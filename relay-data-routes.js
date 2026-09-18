// SPDX-License-Identifier: AGPL-3.0-only

import { requireRequestFields, requireRequestObject } from './relay-request-validation.js';

export function registerRelayDataRoutes(app, dependencies) {
  const { store, blobs, blobUploads, groupMemberships, acked, nowMs, pruneRecipient, pruneBlobs, pruneAckTombstones, pruneGroupMemberships, envelopeKey, uploadKey, normalizePeerIdList, parseBase64, buildEnvelopeSignaturePayload, buildGroupEnvelopeSignaturePayload, buildGroupMembersSignaturePayload, buildBlobSignaturePayload, buildAckSignaturePayload, verifyEd25519Signature, ackTombstoneTtlSeconds } = dependencies;
  app.post('/relay/store', (req, res) => {
    const body = req.body;
    if (!requireRequestObject(body, res)) return;
  
    const required = ['id', 'from', 'to', 'ts', 'ttl', 'payload', 'sig', 'signingPub'];
    if (!requireRequestFields(body, required, res)) return;
  
    const { id, from, to, ts, ttl, payload, sig, signingPub } = body;
    if (typeof id !== 'string' || typeof from !== 'string' || typeof to !== 'string') {
      return res.status(400).json({ error: 'invalid id/from/to' });
    }
    if (!Number.isFinite(ts) || !Number.isFinite(ttl)) {
      return res.status(400).json({ error: 'invalid ts/ttl' });
    }
  
    const payloadBytes = parseBase64(payload);
    if (!payloadBytes) {
      return res.status(400).json({ error: 'invalid payload encoding' });
    }
  
    const signaturePayload = buildEnvelopeSignaturePayload({
      id,
      from,
      to,
      timestampMs: ts,
      ttlSeconds: ttl,
      payloadBytes,
    });
    const verified = verifyEd25519Signature({
      payloadBytes: signaturePayload,
      signatureB64: sig,
      signingPubB64: signingPub,
    });
    if (!verified) {
      return res.status(401).json({ error: 'invalid signature' });
    }
  
    pruneAckTombstones();
    const key = envelopeKey(to, id);
    if (acked.has(key)) {
      return res.json({ ok: true, stored: false, duplicate: true });
    }
  
    pruneRecipient(to);
  
    const list = store.get(to) || [];
    const exists = list.some((item) => item.envelope.id === id);
    if (!exists) {
      list.push({ envelope: body, insertedAtMs: nowMs() });
      store.set(to, list);
    }
  
    res.json({ ok: true, stored: !exists, duplicate: exists });
  });
  
  app.post('/relay/group/store', (req, res) => {
    const body = req.body;
    if (!body || typeof body !== 'object') {
      return res.status(400).json({ error: 'invalid body' });
    }
  
    const required = ['id', 'from', 'groupId', 'recipients', 'ts', 'ttl', 'payload', 'sig', 'signingPub'];
    for (const key of required) {
      if (!(key in body)) {
        return res.status(400).json({ error: `missing ${key}` });
      }
    }
  
    const { id, from, groupId, recipients, ts, ttl, payload, sig, signingPub } = body;
  
    if (typeof id !== 'string' || typeof from !== 'string' || typeof groupId !== 'string') {
      return res.status(400).json({ error: 'invalid id/from/groupId' });
    }
    if (!Array.isArray(recipients)) {
      return res.status(400).json({ error: 'invalid recipients' });
    }
    if (!Number.isFinite(ts) || !Number.isFinite(ttl)) {
      return res.status(400).json({ error: 'invalid ts/ttl' });
    }
  
    const normalizedRecipients = [...new Set(
      recipients
        .filter((item) => typeof item === 'string')
        .map((item) => item.trim())
        .filter((item) => item.length > 0 && item !== from),
    )].sort();
  
    if (normalizedRecipients.length === 0) {
      return res.status(400).json({ error: 'empty recipients' });
    }
  
    const payloadBytes = parseBase64(payload);
    if (!payloadBytes) {
      return res.status(400).json({ error: 'invalid payload encoding' });
    }
  
    const signaturePayload = buildGroupEnvelopeSignaturePayload({
      id,
      from,
      groupId,
      recipients: normalizedRecipients,
      timestampMs: ts,
      ttlSeconds: ttl,
      payloadBytes,
    });
  
    const verified = verifyEd25519Signature({
      payloadBytes: signaturePayload,
      signatureB64: sig,
      signingPubB64: signingPub,
    });
    if (!verified) {
      return res.status(401).json({ error: 'invalid signature' });
    }
  
    pruneAckTombstones();
    pruneGroupMemberships();
    const membership = groupMemberships.get(groupId);
    if (membership?.expiredAtMs) {
      return res.status(409).json({ error: 'group membership expired; owner update required' });
    }
    if (membership) {
      if (!membership.memberPeerIds.has(from)) {
        return res.status(403).json({ error: 'sender is not a group member' });
      }
      const unauthorizedRecipients = normalizedRecipients.filter(
        (recipient) => !membership.memberPeerIds.has(recipient),
      );
      if (unauthorizedRecipients.length > 0) {
        return res.status(403).json({
          error: 'recipient is not a group member',
          unauthorizedRecipients,
        });
      }
    } else {
      const bootstrapMembers = new Set([from, ...normalizedRecipients]);
      groupMemberships.set(groupId, {
        ownerPeerId: from,
        memberPeerIds: bootstrapMembers,
        updatedAtMs: nowMs(),
        provisional: true,
      });
    }
  
    let storedCount = 0;
    let duplicateCount = 0;
  
    for (const recipient of normalizedRecipients) {
      const key = envelopeKey(recipient, id);
      if (acked.has(key)) {
        duplicateCount += 1;
        continue;
      }
  
      pruneRecipient(recipient);
  
      const list = store.get(recipient) || [];
      const exists = list.some((item) => item.envelope.id === id);
      if (exists) {
        duplicateCount += 1;
        continue;
      }
  
      const fanoutEnvelope = {
        id,
        from,
        to: recipient,
        groupId,
        recipients: normalizedRecipients,
        ts,
        ttl,
        payload,
        sig,
        signingPub,
      };
  
      list.push({ envelope: fanoutEnvelope, insertedAtMs: nowMs() });
      store.set(recipient, list);
      storedCount += 1;
    }
  
    return res.json({
      ok: true,
      groupId,
      recipients: normalizedRecipients.length,
      stored: storedCount,
      duplicate: duplicateCount,
    });
  });
  
  app.post('/relay/group/members/update', (req, res) => {
    const body = req.body;
    if (!body || typeof body !== 'object') {
      return res.status(400).json({ error: 'invalid body' });
    }
  
    const required = ['id', 'from', 'groupId', 'ownerPeerId', 'memberPeerIds', 'ts', 'ttl', 'sig', 'signingPub'];
    for (const key of required) {
      if (!(key in body)) {
        return res.status(400).json({ error: `missing ${key}` });
      }
    }
  
    const { id, from, groupId, ownerPeerId, memberPeerIds, ts, ttl, sig, signingPub } = body;
    if (
      typeof id !== 'string' ||
      typeof from !== 'string' ||
      typeof groupId !== 'string' ||
      typeof ownerPeerId !== 'string'
    ) {
      return res.status(400).json({ error: 'invalid id/from/groupId/ownerPeerId' });
    }
    if (!Number.isFinite(ts) || !Number.isFinite(ttl)) {
      return res.status(400).json({ error: 'invalid ts/ttl' });
    }
    if (from !== ownerPeerId) {
      return res.status(403).json({ error: 'only owner can update members' });
    }
  
    const normalizedMembers = normalizePeerIdList(memberPeerIds);
    if (normalizedMembers.length === 0) {
      return res.status(400).json({ error: 'empty memberPeerIds' });
    }
    if (!normalizedMembers.includes(ownerPeerId)) {
      return res.status(400).json({ error: 'owner must be in memberPeerIds' });
    }
  
    const signaturePayload = buildGroupMembersSignaturePayload({
      id,
      from,
      groupId,
      ownerPeerId,
      memberPeerIds: normalizedMembers,
      timestampMs: ts,
      ttlSeconds: ttl,
    });
    const verified = verifyEd25519Signature({
      payloadBytes: signaturePayload,
      signatureB64: sig,
      signingPubB64: signingPub,
    });
    if (!verified) {
      return res.status(401).json({ error: 'invalid signature' });
    }
  
    const existing = groupMemberships.get(groupId);
    if (existing && !existing.expiredAtMs && existing.ownerPeerId !== ownerPeerId && !existing.provisional) {
      return res.status(409).json({ error: 'owner mismatch' });
    }
  
    groupMemberships.set(groupId, {
      ownerPeerId,
      memberPeerIds: new Set(normalizedMembers),
      updatedAtMs: nowMs(),
      provisional: false,
    });
  
    return res.json({
      ok: true,
      groupId,
      ownerPeerId,
      members: normalizedMembers.length,
    });
  });
  
  app.post('/relay/blob/upload', (req, res) => {
    const body = req.body;
    if (!body || typeof body !== 'object') {
      return res.status(400).json({ error: 'invalid body' });
    }
  
    const required = ['id', 'from', 'groupId', 'fileName', 'ts', 'ttl', 'payload', 'sig', 'signingPub'];
    for (const key of required) {
      if (!(key in body)) {
        return res.status(400).json({ error: `missing ${key}` });
      }
    }
  
    const { id, from, groupId, fileName, mimeType, ts, ttl, payload, sig, signingPub } = body;
    if (
      typeof id !== 'string' ||
      typeof from !== 'string' ||
      typeof groupId !== 'string' ||
      typeof fileName !== 'string'
    ) {
      return res.status(400).json({ error: 'invalid id/from/groupId/fileName' });
    }
    if (!Number.isFinite(ts) || !Number.isFinite(ttl)) {
      return res.status(400).json({ error: 'invalid ts/ttl' });
    }
  
    const payloadBytes = parseBase64(payload);
    if (!payloadBytes) {
      return res.status(400).json({ error: 'invalid payload encoding' });
    }
  
    const signaturePayload = buildBlobSignaturePayload({
      id,
      from,
      groupId,
      fileName,
      mimeType: typeof mimeType === 'string' ? mimeType : '',
      timestampMs: ts,
      ttlSeconds: ttl,
      payloadBytes,
    });
  
    const verified = verifyEd25519Signature({
      payloadBytes: signaturePayload,
      signatureB64: sig,
      signingPubB64: signingPub,
    });
    if (!verified) {
      return res.status(401).json({ error: 'invalid signature' });
    }
  
    const existing = blobs.get(id);
    if (existing) {
      return res.json({ ok: true, blobId: id, duplicate: true });
    }
  
    const blob = {
      id,
      from,
      groupId,
      fileName,
      mimeType: typeof mimeType === 'string' ? mimeType : null,
      sizeBytes: payloadBytes.length,
      payload,
      ts,
      ttl,
      sig,
      signingPub,
    };
  
    blobs.set(id, { blob, insertedAtMs: nowMs() });
    return res.json({ ok: true, blobId: id, duplicate: false });
  });
  
  app.post('/relay/blob/upload/chunk', (req, res) => {
    const body = req.body;
    if (!body || typeof body !== 'object') {
      return res.status(400).json({ error: 'invalid body' });
    }
  
    const required = ['id', 'from', 'groupId', 'fileName', 'ts', 'ttl', 'chunkIndex', 'totalChunks', 'payload'];
    for (const key of required) {
      if (!(key in body)) {
        return res.status(400).json({ error: `missing ${key}` });
      }
    }
  
    const { id, from, groupId, fileName, mimeType, ts, ttl, chunkIndex, totalChunks, payload } = body;
    if (
      typeof id !== 'string' ||
      typeof from !== 'string' ||
      typeof groupId !== 'string' ||
      typeof fileName !== 'string'
    ) {
      return res.status(400).json({ error: 'invalid id/from/groupId/fileName' });
    }
    if (!Number.isFinite(ts) || !Number.isFinite(ttl)) {
      return res.status(400).json({ error: 'invalid ts/ttl' });
    }
    if (!Number.isInteger(chunkIndex) || !Number.isInteger(totalChunks)) {
      return res.status(400).json({ error: 'invalid chunkIndex/totalChunks' });
    }
    if (chunkIndex < 0 || totalChunks <= 0 || chunkIndex >= totalChunks || totalChunks > 10000) {
      return res.status(400).json({ error: 'chunk range invalid' });
    }
  
    const chunkBytes = parseBase64(payload);
    if (!chunkBytes) {
      return res.status(400).json({ error: 'invalid payload encoding' });
    }
  
    const key = uploadKey(id, from, groupId);
    const existingUpload = blobUploads.get(key);
    if (existingUpload) {
      if (existingUpload.meta.totalChunks !== totalChunks) {
        return res.status(409).json({ error: 'totalChunks mismatch' });
      }
    }
  
    const upload = existingUpload || {
      meta: {
        id,
        from,
        groupId,
        fileName,
        mimeType: typeof mimeType === 'string' ? mimeType : null,
        ts,
        ttl,
        totalChunks,
      },
      chunks: new Map(),
      insertedAtMs: nowMs(),
    };
  
    upload.chunks.set(chunkIndex, chunkBytes);
    blobUploads.storeChunk(key, chunkIndex, chunkBytes);
    blobUploads.set(key, upload);
  
    return res.json({ ok: true, id, chunkIndex, totalChunks, received: upload.chunks.size });
  });
  
  app.post('/relay/blob/upload/complete', (req, res) => {
    const body = req.body;
    if (!body || typeof body !== 'object') {
      return res.status(400).json({ error: 'invalid body' });
    }
  
    const required = ['id', 'from', 'groupId', 'fileName', 'ts', 'ttl', 'totalChunks', 'sig', 'signingPub'];
    for (const key of required) {
      if (!(key in body)) {
        return res.status(400).json({ error: `missing ${key}` });
      }
    }
  
    const { id, from, groupId, fileName, mimeType, ts, ttl, totalChunks, sig, signingPub } = body;
    if (
      typeof id !== 'string' ||
      typeof from !== 'string' ||
      typeof groupId !== 'string' ||
      typeof fileName !== 'string'
    ) {
      return res.status(400).json({ error: 'invalid id/from/groupId/fileName' });
    }
    if (!Number.isFinite(ts) || !Number.isFinite(ttl)) {
      return res.status(400).json({ error: 'invalid ts/ttl' });
    }
    if (!Number.isInteger(totalChunks) || totalChunks <= 0 || totalChunks > 10000) {
      return res.status(400).json({ error: 'invalid totalChunks' });
    }
  
    const key = uploadKey(id, from, groupId);
    const upload = blobUploads.get(key);
    if (!upload) {
      return res.status(404).json({ error: 'upload session not found' });
    }
  
    if (upload.chunks.size !== totalChunks) {
      return res.status(409).json({
        error: 'missing chunks',
        expected: totalChunks,
        received: upload.chunks.size,
      });
    }
  
    const parts = [];
    for (let i = 0; i < totalChunks; i++) {
      const part = upload.chunks.get(i);
      if (!part) {
        return res.status(409).json({ error: `missing chunk ${i}` });
      }
      parts.push(part);
    }
    const payloadBytes = Buffer.concat(parts);
  
    const signaturePayload = buildBlobSignaturePayload({
      id,
      from,
      groupId,
      fileName,
      mimeType: typeof mimeType === 'string' ? mimeType : '',
      timestampMs: ts,
      ttlSeconds: ttl,
      payloadBytes,
    });
  
    const verified = verifyEd25519Signature({
      payloadBytes: signaturePayload,
      signatureB64: sig,
      signingPubB64: signingPub,
    });
    if (!verified) {
      return res.status(401).json({ error: 'invalid signature' });
    }
  
    const existing = blobs.get(id);
    if (!existing) {
      const blob = {
        id,
        from,
        groupId,
        fileName,
        mimeType: typeof mimeType === 'string' ? mimeType : null,
        sizeBytes: payloadBytes.length,
        payload: payloadBytes.toString('base64'),
        ts,
        ttl,
        sig,
        signingPub,
      };
      blobs.set(id, { blob, insertedAtMs: nowMs() });
    }
  
    blobUploads.delete(key);
    return res.json({ ok: true, blobId: id, duplicate: !!existing });
  });
  
  app.get('/relay/blob/:blobId', (req, res) => {
    const blobId = req.params.blobId;
    if (!blobId || typeof blobId !== 'string') {
      return res.status(400).json({ error: 'missing blobId' });
    }
  
    pruneBlobs();
    const item = blobs.get(blobId);
    if (!item) {
      return res.status(404).json({ error: 'blob not found' });
    }
  
    const { blob } = item;
    return res.json({
      id: blob.id,
      groupId: blob.groupId,
      fileName: blob.fileName,
      mimeType: blob.mimeType,
      sizeBytes: blob.sizeBytes,
      payload: blob.payload,
    });
  });
  
  app.get('/relay/fetch', (req, res) => {
    const recipient = req.query.to;
    if (typeof recipient !== 'string') {
      return res.status(400).json({ error: 'missing to' });
    }
  
    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : null;
    const limitRaw = req.query.limit;
    const limit = Math.min(
      Number.parseInt(typeof limitRaw === 'string' ? limitRaw : '50', 10) || 50,
      500,
    );
  
    pruneRecipient(recipient);
  
    const list = store.get(recipient) || [];
    let startIdx = 0;
    if (cursor) {
      const idx = list.findIndex((item) => item.envelope.id === cursor);
      if (idx >= 0) startIdx = idx + 1;
    }
  
    const slice = list.slice(startIdx, startIdx + limit).map((item) => item.envelope);
    const nextCursor = slice.length ? slice[slice.length - 1].id : cursor;
  
    res.json({ messages: slice, cursor: nextCursor });
  });
  
  app.post('/relay/ack', (req, res) => {
    const body = req.body;
    if (!body || typeof body !== 'object') {
      return res.status(400).json({ error: 'invalid body' });
    }
  
    const required = ['id', 'from', 'to', 'ts', 'sig', 'signingPub'];
    for (const key of required) {
      if (!(key in body)) {
        return res.status(400).json({ error: `missing ${key}` });
      }
    }
  
    const { id, from, to, ts, sig, signingPub } = body;
    if (typeof id !== 'string' || typeof from !== 'string' || typeof to !== 'string') {
      return res.status(400).json({ error: 'invalid id/from/to' });
    }
    if (!Number.isFinite(ts)) {
      return res.status(400).json({ error: 'invalid ts' });
    }
  
    const signaturePayload = buildAckSignaturePayload({
      id,
      from,
      to,
      timestampMs: ts,
    });
    const verified = verifyEd25519Signature({
      payloadBytes: signaturePayload,
      signatureB64: sig,
      signingPubB64: signingPub,
    });
    if (!verified) {
      return res.status(401).json({ error: 'invalid signature' });
    }
  
    const key = envelopeKey(to, id);
    const ackedAtMs = nowMs();
    acked.set(key, {
      recipient: to,
      messageId: id,
      ackedAtMs,
      expiresAtMs: ackedAtMs + ackTombstoneTtlSeconds * 1000,
    });
  
    const list = store.get(to);
    if (list && list.length) {
      const filtered = list.filter((item) => item.envelope.id !== id);
      if (filtered.length === 0) {
        store.delete(to);
      } else {
        store.set(to, filtered);
      }
    }
  
    res.json({ ok: true });
  });
  
}
