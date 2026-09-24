// SPDX-License-Identifier: AGPL-3.0-only

import crypto from 'crypto';

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const SCHEMA = 'peerlink_routing_authority_descriptor_v1';

function requiredString(value, name, maxLength = 512) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized || normalized.length > maxLength) {
    throw new Error(`invalid ${name}`);
  }
  return normalized;
}

function normalizeBaseUrl(value) {
  const raw = requiredString(value, 'baseUrl', 2048);
  let url;
  try {
    url = new URL(raw);
  } catch (_) {
    throw new Error('invalid baseUrl');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('invalid baseUrl protocol');
  }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('baseUrl must be an origin');
  }
  return url.origin;
}

function normalizeEpoch(value, name) {
  const epoch = Number.parseInt(String(value), 10);
  if (!Number.isFinite(epoch) || epoch <= 0) {
    throw new Error(`invalid ${name}`);
  }
  return epoch;
}

function normalizePublicKey(value) {
  const publicKey = requiredString(value, 'publicKey', 128);
  const bytes = Buffer.from(publicKey, 'base64');
  if (bytes.length !== 32) throw new Error('invalid routing publicKey');
  return publicKey;
}

function normalizeKey(value) {
  if (!value || typeof value !== 'object') throw new Error('invalid routing key');
  const keyId = requiredString(value.keyId, 'keyId', 128);
  const algorithm = requiredString(value.algorithm, 'algorithm', 64);
  if (algorithm !== 'Ed25519') throw new Error('unsupported routing key algorithm');
  const publicKey = normalizePublicKey(value.publicKey);
  const notBefore = normalizeEpoch(value.notBefore, 'key notBefore');
  const notAfter = normalizeEpoch(value.notAfter, 'key notAfter');
  if (notAfter <= notBefore) throw new Error('invalid routing key validity window');
  return { keyId, algorithm, publicKey, notBefore, notAfter };
}

export function parseRoutingAuthorityDescriptor(value) {
  const raw = typeof value === 'string' ? JSON.parse(value) : value;
  if (!raw || typeof raw !== 'object' || raw.schema !== SCHEMA) {
    throw new Error('invalid routing descriptor schema');
  }
  const keys = Array.isArray(raw.keys) ? raw.keys.map(normalizeKey) : [];
  if (keys.length === 0 || keys.length > 3) throw new Error('invalid routing key set');
  if (new Set(keys.map((key) => key.keyId)).size !== keys.length) {
    throw new Error('duplicate routing keyId');
  }
  return {
    schema: SCHEMA,
    authorityId: requiredString(raw.authorityId, 'authorityId', 128),
    baseUrl: normalizeBaseUrl(raw.baseUrl),
    keys,
  };
}

function parsePrivateKey(value) {
  if (!value) return null;
  try {
    const privateKey = value.includes('BEGIN PRIVATE KEY')
      ? crypto.createPrivateKey(value)
      : crypto.createPrivateKey({ key: Buffer.from(value, 'base64'), format: 'der', type: 'pkcs8' });
    if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('routing key must be Ed25519');
    return privateKey;
  } catch (error) {
    throw new Error(`invalid routing private key: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function rawPublicKeyB64(privateKey) {
  const der = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
  return der.subarray(ED25519_SPKI_PREFIX.length).toString('base64');
}

export function createRoutingAuthority({ descriptorJson, privateKeyValue, now = () => Date.now() }) {
  if (!descriptorJson && !privateKeyValue) {
    return { ready: false, descriptor: null, activeKeyId: null, error: null };
  }
  if (!descriptorJson || !privateKeyValue) {
    return { ready: false, descriptor: null, activeKeyId: null, error: 'routing descriptor and private key must be configured together' };
  }
  try {
    const descriptor = parseRoutingAuthorityDescriptor(descriptorJson);
    const publicKey = rawPublicKeyB64(parsePrivateKey(privateKeyValue));
    const nowMs = now();
    const activeKey = descriptor.keys.find((key) => key.publicKey === publicKey && key.notBefore <= nowMs && nowMs < key.notAfter);
    if (!activeKey) {
      return { ready: false, descriptor: null, activeKeyId: null, error: 'no active descriptor key matches routing private key' };
    }
    return { ready: true, descriptor, activeKeyId: activeKey.keyId, error: null };
  } catch (error) {
    return { ready: false, descriptor: null, activeKeyId: null, error: error instanceof Error ? error.message : String(error) };
  }
}
