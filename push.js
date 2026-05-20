import express from 'express';
import crypto from 'crypto';
import { GoogleAuth } from 'google-auth-library';

const app = express();
app.use(express.json({ limit: process.env.PUSH_BODY_LIMIT || '2mb' }));

app.use((req, res, next) => {
  const startedAt = Date.now();
  const requestId = crypto.randomUUID().slice(0, 8);
  console.log(
    `[push][http][in] id=${requestId} method=${req.method} path=${req.originalUrl} ip=${req.ip || '-'} ua=${req.get('user-agent') || '-'}`,
  );
  res.on('finish', () => {
    const elapsedMs = Date.now() - startedAt;
    console.log(
      `[push][http][out] id=${requestId} status=${res.statusCode} elapsedMs=${elapsedMs}`,
    );
  });
  next();
});

const PORT = Number.parseInt(process.env.PORT || '4500', 10);
const API_TOKEN = (process.env.PUSH_API_TOKEN || '').trim();
const DEDUP_TTL_SECONDS = Number.parseInt(process.env.PUSH_DEDUP_TTL_SECONDS || '30', 10);
const MAX_DEVICES_PER_USER = Number.parseInt(process.env.PUSH_MAX_DEVICES_PER_USER || '20', 10);
const SIGNATURE_SKEW_SECONDS = Number.parseInt(process.env.PUSH_SIGNATURE_SKEW_SECONDS || '120', 10);
const SIGNED_ID_TTL_SECONDS = Number.parseInt(process.env.PUSH_SIGNED_ID_TTL_SECONDS || '300', 10);

const FCM_PROJECT_ID = (process.env.FCM_PROJECT_ID || '').trim();
const FCM_CREDENTIALS_JSON = (process.env.FCM_CREDENTIALS_JSON || '').trim();
const FCM_SCOPES = ['https://www.googleapis.com/auth/firebase.messaging'];
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

let googleAuthClient = null;
const dedupCache = new Map(); // dedupKey -> expiresAtMs
const devicesByUser = new Map(); // userId -> Map<deviceId, device>
const tokenToOwner = new Map(); // fcmToken -> { userId, deviceId }
const signedRequestIds = new Map(); // id -> expiresAtMs

function cleanupDedupCache() {
  const now = Date.now();
  for (const [key, expiresAtMs] of dedupCache.entries()) {
    if (expiresAtMs <= now) {
      dedupCache.delete(key);
    }
  }
}

function getDedupKey(body) {
  if (!body || typeof body !== 'object') {
    return null;
  }
  const token = normalizeTokenInput(body.token);
  const data = body.data && typeof body.data === 'object' ? body.data : null;
  if (!token || !data) {
    return null;
  }
  const eventType = typeof data.type === 'string' ? data.type : 'unknown';
  const scopeId =
    (typeof data.groupId === 'string' && data.groupId) ||
    (typeof data.directPeerId === 'string' && data.directPeerId) ||
    '';
  const seq = typeof data.lastSeq === 'string' ? data.lastSeq : '';
  if (!scopeId || !seq) {
    return null;
  }
  return `${token}|${eventType}|${scopeId}|${seq}`;
}

function tryAcquireDedup(body) {
  const ttlSeconds = Number.isFinite(DEDUP_TTL_SECONDS) && DEDUP_TTL_SECONDS > 0
    ? DEDUP_TTL_SECONDS
    : 30;
  const key = getDedupKey(body);
  if (!key) {
    return { deduped: false, key: null };
  }
  cleanupDedupCache();
  if (dedupCache.has(key)) {
    return { deduped: true, key };
  }
  dedupCache.set(key, Date.now() + ttlSeconds * 1000);
  return { deduped: false, key };
}

function parseBearerToken(authHeader) {
  if (typeof authHeader !== 'string') return null;
  const [scheme, token] = authHeader.split(' ');
  if (!scheme || !token || scheme.toLowerCase() !== 'bearer') {
    return null;
  }
  return token.trim();
}

function cleanupSignedRequestIds() {
  const now = Date.now();
  for (const [id, expiresAtMs] of signedRequestIds.entries()) {
    if (expiresAtMs <= now) {
      signedRequestIds.delete(id);
    }
  }
}

function tryAcquireSignedRequestId(id) {
  cleanupSignedRequestIds();
  if (signedRequestIds.has(id)) {
    return false;
  }
  const ttlSeconds = Number.isFinite(SIGNED_ID_TTL_SECONDS) && SIGNED_ID_TTL_SECONDS > 0
    ? SIGNED_ID_TTL_SECONDS
    : 300;
  signedRequestIds.set(id, Date.now() + ttlSeconds * 1000);
  return true;
}

function requireAuth(req, res, next) {
  if (!API_TOKEN) {
    return next();
  }
  const token = parseBearerToken(req.headers.authorization);
  if (token && token === API_TOKEN) {
    return next();
  }
  console.warn('[push][auth] unauthorized', {
    path: req.originalUrl,
    hasAuthorizationHeader: Boolean(req.headers.authorization),
    tokenLength: token ? token.length : 0,
  });
  return res.status(401).json({ error: 'unauthorized' });
}

function normalizeTokenInput(token) {
  if (typeof token !== 'string') return null;
  const trimmed = token.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('fcm:')) {
    return trimmed.slice('fcm:'.length);
  }
  return trimmed;
}

function normalizeStringValue(value, maxLen = 512) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLen) return null;
  return normalized;
}

function normalizeUserId(value) {
  return normalizeStringValue(value, 128);
}

function normalizeDeviceId(value) {
  return normalizeStringValue(value, 256);
}

function normalizePlatform(value) {
  const platform = normalizeStringValue(value, 32);
  if (!platform) return null;
  return platform.toLowerCase();
}

function parseBase64(input) {
  if (typeof input !== 'string' || input.length === 0) {
    return null;
  }
  try {
    return Buffer.from(input, 'base64');
  } catch (_) {
    return null;
  }
}

function verifyEd25519Signature({ payloadBytes, signatureB64, signingPubB64 }) {
  const signature = parseBase64(signatureB64);
  const signingPubRaw = parseBase64(signingPubB64);
  if (!signature || !signingPubRaw || signingPubRaw.length !== 32) {
    return false;
  }
  try {
    const publicKeyDer = Buffer.concat([ED25519_SPKI_PREFIX, signingPubRaw]);
    const publicKey = crypto.createPublicKey({
      key: publicKeyDer,
      format: 'der',
      type: 'spki',
    });
    return crypto.verify(null, payloadBytes, publicKey, signature);
  } catch (_) {
    return false;
  }
}

function requireSignedRequest(buildPayload) {
  return (req, res, next) => {
    const body = req.body;
    if (!body || typeof body !== 'object') {
      return res.status(400).json({ error: 'invalid body' });
    }
    const required = ['id', 'from', 'ts', 'sig', 'signingPub'];
    for (const key of required) {
      if (!(key in body)) {
        return res.status(400).json({ error: `missing ${key}` });
      }
    }
    const id = normalizeStringValue(body.id, 256);
    const from = normalizeStringValue(body.from, 128);
    const ts = Number.parseInt(String(body.ts), 10);
    if (!id || !from || !Number.isFinite(ts)) {
      return res.status(400).json({ error: 'invalid id/from/ts' });
    }
    const nowSec = Math.floor(Date.now() / 1000);
    const tsSec = Math.floor(ts / 1000);
    if (Math.abs(nowSec - tsSec) > SIGNATURE_SKEW_SECONDS) {
      console.warn('[push][sig] signature_timestamp_skew', {
        path: req.originalUrl,
        id,
        from,
        nowSec,
        tsSec,
        skewSec: nowSec - tsSec,
      });
      return res.status(401).json({ error: 'signature_timestamp_skew' });
    }
    if (!tryAcquireSignedRequestId(id)) {
      return res.status(409).json({ error: 'duplicate request id' });
    }
    let payloadBytes;
    try {
      payloadBytes = buildPayload(body, { id, from, ts });
    } catch (error) {
      return res.status(400).json({
        error: 'invalid signature payload',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
    const verified = verifyEd25519Signature({
      payloadBytes,
      signatureB64: body.sig,
      signingPubB64: body.signingPub,
    });
    if (!verified) {
      console.warn('[push][sig] invalid signature', {
        path: req.originalUrl,
        id,
        from,
      });
      return res.status(401).json({ error: 'invalid signature' });
    }
    req.signature = { id, from, ts };
    return next();
  };
}

function buildRegisterSignaturePayload(body, normalized) {
  const userId = normalizeUserId(body.userId);
  const deviceId = normalizeDeviceId(body.deviceId);
  const token = normalizeTokenInput(body.token);
  const platform = normalizePlatform(body.platform);
  const appVersion = normalizeStringValue(body.appVersion, 64) || '';
  if (!userId || !deviceId || !token || !platform) {
    throw new Error('invalid register fields');
  }
  if (normalized.from !== userId) {
    throw new Error('from must match userId');
  }
  return Buffer.from(
    `${normalized.id}|${normalized.from}|${deviceId}|${token}|${platform}|${appVersion}|${normalized.ts}`,
    'utf8',
  );
}

function buildUnregisterSignaturePayload(body, normalized) {
  const userId = normalizeUserId(body.userId);
  const deviceId = normalizeDeviceId(body.deviceId);
  const token = normalizeTokenInput(body.token);
  if (!userId || !deviceId || !token) {
    throw new Error('invalid unregister fields');
  }
  if (normalized.from !== userId) {
    throw new Error('from must match userId');
  }
  return Buffer.from(
    `${normalized.id}|${normalized.from}|${deviceId}|${token}|${normalized.ts}`,
    'utf8',
  );
}

function buildEventSignaturePayload(body, normalized) {
  const senderUserId = normalizeUserId(body.senderUserId);
  const groupId = normalizeStringValue(body.groupId, 256);
  const directPeerId = normalizeUserId(body.directPeerId);
  const scopeId = groupId || directPeerId;
  const messageId = normalizeStringValue(body.messageId, 256);
  const schemaVersionRaw = normalizeStringValue(body.schemaVersion, 32);
  const schemaVersion = schemaVersionRaw || 'push-v1';
  const recipients = Array.isArray(body.recipientUserIds)
    ? [...new Set(body.recipientUserIds.map((value) => normalizeUserId(value)).filter(Boolean))].sort()
    : [];
  if (!senderUserId || !scopeId || !messageId || recipients.length === 0) {
    throw new Error('invalid event fields');
  }
  if (normalized.from !== senderUserId) {
    throw new Error('from must match senderUserId');
  }
  let relayPart = '';
  if (schemaVersion === 'push-v1.1') {
    const relay = body.relay && typeof body.relay === 'object' ? body.relay : null;
    const relayServerId = normalizeStringValue(relay?.serverId, 256);
    const relayScopeKind = normalizeStringValue(relay?.scopeKind, 32)?.toLowerCase();
    const relayBlobId = normalizeStringValue(relay?.blobId, 256) || '';
    const relayMessageId = normalizeStringValue(relay?.relayMessageId, 256) || '';
    if (!relayServerId || !relayScopeKind) {
      throw new Error('invalid relay metadata for push-v1.1');
    }
    relayPart = `${relayServerId}|${relayScopeKind}|${relayBlobId}|${relayMessageId}`;
  }
  if (!schemaVersionRaw) {
    return Buffer.from(
      `${normalized.id}|${normalized.from}|${scopeId}|${messageId}|${recipients.join(',')}|${normalized.ts}`,
      'utf8',
    );
  }
  return Buffer.from(
    `${normalized.id}|${normalized.from}|${scopeId}|${messageId}|${recipients.join(',')}|${normalized.ts}|${schemaVersion}|${relayPart}`,
    'utf8',
  );
}

function devicePublicView(device) {
  return {
    userId: device.userId,
    deviceId: device.deviceId,
    platform: device.platform,
    appVersion: device.appVersion,
    enabled: device.enabled,
    lastSeenAt: device.lastSeenAt,
    updatedAt: device.updatedAt,
  };
}

function ensureUserDevices(userId) {
  let devices = devicesByUser.get(userId);
  if (!devices) {
    devices = new Map();
    devicesByUser.set(userId, devices);
  }
  return devices;
}

function registerDevice({ userId, deviceId, token, platform, appVersion }) {
  const devices = ensureUserDevices(userId);
  const now = Date.now();
  const previousOwner = tokenToOwner.get(token);
  if (previousOwner && (previousOwner.userId !== userId || previousOwner.deviceId !== deviceId)) {
    const previousDevices = devicesByUser.get(previousOwner.userId);
    const previousDevice = previousDevices?.get(previousOwner.deviceId);
    if (previousDevice && previousDevice.token === token) {
      previousDevice.enabled = false;
      previousDevice.updatedAt = now;
      previousDevices.set(previousOwner.deviceId, previousDevice);
    }
  }
  if (!devices.has(deviceId) && devices.size >= Math.max(1, MAX_DEVICES_PER_USER)) {
    let oldest = null;
    for (const candidate of devices.values()) {
      if (!oldest || candidate.lastSeenAt < oldest.lastSeenAt) {
        oldest = candidate;
      }
    }
    if (oldest) {
      devices.delete(oldest.deviceId);
      if (tokenToOwner.get(oldest.token)?.deviceId === oldest.deviceId) {
        tokenToOwner.delete(oldest.token);
      }
    }
  }
  const existing = devices.get(deviceId);
  const device = {
    userId,
    deviceId,
    token,
    platform,
    appVersion,
    enabled: true,
    lastSeenAt: now,
    updatedAt: now,
    createdAt: existing?.createdAt ?? now,
  };
  devices.set(deviceId, device);
  tokenToOwner.set(token, { userId, deviceId });
  return device;
}

function unregisterDevice({ userId, deviceId, token }) {
  const devices = devicesByUser.get(userId);
  if (!devices) return false;
  const device = devices.get(deviceId);
  if (!device) return false;
  if (device.token !== token) return false;
  device.enabled = false;
  device.updatedAt = Date.now();
  devices.set(deviceId, device);
  if (tokenToOwner.get(token)?.userId === userId && tokenToOwner.get(token)?.deviceId === deviceId) {
    tokenToOwner.delete(token);
  }
  return true;
}

function getActiveTokensForUsers(userIds) {
  const tokens = [];
  for (const userId of userIds) {
    const devices = devicesByUser.get(userId);
    if (!devices) continue;
    for (const device of devices.values()) {
      if (device.enabled && device.token) {
        tokens.push({ userId, deviceId: device.deviceId, token: device.token });
      }
    }
  }
  return tokens;
}

function getGoogleAuthClient() {
  if (googleAuthClient) return googleAuthClient;
  if (!FCM_PROJECT_ID) {
    throw new Error('FCM_PROJECT_ID is not configured');
  }
  let credentials;
  if (FCM_CREDENTIALS_JSON) {
    credentials = JSON.parse(FCM_CREDENTIALS_JSON);
  }
  googleAuthClient = new GoogleAuth({
    credentials,
    scopes: FCM_SCOPES,
  });
  return googleAuthClient;
}

async function sendFcm({ token, data, notification, android }) {
  const auth = getGoogleAuthClient();
  const accessToken = await auth.getAccessToken();
  if (!accessToken) {
    throw new Error('failed to obtain FCM access token');
  }

  const message = {
    token,
    data: data && typeof data === 'object' ? data : {},
  };
  if (
    notification &&
    typeof notification === 'object' &&
    (typeof notification.title === 'string' || typeof notification.body === 'string')
  ) {
    message.notification = {};
    if (typeof notification.title === 'string') message.notification.title = notification.title;
    if (typeof notification.body === 'string') message.notification.body = notification.body;
  }
  if (android && typeof android === 'object') {
    message.android = android;
  }

  const response = await fetch(
    `https://fcm.googleapis.com/v1/projects/${FCM_PROJECT_ID}/messages:send`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ message }),
    },
  );
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`fcm status=${response.status} body=${text.slice(0, 512)}`);
  }
  return { ok: true, provider: 'fcm', raw: text };
}

app.get('/health', (_req, res) => {
  cleanupDedupCache();
  cleanupSignedRequestIds();
  res.json({
    ok: true,
    providers: {
      fcmConfigured: Boolean(FCM_PROJECT_ID),
    },
    security: {
      bearerEnabled: Boolean(API_TOKEN),
    },
    dedup: {
      ttlSeconds: DEDUP_TTL_SECONDS,
      cacheSize: dedupCache.size,
    },
    signature: {
      requiredForWrite: true,
      skewSeconds: SIGNATURE_SKEW_SECONDS,
      signedIdTtlSeconds: SIGNED_ID_TTL_SECONDS,
      replayCacheSize: signedRequestIds.size,
    },
    devices: {
      users: devicesByUser.size,
      tokens: tokenToOwner.size,
      maxDevicesPerUser: MAX_DEVICES_PER_USER,
    },
    ts: Date.now(),
  });
});

app.post('/send', requireAuth, async (req, res) => {
  const body = req.body;
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ error: 'invalid body' });
  }
  const token = normalizeTokenInput(body.token);
  if (!token) {
    return res.status(400).json({ error: 'invalid token' });
  }
  const dedup = tryAcquireDedup(body);
  if (dedup.deduped) {
    return res.json({ ok: true, provider: 'fcm', deduped: true });
  }
  try {
    const result = await sendFcm({
      token,
      data: body.data,
      notification: body.notification,
      android: body.android,
    });
    return res.json({ ok: true, provider: result.provider });
  } catch (error) {
    return res.status(502).json({
      ok: false,
      error: 'push_send_failed',
      detail: error instanceof Error ? error.message : String(error),
      provider: 'fcm',
    });
  }
});

app.post('/devices/register', requireAuth, requireSignedRequest(buildRegisterSignaturePayload), (req, res) => {
  const userId = normalizeUserId(req.body?.userId);
  const deviceId = normalizeDeviceId(req.body?.deviceId);
  const token = normalizeTokenInput(req.body?.token);
  const platform = normalizePlatform(req.body?.platform);
  const appVersion = normalizeStringValue(req.body?.appVersion, 64) || '';
  if (!userId || !deviceId || !token || !platform) {
    return res.status(400).json({ error: 'invalid_payload' });
  }
  console.log('[push][register]', {
    userId,
    deviceId,
    platform,
    appVersion,
    tokenTail: token.slice(-8),
  });
  const device = registerDevice({ userId, deviceId, token, platform, appVersion });
  return res.json({ ok: true, device: devicePublicView(device) });
});

app.post('/devices/unregister', requireAuth, requireSignedRequest(buildUnregisterSignaturePayload), (req, res) => {
  const userId = normalizeUserId(req.body?.userId);
  const deviceId = normalizeDeviceId(req.body?.deviceId);
  const token = normalizeTokenInput(req.body?.token);
  if (!userId || !deviceId || !token) {
    return res.status(400).json({ error: 'invalid_payload' });
  }
  const ok = unregisterDevice({ userId, deviceId, token });
  return res.json({ ok });
});

app.get('/devices/by-user/:userId', requireAuth, (req, res) => {
  const userId = normalizeUserId(req.params.userId);
  if (!userId) {
    return res.status(400).json({ error: 'invalid_user_id' });
  }
  const devices = Array.from((devicesByUser.get(userId) || new Map()).values()).map(devicePublicView);
  return res.json({ ok: true, userId, devices });
});

app.post('/events/message', requireAuth, requireSignedRequest(buildEventSignaturePayload), async (req, res) => {
  const senderUserId = normalizeUserId(req.body?.senderUserId);
  const groupId = normalizeStringValue(req.body?.groupId, 256);
  const directPeerId = normalizeUserId(req.body?.directPeerId);
  const scopeId = groupId || directPeerId;
  const eventType = groupId ? 'group_update' : 'direct_update';
  const messageId = normalizeStringValue(req.body?.messageId, 256);
  const schemaVersion = normalizeStringValue(req.body?.schemaVersion, 32) || 'push-v1';
  const recipientUserIds = Array.isArray(req.body?.recipientUserIds)
    ? [...new Set(req.body.recipientUserIds.map((value) => normalizeUserId(value)).filter(Boolean))]
    : [];
  const relay = req.body?.relay && typeof req.body.relay === 'object'
    ? {
        serverId: normalizeStringValue(req.body.relay.serverId, 256),
        scopeKind: normalizeStringValue(req.body.relay.scopeKind, 32)?.toLowerCase(),
        blobId: normalizeStringValue(req.body.relay.blobId, 256),
        relayMessageId: normalizeStringValue(req.body.relay.relayMessageId, 256),
      }
    : null;
  if (!senderUserId || !scopeId || !messageId || recipientUserIds.length === 0) {
    return res.status(400).json({ error: 'invalid_payload' });
  }
  if (schemaVersion === 'push-v1.1' && (!relay?.serverId || !relay?.scopeKind)) {
    return res.status(400).json({ error: 'invalid_relay_metadata' });
  }
  console.log('[push][event][incoming]', {
    senderUserId,
    groupId,
    directPeerId,
    messageId,
    eventType,
    schemaVersion,
    relay,
    recipientUserIds,
  });
  const eventBody = {
    token: 'virtual:event',
    data: {
      type: eventType,
      ...(groupId ? { groupId } : { directPeerId }),
      lastSeq: messageId,
    },
  };
  const dedup = tryAcquireDedup(eventBody);
  if (dedup.deduped) {
    return res.json({ ok: true, deduped: true, sent: 0, failed: 0 });
  }

  const targets = getActiveTokensForUsers(recipientUserIds);
  console.log('[push][event][targets]', {
    scopeId,
    eventType,
    messageId,
    recipients: recipientUserIds.length,
    devices: targets.map((target) => ({
      userId: target.userId,
      deviceId: target.deviceId,
      tokenTail: target.token.slice(-8),
    })),
  });
  let sent = 0;
  let failed = 0;
  for (const target of targets) {
    try {
      await sendFcm({
        token: target.token,
        notification: {
          title: 'PeerLink',
          body: 'Новое сообщение',
        },
        data: {
          type: eventType,
          ...(groupId ? { groupId } : { directPeerId }),
          lastSeq: messageId,
          senderUserId,
          schemaVersion,
          relayServerId: relay?.serverId || '',
          relayScopeKind: relay?.scopeKind || '',
          relayBlobId: relay?.blobId || '',
          relayMessageId: relay?.relayMessageId || '',
          ts: String(Date.now()),
        },
      });
      sent += 1;
    } catch (error) {
      failed += 1;
      console.warn(
        `[push] send failed userId=${target.userId} deviceId=${target.deviceId} scopeId=${scopeId} messageId=${messageId}:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  return res.json({
    ok: true,
    provider: 'fcm',
    deduped: false,
    recipients: recipientUserIds.length,
    devices: targets.length,
    sent,
    failed,
  });
});

app.listen(PORT, () => {
  console.log(`[push] listening on :${PORT}`);
  console.log(
    `[push] config bearer=${Boolean(API_TOKEN)} fcmProject=${FCM_PROJECT_ID || '-'} dedupTtl=${DEDUP_TTL_SECONDS}s`,
  );
});
