// SPDX-License-Identifier: AGPL-3.0-only

import crypto from 'crypto';

function normalizeIdentitySchemaVersion(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function base64UrlNoPadding(bytes) {
  return Buffer.from(bytes)
    .toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
}

function derivePeerIdV2(signingPubB64, identityNonce) {
  const payload = Buffer.from(
    `uid:v2:${signingPubB64}:${identityNonce}`,
    'utf8',
  );
  return base64UrlNoPadding(crypto.createHash('sha256').update(payload).digest()).slice(0, 32);
}

function identityProofPayload({ peerId, signingPubB64, identityNonce }) {
  return Buffer.from(
    `peerlink_identity_binding_v2|${peerId}|${signingPubB64}|${identityNonce}`,
    'utf8',
  );
}

export function createIdentityBindingService({
  observability,
  normalizeStringValue,
  verifyEd25519Signature,
  logger = console,
}) {
  function readIdentityBindingFields(body) {
    const schemaVersion = normalizeIdentitySchemaVersion(
      body?.identitySchemaVersion,
    );
    const identityNonce = normalizeStringValue(body?.identityNonce, 256);
    const identityProofSig = normalizeStringValue(body?.identityProofSig, 1024);
    if (!schemaVersion && !identityNonce && !identityProofSig) {
      return null;
    }
    if (schemaVersion !== 2 || !identityNonce || !identityProofSig) {
      return { ok: false, error: 'invalid_identity_binding_fields' };
    }
    return { ok: true, schemaVersion, identityNonce, identityProofSig };
  }

  async function verifyAndBindPeerIdentity({
    peerId,
    signingPubB64,
    body,
    source,
  }) {
    const fields = readIdentityBindingFields(body);
    if (!fields) {
      return { ok: true, legacy: true };
    }
    if (!fields.ok) {
      return fields;
    }
    const derivedPeerId = derivePeerIdV2(signingPubB64, fields.identityNonce);
    if (derivedPeerId !== peerId) {
      return { ok: false, error: 'identity_peer_id_mismatch' };
    }
    const proofOk = verifyEd25519Signature({
      payloadBytes: identityProofPayload({
        peerId,
        signingPubB64,
        identityNonce: fields.identityNonce,
      }),
      signatureB64: fields.identityProofSig,
      signingPubB64,
    });
    if (!proofOk) {
      return { ok: false, error: 'invalid_identity_proof' };
    }
    const existing = await observability.peerIdentityBinding(peerId);
    if (existing && existing.signingPub !== signingPubB64) {
      logger.warn('[push][identity] binding conflict', {
        peerId,
        source,
        existingSource: existing.source,
      });
      return { ok: false, error: 'identity_binding_conflict' };
    }
    const stored = await observability.upsertPeerIdentityBinding({
      peerId,
      signingPub: signingPubB64,
      identityNonce: fields.identityNonce,
      schemaVersion: fields.schemaVersion,
      source,
    });
    if (!stored) {
      return { ok: false, error: 'identity_binding_conflict' };
    }
    return { ok: true, legacy: false };
  }

  async function enforcePeerIdentityBinding({ peerId, signingPubB64, source }) {
    const existing = await observability.peerIdentityBinding(peerId);
    if (!existing) {
      return { ok: true, legacy: true };
    }
    if (existing.signingPub !== signingPubB64) {
      logger.warn('[push][identity] signed request rejected for binding mismatch', {
        peerId,
        source,
      });
      return { ok: false, error: 'identity_binding_mismatch' };
    }
    await observability.upsertPeerIdentityBinding({
      peerId: existing.peerId,
      signingPub: existing.signingPub,
      identityNonce: existing.identityNonce,
      schemaVersion: existing.schemaVersion,
      source,
    });
    return { ok: true, legacy: false };
  }

  return {
    readIdentityBindingFields,
    verifyAndBindPeerIdentity,
    enforcePeerIdentityBinding,
  };
}
