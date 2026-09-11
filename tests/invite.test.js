// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import test from 'node:test';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function manifest() {
  const pair = crypto.generateKeyPairSync('ed25519');
  const signingPublicKey = pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
  const identity = {
    type: 'peerlink_identity_bundle', version: 3, peerId: 'peer-test', signingPublicKey,
    agreementPublicKey: crypto.randomBytes(32).toString('base64'), signature: '',
  };
  identity.signature = crypto.sign(null, Buffer.from(JSON.stringify({
    type: identity.type, version: identity.version, peerId: identity.peerId,
    signingPublicKey: identity.signingPublicKey, agreementPublicKey: identity.agreementPublicKey,
  })), pair.privateKey).toString('base64');
  const value = { version: 1, inviter: { peerId: 'peer-test', username: 'Alice', identityBundle: identity } };
  value.manifestSignature = crypto.sign(null, Buffer.from(canonicalJson(value)), pair.privateKey).toString('base64');
  return value;
}

async function start(dataFile) {
  const child = spawn(process.execPath, ['invite.js'], { env: { ...process.env, PORT: '0', INVITE_DATA_FILE: dataFile } });
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('invite startup timeout')), 3000);
    child.stdout.on('data', (chunk) => {
      const matched = String(chunk).match(/:(\d+)/);
      if (matched) { clearTimeout(timer); resolve(Number(matched[1])); }
    });
    child.once('error', reject);
  });
  return { child, base: `http://127.0.0.1:${port}` };
}

async function stop(child) {
  child.kill('SIGTERM');
  await new Promise((resolve) => child.once('exit', resolve));
}

test('invite persists a signed manifest and rejects a forged one', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'peerlink-invite-'));
  const dataFile = path.join(dir, 'invites.json');
  let server = await start(dataFile);
  try {
    const payload = manifest();
    const created = await fetch(`${server.base}/invites`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    assert.equal(created.status, 201);
    const { token } = await created.json();
    const resolved = await fetch(`${server.base}/invites/${token}`, {
      headers: { origin: 'https://simplegear.org' },
    });
    assert.equal(resolved.status, 200);
    assert.equal(resolved.headers.get('access-control-allow-origin'), 'https://simplegear.org');
    const resolvedManifest = await resolved.json();
    assert.equal(resolvedManifest.inviter.username, 'Alice');
    assert.equal(typeof resolvedManifest.inviteId, 'string');
    assert.ok(Number.isFinite(Date.parse(resolvedManifest.expiration)));
    await stop(server.child);
    server = await start(dataFile);
    const restored = await fetch(`${server.base}/invites/${token}`);
    assert.equal(restored.status, 200);
    assert.equal((await restored.json()).inviteId, resolvedManifest.inviteId);
    payload.manifestSignature = 'forged';
    const rejected = await fetch(`${server.base}/invites`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    assert.equal(rejected.status, 400);
  } finally {
    await stop(server.child);
    await fs.rm(dir, { recursive: true, force: true });
  }
});
