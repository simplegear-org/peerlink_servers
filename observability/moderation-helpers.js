// SPDX-License-Identifier: AGPL-3.0-only

export function moderationStatusForAction(action) {
  if (action === 'reject' || action === 'ignore') return 'rejected';
  return 'resolved';
}

export function moderationPolicyForCount(reportCount, thresholds = {}) {
  const warningThreshold = thresholds.warningThreshold || 10;
  const banThreshold = thresholds.banThreshold || 20;
  if (reportCount >= banThreshold) return 'banned';
  if (reportCount >= warningThreshold) return 'warning';
  return 'clear';
}

export async function refreshModerationPeerScore(client, peerId, thresholds = {}) {
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

export async function setModerationPeerPolicy(client, peerId, action, thresholds = {}) {
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

export function moderationScoreOrderBy(sort) {
  if (sort === 'pending_desc') return 'pending_count desc, report_count desc, last_report_at desc nulls last';
  if (sort === 'state_desc') return "case policy_state when 'banned' then 3 when 'warning' then 2 else 1 end desc, report_count desc";
  if (sort === 'last_report_desc') return 'last_report_at desc nulls last, report_count desc';
  return 'report_count desc, last_report_at desc nulls last';
}

export function compareModerationScores(a, b, sort) {
  if (sort === 'pending_desc') return (b.pendingCount - a.pendingCount) || (b.reportCount - a.reportCount);
  if (sort === 'state_desc') {
    const rank = { banned: 3, warning: 2, clear: 1 };
    return (rank[b.policyState] - rank[a.policyState]) || (b.reportCount - a.reportCount);
  }
  if (sort === 'last_report_desc') return String(b.lastReportAt || '').localeCompare(String(a.lastReportAt || ''));
  return (b.reportCount - a.reportCount) || String(b.lastReportAt || '').localeCompare(String(a.lastReportAt || ''));
}

export function mapModerationReport(row) {
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

export function mapPeerIdentityBinding(row) {
  return {
    peerId: row.peer_id,
    signingPub: row.signing_pub,
    identityNonce: row.identity_nonce,
    schemaVersion: Number(row.schema_version || 0),
    source: row.source,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
  };
}

export function mapModerationReportAggregate(row) {
  return {
    peerId: row.peer_id,
    reportCount: Number(row.report_count || 0),
    directCount: Number(row.direct_count || 0),
    groupCount: Number(row.group_count || 0),
    lastReportAt: row.last_report_at,
  };
}

export function mapModerationScore(row) {
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

export function mapModerationAppeal(row) {
  return {
    id: row.id,
    peerId: row.peer_id,
    text: row.text,
    status: row.status,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}

export function cryptoRandomId() {
  return `mod_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
