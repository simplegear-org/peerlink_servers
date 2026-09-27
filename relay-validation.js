// SPDX-License-Identifier: AGPL-3.0-only

import crypto from 'crypto';

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export function normalizePeerIdList(values) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.filter((item) => typeof item === 'string').map((item) => item.trim()).filter(Boolean))].sort();
}

export const envelopeKey = (to, id) => `${to}|${id}`;
export const uploadKey = (id, from, groupId) => `${id}|${from}|${groupId}`;
export const buildAckSignaturePayload = ({ id, from, to, timestampMs }) => Buffer.from(`${id}|${from}|${to}|${timestampMs}`, 'utf8');
export const buildEnvelopeSignaturePayload = ({ id, from, to, timestampMs, ttlSeconds, payloadBytes }) => Buffer.concat([Buffer.from(`${id}|${from}|${to}|${timestampMs}|${ttlSeconds}|`, 'utf8'), payloadBytes]);
export const buildGroupEnvelopeSignaturePayload = ({ id, from, groupId, recipients, timestampMs, ttlSeconds, payloadBytes }) => Buffer.concat([Buffer.from(`${id}|${from}|${groupId}|${recipients.join(',')}|${timestampMs}|${ttlSeconds}|`, 'utf8'), payloadBytes]);
export const buildBlobSignaturePayload = ({ id, from, groupId, fileName, mimeType, timestampMs, ttlSeconds, payloadBytes }) => Buffer.concat([Buffer.from(`${id}|${from}|${groupId}|${fileName}|${(mimeType || '').trim()}|${timestampMs}|${ttlSeconds}|`, 'utf8'), payloadBytes]);
export const buildGroupMembersSignaturePayload = ({ id, from, groupId, ownerPeerId, memberPeerIds, timestampMs, ttlSeconds }) => Buffer.from(`${id}|${from}|${groupId}|${ownerPeerId}|${[...memberPeerIds].sort().join(',')}|${timestampMs}|${ttlSeconds}`, 'utf8');

export const buildGroupAdminDelegationPayload = ({ groupId, adminPeerId, permissions, expiresAtMs, delegationVersion, protectedPeerIds }) => Buffer.from(
  `v1|${groupId}|${adminPeerId}|${[...permissions].sort().join(',')}|${expiresAtMs}|${delegationVersion}|${[...protectedPeerIds].sort().join(',')}`,
  'utf8',
);

export const buildOwnerGroupMembersV2SignaturePayload = ({ id, from, groupId, ownerPeerId, memberPeerIds, timestampMs, ttlSeconds, delegationVersion }) => Buffer.from(
  `v3|${id}|${from}|${groupId}|${ownerPeerId}|${[...memberPeerIds].sort().join(',')}|${timestampMs}|${ttlSeconds}|${delegationVersion}`,
  'utf8',
);

export const buildDelegatedGroupMembersSignaturePayload = ({ id, from, groupId, ownerPeerId, memberPeerIds, timestampMs, ttlSeconds, memberAction, changedPeerIds, delegationVersion, delegationExpiresAtMs, delegationSignature }) => Buffer.from(
  `v2|${id}|${from}|${groupId}|${ownerPeerId}|${[...memberPeerIds].sort().join(',')}|${timestampMs}|${ttlSeconds}|${memberAction}|${[...changedPeerIds].sort().join(',')}|${delegationVersion}|${delegationExpiresAtMs}|${delegationSignature}`,
  'utf8',
);

export function parseBase64(input) {
  if (typeof input !== 'string' || input.length === 0) return null;
  try { return Buffer.from(input, 'base64'); } catch (_) { return null; }
}

export function verifyEd25519Signature({ payloadBytes, signatureB64, signingPubB64 }) {
  const signature = parseBase64(signatureB64);
  const signingPubRaw = parseBase64(signingPubB64);
  if (!signature || !signingPubRaw || signingPubRaw.length !== 32) return false;
  try {
    return crypto.verify(null, payloadBytes, crypto.createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, signingPubRaw]), format: 'der', type: 'spki' }), signature);
  } catch (_) { return false; }
}
