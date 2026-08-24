// SPDX-License-Identifier: AGPL-3.0-only

import express from 'express';
import crypto from 'crypto';
import http2 from 'http2';
import { GoogleAuth } from 'google-auth-library';
import { sourceInfo } from './source-info.js';
import { PushObservability } from './observability.js';

const app = express();
app.use(express.json({ limit: process.env.PUSH_BODY_LIMIT || '2mb' }));
const sourceMetadata = sourceInfo();

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
const MODERATION_ADMIN_TOKEN = (process.env.MODERATION_ADMIN_TOKEN || API_TOKEN).trim();
const MODERATION_WARNING_REPORT_THRESHOLD = positiveInt(
  process.env.MODERATION_WARNING_REPORT_THRESHOLD,
  10,
);
const MODERATION_BAN_REPORT_THRESHOLD = positiveInt(
  process.env.MODERATION_BAN_REPORT_THRESHOLD,
  20,
);
const DEDUP_TTL_SECONDS = Number.parseInt(process.env.PUSH_DEDUP_TTL_SECONDS || '30', 10);
const MAX_DEVICES_PER_USER = Number.parseInt(process.env.PUSH_MAX_DEVICES_PER_USER || '20', 10);
const SIGNATURE_SKEW_SECONDS = Number.parseInt(process.env.PUSH_SIGNATURE_SKEW_SECONDS || '120', 10);
const SIGNED_ID_TTL_SECONDS = Number.parseInt(process.env.PUSH_SIGNED_ID_TTL_SECONDS || '300', 10);

const FCM_PROJECT_ID = (process.env.FCM_PROJECT_ID || '').trim();
const FCM_CREDENTIALS_JSON = (process.env.FCM_CREDENTIALS_JSON || '').trim();
const FCM_SCOPES = ['https://www.googleapis.com/auth/firebase.messaging'];
const APNS_TEAM_ID = (process.env.APNS_TEAM_ID || '').trim();
const APNS_KEY_ID = (process.env.APNS_KEY_ID || '').trim();
const APNS_PRIVATE_KEY = (process.env.APNS_PRIVATE_KEY || '').trim();
const APNS_VOIP_TOPIC = (process.env.APNS_VOIP_TOPIC || '').trim();
const APNS_MESSAGES_TOPIC = (process.env.APNS_MESSAGES_TOPIC || '').trim();
const APNS_USE_SANDBOX = (process.env.APNS_USE_SANDBOX || 'true').trim().toLowerCase() !== 'false';
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

let googleAuthClient = null;
let apnsJwtCache = null;
const dedupCache = new Map(); // dedupKey -> expiresAtMs
const devicesByUser = new Map(); // userId -> Map<deviceId, device>
const tokenToOwner = new Map(); // fcmToken -> { userId, deviceId }
const voipDevicesByUser = new Map(); // userId -> Map<deviceId, voipDevice>
const voipTokenToOwner = new Map(); // voipToken -> { userId, deviceId }
const signedRequestIds = new Map(); // id -> expiresAtMs
const observability = new PushObservability();
await observability.init();

const moderationThresholds = {
  warningThreshold: MODERATION_WARNING_REPORT_THRESHOLD,
  banThreshold: MODERATION_BAN_REPORT_THRESHOLD,
};

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

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

function requireAdminAuth(req, res, next) {
  if (!MODERATION_ADMIN_TOKEN) {
    return res.status(503).json({ error: 'moderation_admin_token_required' });
  }
  const token = parseBearerToken(req.headers.authorization);
  if (token && token === MODERATION_ADMIN_TOKEN) {
    return next();
  }
  console.warn('[push][moderation][auth] unauthorized', {
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

function normalizeVoipTokenInput(token) {
  const normalized = normalizeStringValue(token, 1024);
  if (!normalized) {
    return null;
  }
  return normalized.toLowerCase();
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

function normalizePeerId(value) {
  return normalizeStringValue(value, 128);
}

function normalizeModerationReason(value) {
  const reason = normalizeStringValue(value, 64)?.toLowerCase();
  if (!reason) return null;
  const allowed = new Set(['spam', 'harassment', 'threats', 'illegal_content', 'illegalcontent', 'abusive_behavior', 'abusivebehavior', 'other']);
  if (!allowed.has(reason)) return null;
  if (reason === 'illegalcontent') return 'illegal_content';
  if (reason === 'abusivebehavior') return 'abusive_behavior';
  return reason;
}

function normalizeModerationReport(body) {
  if (!body || typeof body !== 'object') return null;
  const reporterPeerId = normalizePeerId(body.reporterPeerId || body.reporter_peer_id || body.from);
  const reportedPeerId = normalizePeerId(body.reportedPeerId || body.reported_peer_id || body.peerId);
  const reason = normalizeModerationReason(body.reason);
  if (!reporterPeerId || !reportedPeerId || !reason || reporterPeerId === reportedPeerId) return null;
  const clientId = normalizeStringValue(body.id || body.reportId, 256);
  const encryptedContent = body.encryptedContent && typeof body.encryptedContent === 'object'
    ? body.encryptedContent
    : (body.content && typeof body.content === 'object' ? body.content : null);
  const contentEncrypted = Boolean(body.contentEncrypted || encryptedContent);
  return {
    id: clientId || `report_${crypto.randomUUID()}`,
    type: normalizeStringValue(body.type, 64) || 'direct_report',
    reason,
    reporterPeerId,
    reportedPeerId,
    contentEncrypted,
    encryptedContent: encryptedContent ? normalizeJsonValue(encryptedContent) : null,
    clientCreatedAt: normalizeTimestamp(body.createdAt || body.clientCreatedAt),
  };
}

function normalizeTimestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  if (typeof value !== 'string') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function normalizeModerationStatus(value) {
  const status = normalizeStringValue(value, 32)?.toLowerCase();
  if (!status || status === 'all') return 'all';
  return ['pending', 'resolved', 'rejected', 'appealed'].includes(status) ? status : null;
}

function normalizeModerationAction(value) {
  const action = normalizeStringValue(value, 32)?.toLowerCase();
  return ['ignore', 'warn', 'suspend', 'ban', 'resolve', 'reject'].includes(action) ? action : null;
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
  const messageToken = normalizeStringValue(body.messageToken, 4096)
    || normalizeTokenInput(body.token);
  const messageProvider = normalizeStringValue(body.messageProvider, 16)?.toLowerCase() || 'fcm';
  const voipToken = normalizeVoipTokenInput(body.voipToken) || '';
  const platform = normalizePlatform(body.platform);
  const appVersion = normalizeStringValue(body.appVersion, 64) || '';
  if (!userId || !deviceId || !messageToken || !platform) {
    throw new Error('invalid register fields');
  }
  if (normalized.from !== userId) {
    throw new Error('from must match userId');
  }
  return Buffer.from(
    `${normalized.id}|${normalized.from}|${deviceId}|${messageToken}|${messageProvider}|${voipToken}|${platform}|${appVersion}|${normalized.ts}`,
    'utf8',
  );
}

function buildUnregisterSignaturePayload(body, normalized) {
  return buildUnregisterPayload(body, normalized, {
    normalizeToken: normalizeTokenInput,
    invalidMessage: 'invalid unregister fields',
  });
}

function buildUnregisterPayload(body, normalized, { normalizeToken, invalidMessage }) {
  const userId = normalizeUserId(body.userId);
  const deviceId = normalizeDeviceId(body.deviceId);
  const token = normalizeToken(body.token);
  if (!userId || !deviceId || !token) {
    throw new Error(invalidMessage);
  }
  if (normalized.from !== userId) {
    throw new Error('from must match userId');
  }
  return Buffer.from(
    `${normalized.id}|${normalized.from}|${deviceId}|${token}|${normalized.ts}`,
    'utf8',
  );
}

function buildPushPassthroughData(body, {
  fallbackType,
  fallbackTs = Date.now(),
  excludeKeys = [],
} = {}) {
  const source = body && typeof body === 'object' ? body : {};
  const excluded = new Set([
    'id',
    'from',
    'sig',
    'signingPub',
    ...excludeKeys,
  ]);
  const data = {};
  for (const [key, value] of Object.entries(source)) {
    if (excluded.has(key) || value == null) {
      continue;
    }
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      data[key] = String(value);
      continue;
    }
    try {
      data[key] = JSON.stringify(value);
    } catch (_) {}
  }
  if (!data.type && fallbackType) {
    data.type = fallbackType;
  }
  if (!data.ts) {
    data.ts = String(fallbackTs);
  }
  return data;
}

function getObjectField(body, key) {
  return body?.[key] && typeof body[key] === 'object'
    ? body[key]
    : null;
}

function describeFcmTarget(target) {
  return {
    userId: target.userId,
    deviceId: target.deviceId,
    platform: target.platform || '-',
    messageProvider: target.messageProvider || 'fcm',
    tokenTail: target.token.slice(-8),
  };
}

function describeVoipTarget(target) {
  return {
    userId: target.userId,
    deviceId: target.deviceId,
    platform: target.platform || '-',
    voipTokenTail: target.token.slice(-8),
  };
}

function normalizeRecipients(value) {
  return Array.isArray(value)
    ? [...new Set(value.map((item) => normalizeUserId(item)).filter(Boolean))].sort()
    : [];
}

function normalizeJsonValue(value) {
  if (value == null) {
    return null;
  }
  if (Array.isArray(value)) {
    return value.map(normalizeJsonValue);
  }
  if (typeof value === 'object') {
    const sortedKeys = Object.keys(value).sort();
    const normalized = {};
    for (const key of sortedKeys) {
      const trimmedKey = String(key).trim();
      if (!trimmedKey) {
        continue;
      }
      const normalizedValue = normalizeJsonValue(value[key]);
      if (normalizedValue !== null && normalizedValue !== undefined) {
        normalized[trimmedKey] = normalizedValue;
      }
    }
    return normalized;
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  return String(value);
}

function normalizeNotification(value) {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const title = normalizeStringValue(value.title, 128);
  const body = normalizeStringValue(value.body, 512);
  if (!title && !body) {
    return null;
  }
  return {
    ...(title ? { title } : {}),
    ...(body ? { body } : {}),
  };
}

function normalizeDelivery(value) {
  const delivery = value && typeof value === 'object' ? value : {};
  return {
    standard: delivery.standard !== false,
    voip: delivery.voip === true,
  };
}

function buildPushEventSignaturePayload(body, normalized) {
  const senderUserId = normalizeUserId(body.senderUserId);
  const recipients = normalizeRecipients(body.recipientUserIds);
  const payload = normalizeJsonValue(body.payload);
  const notification = normalizeNotification(body.notification);
  const delivery = normalizeDelivery(body.delivery);
  if (!senderUserId || recipients.length === 0 || !payload || typeof payload !== 'object') {
    throw new Error('invalid push event fields');
  }
  if (normalized.from !== senderUserId) {
    throw new Error('from must match senderUserId');
  }
  return Buffer.from(
    `${normalized.id}|${normalized.from}|${recipients.join(',')}|${JSON.stringify(payload)}|`
      + `${JSON.stringify(notification || {})}|${delivery.standard}|${delivery.voip}|${normalized.ts}`,
    'utf8',
  );
}

function buildModerationReportSignaturePayload(body, normalized) {
  const report = normalizeModerationReport(body);
  if (!report) {
    throw new Error('invalid moderation report fields');
  }
  if (normalized.from !== report.reporterPeerId) {
    throw new Error('from must match reporterPeerId');
  }
  return Buffer.from(
    `${normalized.id}|${normalized.from}|${report.reportedPeerId}|${report.reason}|`
      + `${report.type}|${report.contentEncrypted}|${JSON.stringify(report.encryptedContent || {})}|${normalized.ts}`,
    'utf8',
  );
}

function buildModerationAppealSignaturePayload(body, normalized) {
  const peerId = normalizePeerId(body?.peerId || body?.reportedPeerId);
  const text = normalizeStringValue(body?.text || body?.message, 4096);
  if (!peerId || !text) {
    throw new Error('invalid moderation appeal fields');
  }
  if (normalized.from !== peerId) {
    throw new Error('from must match peerId');
  }
  return Buffer.from(
    `${normalized.id}|${normalized.from}|${peerId}|${text}|${normalized.ts}`,
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

function registerDevice({ userId, deviceId, token, platform, appVersion, messageProvider = 'fcm' }) {
  return registerDeviceGeneric({
    userId,
    deviceId,
    token,
    platform,
    appVersion,
    messageProvider,
    ensureDevices: ensureUserDevices,
    devicesByUserMap: devicesByUser,
    tokenToOwnerMap: tokenToOwner,
  });
}

function ensureVoipUserDevices(userId) {
  let devices = voipDevicesByUser.get(userId);
  if (!devices) {
    devices = new Map();
    voipDevicesByUser.set(userId, devices);
  }
  return devices;
}

function registerVoipDevice({ userId, deviceId, token, platform, appVersion }) {
  return registerDeviceGeneric({
    userId,
    deviceId,
    token,
    platform,
    appVersion,
    ensureDevices: ensureVoipUserDevices,
    devicesByUserMap: voipDevicesByUser,
    tokenToOwnerMap: voipTokenToOwner,
  });
}

function registerDeviceGeneric({
  userId,
  deviceId,
  token,
  platform,
  appVersion,
  messageProvider,
  ensureDevices,
  devicesByUserMap,
  tokenToOwnerMap,
}) {
  const devices = ensureDevices(userId);
  const now = Date.now();
  const previousOwner = tokenToOwnerMap.get(token);
  if (previousOwner && (previousOwner.userId !== userId || previousOwner.deviceId !== deviceId)) {
    const previousDevices = devicesByUserMap.get(previousOwner.userId);
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
      if (tokenToOwnerMap.get(oldest.token)?.deviceId === oldest.deviceId) {
        tokenToOwnerMap.delete(oldest.token);
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
    messageProvider: messageProvider || 'fcm',
    enabled: true,
    lastSeenAt: now,
    updatedAt: now,
    createdAt: existing?.createdAt ?? now,
  };
  devices.set(deviceId, device);
  tokenToOwnerMap.set(token, { userId, deviceId });
  return device;
}

function unregisterDevice({ userId, deviceId, token }) {
  return unregisterDeviceGeneric({
    userId,
    deviceId,
    token,
    devicesByUserMap: devicesByUser,
    tokenToOwnerMap: tokenToOwner,
  });
}

function unregisterVoipDevice({ userId, deviceId, token }) {
  return unregisterDeviceGeneric({
    userId,
    deviceId,
    token,
    devicesByUserMap: voipDevicesByUser,
    tokenToOwnerMap: voipTokenToOwner,
  });
}

function shouldInvalidateVoipToken(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('"reason":"BadDeviceToken"')
    || message.includes('"reason":"Unregistered"');
}

function unregisterDeviceGeneric({ userId, deviceId, token, devicesByUserMap, tokenToOwnerMap }) {
  const devices = devicesByUserMap.get(userId);
  if (!devices) return false;
  const device = devices.get(deviceId);
  if (!device) return false;
  if (device.token !== token) return false;
  device.enabled = false;
  device.updatedAt = Date.now();
  devices.set(deviceId, device);
  if (tokenToOwnerMap.get(token)?.userId === userId && tokenToOwnerMap.get(token)?.deviceId === deviceId) {
    tokenToOwnerMap.delete(token);
  }
  return true;
}

function getActiveTokensForUsers(userIds) {
  return getActiveTokensForUsersFromMap(userIds, devicesByUser);
}

function getActiveVoipTokensForUsers(userIds) {
  return getActiveTokensForUsersFromMap(userIds, voipDevicesByUser);
}

function getActiveTokensForUsersFromMap(userIds, devicesByUserMap) {
  const tokens = [];
  for (const userId of userIds) {
    const devices = devicesByUserMap.get(userId);
    if (!devices) continue;
    for (const device of devices.values()) {
      if (device.enabled && device.token) {
        tokens.push({
          userId,
          deviceId: device.deviceId,
          token: device.token,
          platform: device.platform || '',
          messageProvider: device.messageProvider || 'fcm',
        });
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
  const credentials = parseFcmCredentialsJson();
  googleAuthClient = new GoogleAuth({
    credentials,
    scopes: FCM_SCOPES,
  });
  return googleAuthClient;
}

function parseFcmCredentialsJson() {
  if (!FCM_CREDENTIALS_JSON) {
    return undefined;
  }
  try {
    return JSON.parse(FCM_CREDENTIALS_JSON);
  } catch (error) {
    throw new Error(
      'FCM_CREDENTIALS_JSON is invalid JSON; wrap the service account JSON '
        + 'in single quotes in .env.push.local. '
        + (error instanceof Error ? error.message : String(error)),
    );
  }
}

async function sendFcm({ token, data, notification, android }) {
  const auth = getGoogleAuthClient();
  const accessToken = await auth.getAccessToken();
  if (!accessToken) {
    throw new Error('failed to obtain FCM access token');
  }

  const message = {
    token,
    data: normalizeFcmData(data),
  };
  if (
    notification &&
    typeof notification === 'object' &&
    (typeof notification.title === 'string' || typeof notification.body === 'string')
  ) {
    message.notification = {};
    if (typeof notification.title === 'string') message.notification.title = notification.title;
    if (typeof notification.body === 'string') message.notification.body = notification.body;
    message.apns = {
      payload: {
        aps: {
          badge: 1,
          sound: 'default',
          alert: {
            ...(typeof notification.title === 'string' ? { title: notification.title } : {}),
            ...(typeof notification.body === 'string' ? { body: notification.body } : {}),
          },
        },
      },
    };
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

function normalizeFcmData(data) {
  if (!data || typeof data !== 'object') {
    return {};
  }
  const out = {};
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined || value === null) {
      continue;
    }
    if (typeof value === 'string') {
      out[key] = value;
      continue;
    }
    out[key] = typeof value === 'object' ? JSON.stringify(value) : String(value);
  }
  return out;
}

function hasApnsCredentials() {
  return Boolean(APNS_TEAM_ID && APNS_KEY_ID && APNS_PRIVATE_KEY);
}

function isApnsVoipConfigured() {
  return hasApnsCredentials() && Boolean(normalizeApnsVoipTopic(APNS_VOIP_TOPIC));
}

function normalizeApnsVoipTopic(value) {
  const topic = normalizeStringValue(value, 256);
  if (!topic) return null;
  if (!topic.endsWith('.voip')) {
    return null;
  }
  return topic;
}

function normalizeApnsAlertTopic(value) {
  const topic = normalizeStringValue(value, 256);
  if (!topic) return null;
  if (topic.endsWith('.voip')) {
    return null;
  }
  return topic;
}

function isApnsAlertConfigured() {
  return hasApnsCredentials() && Boolean(normalizeApnsAlertTopic(APNS_MESSAGES_TOPIC));
}

function getApnsJwt() {
  if (!hasApnsCredentials()) {
    throw new Error('apns credentials are not configured');
  }
  const nowSec = Math.floor(Date.now() / 1000);
  if (apnsJwtCache && apnsJwtCache.expiresAtSec > nowSec + 30) {
    return apnsJwtCache.token;
  }
  const header = Buffer.from(
    JSON.stringify({ alg: 'ES256', kid: APNS_KEY_ID }),
    'utf8',
  ).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({ iss: APNS_TEAM_ID, iat: nowSec }),
    'utf8',
  ).toString('base64url');
  const signingInput = `${header}.${payload}`;
  const privateKeyPem = APNS_PRIVATE_KEY.includes('\\n')
    ? APNS_PRIVATE_KEY.replace(/\\n/g, '\n')
    : APNS_PRIVATE_KEY;
  const signer = crypto.createSign('sha256');
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign(privateKeyPem).toString('base64url');
  const token = `${signingInput}.${signature}`;
  apnsJwtCache = {
    token,
    expiresAtSec: nowSec + 50 * 60,
  };
  return token;
}

async function sendApnsVoip({ token, payload, topic }) {
  const jwt = getApnsJwt();
  const host = APNS_USE_SANDBOX ? 'https://api.sandbox.push.apple.com' : 'https://api.push.apple.com';
  const resolvedTopic = normalizeApnsVoipTopic(topic) || normalizeApnsVoipTopic(APNS_VOIP_TOPIC);
  if (!resolvedTopic) {
    throw new Error('apns voip topic is not configured or invalid (must end with .voip)');
  }
  const body = JSON.stringify(payload);
  const response = await new Promise((resolve, reject) => {
    const client = http2.connect(host);
    client.on('error', reject);

    const req = client.request({
      ':method': 'POST',
      ':path': `/3/device/${token}`,
      authorization: `bearer ${jwt}`,
      'apns-push-type': 'voip',
      'apns-priority': '10',
      'apns-topic': resolvedTopic,
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
    });

    let raw = '';
    let status = 0;

    req.setEncoding('utf8');
    req.on('response', (headers) => {
      status = Number(headers[':status'] || 0);
    });
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      client.close();
      resolve({ status, raw });
    });
    req.on('error', (error) => {
      client.close();
      reject(error);
    });

    req.write(body);
    req.end();
  });

  if (response.status < 200 || response.status >= 300) {
    throw new Error(`apns status=${response.status} body=${(response.raw || '').slice(0, 512)}`);
  }
  return { ok: true, provider: 'apns', raw: response.raw || '' };
}

async function sendApnsAlert({ token, payload, topic }) {
  const jwt = getApnsJwt();
  const host = APNS_USE_SANDBOX ? 'https://api.sandbox.push.apple.com' : 'https://api.push.apple.com';
  const resolvedTopic = normalizeApnsAlertTopic(topic) || normalizeApnsAlertTopic(APNS_MESSAGES_TOPIC);
  if (!resolvedTopic) {
    throw new Error('apns alert topic is not configured or invalid');
  }
  const body = JSON.stringify(payload);
  const response = await new Promise((resolve, reject) => {
    const client = http2.connect(host);
    client.on('error', reject);

    const req = client.request({
      ':method': 'POST',
      ':path': `/3/device/${token}`,
      authorization: `bearer ${jwt}`,
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'apns-topic': resolvedTopic,
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
    });

    let raw = '';
    let status = 0;

    req.setEncoding('utf8');
    req.on('response', (headers) => {
      status = Number(headers[':status'] || 0);
    });
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      client.close();
      resolve({ status, raw });
    });
    req.on('error', (error) => {
      client.close();
      reject(error);
    });

    req.write(body);
    req.end();
  });

  if (response.status < 200 || response.status >= 300) {
    throw new Error(`apns status=${response.status} body=${(response.raw || '').slice(0, 512)}`);
  }
  return { ok: true, provider: 'apns', raw: response.raw || '' };
}

app.get('/health', (_req, res) => {
  cleanupDedupCache();
  cleanupSignedRequestIds();
  res.json({
    ok: true,
    source: sourceMetadata,
    providers: {
      fcmConfigured: Boolean(FCM_PROJECT_ID),
      apnsVoipConfigured: isApnsVoipConfigured(),
      apnsVoipTopicConfigured: Boolean(normalizeApnsVoipTopic(APNS_VOIP_TOPIC)),
      apnsAlertConfigured: isApnsAlertConfigured(),
      apnsAlertTopicConfigured: Boolean(normalizeApnsAlertTopic(APNS_MESSAGES_TOPIC)),
      apnsUseSandbox: APNS_USE_SANDBOX,
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
      voipUsers: voipDevicesByUser.size,
      voipTokens: voipTokenToOwner.size,
      maxDevicesPerUser: MAX_DEVICES_PER_USER,
    },
    ts: Date.now(),
  });
});

app.get('/metrics', async (_req, res) => {
  cleanupDedupCache();
  cleanupSignedRequestIds();
  const body = await observability.metrics({
    devicesByUser,
    tokenToOwner,
    voipDevicesByUser,
    voipTokenToOwner,
    dedupCache,
    signedRequestIds,
  });
  res.type('text/plain; version=0.0.4; charset=utf-8').send(body);
});

app.get('/.well-known/peerlink-source', (_req, res) => {
  res.json(sourceMetadata);
});

app.post('/moderation/reports', requireSignedRequest(buildModerationReportSignaturePayload), async (req, res) => {
  const report = normalizeModerationReport(req.body);
  if (!report) {
    return res.status(400).json({ error: 'invalid_moderation_report' });
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
    observability.recordPushEvent({ payload: body.data, delivery: { standard: true, voip: false }, deduped: true });
    return res.json({ ok: true, provider: 'fcm', deduped: true });
  }
  observability.recordPushEvent({ payload: body.data, delivery: { standard: true, voip: false } });
  try {
    const result = await sendFcm({
      token,
      data: body.data,
      notification: body.notification,
      android: body.android,
    });
    observability.recordPushResult({
      payload: body.data,
      deliveryName: 'standard',
      provider: result.provider,
      sent: 1,
      failed: 0,
    });
    return res.json({ ok: true, provider: result.provider });
  } catch (error) {
    observability.recordPushResult({
      payload: body.data,
      deliveryName: 'standard',
      provider: 'fcm',
      sent: 0,
      failed: 1,
    });
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
  const messageToken = normalizeStringValue(req.body?.messageToken, 4096)
    || normalizeTokenInput(req.body?.token);
  const messageProvider = normalizeStringValue(req.body?.messageProvider, 16)?.toLowerCase() || 'fcm';
  const voipToken = normalizeVoipTokenInput(req.body?.voipToken);
  const platform = normalizePlatform(req.body?.platform);
  const appVersion = normalizeStringValue(req.body?.appVersion, 64) || '';
  if (!userId || !deviceId || !messageToken || !platform) {
    return res.status(400).json({ error: 'invalid_payload' });
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
  });
  const device = registerDevice({
    userId,
    deviceId,
    token: messageToken,
    platform,
    appVersion,
    messageProvider,
  });
  if (voipToken) {
    registerVoipDevice({
      userId,
      deviceId,
      token: voipToken,
      platform,
      appVersion,
    });
  }
  observability.recordDeviceRegister({ platform, messageProvider });
  return res.json({ ok: true, device: devicePublicView(device) });
});

app.post('/devices/unregister', requireAuth, requireSignedRequest(buildUnregisterSignaturePayload), (req, res) => {
  const userId = normalizeUserId(req.body?.userId);
  const deviceId = normalizeDeviceId(req.body?.deviceId);
  const token = normalizeTokenInput(req.body?.token);
  if (!userId || !deviceId || !token) {
    return res.status(400).json({ error: 'invalid_payload' });
  }
  const existing = devicesByUser.get(userId)?.get(deviceId);
  const ok = unregisterDevice({ userId, deviceId, token });
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
  const devices = Array.from((devicesByUser.get(userId) || new Map()).values()).map(devicePublicView);
  return res.json({ ok: true, userId, devices });
});

app.post('/events/push', requireAuth, requireSignedRequest(buildPushEventSignaturePayload), async (req, res) => {
  const senderUserId = normalizeUserId(req.body?.senderUserId);
  const recipientUserIds = normalizeRecipients(req.body?.recipientUserIds);
  const payload = normalizeJsonValue(req.body?.payload);
  const notification = normalizeNotification(req.body?.notification);
  const delivery = normalizeDelivery(req.body?.delivery);
  if (!senderUserId || recipientUserIds.length === 0 || !payload || typeof payload !== 'object') {
    return res.status(400).json({ error: 'invalid_payload' });
  }
  const dedupBody = {
    token: `virtual:${senderUserId}`,
    data: {
      type: typeof payload.type === 'string' ? payload.type : 'push',
      groupId: typeof payload.groupId === 'string' ? payload.groupId : '',
      directPeerId: typeof payload.directPeerId === 'string'
        ? payload.directPeerId
        : (typeof payload.calleeUserId === 'string' ? payload.calleeUserId : ''),
      lastSeq: typeof payload.lastSeq === 'string'
        ? payload.lastSeq
        : (typeof payload.callId === 'string' ? payload.callId : ''),
    },
  };
  const dedup = tryAcquireDedup(dedupBody);
  if (dedup.deduped) {
    observability.recordPushEvent({ payload, delivery, deduped: true });
    return res.json({ ok: true, deduped: true, sent: 0, failed: 0 });
  }
  observability.recordPushEvent({ payload, delivery });
  const standardTargets = delivery.standard
    ? getActiveTokensForUsers(recipientUserIds)
    : [];
  const voipTargets = delivery.voip
    ? getActiveVoipTokensForUsers(recipientUserIds)
    : [];
  console.log('[push][event][targets]', {
    senderUserId,
    recipients: recipientUserIds,
    delivery,
    pushKeys: Object.keys(payload),
    standardTargets: standardTargets.map(describeFcmTarget),
    voipTargets: voipTargets.map(describeVoipTarget),
  });
  const voipTopic = delivery.voip ? normalizeApnsVoipTopic(APNS_VOIP_TOPIC) : null;
  let standardSent = 0;
  let standardFailed = 0;
  for (const target of standardTargets) {
    try {
      const hasNotificationText = Boolean(notification?.title || notification?.body);
      const provider = (target.messageProvider || 'fcm').toLowerCase();
      if (provider === 'apns') {
        const apnsTopic = normalizeApnsAlertTopic(APNS_MESSAGES_TOPIC);
        if (!apnsTopic) {
          throw new Error('apns messages topic is not configured');
        }
        await sendApnsAlert({
          token: target.token,
          topic: apnsTopic,
          payload: {
            aps: {
              ...(hasNotificationText
                ? {
                    alert: {
                      ...(notification?.title ? { title: notification.title } : {}),
                      ...(notification?.body ? { body: notification.body } : {}),
                    },
                    sound: 'default',
                    badge: 1,
                  }
                : {
                    'content-available': 1,
                  }),
            },
            ...payload,
          },
        });
      } else {
        await sendFcm({
          token: target.token,
          ...(hasNotificationText
            ? {
                notification: {
                  ...(notification?.title ? { title: notification.title } : {}),
                  ...(notification?.body ? { body: notification.body } : {}),
                },
              }
            : {}),
          data: payload,
        });
      }
      standardSent += 1;
      observability.recordPushResult({
        payload,
        deliveryName: 'standard',
        provider,
        sent: 1,
        failed: 0,
      });
      console.log(
        `[push] standard send ok sender=${senderUserId} userId=${target.userId} deviceId=${target.deviceId} provider=${provider}`,
      );
    } catch (error) {
      standardFailed += 1;
      observability.recordPushResult({
        payload,
        deliveryName: 'standard',
        provider: (target.messageProvider || 'fcm').toLowerCase(),
        sent: 0,
        failed: 1,
      });
      console.warn(
        `[push] standard send failed sender=${senderUserId} userId=${target.userId} deviceId=${target.deviceId}:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  let voipSent = 0;
  let voipFailed = 0;
  if (voipTopic) {
    for (const target of voipTargets) {
      try {
        await sendApnsVoip({
          token: target.token,
          topic: voipTopic,
          payload: {
            aps: {
              'content-available': 1,
            },
            ...payload,
          },
        });
        voipSent += 1;
        observability.recordPushResult({
          payload,
          deliveryName: 'voip',
          provider: 'apns',
          sent: 1,
          failed: 0,
        });
        console.log(
          `[push] voip send ok sender=${senderUserId} userId=${target.userId} deviceId=${target.deviceId}`,
        );
      } catch (error) {
        voipFailed += 1;
        observability.recordPushResult({
          payload,
          deliveryName: 'voip',
          provider: 'apns',
          sent: 0,
          failed: 1,
        });
        if (shouldInvalidateVoipToken(error)) {
          const invalidated = unregisterVoipDevice({
            userId: target.userId,
            deviceId: target.deviceId,
            token: target.token,
          });
          console.warn('[push][event][voip_invalidate]', {
            userId: target.userId,
            deviceId: target.deviceId,
            voipTokenTail: target.token.slice(-8),
            invalidated,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
        console.warn(
          `[push] voip send failed sender=${senderUserId} userId=${target.userId} deviceId=${target.deviceId}:`,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  }
  const sent = standardSent + voipSent;
  const failed = standardFailed + voipFailed;
  const result = {
    ok: true,
    provider: delivery.voip ? 'mixed' : 'standard',
    deduped: false,
    recipients: recipientUserIds.length,
    devices: standardTargets.length + voipTargets.length,
    sent,
    failed,
    details: {
      standard: { sent: standardSent, failed: standardFailed },
      voip: { sent: voipSent, failed: voipFailed },
    },
  };
  if (sent === 0 && failed > 0) {
    return res.status(502).json({
      ...result,
      ok: false,
      error: 'push_send_failed',
    });
  }
  return res.json(result);
});

app.listen(PORT, () => {
  console.log(`[push] listening on :${PORT}`);
  console.log(
    `[push] config bearer=${Boolean(API_TOKEN)} fcmProject=${FCM_PROJECT_ID || '-'} dedupTtl=${DEDUP_TTL_SECONDS}s`,
  );
});
