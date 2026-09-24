# CHANGELOG


## [1.7.9-2026092402] - 2026-09-24

### Fixed

- Fixed CI publication of the public source snapshot when mirror scripts do not
  have the executable permission bit.


## [1.7.9-2026092401] - 2026-09-24

### Changed

- Relay capabilities now explicitly report safe multi-replica persistence and
  the inactive routed-transfer surface. Legacy clients and relays continue to
  use normal store/fetch behavior when routing fields are absent or disabled.
- Push can optionally publish `GET /routing/descriptor` with up to three
  overlapping Ed25519 routing public keys. The endpoint is available only when
  its configured private key matches an active descriptor key; it does not yet
  enable server-to-server transfer.
- Routing descriptors are admitted only after encrypted Push delivery
  self-check, are bound to the Push origin and authority id, and reject expired
  keys. No Push key or global routing root key is pinned in the app.


## [1.7.8+2026092301] - 2026-09-23

### Changed

- Added `POST /devices/self-check` so clients can verify APNs/FCM delivery in
  the background. The server sends the same opaque encrypted payload back to
  the submitted token without decrypting or persisting it; the check never
  creates a user-visible notification.
- Preserved compatibility with older app versions: the endpoint is optional
  and does not change existing register, access-policy, or fanout contracts.


## [1.7.7+2026091802] - 2026-09-18

### Changed

- Fixed chunked relay-media uploads that could time out after many chunks.
  Incomplete upload chunks are now persisted as individual crash-safe files,
  while the upload snapshot stores only metadata and chunk indexes. Legacy
  embedded-chunk snapshots are migrated during relay startup.
- Added regression coverage for bounded upload metadata, restart recovery, and
  legacy upload-snapshot migration.


## [1.7.6+2026091801] - 2026-09-18

### Changed

- Added signed access-policy schema v2 with four independent notification-mute
  lists: direct/group messages and direct/group calls.
- Push fanout now suppresses only the matching muted notification before
  APNs/FCM delivery; muted-only fanout succeeds with `suppressed`, while relay
  message delivery remains unchanged.
- Kept schema-v1 access-policy compatibility and added regression coverage for
  mute/unmute, message/call separation, and mute/block independence.


## [1.7.5+2026091702] - 2026-09-17

### Changed

- The relay Docker target now copies every extracted `relay-*.js` module; a
  newly published immutable image tag is required for that correction.


## [1.7.4+2026091701] - 2026-09-17

### Changed

- Public snapshot validation now checks required Docker build-context sources
  independently of `COPY` argument order.
- Local relay persistence (`data/relay/`) is ignored by Git; obsolete empty
  local `invites/` workspace residue was removed.
- Auto-update policy has isolated regression coverage for disabled, unsafe and
  tagged fast-forward releases; it uses only the canonical public repository.
- Shared stateless deployment primitives were extracted without merging push
  and bootstrap/relay/TURN rollout workflows.
- Relay HTTP composition is split into data routes, metadata routes, request
  and signature validation, and retention lifecycle modules without protocol or
  persistence-format changes.


## [1.7.3+2026091602] - 2026-09-16

### Changed

- Fixed public snapshot validation so the Dockerfile source-info check accepts
  the current COPY instruction with additional runtime modules.
- ACK now removes only its message envelope; media blobs keep their independent
  TTL. Durable ACK tombstones persist recipient/message/acknowledgement/expiry
  metadata and GC bounds duplicate-store protection.


## [1.7.2+2026091601] - 2026-09-16

### Changed

- Relay replicas are durable across process, container and host restarts:
  messages, blobs, incomplete uploads, group membership and ACK tombstones use
  crash-safe atomic snapshots in the `relay-data` Compose volume. Startup and
  periodic retention GC enforce the configured TTL policy.
- Added `update-server.sh` for protected bootstrap/relay/TURN rollouts from
  the public source mirror, using versioned CI images and health checks.
- `deploy.sh` and `bootstrap.sh` install/configure a local opt-out systemd
  auto-update timer. It accepts only fast-forward tagged public releases and
  rejects major releases by default.
- The push stack now pulls versioned CI images only: `invite` is published by
  the Docker workflow alongside `push` and `server-checker`; local builds are
  removed from deploy and update paths.


## [1.7.1+2026091201] - 2026-09-12

### Changed

- The public invite resolver now returns CORS headers only for
  `https://simplegear.org`, enabling the invite landing page without opening
  the API to arbitrary browser origins.
- Hardened push-stack deployment and updates: generated nginx configuration is
  validated before activation, upstreams use Docker DNS re-resolution, and the
  deploy waits for push/proxy readiness before completing.
- `update-push.sh` now fetches the selected branch and delegates deployment to
  the canonical `deploy-push.sh` flow while preserving the existing env file.


## [1.7.0+2026091001] - 2026-09-10

### Changed

- Added the persistent invite service (`invite.js`) with signed manifest
  creation and repeated short-token resolution at `POST /invites` and
  `GET /invites/:token`.
- Invite records use cryptographically random tokens, server-owned expiry and
  invite IDs, creation rate limits, atomic persistence and restart recovery.
- The service verifies the inviter identity bundle and canonical Ed25519
  manifest signature; optional username and server metadata are returned
  without storing message content or encryption keys.


## [1.6.4+2026090802] - 2026-09-08

### Changed

- Improved moderation workflow:
  - added individual review and resolution for each report;
  - added `Dismiss`, `Warning`, and `Ban` decisions;
  - fixed pending/processed report counters;
  - added priority handling for `OVERDUE` and high-risk reports;
  - improved 24-hour SLA tracking;
  - expanded moderator audit trail;
  - added support for rejecting appeals while keeping a ban in place;
  - prevented automatic resolution of all reports when action is taken against a Peer ID.


## [1.6.3+2026090801] - 2026-09-08

### Changed

- Added 24-hour SLA tracking to `Incoming Reports`: report age, warnings
  starting at 20 hours, and `OVERDUE` status after 24 hours. The dashboard
  refreshes automatically every minute.
- Added queue-wide counts for pending, approaching-deadline, and overdue
  reports, independent of the displayed list limit.
- Fixed pending/processed counts to reflect moderator decisions; the
  `/admin/reports` API supports `pending`, `processed`, and `all` filters.
  `Incoming Reports` now shows only reports requiring action.
- In-memory fallback peer moderation actions now update the associated
  reports and decision history, matching PostgreSQL behavior.
- Added tests for SLA boundaries, empty queues, and removal of processed
  reports from `Incoming Reports`. Documented SLA tracking and client
  `Block and Report` submissions through the existing metadata-only
  `/moderation/reports` endpoint.


## [1.6.2+2026090603] - 2026-09-07

### Changed

- Added server-side normalization for legacy iOS/macOS APNs message tokens that
  were stored as FCM provider tokens, so restored devices use APNs delivery
  after push restarts.
- Added a schema bootstrap migration for existing APNs-looking iOS/macOS
  message tokens in `push_devices`.


## [1.6.1+2026090602] - 2026-09-06

### Changed

- Public source mirror manifest now exports the full `deploy` directory, so new
  Grafana provisioning dashboards are included in released source snapshots.
- Added the new observability schema module and observability documentation to
  the public mirror manifest.


## [1.6.0+2026090601] - 2026-09-06

### Changed

- Split Grafana monitoring into `PeerLink Overview`, `PeerLink Push Health`,
  and `PeerLink Network` dashboards with separate product analytics and push
  operations views.
- Added persistent `product_event_hourly` analytics for logical message/group
  and call events, avoiding server/device fanout double counting in product
  charts.
- Added Prometheus delivery latency histogram
  `peerlink_push_delivery_duration_seconds` and call/VoIP push health panels.
- Moved observability schema bootstrap into `observability/db/schema.js` and
  made `peerlink_observed_servers_total` use PostgreSQL totals when available.
- Documented observability data sources, dashboard semantics, and restart
  behavior.


## [1.5.3+2026090101] - 2026-09-01

### Changed

- Push nginx deployment config now proxies `POST /devices/access-policy`, so
  clients can sync access-policy snapshots through the public push endpoint.


## [1.5.2+2026083104] - 2026-08-31

### Changed

- Extended access-policy filtering to `call_invite` fanout, so blocked senders
  and contacts-only mode are enforced for call pushes as well as message updates.
- Added startup diagnostics for restored push device registry state, including
  DB readiness and restored message/VoIP token counts.
- Invalid standard message tokens are now disabled after explicit FCM/APNs
  invalid-token responses, preventing repeated sends to stale restored tokens.


## [1.5.1+2026083102] - 2026-08-31

### Changed

- Added access-policy stdout diagnostics for snapshot sync and fanout
  decisions, including policy version, snapshot hash, contact/block counts, and
  allow/drop reasons without logging full peer lists.


## [1.5.0+2026083101] - 2026-08-31

### Changed

- Push device registry moved to Postgres-backed `push_devices`, with active
  device loading on server startup and in-memory fallback/cache.
- Added signed `POST /devices/access-policy` for recipient
  `allowMessagesOnlyFromContacts`, contacts, and blocklist snapshots.
- Added server-side `direct_update`/`group_update` filtering before fanout:
  blocked senders are dropped, and contacts-only recipients only allow contacts.
- Added compatibility mode
  `PUSH_ACCESS_POLICY_MISSING_SNAPSHOT_MODE=allow` by default: older clients
  without an access-policy snapshot still receive pushes without the new filter.
  Strict mode can be enabled with `drop` after client rollout.
- After allow, iOS `direct_update`/`group_update` is sent as visible alert push
  with APNs priority `10` and `mutable-content: 1`; Android message/update
  remains data-only.
- Added Prometheus metrics and Grafana panels for access-policy users, sync,
  decisions, and max snapshot age.


## [1.4.13+2026083001] - 2026-08-30

### Changed

- Fixed iOS APNS-provider `direct_update`/`group_update` delivery to use native
  APNs background pushes (`apns-push-type: background`, priority `5`) instead of
  the alert APNs path when sending `content-available` payloads.


## [1.4.12+2026082908] - 2026-08-29

### Changed

- iOS `direct_update`/`group_update` delivery is now silent/data-only with
  APNs `content-available` and no remote alert. The iOS app creates a local
  notification only after its native access-policy gate allows the sender, so
  blocked/contacts-only filtering is applied before presentation.


## [1.4.11+2026082907] - 2026-08-29

### Changed

- iOS `direct_update`/`group_update` delivery through FCM now uses an APNs
  alert payload with `mutable-content: 1` and no top-level FCM `notification`,
  so the Notification Service Extension can reliably apply local blocked-peer
  filtering before push presentation.


## [1.4.10+2026082906] - 2026-08-29

### Changed

- iOS/macOS `call_invite` standard FCM/APNs delivery is now skipped only when
  the exact target device already has an active `voipToken` and an APNs VoIP
  topic is configured. If no VoIP token is registered for that device, standard
  delivery remains as a fallback so the device is not left without a call push.


## [1.4.9+2026082905] - 2026-08-29

### Changed

- `call_invite` standard FCM/APNs delivery is now skipped for iOS/macOS when
  the request includes VoIP delivery and an APNs VoIP topic is configured. This
  removes the duplicate ordinary-push path beside CallKit VoIP delivery.
- Android `call_invite` continues to use standard FCM data-only delivery.


## [1.4.8+2026082904] - 2026-08-29

### Changed

- iOS `direct_update`/`group_update` delivery through FCM is back to visible
  `notification` with APNs `mutable-content`, because iOS data-only delivery is
  unreliable while the app is backgrounded.
- Android message/update push remains data-only with native block-check.


## [1.4.7+2026082903] - 2026-08-29

### Changed

- iOS `direct_update`/`group_update` delivery through FCM is now data-only with
  APNs `content-available` and no FCM `notification`, so the client can check
  the local block-list before showing a notification.
- `delivery/providers.js` now supports APNs headers/payload in FCM v1 messages
  without a display notification.


## [1.4.6+2026082902] - 2026-08-29

### Changed

- Added `mutable-content: 1` to APNs message/update push alerts so the iOS
  Notification Service Extension can apply local blocked-peer filtering before
  notification presentation.
- Changed FCM message/update push delivery to data-only with high priority only
  for Android devices; iOS FCM fallback keeps the notification payload and adds
  APNs `mutable-content: 1`.
- Fixed `tools/prepare_release.sh` to update Docker tags for registry-prefixed
  `push` images (`tangash/push`, `simplegear/push`), not only the legacy
  `peerlink-push` name.


## [1.4.4+2026082801] - 2026-08-28

### Changed

- Moderator UI now truncates long Peer IDs and replaces native prompts with a matching dark modal.


## [1.4.4+2026082706] - 2026-08-27

### Fixed

- `signedStatus` for moderation warning/ban now signs and returns timestamps in the same ISO format, so client signature verification no longer rejects delivered warn/ban events.
- Moderator UI now uses a dark theme, separate `Incoming Reports` / `Reported Users` / `Reporters` / `Appeals` tabs, and client-side pagination with 20 rows per page.


## [1.4.3+2026082705] - 2026-08-27

### Changed

- Added the admin `Appeals` block: moderators can accept an appeal with `Unban`, clear the peer policy, and send `moderation_policy action=unban`.


## [1.4.2+2026082703] - 2026-08-27

### Changed

- Moderator UI/API now accepts only manual `warn`/`ban`; automatic report-count scoring was removed.
- Moderator UI pre-fills the note with report count and unique reporter count without exposing Peer IDs.
- Manual `warn`/`ban` actions now send the target user a best-effort data-only `moderation_policy` push with `messageKey`, `reportCount`, and `reporterCount`.


## [1.4.1+2026082701] - 2026-08-27

### Changed

- Changed `update-push.sh` to restart `push-proxy` and `moderation-ui` after
  updates so nginx does not keep stale upstream container IPs.
- Added checked-in moderator UI files to the public source mirror manifest.


## [1.4.0+2026082607] - 2026-08-26

### Changed

- Changed `update-push.sh` to force-sync the deployment checkout with
  `origin/main` via `git checkout -B` and `git reset --hard`, then pull images
  and restart the push stack.


## [1.4.0+2026082606] - 2026-08-26

### Changed

- Changed public push compose image defaults to the public Docker Hub images
  `tangash/push` and `tangash/server-checker`.


## [1.4.0+2026082605] - 2026-08-26

### Changed

- Changed the public push compose defaults to Docker Hub images
  `simplegear/push` and `simplegear/server-checker`, so `update-push.sh`
  can pull GitHub-built images without local `PUSH_IMAGE` overrides.


## [1.4.0+2026082604] - 2026-08-26

### Changed

- Added `update-push.sh` and decomposed push runtime modules to the public
  source mirror manifest so deployments that track the public `main` checkout
  receive the updater script and all Docker runtime imports.


## [1.4.0+2026082603] - 2026-08-26

### Changed

- Fixed Docker images for decomposed push modules by copying `delivery/`,
  `devices/`, `moderation/`, `observability/`, and `security/` into runtime
  images.
- Added `update-push.sh` to update the push stack with one command from
  `origin/main`, pulling GitHub-built images and restarting services with
  `docker compose up -d --no-build`.
- Fixed the signal ping test to wait for `pong` while allowing legitimate
  `presence_update` frames between registration and ping response.


## [1.4.0+2026082602] - 2026-08-26

### Changed

- Added soft-migration identity binding for the push API: new clients bind
  `peerId` to `signingPub` in the existing `/devices/register` request through
  `identitySchemaVersion=2`, `identityNonce`, and `identityProofSig` without
  extra network round trips.
- Push server now persists verified bindings in Postgres
  `peer_identity_bindings`, with memory fallback.
- For already-bound `peerId` values, the server rejects signing-key mismatches
  on `/events/push`, `/moderation/reports`, and `/moderation/appeals` while
  preserving compatibility for legacy clients without bindings.
- Moderator UI was updated for metadata-only moderation: it separately shows
  reported-user aggregates, reporter aggregates, and a general incoming report
  list without message text.
- Added admin endpoints `/admin/moderation/reported-peers` and
  `/admin/moderation/reporters` with total/direct/group report counters.
- Decomposed security-critical push logic: signed request/replay handling moved
  to `security/signed-requests.js`, identity binding moved to
  `security/identity-bindings.js`, and `push.js` now wires these modules into
  routes.
- Continued `push.js` decomposition: device registry/routes moved to
  `devices/*`, push dedup and FCM/APNs providers moved to `delivery/*`, and
  moderation endpoints moved to `moderation/routes.js`.
- Decomposed `observability.js`: server discovery, Prometheus metrics,
  moderation helpers, and observed-server checker moved to `observability/*`.
- Updated push API documentation and added tests for verified registration and
  spoofed push/moderation request rejection plus moderation aggregate lists.


## [1.3.2+2026082404] - 2026-08-24

### Changed

- Updated `deploy-push.sh` to generate moderator UI files
  `deploy/push/moderation-ui/index.html` and `nginx.conf`, so clean deploys do
  not fail on missing mount sources.


## [1.3.1+2026082403] - 2026-08-24

### Changed

- Updated `deploy-push.sh` to generate moderator UI mount sources, start
  `moderation-ui` with the push stack and proxy public client `/moderation/*`
  endpoints.


## [1.3.0+2026082402] - 2026-08-24

### Changed

- Added push/moderation endpoints for report intake, moderation status,
  appeals and moderator actions; client reports and appeals are accepted with
  Ed25519 signatures, without shipping an admin token in the app.
- Added Postgres-backed moderation policy: reports increase counters, while
  only moderators can set `warning`/`banned`.
- Added a localhost-only moderator UI to the push-only compose stack on
  `127.0.0.1:4501`.
- Added the `PeerLink X Moderation` Grafana dashboard with report counters and
  a peer score table.


## [1.2.1+2026082401] - 2026-08-24

### Release

- Fixed Docker image publishing for SemVer build metadata by using
  registry-safe Docker tags while keeping the original version in build
  metadata and source metadata.
- Added the `server-checker` image to the Docker image workflow.
- Removed the host Node.js requirement from push deployment validation by
  checking FCM credentials JSON through the push container.
- Made public source snapshot publishing idempotent for unchanged existing
  source tags and fail before committing when an immutable source tag already
  exists for different exported content.


## [1.2.0+2026082301] - 2026-08-23

### Observability

- Added push metrics endpoint for Prometheus with registered device, push event,
  delivery, failure, dedup and observed-server counters.
- Added Postgres-backed self-hosted server discovery from push payload server
  lists, including per-server message/call usage and health-check history.
- Added a server checker service plus Grafana/Prometheus/Postgres services to
  the standalone push compose stack.

### Release

- Added release tooling support for SemVer build metadata such as
  `1.2.0+2026082301`, with Docker image tags normalized to a registry-safe
  `1.2.0-2026082301` form.
- Updated the Docker image workflow to publish registry-safe tags when release
  versions include SemVer build metadata.


## [1.1.2] - 2026-08-14

### Deployment

- Switched the default coturn image to the official `coturn/coturn:4.6.2`
  image because the archived `instrumentisto/coturn` repository does not
  provide the previously configured tag.


## [1.1.1] - 2026-08-14

### Source distribution

- Updated release metadata for version `1.1.1` and source tag
  `source-v1.1.1`.
- Added release snapshot validation before public mirror publication.
- Included public mirror repository hardening guidance in the mirrored source
  documentation.
- Kept `tools/public_mirror/include.txt` as the single public mirror manifest
  and excluded non-required internal/release files from the mirrored snapshot.

### Deployment

- Compose files now build PeerLink relay, signal, and push images from the
  checked-out source by default.
- Removed floating `latest` PeerLink image defaults from public deployment
  paths.
- Pinned third-party runtime image defaults where they are still used.
- Deploy scripts now use source-build mode during automatic deployment.
- Bootstrap scripts can deploy a specific branch or source tag.

### TURN

- Kept fixed TURN compatibility credentials `peerlink`/`peerlink`.
- Removed misleading custom TURN credential instructions from public README
  files.
- Automatic deployment now applies default TURN bandwidth limits and supports
  optional quota/bandwidth overrides.
- No default total allocation quota is applied, to avoid blocking legitimate
  deployments that use a single TURN server.

### Metadata and documentation

- Docker images now copy `source-info.js` and include source/version/license OCI
  labels derived from the public source tag, not private commits.
- Removed stale manual update dates from public README files.
- Removed the AI-authorship statement from public README files.
- Updated commercial licensing, security and third-party notice wording for the
  public source snapshot.

## [1.1.0] - 2026-08-14

### Licensing

- PeerLink Servers source snapshots beginning with this release are distributed
  under AGPL-3.0-only.
- Earlier public releases were distributed under MIT.
- Separate commercial licensing may be available.
- The public GitHub repository is maintained as an append-only public source
  snapshot mirror rather than a copy of internal development history.
- Docker image labels and package metadata now declare `AGPL-3.0-only`.
- Project-authored server and deploy files now carry AGPL SPDX notices.
- Added `BRANDING.md` with brand-use wording that does not claim registered
  trademark status.

### Source availability

- Relay and push expose `/.well-known/peerlink-source`.
- Relay capabilities, relay health, push health, and bootstrap `register_ack`
  include source metadata without removing existing fields.
- Added `source-info.js` as the shared runtime source metadata provider.
- `SOURCE_SNAPSHOT.md` records version `1.1.0`, source tag `source-v1.1.0`,
  and AGPL licensing.

### Public mirror

- Replaced reset-history mirroring with append-only source snapshot publishing.
- Public mirror commits now use `chore(snapshot): publish PeerLink Servers
  <version> source` and do not include private repository names or SHAs.
- Public source tags are immutable and use `source-v<version>`.
- `tools/public_mirror/include.txt` is the single source of truth for mirrored
  files.
- Reduced the public mirror manifest to the minimal source-distribution set:
  license/notice/branding files, public READMEs, package manifests,
  Docker/Compose/deploy scripts, runtime server source, and `source-info.js`.
- Docker image workflow keeps container build/push and now delegates only source
  mirroring to `tools/public_mirror/publish_snapshot.sh`.

### Release tooling

- Added `tools/prepare_release.sh` for server version bumps and changelog/source
  snapshot metadata preparation.
- Added internal `RELEASE_FLOW_RU.md` describing server versioning and release
  handling; it is intentionally excluded from the public mirror.
