// SPDX-License-Identifier: AGPL-3.0-only

import express from 'express';
import crypto from 'crypto';
import { sourceInfo } from './source-info.js';
import { PushObservability } from './observability.js';
import {
  createDeviceRegistry,
  shouldInvalidateVoipToken,
} from './devices/registry.js';
import { registerDeviceRoutes } from './devices/routes.js';
import { createDedupCache } from './delivery/dedup-cache.js';
import { createPushProviders } from './delivery/providers.js';
import { registerModerationRoutes } from './moderation/routes.js';
import { createIdentityBindingService } from './security/identity-bindings.js';
import {
  createSignedRequestVerifier,
  verifyEd25519Signature,
} from './security/signed-requests.js';

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
const DEDUP_TTL_SECONDS = Number.parseInt(process.env.PUSH_DEDUP_TTL_SECONDS || '30', 10);
const MAX_DEVICES_PER_USER = Number.parseInt(process.env.PUSH_MAX_DEVICES_PER_USER || '20', 10);
const SIGNATURE_SKEW_SECONDS = Number.parseInt(process.env.PUSH_SIGNATURE_SKEW_SECONDS || '120', 10);
const SIGNED_ID_TTL_SECONDS = Number.parseInt(process.env.PUSH_SIGNED_ID_TTL_SECONDS || '300', 10);
const MODERATION_STATUS_SIGNING_PRIVATE_KEY = (process.env.MODERATION_STATUS_SIGNING_PRIVATE_KEY || '').trim();

const FCM_PROJECT_ID = (process.env.FCM_PROJECT_ID || '').trim();
const FCM_CREDENTIALS_JSON = (process.env.FCM_CREDENTIALS_JSON || '').trim();
const APNS_TEAM_ID = (process.env.APNS_TEAM_ID || '').trim();
const APNS_KEY_ID = (process.env.APNS_KEY_ID || '').trim();
const APNS_PRIVATE_KEY = (process.env.APNS_PRIVATE_KEY || '').trim();
const APNS_VOIP_TOPIC = (process.env.APNS_VOIP_TOPIC || '').trim();
const APNS_MESSAGES_TOPIC = (process.env.APNS_MESSAGES_TOPIC || '').trim();
const APNS_USE_SANDBOX = (process.env.APNS_USE_SANDBOX || 'true').trim().toLowerCase() !== 'false';

const deviceRegistry = createDeviceRegistry({ maxDevicesPerUser: MAX_DEVICES_PER_USER });
const dedup = createDedupCache({
  ttlSeconds: DEDUP_TTL_SECONDS,
  normalizeTokenInput,
});
const pushProviders = createPushProviders({
  fcmProjectId: FCM_PROJECT_ID,
  fcmCredentialsJson: FCM_CREDENTIALS_JSON,
  apnsTeamId: APNS_TEAM_ID,
  apnsKeyId: APNS_KEY_ID,
  apnsPrivateKey: APNS_PRIVATE_KEY,
  apnsVoipTopic: APNS_VOIP_TOPIC,
  apnsMessagesTopic: APNS_MESSAGES_TOPIC,
  apnsUseSandbox: APNS_USE_SANDBOX,
  normalizeStringValue,
});
const observability = new PushObservability();
await observability.init();
const signedRequests = createSignedRequestVerifier({
  skewSeconds: SIGNATURE_SKEW_SECONDS,
  signedIdTtlSeconds: SIGNED_ID_TTL_SECONDS,
  normalizeStringValue,
});
const { requireSignedRequest } = signedRequests;
const identityBindings = createIdentityBindingService({
  observability,
  normalizeStringValue,
  verifyEd25519Signature,
});
const {
  readIdentityBindingFields,
  verifyAndBindPeerIdentity,
  enforcePeerIdentityBinding,
} = identityBindings;
const signModerationStatus = createModerationStatusSigner(MODERATION_STATUS_SIGNING_PRIVATE_KEY);
const notifyModerationPolicy = createModerationPolicyNotifier({
  deviceRegistry,
  pushProviders,
  signModerationStatus,
});

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function rawPublicKeyB64(publicKey) {
  const spkiPrefix = Buffer.from('302a300506032b6570032100', 'hex');
  const der = publicKey.export({ type: 'spki', format: 'der' });
  return der.subarray(spkiPrefix.length).toString('base64');
}

function createModerationStatusSigner(privateKeyValue) {
  if (!privateKeyValue) return null;
  let privateKey;
  try {
    privateKey = privateKeyValue.includes('BEGIN PRIVATE KEY')
      ? crypto.createPrivateKey(privateKeyValue)
      : crypto.createPrivateKey({
          key: Buffer.from(privateKeyValue, 'base64'),
          format: 'der',
          type: 'pkcs8',
        });
  } catch (error) {
    console.warn('[push][moderation] invalid status signing key:', error instanceof Error ? error.message : String(error));
    return null;
  }
  const publicKey = crypto.createPublicKey(privateKey);
  const signingPub = rawPublicKeyB64(publicKey);
  const statusTimestamp = (value) => {
    if (!value) return '';
    if (value instanceof Date) return value.toISOString();
    return String(value);
  };
  return (score) => {
    const issuedAt = new Date().toISOString();
    const warningIssuedAt = statusTimestamp(score.warningIssuedAt);
    const bannedAt = statusTimestamp(score.bannedAt);
    const payload = [
      'peerlink_moderation_status_v1',
      score.peerId || '',
      score.policyState || 'clear',
      String(score.reportCount || 0),
      warningIssuedAt,
      bannedAt,
      issuedAt,
    ].join('|');
    return {
      schema: 'peerlink_moderation_status_v1',
      peerId: score.peerId,
      policyState: score.policyState || 'clear',
      reportCount: score.reportCount || 0,
      warningIssuedAt: warningIssuedAt || null,
      bannedAt: bannedAt || null,
      issuedAt,
      signingPub,
      sig: crypto.sign(null, Buffer.from(payload, 'utf8'), privateKey).toString('base64'),
    };
  };
}

function createModerationPolicyNotifier({
  deviceRegistry,
  pushProviders,
  signModerationStatus,
}) {
  return async function notifyModerationPolicy({ score, action, note }) {
    const peerId = score?.peerId;
    if (!peerId) {
      return { sent: 0, failed: 0, devices: 0 };
    }
    const policyState = score.policyState || (action === 'ban' ? 'banned' : 'warning');
    const signedStatus = signModerationStatus ? signModerationStatus(score) : null;
    const reportCount = Number(score.reportCount || 0);
    const reporterCount = Number(score.reporterCount || 0);
    const messageKey = policyState === 'banned'
      ? 'moderationBanMessage'
      : policyState === 'warning'
        ? 'moderationWarningMessage'
        : 'moderationUnbanMessage';
    const payload = {
      type: 'moderation_policy',
      peerId,
      policyState,
      action,
      messageKey,
      reportCount: String(reportCount),
      reporterCount: String(reporterCount),
      message: policyState === 'banned'
        ? `Your PeerLink X account has been blocked after ${reportCount} reports from ${reporterCount} users. You can submit an appeal in the app.`
        : policyState === 'warning'
          ? `Your PeerLink X account received ${reportCount} reports from ${reporterCount} users and may be blocked if more reports are received.`
          : 'Your PeerLink X account has been unblocked.',
      ...(note ? { moderatorNote: note } : {}),
      ...(signedStatus ? { signedStatus } : {}),
    };
    const standardTargets = deviceRegistry.getActiveTokensForUsers([peerId]);
    const voipTargets = deviceRegistry.getActiveVoipTokensForUsers([peerId]);
    let sent = 0;
    let failed = 0;
    for (const target of standardTargets) {
      try {
        const provider = (target.messageProvider || 'fcm').toLowerCase();
        if (provider === 'apns') {
          const topic = pushProviders.normalizeApnsAlertTopic(APNS_MESSAGES_TOPIC);
          if (!topic) throw new Error('apns messages topic is not configured');
          await pushProviders.sendApnsBackground({
            token: target.token,
            topic,
            payload: {
              aps: {
                'content-available': 1,
              },
              ...payload,
            },
          });
        } else {
          await pushProviders.sendFcm({
            token: target.token,
            data: payload,
          });
        }
        sent += 1;
      } catch (error) {
        failed += 1;
        console.warn(
          `[push][moderation] policy push failed peerId=${peerId} deviceId=${target.deviceId}:`,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    const voipTopic = pushProviders.normalizeApnsVoipTopic(APNS_VOIP_TOPIC);
    if (voipTopic) {
      for (const target of voipTargets) {
        try {
          await pushProviders.sendApnsVoip({
            token: target.token,
            topic: voipTopic,
            payload: {
              aps: { 'content-available': 1 },
              ...payload,
            },
          });
          sent += 1;
        } catch (error) {
          failed += 1;
          console.warn(
            `[push][moderation] policy voip push failed peerId=${peerId} deviceId=${target.deviceId}:`,
            error instanceof Error ? error.message : String(error),
          );
        }
      }
    }
    return {
      sent,
      failed,
      devices: standardTargets.length + (voipTopic ? voipTargets.length : 0),
    };
  };
}

function parseBearerToken(authHeader) {
  if (typeof authHeader !== 'string') return null;
  const [scheme, token] = authHeader.split(' ');
  if (!scheme || !token || scheme.toLowerCase() !== 'bearer') {
    return null;
  }
  return token.trim();
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
  return ['pending', 'resolved', 'rejected', 'appealed'].includes(status) ? 'all' : null;
}

function normalizeModerationAction(value) {
  const action = normalizeStringValue(value, 32)?.toLowerCase();
  return ['warn', 'ban', 'unban'].includes(action) ? action : null;
}

function normalizeDeviceId(value) {
  return normalizeStringValue(value, 256);
}

function normalizePlatform(value) {
  const platform = normalizeStringValue(value, 32);
  if (!platform) return null;
  return platform.toLowerCase();
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
  const identityFields = readIdentityBindingFields(body);
  if (!userId || !deviceId || !messageToken || !platform) {
    throw new Error('invalid register fields');
  }
  if (identityFields && !identityFields.ok) {
    throw new Error(identityFields.error);
  }
  if (normalized.from !== userId) {
    throw new Error('from must match userId');
  }
  const identitySuffix = identityFields
    ? `|${identityFields.schemaVersion}|${identityFields.identityNonce}|${identityFields.identityProofSig}`
    : '';
  return Buffer.from(
    `${normalized.id}|${normalized.from}|${deviceId}|${messageToken}|${messageProvider}|${voipToken}|${platform}|${appVersion}${identitySuffix}|${normalized.ts}`,
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

app.get('/health', async (_req, res) => {
  dedup.cleanup();
  signedRequests.cleanupSignedRequestIds();
  res.json({
    ok: true,
    source: sourceMetadata,
    providers: {
      fcmConfigured: Boolean(FCM_PROJECT_ID),
      apnsVoipConfigured: pushProviders.isApnsVoipConfigured(),
      apnsVoipTopicConfigured: Boolean(pushProviders.normalizeApnsVoipTopic(APNS_VOIP_TOPIC)),
      apnsAlertConfigured: pushProviders.isApnsAlertConfigured(),
      apnsAlertTopicConfigured: Boolean(pushProviders.normalizeApnsAlertTopic(APNS_MESSAGES_TOPIC)),
      apnsUseSandbox: APNS_USE_SANDBOX,
    },
    security: {
      bearerEnabled: Boolean(API_TOKEN),
    },
    dedup: {
      ttlSeconds: DEDUP_TTL_SECONDS,
      cacheSize: dedup.cache.size,
    },
    signature: {
      requiredForWrite: true,
      skewSeconds: SIGNATURE_SKEW_SECONDS,
      signedIdTtlSeconds: SIGNED_ID_TTL_SECONDS,
      replayCacheSize: signedRequests.replayCacheSize(),
    },
    identityBindings: {
      verifiedPeers: await observability.peerIdentityBindingCount(),
      mode: 'soft',
    },
    devices: deviceRegistry.stats(),
    ts: Date.now(),
  });
});

app.get('/metrics', async (_req, res) => {
  dedup.cleanup();
  signedRequests.cleanupSignedRequestIds();
  const body = await observability.metrics({
    ...deviceRegistry.maps,
    dedupCache: dedup.cache,
    signedRequestReplayCacheSize: signedRequests.replayCacheSize(),
  });
  res.type('text/plain; version=0.0.4; charset=utf-8').send(body);
});

app.get('/.well-known/peerlink-source', (_req, res) => {
  res.json(sourceMetadata);
});

registerModerationRoutes({
  app,
  requireSignedRequest,
  requireAdminAuth,
  buildModerationReportSignaturePayload,
  buildModerationAppealSignaturePayload,
  enforcePeerIdentityBinding,
  observability,
  signModerationStatus,
  notifyModerationPolicy,
  normalizeModerationReport,
  normalizeModerationStatus,
  normalizeModerationAction,
  normalizePeerId,
  normalizeStringValue,
  positiveInt,
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
  const dedupResult = dedup.tryAcquire(body);
  if (dedupResult.deduped) {
    observability.recordPushEvent({ payload: body.data, delivery: { standard: true, voip: false }, deduped: true });
    return res.json({ ok: true, provider: 'fcm', deduped: true });
  }
  observability.recordPushEvent({ payload: body.data, delivery: { standard: true, voip: false } });
  try {
    const result = await pushProviders.sendFcm({
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

registerDeviceRoutes({
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
  const binding = await enforcePeerIdentityBinding({
    peerId: senderUserId,
    signingPubB64: req.body.signingPub,
    source: 'events_push',
  });
  if (!binding.ok) {
    return res.status(401).json({ error: binding.error });
  }
  if (await observability.isPeerBanned(senderUserId)) {
    return res.status(403).json({ error: 'peer_banned' });
  }
  const allowedRecipients = await observability.filterAllowedPeers(recipientUserIds);
  if (allowedRecipients.allowed.length === 0) {
    return res.status(403).json({
      ok: false,
      error: 'all_recipients_banned',
      bannedRecipients: allowedRecipients.banned,
    });
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
  const dedupResult = dedup.tryAcquire(dedupBody);
  if (dedupResult.deduped) {
    observability.recordPushEvent({ payload, delivery, deduped: true });
    return res.json({ ok: true, deduped: true, sent: 0, failed: 0 });
  }
  observability.recordPushEvent({ payload, delivery });
  const standardTargets = delivery.standard
    ? deviceRegistry.getActiveTokensForUsers(allowedRecipients.allowed)
    : [];
  const voipTargets = delivery.voip
    ? deviceRegistry.getActiveVoipTokensForUsers(allowedRecipients.allowed)
    : [];
  console.log('[push][event][targets]', {
    senderUserId,
    recipients: allowedRecipients.allowed,
    bannedRecipients: allowedRecipients.banned,
    delivery,
    pushKeys: Object.keys(payload),
    standardTargets: standardTargets.map(describeFcmTarget),
    voipTargets: voipTargets.map(describeVoipTarget),
  });
  const voipTopic = delivery.voip ? pushProviders.normalizeApnsVoipTopic(APNS_VOIP_TOPIC) : null;
  let standardSent = 0;
  let standardFailed = 0;
  for (const target of standardTargets) {
    try {
      const hasNotificationText = Boolean(notification?.title || notification?.body);
      const platform = (target.platform || '').toLowerCase();
      const isCallInvite = payload.type === 'call_invite';
      const isMessageUpdate = payload.type === 'direct_update' || payload.type === 'group_update';
      const isAndroidTarget = platform === 'android';
      const isIosTarget = platform === 'ios';
      const isAppleTarget = platform === 'ios' || platform === 'macos';
      const useNativeMessageFilter = isMessageUpdate && isAndroidTarget;
      const useIosSilentMessageFilter = isMessageUpdate && isIosTarget;
      const provider = (target.messageProvider || 'fcm').toLowerCase();
      const hasVoipTokenForDevice = isCallInvite && isAppleTarget && delivery.voip && voipTopic
        ? deviceRegistry.hasActiveVoipTokenForDevice({
            userId: target.userId,
            deviceId: target.deviceId,
          })
        : false;
      if (hasVoipTokenForDevice) {
        console.log(
          `[push] standard call skip sender=${senderUserId} userId=${target.userId} deviceId=${target.deviceId} platform=${platform} reason=voip_token_registered`,
        );
        continue;
      }
      if (provider === 'apns') {
        const apnsTopic = pushProviders.normalizeApnsAlertTopic(APNS_MESSAGES_TOPIC);
        if (!apnsTopic) {
          throw new Error('apns messages topic is not configured');
        }
        await pushProviders.sendApnsAlert({
          token: target.token,
          topic: apnsTopic,
          payload: {
            aps: {
              ...(hasNotificationText && !useIosSilentMessageFilter
                ? {
                    alert: {
                      ...(notification?.title ? { title: notification.title } : {}),
                      ...(notification?.body ? { body: notification.body } : {}),
                    },
                    sound: 'default',
                    badge: 1,
                    'mutable-content': 1,
                  }
                : {
                    'content-available': 1,
                  }),
            },
            ...(useIosSilentMessageFilter && notification?.body
              ? { notificationText: notification.body }
              : {}),
            ...payload,
          },
        });
      } else {
        await pushProviders.sendFcm({
          token: target.token,
          ...(hasNotificationText && !useNativeMessageFilter && !useIosSilentMessageFilter
            ? {
                notification: {
                  ...(notification?.title ? { title: notification.title } : {}),
                  ...(notification?.body ? { body: notification.body } : {}),
                },
                ...(isMessageUpdate
                  ? {
                      apns: {
                        mutableContent: true,
                      },
                    }
                  : {}),
              }
            : {}),
          ...(!hasNotificationText || (isMessageUpdate && isAndroidTarget)
            ? {
                android: {
                  priority: 'HIGH',
                },
              }
            : {}),
          ...(useIosSilentMessageFilter
            ? {
                apns: {
                  headers: {
                    'apns-push-type': 'background',
                    'apns-priority': '5',
                  },
                  payload: {
                    aps: {
                      'content-available': 1,
                    },
                  },
                },
            }
            : {}),
          data: {
            ...(useIosSilentMessageFilter && notification?.body
              ? { notificationText: notification.body }
              : {}),
            ...payload,
          },
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
        await pushProviders.sendApnsVoip({
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
          const invalidated = deviceRegistry.unregisterVoipDevice({
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
    recipients: allowedRecipients.allowed.length,
    bannedRecipients: allowedRecipients.banned,
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
