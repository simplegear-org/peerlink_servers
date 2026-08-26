// SPDX-License-Identifier: AGPL-3.0-only

export function registerDeviceRoutes({
  app,
  requireAuth,
  requireSignedRequest,
  buildRegisterSignaturePayload,
  buildUnregisterSignaturePayload,
  verifyAndBindPeerIdentity,
  observability,
  deviceRegistry,
  normalizeUserId,
  normalizeDeviceId,
  normalizeStringValue,
  normalizeTokenInput,
  normalizeVoipTokenInput,
  normalizePlatform,
}) {
  app.post('/devices/register', requireAuth, requireSignedRequest(buildRegisterSignaturePayload), async (req, res) => {
    const userId = normalizeUserId(req.body?.userId);
    const deviceId = normalizeDeviceId(req.body?.deviceId);
    const messageToken = normalizeStringValue(req.body?.messageToken, 4096)
      || normalizeTokenInput(req.body?.token);
    const messageProvider = normalizeStringValue(req.body?.messageProvider, 16)?.toLowerCase() || 'fcm';
    const voipToken = normalizeVoipTokenInput(req.body?.voipToken);
    const platform = normalizePlatform(req.body?.platform);
    const appVersion = normalizeStringValue(req.body?.appVersion, 64) || '';
    if (!userId || !deviceId || !messageToken || !platform) {
      return res.status(400).json({ error: 'invalid_payload' });
    }
    const binding = await verifyAndBindPeerIdentity({
      peerId: userId,
      signingPubB64: req.body.signingPub,
      body: req.body,
      source: 'devices_register',
    });
    if (!binding.ok) {
      return res.status(binding.error === 'identity_binding_conflict' ? 409 : 401).json({
        error: binding.error,
      });
    }
    console.log('[push][register]', {
      userId,
      deviceId,
      platform,
      messageProvider,
      appVersion,
      tokenTail: messageToken.slice(-8),
      voipTokenTail: voipToken ? voipToken.slice(-8) : null,
      hasVoipToken: Boolean(voipToken),
      identityBinding: binding.legacy ? 'legacy' : 'verified',
    });
    const device = deviceRegistry.registerDevice({
      userId,
      deviceId,
      token: messageToken,
      platform,
      appVersion,
      messageProvider,
    });
    if (voipToken) {
      deviceRegistry.registerVoipDevice({
        userId,
        deviceId,
        token: voipToken,
        platform,
        appVersion,
      });
    }
    observability.recordDeviceRegister({ platform, messageProvider });
    return res.json({
      ok: true,
      device: deviceRegistry.devicePublicView(device),
      identityBinding: binding.legacy ? 'legacy' : 'verified',
    });
  });

  app.post('/devices/unregister', requireAuth, requireSignedRequest(buildUnregisterSignaturePayload), (req, res) => {
    const userId = normalizeUserId(req.body?.userId);
    const deviceId = normalizeDeviceId(req.body?.deviceId);
    const token = normalizeTokenInput(req.body?.token);
    if (!userId || !deviceId || !token) {
      return res.status(400).json({ error: 'invalid_payload' });
    }
    const existing = deviceRegistry.getDevice({ userId, deviceId });
    const ok = deviceRegistry.unregisterDevice({ userId, deviceId, token });
    if (ok) {
      observability.recordDeviceUnregister({
        platform: existing?.platform || 'unknown',
        messageProvider: existing?.messageProvider || 'unknown',
      });
    }
    return res.json({ ok });
  });

  app.get('/devices/by-user/:userId', requireAuth, (req, res) => {
    const userId = normalizeUserId(req.params.userId);
    if (!userId) {
      return res.status(400).json({ error: 'invalid_user_id' });
    }
    const devices = deviceRegistry.listDevicesForUser(userId);
    return res.json({ ok: true, userId, devices });
  });
}
