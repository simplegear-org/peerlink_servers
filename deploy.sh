#!/bin/bash

# Script for automatic deployment of PeerLink server suite.
# Public client contract:
# - bootstrap: wss://PUBLIC_HOST:443
# - relay: https://PUBLIC_HOST:444
# - turn: turn:PUBLIC_HOST:3478?transport=udp
# - turn: turn:PUBLIC_HOST:3478?transport=tcp
# - optional turns: turns:PUBLIC_HOST:5349?transport=tcp
#
# PUBLIC_HOST may be either a domain or an IP address and is what clients use.
# PUBLIC_IP must be the real external IP for coturn external-ip and defaults to
# automatic detection. PUBLIC_HOST defaults to PUBLIC_IP when not provided.

set -e
STAGE_PREFIX="__PEERLINK_STAGE__"

stage() {
  echo "${STAGE_PREFIX}:$1:$2"
}

DETECTED_PUBLIC_IP=$(ip route get 1.1.1.1 2>/dev/null | awk '/src/ {print $7; exit}' || hostname -I 2>/dev/null | awk '{print $1}' || curl -s https://ifconfig.me || echo "127.0.0.1")
PUBLIC_IP=${PUBLIC_IP:-${CERT_IP:-$DETECTED_PUBLIC_IP}}
if [ -z "$PUBLIC_IP" ]; then
  PUBLIC_IP=127.0.0.1
fi
PUBLIC_HOST=${PUBLIC_HOST:-$PUBLIC_IP}

echo "Using PUBLIC_HOST: $PUBLIC_HOST"
echo "Using PUBLIC_IP: $PUBLIC_IP"

is_ip_address() {
  echo "$1" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$|:'
}

stage "5" "Installing Docker"
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh
sudo usermod -aG docker $USER

stage "6" "Installing Docker Compose"
sudo curl -L "https://github.com/docker/compose/releases/download/v2.24.0/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
sudo chmod +x /usr/local/bin/docker-compose

stage "7" "Installing OpenSSL"
sudo apt install -y openssl

echo "Configuring firewall (if ufw is active)..."
if command -v ufw >/dev/null 2>&1; then
  UFW_STATUS="$(sudo ufw status 2>/dev/null | head -n 1 || true)"
  if echo "$UFW_STATUS" | grep -qi "Status: active"; then
    sudo ufw allow 443/tcp || true
    sudo ufw allow 444/tcp || true
    sudo ufw allow 5349/tcp || true
    sudo ufw allow 5349/udp || true
    sudo ufw allow 3478/udp || true
    sudo ufw allow 3478/tcp || true
    sudo ufw allow 49152:51819/udp || true
    sudo ufw allow 49152:51819/tcp || true
  fi
fi

stage "8" "Generating long-lived self-signed certificate"
sudo mkdir -p /etc/ssl/certs /etc/ssl/private
if is_ip_address "$PUBLIC_HOST"; then
  SAN_ENTRY="IP:$(echo "$PUBLIC_HOST" | sed 's/[\\&/]/\\\\&/g')"
else
  SAN_ENTRY="DNS:$(echo "$PUBLIC_HOST" | sed 's/[\\&/]/\\\\&/g')"
fi
sudo bash -c "cat > /tmp/selfsigned.cnf <<EOF
[req]
distinguished_name=req_distinguished_name
x509_extensions=v3_req
prompt=no

[req_distinguished_name]
CN=$(echo "$PUBLIC_HOST" | sed 's/[\\&/]/\\\\&/g')

[v3_req]
subjectAltName=${SAN_ENTRY}
EOF"

sudo openssl req -x509 -nodes -days 36500 -newkey rsa:2048 \
  -keyout /etc/ssl/private/selfsigned.key \
  -out /etc/ssl/certs/selfsigned.crt \
  -config /tmp/selfsigned.cnf
sudo bash -c "cat /etc/ssl/certs/selfsigned.crt /etc/ssl/private/selfsigned.key > /etc/ssl/certs/selfsigned.pem"

echo "Preparing config targets..."
sudo rm -rf haproxy.cfg turnserver.conf
if [ -d haproxy.cfg ] || [ -d turnserver.conf ]; then
  echo "Failed to cleanup old config targets"
  exit 1
fi
stage "9" "Generating haproxy.cfg"
cat > haproxy.cfg <<EOF
global
    log /dev/log local0
    log /dev/log local1 notice
    chroot /var/lib/haproxy
    stats timeout 30s
    user haproxy
    group haproxy
    daemon

defaults
    log global
    mode http
    option httplog
    option dontlognull
    timeout connect 5000
    timeout client 50000
    timeout server 50000

frontend http_front
    bind *:443 ssl crt /usr/local/etc/haproxy/certs/haproxy.pem
    default_backend signal_backend

frontend relay_front
    bind *:444 ssl crt /usr/local/etc/haproxy/certs/haproxy.pem
    default_backend relay_backend

backend relay_backend
    server relay 127.0.0.1:4000

backend signal_backend
    server signal 127.0.0.1:3000
EOF

TURN_USER=${TURN_USER:-testuser}
TURN_PASSWORD=${TURN_PASSWORD:-testpassword}

stage "10" "Generating turnserver.conf"
sudo bash -c "cat > turnserver.conf <<EOF
# Listening
listening-port=3478
tls-listening-port=5349

# Public IP
external-ip=$(echo "$PUBLIC_IP" | sed 's/[\\&/]/\\\\&/g')

# Relay ports
min-port=49152
max-port=51819

# Auth
lt-cred-mech
realm=$(echo "$PUBLIC_HOST" | sed 's/[\\&/]/\\\\&/g')
 
# Users
user=${TURN_USER}:${TURN_PASSWORD}

# SSL/TLS
cert=/etc/coturn/certs/fullchain.pem
pkey=/etc/coturn/private/privkey.pem

# Security
fingerprint
no-multicast-peers
no-cli
no-tlsv1
no-tlsv1_1

# Logging
simple-log
log-file=stdout
EOF"
sudo docker-compose up -d --force-recreate --remove-orphans relay signal haproxy coturn

stage "11" "Deployment complete!"
echo "Deployment complete!"
