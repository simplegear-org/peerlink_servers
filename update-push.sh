```bash
#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
set -Eeuo pipefail

###############################################################################
# PeerLink Push — safe update/deploy
#
# Responsibilities:
#   1. Protect this script outside Git working tree.
#   2. Resolve the latest immutable push-v* release (legacy source-v* fallback).
#   3. Keep the newly downloaded updater in the working tree after git reset.
#   4. Validate env / compose / FCM credentials.
#   5. Pull versioned application images before touching running containers.
#   6. Generate nginx configuration.
#   7. Validate nginx config BEFORE activating it.
#   8. Deploy containers.
#   9. Wait for push readiness.
#  10. Verify push-proxy -> push.
#  11. Verify local HTTPS origin.
#  12. Verify public HTTPS endpoint.
#
# deploy-push.sh is NOT used.
###############################################################################

###############################################################################
# Paths / configuration
###############################################################################

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="${PEERLINK_PUSH_ROOT_DIR:-$SCRIPT_DIR}"
# shellcheck source=deploy/update-common.sh
source "$ROOT_DIR/deploy/update-common.sh"

COMPOSE_FILE="$ROOT_DIR/docker-compose.push.yml"
ENV_FILE="${PEERLINK_PUSH_ENV_FILE:-$ROOT_DIR/.env.push.local}"

BRANCH="${PEERLINK_PUSH_BRANCH:-main}"
REMOTE="${PEERLINK_PUSH_REMOTE:-origin}"
REPOSITORY="${PEERLINK_PUSH_REPOSITORY:-https://github.com/simplegear-org/peerlink_servers.git}"
TARGET_REF="${PEERLINK_PUSH_REF:-}"
TAG_PATTERN="${PEERLINK_PUSH_TAG_PATTERN:-push-v*}"
LEGACY_TAG_PATTERN="${PEERLINK_PUSH_LEGACY_TAG_PATTERN:-source-v*}"

DEPLOY_DIR="$ROOT_DIR/deploy/push"

NGINX_DIR="$DEPLOY_DIR/nginx/conf.d"
NGINX_CONFIG="$NGINX_DIR/push.conf"

MODERATION_UI_DIR="$DEPLOY_DIR/moderation-ui"

WEBROOT_DIR="$DEPLOY_DIR/certbot/www"
LETSENCRYPT_DIR="$DEPLOY_DIR/letsencrypt"

#
# IMPORTANT:
# This directory MUST live outside the Git repository.
#
OPS_DIR="${PEERLINK_PUSH_OPS_DIR:-$(dirname "$ROOT_DIR")/.peerlink-push-ops}"

PROTECTED_SCRIPT="$OPS_DIR/update-push.sh"
NGINX_CANDIDATE="$OPS_DIR/push.conf.candidate"
NGINX_BACKUP="$OPS_DIR/push.conf.backup"

LOCK_DIR="$OPS_DIR/update.lock"

PUSH_RUNTIME_SERVICES=(
  invite
  push
  server-checker
  push-observability-db
  prometheus
  grafana
  moderation-ui
  push-proxy
)

SUDO=""

if [[ "${EUID}" -ne 0 ]] && ! docker info >/dev/null 2>&1; then
  if ! command -v sudo >/dev/null 2>&1; then
    echo "Docker is unavailable for current user and sudo is missing."
    exit 1
  fi

  SUDO="sudo"
fi

###############################################################################
# Helpers
###############################################################################

log() {
  echo
  echo "================================================================"
  echo "$*"
  echo "================================================================"
}

fail() {
  echo
  echo "ERROR: $*" >&2
  exit 1
}

compose() {
  if [[ -n "$SUDO" ]]; then
    $SUDO docker compose \
      -f "$COMPOSE_FILE" \
      --env-file "$ENV_FILE" \
      "$@"
  else
    docker compose \
      -f "$COMPOSE_FILE" \
      --env-file "$ENV_FILE" \
      "$@"
  fi
}

###############################################################################
# Self protection
###############################################################################

protect_and_reexec() {
  ensure_dir "$OPS_DIR"

  cp -p "${BASH_SOURCE[0]}" "$PROTECTED_SCRIPT"
  chmod 700 "$PROTECTED_SCRIPT"

  bash -n "$PROTECTED_SCRIPT"

  log "Operational script protected"

  echo "Protected copy:"
  echo "  $PROTECTED_SCRIPT"

  exec env \
    PEERLINK_PUSH_PROTECTED_RUN=true \
    PEERLINK_PUSH_ROOT_DIR="$ROOT_DIR" \
    PEERLINK_PUSH_ENV_FILE="$ENV_FILE" \
    PEERLINK_PUSH_OPS_DIR="$OPS_DIR" \
    PEERLINK_PUSH_BRANCH="$BRANCH" \
    PEERLINK_PUSH_REMOTE="$REMOTE" \
    PEERLINK_PUSH_REPOSITORY="$REPOSITORY" \
    PEERLINK_PUSH_REF="$TARGET_REF" \
    "$PROTECTED_SCRIPT" "$@"
}

validate_checked_out_updater() {
  [[ -f "$ROOT_DIR/update-push.sh" ]] || fail "Updated checkout is missing update-push.sh"
  bash -n "$ROOT_DIR/update-push.sh"
}

latest_release_ref() {
  local ref
  ref="$(git tag --list "$TAG_PATTERN" --sort=-v:refname | head -n 1)"
  if [[ -z "$ref" ]]; then
    ref="$(git tag --list "$LEGACY_TAG_PATTERN" --sort=-v:refname | head -n 1)"
  fi
  [[ -n "$ref" ]] || fail "No push release tag found ($TAG_PATTERN or $LEGACY_TAG_PATTERN)"
  printf '%s\n' "$ref"
}

###############################################################################
# Lock
###############################################################################

acquire_lock() {
  ensure_dir "$OPS_DIR"

  if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    fail "Another push update appears to be running: $LOCK_DIR"
  fi

  trap 'rm -rf "$LOCK_DIR"' EXIT
}

###############################################################################
# Environment
###############################################################################

load_env() {
  require_file "$ENV_FILE"

  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
}

require_var() {
  local name="$1"
  local value="${!name:-}"

  if [[ -z "$value" || "$value" == "change_me" || "$value" == "true/false" ]]; then
    fail "Missing required env: $name"
  fi
}

validate_env() {
  require_var "PUSH_PUBLIC_HOST"

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

  if [[ "$APNS_USE_SANDBOX" != "true" && "$APNS_USE_SANDBOX" != "false" ]]; then
    fail "APNS_USE_SANDBOX must be exactly true or false"
  fi

  case "${PUSH_TLS_PROVIDER:-letsencrypt}" in
    letsencrypt)
      require_var "LETSENCRYPT_EMAIL"
      ;;

    cloudflare_origin)
      require_var "PUSH_ORIGIN_CERT_PEM"
      require_var "PUSH_ORIGIN_KEY_PEM"

      [[ "$PUSH_ORIGIN_CERT_PEM" == *"BEGIN CERTIFICATE"* ]] \
        || fail "PUSH_ORIGIN_CERT_PEM is invalid"

      [[ "$PUSH_ORIGIN_KEY_PEM" == *"PRIVATE KEY"* ]] \
        || fail "PUSH_ORIGIN_KEY_PEM is invalid"
      ;;

    *)
      fail "PUSH_TLS_PROVIDER must be letsencrypt or cloudflare_origin"
      ;;
  esac
}

###############################################################################
# Git update
###############################################################################

check_local_changes() {
  local changes

  changes="$(
    {
      git diff --name-only
      git diff --cached --name-only
    } |
      sort -u |
      grep -vE '^(update-push\.sh|deploy-push\.sh)$' \
      || true
  )"

  if [[ -n "$changes" ]]; then
    echo
    echo "Local tracked changes detected:"
    echo "$changes"
    echo

    fail "Refusing git reset. Commit/stash these changes first."
  fi
}

update_repository() {
  log "Updating repository"

  local old_commit
  local selected_ref="$TARGET_REF"
  local target_commit

  old_commit="$(git rev-parse HEAD)"
  echo "Current:"
  echo "  $old_commit"

  git remote set-url "$REMOTE" "$REPOSITORY"
  git fetch --tags "$REMOTE" "$BRANCH"

  if [[ -z "$selected_ref" ]]; then
    selected_ref="$(latest_release_ref)"
  fi

  target_commit="$(git rev-parse --verify "${selected_ref}^{commit}")" \
    || fail "Unknown push update ref: $selected_ref"

  echo
  echo "Push release:"
  echo "  $selected_ref"
  echo "Commit:"
  echo "  $target_commit"

  git checkout -B "$BRANCH" "$target_commit"
  git reset --hard "$target_commit"

  # Finish this rollout from the protected copy, but retain the newly
  # downloaded updater for the next invocation.
  validate_checked_out_updater

  echo
  echo "Updated:"
  echo "  $(git rev-parse HEAD)"
}

###############################################################################
# Validation
###############################################################################

validate_compose() {
  log "Validating Docker Compose"

  compose config -q

  echo "Docker Compose configuration OK."
}

validate_fcm() {
  log "Validating FCM credentials"

  compose run \
    --rm \
    --no-deps \
    push \
    node -e '
      JSON.parse(process.env.FCM_CREDENTIALS_JSON);
      console.log("FCM_CREDENTIALS_JSON OK");
    '
}

###############################################################################
# Pull application images before replacing running services
###############################################################################

pull_application_images() {
  log "Pulling versioned application images"

  compose pull \
    invite \
    push \
    server-checker

  echo "Application images pulled successfully."
}

###############################################################################
# TLS
###############################################################################

tls_provider() {
  echo "${PUSH_TLS_PROVIDER:-letsencrypt}"
}

has_certificate() {
  [[ -f "$LETSENCRYPT_DIR/live/$PUSH_PUBLIC_HOST/fullchain.pem" ]] \
    && [[ -f "$LETSENCRYPT_DIR/live/$PUSH_PUBLIC_HOST/privkey.pem" ]]
}

write_pem() {
  local value="$1"
  local target="$2"

  (
    umask 077
    printf '%b\n' "$value" > "$target"
  )
}

install_cloudflare_origin_certificate() {
  local live_dir

  live_dir="$LETSENCRYPT_DIR/live/$PUSH_PUBLIC_HOST"

  ensure_dir "$live_dir"

  write_pem \
    "$PUSH_ORIGIN_CERT_PEM" \
    "$live_dir/fullchain.pem"

  write_pem \
    "$PUSH_ORIGIN_KEY_PEM" \
    "$live_dir/privkey.pem"
}

###############################################################################
# Moderation UI nginx
###############################################################################

write_moderation_nginx() {
  ensure_dir "$MODERATION_UI_DIR"

  cat > "$MODERATION_UI_DIR/nginx.conf" <<'EOF'
resolver 127.0.0.11 valid=10s ipv6=off;

upstream moderation_push_backend {
    zone moderation_push_backend 64k;
    server push:4500 resolve;
}

server {
    listen 80;
    server_name _;

    root /usr/share/nginx/html;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }

    location /api/ {
        proxy_pass http://moderation_push_backend/;

        proxy_http_version 1.1;

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
EOF
}

###############################################################################
# Push nginx configuration
###############################################################################

write_nginx_upstreams() {
  cat <<'EOF'
resolver 127.0.0.11 valid=10s ipv6=off;

upstream peerlink_push_backend {
    zone peerlink_push_backend 64k;
    server push:4500 resolve;
}

upstream peerlink_invite_backend {
    zone peerlink_invite_backend 64k;
    server invite:4600 resolve;
}
EOF
}

write_nginx_locations() {
  cat <<'EOF'
    location = /invites {
        limit_req zone=invite_create burst=10 nodelay;
        limit_except POST { deny all; }

        proxy_pass http://peerlink_invite_backend/invites;

        proxy_http_version 1.1;

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location ~ "^/invites/[A-Za-z0-9_-]{22,128}$" {
        limit_except GET { deny all; }

        proxy_pass http://peerlink_invite_backend;

        proxy_http_version 1.1;

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location = /health {
        limit_except GET { deny all; }

        proxy_pass http://peerlink_push_backend/health;

        proxy_http_version 1.1;

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        proxy_read_timeout 60s;
    }

    location = /devices/register {
        limit_except POST { deny all; }

        proxy_pass http://peerlink_push_backend/devices/register;

        proxy_http_version 1.1;

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        proxy_read_timeout 60s;
    }

    location = /devices/access-policy {
        limit_except POST { deny all; }

        proxy_pass http://peerlink_push_backend/devices/access-policy;

        proxy_http_version 1.1;

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        proxy_read_timeout 60s;
    }

    location = /devices/unregister {
        limit_except POST { deny all; }

        proxy_pass http://peerlink_push_backend/devices/unregister;

        proxy_http_version 1.1;

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        proxy_read_timeout 60s;
    }

    location = /events/push {
        limit_except POST { deny all; }

        proxy_pass http://peerlink_push_backend/events/push;

        proxy_http_version 1.1;

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        proxy_read_timeout 60s;
    }

    location = /events/message {
        limit_except POST { deny all; }

        proxy_pass http://peerlink_push_backend/events/message;

        proxy_http_version 1.1;

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        proxy_read_timeout 60s;
    }

    location = /events/call {
        limit_except POST { deny all; }

        proxy_pass http://peerlink_push_backend/events/call;

        proxy_http_version 1.1;

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        proxy_read_timeout 60s;
    }

    location = /moderation/reports {
        limit_except POST { deny all; }

        proxy_pass http://peerlink_push_backend/moderation/reports;

        proxy_http_version 1.1;

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        proxy_read_timeout 60s;
    }

    location = /moderation/status {
        limit_except GET { deny all; }

        proxy_pass http://peerlink_push_backend/moderation/status;

        proxy_http_version 1.1;

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        proxy_read_timeout 60s;
    }

    location = /moderation/appeals {
        limit_except POST { deny all; }

        proxy_pass http://peerlink_push_backend/moderation/appeals;

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
EOF
}

generate_http_nginx_candidate() {
  cat > "$NGINX_CANDIDATE" <<EOF
limit_req_zone \$binary_remote_addr zone=invite_create:10m rate=1r/m;

$(write_nginx_upstreams)

server {
    listen 80;
    listen [::]:80;

    server_name ${PUSH_PUBLIC_HOST};

    client_max_body_size 8m;

    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }

$(write_nginx_locations)
}
EOF
}

generate_tls_nginx_candidate() {
  cat > "$NGINX_CANDIDATE" <<EOF
limit_req_zone \$binary_remote_addr zone=invite_create:10m rate=1r/m;

$(write_nginx_upstreams)

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
    listen 443 ssl;
    listen [::]:443 ssl;

    http2 on;

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

$(write_nginx_locations)
}
EOF
}

###############################################################################
# Nginx safe activation
###############################################################################

backup_current_nginx() {
  rm -f "$NGINX_BACKUP"

  if [[ -f "$NGINX_CONFIG" ]]; then
    cp -p "$NGINX_CONFIG" "$NGINX_BACKUP"
  fi
}

validate_nginx_candidate() {
  log "Validating nginx candidate"

  #
  # Override only push.conf inside temporary container.
  # Existing production nginx process is untouched.
  #
  compose run \
    --rm \
    --no-deps \
    -v "$NGINX_CANDIDATE:/etc/nginx/conf.d/push.conf:ro" \
    push-proxy \
    nginx -t

  echo "Nginx candidate is valid."
}

activate_nginx_candidate() {
  ensure_dir "$NGINX_DIR"

  backup_current_nginx

  cp "$NGINX_CANDIDATE" "$NGINX_CONFIG"

  echo "Validated nginx configuration installed."
}

rollback_nginx() {
  echo
  echo "Deployment failed."

  if [[ -f "$NGINX_BACKUP" ]]; then
    echo "Restoring previous nginx configuration..."

    cp -p "$NGINX_BACKUP" "$NGINX_CONFIG"

    compose restart push-proxy >/dev/null 2>&1 || true
  fi
}

###############################################################################
# Readiness
###############################################################################

wait_for_push() {
  local attempts="${PUSH_READY_ATTEMPTS:-45}"
  local delay="${PUSH_READY_DELAY_SECONDS:-2}"
  local attempt

  log "Waiting for push:4500"

  for ((attempt = 1; attempt <= attempts; attempt++)); do
    if compose exec -T push \
      node -e "
        fetch('http://127.0.0.1:4500/health')
          .then(r => {
            if (!r.ok) process.exit(1);
          })
          .catch(() => process.exit(1));
      " >/dev/null 2>&1
    then
      echo "Push service ready."
      return
    fi

    sleep "$delay"
  done

  compose logs --tail=100 push || true

  fail "Push service did not become ready"
}

wait_for_proxy_backend() {
  local attempts=30
  local delay=2
  local attempt

  log "Checking push-proxy -> push"

  for ((attempt = 1; attempt <= attempts; attempt++)); do
    if compose exec -T push-proxy \
      wget -q -O /dev/null http://push:4500/health \
      >/dev/null 2>&1
    then
      echo "Proxy can reach push backend."
      return
    fi

    sleep "$delay"
  done

  compose logs --tail=100 push-proxy || true

  fail "push-proxy cannot reach push:4500"
}

wait_for_local_https() {
  local attempts=30
  local delay=2
  local attempt

  log "Checking local HTTPS origin"

  for ((attempt = 1; attempt <= attempts; attempt++)); do
    if curl \
      -kfsS \
      --max-time 5 \
      --resolve "${PUSH_PUBLIC_HOST}:443:127.0.0.1" \
      "https://${PUSH_PUBLIC_HOST}/health" \
      >/dev/null
    then
      echo "Local HTTPS origin OK."
      return
    fi

    sleep "$delay"
  done

  fail "Local HTTPS origin health check failed"
}

wait_for_public_https() {
  local attempts=30
  local delay=2
  local attempt

  log "Checking public HTTPS endpoint"

  for ((attempt = 1; attempt <= attempts; attempt++)); do
    if curl \
      -kfsS \
      --max-time 10 \
      "https://${PUSH_PUBLIC_HOST}/health" \
      >/dev/null
    then
      echo "Public HTTPS health OK."
      return
    fi

    sleep "$delay"
  done

  fail "Public HTTPS endpoint did not become healthy"
}

###############################################################################
# Infrastructure images
###############################################################################

pull_infrastructure_images() {
  log "Pulling infrastructure images"

  compose pull \
    push-proxy \
    push-observability-db \
    prometheus \
    grafana \
    moderation-ui
}

###############################################################################
# Runtime deploy
###############################################################################

start_runtime() {
  log "Starting runtime stack"

  compose up \
    -d \
    --remove-orphans \
    "${PUSH_RUNTIME_SERVICES[@]}"
}

finalize_runtime() {
  wait_for_push

  #
  # Config contains dynamic Docker DNS resolution, but restart also guarantees
  # activation of the freshly installed configuration.
  #
  compose restart push-proxy

  wait_for_proxy_backend
  wait_for_local_https
  wait_for_public_https
}

###############################################################################
# Let's Encrypt initial bootstrap
###############################################################################

bootstrap_letsencrypt() {
  log "Bootstrapping Let's Encrypt"

  generate_http_nginx_candidate
  validate_nginx_candidate
  activate_nginx_candidate

  pull_infrastructure_images

  start_runtime

  wait_for_push

  compose restart push-proxy

  compose run \
    --rm \
    certbot \
    certonly \
    --webroot \
    -w /var/www/certbot \
    -d "$PUSH_PUBLIC_HOST" \
    --email "$LETSENCRYPT_EMAIL" \
    --agree-tos \
    --no-eff-email \
    --non-interactive \
    --keep-until-expiring

  has_certificate \
    || fail "Let's Encrypt certificate was not created"

  generate_tls_nginx_candidate
  validate_nginx_candidate
  activate_nginx_candidate

  compose up \
    -d \
    certbot-renewer

  compose restart push-proxy

  finalize_runtime
}

###############################################################################
# Normal HTTPS deployment
###############################################################################

deploy_https() {
  if [[ "$(tls_provider)" == "cloudflare_origin" ]]; then
    log "Installing Cloudflare Origin certificate"

    install_cloudflare_origin_certificate

    compose stop certbot-renewer >/dev/null 2>&1 || true
  fi

  generate_tls_nginx_candidate
  validate_nginx_candidate

  #
  # Do not install new nginx config until all source/build validation passed.
  #
  activate_nginx_candidate

  pull_infrastructure_images

  start_runtime

  if [[ "$(tls_provider)" == "letsencrypt" ]]; then
    compose up \
      -d \
      certbot-renewer
  fi

  finalize_runtime
}

###############################################################################
# Status
###############################################################################

show_status() {
  log "Deployment status"

  compose ps

  echo
  echo "Push:"
  compose logs --tail=30 push || true

  echo
  echo "Invite:"
  compose logs --tail=30 invite || true

  echo
  echo "Push proxy:"
  compose logs --tail=30 push-proxy || true

  echo
  echo "Server checker:"
  compose logs --tail=30 server-checker || true
}

###############################################################################
# Main
###############################################################################

main() {
  require_command git
  require_command docker
  require_command curl

  #
  # Critical:
  # escape from Git working tree before any reset/checkout.
  #
  if [[ "${PEERLINK_PUSH_PROTECTED_RUN:-false}" != "true" ]]; then
    protect_and_reexec "$@"
  fi

  acquire_lock

  cd "$ROOT_DIR"

  require_file "$COMPOSE_FILE"
  require_file "$ENV_FILE"

  load_env
  validate_env

  check_local_changes

  update_repository

  #
  # Reload env after Git update just in case working tree content changed.
  #
  load_env
  validate_env

  validate_compose
  validate_fcm

  #
  # Pull failures happen BEFORE touching running services.
  #
  pull_application_images

  ensure_dir "$OPS_DIR"
  ensure_dir "$NGINX_DIR"
  ensure_dir "$WEBROOT_DIR"
  ensure_dir "$LETSENCRYPT_DIR"

  write_moderation_nginx

  #
  # From this point nginx rollback becomes relevant.
  #
  trap rollback_nginx ERR

  if [[ "$(tls_provider)" == "cloudflare_origin" ]]; then
    deploy_https

  elif has_certificate; then
    deploy_https

  else
    bootstrap_letsencrypt
  fi

  trap - ERR

  rm -f "$NGINX_BACKUP"
  rm -f "$NGINX_CANDIDATE"

  show_status

  log "SUCCESS"

  echo "Push stack update completed successfully."
  echo
  echo "Repository:"
  echo "  $ROOT_DIR"
  echo
  echo "Commit:"
  echo "  $(git rev-parse HEAD)"
  echo
  echo "Protected operational script:"
  echo "  $PROTECTED_SCRIPT"
  echo
  echo "Health:"
  echo "  https://${PUSH_PUBLIC_HOST}/health"
}

main "$@"
```
