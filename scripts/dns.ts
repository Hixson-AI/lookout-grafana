#!/usr/bin/env tsx

import { readFileSync } from 'fs';
import { join } from 'path';
import { load } from 'js-yaml';
import { program } from 'commander';

interface DomainConfig {
  domain: string;
  type: string;
  target: string;
  status: string;
  ssl: boolean;
  proxy?: boolean;
  description: string;
}

interface DnsConfig {
  domains: Record<string, Record<string, DomainConfig>>;
  cloudflare: {
    zone_id: string;
    ttl: {
      default: number;
    };
  };
}

class DnsManager {
  private config: DnsConfig;
  private dryRun: boolean;
  private cloudflareToken: string;
  private flyIps?: {
    ipv4?: string;
    ipv6_1?: string;
    ipv6_2?: string;
  };
  private flyHostname?: string;
  private flyOwnership?: {
    name?: string;
    value?: string;
  };

  constructor(dryRun = false, yamlPath?: string) {
    this.dryRun = dryRun;

    // Check for Fly.io IPs from environment
    this.flyIps = {
      ipv4: process.env.FLY_IPV4,
      ipv6_1: process.env.FLY_IPV6_1,
      ipv6_2: process.env.FLY_IPV6_2,
    };

    // Check for Fly.io hostname from environment (for CNAME fallback)
    this.flyHostname = process.env.FLY_HOSTNAME;

    // Check for Fly.io ownership TXT record from environment
    this.flyOwnership = {
      name: process.env.FLY_OWNERSHIP_NAME,
      value: process.env.FLY_OWNERSHIP_VALUE,
    };
    
    // Load configuration
    const configPath = yamlPath || join(process.cwd(), 'dns.yaml');
    let configContent = readFileSync(configPath, 'utf8');
    
    // Substitute environment variables
    configContent = configContent.replace(/\$\{([^}]+)\}/g, (match, envVar) => {
      const value = process.env[envVar];
      if (value === undefined) {
        throw new Error(`Environment variable ${envVar} is not set`);
      }
      return value;
    });
    
    this.config = load(configContent) as DnsConfig;
    
    // Get Cloudflare token
    this.cloudflareToken = process.env.CLOUDFLARE_API_TOKEN || '';
    if (!this.cloudflareToken && !dryRun) {
      throw new Error('CLOUDFLARE_API_TOKEN environment variable is required');
    }
  }

  async manageRecords(env?: string): Promise<void> {
    console.log('🌐 Managing DNS records...\n');
    
    let recordsToProcess: Array<{service: string, env: string, config: DomainConfig}> = [];
    
    // Collect records based on environment filter
    for (const [service, environments] of Object.entries(this.config.domains)) {
      for (const [envName, config] of Object.entries(environments)) {
        if (env && envName !== env) continue;
        if (config.status === 'disabled') continue;
        
        recordsToProcess.push({
          service,
          env: envName,
          config
        });
      }
    }
    
    if (recordsToProcess.length === 0) {
      console.log(`⚠️  No DNS records found${env ? ` for environment: ${env}` : ''}`);
      return;
    }
    
    console.log(`Found ${recordsToProcess.length} record(s) to process\n`);
    
    for (const {service, env, config} of recordsToProcess) {
      await this.syncRecord(service, env, config);
    }
    
    console.log('\n✅ DNS management completed!');
  }

  private async syncRecord(service: string, env: string, config: DomainConfig): Promise<void> {
    // Use Fly.io IPs if available, otherwise use CNAME target from YAML or Fly.io hostname
    let recordType = config.type;
    let recordTarget = config.target;

    console.log(`    Fly.io IPs received: ipv4=${this.flyIps?.ipv4}, ipv6_1=${this.flyIps?.ipv6_1}, ipv6_2=${this.flyIps?.ipv6_2}`);
    console.log(`    Fly.io hostname: ${this.flyHostname}`);

    if (this.flyHostname && config.type === 'CNAME') {
      recordTarget = this.flyHostname;
      console.log(`  ${env}: ${config.domain} (CNAME → ${recordTarget})`);
    } else if (this.flyIps?.ipv4 && this.flyIps.ipv6_1 &&
        this.flyIps.ipv4 !== '' && this.flyIps.ipv6_1 !== '') {
      // Use A/AAAA records with Fly.io IPs for non-CNAME types
      console.log(`  ${env}: ${config.domain} (using Fly.io IPs)`);
      await this.syncFlyIpsRecord(config);
      return;
    } else {
      console.log(`    ⚠️  Not all Fly.io IPs present, falling back to CNAME`);
      // Use Fly.io hostname if available for CNAME, otherwise use YAML target
      if (this.flyHostname && config.type === 'CNAME') {
        recordTarget = this.flyHostname;
        console.log(`  ${env}: ${config.domain} (CNAME → ${recordTarget})`);
      } else {
        console.log(`  ${env}: ${config.domain} (${config.type} → ${config.target})`);
      }
    }

    if (this.dryRun) {
      console.log(`    📝 Would ${recordType} record for ${config.domain}`);
      return;
    }

    try {
      // Check if record of the same type exists
      const existingRecords = await this.fetch(
        `https://api.cloudflare.com/client/v4/zones/${this.config.cloudflare.zone_id}/dns_records?type=${recordType}&name=${config.domain}`
      );

      if (existingRecords.result.length > 0) {
        // Update existing record
        const existing = existingRecords.result[0];

        const currentProxy = existing.proxied || false;
        const desiredProxy = config.proxy || false;

        if (existing.content === recordTarget && currentProxy === desiredProxy) {
          console.log(`    ✓ Record already exists with correct content and proxy setting`);
          return;
        }

        await this.fetch(
          `https://api.cloudflare.com/client/v4/zones/${this.config.cloudflare.zone_id}/dns_records/${existing.id}`,
          {
            method: 'PUT',
            body: JSON.stringify({
              type: recordType,
              name: config.domain,
              content: recordTarget,
              ttl: this.config.cloudflare.ttl.default,
              proxied: config.proxy || false
            })
          }
        );
        const updateReason = existing.content !== recordTarget ? 'content' : 'proxy setting';
        console.log(`    📝 Updated existing record (${updateReason})`);
      } else {
        // Check if any other record type exists with the same name (A, AAAA, or CNAME)
        const allRecords = await this.fetch(
          `https://api.cloudflare.com/client/v4/zones/${this.config.cloudflare.zone_id}/dns_records?name=${config.domain}`
        );

        console.log(`    🔍 Found ${allRecords.result.length} existing record(s) with name "${config.domain}"`);
        if (allRecords.result.length > 0) {
          // Delete existing records of different types
          console.log(`    🗑️  Deleting existing record(s) of different type(s)`);
          for (const record of allRecords.result) {
            console.log(`      - Deleting ${record.type} record (ID: ${record.id})`);
            await this.fetch(
              `https://api.cloudflare.com/client/v4/zones/${this.config.cloudflare.zone_id}/dns_records/${record.id}`,
              { method: 'DELETE' }
            );
          }
        }

        // Create new record
        await this.fetch(
          `https://api.cloudflare.com/client/v4/zones/${this.config.cloudflare.zone_id}/dns_records`,
          {
            method: 'POST',
            body: JSON.stringify({
              type: recordType,
              name: config.domain,
              content: recordTarget,
              ttl: this.config.cloudflare.ttl.default,
              proxied: config.proxy || false
            })
          }
        );
        console.log(`    ➕ Created new record`);
      }
    } catch (error) {
      console.error(`    ❌ Failed to sync record: ${error}`);
      throw error;
    }
  }

  private async syncFlyIpsRecord(config: DomainConfig): Promise<void> {
    if (!this.flyIps?.ipv4 || !this.flyIps.ipv6_1) {
      console.log(`    ⚠️  Fly.io IPs not provided, skipping A/AAAA record creation`);
      return;
    }

    if (this.dryRun) {
      console.log(`    📝 Would delete existing CNAME record for ${config.domain}`);
      console.log(`    📝 Would create A record: ${config.domain} → ${this.flyIps.ipv4}`);
      console.log(`    📝 Would create AAAA record: ${config.domain} → ${this.flyIps.ipv6_1}`);
      if (this.flyIps.ipv6_2 && this.flyIps.ipv6_2 !== '') {
        console.log(`    📝 Would create AAAA record: ${config.domain} → ${this.flyIps.ipv6_2}`);
      }
      return;
    }

    // Delete existing CNAME record if it exists (Cloudflare doesn't allow CNAME + A/AAAA with same name)
    await this.deleteExistingCname(config.domain);

    // Sync A record
    await this.syncSingleRecord('A', config.domain, this.flyIps.ipv4, config.proxy);

    // Sync AAAA records
    await this.syncSingleRecord('AAAA', config.domain, this.flyIps.ipv6_1, config.proxy);
    if (this.flyIps.ipv6_2 && this.flyIps.ipv6_2 !== '') {
      await this.syncSingleRecord('AAAA', config.domain, this.flyIps.ipv6_2, config.proxy);
    }

    // Sync ownership TXT record for Fly.io domain verification
    if (this.flyOwnership?.name && this.flyOwnership.value) {
      await this.syncSingleRecord('TXT', this.flyOwnership.name, this.flyOwnership.value || '', false);
    }
  }

  private async deleteExistingCname(name: string): Promise<void> {
    try {
      const existingCname = await this.fetch(
        `https://api.cloudflare.com/client/v4/zones/${this.config.cloudflare.zone_id}/dns_records?type=CNAME&name=${name}`
      );

      if (existingCname.result.length > 0) {
        const cnameRecord = existingCname.result[0];
        console.log(`    🗑️  Deleting existing CNAME record for ${name}`);
        await this.fetch(
          `https://api.cloudflare.com/client/v4/zones/${this.config.cloudflare.zone_id}/dns_records/${cnameRecord.id}`,
          { method: 'DELETE' }
        );
      }
    } catch (error) {
      console.error(`    ⚠️  Failed to delete existing CNAME record: ${error}`);
      // Don't throw error, continue with A/AAAA creation
    }
  }

  private async syncAaaaRecord(name: string, content: string, proxy?: boolean): Promise<void> {
    // Check if an AAAA record with this content already exists
    const existingRecords = await this.fetch(
      `https://api.cloudflare.com/client/v4/zones/${this.config.cloudflare.zone_id}/dns_records?type=AAAA&name=${name}`
    );

    const existingWithSameContent = existingRecords.result.find((r: any) => r.content === content);
    if (existingWithSameContent) {
      console.log(`    ✓ AAAA record already exists with correct content`);
      return;
    }

    // If there are other AAAA records with different content, delete them
    for (const record of existingRecords.result) {
      if (record.content !== content) {
        console.log(`    🗑️  Deleting AAAA record with outdated content: ${record.content}`);
        await this.fetch(
          `https://api.cloudflare.com/client/v4/zones/${this.config.cloudflare.zone_id}/dns_records/${record.id}`,
          { method: 'DELETE' }
        );
      }
    }

    // Create the new AAAA record
    await this.syncSingleRecord('AAAA', name, content, proxy);
  }

  private async syncSingleRecord(type: string, name: string, content: string, proxy?: boolean): Promise<void> {
    // Cloudflare requires TXT record content wrapped in double quotes
    const apiContent = type === 'TXT' ? `"${content.replace(/^"|"$/g, '')}"` : content;

    try {
      // Check if record exists
      const existingRecords = await this.fetch(
        `https://api.cloudflare.com/client/v4/zones/${this.config.cloudflare.zone_id}/dns_records?type=${type}&name=${name}`
      );

      const existingRecord = existingRecords.result.find((r: any) => r.content === apiContent || r.content === content);

      if (existingRecord) {
        const currentProxy = existingRecord.proxied || false;
        const desiredProxy = proxy || false;

        if (currentProxy === desiredProxy) {
          console.log(`    ✓ ${type} record already exists with correct proxy setting (${content})`);
          return;
        }

        await this.fetch(
          `https://api.cloudflare.com/client/v4/zones/${this.config.cloudflare.zone_id}/dns_records/${existingRecord.id}`,
          {
            method: 'PUT',
            body: JSON.stringify({
              type,
              name,
              content: apiContent,
              ttl: this.config.cloudflare.ttl.default,
              proxied: desiredProxy
            })
          }
        );
        console.log(`    📝 Updated ${type} record proxy setting (${content})`);
      } else {
        // Create new record
        await this.fetch(
          `https://api.cloudflare.com/client/v4/zones/${this.config.cloudflare.zone_id}/dns_records`,
          {
            method: 'POST',
            body: JSON.stringify({
              type,
              name,
              content: apiContent,
              ttl: this.config.cloudflare.ttl.default,
              proxied: proxy || false
            })
          }
        );
        console.log(`    ➕ Created ${type} record (${content})`);
      }
    } catch (error) {
      console.error(`    ❌ Failed to sync ${type} record: ${error}`);
      throw error;
    }
  }

  private async fetch(url: string, options: RequestInit = {}): Promise<any> {
    const response = await fetch(url, {
      ...options,
      headers: {
        'Authorization': `Bearer ${this.cloudflareToken}`,
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });
    
    if (!response.ok) {
      // Get detailed error response from Cloudflare
      const errorBody = await response.text();
      console.error(`Cloudflare API Error Response: ${errorBody}`);
      throw new Error(`HTTP ${response.status}: ${response.statusText} - ${errorBody}`);
    }
    
    return response.json();
  }
}

// CLI setup
program
  .name('dns')
  .description('Manage DNS records from yaml file')
  .option('--dry-run', 'Show what would be done without making changes')
  .option('--env <env>', 'Sync only specific environment')
  .option('--yaml <path>', 'Path to YAML file (default: dns.yaml)')
  .action(async (options) => {
    try {
      const manager = new DnsManager(options.dryRun, options.yaml);
      await manager.manageRecords(options.env);
    } catch (error) {
      console.error('❌ DNS management failed:', error);
      process.exit(1);
    }
  });

program.parse();
