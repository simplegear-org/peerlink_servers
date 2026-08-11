import WebSocket, { WebSocketServer } from 'ws';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';

const PORT = Number.parseInt(process.env.PORT || '3000', 10);
const wss = new WebSocketServer({ port: PORT });
const REGISTER_AUTH_SCHEME = 'peerlink-ed25519-v1';
const REGISTER_MAX_SKEW_MS = 30 * 1000;
const NONCE_TTL_MS = 2 * 60 * 1000;
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/**
 * Map для хранения peerId -> ws-соединение
 * При отключении - удаляем из map
 */
const peers = new Map();
const recentNonces = new Map();

/** peerId -> last seen timestamp ms */
const lastSeenByPeer = new Map();

function send(ws, msgObj) {
  try {
    ws.send(JSON.stringify(msgObj));
  } catch (e) {
    console.warn('Send error', e);
  }
}

function sendError(ws, id, code, message) {
  send(ws, {
    v: '1',
    id: id || `srv-error-${uuidv4()}`,
    type: 'error',
    payload: { code, message },
  });
}

function cleanupExpiredNonces() {
  const now = Date.now();
  for (const [nonce, timestampMs] of recentNonces.entries()) {
    if (now - timestampMs > NONCE_TTL_MS) {
      recentNonces.delete(nonce);
    }
  }
}

function derivePeerIdFromSigningPublicKey(signingPublicKeyBytes) {
  return crypto
    .createHash('sha256')
    .update(signingPublicKeyBytes)
    .digest('base64url')
    .slice(0, 32);
}

function buildRegisterCanonicalPayloadV1(auth) {
  return JSON.stringify({
    purpose: 'bootstrap-register',
    protocol: '1',
    peerId: auth.peerId,
    timestampMs: auth.timestampMs,
    nonce: auth.nonce,
    signingPublicKey: auth.signingPublicKey,
  });
}

function buildRegisterCanonicalPayloadV2(payload, auth) {
  const canonical = {
    purpose: 'bootstrap-register',
    protocol: '1',
    peerId: auth.peerId,
    timestampMs: auth.timestampMs,
    nonce: auth.nonce,
    signingPublicKey: auth.signingPublicKey,
  };

  if (typeof auth.legacyPeerId === 'string' && auth.legacyPeerId.length > 0) {
    canonical.legacyPeerId = auth.legacyPeerId;
  }

  if (auth.identityProfile && typeof auth.identityProfile === 'object') {
    canonical.identityProfile = auth.identityProfile;
  }

  return JSON.stringify(canonical);
}

function verifyRegisterAuth(payload) {
  if (!payload || typeof payload !== 'object') {
    return { ok: false, code: 'INVALID_REGISTER', message: 'register payload is required' };
  }
  if (!payload.peerId) {
    return { ok: false, code: 'INVALID_REGISTER', message: 'peerId is required' };
  }
  const auth = payload.auth;
  if (!auth || typeof auth !== 'object') {
    return { ok: false, code: 'INVALID_REGISTER_AUTH', message: 'auth is required' };
  }
  if (auth.scheme !== REGISTER_AUTH_SCHEME) {
    return { ok: false, code: 'INVALID_REGISTER_AUTH', message: 'unsupported auth scheme' };
  }
  if (auth.peerId !== payload.peerId) {
    return { ok: false, code: 'INVALID_REGISTER_AUTH', message: 'auth peerId mismatch' };
  }
  if (auth.legacyPeerId != null && typeof auth.legacyPeerId !== 'string') {
    return { ok: false, code: 'INVALID_REGISTER_AUTH', message: 'legacyPeerId must be string' };
  }
  if (auth.identityProfile != null && typeof auth.identityProfile !== 'object') {
    return { ok: false, code: 'INVALID_REGISTER_AUTH', message: 'identityProfile must be object' };
  }
  if (
    auth.identityProfile &&
    typeof auth.identityProfile.stableUserId === 'string' &&
    auth.identityProfile.stableUserId !== payload.peerId
  ) {
    return { ok: false, code: 'INVALID_REGISTER_AUTH', message: 'identityProfile stableUserId mismatch' };
  }
  if (typeof auth.timestampMs !== 'number' || !Number.isFinite(auth.timestampMs)) {
    return { ok: false, code: 'INVALID_REGISTER_AUTH', message: 'timestampMs is required' };
  }
  if (typeof auth.nonce !== 'string' || auth.nonce.length < 8) {
    return { ok: false, code: 'INVALID_REGISTER_AUTH', message: 'nonce is required' };
  }
  if (typeof auth.signingPublicKey !== 'string' || typeof auth.signature !== 'string') {
    return { ok: false, code: 'INVALID_REGISTER_AUTH', message: 'signingPublicKey and signature are required' };
  }

  cleanupExpiredNonces();

  const now = Date.now();
  if (Math.abs(now - auth.timestampMs) > REGISTER_MAX_SKEW_MS) {
    return { ok: false, code: 'INVALID_REGISTER_AUTH', message: 'timestamp outside allowed skew window' };
  }
  if (recentNonces.has(auth.nonce)) {
    return { ok: false, code: 'INVALID_REGISTER_AUTH', message: 'nonce already used' };
  }

  let signingPublicKeyBytes;
  let signatureBytes;
  try {
    signingPublicKeyBytes = Buffer.from(auth.signingPublicKey, 'base64');
    signatureBytes = Buffer.from(auth.signature, 'base64');
  } catch (error) {
    return { ok: false, code: 'INVALID_REGISTER_AUTH', message: `invalid base64 auth fields: ${error.message}` };
  }

  if (signingPublicKeyBytes.length !== 32) {
    return { ok: false, code: 'INVALID_REGISTER_AUTH', message: 'invalid signing public key length' };
  }

  const spkiDer = Buffer.concat([ED25519_SPKI_PREFIX, signingPublicKeyBytes]);
  let publicKey;
  try {
    publicKey = crypto.createPublicKey({
      key: spkiDer,
      format: 'der',
      type: 'spki',
    });
  } catch (error) {
    return { ok: false, code: 'INVALID_REGISTER_AUTH', message: `invalid public key: ${error.message}` };
  }

  const canonicalPayloadV2 = buildRegisterCanonicalPayloadV2(payload, auth);
  let verified = crypto.verify(
    null,
    Buffer.from(canonicalPayloadV2, 'utf8'),
    publicKey,
    signatureBytes,
  );
  if (!verified) {
    const canonicalPayloadV1 = buildRegisterCanonicalPayloadV1(auth);
    verified = crypto.verify(
      null,
      Buffer.from(canonicalPayloadV1, 'utf8'),
      publicKey,
      signatureBytes,
    );
  }
  if (!verified) {
    return { ok: false, code: 'INVALID_REGISTER_AUTH', message: 'signature verification failed' };
  }

  recentNonces.set(auth.nonce, auth.timestampMs);
  return {
    ok: true,
    peerId: payload.peerId,
  };
}

function cleanupOfflinePeers() {
  const now = Date.now();
  for (const [peerId, ws] of peers.entries()) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      peers.delete(peerId);
      lastSeenByPeer.set(peerId, now);
    }
  }
}

function getOnlinePeerIds() {
  cleanupOfflinePeers();
  return Array.from(peers.keys());
}

function buildLastSeenPayload() {
  const payload = {};
  for (const [peerId, lastSeenMs] of lastSeenByPeer.entries()) {
    payload[peerId] = lastSeenMs;
  }
  return payload;
}

function sendPeersSnapshot(ws, id = null) {
  send(ws, {
    v: '1',
    id: id || `srv-peers-${uuidv4()}`,
    type: 'peers',
    payload: {
      peers: getOnlinePeerIds(),
      lastSeenMsByPeer: buildLastSeenPayload(),
    },
  });
}

function broadcastPresenceUpdate({ peerId, status, lastSeenMs = null, exceptWs = null }) {
  const recipients = new Set(peers.values());
  for (const targetWs of recipients) {
    if (!targetWs || targetWs.readyState !== WebSocket.OPEN || targetWs === exceptWs) {
      continue;
    }
    send(targetWs, {
      v: '1',
      id: `srv-presence-update-${uuidv4()}`,
      type: 'presence_update',
      payload: {
        peerId,
        status,
        ...(typeof lastSeenMs === 'number' ? { lastSeenMs } : {}),
      },
    });
  }
}

wss.on('connection', (ws) => {
  // Состояние соединения: ожидает регистрации
  let registeredPeerId = null;

  ws.on('message', (message) => {
    let frame;
    try {
      const raw = typeof message === 'string' ? message : message.toString('utf8');
      frame = JSON.parse(raw);
    } catch (e) {
      sendError(ws, null, 'INVALID_JSON', 'Invalid JSON format');
      return;
    }

    const { v, id, type, payload } = frame;

    // Проверка версии протокола
    if (v !== '1') {
      sendError(ws, id, 'INVALID_VERSION', 'Unsupported protocol version');
      return;
    }

    switch (type) {
      case 'register': {
        const registerAuth = verifyRegisterAuth(payload);
        if (!registerAuth.ok) {
          sendError(ws, id, registerAuth.code, registerAuth.message);
          return;
        }
        const peerId = registerAuth.peerId;

        const existingWs = peers.get(peerId);
        if (existingWs && existingWs !== ws) {
          try {
            sendError(
              existingWs,
              `srv-error-${uuidv4()}`,
              'SESSION_REPLACED',
              'Session replaced by a new authenticated register',
            );
            existingWs.close(4001, 'Session replaced');
          } catch (error) {
            console.warn('Failed to close replaced session', error);
          }
        }

        // Сохраняем связь peerId -> ws
        peers.set(peerId, ws);
        registeredPeerId = peerId;
        lastSeenByPeer.delete(peerId);

        // Ответ register_ack
        send(ws, {
          v: '1',
          id: `srv-ack-${uuidv4()}`,
          type: 'register_ack',
          payload: {
            peerId,
            sessionId: null, // необязательно
          },
        });
        // Push-событие online для остальных.
        broadcastPresenceUpdate({ peerId, status: 'online', exceptWs: ws });
        break;
      }

      case 'signal':
        if (!registeredPeerId) {
          sendError(ws, id, 'NOT_REGISTERED', 'Register before sending signals');
          return;
        }
        if (!payload || !payload.to) {
          sendError(ws, id, 'INVALID_SIGNAL', 'Missing "to" in payload');
          return;
        }
        // Находим получателя
        const receiverWs = peers.get(payload.to);
        if (!receiverWs || receiverWs.readyState !== WebSocket.OPEN) {
          sendError(ws, id, 'PEER_NOT_FOUND', `Peer ${payload.to} not connected`);
          return;
        }

        // Переправляем signal на получателя
        send(receiverWs, {
          v: '1',
          id: `srv-signal-${uuidv4()}`,
          type: 'signal',
          payload,
        });
        break;

      case 'ping':
        if (!registeredPeerId) {
          sendError(ws, id, 'NOT_REGISTERED', 'Register before sending ping');
          return;
        }
        // Отвечаем pong с peerId
        send(ws, {
          v: '1',
          id: `srv-pong-${uuidv4()}`,
          type: 'pong',
          payload: {
            peerId: registeredPeerId,
          },
        });
        break;

      case 'peers_request':
        if (!registeredPeerId) {
          sendError(ws, id, 'NOT_REGISTERED', 'Register before peers_request');
          return;
        }
        // Стабильный snapshot: только реально онлайн peers + lastSeenMs с сервера.
        sendPeersSnapshot(ws, `srv-peers-${uuidv4()}`);
        break;

      default:
        sendError(ws, id, 'UNKNOWN_TYPE', `Unknown frame type: ${type}`);
    }
  });

  ws.on('close', () => {
    if (registeredPeerId && peers.get(registeredPeerId) === ws) {
      peers.delete(registeredPeerId);
      const lastSeenMs = Date.now();
      lastSeenByPeer.set(registeredPeerId, lastSeenMs);
      broadcastPresenceUpdate({
        peerId: registeredPeerId,
        status: 'offline',
        lastSeenMs,
        exceptWs: ws,
      });
    }
  });

  ws.on('error', (err) => {
    console.error('WebSocket error', err);
  });
});

console.log(`Bootstrap signaling server running on ws://localhost:${PORT}`);
