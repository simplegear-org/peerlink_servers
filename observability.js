// SPDX-License-Identifier: AGPL-3.0-only

const DEFAULT_CHECK_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_CHECK_TIMEOUT_MS = 5_000;

function nowIso() {
  return new Date().toISOString();
}

function normalizeEventType(value) {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!raw) return 'unknown';
  if (raw.includes('call')) return 'call';
  if (raw.includes('message') || raw.includes('direct')) return 'message';
  if (raw.includes('group')) return 'group';
  return raw.replace(/[^a-z0-9_:-]/g, '_').slice(0, 64) || 'unknown';
}

function parseMaybeJson(value) {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch (_) {
    return trimmed;
  }
}

function collectServerCandidates(value, out = []) {
  const parsed = parseMaybeJson(value);
  if (!parsed) return out;
  if (typeof parsed === 'string') {
    out.push(parsed);
    return out;
  }
  if (Array.isArray(parsed)) {
    for (const item of parsed) collectServerCandidates(item, out);
    return out;
  }
  if (typeof parsed === 'object') {
    for (const key of ['url', 'uri', 'endpoint', 'signal', 'relay', 'turn', 'turns', 'host']) {
      if (parsed[key]) collectServerCandidates(parsed[key], out);
    }
    for (const key of ['servers', 'signalServers', 'relayServers', 'turnServers', 'iceServers', 'urls']) {
      if (parsed[key]) collectServerCandidates(parsed[key], out);
    }
  }
  return out;
}

function normalizeServerUrl(input) {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed || trimmed.length > 2048) return null;
  try {
    const turnMatch = trimmed.match(/^(turns?):([^/?#]+)(.*)$/i);
    const withScheme = turnMatch && !trimmed.includes('://')
      ? `${turnMatch[1].toLowerCase()}://${turnMatch[2]}${turnMatch[3] || ''}`
      : /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
      ? trimmed
      : `https://${trimmed}`;
    const url = new URL(withScheme);
    const scheme = url.protocol.replace(':', '').toLowerCase();
    if (!['http', 'https', 'ws', 'wss', 'turn', 'turns'].includes(scheme)) return null;
    const host = url.hostname.toLowerCase();
    if (!host || host === 'localhost' || host === '127.0.0.1' || host === '::1') return null;
    const defaultPort = scheme === 'wss' ? '443'
      : scheme === 'https' ? '443'
        : scheme === 'ws' ? '80'
          : scheme === 'http' ? '80'
            : scheme === 'turns' ? '5349'
              : '3478';
    const port = url.port || defaultPort;
    return {
      normalizedUrl: `${scheme}://${host}:${port}${url.pathname === '/' ? '' : url.pathname}`,
      scheme,
      host,
      port: Number.parseInt(port, 10),
    };
  } catch (_) {
    return null;
  }
}

export function extractServersFromPayload(payload) {
  const source = payload && typeof payload === 'object' ? payload : {};
  const candidates = [
    ...collectServerCandidates(source.servers),
    ...collectServerCandidates(source.signalServers),
    ...collectServerCandidates(source.relayServers),
    ...collectServerCandidates(source.turnServers),
    ...collectServerCandidates(source.iceServers),
  ];
  const byUrl = new Map();
  for (const candidate of candidates) {
    const normalized = normalizeServerUrl(candidate);
    if (normalized) byUrl.set(normalized.normalizedUrl, normalized);
  }
  return [...byUrl.values()];
}

function escapeLabel(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

function metricLine(name, labels, value) {
  const labelEntries = Object.entries(labels || {}).filter(([, item]) => item !== undefined && item !== null);
  const suffix = labelEntries.length
    ? `{${labelEntries.map(([key, item]) => `${key}="${escapeLabel(item)}"`).join(',')}}`
    : '';
  return `${name}${suffix} ${Number.isFinite(value) ? value : 0}`;
}

class CounterMap {
  constructor() {
    this.values = new Map();
  }

  inc(labels, delta = 1) {
    const key = JSON.stringify(labels || {});
    this.values.set(key, (this.values.get(key) || 0) + delta);
  }

  lines(name) {
    return [...this.values.entries()].map(([key, value]) => metricLine(name, JSON.parse(key), value));
  }
}

export class PushObservability {
  constructor(env = process.env) {
    this.env = env;
    this.databaseUrl = (env.PUSH_OBSERVABILITY_DATABASE_URL || env.DATABASE_URL || '').trim();
    this.dbReady = false;
    this.dbError = null;
    this.pool = null;
    this.events = new CounterMap();
    this.sent = new CounterMap();
    this.failed = new CounterMap();
    this.deduped = new CounterMap();
    this.registers = new CounterMap();
    this.unregisters = new CounterMap();
    this.observedServers = new Map();
  }

  async init() {
    if (!this.databaseUrl) return;
    const attempts = Number.parseInt(this.env.PUSH_OBSERVABILITY_DB_INIT_ATTEMPTS || '20', 10);
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const pg = await import('pg');
        this.pool = new pg.Pool({ connectionString: this.databaseUrl });
        await this.pool.query(SCHEMA_SQL);
        this.dbReady = true;
        console.log('[push][observability] postgres enabled');
        return;
      } catch (error) {
        this.dbError = error instanceof Error ? error.message : String(error);
        if (this.pool) {
          await this.pool.end().catch(() => {});
          this.pool = null;
        }
        if (attempt >= attempts) {
          console.warn('[push][observability] postgres disabled:', this.dbError);
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }

  recordDeviceRegister({ platform, messageProvider }) {
    this.registers.inc({ platform: platform || 'unknown', provider: messageProvider || 'unknown' });
  }

  recordDeviceUnregister({ platform = 'unknown', messageProvider = 'unknown' } = {}) {
    this.unregisters.inc({ platform, provider: messageProvider });
  }

  recordPushEvent({ payload, delivery, deduped = false }) {
    const eventType = normalizeEventType(payload?.type);
    if (deduped) {
      this.deduped.inc({ event_type: eventType });
      return;
    }
    this.events.inc({ event_type: eventType });
    const servers = extractServersFromPayload(payload);
    for (const server of servers) {
      const existing = this.observedServers.get(server.normalizedUrl) || {
        ...server,
        firstSeenAt: nowIso(),
        lastSeenAt: nowIso(),
        seenCount: 0,
        messageSeenCount: 0,
        callSeenCount: 0,
      };
      existing.lastSeenAt = nowIso();
      existing.seenCount += 1;
      if (eventType === 'call') existing.callSeenCount += 1;
      if (eventType === 'message' || eventType === 'group') existing.messageSeenCount += 1;
      this.observedServers.set(server.normalizedUrl, existing);
    }
    if (this.dbReady && servers.length > 0) {
      this.persistObservedServers({ servers, eventType, delivery }).catch((error) => {
        console.warn('[push][observability] persist failed:', error instanceof Error ? error.message : String(error));
      });
    }
  }

  recordPushResult({ payload, deliveryName, provider, sent, failed }) {
    const eventType = normalizeEventType(payload?.type);
    if (sent > 0) this.sent.inc({ event_type: eventType, delivery: deliveryName, provider }, sent);
    if (failed > 0) this.failed.inc({ event_type: eventType, delivery: deliveryName, provider, reason: 'send_failed' }, failed);
  }

  async persistObservedServers({ servers, eventType }) {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      for (const server of servers) {
        const result = await client.query(
          `insert into observed_servers
            (normalized_url, scheme, host, port, first_seen_at, last_seen_at, seen_count,
             message_seen_count, call_seen_count, last_event_type)
           values ($1, $2, $3, $4, now(), now(), 1,
             case when $5 in ('message', 'group') then 1 else 0 end,
             case when $5 = 'call' then 1 else 0 end,
             $5)
           on conflict (normalized_url) do update set
             last_seen_at = now(),
             seen_count = observed_servers.seen_count + 1,
             message_seen_count = observed_servers.message_seen_count + case when $5 in ('message', 'group') then 1 else 0 end,
             call_seen_count = observed_servers.call_seen_count + case when $5 = 'call' then 1 else 0 end,
             last_event_type = $5
           returning id`,
          [server.normalizedUrl, server.scheme, server.host, server.port, eventType],
        );
        const serverId = result.rows[0].id;
        await client.query(
          `insert into server_observations (server_id, event_type, observed_at)
           values ($1, $2, now())`,
          [serverId, eventType],
        );
        await client.query(
          `insert into server_usage_hourly
            (server_id, bucket_at, message_count, call_count, observation_count)
           values ($1, date_trunc('hour', now()),
             case when $2 in ('message', 'group') then 1 else 0 end,
             case when $2 = 'call' then 1 else 0 end,
             1)
           on conflict (server_id, bucket_at) do update set
             message_count = server_usage_hourly.message_count + excluded.message_count,
             call_count = server_usage_hourly.call_count + excluded.call_count,
             observation_count = server_usage_hourly.observation_count + 1`,
          [serverId, eventType],
        );
      }
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  async metrics({ devicesByUser, tokenToOwner, voipDevicesByUser, voipTokenToOwner, dedupCache, signedRequestIds }) {
    const lines = [
      '# HELP peerlink_push_registered_users Registered users with message devices.',
      '# TYPE peerlink_push_registered_users gauge',
      metricLine('peerlink_push_registered_users', {}, devicesByUser.size),
      '# HELP peerlink_push_registered_devices Registered message device tokens.',
      '# TYPE peerlink_push_registered_devices gauge',
      metricLine('peerlink_push_registered_devices', {}, tokenToOwner.size),
      '# HELP peerlink_push_registered_voip_devices Registered VoIP device tokens.',
      '# TYPE peerlink_push_registered_voip_devices gauge',
      metricLine('peerlink_push_registered_voip_devices', {}, voipTokenToOwner.size),
      '# HELP peerlink_push_dedup_cache_entries Current dedup cache size.',
      '# TYPE peerlink_push_dedup_cache_entries gauge',
      metricLine('peerlink_push_dedup_cache_entries', {}, dedupCache.size),
      '# HELP peerlink_push_replay_cache_entries Current signed request replay cache size.',
      '# TYPE peerlink_push_replay_cache_entries gauge',
      metricLine('peerlink_push_replay_cache_entries', {}, signedRequestIds.size),
      '# HELP peerlink_push_device_register_total Device register calls.',
      '# TYPE peerlink_push_device_register_total counter',
      ...this.registers.lines('peerlink_push_device_register_total'),
      '# HELP peerlink_push_device_unregister_total Device unregister calls.',
      '# TYPE peerlink_push_device_unregister_total counter',
      ...this.unregisters.lines('peerlink_push_device_unregister_total'),
      '# HELP peerlink_push_events_total Push events accepted.',
      '# TYPE peerlink_push_events_total counter',
      ...this.events.lines('peerlink_push_events_total'),
      '# HELP peerlink_push_sent_total Push deliveries sent.',
      '# TYPE peerlink_push_sent_total counter',
      ...this.sent.lines('peerlink_push_sent_total'),
      '# HELP peerlink_push_failed_total Push deliveries failed.',
      '# TYPE peerlink_push_failed_total counter',
      ...this.failed.lines('peerlink_push_failed_total'),
      '# HELP peerlink_push_deduped_total Push events deduped.',
      '# TYPE peerlink_push_deduped_total counter',
      ...this.deduped.lines('peerlink_push_deduped_total'),
      '# HELP peerlink_observed_servers_total Servers observed in push payloads.',
      '# TYPE peerlink_observed_servers_total gauge',
      metricLine('peerlink_observed_servers_total', {}, this.observedServers.size),
      '# HELP peerlink_push_observability_postgres_up Postgres observability state.',
      '# TYPE peerlink_push_observability_postgres_up gauge',
      metricLine('peerlink_push_observability_postgres_up', {}, this.dbReady ? 1 : 0),
    ];
    for (const [labels, value] of aggregateDevices(devicesByUser, (device) => ({
      platform: device.platform || 'unknown',
      provider: device.messageProvider || 'unknown',
    })).entries()) {
      lines.push(metricLine('peerlink_push_registered_devices_by_platform', JSON.parse(labels), value));
    }
    for (const [labels, value] of aggregateDevices(voipDevicesByUser, (device) => ({
      platform: device.platform || 'unknown',
    })).entries()) {
      lines.push(metricLine('peerlink_push_registered_voip_devices_by_platform', JSON.parse(labels), value));
    }
    if (this.dbReady) {
      try {
        const result = await this.pool.query(
          `select status, count(*)::int as count
           from observed_servers
           group by status`,
        );
        lines.push('# HELP peerlink_observed_servers_by_status Servers by latest checker status.');
        lines.push('# TYPE peerlink_observed_servers_by_status gauge');
        for (const row of result.rows) {
          lines.push(metricLine('peerlink_observed_servers_by_status', { status: row.status }, row.count));
        }
      } catch (error) {
        lines.push(metricLine('peerlink_push_observability_postgres_query_error', {}, 1));
      }
    }
    return `${lines.join('\n')}\n`;
  }
}

function aggregateDevices(devicesByUser, labelsFor) {
  const values = new Map();
  for (const device of iterEnabledDevices(devicesByUser)) {
    const key = JSON.stringify(labelsFor(device));
    values.set(key, (values.get(key) || 0) + 1);
  }
  return values;
}

function* iterEnabledDevices(devicesByUser) {
  for (const devices of devicesByUser.values()) {
    for (const device of devices.values()) {
      if (device.enabled) yield device;
    }
  }
}

export async function runServerChecker(env = process.env) {
  const databaseUrl = (env.PUSH_OBSERVABILITY_DATABASE_URL || env.DATABASE_URL || '').trim();
  if (!databaseUrl) throw new Error('PUSH_OBSERVABILITY_DATABASE_URL is required');
  const pg = await import('pg');
  const pool = new pg.Pool({ connectionString: databaseUrl });
  await pool.query(SCHEMA_SQL);
  const intervalMs = Number.parseInt(env.PEERLINK_SERVER_CHECK_INTERVAL_MS || '', 10) || DEFAULT_CHECK_INTERVAL_MS;
  const timeoutMs = Number.parseInt(env.PEERLINK_SERVER_CHECK_TIMEOUT_MS || '', 10) || DEFAULT_CHECK_TIMEOUT_MS;

  async function tick() {
    const result = await pool.query(
      `select id, normalized_url, scheme, host, port
       from observed_servers
       where last_checked_at is null
          or last_checked_at < now() - ($1::int * interval '1 second')
       order by coalesce(last_checked_at, 'epoch'::timestamptz), last_seen_at desc
       limit 50`,
      [Math.max(30, Math.floor(intervalMs / 1000))],
    );
    for (const row of result.rows) {
      const startedAt = Date.now();
      const check = await checkServer(row, timeoutMs);
      const latencyMs = Date.now() - startedAt;
      await pool.query(
        `update observed_servers set
           status = $2,
           last_checked_at = now(),
           last_error = $3,
           capabilities_json = $4,
           last_check_latency_ms = $5
         where id = $1`,
        [row.id, check.status, check.error, check.capabilities, latencyMs],
      );
      await pool.query(
        `insert into server_checks (server_id, checked_at, status, latency_ms, error)
         values ($1, now(), $2, $3, $4)`,
        [row.id, check.status, latencyMs, check.error],
      );
      await pool.query(
        `insert into server_usage_hourly
          (server_id, bucket_at, failed_checks, avg_check_latency_ms, p95_check_latency_ms, status)
         values ($1, date_trunc('hour', now()), case when $2 in ('healthy', 'degraded') then 0 else 1 end, $3, $3, $2)
         on conflict (server_id, bucket_at) do update set
           failed_checks = server_usage_hourly.failed_checks + excluded.failed_checks,
           avg_check_latency_ms = coalesce((server_usage_hourly.avg_check_latency_ms + excluded.avg_check_latency_ms) / 2, excluded.avg_check_latency_ms),
           p95_check_latency_ms = greatest(coalesce(server_usage_hourly.p95_check_latency_ms, 0), excluded.p95_check_latency_ms),
           status = excluded.status`,
        [row.id, check.status, latencyMs],
      );
      console.log('[server-checker] checked', row.normalized_url, check.status, latencyMs, check.error || '');
    }
  }

  await tick();
  setInterval(() => {
    tick().catch((error) => {
      console.warn('[server-checker] tick failed:', error instanceof Error ? error.message : String(error));
    });
  }, intervalMs);
}

async function checkServer(row, timeoutMs) {
  if (row.scheme === 'turn' || row.scheme === 'turns') {
    return checkTcp(row.host, row.port, timeoutMs);
  }
  const baseScheme = row.scheme === 'ws' || row.scheme === 'wss'
    ? (row.scheme === 'wss' ? 'https' : 'http')
    : row.scheme;
  const baseUrl = `${baseScheme}://${row.host}:${row.port}`;
  try {
    const capabilities = await fetchJson(`${baseUrl}/relay/capabilities`, timeoutMs);
    return { status: 'healthy', error: null, capabilities };
  } catch (capabilitiesError) {
    try {
      await fetchJson(`${baseUrl}/health`, timeoutMs);
      return {
        status: 'degraded',
        error: capabilitiesError instanceof Error ? capabilitiesError.message.slice(0, 512) : String(capabilitiesError).slice(0, 512),
        capabilities: null,
      };
    } catch (healthError) {
      return {
        status: classifyCheckError(healthError),
        error: healthError instanceof Error ? healthError.message.slice(0, 512) : String(healthError).slice(0, 512),
        capabilities: null,
      };
    }
  }
}

async function fetchJson(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`http_${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function checkTcp(host, port, timeoutMs) {
  const net = await import('node:net');
  return await new Promise((resolve) => {
    const socket = net.createConnection({ host, port, timeout: timeoutMs });
    socket.once('connect', () => {
      socket.destroy();
      resolve({ status: 'healthy', error: null, capabilities: null });
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve({ status: 'blocked', error: 'tcp_timeout', capabilities: null });
    });
    socket.once('error', (error) => {
      socket.destroy();
      resolve({ status: classifyCheckError(error), error: error.message.slice(0, 512), capabilities: null });
    });
  });
}

function classifyCheckError(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('timeout') || message.includes('aborted') || message.includes('AbortError')) return 'blocked';
  if (message.includes('ENOTFOUND') || message.includes('ECONNREFUSED')) return 'dead';
  return 'dead';
}

const SCHEMA_SQL = `
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

create index if not exists observed_servers_status_idx on observed_servers(status);
create index if not exists observed_servers_last_seen_idx on observed_servers(last_seen_at desc);
create index if not exists server_observations_server_time_idx on server_observations(server_id, observed_at desc);
create index if not exists server_usage_hourly_bucket_idx on server_usage_hourly(bucket_at desc);
`;
