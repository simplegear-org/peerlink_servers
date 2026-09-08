// SPDX-License-Identifier: AGPL-3.0-only

import { SCHEMA_SQL } from './observability/db/schema.js';
import { buildPushMetrics, CounterMap, HistogramMap } from './observability/metrics.js';
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

export { extractServersFromPayload, normalizeEventType } from './observability/server-discovery.js';

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
    this.policyDecisions = new CounterMap();
    this.policySync = new CounterMap();
    this.deliveryDuration = new HistogramMap({
      buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
    });
    this.observedServers = new Map();
    this.moderationReports = new Map();
    this.moderationAppeals = new Map();
    this.moderationPeerPolicies = new Map();
    this.peerIdentityBindings = new Map();
    this.pushUserPolicies = new Map();
    this.pushUserContacts = new Map();
    this.pushUserBlocked = new Map();
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

  async listActivePushDevices() {
    if (!this.dbReady) return [];
    const result = await this.pool.query(
      `select
         user_id, device_id, message_token, message_provider, voip_token, platform,
         app_version, enabled, created_at, updated_at, last_seen_at
       from push_devices
       where enabled = true`,
    );
    return result.rows.map((row) => ({
      userId: row.user_id,
      deviceId: row.device_id,
      messageToken: row.message_token,
      messageProvider: row.message_provider || 'fcm',
      voipToken: row.voip_token,
      platform: row.platform || '',
      appVersion: row.app_version || '',
      enabled: row.enabled,
      createdAtMs: row.created_at ? new Date(row.created_at).getTime() : null,
      updatedAtMs: row.updated_at ? new Date(row.updated_at).getTime() : null,
      lastSeenAtMs: row.last_seen_at ? new Date(row.last_seen_at).getTime() : null,
    }));
  }

  async upsertPushDevice({
    userId,
    deviceId,
    messageToken = null,
    messageProvider = null,
    voipToken = null,
    platform,
    appVersion = '',
    maxDevicesPerUser,
  }) {
    if (!this.dbReady) return;
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      if (messageToken) {
        await client.query(
          `update push_devices
           set enabled = false, updated_at = now()
           where message_token = $1 and (user_id <> $2 or device_id <> $3)`,
          [messageToken, userId, deviceId],
        );
      }
      if (voipToken) {
        await client.query(
          `update push_devices
           set voip_token = null, updated_at = now()
           where voip_token = $1 and (user_id <> $2 or device_id <> $3)`,
          [voipToken, userId, deviceId],
        );
      }
      await client.query(
        `insert into push_devices
          (user_id, device_id, message_token, message_provider, voip_token, platform,
           app_version, enabled, created_at, updated_at, last_seen_at)
         values ($1, $2, $3, coalesce($4, 'fcm'), $5, $6, $7, true, now(), now(), now())
         on conflict (user_id, device_id) do update set
           message_token = coalesce(excluded.message_token, push_devices.message_token),
           message_provider = coalesce(excluded.message_provider, push_devices.message_provider),
           voip_token = coalesce(excluded.voip_token, push_devices.voip_token),
           platform = excluded.platform,
           app_version = excluded.app_version,
           enabled = true,
           updated_at = now(),
           last_seen_at = now()`,
        [userId, deviceId, messageToken, messageProvider, voipToken, platform, appVersion],
      );
      const limit = Math.max(1, Number.parseInt(String(maxDevicesPerUser || 20), 10));
      await client.query(
        `with ranked as (
           select user_id, device_id,
             row_number() over (partition by user_id order by last_seen_at desc, updated_at desc) as rn
           from push_devices
           where user_id = $1 and enabled = true
         )
         update push_devices d
         set enabled = false, updated_at = now()
         from ranked r
         where d.user_id = r.user_id and d.device_id = r.device_id and r.rn > $2`,
        [userId, limit],
      );
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  async disablePushDeviceToken({ userId, deviceId, messageToken = null, voipToken = null }) {
    if (!this.dbReady) return;
    if (messageToken) {
      await this.pool.query(
        `update push_devices
         set enabled = false, updated_at = now()
         where user_id = $1 and device_id = $2 and message_token = $3`,
        [userId, deviceId, messageToken],
      );
      return;
    }
    if (voipToken) {
      await this.pool.query(
        `update push_devices
         set voip_token = null, updated_at = now()
         where user_id = $1 and device_id = $2 and voip_token = $3`,
        [userId, deviceId, voipToken],
      );
    }
  }

  normalizePolicyIds(values) {
    return [...new Set((Array.isArray(values) ? values : [])
      .map((item) => (typeof item === 'string' ? item.trim() : ''))
      .filter((item) => item && item.length <= 128))]
      .sort();
  }

  async upsertAccessPolicy({
    userId,
    allowMessagesOnlyFromContacts,
    contactPeerIds,
    blockedPeerIds,
    policyVersion,
    updatedAt,
    snapshotHash,
  }) {
    const contacts = this.normalizePolicyIds(contactPeerIds);
    const blocked = this.normalizePolicyIds(blockedPeerIds);
    const version = Number.isFinite(Number(policyVersion)) ? Number(policyVersion) : 0;
    const clientUpdatedAt = updatedAt ? new Date(updatedAt) : new Date();
    if (Number.isNaN(clientUpdatedAt.getTime())) {
      this.policySync.inc({ result: 'failed', reason: 'invalid_updated_at' });
      return { ok: false, error: 'invalid_updated_at' };
    }
    if (this.dbReady) {
      const current = await this.pool.query(
        `select policy_version from push_user_policy where user_id = $1`,
        [userId],
      );
      const currentVersion = Number(current.rows[0]?.policy_version ?? -1);
      if (current.rows[0] && version < currentVersion) {
        this.policySync.inc({ result: 'stale' });
        return { ok: true, stale: true, policyVersion: currentVersion };
      }
      const client = await this.pool.connect();
      try {
        await client.query('begin');
        await client.query(
          `insert into push_user_policy
            (user_id, allow_messages_only_from_contacts, last_policy_sync_at,
             policy_version, snapshot_hash, updated_at)
           values ($1, $2, now(), $3, $4, $5)
           on conflict (user_id) do update set
             allow_messages_only_from_contacts = excluded.allow_messages_only_from_contacts,
             last_policy_sync_at = now(),
             policy_version = excluded.policy_version,
             snapshot_hash = excluded.snapshot_hash,
             updated_at = excluded.updated_at`,
          [userId, Boolean(allowMessagesOnlyFromContacts), version, snapshotHash || '', clientUpdatedAt.toISOString()],
        );
        await client.query('delete from push_user_contacts where user_id = $1', [userId]);
        for (const contactPeerId of contacts) {
          await client.query(
            `insert into push_user_contacts (user_id, contact_peer_id, updated_at)
             values ($1, $2, $3)
             on conflict (user_id, contact_peer_id) do update set updated_at = excluded.updated_at`,
            [userId, contactPeerId, clientUpdatedAt.toISOString()],
          );
        }
        await client.query('delete from push_user_blocked where user_id = $1', [userId]);
        for (const blockedPeerId of blocked) {
          await client.query(
            `insert into push_user_blocked (user_id, blocked_peer_id, updated_at)
             values ($1, $2, $3)
             on conflict (user_id, blocked_peer_id) do update set updated_at = excluded.updated_at`,
            [userId, blockedPeerId, clientUpdatedAt.toISOString()],
          );
        }
        await client.query('commit');
      } catch (error) {
        await client.query('rollback');
        this.policySync.inc({ result: 'failed', reason: 'db_error' });
        throw error;
      } finally {
        client.release();
      }
    } else {
      const current = this.pushUserPolicies.get(userId);
      if (current && version < Number(current.policyVersion || 0)) {
        this.policySync.inc({ result: 'stale' });
        return { ok: true, stale: true, policyVersion: current.policyVersion };
      }
    }
    this.pushUserPolicies.set(userId, {
      userId,
      allowMessagesOnlyFromContacts: Boolean(allowMessagesOnlyFromContacts),
      policyVersion: version,
      snapshotHash: snapshotHash || '',
      updatedAt: clientUpdatedAt.toISOString(),
      lastPolicySyncAt: nowIso(),
    });
    this.pushUserContacts.set(userId, new Set(contacts));
    this.pushUserBlocked.set(userId, new Set(blocked));
    this.policySync.inc({ result: 'ok' });
    return { ok: true, stale: false, policyVersion: version, snapshotHash: snapshotHash || '' };
  }

  async accessPolicyForUser(userId) {
    if (this.dbReady) {
      const policy = await this.pool.query(
        `select * from push_user_policy where user_id = $1`,
        [userId],
      );
      if (!policy.rows[0]) return null;
      const contacts = await this.pool.query(
        `select contact_peer_id from push_user_contacts where user_id = $1`,
        [userId],
      );
      const blocked = await this.pool.query(
        `select blocked_peer_id from push_user_blocked where user_id = $1`,
        [userId],
      );
      return {
        userId,
        allowMessagesOnlyFromContacts: Boolean(policy.rows[0].allow_messages_only_from_contacts),
        contactPeerIds: new Set(contacts.rows.map((row) => row.contact_peer_id)),
        blockedPeerIds: new Set(blocked.rows.map((row) => row.blocked_peer_id)),
        policyVersion: Number(policy.rows[0].policy_version || 0),
        snapshotHash: policy.rows[0].snapshot_hash || '',
        updatedAt: policy.rows[0].updated_at,
        lastPolicySyncAt: policy.rows[0].last_policy_sync_at,
      };
    }
    const policy = this.pushUserPolicies.get(userId);
    if (!policy) return null;
    return {
      ...policy,
      contactPeerIds: this.pushUserContacts.get(userId) || new Set(),
      blockedPeerIds: this.pushUserBlocked.get(userId) || new Set(),
    };
  }

  async decideAccessPolicy({ recipientUserId, senderUserId, missingSnapshotMode = 'allow' }) {
    const policy = await this.accessPolicyForUser(recipientUserId);
    if (!policy) {
      const allowed = missingSnapshotMode !== 'drop';
      this.policyDecisions.inc({
        decision: allowed ? 'allow_missing_snapshot' : 'drop_missing_snapshot',
      });
      return { allowed, reason: 'missing_snapshot' };
    }
    if (policy.blockedPeerIds.has(senderUserId)) {
      this.policyDecisions.inc({ decision: 'drop_blocked' });
      return {
        allowed: false,
        reason: 'blocked',
        policyVersion: Number(policy.policyVersion || 0),
        snapshotHash: policy.snapshotHash || '',
        contactsCount: policy.contactPeerIds.size,
        blockedCount: policy.blockedPeerIds.size,
      };
    }
    if (!policy.allowMessagesOnlyFromContacts) {
      this.policyDecisions.inc({ decision: 'allow' });
      return {
        allowed: true,
        reason: 'allow_all',
        policyVersion: Number(policy.policyVersion || 0),
        snapshotHash: policy.snapshotHash || '',
        contactsCount: policy.contactPeerIds.size,
        blockedCount: policy.blockedPeerIds.size,
      };
    }
    if (policy.contactPeerIds.has(senderUserId)) {
      this.policyDecisions.inc({ decision: 'allow' });
      return {
        allowed: true,
        reason: 'contact',
        policyVersion: Number(policy.policyVersion || 0),
        snapshotHash: policy.snapshotHash || '',
        contactsCount: policy.contactPeerIds.size,
        blockedCount: policy.blockedPeerIds.size,
      };
    }
    this.policyDecisions.inc({ decision: 'drop_not_contact' });
    return {
      allowed: false,
      reason: 'not_contact',
      policyVersion: Number(policy.policyVersion || 0),
      snapshotHash: policy.snapshotHash || '',
      contactsCount: policy.contactPeerIds.size,
      blockedCount: policy.blockedPeerIds.size,
    };
  }

  async filterByAccessPolicy({ senderUserId, recipientUserIds, missingSnapshotMode = 'allow' }) {
    const allowed = [];
    const dropped = [];
    const decisions = [];
    for (const recipientUserId of recipientUserIds) {
      const decision = await this.decideAccessPolicy({
        recipientUserId,
        senderUserId,
        missingSnapshotMode,
      });
      decisions.push({
        userId: recipientUserId,
        allowed: decision.allowed,
        reason: decision.reason,
        policyVersion: decision.policyVersion ?? null,
        snapshotHash: decision.snapshotHash || '',
        contactsCount: decision.contactsCount ?? null,
        blockedCount: decision.blockedCount ?? null,
      });
      if (decision.allowed) {
        allowed.push(recipientUserId);
      } else {
        dropped.push({ userId: recipientUserId, reason: decision.reason });
      }
    }
    return { allowed, dropped, decisions };
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
    if (this.dbReady) {
      this.recordProductEvent({ eventType }).catch((error) => {
        console.warn('[push][observability] product event persist failed:', error instanceof Error ? error.message : String(error));
      });
    }
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

  recordPushDeliveryDuration({ payload, deliveryName, provider, durationSeconds }) {
    const eventType = normalizeEventType(payload?.type);
    this.deliveryDuration.observe({
      event_type: eventType,
      delivery: deliveryName || 'unknown',
      provider: provider || 'unknown',
    }, durationSeconds);
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
           count(*) filter (where action_at is null)::int as pending,
           count(*) filter (where action_at is not null)::int as processed,
           count(*) filter (where action_at is null and received_at <= now() - interval '20 hours' and received_at >= now() - interval '24 hours')::int as approaching_24h,
           count(*) filter (where action_at is null and received_at < now() - interval '24 hours')::int as overdue,
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
    const pending = reports.filter((report) => !report.actionAt);
    const now = Date.now();
    const age = (report) => now - new Date(report.receivedAt).getTime();
    const scores = new Map(reports.map((report) => [report.reportedPeerId, this.memoryModerationStatus(report.reportedPeerId)]));
    return {
      total: reports.length,
      pending: pending.length,
      processed: reports.length - pending.length,
      approaching_24h: pending.filter((report) => age(report) >= 20 * 3600000 && age(report) <= 24 * 3600000).length,
      overdue: pending.filter((report) => age(report) > 24 * 3600000).length,
      appealed: 0,
      remaining: pending.length,
      warned_peers: [...scores.values()].filter((score) => score.policyState === 'warning').length,
      banned_peers: [...scores.values()].filter((score) => score.policyState === 'banned').length,
    };
  }

  async listModerationReports({ status, reportedPeerId, limit = 100 } = {}) {
    if (this.dbReady) {
      const filters = [];
      const values = [];
      if (status === 'pending') filters.push('action_at is null');
      if (status === 'processed') filters.push('action_at is not null');
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
      .filter((report) => status !== 'pending' || !report.actionAt)
      .filter((report) => status !== 'processed' || !!report.actionAt)
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
    const at = nowIso();
    for (const report of this.moderationReports.values()) {
      if (report.reportedPeerId !== peerId) continue;
      report.action = action;
      report.actionNote = note || null;
      report.actionAt = at;
      report.auditHistory.push({ at, action, actor, note: note || null });
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

  async recordProductEvent({ eventType }) {
    if (!this.dbReady) return;
    await this.pool.query(
      `insert into product_event_hourly (bucket_at, event_type, event_count)
       values (date_trunc('hour', now()), $1, 1)
       on conflict (bucket_at, event_type) do update set
         event_count = product_event_hourly.event_count + 1`,
      [eventType],
    );
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
        policyDecisions: this.policyDecisions,
        policySync: this.policySync,
      },
      histograms: {
        deliveryDuration: this.deliveryDuration,
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
