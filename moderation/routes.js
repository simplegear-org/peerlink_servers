// SPDX-License-Identifier: AGPL-3.0-only

export function registerModerationRoutes({
  app,
  requireSignedRequest,
  requireAdminAuth,
  buildModerationReportSignaturePayload,
  buildModerationAppealSignaturePayload,
  enforcePeerIdentityBinding,
  observability,
  moderationThresholds,
  normalizeModerationReport,
  normalizeModerationStatus,
  normalizeModerationAction,
  normalizePeerId,
  normalizeStringValue,
  positiveInt,
}) {
  app.post('/moderation/reports', requireSignedRequest(buildModerationReportSignaturePayload), async (req, res) => {
    const report = normalizeModerationReport(req.body);
    if (!report) {
      return res.status(400).json({ error: 'invalid_moderation_report' });
    }
    const binding = await enforcePeerIdentityBinding({
      peerId: report.reporterPeerId,
      signingPubB64: req.body.signingPub,
      source: 'moderation_reports',
    });
    if (!binding.ok) {
      return res.status(401).json({ error: binding.error });
    }
    try {
      const result = await observability.createModerationReport(report, moderationThresholds);
      return res.status(201).json({
        ok: true,
        report: result.report,
        score: result.score,
        thresholds: moderationThresholds,
      });
    } catch (error) {
      console.warn('[push][moderation] report persist failed:', error instanceof Error ? error.message : String(error));
      return res.status(503).json({ error: 'moderation_storage_unavailable' });
    }
  });

  app.get('/moderation/status', async (req, res) => {
    const peerId = normalizePeerId(req.query.peerId);
    if (!peerId) {
      return res.status(400).json({ error: 'invalid_peer_id' });
    }
    try {
      const score = await observability.moderationStatus(peerId, moderationThresholds);
      return res.json({ ok: true, score, thresholds: moderationThresholds });
    } catch (error) {
      console.warn('[push][moderation] status failed:', error instanceof Error ? error.message : String(error));
      return res.status(503).json({ error: 'moderation_storage_unavailable' });
    }
  });

  app.post('/moderation/appeals', requireSignedRequest(buildModerationAppealSignaturePayload), async (req, res) => {
    const peerId = normalizePeerId(req.body?.peerId || req.body?.reportedPeerId);
    const text = normalizeStringValue(req.body?.text || req.body?.message, 4096);
    if (!peerId || !text) {
      return res.status(400).json({ error: 'invalid_appeal' });
    }
    const binding = await enforcePeerIdentityBinding({
      peerId,
      signingPubB64: req.body.signingPub,
      source: 'moderation_appeals',
    });
    if (!binding.ok) {
      return res.status(401).json({ error: binding.error });
    }
    try {
      const appeal = await observability.createModerationAppeal({ peerId, text });
      return res.status(201).json({ ok: true, appeal });
    } catch (error) {
      console.warn('[push][moderation] appeal failed:', error instanceof Error ? error.message : String(error));
      return res.status(503).json({ error: 'moderation_storage_unavailable' });
    }
  });

  app.get('/admin/moderation/summary', requireAdminAuth, async (_req, res) => {
    try {
      const summary = await observability.moderationSummary();
      return res.json({ ok: true, summary, thresholds: moderationThresholds });
    } catch (error) {
      console.warn('[push][moderation] summary failed:', error instanceof Error ? error.message : String(error));
      return res.status(503).json({ error: 'moderation_storage_unavailable' });
    }
  });

  app.get('/admin/reports', requireAdminAuth, async (req, res) => {
    const status = normalizeModerationStatus(req.query.status);
    const reportedPeerId = normalizePeerId(req.query.reportedPeerId);
    const limit = Math.min(500, positiveInt(req.query.limit, 100));
    if (!status) {
      return res.status(400).json({ error: 'invalid_status' });
    }
    try {
      const reports = await observability.listModerationReports({ status, reportedPeerId, limit });
      return res.json({ ok: true, reports });
    } catch (error) {
      console.warn('[push][moderation] reports failed:', error instanceof Error ? error.message : String(error));
      return res.status(503).json({ error: 'moderation_storage_unavailable' });
    }
  });

  app.get('/admin/moderation/reported-peers', requireAdminAuth, async (req, res) => {
    const limit = Math.min(500, positiveInt(req.query.limit, 100));
    try {
      const peers = await observability.listModerationReportAggregates({ role: 'reported', limit });
      return res.json({ ok: true, peers });
    } catch (error) {
      console.warn('[push][moderation] reported peers failed:', error instanceof Error ? error.message : String(error));
      return res.status(503).json({ error: 'moderation_storage_unavailable' });
    }
  });

  app.get('/admin/moderation/reporters', requireAdminAuth, async (req, res) => {
    const limit = Math.min(500, positiveInt(req.query.limit, 100));
    try {
      const peers = await observability.listModerationReportAggregates({ role: 'reporter', limit });
      return res.json({ ok: true, peers });
    } catch (error) {
      console.warn('[push][moderation] reporters failed:', error instanceof Error ? error.message : String(error));
      return res.status(503).json({ error: 'moderation_storage_unavailable' });
    }
  });

  app.get('/admin/moderation/peer-scores', requireAdminAuth, async (req, res) => {
    const sort = normalizeStringValue(req.query.sort, 64) || 'report_count_desc';
    const limit = Math.min(1000, positiveInt(req.query.limit, 500));
    try {
      const scores = await observability.listModerationPeerScores({ sort, limit, thresholds: moderationThresholds });
      return res.json({ ok: true, scores, thresholds: moderationThresholds });
    } catch (error) {
      console.warn('[push][moderation] peer scores failed:', error instanceof Error ? error.message : String(error));
      return res.status(503).json({ error: 'moderation_storage_unavailable' });
    }
  });

  app.post('/admin/reports/:id/action', requireAdminAuth, async (req, res) => {
    const reportId = normalizeStringValue(req.params.id, 256);
    const action = normalizeModerationAction(req.body?.action);
    const note = normalizeStringValue(req.body?.note, 2048) || '';
    if (!reportId || !action) {
      return res.status(400).json({ error: 'invalid_action' });
    }
    try {
      const result = await observability.recordModerationAction({
        reportId,
        action,
        note,
        actor: 'moderator',
        thresholds: moderationThresholds,
      });
      if (!result) {
        return res.status(404).json({ error: 'report_not_found' });
      }
      return res.json({ ok: true, ...result });
    } catch (error) {
      console.warn('[push][moderation] action failed:', error instanceof Error ? error.message : String(error));
      return res.status(503).json({ error: 'moderation_storage_unavailable' });
    }
  });
}
