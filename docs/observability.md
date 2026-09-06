<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# Observability

## Data sources

PostgreSQL is the authoritative persistent source for product analytics:
unique users from `push_devices`, known servers from `observed_servers`,
logical product activity from `product_event_hourly`, per-server observations
from `server_usage_hourly`, and checker history from `server_checks`.

Prometheus is runtime telemetry for push infrastructure: accepted push events,
sent/failed deliveries, APNS/FCM split, dedup/replay cache size, access-policy
decisions/sync, Postgres health and delivery latency.

## Dashboards

`PeerLink Overview` is the daily product dashboard. It shows users, new users,
known servers, new servers, logical message/call events, server health and top
active servers.

`PeerLink Push Health` is the operational dashboard. It shows push throughput,
success/failure, APNS/FCM failures, registered devices, access-policy state,
delivery latency p50/p95/p99 and separate call/VoIP push health.

`PeerLink Network` is the server/network dashboard. It shows total/healthy/
degraded/offline servers, server growth, top server activity and selected server
details.

## Event semantics

`normalizeEventType` maps message/direct payload types to `message`, group
payload types to `group`, call payload types to `call`, empty values to
`unknown`, and sanitizes custom event names.

`product_event_hourly` increments once per accepted, non-deduped logical push
event. It is not multiplied by number of recipients, devices or discovered
server URLs.

`server_usage_hourly` is per observed server. If one payload contains several
server URLs, each server gets its own observation and activity increment.

## Restart behavior

Prometheus counters and histograms are in-memory process telemetry and can reset
after a `push` restart. Queries use `rate`/`increase`, so counter resets are
expected.

PostgreSQL data persists across restarts: total users, first-seen users, known
servers, first-seen servers, product event history, server observations and
checker history do not reset with the `push` process.
