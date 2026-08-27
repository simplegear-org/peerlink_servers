// SPDX-License-Identifier: AGPL-3.0-only

export async function refreshModerationPeerScore(client, peerId) {
  const stats = await client.query(
    `select
       count(*)::int as report_count,
       count(distinct reporter_peer_id)::int as reporter_count,
       count(*)::int as pending_count,
       0::int as processed_count,
       0::int as appealed_count,
       max(received_at) as last_report_at
     from moderation_reports
     where reported_peer_id = $1`,
    [peerId],
  );
  const row = stats.rows[0] || {};
  const reportCount = Number(row.report_count || 0);
  const result = await client.query(
    `insert into moderation_peer_scores
       (peer_id, report_count, reporter_count, pending_count, processed_count, appealed_count,
        policy_state, warning_issued_at, banned_at, last_report_at, updated_at)
     values (
       $1, $2, $3, $4, $5, $6, 'clear',
       null,
       null,
       $7, now()
     )
     on conflict (peer_id) do update set
       report_count = excluded.report_count,
       reporter_count = excluded.reporter_count,
       pending_count = excluded.pending_count,
       processed_count = excluded.processed_count,
       appealed_count = excluded.appealed_count,
       last_report_at = excluded.last_report_at,
       updated_at = now()
     returning *`,
    [
      peerId,
      reportCount,
      Number(row.reporter_count || 0),
      Number(row.pending_count || 0),
      Number(row.processed_count || 0),
      Number(row.appealed_count || 0),
      row.last_report_at,
    ],
  );
  return mapModerationScore(result.rows[0]);
}

export async function setModerationPeerPolicy(client, peerId, action) {
  if (action === 'unban') {
    await refreshModerationPeerScore(client, peerId);
    const result = await client.query(
      `update moderation_peer_scores set
         policy_state = 'clear',
         warning_issued_at = null,
         banned_at = null,
         updated_at = now()
       where peer_id = $1
       returning *`,
      [peerId],
    );
    return mapModerationScore(result.rows[0]);
  }
  const policyState = action === 'ban' ? 'banned' : 'warning';
  await refreshModerationPeerScore(client, peerId);
  const result = await client.query(
    `update moderation_peer_scores set
       policy_state = case
         when policy_state = 'banned' then 'banned'
         when $2 = 'banned' then 'banned'
         else 'warning'
       end,
       warning_issued_at = coalesce(warning_issued_at, now()),
       banned_at = case when policy_state = 'banned' or $2 = 'banned' then coalesce(banned_at, now()) else banned_at end,
       updated_at = now()
     where peer_id = $1
     returning *`,
    [peerId, policyState],
  );
  return mapModerationScore(result.rows[0]);
}

export function moderationScoreOrderBy(sort) {
  if (sort === 'state_desc') return "case policy_state when 'banned' then 3 when 'warning' then 2 else 1 end desc, report_count desc";
  if (sort === 'last_report_desc') return 'last_report_at desc nulls last, report_count desc';
  return 'report_count desc, last_report_at desc nulls last';
}

export function compareModerationScores(a, b, sort) {
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
    action: row.action,
    actionNote: row.action_note,
    actionAt: row.action_at,
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
    reporterCount: Number(row.reporter_count || 0),
    directCount: Number(row.direct_count || 0),
    groupCount: Number(row.group_count || 0),
    lastReportAt: row.last_report_at,
  };
}

export function mapModerationScore(row) {
  return {
    peerId: row.peer_id,
    reportCount: Number(row.report_count || 0),
    reporterCount: Number(row.reporter_count || 0),
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
    resolutionAction: row.resolution_action,
    resolutionNote: row.resolution_note,
    resolvedBy: row.resolved_by,
  };
}

export function cryptoRandomId() {
  return `mod_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
