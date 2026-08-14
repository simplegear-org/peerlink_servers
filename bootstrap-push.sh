#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/simplegear-org/peerlink_servers.git}"
INSTALL_DIR="${INSTALL_DIR:-/opt/peerlink_servers}"
ENV_FILE="$INSTALL_DIR/.env.push.local"
ENV_EXAMPLE_FILE="$INSTALL_DIR/.env.push.example"

SUDO=""
if [[ "${EUID}" -ne 0 ]]; then
  if ! command -v sudo >/dev/null 2>&1; then
    echo "Run this script as root, or install sudo for the current user."
    exit 1
  fi
  SUDO="sudo"
fi

is_debian_like() {
  [[ -f /etc/debian_version ]] && command -v apt-get >/dev/null 2>&1
}

apt_install() {
  if ! is_debian_like; then
    echo "This bootstrap script supports clean Debian/Ubuntu hosts with apt-get."
    exit 1
  fi

  if [[ -z "$SUDO" ]]; then
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y "$@"
  else
    $SUDO apt-get update
    $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y "$@"
  fi
}

ensure_base_system() {
  echo "Installing base packages..."
  apt_install ca-certificates curl git nano openssl iproute2
}

ensure_project() {
  if [[ -d "$INSTALL_DIR/.git" ]]; then
    echo "Updating project in $INSTALL_DIR..."
    git -C "$INSTALL_DIR" pull --ff-only
    return
  fi

  if [[ -e "$INSTALL_DIR" ]]; then
    echo "Install dir exists but is not a git repo: $INSTALL_DIR"
    exit 1
  fi

  echo "Cloning project to $INSTALL_DIR..."
  if [[ -z "$SUDO" ]]; then
    mkdir -p "$(dirname "$INSTALL_DIR")"
    git clone "$REPO_URL" "$INSTALL_DIR"
  else
    $SUDO mkdir -p "$(dirname "$INSTALL_DIR")"
    $SUDO git clone "$REPO_URL" "$INSTALL_DIR"
    $SUDO chown -R "$USER":"$(id -gn)" "$INSTALL_DIR" 2>/dev/null || true
  fi
}

ensure_env() {
  if [[ -f "$ENV_FILE" ]]; then
    return
  fi

  cp "$ENV_EXAMPLE_FILE" "$ENV_FILE"
  chmod 600 "$ENV_FILE"

  echo
  echo "Created $ENV_FILE"
  echo "Fill it now, then rerun:"
  echo "  cd $INSTALL_DIR"
  echo "  ./bootstrap-push.sh"
  echo
  echo "Required before rerun:"
  echo "- DNS A record for PUSH_PUBLIC_HOST is configured"
  echo "- LETSENCRYPT_EMAIL, or PUSH_TLS_PROVIDER=cloudflare_origin with Origin CA cert/key"
  echo "- PUSH_API_TOKEN"
  echo "- FCM_PROJECT_ID and FCM_CREDENTIALS_JSON"
  echo "- APNS_TEAM_ID, APNS_KEY_ID, APNS_PRIVATE_KEY, APNS topics"
  exit 2
}

run_deploy() {
  chmod +x "$INSTALL_DIR/deploy-push.sh"
  cd "$INSTALL_DIR"
  ./deploy-push.sh
}

main() {
  ensure_base_system
  ensure_project
  ensure_env
  run_deploy
}

main "$@"
