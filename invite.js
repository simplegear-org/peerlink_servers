// SPDX-License-Identifier: AGPL-3.0-only

import crypto from 'crypto';
import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import { verifyEd25519Signature } from './security/signed-requests.js';

const app = express();
app.use(express.json({ limit: process.env.INVITE_BODY_LIMIT || '128kb' }));

const port = Number.parseInt(process.env.PORT || '4600', 10);
const ttlMs = Number.parseInt(process.env.INVITE_TTL_MS || `${30 * 24 * 60 * 60 * 1000}`, 10);
const rateLimit = Number.parseInt(process.env.INVITE_CREATE_RATE_LIMIT || '30', 10);
const dataFile = process.env.INVITE_DATA_FILE || '/data/invites.json';
const invites = new Map();
const rateBuckets = new Map();

function validManifest(value) {
  const inviter = value?.inviter;
  const identity = inviter?.identityBundle;
  const username = inviter?.username;
  return value?.version === 1 && typeof value?.manifestSignature === 'string' &&
    typeof inviter?.peerId === 'string' && inviter.peerId.trim() &&
    identity?.type === 'peerlink_identity_bundle' && identity.version === 3 && identity.peerId === inviter.peerId &&
    typeof identity.signingPublicKey === 'string' && typeof identity.agreementPublicKey === 'string' &&
    typeof identity.signature === 'string' &&
    (username === undefined || (typeof username === 'string' && username.trim().length <= 64 && !/[\x00-\x1F\x7F]/.test(username)));
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function identityBundlePayload(identity) {
  return Buffer.from(JSON.stringify({
    type: 'peerlink_identity_bundle', version: 3, peerId: identity.peerId,
    signingPublicKey: identity.signingPublicKey, agreementPublicKey: identity.agreementPublicKey,
  }));
}

function verifiedManifest(value) {
  if (!validManifest(value)) return false;
  const identity = value.inviter.identityBundle;
  if (!verifyEd25519Signature({
    payloadBytes: identityBundlePayload(identity), signatureB64: identity.signature,
    signingPubB64: identity.signingPublicKey,
  })) return false;
  const unsigned = { ...value };
  delete unsigned.manifestSignature;
  // Эти поля добавляет сервер после проверки клиентской подписи.
  delete unsigned.inviteId;
  delete unsigned.expiration;
  return verifyEd25519Signature({
    payloadBytes: Buffer.from(canonicalJson(unsigned)), signatureB64: value.manifestSignature,
    signingPubB64: identity.signingPublicKey,
  });
}

function prune() {
  const now = Date.now();
  for (const [token, record] of invites) if (record.expiresAtMs <= now) invites.delete(token);
}

async function persist() {
  await fs.mkdir(path.dirname(dataFile), { recursive: true });
  const temporaryFile = `${dataFile}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporaryFile, JSON.stringify(Object.fromEntries(invites)), { mode: 0o600 });
  await fs.rename(temporaryFile, dataFile);
}

try {
  const saved = JSON.parse(await fs.readFile(dataFile, 'utf8'));
  for (const [token, record] of Object.entries(saved)) {
    if (record?.expiresAtMs > Date.now() && verifiedManifest(record.manifest)) invites.set(token, record);
  }
} catch (error) {
  if (error.code !== 'ENOENT') console.warn('[invite] restore failed', error);
}

app.post('/invites', async (req, res) => {
  const key = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const bucket = (rateBuckets.get(key) || []).filter((at) => now - at < 3600000);
  if (bucket.length >= rateLimit) return res.status(429).json({ error: 'rate_limited' });
  if (!verifiedManifest(req.body)) return res.status(400).json({ error: 'invalid_manifest_signature' });
  bucket.push(now); rateBuckets.set(key, bucket); prune();
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAtMs = now + ttlMs;
  const manifest = {
    ...req.body,
    inviteId: crypto.randomUUID(),
    expiration: new Date(expiresAtMs).toISOString(),
  };
  invites.set(token, { manifest, expiresAtMs });
  await persist();
  return res.status(201).json({ token, expiresAtMs });
});

app.get('/invites/:token', async (req, res) => {
  prune();
  const record = invites.get(req.params.token);
  if (!/^[A-Za-z0-9_-]{22,128}$/.test(req.params.token) || !record) return res.status(404).end();
  await persist();
  return res.set('Cache-Control', 'no-store').json(record.manifest);
});

app.get('/health', (_req, res) => res.json({ ok: true }));
const server = app.listen(port);
server.on('listening', () => {
  const address = server.address();
  console.log(`[invite] listening on :${typeof address === 'object' ? address.port : port}`);
});
