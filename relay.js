// SPDX-License-Identifier: AGPL-3.0-only

import express from 'express';
import {
  buildAckSignaturePayload, buildBlobSignaturePayload, buildEnvelopeSignaturePayload,
  buildGroupEnvelopeSignaturePayload, buildGroupMembersSignaturePayload, envelopeKey,
  normalizePeerIdList, parseBase64, uploadKey, verifyEd25519Signature,
} from './relay-validation.js';
import { createRelayLifecycle } from './relay-lifecycle.js';
import { registerRelayMetaRoutes } from './relay-meta-routes.js';
import { registerRelayDataRoutes } from './relay-data-routes.js';
import { sourceInfo } from './source-info.js';
import {
  RelayAckTombstoneStore,
  RelayBlobStore,
  RelayBlobUploadStore,
  RelayGroupMembershipStore,
  RelayMessageStore,
} from './relay-storage.js';

const app = express();
app.use(express.json({ limit: process.env.RELAY_BODY_LIMIT || '20mb' }));
const sourceMetadata = sourceInfo();

const PORT = process.env.PORT || 4000;
const TTL_SECONDS = Number.parseInt(process.env.RELAY_TTL_SECONDS || '86400', 10);
const UPLOAD_TTL_SECONDS = Number.parseInt(process.env.RELAY_UPLOAD_TTL_SECONDS || '21600', 10);
const ACK_TOMBSTONE_TTL_SECONDS = Number.parseInt(
  process.env.RELAY_ACK_TOMBSTONE_TTL_SECONDS || String(TTL_SECONDS),
  10,
);
const GROUP_MEMBERSHIP_TTL_SECONDS = Number.parseInt(
  process.env.RELAY_GROUP_MEMBERSHIP_TTL_SECONDS || '2592000',
  10,
);
const GROUP_MEMBERSHIP_EXPIRED_TOMBSTONE_TTL_SECONDS = Number.parseInt(
  process.env.RELAY_GROUP_MEMBERSHIP_EXPIRED_TOMBSTONE_TTL_SECONDS
    || String(GROUP_MEMBERSHIP_TTL_SECONDS),
  10,
);
const RELAY_DATA_DIR = process.env.RELAY_DATA_DIR || 'data/relay';

const store = new RelayMessageStore(RELAY_DATA_DIR); // recipientId -> [{ envelope, insertedAtMs }]
const blobs = new RelayBlobStore(RELAY_DATA_DIR); // blobId -> { blob, insertedAtMs }
const blobUploads = new RelayBlobUploadStore(RELAY_DATA_DIR); // uploadKey -> { meta, chunks: Map<int, Buffer>, insertedAtMs }
const groupMemberships = new RelayGroupMembershipStore(RELAY_DATA_DIR); // groupId -> { ownerPeerId, memberPeerIds:Set<string>, updatedAtMs, provisional?: boolean }
const acked = new RelayAckTombstoneStore(RELAY_DATA_DIR); // ${to}|${id} -> ackedAtMs

const nowMs = () => Date.now();
const {
  pruneRecipient, pruneBlobs, pruneUploads, pruneAckTombstones,
  pruneGroupMemberships, prunePersistentState,
} = createRelayLifecycle({
  store, blobs, blobUploads, groupMemberships, acked, nowMs,
  ttlSeconds: TTL_SECONDS, uploadTtlSeconds: UPLOAD_TTL_SECONDS,
  ackTombstoneTtlSeconds: ACK_TOMBSTONE_TTL_SECONDS,
  groupMembershipTtlSeconds: GROUP_MEMBERSHIP_TTL_SECONDS,
  groupMembershipExpiredTombstoneTtlSeconds: GROUP_MEMBERSHIP_EXPIRED_TOMBSTONE_TTL_SECONDS,
});

registerRelayMetaRoutes(app, { sourceMetadata, nowMs });


registerRelayDataRoutes(app, { store, blobs, blobUploads, groupMemberships, acked, nowMs, pruneRecipient, pruneBlobs, pruneAckTombstones, pruneGroupMemberships, envelopeKey, uploadKey, normalizePeerIdList, parseBase64, buildEnvelopeSignaturePayload, buildGroupEnvelopeSignaturePayload, buildGroupMembersSignaturePayload, buildBlobSignaturePayload, buildAckSignaturePayload, verifyEd25519Signature, ackTombstoneTtlSeconds: ACK_TOMBSTONE_TTL_SECONDS });

app.listen(PORT, () => {
  console.log(`[relay] listening on :${PORT}`);
});

setInterval(() => {
  prunePersistentState();
}, 60_000).unref();

prunePersistentState();
