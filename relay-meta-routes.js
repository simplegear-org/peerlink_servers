// SPDX-License-Identifier: AGPL-3.0-only

export function registerRelayMetaRoutes(app, { sourceMetadata, nowMs }) {
  app.get('/health', (_req, res) => res.json({ ok: true, ts: nowMs(), source: sourceMetadata }));
  app.get('/.well-known/peerlink-source', (_req, res) => res.json(sourceMetadata));
  app.get('/relay/capabilities', (_req, res) => res.json({
    ok: true, service: 'peerlink-relay', protocolVersion: '1', source: sourceMetadata,
    features: {
      health: true, probe: true, store: true, fetch: true, ack: true,
      groupStore: true, groupMembersUpdate: true, blobUpload: true,
      blobChunkUpload: true, blobDownload: true,
      // Existing durable replication is safe; routed transfer is intentionally
      // unavailable until its authenticated protocol and authority exist.
      multiReplicaSafe: true,
      messageTransfer: false,
      blobTransfer: false,
      streamingBlobTransfer: false,
    },
    routing: {
      authorityDiscovery: false,
      ready: false,
      transferProtocolVersion: null,
    },
    auth: { storeRequiresEd25519Signature: true, ackRequiresEd25519Signature: true, groupStoreRequiresEd25519Signature: true, groupMembersUpdateRequiresEd25519Signature: true, blobUploadRequiresEd25519Signature: true, blobUploadCompleteRequiresEd25519Signature: true },
    query: { fetchRecipientParam: 'to', fetchCursorParam: 'cursor', fetchLimitParam: 'limit' }, ts: nowMs(),
  }));
  app.post('/relay/probe', (req, res) => {
    if (!req.body || typeof req.body !== 'object') return res.status(400).json({ error: 'invalid body' });
    if (req.body.v != null && req.body.v !== '1') return res.status(400).json({ error: 'unsupported protocol version', supported: ['1'] });
    return res.json({ ok: true, service: 'peerlink-relay', protocolVersion: '1', ts: nowMs() });
  });
}
