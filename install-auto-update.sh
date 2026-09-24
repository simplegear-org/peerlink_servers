#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_DIR="${PEERLINK_AUTO_UPDATE_CONFIG_DIR:-/etc/peerlink-server-updater}"
CONFIG_FILE="$CONFIG_DIR/config.env"
LIBEXEC_DIR="${PEERLINK_AUTO_UPDATE_LIBEXEC_DIR:-/usr/local/libexec}"
RUNNER="$LIBEXEC_DIR/peerlink-server-auto-update"
SERVICE_FILE="/etc/systemd/system/peerlink-server-auto-update.service"
TIMER_FILE="/etc/systemd/system/peerlink-server-auto-update.timer"
SUDO=""
MODE="install"

case "${1:-}" in
  ""|--install) ;;
  --refresh) MODE="refresh" ;;
  --enable) MODE="enable" ;;
  --disable) MODE="disable" ;;
  *)
    echo "Usage: $0 [--install|--refresh|--enable|--disable]" >&2
    exit 64
    ;;
esac

if [[ "${EUID}" -ne 0 ]]; then
  command -v sudo >/dev/null 2>&1 \
    || { echo "Run as root or install sudo." >&2; exit 1; }
  SUDO="sudo"
fi

root() {
  if [[ -n "$SUDO" ]]; then
    $SUDO "$@"
  else
    "$@"
  fi
}

write_default_config() {
  root mkdir -p "$CONFIG_DIR"
  root tee "$CONFIG_FILE" >/dev/null <<EOF
# Local owner configuration. This file is never read from Git.
PEERLINK_AUTO_UPDATE_ENABLED=true
PEERLINK_AUTO_UPDATE_ROOT_DIR=$SCRIPT_DIR
PEERLINK_AUTO_UPDATE_REMOTE=origin
PEERLINK_AUTO_UPDATE_BRANCH=main
PEERLINK_AUTO_UPDATE_REPOSITORY=https://github.com/simplegear-org/peerlink_servers.git
PEERLINK_AUTO_UPDATE_TAG_PATTERN=server-v*
PEERLINK_AUTO_UPDATE_LEGACY_TAG_PATTERN=source-v*
# Set true only after importing the trusted release-signing key into root's keyring.
PEERLINK_AUTO_UPDATE_REQUIRE_SIGNED_TAG=false
# Major releases require explicit owner approval by default.
PEERLINK_AUTO_UPDATE_ALLOW_MAJOR=false
EOF
  root chmod 600 "$CONFIG_FILE"
}

set_enabled() {
  local value="$1"
  root sed -i -E "s/^PEERLINK_AUTO_UPDATE_ENABLED=.*/PEERLINK_AUTO_UPDATE_ENABLED=${value}/" "$CONFIG_FILE"
}

install_runtime_files() {
  root mkdir -p "$LIBEXEC_DIR"
  root install -m 755 "$SCRIPT_DIR/auto-update.sh" "$RUNNER"
  root tee "$SERVICE_FILE" >/dev/null <<EOF
[Unit]
Description=PeerLink Servers verified auto-update
Wants=network-online.target
After=network-online.target docker.service

[Service]
Type=oneshot
EnvironmentFile=-$CONFIG_FILE
ExecStart=$RUNNER
EOF
  root tee "$TIMER_FILE" >/dev/null <<'EOF'
[Unit]
Description=Run PeerLink Servers auto-update every six hours

[Timer]
OnCalendar=*-*-* 00/6:17:00
Persistent=true
RandomizedDelaySec=20m
Unit=peerlink-server-auto-update.service

[Install]
WantedBy=timers.target
EOF
  root systemctl daemon-reload
  root systemctl enable --now peerlink-server-auto-update.timer
}

if [[ "$MODE" == "refresh" && ! -f "$CONFIG_FILE" ]]; then
  exit 0
fi

if [[ ! -f "$CONFIG_FILE" ]]; then
  write_default_config
fi

case "$MODE" in
  enable) set_enabled true ;;
  disable) set_enabled false ;;
esac

install_runtime_files
echo "PeerLink auto-update timer is installed. Configuration: $CONFIG_FILE"
