#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="$ROOT_DIR/docker-compose.push.yml"
ENV_FILE="$ROOT_DIR/.env.push.local"
ENV_EXAMPLE_FILE="$ROOT_DIR/.env.push.example"
DEPLOY_DIR="$ROOT_DIR/deploy/push"
NGINX_DIR="$DEPLOY_DIR/nginx/conf.d"
MODERATION_UI_DIR="$DEPLOY_DIR/moderation-ui"
WEBROOT_DIR="$DEPLOY_DIR/certbot/www"
LETSENCRYPT_DIR="$DEPLOY_DIR/letsencrypt"
PUSH_RUNTIME_SERVICES=(push server-checker push-observability-db prometheus grafana moderation-ui push-proxy)

SUDO=""
if [[ "${EUID}" -ne 0 ]]; then
  if ! command -v sudo >/dev/null 2>&1; then
    echo "Run this script as root, or install sudo for the current user."
    exit 1
  fi
  SUDO="sudo"
fi

require_command() {
  local name="$1"
  if ! command -v "$name" >/dev/null 2>&1; then
    echo "Missing required command: $name"
    exit 1
  fi
}

require_var() {
  local name="$1"
  local value="${!name:-}"
  if [[ -z "$value" || "$value" == "change_me" || "$value" == "true/false" ]]; then
    echo "Missing required env: $name"
    exit 1
  fi
}

require_bool() {
  local name="$1"
  local value="${!name:-}"
  if [[ "$value" != "true" && "$value" != "false" ]]; then
    echo "Env $name must be exactly true or false"
    exit 1
  fi
}

tls_provider() {
  echo "${PUSH_TLS_PROVIDER:-letsencrypt}"
}

uses_cloudflare_origin_tls() {
  [[ "$(tls_provider)" == "cloudflare_origin" ]]
}

ensure_dir() {
  mkdir -p "$1"
}

ensure_file_mount_source() {
  local path="$1"
  if [[ -d "$path" ]]; then
    echo "Removing stale directory that must be a file: $path"
    rm -rf "$path"
  fi
}

write_moderation_ui_nginx_config() {
  ensure_file_mount_source "$MODERATION_UI_DIR/nginx.conf"
  cat > "$MODERATION_UI_DIR/nginx.conf" <<'EOF_MODERATION_NGINX'
server {
  listen 80;
  server_name _;

  root /usr/share/nginx/html;
  index index.html;

  location / {
    try_files $uri $uri/ /index.html;
  }

  location /api/ {
    proxy_pass http://push:4500/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
EOF_MODERATION_NGINX
}

write_moderation_ui_index() {
  ensure_file_mount_source "$MODERATION_UI_DIR/index.html"
  if [[ -f "$MODERATION_UI_DIR/index.html" ]]; then
    return 0
  fi
  cat > "$MODERATION_UI_DIR/index.html" <<'EOF_MODERATION_HTML'
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>PeerLink X Moderation</title>
  <style>
    body { margin: 0; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f6f7f9; color: #111827; }
    header { display: flex; gap: 16px; align-items: center; justify-content: space-between; padding: 18px 24px; border-bottom: 1px solid #d9dde5; background: #fff; }
    h1 { margin: 0; font-size: 20px; }
    main { padding: 20px 24px 28px; display: grid; gap: 18px; }
    input, select, button { font: inherit; border: 1px solid #d9dde5; border-radius: 6px; background: #fff; color: #111827; padding: 8px 10px; }
    button { cursor: pointer; white-space: nowrap; }
    button.primary { background: #1f7a5b; border-color: #1f7a5b; color: #fff; }
    button.warn { background: #b7791f; border-color: #b7791f; color: #fff; }
    button.danger { background: #b42318; border-color: #b42318; color: #fff; }
    .token { display: flex; gap: 8px; align-items: center; min-width: min(520px, 100%); }
    .token input { width: 100%; }
    .metrics { display: grid; grid-template-columns: repeat(3, minmax(120px, 1fr)); gap: 12px; }
    .metric, section { background: #fff; border: 1px solid #d9dde5; border-radius: 8px; }
    .metric { padding: 14px; }
    .metric span { display: block; color: #667085; font-size: 12px; }
    .metric strong { display: block; margin-top: 6px; font-size: 26px; }
    section { overflow: hidden; }
    .section-head { display: flex; gap: 10px; align-items: center; justify-content: space-between; padding: 12px 14px; border-bottom: 1px solid #d9dde5; }
    .section-head h2 { margin: 0; font-size: 15px; }
    table { width: 100%; border-collapse: collapse; table-layout: fixed; }
    th, td { padding: 10px 12px; border-bottom: 1px solid #d9dde5; text-align: left; vertical-align: top; font-size: 13px; overflow-wrap: anywhere; }
    th { color: #667085; font-weight: 600; background: #fafbfc; }
    .actions { display: flex; gap: 6px; flex-wrap: wrap; }
    .badge { display: inline-block; min-width: 64px; padding: 3px 7px; border-radius: 999px; background: #edf2f7; text-align: center; font-size: 12px; }
    .badge.warning { color: #b7791f; background: #fff7e6; }
    .badge.banned { color: #b42318; background: #fff1f0; }
    .empty, .error { padding: 16px; color: #667085; }
    .error { color: #b42318; }
    @media (max-width: 920px) { header { align-items: stretch; flex-direction: column; } .metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); } table { min-width: 860px; } section { overflow-x: auto; } }
  </style>
</head>
<body>
  <header>
    <h1>PeerLink X Moderation</h1>
    <div class="token">
      <input id="token" type="password" placeholder="Moderator token">
      <button id="saveToken" class="primary" type="button">Save</button>
      <button id="refresh" type="button">Refresh</button>
    </div>
  </header>
  <main>
    <div class="metrics" id="metrics"></div>
    <section>
      <div class="section-head"><h2>Reports</h2></div>
      <div id="reports"></div>
    </section>
    <section>
      <div class="section-head"><h2>Peer Scores</h2><select id="sort"><option value="report_count_desc">Reports</option><option value="state_desc">Policy</option><option value="last_report_desc">Last report</option></select></div>
      <div id="scores"></div>
    </section>
  </main>
  <script>
    const apiBase = '/api';
    const tokenInput = document.querySelector('#token');
    const metricsEl = document.querySelector('#metrics');
    const reportsEl = document.querySelector('#reports');
    const scoresEl = document.querySelector('#scores');
    const sortEl = document.querySelector('#sort');
    tokenInput.value = sessionStorage.getItem('moderationToken') || '';
    function authHeaders() { const token = tokenInput.value.trim(); return token ? { Authorization: `Bearer ${token}` } : {}; }
    async function getJson(path) { const res = await fetch(`${apiBase}${path}`, { headers: authHeaders() }); const data = await res.json().catch(() => ({})); if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`); return data; }
    async function postJson(path, body) { const res = await fetch(`${apiBase}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify(body) }); const data = await res.json().catch(() => ({})); if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`); return data; }
    function metric(label, value) { return `<div class="metric"><span>${label}</span><strong>${value ?? 0}</strong></div>`; }
    function badge(value) { const cls = value === 'banned' ? 'banned' : value === 'warning' ? 'warning' : ''; return `<span class="badge ${cls}">${esc(value || 'clear')}</span>`; }
    function fmt(value) { return value ? new Date(value).toLocaleString() : '-'; }
    function esc(value) { return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])); }
    function defaultDecisionNote(action, reportCount, reporterCount) { const reports = Number(reportCount || 0); const reporters = Number(reporterCount || 0); return action === 'ban' ? `Account blocked because ${reports} reports were received from ${reporters} users. Reporter Peer IDs are not disclosed.` : `Warning issued because ${reports} reports were received from ${reporters} users. Reporter Peer IDs are not disclosed.`; }
    async function actPeer(peerId, action, reportCount, reporterCount) { const note = window.prompt('Moderator note', defaultDecisionNote(action, reportCount, reporterCount)); if (note === null) return; await postJson(`/admin/moderation/peers/${encodeURIComponent(peerId)}/action`, { action, note, reportCount, reporterCount }); await load(); }
    window.actPeer = actPeer;
    function renderReports(reports) {
      if (!reports.length) { reportsEl.innerHTML = '<div class="empty">No reports</div>'; return; }
      reportsEl.innerHTML = `<table><thead><tr><th>Received</th><th>Reported peer</th><th>Reporter</th><th>Reason</th><th>Content</th></tr></thead><tbody>${reports.map((report) => `<tr><td>${fmt(report.receivedAt)}</td><td>${esc(report.reportedPeerId)}</td><td>${esc(report.reporterPeerId)}</td><td>${esc(report.reason)}</td><td>metadata only</td></tr>`).join('')}</tbody></table>`;
    }
    function renderScores(scores) {
      if (!scores.length) { scoresEl.innerHTML = '<div class="empty">No peer reports</div>'; return; }
      scoresEl.innerHTML = `<table><thead><tr><th>Peer ID</th><th>Reports</th><th>Users</th><th>Policy</th><th>Last report</th><th>Actions</th></tr></thead><tbody>${scores.map((score) => `<tr><td>${esc(score.peerId)}</td><td>${score.reportCount}</td><td>${score.reporterCount || 0}</td><td>${badge(score.policyState)}</td><td>${fmt(score.lastReportAt)}</td><td class="actions"><button class="warn" onclick="actPeer('${esc(score.peerId)}', 'warn', ${score.reportCount || 0}, ${score.reporterCount || 0})">Warn</button><button class="danger" onclick="actPeer('${esc(score.peerId)}', 'ban', ${score.reportCount || 0}, ${score.reporterCount || 0})">Ban</button></td></tr>`).join('')}</tbody></table>`;
    }
    async function load() {
      try {
        const [summary, reports, scores] = await Promise.all([getJson('/admin/moderation/summary'), getJson('/admin/reports?limit=500'), getJson(`/admin/moderation/peer-scores?sort=${encodeURIComponent(sortEl.value)}`)]);
        const s = summary.summary;
        metricsEl.innerHTML = [metric('Reports', s.total), metric('Warnings', s.warned_peers), metric('Bans', s.banned_peers)].join('');
        renderReports(reports.reports || []);
        renderScores(scores.scores || []);
      } catch (error) {
        metricsEl.innerHTML = '';
        reportsEl.innerHTML = `<div class="error">${esc(error.message)}</div>`;
        scoresEl.innerHTML = '';
      }
    }
    document.querySelector('#saveToken').addEventListener('click', () => { sessionStorage.setItem('moderationToken', tokenInput.value.trim()); load(); });
    document.querySelector('#refresh').addEventListener('click', load);
    sortEl.addEventListener('change', load);
    load();
  </script>
</body>
</html>
EOF_MODERATION_HTML
}

prepare_moderation_ui() {
  ensure_dir "$MODERATION_UI_DIR"
  write_moderation_ui_index
  write_moderation_ui_nginx_config
}

is_debian_like() {
  [[ -f /etc/debian_version ]] && command -v apt-get >/dev/null 2>&1
}

load_env() {
  if [[ ! -f "$ENV_FILE" ]]; then
    echo "Missing env file: $ENV_FILE"
    echo "Create it before first deploy:"
    echo "  cp $ENV_EXAMPLE_FILE $ENV_FILE"
    echo "  nano $ENV_FILE"
    exit 1
  fi

  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
}

validate_env() {
  require_var "PUSH_PUBLIC_HOST"
  require_var "LETSENCRYPT_EMAIL"
  require_var "PUSH_API_TOKEN"
  require_var "FCM_PROJECT_ID"
  require_var "FCM_CREDENTIALS_JSON"
  require_var "APNS_TEAM_ID"
  require_var "APNS_KEY_ID"
  require_var "APNS_PRIVATE_KEY"
  require_var "APNS_VOIP_TOPIC"
  require_var "APNS_MESSAGES_TOPIC"
  require_var "APNS_USE_SANDBOX"
  require_var "PUSH_OBSERVABILITY_POSTGRES_PASSWORD"
  require_var "GRAFANA_ADMIN_PASSWORD"
  require_bool "APNS_USE_SANDBOX"

  if [[ "$PUSH_PUBLIC_HOST" == "localhost" || "$PUSH_PUBLIC_HOST" =~ ^127\. ]]; then
    echo "PUSH_PUBLIC_HOST must be a public DNS name"
    exit 1
  fi

  case "$(tls_provider)" in
    letsencrypt)
      require_var "LETSENCRYPT_EMAIL"
      ;;
    cloudflare_origin)
      require_var "PUSH_ORIGIN_CERT_PEM"
      require_var "PUSH_ORIGIN_KEY_PEM"
      if [[ "$PUSH_ORIGIN_CERT_PEM" != *"BEGIN CERTIFICATE"* ]]; then
        echo "PUSH_ORIGIN_CERT_PEM must contain a PEM certificate"
        exit 1
      fi
      if [[ "$PUSH_ORIGIN_KEY_PEM" != *"PRIVATE KEY"* ]]; then
        echo "PUSH_ORIGIN_KEY_PEM must contain a PEM private key"
        exit 1
      fi
      ;;
    *)
      echo "PUSH_TLS_PROVIDER must be letsencrypt or cloudflare_origin"
      exit 1
      ;;
  esac
}

install_base_packages() {
  if ! is_debian_like; then
    echo "This auto-deploy script supports clean Debian/Ubuntu hosts with apt-get."
    exit 1
  fi

  if [[ -z "$SUDO" ]]; then
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl gnupg lsb-release openssl iproute2
  else
    $SUDO apt-get update
    $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl gnupg lsb-release openssl iproute2
  fi
}

install_docker() {
  if docker compose version >/dev/null 2>&1; then
    return
  fi

  echo "Installing Docker Engine and Compose plugin..."

  install -m 0755 -d /tmp/peerlink-docker-install
  curl -fsSL https://get.docker.com -o /tmp/peerlink-docker-install/get-docker.sh
  if [[ -z "$SUDO" ]]; then
    sh /tmp/peerlink-docker-install/get-docker.sh
    systemctl enable --now docker
  else
    $SUDO sh /tmp/peerlink-docker-install/get-docker.sh
    $SUDO systemctl enable --now docker
    $SUDO usermod -aG docker "$USER" || true
  fi

  if ! docker compose version >/dev/null 2>&1; then
    echo "Docker Compose plugin was not installed correctly."
    echo "Log out/in if your user was just added to the docker group, or run this script with sudo."
    exit 1
  fi
}

configure_firewall() {
  if ! command -v ufw >/dev/null 2>&1; then
    return
  fi

  local status
  status="$($SUDO ufw status 2>/dev/null | head -n 1 || true)"
  if echo "$status" | grep -qi "Status: active"; then
    echo "Configuring UFW for push server..."
    $SUDO ufw allow 80/tcp || true
    $SUDO ufw allow 443/tcp || true
  fi
}

detect_public_ip() {
  curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null \
    || curl -fsS --max-time 5 https://ifconfig.me 2>/dev/null \
    || true
}

check_dns_points_here() {
  if uses_cloudflare_origin_tls; then
    return
  fi

  if [[ "${PUSH_SKIP_DNS_CHECK:-false}" == "true" ]]; then
    return
  fi

  local public_ip resolved_ips
  public_ip="$(detect_public_ip)"
  resolved_ips="$(getent ahosts "$PUSH_PUBLIC_HOST" 2>/dev/null | awk '{print $1}' | sort -u || true)"

  if [[ -z "$public_ip" || -z "$resolved_ips" ]]; then
    echo "Could not verify DNS for $PUSH_PUBLIC_HOST; continuing."
    return
  fi

  if ! echo "$resolved_ips" | grep -Fxq "$public_ip"; then
    echo "DNS for $PUSH_PUBLIC_HOST does not point to this server."
    echo "Current server IP: $public_ip"
    echo "DNS resolves to:"
    echo "$resolved_ips"
    echo "Fix DNS before deploy, or set PUSH_SKIP_DNS_CHECK=true if this is expected."
    exit 1
  fi
}

check_public_ports() {
  if compose ps -q push-proxy >/dev/null 2>&1 && [[ -n "$(compose ps -q push-proxy 2>/dev/null || true)" ]]; then
    return
  fi

  local listeners
  listeners="$(ss -ltn '( sport = :80 or sport = :443 )' 2>/dev/null | tail -n +2 || true)"
  if [[ -n "$listeners" ]]; then
    echo "Ports 80/443 appear to be in use. Stop the conflicting service before deploy."
    echo "$listeners"
    exit 1
  fi
}

has_existing_cert() {
  [[ -f "$LETSENCRYPT_DIR/live/$PUSH_PUBLIC_HOST/fullchain.pem" ]] \
    && [[ -f "$LETSENCRYPT_DIR/live/$PUSH_PUBLIC_HOST/privkey.pem" ]]
}

write_pem_env() {
  local value="$1"
  local target="$2"
  (umask 077 && printf '%b\n' "$value" > "$target")
}

install_cloudflare_origin_cert() {
  local live_dir="$LETSENCRYPT_DIR/live/$PUSH_PUBLIC_HOST"
  ensure_dir "$live_dir"
  write_pem_env "$PUSH_ORIGIN_CERT_PEM" "$live_dir/fullchain.pem"
  write_pem_env "$PUSH_ORIGIN_KEY_PEM" "$live_dir/privkey.pem"
}

write_push_locations() {
  cat <<'EOF_LOCATIONS'
    location = /health {
        limit_except GET { deny all; }
        proxy_pass http://push:4500/health;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 60s;
    }

    location = /devices/register {
        limit_except POST { deny all; }
        proxy_pass http://push:4500/devices/register;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 60s;
    }

    location = /devices/unregister {
        limit_except POST { deny all; }
        proxy_pass http://push:4500/devices/unregister;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 60s;
    }

    location = /events/push {
        limit_except POST { deny all; }
        proxy_pass http://push:4500/events/push;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 60s;
    }

    location = /events/message {
        limit_except POST { deny all; }
        proxy_pass http://push:4500/events/message;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 60s;
    }

    location = /events/call {
        limit_except POST { deny all; }
        proxy_pass http://push:4500/events/call;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 60s;
    }

    location = /moderation/reports {
        limit_except POST { deny all; }
        proxy_pass http://push:4500/moderation/reports;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 60s;
    }

    location = /moderation/status {
        limit_except GET { deny all; }
        proxy_pass http://push:4500/moderation/status;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 60s;
    }

    location = /moderation/appeals {
        limit_except POST { deny all; }
        proxy_pass http://push:4500/moderation/appeals;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 60s;
    }

    location / {
        return 404;
    }
EOF_LOCATIONS
}

write_http_only_nginx_config() {
  cat > "$NGINX_DIR/push.conf" <<EOF_HTTP
server {
    listen 80;
    listen [::]:80;
    server_name ${PUSH_PUBLIC_HOST};

    client_max_body_size 8m;

    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }

$(write_push_locations)
}
EOF_HTTP
}

write_tls_nginx_config() {
  cat > "$NGINX_DIR/push.conf" <<EOF_TLS
server {
    listen 80;
    listen [::]:80;
    server_name ${PUSH_PUBLIC_HOST};

    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }

    location / {
        return 301 https://\$host\$request_uri;
    }
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name ${PUSH_PUBLIC_HOST};

    ssl_certificate /etc/letsencrypt/live/${PUSH_PUBLIC_HOST}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${PUSH_PUBLIC_HOST}/privkey.pem;
    ssl_session_timeout 1d;
    ssl_session_cache shared:PeerLinkPushSSL:10m;
    ssl_session_tickets off;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers off;

    client_max_body_size 8m;

    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }

$(write_push_locations)
}
EOF_TLS
}

compose() {
  if docker info >/dev/null 2>&1; then
    docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"
  elif [[ -n "$SUDO" ]]; then
    $SUDO docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"
  else
    docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"
  fi
}

validate_fcm_credentials_json() {
  if ! compose run --rm --no-deps push \
    node -e 'JSON.parse(process.env.FCM_CREDENTIALS_JSON); console.log("FCM_CREDENTIALS_JSON ok")'; then
    echo "FCM_CREDENTIALS_JSON must be valid JSON. Wrap it in single quotes in .env.push.local."
    exit 1
  fi
}

main() {
  load_env
  validate_env
  install_base_packages
  require_command "curl"
  install_docker
  ensure_dir "$NGINX_DIR"
  ensure_dir "$WEBROOT_DIR"
  ensure_dir "$LETSENCRYPT_DIR"
  prepare_moderation_ui
  validate_fcm_credentials_json
  configure_firewall
  check_dns_points_here
  check_public_ports

  if uses_cloudflare_origin_tls; then
    echo "Installing Cloudflare Origin CA certificate for ${PUSH_PUBLIC_HOST}."
    install_cloudflare_origin_cert
    write_tls_nginx_config
    compose pull push-proxy push-observability-db prometheus grafana moderation-ui
    compose stop certbot-renewer >/dev/null 2>&1 || true
    compose up -d --build --remove-orphans "${PUSH_RUNTIME_SERVICES[@]}"
  elif has_existing_cert; then
    echo "Existing certificate found for ${PUSH_PUBLIC_HOST}; deploying HTTPS config."
    write_tls_nginx_config
    compose pull push-proxy certbot-renewer push-observability-db prometheus grafana moderation-ui
    compose up -d --build --remove-orphans "${PUSH_RUNTIME_SERVICES[@]}" certbot-renewer
  else
    echo "No certificate found for ${PUSH_PUBLIC_HOST}; bootstrapping HTTP challenge config."
    write_http_only_nginx_config
    compose pull push-proxy certbot certbot-renewer push-observability-db prometheus grafana moderation-ui
    compose up -d --build --remove-orphans "${PUSH_RUNTIME_SERVICES[@]}"

    compose run --rm certbot certonly \
      --webroot \
      -w /var/www/certbot \
      -d "$PUSH_PUBLIC_HOST" \
      --email "$LETSENCRYPT_EMAIL" \
      --agree-tos \
      --no-eff-email \
      --non-interactive \
      --keep-until-expiring

    write_tls_nginx_config
    compose up -d --build --remove-orphans "${PUSH_RUNTIME_SERVICES[@]}" certbot-renewer
  fi

  echo "Push stack is running."
  echo "Domain: https://${PUSH_PUBLIC_HOST}"
  echo "Compose file: $COMPOSE_FILE"
  echo "Env file: $ENV_FILE"
  echo "Certificates: $LETSENCRYPT_DIR"
}

main "$@"
