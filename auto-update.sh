#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
set -Eeuo pipefail

CONFIG_FILE="${PEERLINK_AUTO_UPDATE_CONFIG_FILE:-/etc/peerlink-server-updater/config.env}"
if [[ -f "$CONFIG_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$CONFIG_FILE"
  set +a
fi

ENABLED="${PEERLINK_AUTO_UPDATE_ENABLED:-true}"
ROOT_DIR="${PEERLINK_AUTO_UPDATE_ROOT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
REMOTE="${PEERLINK_AUTO_UPDATE_REMOTE:-origin}"
BRANCH="${PEERLINK_AUTO_UPDATE_BRANCH:-main}"
REPOSITORY="${PEERLINK_AUTO_UPDATE_REPOSITORY:-https://github.com/simplegear-org/peerlink_servers.git}"
REQUIRE_SIGNED_TAG="${PEERLINK_AUTO_UPDATE_REQUIRE_SIGNED_TAG:-false}"
ALLOW_MAJOR="${PEERLINK_AUTO_UPDATE_ALLOW_MAJOR:-false}"

log() {
  logger -t peerlink-server-auto-update -- "$*" 2>/dev/null || true
  echo "[peerlink-auto-update] $*"
}

fail() {
  log "ERROR: $*"
  exit 1
}

[[ "$ENABLED" == "true" || "$ENABLED" == "false" ]] \
  || fail "PEERLINK_AUTO_UPDATE_ENABLED must be true or false"
[[ "$REQUIRE_SIGNED_TAG" == "true" || "$REQUIRE_SIGNED_TAG" == "false" ]] \
  || fail "PEERLINK_AUTO_UPDATE_REQUIRE_SIGNED_TAG must be true or false"
[[ "$ALLOW_MAJOR" == "true" || "$ALLOW_MAJOR" == "false" ]] \
  || fail "PEERLINK_AUTO_UPDATE_ALLOW_MAJOR must be true or false"

if [[ "$ENABLED" == "false" ]]; then
  log "Auto-update is disabled by configuration."
  exit 0
fi

cd "$ROOT_DIR"
[[ -x "$ROOT_DIR/update-server.sh" ]] || fail "Missing executable update-server.sh"

git remote set-url "$REMOTE" "$REPOSITORY"
git fetch --tags "$REMOTE" "$BRANCH"

candidate_commit="$(git rev-parse --verify "${REMOTE}/${BRANCH}^{commit}")" \
  || fail "Cannot resolve ${REMOTE}/${BRANCH}"
current_commit="$(git rev-parse HEAD)"

if [[ "$candidate_commit" == "$current_commit" ]]; then
  log "Already at the current release."
  exit 0
fi

git merge-base --is-ancestor "$current_commit" "$candidate_commit" \
  || fail "Refusing non-fast-forward update"

release_tag="$(git tag --points-at "$candidate_commit" --list 'source-v*' | sort -V | tail -n 1)"
[[ -n "$release_tag" ]] \
  || fail "Refusing untagged commit: $candidate_commit"

current_tag="$(git tag --points-at "$current_commit" --list 'source-v*' | sort -V | tail -n 1)"
[[ -n "$current_tag" ]] \
  || fail "Refusing auto-update from an untagged current commit"

if [[ "$ALLOW_MAJOR" == "false" ]]; then
  current_major="${current_tag#source-v}"
  current_major="${current_major%%.*}"
  release_major="${release_tag#source-v}"
  release_major="${release_major%%.*}"
  [[ "$current_major" == "$release_major" ]] \
    || fail "Refusing major upgrade $current_tag -> $release_tag"
fi

if [[ "$REQUIRE_SIGNED_TAG" == "true" ]]; then
  git verify-tag "$release_tag" \
    || fail "Release tag signature verification failed: $release_tag"
fi

log "Applying verified release $release_tag"
PEERLINK_SERVER_ROOT_DIR="$ROOT_DIR" \
PEERLINK_SERVER_REMOTE="$REMOTE" \
PEERLINK_SERVER_BRANCH="$BRANCH" \
PEERLINK_SERVER_REPOSITORY="$REPOSITORY" \
PEERLINK_SERVER_REF="$release_tag" \
  "$ROOT_DIR/update-server.sh"
