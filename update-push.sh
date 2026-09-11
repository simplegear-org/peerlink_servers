#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

ENV_FILE="${PEERLINK_PUSH_ENV_FILE:-$ROOT_DIR/.env.push.local}"
DEPLOY_SCRIPT="$ROOT_DIR/deploy-push.sh"

BRANCH="${PEERLINK_PUSH_BRANCH:-main}"
REMOTE="${PEERLINK_PUSH_REMOTE:-origin}"

SUDO=""

if [[ "${EUID}" -ne 0 ]] && ! docker info >/dev/null 2>&1; then
  if ! command -v sudo >/dev/null 2>&1; then
    echo "Docker is not available for current user and sudo is missing."
    exit 1
  fi

  SUDO="sudo"
fi

require_file() {
  local path="$1"

  if [[ ! -f "$path" ]]; then
    echo "Missing required file: $path"
    exit 1
  fi
}

require_command() {
  local name="$1"

  if ! command -v "$name" >/dev/null 2>&1; then
    echo "Missing required command: $name"
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
  local name
  local value

  for name in \
    PUSH_API_TOKEN \
    FCM_PROJECT_ID \
    FCM_CREDENTIALS_JSON \
    APNS_TEAM_ID \
    APNS_KEY_ID \
    APNS_PRIVATE_KEY \
    APNS_VOIP_TOPIC \
    APNS_MESSAGES_TOPIC \
    APNS_USE_SANDBOX \
    PUSH_OBSERVABILITY_POSTGRES_PASSWORD \
    GRAFANA_ADMIN_PASSWORD
  do
    value="${!name:-}"

    if [[ -z "$value" || "$value" == "change_me" || "$value" == "true/false" ]]; then
      missing+=("$name")
    fi
  done

  if (( ${#missing[@]} > 0 )); then
    echo "Missing required env values in $ENV_FILE:"
    printf '  %s\n' "${missing[@]}"
    exit 1
  fi

  if [[ "${APNS_USE_SANDBOX}" != "true" && "${APNS_USE_SANDBOX}" != "false" ]]; then
    echo "APNS_USE_SANDBOX must be exactly true or false"
    exit 1
  fi
}

update_repository() {
  echo "Updating repository from ${REMOTE}/${BRANCH}..."

  git fetch "$REMOTE" "$BRANCH"

  git checkout -B \
    "$BRANCH" \
    "$REMOTE/$BRANCH"

  git reset \
    --hard \
    "$REMOTE/$BRANCH"
}

run_deploy() {
  require_file "$DEPLOY_SCRIPT"

  chmod +x "$DEPLOY_SCRIPT"

  echo
  echo "Repository updated."
  echo "Starting canonical push deployment..."
  echo

  #
  # update-push.sh owns only git update.
  #
  # All deployment logic, nginx generation, validation, service readiness,
  # TLS handling and proxy activation live in deploy-push.sh.
  #
  # System package installation/firewall setup are skipped here because this
  # is an update of an already deployed server, not a first-time installation.
  #
  PEERLINK_PUSH_ENV_FILE="$ENV_FILE" \
  PEERLINK_PUSH_SKIP_SYSTEM_SETUP=true \
    "$DEPLOY_SCRIPT"
}

show_recent_logs() {
  echo
  echo "Recent push logs:"
  docker compose \
    -f "$ROOT_DIR/docker-compose.push.yml" \
    --env-file "$ENV_FILE" \
    logs \
    --tail=40 \
    push || true

  echo
  echo "Recent invite logs:"
  docker compose \
    -f "$ROOT_DIR/docker-compose.push.yml" \
    --env-file "$ENV_FILE" \
    logs \
    --tail=40 \
    invite || true

  echo
  echo "Recent push-proxy logs:"
  docker compose \
    -f "$ROOT_DIR/docker-compose.push.yml" \
    --env-file "$ENV_FILE" \
    logs \
    --tail=40 \
    push-proxy || true

  echo
  echo "Recent server-checker logs:"
  docker compose \
    -f "$ROOT_DIR/docker-compose.push.yml" \
    --env-file "$ENV_FILE" \
    logs \
    --tail=40 \
    server-checker || true
}

main() {
  cd "$ROOT_DIR"

  require_command "git"
  require_command "docker"

  require_file "$ROOT_DIR/docker-compose.push.yml"

  load_env
  validate_env

  update_repository

  #
  # deploy-push.sh comes from the just-fetched revision,
  # so check it only after git update.
  #
  require_file "$DEPLOY_SCRIPT"

  run_deploy

  show_recent_logs

  echo
  echo "Push stack update completed successfully."
}

main "$@"