# PeerLink Relay
Last updated: 2026-04-13

PeerLink relay service for signed envelope delivery and encrypted blob transport.

https://github.com/simplegear-org/peerlink_servers.git

## What it does

- Accepts relay envelopes from peers
- Stores pending messages for recipients
- Returns queued messages via polling endpoint flow
- Supports acknowledgement and cleanup of delivered messages
- Supports encrypted blob upload/download (single and chunked upload modes)

Presence (online/last-seen) is implemented by the signaling service (`signal.js`) via `peers_request`/`peers` snapshots and push `presence_update` frames.

## Exposed port

- `4000/tcp`

## Main runtime file

- `relay.js`

## Relay HTTP API

### `GET /health`

Returns service status:

```json
{
  "ok": true,
  "ts": 1741590002123
}
```

### `POST /relay/store`

Stores an envelope for recipient delivery queue.

Required body fields:

- `id` (string)
- `from` (string)
- `to` (string)
- `ts` (number, unix ms)
- `ttl` (number, seconds)
- `payload` (base64)
- `sig` (base64 Ed25519 signature)
- `signingPub` (base64 Ed25519 public key, 32 bytes)

Signature payload for verification:

`id|from|to|ts|ttl|` + raw decoded `payload` bytes

### `POST /relay/group/store`

Stores one signed envelope and fan-outs it to multiple recipients.

Required body fields:

- `id` (string)
- `from` (string)
- `groupId` (string)
- `recipients` (array of recipient peerIds)
- `ts` (number, unix ms)
- `ttl` (number, seconds)
- `payload` (base64)
- `sig` (base64 Ed25519 signature)
- `signingPub` (base64 Ed25519 public key, 32 bytes)

Signature payload for verification:

`id|from|groupId|recipient1,recipient2,...|ts|ttl|` + raw decoded `payload` bytes

Server-side membership checks:

- sender (`from`) must be a current group member
- each recipient in `recipients[]` must be a current group member
- if group membership is unknown yet, relay bootstraps initial membership as:
  `from + recipients[]`

### `POST /relay/group/members/update`

Updates authoritative group membership on relay.

Required body fields:

- `id` (string)
- `from` (string, must equal `ownerPeerId`)
- `groupId` (string)
- `ownerPeerId` (string)
- `memberPeerIds` (array of peerIds)
- `ts` (number, unix ms)
- `ttl` (number, seconds)
- `sig` (base64 Ed25519 signature)
- `signingPub` (base64 Ed25519 public key, 32 bytes)

Signature payload for verification:

`id|from|groupId|ownerPeerId|member1,member2,...|ts|ttl`

### `POST /relay/blob/upload`

Stores one encrypted blob payload (single-shot upload).

Required body fields:

- `id` (string, blob id)
- `from` (string)
- `groupId` (string)
- `fileName` (string)
- `mimeType` (string or empty string)
- `ts` (number, unix ms)
- `ttl` (number, seconds)
- `payload` (base64)
- `sig` (base64 Ed25519 signature)
- `signingPub` (base64 Ed25519 public key, 32 bytes)

Signature payload for verification:

`id|from|groupId|fileName|mimeType|ts|ttl|` + raw decoded `payload` bytes

Server-side membership checks:

- if group membership is known, sender (`from`) must be a current group member

### `POST /relay/blob/upload/chunk`

Stores one chunk for a blob upload session.

Required body fields:

- `id` (string, blob id)
- `from` (string)
- `groupId` (string)
- `fileName` (string)
- `mimeType` (string or empty string)
- `ts` (number, unix ms)
- `ttl` (number, seconds)
- `chunkIndex` (number, 0-based)
- `totalChunks` (number)
- `payload` (base64 chunk bytes)

Server-side membership checks:

- if group membership is known, sender (`from`) must be a current group member

### `POST /relay/blob/upload/complete`

Finalizes chunked blob upload and materializes the blob.

Required body fields:

- `id` (string, blob id)
- `from` (string)
- `groupId` (string)
- `fileName` (string)
- `mimeType` (string or empty string)
- `ts` (number, unix ms)
- `ttl` (number, seconds)
- `sig` (base64 Ed25519 signature)
- `signingPub` (base64 Ed25519 public key, 32 bytes)

Signature payload for verification:

`id|from|groupId|fileName|mimeType|ts|ttl|` + raw reassembled blob bytes

Server-side membership checks:

- if group membership is known, sender (`from`) must be a current group member

### `GET /relay/blob/:blobId`

Fetches stored blob metadata and base64 payload by blob id.

### `GET /relay/fetch?to=<recipient>&cursor=<id>&limit=<n>`

Fetches queued envelopes for recipient.

- `to` is required
- `cursor` is optional
- `limit` default is `50`, max is `500`

Response:

```json
{
  "messages": [],
  "cursor": "last-envelope-id-or-null"
}
```

### `POST /relay/ack`

Acknowledges successful delivery and removes message from queue.

Required body fields:

- `id` (string)
- `from` (string)
- `to` (string)
- `ts` (number, unix ms)
- `sig` (base64 Ed25519 signature)
- `signingPub` (base64 Ed25519 public key, 32 bytes)

Signature payload for verification:

`id|from|to|ts`

## Signature validation behavior

- Invalid body/field types return `400`
- Signature verification failure returns `401` with `{"error":"invalid signature"}`
- Membership violation returns `403`
- Owner mismatch on membership update returns `409`
- Valid requests are accepted and processed

## Local run

```bash
npm install
npm run start:relay
```

## Docker target

The image is built from `Dockerfile` target:

- `relay`
