#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="$ROOT_DIR/docker-compose.push.yml"
ENV_FILE="${PEERLINK_PUSH_ENV_FILE:-$ROOT_DIR/.env.push.local}"
BRANCH="${PEERLINK_PUSH_BRANCH:-main}"
REMOTE="${PEERLINK_PUSH_REMOTE:-origin}"
RUNTIME_SERVICES=(push server-checker push-observability-db prometheus grafana moderation-ui push-proxy certbot-renewer)

SUDO=""
if [[ "${EUID}" -ne 0 ]] && ! docker info >/dev/null 2>&1; then
  if ! command -v sudo >/dev/null 2>&1; then
    echo "Docker is not available for current user and sudo is missing."
    exit 1
  fi
  SUDO="sudo"
fi

compose() {
  if [[ -n "$SUDO" ]]; then
    $SUDO docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"
  else
    docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"
  fi
}

require_file() {
  if [[ ! -f "$1" ]]; then
    echo "Missing required file: $1"
    exit 1
  fi
}

load_env() {
  require_file "$ENV_FILE"
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
}

validate_env() {
  local missing=()
  for name in PUSH_API_TOKEN FCM_PROJECT_ID FCM_CREDENTIALS_JSON APNS_TEAM_ID APNS_KEY_ID APNS_PRIVATE_KEY APNS_VOIP_TOPIC APNS_MESSAGES_TOPIC APNS_USE_SANDBOX PUSH_OBSERVABILITY_POSTGRES_PASSWORD GRAFANA_ADMIN_PASSWORD; do
    local value="${!name:-}"
    if [[ -z "$value" || "$value" == "change_me" || "$value" == "true/false" ]]; then
      missing+=("$name")
    fi
  done
  if (( ${#missing[@]} > 0 )); then
    echo "Missing required env values in $ENV_FILE:"
    printf '  %s\n' "${missing[@]}"
    exit 1
  fi
}

main() {
  cd "$ROOT_DIR"
  require_file "$COMPOSE_FILE"
  load_env
  validate_env

  git fetch "$REMOTE" "$BRANCH"
  git checkout -B "$BRANCH" "$REMOTE/$BRANCH"
  git reset --hard "$REMOTE/$BRANCH"

  compose pull push-proxy push-observability-db prometheus grafana moderation-ui certbot-renewer
  compose up -d --build --remove-orphans "${RUNTIME_SERVICES[@]}"
  compose restart push-proxy moderation-ui
  compose ps

  echo
  echo "Recent push logs:"
  compose logs --tail=40 push
  echo
  echo "Recent server-checker logs:"
  compose logs --tail=40 server-checker
}

main "$@"
