// SPDX-License-Identifier: AGPL-3.0-only

export const reportActions = ['dismiss', 'warn', 'ban'];
export const policyActions = ['warn', 'ban', 'unban'];

export function moderationPolicyMessage(policyState) {
  if (policyState === 'banned') return 'A serious or repeated policy violation was confirmed. Your PeerLink identity has been suspended. You can submit an appeal in the app.';
  if (policyState === 'warning') return 'A policy violation was confirmed after moderation review. A warning has been issued to your PeerLink identity.';
  return 'Your PeerLink identity has been unblocked after moderation review.';
}

export function normalizeModerationAction(value) {
  const action = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return [...reportActions, 'unban'].includes(action) ? action : null;
}

export function normalizeModerationStatus(value) {
  const status = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!status || status === 'all') return 'all';
  if (status === 'processed') return 'resolved'; // Legacy API alias.
  return ['pending', 'resolved'].includes(status) ? status : null;
}

export function decisionError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

export function validateDecision(action, note, actor, allowed = reportActions) {
  if (!allowed.includes(action)) throw decisionError('invalid_action');
  if (typeof note !== 'string' || !note.trim() || note.length > 2048) throw decisionError('moderator_note_required');
  if (typeof actor !== 'string' || !actor.trim()) throw decisionError('moderator_actor_required');
}

export function reportPriority(reason) {
  return ['threats', 'illegal_content'].includes(reason) ? 'high' : 'normal';
}

export function reportQueueRank(report, now = Date.now()) {
  const age = now - new Date(report.receivedAt).getTime();
  if (age > 24 * 3600000) return 0;
  if (age >= 20 * 3600000) return 1;
  return reportPriority(report.reason) === 'high' ? 2 : 3;
}

export function compareReportQueue(a, b, now = Date.now()) {
  return reportQueueRank(a, now) - reportQueueRank(b, now)
    || new Date(a.receivedAt) - new Date(b.receivedAt)
    || a.id.localeCompare(b.id);
}

export function reportDecisionAudit(report, action, note, actor, at = new Date().toISOString()) {
  const slaAgeMs = Math.max(0, new Date(at) - new Date(report.receivedAt));
  return { reportId: report.id, reportedPeerId: report.reportedPeerId,
    actor, previousStatus: report.status, newStatus: 'resolved', action, note,
    at, slaAgeMs, resolvedWithin24h: slaAgeMs <= 24 * 3600000 };
}

export function resolutionStatistics(reports) {
  const times = reports.filter((r) => r.status === 'resolved' && r.actionAt)
    .map((r) => Math.max(0, new Date(r.actionAt) - new Date(r.receivedAt)))
    .filter(Number.isFinite).sort((a, b) => a - b);
  const within = times.filter((ms) => ms <= 24 * 3600000).length;
  const mid = Math.floor(times.length / 2);
  return { resolved_within_24h: within, resolved_after_24h: times.length - within,
    resolved_within_24h_percent: times.length ? 100 * within / times.length : null,
    median_resolution_seconds: times.length ? (times[mid] + times[Math.ceil(times.length / 2) - 1]) / 2000 : null };
}
