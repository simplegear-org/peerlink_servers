# PeerLink Push

Push service for PeerLink. Stores device tokens and sends remote push:
- message/update events via FCM/APNs alert (auto-selected by server)
- incoming call events via data-only FCM and APNs VoIP (auto-selected by server)

Main runtime file:
- `push.js`

Runtime port inside stack:
- `4500/tcp` (`push` container)

Public ports:
- `80/tcp` (`push-proxy` ACME challenge + redirect)
- `443/tcp` (`push-proxy` TLS termination for push API)

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

FCM `data` values are normalized to strings before sending; nested objects such as
`servers` are serialized as JSON strings.

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
- `messageToken` (required; FCM token for Android, APNS token for iOS/macOS)
- `messageProvider` (optional; `fcm` or `apns`, default `fcm`)
- `voipToken` (optional; iOS/macOS PushKit token for CallKit)
- `platform` (required, example: `android`, `ios`)
- `appVersion` (optional)

Signature payload:
`id|from|deviceId|messageToken|messageProvider|voipToken|platform|appVersion|ts`

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

### `POST /events/push`

Universal signed fanout endpoint for all app push events.

Request body:
- `id` (required request id)
- `from` (required, must match `senderUserId`)
- `ts` (required unix ms)
- `sig` (required, base64 Ed25519 signature)
- `signingPub` (required, base64 Ed25519 public key)
- `senderUserId` (required)
- `recipientUserIds` (required array)
- `payload` (required object; app-defined technical payload)
- `notification` (optional object): `{ "title": "...", "body": "..." }`
- `delivery` (optional object): `{ "standard": true|false, "voip": true|false }`

Signature payload:
`id|from|recipient1,recipient2,...|payloadJson|notificationJson|delivery.standard|delivery.voip|ts`

Fanout behavior:
- `delivery.standard` sends to regular message tokens:
  - `apns` -> APNs alert/silent push over native HTTP/2,
  - `fcm` -> FCM push with normalized string `data`.
- `delivery.voip` sends APNs VoIP to registered `voipToken` devices.
- The server does not interpret business semantics inside `payload`; it forwards the technical payload and only uses recipients/delivery for routing.
- If `notification.title/body` is omitted, standard delivery is silent/data-only. This is the required path for Android `call_invite`, where the client decides foreground/fullscreen presentation.

APNs headers used by push service:
- `apns-push-type: voip`
- `apns-priority: 10`
- `apns-topic: <bundle_id>.voip`
- APNs transport is sent over native HTTP/2 client in `push.js` (not `fetch`), because APNs endpoint is HTTP/2-only.

## Security

- Set `PUSH_API_TOKEN` and call with `Authorization: Bearer <token>`.
- Write endpoints `/devices/register`, `/devices/unregister`, `/events/push`
  require Ed25519 signature (`id`, `from`, `ts`, `sig`, `signingPub`) and replay
  protection by request id TTL cache.
- If `PUSH_API_TOKEN` is empty, bearer layer is disabled, but signature checks still apply.

Common write errors:
- `401 unauthorized` (bearer mismatch)
- `401 invalid signature`
- `401 signature_timestamp_skew`
- `409 duplicate request id`
- `400 invalid_payload`
- `400 invalid_apns_topic`
- `502 push_send_failed` (when all selected deliveries fail, for example APNs/FCM upstream error)

## Environment

- `PORT` (default `4500`)
- `PUSH_BODY_LIMIT` (default `2mb`)
- `PUSH_PUBLIC_HOST` (public DNS name for the push API, used by deploy script)
- `LETSENCRYPT_EMAIL` (email for Let's Encrypt account, used by deploy script)
- `PUSH_API_TOKEN`
- `PUSH_DEDUP_TTL_SECONDS` (default `30`)
- `PUSH_MAX_DEVICES_PER_USER` (default `20`)
- `PUSH_SIGNATURE_SKEW_SECONDS` (default `120`)
- `PUSH_SIGNED_ID_TTL_SECONDS` (default `300`)

FCM:
- `FCM_PROJECT_ID`
- `FCM_CREDENTIALS_JSON` (service account JSON string; wrap the whole JSON in single quotes in `.env.push.local`; if omitted, ADC is used)

APNs VoIP:
- `APNS_TEAM_ID`
- `APNS_KEY_ID`
- `APNS_PRIVATE_KEY`
- `APNS_VOIP_TOPIC` (must be full topic and end with `.voip`)
- `APNS_MESSAGES_TOPIC` (must be full app topic for alert pushes, without `.voip`)
- `APNS_USE_SANDBOX` (`true` by default; set `false` for production/TestFlight)

## Local run

```bash
npm install
npm run start:push
```

## Docker Compose (push-only)

The standalone stack now contains:
- `push` — Node push runtime on internal port `4500`
- `push-proxy` — public `nginx` on `80/443`
- `certbot` — one-shot certificate issue helper
- `certbot-renewer` — background renewal loop (`certbot renew` every `12h`)

Public URL after deploy:

```text
https://<PUSH_PUBLIC_HOST>
```

Use standalone compose file:

```bash
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

After the script creates `/opt/peerlink_servers/.env.push.local`, fill it and run:

```bash
cd /opt/peerlink_servers
./bootstrap-push.sh
```

`deploy-push.sh` flow:
- prepares local directories for `nginx`, ACME webroot and Let's Encrypt state
- installs Docker Engine and Docker Compose plugin on clean Debian/Ubuntu hosts
- validates `.env.push.local` before deployment
- for `PUSH_TLS_PROVIDER=letsencrypt`, starts HTTP challenge config, issues a certificate with `certbot certonly --webroot`, switches `nginx` to HTTPS and starts `certbot-renewer`
- for `PUSH_TLS_PROVIDER=cloudflare_origin`, writes Cloudflare Origin CA cert/key from `.env.push.local`, starts HTTPS directly and does not run certbot

Certificate paths on host:
- `deploy/push/letsencrypt/live/<PUSH_PUBLIC_HOST>/fullchain.pem`
- `deploy/push/letsencrypt/live/<PUSH_PUBLIC_HOST>/privkey.pem`

## Cloudflare

Recommended default for this stack:
- use `DNS only` (gray cloud) for the push domain

Why:
- simpler ACME/Let's Encrypt troubleshooting
- direct TLS termination on your origin
- fewer moving parts while validating APNs/FCM behavior

If you later put the domain behind Cloudflare proxy:
- use `Full (strict)` SSL mode
- disable caching for the API hostname/path

For permanent orange-cloud proxy, use Cloudflare Origin CA:

```env
PUSH_TLS_PROVIDER=cloudflare_origin
PUSH_ORIGIN_CERT_PEM='-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----'
PUSH_ORIGIN_KEY_PEM='-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----'
```

Cloudflare settings:
- DNS record for `PUSH_PUBLIC_HOST`: `Proxied`
- SSL/TLS mode: `Full (strict)`
- Origin certificate hostnames must include `PUSH_PUBLIC_HOST`

In this mode `deploy-push.sh` skips the direct DNS-to-origin check because proxied records resolve to Cloudflare edge IPs.

## Recommended integration

Use `app/backend -> push` integration:
- app/backend calls `/devices/register` and `/devices/unregister`
- app/backend emits `/events/push` for message, account, group, and call events
- push service fanouts FCM/APNs pushes to registered recipient devices

## Autodeploy via `deploy.sh`

`deploy.sh` now auto-wires push deployment:
- adds `push` service into `docker-compose up ...`
- generates `.env` with relay/push integration variables
- auto-generates `PUSH_API_TOKEN` if not provided
- sets `PUSH_PROVIDER_BEARER` to the same token if not provided
