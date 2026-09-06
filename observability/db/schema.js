// SPDX-License-Identifier: AGPL-3.0-only

export const SCHEMA_SQL = `
create table if not exists observed_servers (
  id bigserial primary key,
  normalized_url text not null unique,
  scheme text not null,
  host text not null,
  port integer not null,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  seen_count bigint not null default 0,
  message_seen_count bigint not null default 0,
  call_seen_count bigint not null default 0,
  last_event_type text not null default 'unknown',
  status text not null default 'unknown',
  last_checked_at timestamptz,
  last_error text,
  capabilities_json jsonb,
  last_check_latency_ms integer
);

create table if not exists server_observations (
  id bigserial primary key,
  server_id bigint not null references observed_servers(id) on delete cascade,
  event_type text not null,
  observed_at timestamptz not null default now()
);

create table if not exists server_checks (
  id bigserial primary key,
  server_id bigint not null references observed_servers(id) on delete cascade,
  checked_at timestamptz not null default now(),
  status text not null,
  latency_ms integer,
  error text
);

create table if not exists server_usage_hourly (
  server_id bigint not null references observed_servers(id) on delete cascade,
  bucket_at timestamptz not null,
  message_count bigint not null default 0,
  call_count bigint not null default 0,
  observation_count bigint not null default 0,
  failed_checks bigint not null default 0,
  avg_check_latency_ms numeric,
  p95_check_latency_ms numeric,
  status text not null default 'unknown',
  primary key (server_id, bucket_at)
);

create table if not exists product_event_hourly (
  bucket_at timestamptz not null,
  event_type text not null,
  event_count bigint not null default 0,
  primary key (bucket_at, event_type)
);

create table if not exists moderation_reports (
  id text primary key,
  type text not null,
  reason text not null,
  reporter_peer_id text not null,
  reported_peer_id text not null,
  content_encrypted boolean not null default false,
  encrypted_content jsonb,
  client_created_at timestamptz,
  received_at timestamptz not null default now(),
  status text not null default 'pending',
  action text,
  action_note text,
  action_at timestamptz,
  appealed_at timestamptz,
  audit_history jsonb not null default '[]'::jsonb
);

create table if not exists moderation_peer_scores (
  peer_id text primary key,
  report_count integer not null default 0,
  reporter_count integer not null default 0,
  pending_count integer not null default 0,
  processed_count integer not null default 0,
  appealed_count integer not null default 0,
  policy_state text not null default 'clear',
  warning_issued_at timestamptz,
  banned_at timestamptz,
  last_report_at timestamptz,
  updated_at timestamptz not null default now()
);

alter table moderation_peer_scores
  add column if not exists reporter_count integer not null default 0;

create table if not exists moderation_appeals (
  id text primary key,
  peer_id text not null,
  text text not null,
  status text not null default 'open',
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolution_action text,
  resolution_note text,
  resolved_by text
);

alter table moderation_appeals
  add column if not exists resolution_action text,
  add column if not exists resolution_note text,
  add column if not exists resolved_by text;

create table if not exists peer_identity_bindings (
  peer_id text primary key,
  signing_pub text not null,
  identity_nonce text not null,
  schema_version integer not null,
  source text not null,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create table if not exists push_devices (
  user_id text not null,
  device_id text not null,
  message_token text,
  message_provider text not null default 'fcm',
  voip_token text,
  platform text not null,
  app_version text not null default '',
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  primary key (user_id, device_id)
);

alter table push_devices
  add column if not exists message_provider text not null default 'fcm',
  add column if not exists voip_token text,
  add column if not exists app_version text not null default '',
  add column if not exists enabled boolean not null default true,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now(),
  add column if not exists last_seen_at timestamptz not null default now();

update push_devices
set message_provider = 'apns',
    message_token = lower(message_token),
    updated_at = now()
where message_provider = 'fcm'
  and lower(platform) in ('ios', 'macos')
  and message_token ~* '^[0-9a-f]{64}$';

create table if not exists push_user_policy (
  user_id text primary key,
  allow_messages_only_from_contacts boolean not null default false,
  last_policy_sync_at timestamptz,
  policy_version bigint not null default 0,
  snapshot_hash text not null default '',
  updated_at timestamptz not null default now()
);

create table if not exists push_user_contacts (
  user_id text not null references push_user_policy(user_id) on delete cascade,
  contact_peer_id text not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, contact_peer_id)
);

create table if not exists push_user_blocked (
  user_id text not null references push_user_policy(user_id) on delete cascade,
  blocked_peer_id text not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, blocked_peer_id)
);

create index if not exists observed_servers_first_seen_idx on observed_servers(first_seen_at);
create index if not exists observed_servers_status_idx on observed_servers(status);
create index if not exists observed_servers_last_seen_idx on observed_servers(last_seen_at desc);
create index if not exists server_observations_time_idx on server_observations(observed_at desc);
create index if not exists server_observations_server_time_idx on server_observations(server_id, observed_at desc);
create index if not exists server_checks_server_time_idx on server_checks(server_id, checked_at desc);
create index if not exists server_usage_hourly_bucket_idx on server_usage_hourly(bucket_at desc);
create index if not exists server_usage_hourly_server_bucket_idx on server_usage_hourly(server_id, bucket_at desc);
create index if not exists product_event_hourly_bucket_idx on product_event_hourly(bucket_at desc);
create index if not exists moderation_reports_status_idx on moderation_reports(status);
create index if not exists moderation_reports_reported_peer_idx on moderation_reports(reported_peer_id, received_at desc);
create index if not exists moderation_peer_scores_state_idx on moderation_peer_scores(policy_state, report_count desc);
create index if not exists moderation_appeals_peer_idx on moderation_appeals(peer_id, created_at desc);
create index if not exists peer_identity_bindings_signing_pub_idx on peer_identity_bindings(signing_pub);
create index if not exists push_devices_created_at_idx on push_devices(created_at);
create index if not exists push_devices_user_created_at_idx on push_devices(user_id, created_at);
create index if not exists push_devices_enabled_user_idx on push_devices(enabled, user_id);
create unique index if not exists push_devices_message_token_idx on push_devices(message_token) where message_token is not null and enabled = true;
create unique index if not exists push_devices_voip_token_idx on push_devices(voip_token) where voip_token is not null and enabled = true;
create index if not exists push_user_policy_last_sync_idx on push_user_policy(last_policy_sync_at desc);
create index if not exists push_user_contacts_contact_idx on push_user_contacts(contact_peer_id);
create index if not exists push_user_blocked_blocked_idx on push_user_blocked(blocked_peer_id);
`;
