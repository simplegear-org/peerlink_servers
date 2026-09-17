#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only

# Stateless primitives shared by independent deployment entrypoints.

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "Missing required command: $1"
}

require_file() {
  [[ -f "$1" ]] || fail "Missing required file: $1"
}

ensure_dir() {
  mkdir -p "$1"
}
