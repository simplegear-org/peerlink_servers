// SPDX-License-Identifier: AGPL-3.0-only

export function createRelayLifecycle({
  store, blobs, blobUploads, groupMemberships, acked, nowMs,
  ttlSeconds, uploadTtlSeconds, ackTombstoneTtlSeconds,
  groupMembershipTtlSeconds, groupMembershipExpiredTombstoneTtlSeconds,
}) {
  function pruneRecipient(recipientId) {
    const list = store.get(recipientId);
    if (!list || list.length === 0) return;
    const filtered = list.filter((item) => item.insertedAtMs >= nowMs() - ttlSeconds * 1000);
    if (filtered.length === 0) store.delete(recipientId);
    else if (filtered.length !== list.length) store.set(recipientId, filtered);
  }

  function pruneBlobs() {
    const now = nowMs();
    for (const [blobId, item] of blobs.entries()) {
      if (now >= item.insertedAtMs + (Number.isFinite(item.blob.ttl) ? item.blob.ttl : ttlSeconds) * 1000) blobs.delete(blobId);
    }
  }

  function pruneUploads() {
    const cutoff = nowMs() - uploadTtlSeconds * 1000;
    for (const [key, item] of blobUploads.entries()) if (item.insertedAtMs < cutoff) blobUploads.delete(key);
  }

  function pruneAckTombstones() {
    const now = nowMs();
    for (const [key, tombstone] of acked.entries()) {
      const expiry = Number.isFinite(tombstone.expiresAtMs)
        ? tombstone.expiresAtMs : tombstone.ackedAtMs + ackTombstoneTtlSeconds * 1000;
      if (!Number.isFinite(tombstone.ackedAtMs) || now >= expiry) acked.delete(key);
    }
  }

  function pruneGroupMemberships() {
    const now = nowMs();
    for (const [groupId, membership] of groupMemberships.entries()) {
      if (Number.isFinite(membership.expiredAtMs)) {
        if (membership.expiredAtMs < now - groupMembershipExpiredTombstoneTtlSeconds * 1000) groupMemberships.delete(groupId);
      } else if (!Number.isFinite(membership.updatedAtMs) || membership.updatedAtMs < now - groupMembershipTtlSeconds * 1000) {
        groupMemberships.set(groupId, { expiredAtMs: now });
      }
    }
  }

  function prunePersistentState() {
    for (const recipient of store.keys()) pruneRecipient(recipient);
    pruneBlobs(); pruneUploads(); pruneAckTombstones(); pruneGroupMemberships();
  }

  return { pruneRecipient, pruneBlobs, pruneUploads, pruneAckTombstones, pruneGroupMemberships, prunePersistentState };
}
