#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
set -Eeuo pipefail

# Updates the already deployed bootstrap, relay and TURN stack without rerunning
# first-install provisioning from deploy.sh.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="${PEERLINK_SERVER_ROOT_DIR:-$SCRIPT_DIR}"
# shellcheck source=deploy/update-common.sh
source "$ROOT_DIR/deploy/update-common.sh"
COMPOSE_FILE="$ROOT_DIR/docker-compose.yml"
BRANCH="${PEERLINK_SERVER_BRANCH:-main}"
REMOTE="${PEERLINK_SERVER_REMOTE:-origin}"
REPOSITORY="${PEERLINK_SERVER_REPOSITORY:-https://github.com/simplegear-org/peerlink_servers.git}"
TARGET_REF="${PEERLINK_SERVER_REF:-$REMOTE/$BRANCH}"
OPS_DIR="${PEERLINK_SERVER_OPS_DIR:-$(dirname "$ROOT_DIR")/.peerlink-server-ops}"
PROTECTED_SCRIPT="$OPS_DIR/update-server.sh"
LOCK_DIR="$OPS_DIR/update.lock"
SUDO=""

if [[ "${EUID}" -ne 0 ]] && ! docker info >/dev/null 2>&1; then
  command -v sudo >/dev/null 2>&1 \
    || { echo "Docker is unavailable for current user and sudo is missing." >&2; exit 1; }
  SUDO="sudo"
fi

log() {
  echo
  echo "================================================================"
  echo "$*"
  echo "================================================================"
}

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

compose() {
  if [[ -n "$SUDO" ]]; then
    $SUDO docker compose -f "$COMPOSE_FILE" "$@"
  else
    docker compose -f "$COMPOSE_FILE" "$@"
  fi
}

protect_and_reexec() {
  mkdir -p "$OPS_DIR"
  cp -p "${BASH_SOURCE[0]}" "$PROTECTED_SCRIPT"
  chmod 700 "$PROTECTED_SCRIPT"
  bash -n "$PROTECTED_SCRIPT"

  exec env \
    PEERLINK_SERVER_PROTECTED_RUN=true \
    PEERLINK_SERVER_ROOT_DIR="$ROOT_DIR" \
    PEERLINK_SERVER_BRANCH="$BRANCH" \
    PEERLINK_SERVER_REMOTE="$REMOTE" \
    PEERLINK_SERVER_REPOSITORY="$REPOSITORY" \
    PEERLINK_SERVER_REF="$TARGET_REF" \
    PEERLINK_SERVER_OPS_DIR="$OPS_DIR" \
    "$PROTECTED_SCRIPT" "$@"
}

restore_self_to_repository() {
  cp -p "$PROTECTED_SCRIPT" "$ROOT_DIR/update-server.sh"
  chmod +x "$ROOT_DIR/update-server.sh"
  bash -n "$ROOT_DIR/update-server.sh"
  cmp -s "$PROTECTED_SCRIPT" "$ROOT_DIR/update-server.sh" \
    || fail "Restored update-server.sh differs from protected copy"
}

acquire_lock() {
  mkdir -p "$OPS_DIR"
  mkdir "$LOCK_DIR" 2>/dev/null \
    || fail "Another server update appears to be running: $LOCK_DIR"
  trap 'rm -rf "$LOCK_DIR"' EXIT
}

check_local_changes() {
  local changes
  changes="$(
    {
      git diff --name-only
      git diff --cached --name-only
    } | sort -u | grep -vE '^(update-server\.sh|update-push\.sh)$' || true
  )"

  [[ -z "$changes" ]] && return
  echo "Local tracked changes detected:" >&2
  echo "$changes" >&2
  fail "Refusing git reset. Commit or stash these changes first."
}

update_repository() {
  log "Updating repository"
  git remote set-url "$REMOTE" "$REPOSITORY"
  git fetch --tags "$REMOTE" "$BRANCH"
  local target_commit
  target_commit="$(git rev-parse --verify "${TARGET_REF}^{commit}")" \
    || fail "Unknown update ref: $TARGET_REF"
  git checkout -B "$BRANCH" "$target_commit"
  git reset --hard "$target_commit"
  restore_self_to_repository
  echo "Updated to: $(git rev-parse HEAD)"
}

validate_deployment_files() {
  require_file "$COMPOSE_FILE"
  require_file "$ROOT_DIR/haproxy.cfg"
  require_file "$ROOT_DIR/turnserver.conf"
  compose config -q
}

pull_runtime_images() {
  log "Pulling versioned bootstrap, relay, HAProxy and coturn images"
  compose pull relay signal haproxy coturn
}

rollout() {
  log "Rolling out bootstrap, relay and TURN"
  compose up -d --force-recreate --remove-orphans relay signal haproxy coturn
}

wait_for_http() {
  local url="$1"
  local label="$2"
  local attempt

  for ((attempt = 1; attempt <= 30; attempt++)); do
    if curl -kfsS --max-time 5 "$url" >/dev/null; then
      echo "$label ready."
      return
    fi
    sleep 2
  done
  fail "$label did not become ready: $url"
}

verify_runtime() {
  log "Verifying runtime"
  wait_for_http "http://127.0.0.1:4000/health" "Relay"
  wait_for_http "https://127.0.0.1:444/health" "HAProxy relay route"

  compose ps --status running | grep -Eq '(^|[[:space:]])signal([[:space:]]|$)' \
    || fail "Bootstrap signal container is not running"
  compose ps --status running | grep -Eq '(^|[[:space:]])coturn([[:space:]]|$)' \
    || fail "coturn container is not running"

  echo "Bootstrap and TURN containers are running."
}

show_status() {
  log "Deployment status"
  compose ps
  compose logs --tail=30 relay signal coturn haproxy || true
}

refresh_auto_update_runner() {
  [[ -f /etc/peerlink-server-updater/config.env ]] || return
  [[ -x "$ROOT_DIR/install-auto-update.sh" ]] || return

  log "Refreshing auto-update runner"
  "$ROOT_DIR/install-auto-update.sh" --refresh
}

main() {
  require_command git
  require_command docker
  require_command curl
  require_command cmp

  if [[ "${PEERLINK_SERVER_PROTECTED_RUN:-false}" != "true" ]]; then
    protect_and_reexec "$@"
  fi

  acquire_lock
  cd "$ROOT_DIR"
  require_file "$COMPOSE_FILE"
  check_local_changes
  update_repository
  validate_deployment_files
  pull_runtime_images
  rollout
  verify_runtime
  refresh_auto_update_runner
  show_status

  log "SUCCESS"
  echo "Bootstrap, relay and TURN update completed successfully."
  echo "Protected operational script: $PROTECTED_SCRIPT"
}

main "$@"
