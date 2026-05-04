# PeerLink server suite
Last updated: 2026-05-04

This repository contains a set of server services for PeerLink:
- `relay` — HTTP relay and blob API (store/fetch/ack + group fan-out + blob upload)
- `signal` — bootstrap signaling server
- `coturn` — TURN/TLS server for WebRTC
- `haproxy` — reverse proxy and TLS termination
- `monitoring` — built-in observability stack (Grafana + Prometheus + Loki)

> This project is authored by AI agents; I act only as a coordinator and development lead. No character of code was written by hand.

> Russian documentation is available in `README_RU.md`.

## Overview

The project is deployed with Docker Compose and works as a single system:

- `relay` forwards messages between WebRTC peers
- `relay` stores/fetches signed envelopes and serves blob payload API
- `signal` registers and authenticates stable `peerId` (v2) with Ed25519 proof
- `coturn` provides TURN/TLS access by IP
- `haproxy` accepts HTTP/HTTPS and proxies `relay` and `signal`

A self-signed certificate is used for the server IP instead of a public domain.

Additionally, the deployment includes a built-in monitoring stack providing metrics, logs, and system observability.

## Monitoring

The deployment includes a production-grade monitoring stack:

### Components

- Grafana — dashboards and visualization
- Prometheus — metrics collection and storage
- Loki — log storage
- Promtail — log collection agent
- cAdvisor — Docker container metrics
- Node Exporter — host-level metrics (CPU, RAM, disk, network)
- Blackbox Exporter — HTTP/TCP endpoint monitoring

### Access

Grafana is available at:
https://<IP>/monitor/

Default credentials:
login: admin
password: admin

### Metrics coverage

- CPU / RAM / Disk usage (host)
- Docker container performance
- Network throughput
- TURN / WebRTC port availability
- Endpoint health (`signal`, `relay`)
- Logs (containers + system)

### Data retention

- Prometheus: limited by time and size (e.g. 30d / 10GB)
- Loki: logs retention ~7 days
- Docker logs: automatic rotation (50MB × 5 files)

### Security

- Monitoring services bind to `127.0.0.1`
- Only Grafana is exposed via HAProxy
- TLS is reused from main services

## Requirements

- Debian/Ubuntu-like system for `deploy.sh`
- `bash`, `curl`, `sudo`
- Docker and Docker Compose (installed by the script)
- OpenSSL

## Services

### relay

File: `relay.js`

This service stores signed relay envelopes and allows clients to:
- store/fetch/ack message envelopes,
- fan-out one signed group envelope to recipient list (`/relay/group/store`),
- upload/fetch encrypted blobs (`/relay/blob/*`), including chunked upload.

It does not handle peer registration or signaling.

### signal

File: `signal.js`

This is the bootstrap signaling server with:
- stable `peerId` (v2) registration over WebSocket
- signature-based registration authentication
- backward-compatible signature verification for legacy registration payloads (v1)
- session takeover support when a peer reconnects
- relaying `signal` messages between peers
- `ping/pong` heartbeat
- stable `peers_request` snapshots (online peers only)
- server-side `lastSeenMs` in peers snapshots
- push `presence_update` events for `online/offline` transitions

### coturn

The `instrumentisto/coturn` service runs in `network_mode: host` and exposes:
- TURN: 3478
- TURNS: 5349
- Relay ports: `49152-51819` (UDP/TCP) for TURN media relay candidates.

It uses a self-signed certificate for the IP configured in `turnserver.conf`.

### haproxy

HAProxy accepts HTTP/HTTPS and routes:
- `wss://<IP>:443` -> `signal:3000`
- `https://<IP>:444` -> `relay:4000`

It runs in `network_mode: host` and uses `selfsigned.pem`.

TURN/TURNS is not proxied through HAProxy:
- `turn:<IP>:3478` and `turns:<IP>:5349` are served directly by `coturn`,
- relay ports `49152-51819` are also opened directly for TURN media relay candidates.

> `deploy.sh` targets Debian/Ubuntu and uses `apt`, `sudo`, Docker, and OpenSSL.

## Configuration

### Docker Compose

File: `docker-compose.yml`

This file defines all four services. `coturn` and `haproxy` mount the certificate files from the host.

### TURN

File: `turnserver.conf`

The file is generated automatically by `deploy.sh` with a detected IP address:
- `external-ip=<CERT_IP>`
- `realm=<CERT_IP>`
- `cert=/etc/coturn/certs/fullchain.pem`
- `pkey=/etc/coturn/private/privkey.pem`

> Note: `deploy.sh` uses sample TURN credentials by default (`TURN_USER` / `TURN_PASSWORD`). Replace them with secure values and use real certificates in production.

### HAProxy

File: `haproxy.cfg`

Configures HTTPS termination only for `signal` and `relay`.

## Quick start

To bootstrap automatically:

```bash
wget -qO- https://raw.githubusercontent.com/simplegear-org/peerlink_servers/main/bootstrap.sh | bash
```

Or clone and run manually:

```bash
git clone https://github.com/simplegear-org/peerlink_servers.git
cd peerlink_servers
./deploy.sh
```

### Local run

To start the servers without Docker:

```bash
npm install
npm run start:signal
npm run start:relay
```

`signal` listens on `localhost:3000`, `relay` listens on `localhost:4000`.

## Deployment

File: `deploy.sh`

The script automatically:
- updates the system
- installs Docker and Docker Compose
- detects the server IP address (using `ip route`, `hostname -I`, or an external service)
- generates a self-signed certificate for the detected IP
- generates `turnserver.conf` with the correct `external-ip` and `realm`
- starts the containers

Run:

```bash
./deploy.sh
```

By default the script detects IP automatically; if detection fails it uses `127.0.0.1`.

> To use custom TURN credentials, set `TURN_USER` and `TURN_PASSWORD` before running `./deploy.sh`.
>
> Example:
>
> ```bash
> TURN_USER=myuser TURN_PASSWORD=strongpass ./deploy.sh
> ```
>
> If you need another operating system, `deploy.sh` must be adapted.

## Signaling API

Clients communicate using JSON frames:

```json
{
  "v": "1",
  "id": "string",
  "type": "string",
  "payload": {}
}
```

Supported frame types:
- `register`
- `register_ack`
- `signal`
- `ping`
- `pong`
- `peers_request`
- `peers`
- `presence_update`
- `error`

### Register

A `register` frame requires cryptographic authentication:

```json
{
  "v": "1",
  "id": "1741590000123456",
  "type": "register",
  "payload": {
    "peerId": "PEER_ID",
    "client": {
      "name": "peerlink",
      "protocol": "1"
    },
    "capabilities": ["webrtc", "signal-relay"],
    "auth": {
      "scheme": "peerlink-ed25519-v1",
      "peerId": "PEER_ID",
      "timestampMs": 1741590002123,
      "nonce": "1741590002123456",
      "signingPublicKey": "BASE64",
      "signature": "BASE64",
      "legacyPeerId": "OPTIONAL_LEGACY_ID",
      "identityProfile": {
        "stableUserId": "PEER_ID",
        "endpointId": "OPTIONAL_ENDPOINT_ID",
        "fcmTokenHash": "OPTIONAL_HASH"
      }
    }
  }
}
```

#### Validation checks

The server validates:
- `auth.scheme == peerlink-ed25519-v1`
- `auth.peerId == payload.peerId`
- `timestampMs` is within the allowed skew window
- `nonce` was not used before
- `signingPublicKey` is a valid Ed25519 key
- `signature` is valid for the canonical payload
- if `identityProfile.stableUserId` is present, it must match `payload.peerId`

Canonical payload for signature verification (v2):

```json
{
  "purpose": "bootstrap-register",
  "protocol": "1",
  "peerId": "PEER_ID",
  "timestampMs": 1741590002123,
  "nonce": "1741590002123456",
  "signingPublicKey": "BASE64",
  "legacyPeerId": "OPTIONAL_LEGACY_ID",
  "identityProfile": {
    "stableUserId": "PEER_ID",
    "endpointId": "OPTIONAL_ENDPOINT_ID",
    "fcmTokenHash": "OPTIONAL_HASH"
  }
}
```

Legacy canonical payload (v1 fallback):

```json
{
  "purpose": "bootstrap-register",
  "protocol": "1",
  "peerId": "PEER_ID",
  "timestampMs": 1741590002123,
  "nonce": "1741590002123456",
  "signingPublicKey": "BASE64"
}
```

The server tries v2 verification first and then v1 for backward compatibility.

### Takeover

If a valid `register` arrives for an already connected `peerId`:
- the old session is closed
- the new session becomes active
- the client receives `register_ack`

This supports network changes and reconnection.

## Relay API

Relay endpoints used by current client:

- `GET /health`
- `POST /relay/store`
- `POST /relay/group/store`
- `POST /relay/group/members/update`
- `GET /relay/fetch?to=<peerId>&limit=<n>&cursor=<optional>`
- `POST /relay/ack`
- `POST /relay/blob/upload`
- `POST /relay/blob/upload/chunk`
- `POST /relay/blob/upload/complete`
- `GET /relay/blob/:blobId`

For full payload fields and signature formats, see `README.relay.md`.

### Errors

Example error frame:

```json
{
  "v": "1",
  "id": "srv-error-1",
  "type": "error",
  "payload": {
    "code": "INVALID_REGISTER_AUTH",
    "message": "signature verification failed"
  }
}
```

Common error codes:
- `INVALID_JSON`
- `INVALID_VERSION`
- `INVALID_REGISTER`
- `INVALID_REGISTER_AUTH`
- `NOT_REGISTERED`
- `INVALID_SIGNAL`
- `PEER_NOT_FOUND`
- `SESSION_REPLACED`
- `UNKNOWN_TYPE`

## Relay HTTP API

The relay service exposes the following endpoints:

- `GET /health`
  - returns service status
- `POST /relay/store`
  - store an envelope for a recipient
  - request body must include: `id`, `from`, `to`, `ts`, `ttl`, `payload`, `sig`, `signingPub`
- `POST /relay/group/store`
  - server-side fan-out to multiple recipients
  - request body must include: `id`, `from`, `groupId`, `recipients[]`, `ts`, `ttl`, `payload`, `sig`, `signingPub`
- `POST /relay/group/members/update`
  - updates authoritative membership for a group on relay
  - request body must include: `id`, `from`, `groupId`, `ownerPeerId`, `memberPeerIds[]`, `ts`, `ttl`, `sig`, `signingPub`
  - `from` must equal `ownerPeerId`
- `GET /relay/fetch?to=<recipient>&cursor=<id>&limit=<n>`
  - fetch pending envelopes for a recipient
  - supports pagination with `cursor`
- `POST /relay/ack`
  - acknowledge envelope delivery
  - body must include: `id`, `from`, `to`, `ts`, `sig`, `signingPub`

The relay API validates Ed25519 signatures for both stored envelopes and delivery acknowledgements.
For group operations relay also enforces server-side membership:

- `POST /relay/group/store`: sender and all recipients must be current members
- `POST /relay/blob/upload`, `/relay/blob/upload/chunk`, `/relay/blob/upload/complete`: sender must be a current member (when membership is known)

Relay signature payloads:

- store: `id|from|to|ts|ttl|` + decoded `payload` bytes
- group-store: `id|from|groupId|recipient1,recipient2,...|ts|ttl|` + decoded `payload` bytes
- group-members-update: `id|from|groupId|ownerPeerId|member1,member2,...|ts|ttl`
- ack: `id|from|to|ts`

Relay validation behavior:

- malformed body/fields -> `400`
- invalid signature -> `401` (`{"error":"invalid signature"}`)
- membership violation -> `403`
- owner mismatch in `/relay/group/members/update` -> `409`

## Recommended operation

- Use HAProxy for HTTPS termination and proxying.
- For IP certificates, self-signed certificates with IP SAN are acceptable in this setup.
- Clients must trust the certificate manually.
- In production, store `peer` state and `nonce` state outside the process memory.
- Consider adding metrics for `register_ack`, `INVALID_REGISTER_AUTH`, `SESSION_REPLACED`, and recovery time.
