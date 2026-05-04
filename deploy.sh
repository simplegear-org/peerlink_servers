#!/bin/bash

# PeerLink all-in-one production deployment script
# Installs Docker, creates IP-only self-signed TLS certificate,
# deploys PeerLink services and production monitoring stack.
#
# Public endpoints:
#   https://SERVER_IP/signal
#   https://SERVER_IP/relay
#   https://SERVER_IP/monitor/
#
# Local-only monitoring ports:
#   127.0.0.1:3001  Grafana
#   127.0.0.1:9090  Prometheus
#   127.0.0.1:9093  Alertmanager
#   127.0.0.1:3100  Loki
#
# Environment overrides:
#   CERT_IP=1.2.3.4
#   TURN_USER=myuser
#   TURN_PASSWORD=mypassword
#   GRAFANA_ADMIN_USER=admin
#   GRAFANA_ADMIN_PASSWORD=admin
#   PROMETHEUS_RETENTION_TIME=7d
#   PROMETHEUS_RETENTION_SIZE=1GB
#   LOKI_RETENTION=168h

set -euo pipefail

STAGE_PREFIX="${STAGE_PREFIX:-__PEERLINK_STAGE__}"

stage() {
  echo "${STAGE_PREFIX}:$1:$2"
}

CERT_IP=${CERT_IP:-$(ip route get 1.1.1.1 2>/dev/null | awk '/src/ {print $7; exit}' || hostname -I 2>/dev/null | awk '{print $1}' || curl -s https://ifconfig.me || echo "127.0.0.1")}
if [ -z "$CERT_IP" ]; then
  CERT_IP=127.0.0.1
fi

TURN_USER=${TURN_USER:-testuser}
TURN_PASSWORD=${TURN_PASSWORD:-testpassword}
GRAFANA_ADMIN_USER=${GRAFANA_ADMIN_USER:-admin}
GRAFANA_ADMIN_PASSWORD=${GRAFANA_ADMIN_PASSWORD:-admin}
PROMETHEUS_RETENTION_TIME=${PROMETHEUS_RETENTION_TIME:-7d}
PROMETHEUS_RETENTION_SIZE=${PROMETHEUS_RETENTION_SIZE:-1GB}
LOKI_RETENTION=${LOKI_RETENTION:-168h}

echo "============================================================"
echo "PeerLink deployment"
echo "IP address:                 $CERT_IP"
echo "Grafana URL:                https://$CERT_IP/monitor/"
echo "Prometheus retention time:  $PROMETHEUS_RETENTION_TIME"
echo "Prometheus retention size:  $PROMETHEUS_RETENTION_SIZE"
echo "Loki retention:             $LOKI_RETENTION"
echo "============================================================"

stage "1" "Updating operating system packages"
echo "Updating operating system packages..."
sudo apt update
sudo apt install -y curl ca-certificates openssl

stage "2" "Installing Docker"
if ! command -v docker >/dev/null 2>&1; then
  echo "Installing Docker..."
  curl -fsSL https://get.docker.com -o get-docker.sh
  sudo sh get-docker.sh
  sudo usermod -aG docker "$USER" || true
else
  echo "Docker already installed."
fi

stage "3" "Installing Docker Compose"
if ! docker compose version >/dev/null 2>&1 && ! command -v docker-compose >/dev/null 2>&1; then
  echo "Installing Docker Compose standalone binary..."
  sudo curl -L "https://github.com/docker/compose/releases/download/v2.24.0/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
  sudo chmod +x /usr/local/bin/docker-compose
else
  echo "Docker Compose already installed."
fi

compose_cmd() {
  if docker compose version >/dev/null 2>&1; then
    docker compose "$@"
  else
    docker-compose "$@"
  fi
}

stage "4" "Configuring Docker log rotation"
echo "Configuring Docker log rotation..."
sudo mkdir -p /etc/docker
if [ -f /etc/docker/daemon.json ]; then
  sudo cp /etc/docker/daemon.json "/etc/docker/daemon.json.backup.$(date +%Y%m%d%H%M%S)"
fi

sudo bash -c "cat > /etc/docker/daemon.json <<'EOF'
{
  \"log-driver\": \"json-file\",
  \"log-opts\": {
    \"max-size\": \"50m\",
    \"max-file\": \"5\"
  }
}
EOF"

stage "5" "Restarting Docker"
echo "Restarting Docker to apply log rotation..."
sudo systemctl restart docker


stage "5.1" "Configuring firewall"
echo "Configuring firewall (if ufw is active)..."
if command -v ufw >/dev/null 2>&1; then
  UFW_STATUS="$(sudo ufw status 2>/dev/null | head -n 1 || true)"
  if echo "$UFW_STATUS" | grep -qi "Status: active"; then
    sudo ufw allow 80/tcp || true
    sudo ufw allow 443/tcp || true
    sudo ufw allow 3478/udp || true
    sudo ufw allow 3478/tcp || true
    sudo ufw allow 5349/udp || true
    sudo ufw allow 5349/tcp || true
    sudo ufw allow 49152:51819/udp || true
    sudo ufw allow 49152:51819/tcp || true
  fi
fi

stage "6" "Generating long-lived self-signed certificate"
echo "Generating long-lived self-signed certificate for IP $CERT_IP..."
sudo mkdir -p /etc/ssl/certs /etc/ssl/private
sudo bash -c "cat > /tmp/selfsigned.cnf <<EOF
[req]
distinguished_name=req_distinguished_name
x509_extensions=v3_req
prompt=no

[req_distinguished_name]
CN=$(echo "$CERT_IP" | sed 's/[\\&/]/\\\\&/g')

[v3_req]
subjectAltName=IP:$(echo "$CERT_IP" | sed 's/[\\&/]/\\\\&/g')
EOF"

sudo openssl req -x509 -nodes -days 36500 -newkey rsa:2048 \
  -keyout /etc/ssl/private/selfsigned.key \
  -out /etc/ssl/certs/selfsigned.crt \
  -config /tmp/selfsigned.cnf

sudo bash -c "cat /etc/ssl/certs/selfsigned.crt /etc/ssl/private/selfsigned.key > /etc/ssl/certs/selfsigned.pem"

stage "7" "Preparing monitoring directories"
echo "Creating monitoring directories..."
mkdir -p monitoring/{prometheus,rules,alertmanager,loki,promtail,blackbox,grafana/provisioning/datasources,grafana/provisioning/dashboards}


stage "7.1" "Preparing config targets"
echo "Preparing config targets..."
sudo rm -rf haproxy.cfg turnserver.conf
if [ -d haproxy.cfg ] || [ -d turnserver.conf ]; then
  echo "Failed to cleanup old config targets"
  exit 1
fi

stage "8" "Generating haproxy.cfg"
echo "Generating HAProxy config..."
cat > haproxy.cfg <<'EOF'
global
    log /dev/log local0
    log /dev/log local1 notice
    chroot /var/lib/haproxy
    stats socket /run/haproxy/admin.sock mode 660 level admin expose-fd listeners
    stats timeout 30s
    user haproxy
    group haproxy
    daemon

defaults
    log global
    mode http
    option httplog
    option dontlognull
    option forwardfor
    timeout connect 5000
    timeout client 50000
    timeout server 50000

frontend http_front
    bind *:80
    bind *:443 ssl crt /usr/local/etc/haproxy/certs/haproxy.pem

    acl is_monitor path_beg /monitor
    acl is_relay path_beg /relay
    acl is_signal path_beg /signal

    use_backend grafana_backend if is_monitor
    use_backend relay_backend if is_relay
    use_backend signal_backend if is_signal

    default_backend signal_backend

backend grafana_backend
    http-request set-header X-Forwarded-Proto https
    http-request set-header X-Forwarded-Port 443
    http-request set-header X-Forwarded-For %[src]
    server grafana 127.0.0.1:3001 check

backend relay_backend
    server relay 127.0.0.1:4000 check

backend signal_backend
    server signal 127.0.0.1:3000 check
EOF

stage "9" "Generating turnserver.conf"
echo "Generating TURN config with IP $CERT_IP..."
cat > turnserver.conf <<EOF
# Listening
listening-port=3478
tls-listening-port=5349

# Public IP
external-ip=$(echo "$CERT_IP" | sed 's/[\\&/]/\\\\&/g')

# Relay ports
min-port=49152
max-port=51819

# Auth
lt-cred-mech
realm=$(echo "$CERT_IP" | sed 's/[\\&/]/\\\\&/g')

# Users
user=${TURN_USER}:${TURN_PASSWORD}

# SSL/TLS
cert=/etc/coturn/certs/fullchain.pem
pkey=/etc/coturn/private/privkey.pem

# Security
fingerprint
no-multicast-peers
no-cli
no-tlsv1
no-tlsv1_1

# Logging
simple-log
log-file=stdout
EOF

stage "10" "Generating Prometheus config"
echo "Generating Prometheus config..."
cat > monitoring/prometheus/prometheus.yml <<EOF
global:
  scrape_interval: 10s
  evaluation_interval: 10s

rule_files:
  - /etc/prometheus/rules/*.yml

alerting:
  alertmanagers:
    - static_configs:
        - targets:
            - alertmanager:9093

scrape_configs:
  - job_name: "prometheus"
    static_configs:
      - targets: ["prometheus:9090"]

  - job_name: "node-exporter"
    static_configs:
      - targets: ["node-exporter:9100"]

  - job_name: "cadvisor"
    static_configs:
      - targets: ["cadvisor:8080"]

  - job_name: "blackbox-https"
    metrics_path: /probe
    params:
      module: [http_2xx_insecure]
    static_configs:
      - targets:
          - https://${CERT_IP}/monitor/
          - https://${CERT_IP}/signal
          - https://${CERT_IP}/relay
    relabel_configs:
      - source_labels: [__address__]
        target_label: __param_target
      - source_labels: [__param_target]
        target_label: instance
      - target_label: __address__
        replacement: blackbox-exporter:9115

  - job_name: "blackbox-tcp"
    metrics_path: /probe
    params:
      module: [tcp_connect]
    static_configs:
      - targets:
          - ${CERT_IP}:80
          - ${CERT_IP}:443
          - ${CERT_IP}:3478
          - ${CERT_IP}:5349
    relabel_configs:
      - source_labels: [__address__]
        target_label: __param_target
      - source_labels: [__param_target]
        target_label: instance
      - target_label: __address__
        replacement: blackbox-exporter:9115
EOF

stage "11" "Generating alert rules"
echo "Generating alert rules..."
cat > monitoring/rules/alerts.yml <<'EOF'
groups:
  - name: host-alerts
    rules:
      - alert: HostHighCPU
        expr: 100 - (avg by(instance) (rate(node_cpu_seconds_total{mode="idle"}[5m])) * 100) > 85
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "High CPU usage"
          description: "CPU usage is above 85% for 5 minutes."

      - alert: HostHighMemory
        expr: (1 - (node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes)) * 100 > 85
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "High memory usage"
          description: "Memory usage is above 85% for 5 minutes."

      - alert: HostDiskAlmostFull
        expr: 100 - ((node_filesystem_avail_bytes{fstype!~"tmpfs|overlay"} * 100) / node_filesystem_size_bytes{fstype!~"tmpfs|overlay"}) > 85
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "Disk almost full"
          description: "Filesystem usage is above 85%."

      - alert: HostDiskInodesLow
        expr: 100 - ((node_filesystem_files_free{fstype!~"tmpfs|overlay"} * 100) / node_filesystem_files{fstype!~"tmpfs|overlay"}) > 85
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Filesystem inodes usage high"
          description: "Inodes usage is above 85%."

  - name: docker-alerts
    rules:
      - alert: ContainerHighCPU
        expr: sum by(name) (rate(container_cpu_usage_seconds_total{name!=""}[5m])) * 100 > 85
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Container high CPU"
          description: "Container CPU usage is above 85%."

      - alert: ContainerHighMemory
        expr: (container_memory_working_set_bytes{name!=""} / container_spec_memory_limit_bytes{name!=""} * 100) > 85
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Container high memory"
          description: "Container memory usage is above 85%."

  - name: endpoint-alerts
    rules:
      - alert: EndpointDown
        expr: probe_success == 0
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "Endpoint is down"
          description: "{{ $labels.instance }} is not reachable."

      - alert: EndpointSlow
        expr: probe_duration_seconds > 2
        for: 3m
        labels:
          severity: warning
        annotations:
          summary: "Endpoint is slow"
          description: "{{ $labels.instance }} response time is above 2 seconds."
EOF

stage "12" "Generating Alertmanager config"
echo "Generating Alertmanager config..."
cat > monitoring/alertmanager/alertmanager.yml <<'EOF'
global:
  resolve_timeout: 5m

route:
  receiver: "default"
  group_by: ["alertname", "instance"]
  group_wait: 30s
  group_interval: 5m
  repeat_interval: 4h

receivers:
  - name: "default"
EOF

stage "13" "Generating Blackbox Exporter config"
echo "Generating Blackbox Exporter config..."
cat > monitoring/blackbox/blackbox.yml <<'EOF'
modules:
  http_2xx_insecure:
    prober: http
    timeout: 5s
    http:
      method: GET
      preferred_ip_protocol: ip4
      tls_config:
        insecure_skip_verify: true
      valid_http_versions:
        - HTTP/1.1
        - HTTP/2.0

  tcp_connect:
    prober: tcp
    timeout: 5s
    tcp:
      preferred_ip_protocol: ip4
EOF

stage "14" "Generating Loki config"
echo "Generating Loki config..."
cat > monitoring/loki/loki.yml <<EOF
auth_enabled: false

server:
  http_listen_port: 3100

common:
  path_prefix: /loki
  storage:
    filesystem:
      chunks_directory: /loki/chunks
      rules_directory: /loki/rules
  replication_factor: 1
  ring:
    kvstore:
      store: inmemory

schema_config:
  configs:
    - from: 2024-01-01
      store: tsdb
      object_store: filesystem
      schema: v13
      index:
        prefix: index_
        period: 24h

limits_config:
  retention_period: ${LOKI_RETENTION}
  ingestion_rate_mb: 8
  ingestion_burst_size_mb: 16
  max_query_series: 10000
  reject_old_samples: true
  reject_old_samples_max_age: 168h

compactor:
  working_directory: /loki/compactor
  retention_enabled: true
  delete_request_store: filesystem

analytics:
  reporting_enabled: false
EOF

stage "15" "Generating Promtail config"
echo "Generating Promtail config..."
cat > monitoring/promtail/promtail.yml <<'EOF'
server:
  http_listen_port: 9080
  grpc_listen_port: 0

positions:
  filename: /tmp/promtail-positions.yaml

clients:
  - url: http://loki:3100/loki/api/v1/push

scrape_configs:
  - job_name: docker-containers
    docker_sd_configs:
      - host: unix:///var/run/docker.sock
        refresh_interval: 10s

    relabel_configs:
      - source_labels: ["__meta_docker_container_name"]
        regex: "/(.*)"
        target_label: "container"

      - source_labels: ["__meta_docker_container_log_stream"]
        target_label: "stream"

      - source_labels: ["__meta_docker_container_label_com_docker_compose_service"]
        target_label: "service"

    pipeline_stages:
      - docker: {}

  - job_name: system-logs
    static_configs:
      - targets:
          - localhost
        labels:
          job: system
          __path__: /var/log/*.log
EOF

stage "16" "Generating Grafana datasources"
echo "Generating Grafana datasources..."
cat > monitoring/grafana/provisioning/datasources/datasources.yml <<'EOF'
apiVersion: 1

datasources:
  - name: Prometheus
    uid: Prometheus
    type: prometheus
    access: proxy
    url: http://prometheus:9090
    isDefault: true
    editable: true

  - name: Loki
    uid: Loki
    type: loki
    access: proxy
    url: http://loki:3100
    editable: true
EOF

stage "17" "Generating Grafana dashboard provider"
echo "Generating Grafana dashboard provider..."
cat > monitoring/grafana/provisioning/dashboards/dashboards.yml <<'EOF'
apiVersion: 1

providers:
  - name: "Production Dashboards"
    orgId: 1
    folder: "Production"
    type: file
    disableDeletion: false
    editable: true
    options:
      path: /etc/grafana/provisioning/dashboards
EOF

stage "18" "Generating starter Grafana dashboard"
echo "Generating starter Grafana dashboard..."
cat > monitoring/grafana/provisioning/dashboards/peerlink-overview.json <<'EOF'
{
  "uid": "peerlink-prod-overview",
  "title": "PeerLink Production Overview",
  "tags": ["peerlink", "production"],
  "timezone": "browser",
  "schemaVersion": 39,
  "version": 1,
  "refresh": "10s",
  "time": {"from": "now-6h", "to": "now"},
  "panels": [
    {
      "id": 1,
      "type": "stat",
      "title": "Host CPU %",
      "gridPos": {"h": 4, "w": 6, "x": 0, "y": 0},
      "datasource": {"type": "prometheus", "uid": "Prometheus"},
      "targets": [{"expr": "100 - (avg(rate(node_cpu_seconds_total{mode=\"idle\"}[5m])) * 100)", "refId": "A"}],
      "fieldConfig": {"defaults": {"unit": "percent"}, "overrides": []},
      "options": {"reduceOptions": {"values": false, "calcs": ["lastNotNull"], "fields": ""}}
    },
    {
      "id": 2,
      "type": "stat",
      "title": "Host RAM %",
      "gridPos": {"h": 4, "w": 6, "x": 6, "y": 0},
      "datasource": {"type": "prometheus", "uid": "Prometheus"},
      "targets": [{"expr": "(1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes) * 100", "refId": "A"}],
      "fieldConfig": {"defaults": {"unit": "percent"}, "overrides": []},
      "options": {"reduceOptions": {"values": false, "calcs": ["lastNotNull"], "fields": ""}}
    },
    {
      "id": 3,
      "type": "stat",
      "title": "Root FS used %",
      "gridPos": {"h": 4, "w": 6, "x": 12, "y": 0},
      "datasource": {"type": "prometheus", "uid": "Prometheus"},
      "targets": [{"expr": "100 - ((node_filesystem_avail_bytes{mountpoint=\"/\",fstype!~\"tmpfs|overlay\"} * 100) / node_filesystem_size_bytes{mountpoint=\"/\",fstype!~\"tmpfs|overlay\"})", "refId": "A"}],
      "fieldConfig": {"defaults": {"unit": "percent"}, "overrides": []},
      "options": {"reduceOptions": {"values": false, "calcs": ["lastNotNull"], "fields": ""}}
    },
    {
      "id": 4,
      "type": "timeseries",
      "title": "Container CPU %",
      "gridPos": {"h": 8, "w": 12, "x": 0, "y": 4},
      "datasource": {"type": "prometheus", "uid": "Prometheus"},
      "targets": [{"expr": "sum by(name) (rate(container_cpu_usage_seconds_total{name!=\"\"}[5m])) * 100", "legendFormat": "{{name}}", "refId": "A"}],
      "fieldConfig": {"defaults": {"unit": "percent"}, "overrides": []}
    },
    {
      "id": 5,
      "type": "timeseries",
      "title": "Container Memory",
      "gridPos": {"h": 8, "w": 12, "x": 12, "y": 4},
      "datasource": {"type": "prometheus", "uid": "Prometheus"},
      "targets": [{"expr": "container_memory_working_set_bytes{name!=\"\"}", "legendFormat": "{{name}}", "refId": "A"}],
      "fieldConfig": {"defaults": {"unit": "bytes"}, "overrides": []}
    },
    {
      "id": 6,
      "type": "timeseries",
      "title": "Endpoint Success",
      "gridPos": {"h": 7, "w": 12, "x": 0, "y": 12},
      "datasource": {"type": "prometheus", "uid": "Prometheus"},
      "targets": [{"expr": "probe_success", "legendFormat": "{{instance}}", "refId": "A"}],
      "fieldConfig": {"defaults": {"unit": "short"}, "overrides": []}
    },
    {
      "id": 7,
      "type": "logs",
      "title": "Container Errors",
      "gridPos": {"h": 9, "w": 24, "x": 0, "y": 19},
      "datasource": {"type": "loki", "uid": "Loki"},
      "targets": [{"expr": "{job=\"docker-containers\"} |~ \"(?i)error|failed|exception|panic|timeout|denied|refused\"", "refId": "A"}],
      "options": {"showTime": true, "showLabels": false, "wrapLogMessage": true, "sortOrder": "Descending"}
    }
  ]
}
EOF

stage "19" "Generating docker-compose.yml"
echo "Generating unified docker-compose.yml..."
cat > docker-compose.yml <<EOF
services:
  relay:
    image: tangash/relay:latest
    container_name: relay
    restart: always
    ports:
      - "127.0.0.1:4000:4000"
    environment:
      - NODE_ENV=production

  signal:
    image: tangash/signal:latest
    container_name: signal
    restart: always
    ports:
      - "127.0.0.1:3000:3000"
    environment:
      - NODE_ENV=production

  coturn:
    image: instrumentisto/coturn
    container_name: coturn
    restart: always
    network_mode: host
    environment:
      - TURN_PORT=3478
      - TURNS_PORT=5349
    volumes:
      - ./turnserver.conf:/etc/coturn/turnserver.conf
      - /etc/ssl/certs/selfsigned.crt:/etc/coturn/certs/fullchain.pem:ro
      - /etc/ssl/private/selfsigned.key:/etc/coturn/private/privkey.pem:ro

  haproxy:
    image: haproxy:alpine
    container_name: haproxy
    restart: always
    network_mode: host
    volumes:
      - ./haproxy.cfg:/usr/local/etc/haproxy/haproxy.cfg:ro
      - /etc/ssl/certs/selfsigned.pem:/usr/local/etc/haproxy/certs/haproxy.pem:ro

  grafana:
    image: grafana/grafana:latest
    container_name: grafana
    restart: always
    ports:
      - "127.0.0.1:3001:3000"
    environment:
      - GF_SECURITY_ADMIN_USER=${GRAFANA_ADMIN_USER}
      - GF_SECURITY_ADMIN_PASSWORD=${GRAFANA_ADMIN_PASSWORD}
      - GF_USERS_ALLOW_SIGN_UP=false
      - GF_SERVER_DOMAIN=${CERT_IP}
      - GF_SERVER_ROOT_URL=https://${CERT_IP}/monitor/
      - GF_SERVER_SERVE_FROM_SUB_PATH=true
      - GF_SECURITY_COOKIE_SECURE=true
      - GF_SECURITY_COOKIE_SAMESITE=strict
      - GF_SECURITY_DISABLE_GRAVATAR=true
      - GF_ANALYTICS_REPORTING_ENABLED=false
      - GF_ANALYTICS_CHECK_FOR_UPDATES=false
      - GF_LOG_MODE=console
    volumes:
      - grafana-data:/var/lib/grafana
      - ./monitoring/grafana/provisioning:/etc/grafana/provisioning:ro
    depends_on:
      - prometheus
      - loki

  prometheus:
    image: prom/prometheus:latest
    container_name: prometheus
    restart: always
    ports:
      - "127.0.0.1:9090:9090"
    volumes:
      - ./monitoring/prometheus/prometheus.yml:/etc/prometheus/prometheus.yml:ro
      - ./monitoring/rules:/etc/prometheus/rules:ro
      - prometheus-data:/prometheus
    command:
      - "--config.file=/etc/prometheus/prometheus.yml"
      - "--storage.tsdb.path=/prometheus"
      - "--storage.tsdb.retention.time=${PROMETHEUS_RETENTION_TIME}"
      - "--storage.tsdb.retention.size=${PROMETHEUS_RETENTION_SIZE}"
      - "--web.enable-lifecycle"
    depends_on:
      - alertmanager
      - cadvisor
      - node-exporter
      - blackbox-exporter

  alertmanager:
    image: prom/alertmanager:latest
    container_name: alertmanager
    restart: always
    ports:
      - "127.0.0.1:9093:9093"
    volumes:
      - ./monitoring/alertmanager/alertmanager.yml:/etc/alertmanager/alertmanager.yml:ro
      - alertmanager-data:/alertmanager
    command:
      - "--config.file=/etc/alertmanager/alertmanager.yml"
      - "--storage.path=/alertmanager"

  node-exporter:
    image: quay.io/prometheus/node-exporter:latest
    container_name: node-exporter
    restart: always
    ports:
      - "127.0.0.1:9100:9100"
    pid: host
    command:
      - "--path.rootfs=/host"
      - "--collector.filesystem.mount-points-exclude=^/(dev|proc|sys|run|var/lib/docker/.+|var/lib/containers/storage/.+)($|/)"
      - "--collector.filesystem.fs-types-exclude=^(autofs|binfmt_misc|bpf|cgroup2?|configfs|debugfs|devpts|devtmpfs|fusectl|hugetlbfs|mqueue|overlay|proc|pstore|rpc_pipefs|securityfs|sysfs|tracefs)$"
    volumes:
      - /:/host:ro,rslave

  cadvisor:
    image: gcr.io/cadvisor/cadvisor:latest
    container_name: cadvisor
    restart: always
    privileged: true
    ports:
      - "127.0.0.1:8081:8080"
    volumes:
      - /:/rootfs:ro
      - /var/run:/var/run:ro
      - /sys:/sys:ro
      - /var/lib/docker:/var/lib/docker:ro
      - /dev/disk:/dev/disk:ro

  blackbox-exporter:
    image: prom/blackbox-exporter:latest
    container_name: blackbox-exporter
    restart: always
    ports:
      - "127.0.0.1:9115:9115"
    volumes:
      - ./monitoring/blackbox/blackbox.yml:/etc/blackbox_exporter/config.yml:ro
    command:
      - "--config.file=/etc/blackbox_exporter/config.yml"

  loki:
    image: grafana/loki:latest
    container_name: loki
    restart: always
    ports:
      - "127.0.0.1:3100:3100"
    volumes:
      - ./monitoring/loki/loki.yml:/etc/loki/loki.yml:ro
      - loki-data:/loki
    command:
      - "-config.file=/etc/loki/loki.yml"

  promtail:
    image: grafana/promtail:latest
    container_name: promtail
    restart: always
    volumes:
      - ./monitoring/promtail/promtail.yml:/etc/promtail/promtail.yml:ro
      - /var/log:/var/log:ro
      - /var/lib/docker/containers:/var/lib/docker/containers:ro
      - /var/run/docker.sock:/var/run/docker.sock:ro
    command:
      - "-config.file=/etc/promtail/promtail.yml"
    depends_on:
      - loki

volumes:
  grafana-data:
  prometheus-data:
  alertmanager-data:
  loki-data:
EOF

stage "20" "Starting containers"
echo "Starting all services..."
compose_cmd up -d --force-recreate --remove-orphans

echo "============================================================"
stage "21" "Deployment complete"
echo "Deployment complete."
echo ""
echo "Main endpoints:"
echo "  Signal:  https://${CERT_IP}/signal"
echo "  Relay:   https://${CERT_IP}/relay"
echo "  TURN:    ${CERT_IP}:3478"
echo "  TURNS:   ${CERT_IP}:5349"
echo ""
echo "Monitoring:"
echo "  Grafana: https://${CERT_IP}/monitor/"
echo "  Login:   ${GRAFANA_ADMIN_USER}"
echo "  Password:${GRAFANA_ADMIN_PASSWORD}"
echo ""
echo "Local debug on server:"
echo "  Prometheus:   http://127.0.0.1:9090"
echo "  Alertmanager: http://127.0.0.1:9093"
echo "  Loki:         http://127.0.0.1:3100"
echo ""
echo "Useful checks:"
echo "  docker ps"
echo "  docker logs haproxy --tail=50"
echo "  docker logs grafana --tail=50"
echo "  docker logs prometheus --tail=50"
echo "============================================================"
