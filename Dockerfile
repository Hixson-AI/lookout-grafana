FROM grafana/grafana:11.3.0

# Copy Grafana configuration
COPY config/grafana.ini /etc/grafana/grafana.ini

# Copy datasources configuration
COPY config/datasources /etc/grafana/provisioning/datasources

# Copy dashboard configurations
COPY config/dashboards /etc/grafana/provisioning/dashboards
COPY dashboards /var/lib/grafana/dashboards

# Expose Grafana HTTP endpoint
EXPOSE 3000

# Run Grafana
CMD ["/run.sh"]
