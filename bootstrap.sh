#!/bin/bash

# Bootstrap script for PeerLink server suite
# Clones the repository and runs deploy.sh

set -e

REPO_URL=${1:-https://github.com/simplegear-org/peerlink_servers.git}
BRANCH=${2:-main}
DIR_NAME=${3:-peerlink_servers}
STAGE_PREFIX="__PEERLINK_STAGE__"

stage() {
  echo "${STAGE_PREFIX}:$1:$2"
}

stage "2" "Updating operating system"
sudo apt update && sudo apt upgrade -y && sudo apt install -y git && sudo apt install -y curl

stage "3" "Cloning repository"
git clone -b "$BRANCH" "$REPO_URL" "$DIR_NAME"

echo "Entering directory $DIR_NAME..."
cd "$DIR_NAME"

echo "Making deploy.sh executable..."
chmod +x deploy.sh

stage "4" "Running deploy"
sudo ./deploy.sh
