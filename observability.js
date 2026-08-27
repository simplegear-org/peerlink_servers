// SPDX-License-Identifier: AGPL-3.0-only

import { buildPushMetrics, CounterMap } from './observability/metrics.js';
import {
  compareModerationScores,
  cryptoRandomId,
  mapModerationAppeal,
  mapModerationReport,
  mapModerationReportAggregate,
  mapModerationScore,
  mapPeerIdentityBinding,
  moderationScoreOrderBy,
  refreshModerationPeerScore,
  setModerationPeerPolicy,
} from './observability/moderation-helpers.js';
import {
  extractServersFromPayload,
  normalizeEventType,
} from './observability/server-discovery.js';
import { runObservedServerChecker } from './observability/server-checker.js';

export { extractServersFromPayload } from './observability/server-discovery.js';

const DEFAULT_CHECK_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_CHECK_TIMEOUT_MS = 5_000;

function nowIso() {
  return new Date().toISOString();
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
    this.moderationPeerPolicies = new Map();
    this.peerIdentityBindings = new Map();
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

  async peerIdentityBinding(peerId) {
    if (this.dbReady) {
      const result = await this.pool.query(
        `select * from peer_identity_bindings where peer_id = $1`,
        [peerId],
      );
      return result.rows[0] ? mapPeerIdentityBinding(result.rows[0]) : null;
    }
    return this.peerIdentityBindings.get(peerId) || null;
  }

  async upsertPeerIdentityBinding(binding) {
    if (this.dbReady) {
      const result = await this.pool.query(
        `insert into peer_identity_bindings
          (peer_id, signing_pub, identity_nonce, schema_version, source, first_seen_at, last_seen_at)
         values ($1, $2, $3, $4, $5, now(), now())
         on conflict (peer_id) do update set
           last_seen_at = now(),
           source = excluded.source
         where peer_identity_bindings.signing_pub = excluded.signing_pub
         returning *`,
        [
          binding.peerId,
          binding.signingPub,
          binding.identityNonce,
          binding.schemaVersion,
          binding.source,
        ],
      );
      return result.rows[0] ? mapPeerIdentityBinding(result.rows[0]) : null;
    }
    const existing = this.peerIdentityBindings.get(binding.peerId);
    const now = new Date().toISOString();
    const stored = {
      ...binding,
      firstSeenAt: existing?.firstSeenAt || now,
      lastSeenAt: now,
    };
    this.peerIdentityBindings.set(binding.peerId, stored);
    return stored;
  }

  async peerIdentityBindingCount() {
    if (this.dbReady) {
      const result = await this.pool.query(
        `select count(*)::int as count from peer_identity_bindings`,
      );
      return Number(result.rows[0]?.count || 0);
    }
    return this.peerIdentityBindings.size;
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

  async createModerationReport(report) {
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
        const score = await refreshModerationPeerScore(client, report.reportedPeerId);
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
      score: this.memoryModerationStatus(report.reportedPeerId),
    };
  }

  async moderationStatus(peerId) {
    if (this.dbReady) {
      const client = await this.pool.connect();
      try {
        return await refreshModerationPeerScore(client, peerId);
      } finally {
        client.release();
      }
    }
    return this.memoryModerationStatus(peerId);
  }

  async isPeerBanned(peerId) {
    if (!peerId) return false;
    if (this.dbReady) {
      const result = await this.pool.query(
        `select policy_state from moderation_peer_scores where peer_id = $1`,
        [peerId],
      );
      return result.rows[0]?.policy_state === 'banned';
    }
    return this.moderationPeerPolicies.get(peerId)?.policyState === 'banned';
  }

  async filterAllowedPeers(peerIds) {
    const uniquePeerIds = [...new Set(peerIds.filter(Boolean))];
    const banned = new Set();
    for (const peerId of uniquePeerIds) {
      if (await this.isPeerBanned(peerId)) {
        banned.add(peerId);
      }
    }
    return {
      allowed: uniquePeerIds.filter((peerId) => !banned.has(peerId)),
      banned: [...banned],
    };
  }

  memoryModerationStatus(peerId) {
    const reports = [...this.moderationReports.values()].filter((report) => report.reportedPeerId === peerId);
    const reportCount = reports.length;
    const reporterCount = new Set(reports.map((report) => report.reporterPeerId).filter(Boolean)).size;
    const policy = this.moderationPeerPolicies.get(peerId);
    const lastReportAt = reports
      .map((report) => report.receivedAt)
      .filter(Boolean)
      .sort()
      .pop() || null;
    return {
      peerId,
      reportCount,
      reporterCount,
      pendingCount: reports.length,
      processedCount: 0,
      appealedCount: 0,
      policyState: policy?.policyState || 'clear',
      warningIssuedAt: policy?.warningIssuedAt || null,
      bannedAt: policy?.bannedAt || null,
      lastReportAt,
      updatedAt: nowIso(),
    };
  }

  async moderationSummary() {
    if (this.dbReady) {
      const result = await this.pool.query(
        `select
           count(*)::int as total,
           count(*)::int as pending,
           0::int as processed,
           0::int as appealed
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
      pending: reports.length,
      processed: 0,
      appealed: 0,
      remaining: reports.length,
      warned_peers: [...scores.values()].filter((score) => score.policyState === 'warning').length,
      banned_peers: [...scores.values()].filter((score) => score.policyState === 'banned').length,
    };
  }

  async listModerationReports({ status, reportedPeerId, limit = 100 } = {}) {
    if (this.dbReady) {
      const filters = [];
      const values = [];
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
      .filter((report) => !reportedPeerId || report.reportedPeerId === reportedPeerId)
      .sort((a, b) => String(b.receivedAt).localeCompare(String(a.receivedAt)))
      .slice(0, limit);
  }

  async listModerationPeerScores({ sort = 'report_count_desc', limit = 500 } = {}) {
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
      .map((peerId) => this.memoryModerationStatus(peerId))
      .sort((a, b) => compareModerationScores(a, b, sort))
      .slice(0, limit);
  }

  async listModerationReportAggregates({ role = 'reported', limit = 500 } = {}) {
    const peerColumn = role === 'reporter' ? 'reporter_peer_id' : 'reported_peer_id';
    const distinctCounterColumn = role === 'reporter' ? 'reported_peer_id' : 'reporter_peer_id';
    if (this.dbReady) {
      const result = await this.pool.query(
        `select
           ${peerColumn} as peer_id,
           count(*)::int as report_count,
           count(distinct ${distinctCounterColumn})::int as reporter_count,
           count(*) filter (where type = 'direct_report')::int as direct_count,
           count(*) filter (where type = 'group_report')::int as group_count,
           max(received_at) as last_report_at
         from moderation_reports
         group by ${peerColumn}
         order by report_count desc, last_report_at desc nulls last
         limit $1`,
        [limit],
      );
      return result.rows.map(mapModerationReportAggregate);
    }
    const byPeer = new Map();
    for (const report of this.moderationReports.values()) {
      const peerId = role === 'reporter' ? report.reporterPeerId : report.reportedPeerId;
      const current = byPeer.get(peerId) || {
        peerId,
        reportCount: 0,
        directCount: 0,
        groupCount: 0,
        reporterCount: 0,
        lastReportAt: null,
        distinctCounter: new Set(),
      };
      current.reportCount += 1;
      current.distinctCounter.add(role === 'reporter' ? report.reportedPeerId : report.reporterPeerId);
      if (report.type === 'group_report') current.groupCount += 1;
      else current.directCount += 1;
      if (!current.lastReportAt || String(report.receivedAt).localeCompare(String(current.lastReportAt)) > 0) {
        current.lastReportAt = report.receivedAt;
      }
      byPeer.set(peerId, current);
    }
    return [...byPeer.values()]
      .map((item) => {
        item.reporterCount = item.distinctCounter.size;
        delete item.distinctCounter;
        return item;
      })
      .sort((a, b) => b.reportCount - a.reportCount || String(b.lastReportAt).localeCompare(String(a.lastReportAt)))
      .slice(0, limit);
  }

  async recordModerationAction({ reportId, action, note, actor }) {
    if (this.dbReady) {
      const client = await this.pool.connect();
      try {
        await client.query('begin');
        const current = await client.query('select * from moderation_reports where id = $1 for update', [reportId]);
        if (current.rows.length === 0) {
          await client.query('rollback');
          return null;
        }
        const row = current.rows[0];
        const audit = Array.isArray(row.audit_history) ? row.audit_history : [];
        audit.push({ at: nowIso(), action, actor, note: note || null });
        const updated = await client.query(
          `update moderation_reports set
             action = $2,
             action_note = $3,
             action_at = now(),
             audit_history = $4
           where id = $1
           returning *`,
          [reportId, action, note || null, JSON.stringify(audit)],
        );
        let score = await refreshModerationPeerScore(client, row.reported_peer_id);
        score = await setModerationPeerPolicy(client, row.reported_peer_id, action);
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
    report.action = action;
    report.actionNote = note || null;
    report.actionAt = nowIso();
    report.auditHistory.push({ at: nowIso(), action, actor, note: note || null });
    return { report, score: this.recordMemoryPeerPolicy(report.reportedPeerId, action) };
  }

  async recordModerationPeerAction({ peerId, action, note, actor }) {
    if (this.dbReady) {
      const client = await this.pool.connect();
      try {
        await client.query('begin');
        const score = await setModerationPeerPolicy(client, peerId, action);
        const audit = { at: nowIso(), action, actor, note: note || null };
        await client.query(
          `update moderation_reports set
             action = $2,
             action_note = $3,
             action_at = now(),
             audit_history = coalesce(audit_history, '[]'::jsonb) || $4::jsonb
           where reported_peer_id = $1`,
          [peerId, action, note || null, JSON.stringify([audit])],
        );
        await client.query('commit');
        return score;
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    }
    return this.recordMemoryPeerPolicy(peerId, action);
  }

  recordMemoryPeerPolicy(peerId, action) {
    const current = this.memoryModerationStatus(peerId);
    if (action === 'unban') {
      const next = {
        policyState: 'clear',
        warningIssuedAt: null,
        bannedAt: null,
      };
      this.moderationPeerPolicies.set(peerId, next);
      return this.memoryModerationStatus(peerId);
    }
    const policyState = current.policyState === 'banned' || action === 'ban'
      ? 'banned'
      : 'warning';
    const at = nowIso();
    const next = {
      policyState,
      warningIssuedAt: current.warningIssuedAt || at,
      bannedAt: policyState === 'banned' ? (current.bannedAt || at) : current.bannedAt,
    };
    this.moderationPeerPolicies.set(peerId, next);
    return this.memoryModerationStatus(peerId);
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
      return mapModerationAppeal(result.rows[0]);
    }
    this.moderationAppeals.set(appeal.id, appeal);
    return appeal;
  }

  async listModerationAppeals({ status = 'open', limit = 100 } = {}) {
    if (this.dbReady) {
      const values = [];
      const where = status && status !== 'all' ? 'where status = $1' : '';
      if (where) values.push(status);
      values.push(limit);
      const result = await this.pool.query(
        `select * from moderation_appeals ${where} order by created_at desc limit $${values.length}`,
        values,
      );
      return result.rows.map(mapModerationAppeal);
    }
    return [...this.moderationAppeals.values()]
      .filter((appeal) => status === 'all' || appeal.status === status)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .slice(0, limit);
  }

  async resolveModerationAppealWithUnban({ appealId, note, actor }) {
    if (this.dbReady) {
      const client = await this.pool.connect();
      try {
        await client.query('begin');
        const current = await client.query('select * from moderation_appeals where id = $1 for update', [appealId]);
        if (current.rows.length === 0) {
          await client.query('rollback');
          return null;
        }
        const appealRow = current.rows[0];
        const score = await setModerationPeerPolicy(client, appealRow.peer_id, 'unban');
        const updated = await client.query(
          `update moderation_appeals set
             status = 'accepted',
             resolved_at = now(),
             resolution_action = 'unban',
             resolution_note = $2,
             resolved_by = $3
           where id = $1
           returning *`,
          [appealId, note || null, actor || null],
        );
        await client.query('commit');
        return { appeal: mapModerationAppeal(updated.rows[0]), score };
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    }
    const appeal = this.moderationAppeals.get(appealId);
    if (!appeal) return null;
    appeal.status = 'accepted';
    appeal.resolvedAt = nowIso();
    appeal.resolutionAction = 'unban';
    appeal.resolutionNote = note || null;
    appeal.resolvedBy = actor || null;
    return { appeal, score: this.recordMemoryPeerPolicy(appeal.peerId, 'unban') };
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

  async metrics({
    devicesByUser,
    tokenToOwner,
    voipDevicesByUser,
    voipTokenToOwner,
    dedupCache,
    signedRequestReplayCacheSize = 0,
  }) {
    return buildPushMetrics({
      devicesByUser,
      tokenToOwner,
      voipDevicesByUser,
      voipTokenToOwner,
      dedupCache,
      signedRequestReplayCacheSize,
      counters: {
        events: this.events,
        sent: this.sent,
        failed: this.failed,
        deduped: this.deduped,
        registers: this.registers,
        unregisters: this.unregisters,
      },
      observedServersSize: this.observedServers.size,
      dbReady: this.dbReady,
      pool: this.pool,
    });
  }
}

export async function runServerChecker(env = process.env) {
  return runObservedServerChecker({
    env,
    schemaSql: SCHEMA_SQL,
    defaultCheckIntervalMs: DEFAULT_CHECK_INTERVAL_MS,
    defaultCheckTimeoutMs: DEFAULT_CHECK_TIMEOUT_MS,
  });
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

create index if not exists observed_servers_status_idx on observed_servers(status);
create index if not exists observed_servers_last_seen_idx on observed_servers(last_seen_at desc);
create index if not exists server_observations_server_time_idx on server_observations(server_id, observed_at desc);
create index if not exists server_usage_hourly_bucket_idx on server_usage_hourly(bucket_at desc);
create index if not exists moderation_reports_status_idx on moderation_reports(status);
create index if not exists moderation_reports_reported_peer_idx on moderation_reports(reported_peer_id, received_at desc);
create index if not exists moderation_peer_scores_state_idx on moderation_peer_scores(policy_state, report_count desc);
create index if not exists moderation_appeals_peer_idx on moderation_appeals(peer_id, created_at desc);
create index if not exists peer_identity_bindings_signing_pub_idx on peer_identity_bindings(signing_pub);
`;
