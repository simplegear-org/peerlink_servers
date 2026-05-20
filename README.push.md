# PeerLink Push
Last updated: 2026-05-16

Push service for PeerLink. Stores device FCM tokens and sends remote push via Firebase Cloud Messaging (FCM).

Main runtime file:
- `push.js`

Exposed port:
- `4500/tcp`

## Endpoints

### `GET /health`

Returns service status and provider configuration flags.

### `POST /send`

Sends one push notification through FCM.
Duplicate events are deduplicated by in-memory TTL cache in `push` service.

Request body:
- `token` (required): FCM registration token (prefix `fcm:` is allowed and optional)
- `data` (optional object): key-value payload.
- `notification` (optional object): `{ "title": "...", "body": "..." }`
- `android` (optional object): FCM Android options

### `POST /devices/register`

Registers or updates a user device token.

Request body:
- `id` (required request id)
- `from` (required, must match `userId`)
- `ts` (required unix ms)
- `sig` (required, base64 Ed25519 signature)
- `signingPub` (required, base64 Ed25519 public key)
- `userId` (required)
- `deviceId` (required)
- `token` (required)
- `platform` (required, example: `android`, `ios`)
- `appVersion` (optional)

Signature payload:

`id|from|deviceId|token|platform|appVersion|ts`

### `POST /devices/unregister`

Disables a user device token.

Request body:
- `id` (required request id)
- `from` (required, must match `userId`)
- `ts` (required unix ms)
- `sig` (required, base64 Ed25519 signature)
- `signingPub` (required, base64 Ed25519 public key)
- `userId` (required)
- `deviceId` (required)
- `token` (required)

Signature payload:

`id|from|deviceId|token|ts`

### `GET /devices/by-user/:userId`

Returns registered devices for one user.

### `POST /events/message`

Accepts one message event and sends update push to all active devices of recipients:
- `group_update` for group chats
- `direct_update` for direct chats

Request body:
- `id` (required request id)
- `from` (required, must match `senderUserId`)
- `ts` (required unix ms)
- `sig` (required, base64 Ed25519 signature)
- `signingPub` (required, base64 Ed25519 public key)
- `senderUserId` (required)
- `groupId` (required for group chat events)
- `directPeerId` (required for direct chat events)
- `messageId` (required)
- `recipientUserIds` (required array)
- `schemaVersion` (optional, default legacy `push-v1`; recommended `push-v1.1`)
- `relay` (optional object, required for `push-v1.1`):
  - `serverId` (required for `push-v1.1`)
  - `scopeKind` (required for `push-v1.1`, values like `group`/`direct`)
  - `blobId` (optional)
  - `relayMessageId` (optional)

Signature payload:

- legacy (`schemaVersion` omitted):
  - `id|from|scopeId|messageId|recipient1,recipient2,...|ts`
- `push-v1.1`:
  - `id|from|scopeId|messageId|recipient1,recipient2,...|ts|schemaVersion|relayServerId|relayScopeKind|relayBlobId|relayMessageId`
- `scopeId` = `groupId` for group chat events, or `directPeerId` for direct chat events.
- recipients are sorted/unique before signature verification.

FCM fanout payload:
- `notification` is sent with title/body for better iOS background visibility.
- `data` includes: `type`, (`groupId` or `directPeerId`), `messageId` (`lastSeq`), `senderUserId`, `schemaVersion`, relay metadata fields.

## Security

- Set `PUSH_API_TOKEN` and call with `Authorization: Bearer <token>`.
- Write endpoints `/devices/register`, `/devices/unregister`, `/events/message`
  require Ed25519 signature (`id`, `from`, `ts`, `sig`, `signingPub`) and replay
  protection by request id TTL cache.
- If `PUSH_API_TOKEN` is empty, bearer layer is disabled, but signature checks still apply.

Common write errors:
- `401 unauthorized` (bearer mismatch)
- `401 invalid signature`
- `401 signature_timestamp_skew`
- `409 duplicate request id`
- `400 invalid_payload` / `400 invalid_relay_metadata`

## Environment

- `PORT` (default `4500`)
- `PUSH_BODY_LIMIT` (default `2mb`)
- `PUSH_API_TOKEN`
- `PUSH_DEDUP_TTL_SECONDS` (default `30`)
- `PUSH_MAX_DEVICES_PER_USER` (default `20`)
- `PUSH_SIGNATURE_SKEW_SECONDS` (default `120`)
- `PUSH_SIGNED_ID_TTL_SECONDS` (default `300`)

FCM:
- `FCM_PROJECT_ID`
- `FCM_CREDENTIALS_JSON` (service account JSON string; if omitted, ADC is used)

## Local run

```bash
npm install
npm run start:push
```

## Docker Compose (push-only)

Use standalone compose file:

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

## Recommended integration

Use `app/backend -> push` integration:
- app/backend calls `/devices/register` and `/devices/unregister`
- app/backend emits `/events/message` when a new message is stored
- push service fanouts FCM pushes to registered recipient devices

## Autodeploy via `deploy.sh`

`deploy.sh` now auto-wires push deployment:
- adds `push` service into `docker-compose up ...`
- generates `.env` with relay/push integration variables
- auto-generates `PUSH_API_TOKEN` if not provided
- sets `PUSH_PROVIDER_BEARER` to the same token if not provided
