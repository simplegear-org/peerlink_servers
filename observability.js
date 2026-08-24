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
    this.moderationReports = new Map();
    this.moderationAppeals = new Map();
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

  hasModerationStorage() {
    return true;
  }

  async createModerationReport(report, thresholds) {
    if (this.dbReady) {
      const client = await this.pool.connect();
      try {
        await client.query('begin');
        const result = await client.query(
          `insert into moderation_reports
            (id, type, reason, reporter_peer_id, reported_peer_id, content_encrypted,
             encrypted_content, client_created_at, status, audit_history)
           values ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9)
           on conflict (id) do nothing
           returning *`,
          [
            report.id,
            report.type,
            report.reason,
            report.reporterPeerId,
            report.reportedPeerId,
            report.contentEncrypted,
            report.encryptedContent,
            report.clientCreatedAt,
            JSON.stringify([{ at: nowIso(), action: 'created', actor: 'client' }]),
          ],
        );
        const stored = result.rows[0] || (await client.query('select * from moderation_reports where id = $1', [report.id])).rows[0];
        const score = await refreshModerationPeerScore(client, report.reportedPeerId, thresholds);
        await client.query('commit');
        return { report: mapModerationReport(stored), score };
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    }

    if (!this.moderationReports.has(report.id)) {
      this.moderationReports.set(report.id, {
        ...report,
        receivedAt: nowIso(),
        status: 'pending',
        action: null,
        actionNote: null,
        actionAt: null,
        appealedAt: null,
        auditHistory: [{ at: nowIso(), action: 'created', actor: 'client' }],
      });
    }
    return {
      report: this.moderationReports.get(report.id),
      score: this.memoryModerationStatus(report.reportedPeerId, thresholds),
    };
  }

  async moderationStatus(peerId, thresholds) {
    if (this.dbReady) {
      const client = await this.pool.connect();
      try {
        return await refreshModerationPeerScore(client, peerId, thresholds);
      } finally {
        client.release();
      }
    }
    return this.memoryModerationStatus(peerId, thresholds);
  }

  memoryModerationStatus(peerId, thresholds = {}) {
    const reports = [...this.moderationReports.values()].filter((report) => report.reportedPeerId === peerId);
    const reportCount = reports.length;
    const policyState = moderationPolicyForCount(reportCount, thresholds);
    const lastReportAt = reports
      .map((report) => report.receivedAt)
      .filter(Boolean)
      .sort()
      .pop() || null;
    return {
      peerId,
      reportCount,
      pendingCount: reports.filter((report) => report.status === 'pending').length,
      processedCount: reports.filter((report) => ['resolved', 'rejected'].includes(report.status)).length,
      appealedCount: reports.filter((report) => report.status === 'appealed').length,
      policyState,
      warningIssuedAt: policyState === 'warning' || policyState === 'banned' ? lastReportAt : null,
      bannedAt: policyState === 'banned' ? lastReportAt : null,
      lastReportAt,
      updatedAt: nowIso(),
    };
  }

  async moderationSummary() {
    if (this.dbReady) {
      const result = await this.pool.query(
        `select
           count(*)::int as total,
           count(*) filter (where status = 'pending')::int as pending,
           count(*) filter (where status in ('resolved', 'rejected'))::int as processed,
           count(*) filter (where status = 'appealed')::int as appealed
         from moderation_reports`,
      );
      const peers = await this.pool.query(
        `select
           count(*) filter (where policy_state = 'warning')::int as warned_peers,
           count(*) filter (where policy_state = 'banned')::int as banned_peers
         from moderation_peer_scores`,
      );
      return { ...result.rows[0], ...peers.rows[0], remaining: result.rows[0].pending };
    }
    const reports = [...this.moderationReports.values()];
    const scores = new Map(reports.map((report) => [report.reportedPeerId, this.memoryModerationStatus(report.reportedPeerId)]));
    return {
      total: reports.length,
      pending: reports.filter((report) => report.status === 'pending').length,
      processed: reports.filter((report) => ['resolved', 'rejected'].includes(report.status)).length,
      appealed: reports.filter((report) => report.status === 'appealed').length,
      remaining: reports.filter((report) => report.status === 'pending').length,
      warned_peers: [...scores.values()].filter((score) => score.policyState === 'warning').length,
      banned_peers: [...scores.values()].filter((score) => score.policyState === 'banned').length,
    };
  }

  async listModerationReports({ status, reportedPeerId, limit = 100 } = {}) {
    if (this.dbReady) {
      const filters = [];
      const values = [];
      if (status && status !== 'all') {
        values.push(status);
        filters.push(`status = $${values.length}`);
      }
      if (reportedPeerId) {
        values.push(reportedPeerId);
        filters.push(`reported_peer_id = $${values.length}`);
      }
      values.push(limit);
      const where = filters.length ? `where ${filters.join(' and ')}` : '';
      const result = await this.pool.query(
        `select * from moderation_reports ${where} order by received_at desc limit $${values.length}`,
        values,
      );
      return result.rows.map(mapModerationReport);
    }
    return [...this.moderationReports.values()]
      .filter((report) => !status || status === 'all' || report.status === status)
      .filter((report) => !reportedPeerId || report.reportedPeerId === reportedPeerId)
      .sort((a, b) => String(b.receivedAt).localeCompare(String(a.receivedAt)))
      .slice(0, limit);
  }

  async listModerationPeerScores({ sort = 'report_count_desc', limit = 500, thresholds } = {}) {
    if (this.dbReady) {
      const orderBy = moderationScoreOrderBy(sort);
      const result = await this.pool.query(
        `select * from moderation_peer_scores order by ${orderBy} limit $1`,
        [limit],
      );
      return result.rows.map(mapModerationScore);
    }
    const peerIds = [...new Set([...this.moderationReports.values()].map((report) => report.reportedPeerId))];
    return peerIds
      .map((peerId) => this.memoryModerationStatus(peerId, thresholds))
      .sort((a, b) => compareModerationScores(a, b, sort))
      .slice(0, limit);
  }

  async recordModerationAction({ reportId, action, note, actor, thresholds }) {
    if (this.dbReady) {
      const client = await this.pool.connect();
      try {
        await client.query('begin');
        const current = await client.query('select * from moderation_reports where id = $1 for update', [reportId]);
        if (current.rows.length === 0) return null;
        const row = current.rows[0];
        const status = moderationStatusForAction(action);
        const audit = Array.isArray(row.audit_history) ? row.audit_history : [];
        audit.push({ at: nowIso(), action, actor, note: note || null });
        const updated = await client.query(
          `update moderation_reports set
             status = $2,
             action = $3,
             action_note = $4,
             action_at = now(),
             audit_history = $5
           where id = $1
           returning *`,
          [reportId, status, action, note || null, JSON.stringify(audit)],
        );
        let score = await refreshModerationPeerScore(client, row.reported_peer_id, thresholds);
        if (['warn', 'suspend', 'ban'].includes(action)) {
          score = await setModerationPeerPolicy(client, row.reported_peer_id, action, thresholds);
        }
        await client.query('commit');
        return { report: mapModerationReport(updated.rows[0]), score };
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    }

    const report = this.moderationReports.get(reportId);
    if (!report) return null;
    report.status = moderationStatusForAction(action);
    report.action = action;
    report.actionNote = note || null;
    report.actionAt = nowIso();
    report.auditHistory.push({ at: nowIso(), action, actor, note: note || null });
    return { report, score: this.memoryModerationStatus(report.reportedPeerId, thresholds) };
  }

  async createModerationAppeal({ peerId, text }) {
    const appeal = { id: cryptoRandomId(), peerId, text, status: 'open', createdAt: nowIso() };
    if (this.dbReady) {
      const result = await this.pool.query(
        `insert into moderation_appeals (id, peer_id, text, status)
         values ($1, $2, $3, 'open')
         returning *`,
        [appeal.id, peerId, text],
      );
      await this.pool.query(
        `update moderation_reports set status = 'appealed', appealed_at = now()
         where reported_peer_id = $1 and status in ('pending', 'resolved')`,
        [peerId],
      );
      return mapModerationAppeal(result.rows[0]);
    }
    this.moderationAppeals.set(appeal.id, appeal);
    for (const report of this.moderationReports.values()) {
      if (report.reportedPeerId === peerId && ['pending', 'resolved'].includes(report.status)) {
        report.status = 'appealed';
        report.appealedAt = nowIso();
      }
    }
    return appeal;
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
        const moderation = await this.pool.query(
          `select
             count(*)::int as total,
             count(*) filter (where status = 'pending')::int as pending,
             count(*) filter (where status in ('resolved', 'rejected'))::int as processed
           from moderation_reports`,
        );
        lines.push('# HELP peerlink_moderation_reports Reports by processing state.');
        lines.push('# TYPE peerlink_moderation_reports gauge');
        const moderationRow = moderation.rows[0] || {};
        lines.push(metricLine('peerlink_moderation_reports', { state: 'total' }, moderationRow.total || 0));
        lines.push(metricLine('peerlink_moderation_reports', { state: 'pending' }, moderationRow.pending || 0));
        lines.push(metricLine('peerlink_moderation_reports', { state: 'processed' }, moderationRow.processed || 0));
      } catch (error) {
        lines.push(metricLine('peerlink_push_observability_postgres_query_error', {}, 1));
      }
    }
    return `${lines.join('\n')}\n`;
  }
}

function moderationStatusForAction(action) {
  if (action === 'reject' || action === 'ignore') return 'rejected';
  return 'resolved';
}

function moderationPolicyForCount(reportCount, thresholds = {}) {
  const warningThreshold = thresholds.warningThreshold || 10;
  const banThreshold = thresholds.banThreshold || 20;
  if (reportCount >= banThreshold) return 'banned';
  if (reportCount >= warningThreshold) return 'warning';
  return 'clear';
}

async function refreshModerationPeerScore(client, peerId, thresholds = {}) {
  const stats = await client.query(
    `select
       count(*)::int as report_count,
       count(*) filter (where status = 'pending')::int as pending_count,
       count(*) filter (where status in ('resolved', 'rejected'))::int as processed_count,
       count(*) filter (where status = 'appealed')::int as appealed_count,
       max(received_at) as last_report_at
     from moderation_reports
     where reported_peer_id = $1`,
    [peerId],
  );
  const row = stats.rows[0] || {};
  const reportCount = Number(row.report_count || 0);
  const policyState = moderationPolicyForCount(reportCount, thresholds);
  const result = await client.query(
    `insert into moderation_peer_scores
       (peer_id, report_count, pending_count, processed_count, appealed_count,
        policy_state, warning_issued_at, banned_at, last_report_at, updated_at)
     values (
       $1, $2, $3, $4, $5, $6,
       case when $6 in ('warning', 'banned') then now() else null end,
       case when $6 = 'banned' then now() else null end,
       $7, now()
     )
     on conflict (peer_id) do update set
       report_count = excluded.report_count,
       pending_count = excluded.pending_count,
       processed_count = excluded.processed_count,
       appealed_count = excluded.appealed_count,
       policy_state = case
         when moderation_peer_scores.policy_state = 'banned' then 'banned'
         when excluded.policy_state = 'banned' then 'banned'
         when moderation_peer_scores.policy_state = 'warning' then 'warning'
         else excluded.policy_state
       end,
       warning_issued_at = case
         when excluded.policy_state in ('warning', 'banned') then coalesce(moderation_peer_scores.warning_issued_at, now())
         else moderation_peer_scores.warning_issued_at
       end,
       banned_at = case
         when excluded.policy_state = 'banned' then coalesce(moderation_peer_scores.banned_at, now())
         else moderation_peer_scores.banned_at
       end,
       last_report_at = excluded.last_report_at,
       updated_at = now()
     returning *`,
    [
      peerId,
      reportCount,
      Number(row.pending_count || 0),
      Number(row.processed_count || 0),
      Number(row.appealed_count || 0),
      policyState,
      row.last_report_at,
    ],
  );
  return mapModerationScore(result.rows[0]);
}

async function setModerationPeerPolicy(client, peerId, action, thresholds = {}) {
  const policyState = action === 'ban' ? 'banned' : 'warning';
  await refreshModerationPeerScore(client, peerId, thresholds);
  const result = await client.query(
    `update moderation_peer_scores set
       policy_state = $2,
       warning_issued_at = coalesce(warning_issued_at, now()),
       banned_at = case when $2 = 'banned' then coalesce(banned_at, now()) else banned_at end,
       updated_at = now()
     where peer_id = $1
     returning *`,
    [peerId, policyState],
  );
  return mapModerationScore(result.rows[0]);
}

function moderationScoreOrderBy(sort) {
  if (sort === 'pending_desc') return 'pending_count desc, report_count desc, last_report_at desc nulls last';
  if (sort === 'state_desc') return "case policy_state when 'banned' then 3 when 'warning' then 2 else 1 end desc, report_count desc";
  if (sort === 'last_report_desc') return 'last_report_at desc nulls last, report_count desc';
  return 'report_count desc, last_report_at desc nulls last';
}

function compareModerationScores(a, b, sort) {
  if (sort === 'pending_desc') return (b.pendingCount - a.pendingCount) || (b.reportCount - a.reportCount);
  if (sort === 'state_desc') {
    const rank = { banned: 3, warning: 2, clear: 1 };
    return (rank[b.policyState] - rank[a.policyState]) || (b.reportCount - a.reportCount);
  }
  if (sort === 'last_report_desc') return String(b.lastReportAt || '').localeCompare(String(a.lastReportAt || ''));
  return (b.reportCount - a.reportCount) || String(b.lastReportAt || '').localeCompare(String(a.lastReportAt || ''));
}

function mapModerationReport(row) {
  return {
    id: row.id,
    type: row.type,
    reason: row.reason,
    reporterPeerId: row.reporter_peer_id,
    reportedPeerId: row.reported_peer_id,
    contentEncrypted: row.content_encrypted,
    encryptedContent: row.encrypted_content,
    clientCreatedAt: row.client_created_at,
    receivedAt: row.received_at,
    status: row.status,
    action: row.action,
    actionNote: row.action_note,
    actionAt: row.action_at,
    appealedAt: row.appealed_at,
    auditHistory: row.audit_history || [],
  };
}

function mapModerationScore(row) {
  return {
    peerId: row.peer_id,
    reportCount: Number(row.report_count || 0),
    pendingCount: Number(row.pending_count || 0),
    processedCount: Number(row.processed_count || 0),
    appealedCount: Number(row.appealed_count || 0),
    policyState: row.policy_state || 'clear',
    warningIssuedAt: row.warning_issued_at,
    bannedAt: row.banned_at,
    lastReportAt: row.last_report_at,
    updatedAt: row.updated_at,
  };
}

function mapModerationAppeal(row) {
  return {
    id: row.id,
    peerId: row.peer_id,
    text: row.text,
    status: row.status,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}

function cryptoRandomId() {
  return `mod_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
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
  pending_count integer not null default 0,
  processed_count integer not null default 0,
  appealed_count integer not null default 0,
  policy_state text not null default 'clear',
  warning_issued_at timestamptz,
  banned_at timestamptz,
  last_report_at timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists moderation_appeals (
  id text primary key,
  peer_id text not null,
  text text not null,
  status text not null default 'open',
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

create index if not exists observed_servers_status_idx on observed_servers(status);
create index if not exists observed_servers_last_seen_idx on observed_servers(last_seen_at desc);
create index if not exists server_observations_server_time_idx on server_observations(server_id, observed_at desc);
create index if not exists server_usage_hourly_bucket_idx on server_usage_hourly(bucket_at desc);
create index if not exists moderation_reports_status_idx on moderation_reports(status);
create index if not exists moderation_reports_reported_peer_idx on moderation_reports(reported_peer_id, received_at desc);
create index if not exists moderation_peer_scores_state_idx on moderation_peer_scores(policy_state, report_count desc);
create index if not exists moderation_appeals_peer_idx on moderation_appeals(peer_id, created_at desc);
`;
