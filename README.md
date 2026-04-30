# lookout-grafana

Grafana dashboards for the Lookout platform. Self-hosted on Fly.io with tenant-scoped log explorer views.

## Dashboards

### Platform Team Dashboard (`platform-team-log-explorer`)
- View logs across all tenants
- Variable: `tenant_id` (multi-select to filter by tenant)
- Variable: `service` (filter by service)
- Variable: `level` (filter by log level)
- Available to platform admins only

### Tenant Dashboard (`tenant-log-explorer`)
- Tenant-scoped log view
- `tenant_id` variable auto-populated from JWT claim
- Tenant managers see only their own logs
- Same service and level filters as platform view

## Deployment

### Fly.io

```bash
flyctl apps create lookout-grafana
flyctl secrets set GF_SECURITY_ADMIN_PASSWORD=your-secure-password -a lookout-grafana
flyctl volumes create grafana_data --size 10 --region iad -a lookout-grafana
flyctl deploy
```

## Authentication

**Phase 1 (Current):**
- Default admin user: `admin` / password from `GF_SECURITY_ADMIN_PASSWORD`
- No JWT integration yet — platform admins access via admin credentials

**Phase 2 (Future):**
- Integrate with control plane JWT for tenant-scoped access
- `tenant_id` variable populated from JWT claim
- RBAC: platform admins see all tenants, tenant managers see only their tenant

## Dependencies

- **Loki**: `lookout-loki` Fly app provides log storage
- **OTel Collector**: `lookout-telemetry` Fly app sends logs to Loki

## Related

- `slices/slice_11.md` - Full observability pipeline design
- `lookout-telemetry` - OTel Collector service
- `lookout-loki` - Log aggregation service
