#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="$ROOT_DIR/docker-compose.push.yml"
ENV_FILE="$ROOT_DIR/.env.push.local"
ENV_EXAMPLE_FILE="$ROOT_DIR/.env.push.example"
DEPLOY_DIR="$ROOT_DIR/deploy/push"
NGINX_DIR="$DEPLOY_DIR/nginx/conf.d"
WEBROOT_DIR="$DEPLOY_DIR/certbot/www"
LETSENCRYPT_DIR="$DEPLOY_DIR/letsencrypt"

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
  require_bool "APNS_USE_SANDBOX"

  if ! node -e 'JSON.parse(process.env.FCM_CREDENTIALS_JSON)' >/dev/null 2>&1; then
    echo "FCM_CREDENTIALS_JSON must be valid JSON. Wrap it in single quotes in .env.push.local."
    exit 1
  fi

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

main() {
  load_env
  validate_env
  install_base_packages
  require_command "curl"
  install_docker
  configure_firewall
  check_dns_points_here
  check_public_ports

  ensure_dir "$NGINX_DIR"
  ensure_dir "$WEBROOT_DIR"
  ensure_dir "$LETSENCRYPT_DIR"

  if uses_cloudflare_origin_tls; then
    echo "Installing Cloudflare Origin CA certificate for ${PUSH_PUBLIC_HOST}."
    install_cloudflare_origin_cert
    write_tls_nginx_config
    compose pull push push-proxy
    compose stop certbot-renewer >/dev/null 2>&1 || true
    compose up -d --remove-orphans push push-proxy
  elif has_existing_cert; then
    echo "Existing certificate found for ${PUSH_PUBLIC_HOST}; deploying HTTPS config."
    write_tls_nginx_config
    compose pull
    compose up -d --remove-orphans push push-proxy certbot-renewer
  else
    echo "No certificate found for ${PUSH_PUBLIC_HOST}; bootstrapping HTTP challenge config."
    write_http_only_nginx_config
    compose pull push push-proxy certbot certbot-renewer
    compose up -d --remove-orphans push push-proxy

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
    compose up -d --remove-orphans push push-proxy certbot-renewer
  fi

  echo "Push stack is running."
  echo "Domain: https://${PUSH_PUBLIC_HOST}"
  echo "Compose file: $COMPOSE_FILE"
  echo "Env file: $ENV_FILE"
  echo "Certificates: $LETSENCRYPT_DIR"
}

main "$@"
