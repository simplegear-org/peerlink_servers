# PeerLink server suite
Last updated: 2026-05-16

This repository contains a set of server services for PeerLink:
- `relay` — HTTP relay and blob API (store/fetch/ack + group fan-out + blob upload)
- `signal` — bootstrap signaling server
- `push` — push delivery service via Firebase Cloud Messaging (FCM)
- `coturn` — TURN server for WebRTC, with optional TURNS on 5349
- `haproxy` — reverse proxy and TLS termination

> This project is authored by AI agents; I act only as a coordinator and development lead. No character of code was written by hand.

> Russian documentation is available in `README_RU.md`.

## Overview

The project is deployed with Docker Compose and works as a single system:

- `relay` forwards messages between WebRTC peers
- `relay` stores/fetches signed envelopes and serves blob payload API
- `signal` registers and authenticates stable `peerId` (v2) with Ed25519 proof
- `coturn` provides TURN access on a single public host
- `haproxy` accepts HTTP/HTTPS and proxies `relay` and `signal`

The deployment contract is unified for both domains and raw IP addresses:
- `wss://PUBLIC_HOST:443` for bootstrap
- `https://PUBLIC_HOST:444` for relay
- `turn:PUBLIC_HOST:3478?transport=udp`
- `turn:PUBLIC_HOST:3478?transport=tcp`
- optional `turns:PUBLIC_HOST:5349?transport=tcp`

`PUBLIC_HOST` is what clients connect to. `PUBLIC_IP` is the real external IP
used by coturn as `external-ip`.

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

Relay health model:
- `GET /health` checks basic liveness and network reachability
- `GET /relay/capabilities` exposes protocol-level compatibility metadata
- `POST /relay/probe` performs a lightweight compatibility probe without
  requiring a signed envelope or mutating relay state

This separation lets clients distinguish "server is reachable" from "server is
compatible with the current PeerLink relay protocol".

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

### push

File: `push.js`

Internal push-delivery service for FCM:
- `POST /send`
- `POST /devices/register`
- `POST /devices/unregister`
- `GET /devices/by-user/:userId`
- `POST /events/message`
- `GET /health`

Push write contract:
- bearer auth via `Authorization: Bearer <PUSH_API_TOKEN>`,
- Ed25519 signature on write requests (`id`, `from`, `ts`, `sig`, `signingPub`),
- anti-replay by request id TTL cache.

`POST /events/message` supports `push-v1.1`:
- `schemaVersion=push-v1.1`,
- signed relay metadata: `relay.serverId`, `relay.scopeKind`, optional `relay.blobId`, `relay.relayMessageId`,
- backward-compatible legacy signature verification is preserved when `schemaVersion` is omitted.

FCM fanout for message events sends both:
- `notification` (title/body) for better iOS background visibility,
- `data` (technical fields including `type`, `groupId` or `directPeerId`, `messageId` (`lastSeq`), `senderUserId`, `schemaVersion`, relay metadata).

### coturn

The `instrumentisto/coturn` service runs in `network_mode: host` and exposes:
- TURN: 3478
- optional TURNS: 5349
- Relay ports: `49152-51819` (UDP/TCP) for TURN media relay candidates.

It uses a self-signed certificate for `PUBLIC_HOST` and advertises
`external-ip=PUBLIC_IP` in `turnserver.conf`.

### haproxy

HAProxy accepts HTTP/HTTPS and routes:
- `wss://<IP>:443` -> `signal:3000`
- `https://<IP>:444` -> `relay:4000`

Use the same routing for either a domain or a raw IP by replacing `<IP>` with
`PUBLIC_HOST`.

It runs in `network_mode: host` and uses `selfsigned.pem`.

TURN/TURNS is not proxied through HAProxy:
- `turn:PUBLIC_HOST:3478` and optional `turns:PUBLIC_HOST:5349` are served directly by `coturn`,
- relay ports `49152-51819` are also opened directly for TURN media relay candidates.

> `deploy.sh` targets Debian/Ubuntu and uses `apt`, `sudo`, Docker, and OpenSSL.

## Configuration

### Docker Compose

File: `docker-compose.yml`

This file defines all four services. `coturn` and `haproxy` mount the certificate files from the host.

### TURN

File: `turnserver.conf`

The file is generated automatically by `deploy.sh`:
- `external-ip=<PUBLIC_IP>`
- `realm=<PUBLIC_HOST>`
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
npm run start:push
```

`signal` listens on `localhost:3000`, `relay` listens on `localhost:4000`,
`push` listens on `localhost:4500`.

### Push-only deploy with Docker Compose

Use dedicated file for `push` service:

```bash
docker compose -f docker-compose.push.yml up -d
```

Required environment variables:
- `PUSH_API_TOKEN`
- `FCM_PROJECT_ID`
- `FCM_CREDENTIALS_JSON`

Ready-to-run script:

```bash
cp .env.push.example .env.push.local
# edit .env.push.local
bash ./deploy-push.sh
```

### Relay compatibility smoke-check

Network liveness:

```bash
curl -i http://127.0.0.1:4000/health
```

Protocol capabilities:

```bash
curl -i http://127.0.0.1:4000/relay/capabilities
```

Protocol probe:

```bash
curl -i http://127.0.0.1:4000/relay/probe \
  -H 'Content-Type: application/json' \
  -d '{"v":"1","client":"peerlink-health-check"}'
```

## Deployment

File: `deploy.sh`

The script automatically:
- updates the system
- installs Docker and Docker Compose
- detects the server IP address (using `ip route`, `hostname -I`, or an external service)
- uses `PUBLIC_HOST` for client-facing URLs and certificate CN/SAN
- uses `PUBLIC_IP` for coturn `external-ip`
- generates a self-signed certificate for `PUBLIC_HOST`
- generates `turnserver.conf` with the correct `external-ip` and `realm`
- starts the containers

Run:

```bash
./deploy.sh
```

By default:
- `PUBLIC_IP` is detected automatically; if detection fails it uses `127.0.0.1`
- `PUBLIC_HOST` defaults to `PUBLIC_IP`

Client-side self-hosted behavior:
- the app asks the user for one host value only: either a domain or an IP
- before deploy, the app shows a preview of the final endpoints it will add
- after `Deployment complete!`, the app retries bootstrap/relay/turn readiness checks for a short warm-up window
- bootstrap and relay are expected to work with the generated self-signed certificate for `PUBLIC_HOST`
- current recommended TURN entries added by the app are:
  - `turn:PUBLIC_HOST:3478?transport=udp`
  - `turn:PUBLIC_HOST:3478?transport=tcp`

> To use custom TURN credentials, set `TURN_USER` and `TURN_PASSWORD` before running `./deploy.sh`.
>
> Example:
>
> ```bash
> PUBLIC_HOST=peerlink.example.com TURN_USER=myuser TURN_PASSWORD=strongpass ./deploy.sh
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
