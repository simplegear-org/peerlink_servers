# PeerLink Push

Push service for PeerLink. Stores device tokens and sends remote push:
- message/update events via FCM/APNs with server-side access-policy filtering
- incoming call events via data-only FCM and APNs VoIP (auto-selected by server)

Main runtime file:
- `push.js`
- `devices/registry.js` — message/VoIP device token registry backed by Postgres when configured, with in-memory fallback/cache
- `devices/routes.js` — `/devices/*` route wiring
- `delivery/dedup-cache.js` — push event deduplication TTL cache
- `delivery/providers.js` — FCM/APNs provider clients and APNs topic validation
- `moderation/routes.js` — client/admin moderation route wiring
- `observability.js` — PushObservability facade and Postgres schema bootstrap
- `observability/server-discovery.js` — server URL extraction/normalization from push payloads
- `observability/metrics.js` — Prometheus metrics builder and counters
- `observability/moderation-helpers.js` — moderation score mappers and policy helpers
- `observability/server-checker.js` — observed-server health checker loop
- `security/signed-requests.js` — Ed25519 signed request verification and replay cache
- `security/identity-bindings.js` — v2 peer identity binding and soft migration enforcement

Runtime port inside stack:
- `4500/tcp` (`push` container)

Public ports:
- `80/tcp` (`push-proxy` ACME challenge + redirect)
- `443/tcp` (`push-proxy` TLS termination for push API)

## Updating a Deployed Push Stack

For servers that keep this checkout on the host, apply an update with one command:

```bash
./update-push.sh
```

The script loads `.env.push.local`, resets the local checkout to `origin/main`,
pulls the images referenced by the updated
`docker-compose.push.yml`, rebuilds local `push`/`server-checker` images, runs
`docker compose up -d --build`, restarts `push-proxy` and `moderation-ui`
so nginx resolves fresh upstream container IPs, shows container status and
prints recent `push`/`server-checker` logs.

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
- `messageToken` (required; FCM token for Android/iOS/macOS, APNS token only for APNS-provider clients)
- `messageProvider` (optional; `fcm` or `apns`, default `fcm`)
- `voipToken` (optional; iOS/macOS PushKit token for CallKit)
- `platform` (required, example: `android`, `ios`)
- `appVersion` (optional)
- `identitySchemaVersion` (optional; `2` for verified identity binding)
- `identityNonce` (optional; public nonce used to derive the v2 peer id)
- `identityProofSig` (optional; signature of the identity binding payload)

Signature payload:
`id|from|deviceId|messageToken|messageProvider|voipToken|platform|appVersion|ts`

For clients that include identity binding fields, the signature payload is:
`id|from|deviceId|messageToken|messageProvider|voipToken|platform|appVersion|identitySchemaVersion|identityNonce|identityProofSig|ts`

Identity proof payload:
`peerlink_identity_binding_v2|peerId|signingPub|identityNonce`

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

### `POST /devices/access-policy`

Stores the recipient's push filtering snapshot for server-side filtering.
This lets the push server decide whether `direct_update`/`group_update` may be
sent as visible iOS alert pushes.

Request body:
- `id` (required request id)
- `from` (required, must match `userId`)
- `ts` (required unix ms)
- `sig` (required, base64 Ed25519 signature)
- `signingPub` (required, base64 Ed25519 public key)
- `userId` / `peerId` (required)
- `allowMessagesOnlyFromContacts` (boolean)
- `contactPeerIds` (array)
- `blockedPeerIds` (array)
- `policyVersion` (integer, monotonic per user)
- `updatedAt` (client timestamp)
- `snapshotHash` (optional idempotency/diagnostic hash)

Signature payload:

`id|from|userId|allowMessagesOnlyFromContacts|contactPeerIdsJson|blockedPeerIdsJson|policyVersion|updatedAt|snapshotHash|ts`

Older clients that do not send this endpoint remain compatible while
`PUSH_ACCESS_POLICY_MISSING_SNAPSHOT_MODE=allow`.

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
- For `call_invite` to iOS/macOS targets, standard FCM/APNs delivery is skipped
  only when `delivery.voip=true`, an APNs VoIP topic is configured, and the
  exact target device has an active `voipToken`; CallKit should be driven by the
  VoIP path only. If the device has no active VoIP token, standard delivery
  remains as a fallback. Android still receives standard FCM data-only call
  invites.
- For `direct_update`, `group_update`, and `call_invite`, the server checks the
  recipient's stored access-policy snapshot before fanout: blocked senders are
  dropped, and contacts-only recipients only allow known contacts.
- Missing access-policy snapshots are controlled by
  `PUSH_ACCESS_POLICY_MISSING_SNAPSHOT_MODE`. Default `allow` keeps older clients
  compatible and sends pushes without the new server-side filter. Future strict
  deployments can set `drop`.
- Access-policy diagnostics are written to stdout:
  - `[push][access-policy]` after snapshot sync, with `userId`,
    `policyVersion`, `contactsCount`, `blockedCount`, `snapshotHash`, and
    result.
  - `[push][access-policy][decisions]` during push fanout, with per-recipient
    `allowed`, `reason`, `policyVersion`, `contactsCount`, and `blockedCount`.
  - `[push] standard send skipped ... reason=policy_blocked` when a push is
    dropped by the blocklist.
- After allow, iOS `direct_update`/`group_update` uses visible alert delivery
  with APNs priority `10` and `mutable-content: 1`, so iOS can show the push even
  when the app is suspended. Android message/update delivery remains data-only
  with high priority.
- If `notification.title/body` is omitted, standard delivery is silent/data-only. This is the required path for Android `call_invite`, where the client decides foreground/fullscreen presentation.

APNs headers used by push service:
- `apns-push-type: voip`
- `apns-priority: 10`
- `apns-topic: <bundle_id>.voip`
- APNs transport is sent over native HTTP/2 client in `push.js` (not `fetch`), because APNs endpoint is HTTP/2-only.

### `POST /moderation/reports`

Stores a user-generated-content report in the push observability database.

Request body:
- `id` (required signed request id)
- `from` (required, must match `reporterPeerId`)
- `ts` (required unix ms)
- `sig` (required, base64 Ed25519 signature)
- `signingPub` (required, base64 Ed25519 public key)
- `reporterPeerId` (required)
- `reportedPeerId` (required)
- `reason` (required): `spam`, `harassment`, `threats`, `illegal_content`, `abusive_behavior`, or `other`
- `contentEncrypted` (optional boolean)
- `encryptedContent` (optional object; encrypted selected-message payload)
- `createdAt` / `clientCreatedAt` (optional client timestamp)

Signature payload:
`id|from|reportedPeerId|reason|type|contentEncrypted|encryptedContentJson|ts`

The endpoint returns the stored report and current peer score. Report counts
are moderator context only; they never trigger automatic warning or ban actions.

### `GET /moderation/status?peerId=<peerId>`

Returns moderation score and policy state for one peer id.

Response includes:
- `reportCount`
- `reporterCount`
- `pendingCount`
- `processedCount`
- `appealedCount`
- `policyState`: `clear`, `warning`, or `banned`

### `POST /moderation/appeals`

Stores an appeal request.

Request body:
- `id` (required signed request id)
- `from` (required, must match `peerId`)
- `ts` (required unix ms)
- `sig` (required, base64 Ed25519 signature)
- `signingPub` (required, base64 Ed25519 public key)
- `peerId` (required)
- `text` or `message` (required)

Signature payload:
`id|from|peerId|text|ts`

### Admin moderation endpoints

These endpoints require `Authorization: Bearer <MODERATION_ADMIN_TOKEN>`.
If `MODERATION_ADMIN_TOKEN` is omitted, the server falls back to
`PUSH_API_TOKEN`.

- `GET /admin/moderation/summary` — total reports and warned/banned peer counts
- `GET /admin/reports` — metadata-only report list for moderator UI
- `GET /admin/moderation/reported-peers` — aggregate list of users who were reported, with total/direct/group report counts
- `GET /admin/moderation/reporters` — aggregate list of users who filed reports, with total/direct/group report counts
- `GET /admin/moderation/peer-scores?sort=report_count_desc|state_desc|last_report_desc` — sortable peer score list
- `GET /admin/moderation/appeals?status=open|all` — appeal queue for moderator UI
- `POST /admin/moderation/appeals/:id/unban` — accepts an appeal and clears the peer policy
- `POST /admin/reports/:id/action` — applies `warn`, `ban`, or `unban` to the reported peer
- `POST /admin/moderation/peers/:peerId/action` — applies `warn`, `ban`, or `unban` directly to a peer

Manual `warn`/`ban`/`unban` actions send a best-effort `moderation_policy` push to the
target peer. The moderator UI uses a dark tabbed layout for `Incoming Reports`,
`Reported Users`, `Reporters`, and `Appeals`; long Peer IDs are shortened to
`prefix...suffix`, and each table is paginated at 20 rows.

The moderator UI pre-fills the action note with the current report count and
unique reporter count without exposing reporter Peer IDs. `Warn`, `Ban`, and
`Unban` use the same styled confirmation dialog. The push payload includes
`messageKey`, `reportCount`, and `reporterCount`; the app renders the warning/ban
text using the user's locale. Moderation policy pushes are data-only so the
server does not have to guess the user's locale. `ban` is persisted locally;
after an appeal is submitted the app can be viewed, but outgoing messages and
calls stay blocked until `unban`.

## Security

- Set `PUSH_API_TOKEN` and call with `Authorization: Bearer <token>`.
- Set `MODERATION_ADMIN_TOKEN` for moderator UI/admin endpoints. If omitted,
  admin moderation endpoints use `PUSH_API_TOKEN`.
- Write endpoints `/devices/register`, `/devices/access-policy`,
  `/devices/unregister`, and `/events/push` require Ed25519 signature (`id`,
  `from`, `ts`, `sig`, `signingPub`) and replay protection by request id TTL
  cache.
- `push.js` wires route-level security checks through
  `security/signed-requests.js`; replay state is kept in that module and exposed
  to health/metrics as cache size.
- New clients bind `peerId` to `signingPub` during `/devices/register` by
  proving `peerId == SHA-256("uid:v2:" + signingPub + ":" + identityNonce)`.
  The server runs this in soft migration mode: legacy unbound clients still
  work, but once a peer has a verified binding, mismatched keys are rejected for
  `/events/push`, `/moderation/reports`, and `/moderation/appeals`.
- v2 identity proof parsing, verification, persistence and enforcement live in
  `security/identity-bindings.js`; `push.js` only calls the module from the
  affected routes.
- Client moderation write endpoints `/moderation/reports` and
  `/moderation/appeals` also require Ed25519 signatures and do not require
  `MODERATION_ADMIN_TOKEN`.
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
- `PUSH_ACCESS_POLICY_MISSING_SNAPSHOT_MODE` (`allow` by default; set `drop` only after client rollout)
- `PUSH_SIGNATURE_SKEW_SECONDS` (default `120`)
- `PUSH_SIGNED_ID_TTL_SECONDS` (default `300`)
- `MODERATION_ADMIN_TOKEN` (admin bearer token for moderator UI/API; falls back to `PUSH_API_TOKEN`)
- `MODERATION_STATUS_SIGNING_PRIVATE_KEY` (optional Ed25519 PKCS#8 private key, PEM or base64 DER, for signed `/moderation/status`)

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
- `moderation-ui` — localhost-only dark tabbed moderator UI on `127.0.0.1:4501`
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
- `MODERATION_ADMIN_TOKEN`
- `MODERATION_STATUS_SIGNING_PRIVATE_KEY`
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
- generates moderator UI mount sources and removes stale directory placeholders
  that would break file mounts
- installs Docker Engine and Docker Compose plugin on clean Debian/Ubuntu hosts
- validates `.env.push.local` before deployment
- for `PUSH_TLS_PROVIDER=letsencrypt`, starts HTTP challenge config, issues a certificate with `certbot certonly --webroot`, switches `nginx` to HTTPS and starts `certbot-renewer`
- for `PUSH_TLS_PROVIDER=cloudflare_origin`, writes Cloudflare Origin CA cert/key from `.env.push.local`, starts HTTPS directly and does not run certbot
- proxies client moderation endpoints `/moderation/reports`,
  `/moderation/status`, and `/moderation/appeals` through the public push
  domain; admin moderation endpoints stay available only through the
  localhost-only moderator UI container

Certificate paths on host:
- `deploy/push/letsencrypt/live/<PUSH_PUBLIC_HOST>/fullchain.pem`
- `deploy/push/letsencrypt/live/<PUSH_PUBLIC_HOST>/privkey.pem`

## Observability

The push stack includes production monitoring:
- `push-observability-db` stores observed self-hosted servers from push payloads
- `push-observability-db` also stores moderation reports, appeals and peer scores
- `push-observability-db` stores active push devices and access-policy snapshots
- `server-checker` periodically checks observed relay/signal/TURN endpoints
- `prometheus` scrapes internal `push:4500/metrics`
- `grafana` is exposed only on the origin host and provisions an additional
  moderation dashboard plus access-policy panels

`/metrics` is intentionally not proxied by the public `push-proxy`.

New environment variables:
- `PUSH_OBSERVABILITY_POSTGRES_PASSWORD`
- `GRAFANA_ADMIN_USER`
- `GRAFANA_ADMIN_PASSWORD`
- `PEERLINK_SERVER_CHECK_INTERVAL_MS`
- `PEERLINK_SERVER_CHECK_TIMEOUT_MS`

Observed servers are extracted from `payload.servers`, `signalServers`,
`relayServers`, `turnServers`, and `iceServers` in `/events/push` and `/send`.
The database keeps per-server usage counters for message/group events, calls,
checker status, and checker latency.

Moderation tables:
- `moderation_reports`
- `moderation_peer_scores`
- `moderation_appeals`

Push persistence/access-policy tables:
- `push_devices`
- `push_user_policy`
- `push_user_contacts`
- `push_user_blocked`

Access-policy metrics:
- `peerlink_push_access_policy_decisions_total`
- `peerlink_push_access_policy_sync_total`
- `peerlink_push_access_policy_users`
- `peerlink_push_access_policy_max_age_seconds`

Access-policy stdout diagnostics:
- `[push][access-policy]` logs accepted/stale snapshot sync without full peer
  lists.
- `[push][access-policy][decisions]` logs allow/drop reasons during fanout.
- `[push] standard send skipped ... reason=policy_<reason>` logs actual skipped
  standard push sends.

The moderator UI is exposed only on the origin host:

```text
http://127.0.0.1:4501
```

It proxies `/api/*` to the internal `push:4500` service and uses
`MODERATION_ADMIN_TOKEN` as bearer token.

For a public site allowlist, use only fresh healthy servers:

```sql
select normalized_url
from observed_servers
where status = 'healthy'
  and last_checked_at > now() - interval '15 minutes'
  and seen_count >= 3
order by last_check_latency_ms asc nulls last, last_seen_at desc;
```

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
- app/backend calls `/devices/register`, `/devices/access-policy`, and
  `/devices/unregister`
- app/backend emits `/events/push` for message, account, group, and call events
- push service fanouts FCM/APNs pushes to registered recipient devices

## Autodeploy via `deploy.sh`

`deploy.sh` now auto-wires push deployment:
- adds `push` service into `docker-compose up ...`
- generates `.env` with relay/push integration variables
- auto-generates `PUSH_API_TOKEN` if not provided
- sets `PUSH_PROVIDER_BEARER` to the same token if not provided
