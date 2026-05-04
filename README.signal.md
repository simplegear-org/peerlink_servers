# PeerLink Signal
Last updated: 2026-04-13

PeerLink signaling server for WebRTC peer registration, offer/answer exchange, and ICE candidate routing.

https://github.com/simplegear-org/peerlink_servers.git

## What it does

- Accepts WebSocket client connections
- Handles secure peer registration
- Relays signaling frames between online peers
- Supports `ping/pong` heartbeat
- Supports `peers_request` snapshots (online peers only)
- Returns server-side `lastSeenMs` in peers snapshots
- Emits push `presence_update` frames for `online/offline` transitions
- Supports reconnect/session takeover

## Exposed port

- `3000/tcp`

## Main runtime file

- `signal.js`

## Supported frame types

- `register`
- `register_ack`
- `signal`
- `ping`
- `pong`
- `peers_request`
- `peers`
- `presence_update`
- `error`

## Signaling API

All messages are JSON frames sent over WebSocket:

```json
{
  "v": "1",
  "id": "string",
  "type": "string",
  "payload": {}
}
```

### `register`

Client registration frame:

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

Registration currently uses the stable identity scheme (v2). The server still accepts legacy signature payloads (v1 fallback) for backward compatibility.

Validation rules:

- `auth.scheme` must be `peerlink-ed25519-v1`
- `auth.peerId` must match `payload.peerId`
- `timestampMs` must be within allowed clock skew
- `nonce` must be unique within nonce TTL window
- `signingPublicKey` must be a valid Ed25519 public key
- signature must verify against canonical payload (v2 first, v1 fallback)
- if `identityProfile.stableUserId` is present, it must match `payload.peerId`

Canonical signature payload (v2):

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

Successful response:

```json
{
  "v": "1",
  "id": "srv-ack-uuid",
  "type": "register_ack",
  "payload": {
    "peerId": "PEER_ID",
    "sessionId": null
  }
}
```

### `signal`

Signaling relay frame (`offer`, `answer`, `ice`, `call_invite`, etc.):

```json
{
  "v": "1",
  "id": "1741590003456789",
  "type": "signal",
  "payload": {
    "type": "offer",
    "from": "SENDER_PEER_ID",
    "to": "TARGET_PEER_ID",
    "data": {
      "sdp": "..."
    }
  }
}
```

### `ping` / `pong`

Heartbeat:

```json
{
  "v": "1",
  "id": "1741590009876543",
  "type": "ping",
  "payload": {
    "peerId": "PEER_ID"
  }
}
```

Server replies with:

```json
{
  "v": "1",
  "id": "srv-pong-uuid",
  "type": "pong",
  "payload": {
    "peerId": "PEER_ID"
  }
}
```

### `error`

Error format:

```json
{
  "v": "1",
  "id": "srv-error-uuid",
  "type": "error",
  "payload": {
    "code": "ERROR_CODE",
    "message": "Human-readable message"
  }
}
```

## Relay API reference

PeerLink clients usually use relay together with signaling. Relay endpoints:

- `GET /health`
- `POST /relay/store`
- `POST /relay/group/store`
- `POST /relay/group/members/update`
- `POST /relay/blob/upload`
- `POST /relay/blob/upload/chunk`
- `POST /relay/blob/upload/complete`
- `GET /relay/blob/:blobId`
- `GET /relay/fetch`
- `POST /relay/ack`

For full request/response fields and signature payload formats, see:

- `README.relay.md`

Important relay behavior for group traffic:

- relay enforces server-side membership for `group/store`
- relay enforces sender membership for blob upload endpoints
- client owner should sync membership using `POST /relay/group/members/update`

## Local run

```bash
npm install
npm run start:signal
```

## Docker target

The image is built from `Dockerfile` target:

- `signal`
