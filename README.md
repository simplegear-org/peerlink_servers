# PeerLink server suite

This repository contains a set of server services for PeerLink:
- `relay` — HTTP relay and blob API (store/fetch/ack + group fan-out + blob upload)
- `signal` — bootstrap signaling server
- `push` — push delivery service via Firebase Cloud Messaging (FCM)
- `coturn` — TURN server for WebRTC, with optional TURNS on 5349
- `haproxy` — reverse proxy and TLS termination

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

Internal push-delivery service for FCM/APNs:
- `POST /send`
- `POST /devices/register`
- `POST /devices/unregister`
- `GET /devices/by-user/:userId`
- `POST /events/push`
- `GET /health`

Push write contract:
- bearer auth via `Authorization: Bearer <PUSH_API_TOKEN>`,
- Ed25519 signature on write requests (`id`, `from`, `ts`, `sig`, `signingPub`),
- anti-replay by request id TTL cache.

`POST /events/push` is the universal signed fanout endpoint:
- request contains `senderUserId`, `recipientUserIds`, app-defined `payload`, optional `notification`, and optional `delivery`,
- standard delivery goes to regular message tokens via FCM/APNs alert or silent push,
- VoIP delivery goes to APNs VoIP tokens,
- FCM `data` values are normalized to strings; nested objects such as `servers` are JSON-encoded,
- when `notification.title/body` is omitted, standard delivery is silent/data-only. Android `call_invite` uses this path so the client can decide foreground/fullscreen presentation.

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

### Source availability

PeerLink Servers exposes source metadata for AGPL source availability:

```text
GET /.well-known/peerlink-source
```

Relay and push expose this endpoint over HTTP. Bootstrap signaling also includes
the same metadata in the WebSocket `register_ack` payload.

Official deployments should set:

- `SOURCE_VERSION`
- `SOURCE_CODE_URL`

For official source snapshots, `SOURCE_CODE_URL` should point to the immutable
public source tag for the running version.

If operators deploy a modified AGPL version and are required to provide
Corresponding Source, `SOURCE_CODE_URL` must point to the source corresponding
to their deployed version, not merely to the upstream PeerLink repository.

This mechanism helps users find source code. Operators remain responsible for
complying with the license.

### Docker Compose

File: `docker-compose.yml`

This file defines all four services. `coturn` and `haproxy` mount the certificate files from the host.

### TURN

File: `turnserver.conf`

The file is generated automatically by `deploy.sh`:
- `listening-ip=<PUBLIC_IP>`
- `relay-ip=<PUBLIC_IP>`
- `external-ip=<PUBLIC_IP>`
- `realm=<PUBLIC_HOST>`
- `lt-cred-mech`
- `user=<turn-user>:<turn-password>`
- `cert=/etc/coturn/certs/fullchain.pem`
- `pkey=/etc/coturn/private/privkey.pem`

> Note: `deploy.sh` generates TURN config with long-term credentials. Keep TURN username/password synchronized with the client configuration.

### HAProxy

File: `haproxy.cfg`

Configures HTTPS termination only for `signal` and `relay`.

## Quick start

For a reproducible source deployment, check out the public source tag and build
the containers from that source:

```bash
git clone https://github.com/simplegear-org/peerlink_servers.git
cd peerlink_servers
git checkout source-v1.1.0
docker compose build
docker compose up -d
```

To bootstrap the current/default ref automatically:

```bash
wget -qO- https://raw.githubusercontent.com/simplegear-org/peerlink_servers/main/bootstrap.sh | bash
```

To bootstrap a specific public source tag:

```bash
wget -qO- https://raw.githubusercontent.com/simplegear-org/peerlink_servers/main/bootstrap.sh | bash -s -- https://github.com/simplegear-org/peerlink_servers.git source-v1.1.0
```

### Source-build and official image modes

The default public self-hosted model is source-build mode: `docker-compose.yml`
and `docker-compose.push.yml` build PeerLink server containers from the current
checked-out source tree.

Official prebuilt image mode may still be used by setting image variables such
as `PUSH_IMAGE`, but release deployments should use version-specific image tags
or immutable digests, not floating `latest` tags.

The runtime source metadata must describe the actual running source. Official
deployments can set `SOURCE_VERSION` and `SOURCE_CODE_URL`, but these values
must correspond to the image/source actually being run.

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

The dedicated push stack now includes:
- `push` on internal `4500`
- `push-proxy` (`nginx`) on public `80/443`
- `certbot` for initial certificate issue
- `certbot-renewer` for automatic certificate renewal

Use dedicated file for the push stack:

```bash
docker compose -f docker-compose.push.yml build
docker compose -f docker-compose.push.yml up -d
```

Required environment variables:
- `PUSH_PUBLIC_HOST`
- `LETSENCRYPT_EMAIL` when `PUSH_TLS_PROVIDER=letsencrypt`
- `PUSH_TLS_PROVIDER` (`letsencrypt` by default, or `cloudflare_origin`)
- `PUSH_ORIGIN_CERT_PEM` when `PUSH_TLS_PROVIDER=cloudflare_origin`
- `PUSH_ORIGIN_KEY_PEM` when `PUSH_TLS_PROVIDER=cloudflare_origin`
- `PUSH_API_TOKEN`
- `FCM_PROJECT_ID`
- `FCM_CREDENTIALS_JSON`
- `APNS_TEAM_ID`
- `APNS_KEY_ID`
- `APNS_PRIVATE_KEY`
- `APNS_VOIP_TOPIC`
- `APNS_MESSAGES_TOPIC`
- `APNS_USE_SANDBOX`

Ready-to-run script:

```bash
cp .env.push.example .env.push.local
# edit .env.push.local
bash ./deploy-push.sh
```

Clean Debian bootstrap:

```bash
apt-get update && apt-get install -y ca-certificates curl && curl -fsSL https://raw.githubusercontent.com/simplegear-org/peerlink_servers/main/bootstrap-push.sh -o bootstrap-push.sh && REPO_URL=https://github.com/simplegear-org/peerlink_servers.git bash bootstrap-push.sh
```

`deploy-push.sh` now:
- installs Docker Engine and Docker Compose plugin on clean Debian/Ubuntu hosts
- writes temporary HTTP-only `nginx` config for ACME
- starts `push` and `push-proxy`
- issues a Let's Encrypt certificate with `certbot --webroot`
- switches `nginx` to HTTPS
- starts a long-running renew loop in a separate container
- can use `PUSH_TLS_PROVIDER=cloudflare_origin` with Cloudflare Origin CA instead of certbot for orange-cloud proxy

The push API is exposed at:

```text
https://<PUSH_PUBLIC_HOST>
```

## Licensing

PeerLink Servers is open-source software distributed under the GNU Affero
General Public License version 3 only (AGPL-3.0-only).

Commercial use under AGPL-3.0-only is permitted.

Organizations that require different proprietary, OEM, white-label or
enterprise licensing terms may request a separate commercial agreement.

See:

- LICENSE
- LICENSE-HISTORY.md
- COMMERCIAL-LICENSING.md
- BRANDING.md
- SECURITY.md
- CONTRIBUTING.md
- CLA-POLICY.md
- GITHUB_PUBLIC_MIRROR_SETTINGS.md
- SOURCE_SNAPSHOT.md
- THIRD_PARTY_NOTICES.md

## Repository Model

This repository is the public source-distribution mirror for PeerLink Servers.

Development is performed in a separate development repository.

This repository contains clean source snapshots corresponding to public
PeerLink Servers releases.

Its Git history represents public source snapshots and is not intended to
reproduce the project's private internal development history.

The public mirror contains the minimum source-distribution set required for
the released servers: license and third-party notices, branding/security/
contributor policy documents, public README files, package manifests,
Docker/Compose/deploy scripts, runtime server source, and `source-info.js`.

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

### TURN compatibility credentials

PeerLink X currently uses fixed TURN compatibility credentials:

- Username: `peerlink`
- Password: `peerlink`

These values are part of the current PeerLink X client/server compatibility
contract and are not intended to function as secret administrative credentials.

Changing these values on a self-hosted PeerLink Servers deployment will prevent
current PeerLink X clients from using that TURN server unless the client is also
updated to use the same credentials.

Operators should therefore keep the compatibility credentials unchanged for
current PeerLink X deployments.

TURN resource protection should be implemented through network restrictions,
allocation limits and bandwidth limits rather than by treating these credentials
as secret access-control credentials.

`./deploy.sh` applies bandwidth limits by default:

- `TURN_MAX_BPS=10000000`
- `TURN_BPS_CAPACITY=100000000`

Coturn resource limits can be changed before deployment:

- `TURN_TOTAL_QUOTA`
- `TURN_USER_QUOTA`
- `TURN_MAX_BPS`
- `TURN_BPS_CAPACITY`

These values are optional and must be non-negative integers. Set an empty value
to disable a default. Be careful with `TURN_TOTAL_QUOTA` and
`TURN_USER_QUOTA`: current deployments may rely on a single TURN server and
current PeerLink X clients share the same TURN username, so low allocation
quotas can block legitimate concurrent calls.

If you need another operating system, `deploy.sh` must be adapted.

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
For group delivery operations relay enforces server-side membership:

- `POST /relay/group/store`: sender and all recipients must be current members
- `POST /relay/blob/upload`, `/relay/blob/upload/chunk`, `/relay/blob/upload/complete`: storage-only signed blob writes; group membership is not checked here because delivery authorization happens on `/relay/group/store`

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
