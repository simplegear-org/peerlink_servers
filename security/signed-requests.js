// SPDX-License-Identifier: AGPL-3.0-only

import crypto from 'crypto';

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function parseBase64(input) {
  if (typeof input !== 'string') return null;
  try {
    return Buffer.from(input, 'base64');
  } catch (_) {
    return null;
  }
}

export function verifyEd25519Signature({
  payloadBytes,
  signatureB64,
  signingPubB64,
}) {
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

export function createSignedRequestVerifier({
  skewSeconds,
  signedIdTtlSeconds,
  normalizeStringValue,
  logger = console,
}) {
  const signedRequestIds = new Map();

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
    const ttlSeconds =
      Number.isFinite(signedIdTtlSeconds) && signedIdTtlSeconds > 0
        ? signedIdTtlSeconds
        : 300;
    signedRequestIds.set(id, Date.now() + ttlSeconds * 1000);
    return true;
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
      if (Math.abs(nowSec - tsSec) > skewSeconds) {
        logger.warn('[push][sig] signature_timestamp_skew', {
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
        logger.warn('[push][sig] invalid signature', {
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

  return {
    requireSignedRequest,
    cleanupSignedRequestIds,
    replayCacheSize: () => signedRequestIds.size,
  };
}
