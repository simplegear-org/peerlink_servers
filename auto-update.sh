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
TAG_PATTERN="${PEERLINK_AUTO_UPDATE_TAG_PATTERN:-server-v*}"
LEGACY_TAG_PATTERN="${PEERLINK_AUTO_UPDATE_LEGACY_TAG_PATTERN:-source-v*}"
REQUIRE_SIGNED_TAG="${PEERLINK_AUTO_UPDATE_REQUIRE_SIGNED_TAG:-false}"
ALLOW_MAJOR="${PEERLINK_AUTO_UPDATE_ALLOW_MAJOR:-false}"

log() {
  logger -t peerlink-server-auto-update -- "$*" 2>/dev/null || true
  echo "[peerlink-auto-update] $*"
}
fail() { log "ERROR: $*"; exit 1; }

latest_tag() {
  git tag --list "$1" --sort=-v:refname | head -n 1
}
tag_major() {
  local tag="$1"
  tag="${tag#server-v}"
  tag="${tag#source-v}"
  printf '%s\n' "${tag%%.*}"
}

[[ "$ENABLED" == "true" || "$ENABLED" == "false" ]] || fail "PEERLINK_AUTO_UPDATE_ENABLED must be true or false"
[[ "$REQUIRE_SIGNED_TAG" == "true" || "$REQUIRE_SIGNED_TAG" == "false" ]] || fail "PEERLINK_AUTO_UPDATE_REQUIRE_SIGNED_TAG must be true or false"
[[ "$ALLOW_MAJOR" == "true" || "$ALLOW_MAJOR" == "false" ]] || fail "PEERLINK_AUTO_UPDATE_ALLOW_MAJOR must be true or false"

if [[ "$ENABLED" == "false" ]]; then
  log "Auto-update is disabled by configuration."
  exit 0
fi

cd "$ROOT_DIR"
[[ -x "$ROOT_DIR/update-server.sh" ]] || fail "Missing executable update-server.sh"

git remote set-url "$REMOTE" "$REPOSITORY"
git fetch --tags "$REMOTE" "$BRANCH"

candidate_ref="$(latest_tag "$TAG_PATTERN")"
if [[ -z "$candidate_ref" ]]; then
  candidate_ref="$(latest_tag "$LEGACY_TAG_PATTERN")"
  [[ -n "$candidate_ref" ]] || fail "No tagged server release found"
  log "No server-v* tags yet; using legacy release channel $candidate_ref"
fi

candidate_commit="$(git rev-parse --verify "${candidate_ref}^{commit}")" || fail "Cannot resolve $candidate_ref"
current_commit="$(git rev-parse HEAD)"

if [[ "$candidate_commit" == "$current_commit" ]]; then
  log "Already at the current server release $candidate_ref."
  exit 0
fi

# If this checkout is already ahead because of another component snapshot,
# never downgrade it to an older base-stack tag.
if git merge-base --is-ancestor "$candidate_commit" "$current_commit"; then
  log "No newer server release. Current checkout already contains $candidate_ref."
  exit 0
fi

git merge-base --is-ancestor "$current_commit" "$candidate_commit" || fail "Refusing non-fast-forward server update"

current_tag="$(git tag --points-at "$current_commit" --list 'server-v*' | sort -V | tail -n 1)"
if [[ -z "$current_tag" ]]; then
  current_tag="$(git tag --points-at "$current_commit" --list 'source-v*' | sort -V | tail -n 1)"
fi
[[ -n "$current_tag" ]] || fail "Refusing auto-update from an untagged current commit"

if [[ "$ALLOW_MAJOR" == "false" ]]; then
  current_major="$(tag_major "$current_tag")"
  release_major="$(tag_major "$candidate_ref")"
  [[ "$current_major" == "$release_major" ]] || fail "Refusing major upgrade $current_tag -> $candidate_ref"
fi

if [[ "$REQUIRE_SIGNED_TAG" == "true" ]]; then
  git verify-tag "$candidate_ref" || fail "Release tag signature verification failed: $candidate_ref"
fi

log "Applying verified server release $candidate_ref"
PEERLINK_SERVER_ROOT_DIR="$ROOT_DIR" \
PEERLINK_SERVER_REMOTE="$REMOTE" \
PEERLINK_SERVER_BRANCH="$BRANCH" \
PEERLINK_SERVER_REPOSITORY="$REPOSITORY" \
PEERLINK_SERVER_REF="$candidate_ref" \
  "$ROOT_DIR/update-server.sh"
