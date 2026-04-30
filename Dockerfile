FROM grafana/grafana:11.3.0

# Copy Grafana configuration
COPY config/grafana.ini /etc/grafana/grafana.ini

# Copy datasources configuration
COPY config/datasources /etc/grafana/provisioning/datasources

# Copy dashboard configurations
COPY config/dashboards /etc/grafana/provisioning/dashboards
COPY dashboards /var/lib/grafana/dashboards

# Copy alerting configuration
COPY config/provisioning/alerting /etc/grafana/provisioning/alerting
COPY config/provisioning/notifiers /etc/grafana/provisioning/notifiers
COPY config/provisioning/contactpoints /etc/grafana/provisioning/contactpoints
COPY config/provisioning/policies /etc/grafana/provisioning/policies

# Expose Grafana HTTP endpoint
EXPOSE 3000

# Run Grafana
CMD ["/run.sh"]
