// SPDX-License-Identifier: AGPL-3.0-only

export function buildPushEventDedupBody({ senderUserId, payload }) {
  const source = payload && typeof payload === 'object' ? payload : {};
  const rawType =
    typeof source.type === 'string' && source.type ? source.type : 'push';

  let dedupType = rawType;
  if (rawType === 'call_invite') {
    const callAction =
      typeof source.callAction === 'string'
        ? source.callAction.trim().toLowerCase()
        : '';
    const mediaType =
      typeof source.mediaType === 'string'
        ? source.mediaType.trim().toLowerCase()
        : '';
    const terminal = callAction === 'end' || mediaType === 'end';
    dedupType = terminal ? 'call_invite:end' : 'call_invite:invite';
  }

  return {
    token: `virtual:${senderUserId}`,
    data: {
      type: dedupType,
      groupId: typeof source.groupId === 'string' ? source.groupId : '',
      directPeerId:
        typeof source.directPeerId === 'string'
          ? source.directPeerId
          : (typeof source.calleeUserId === 'string'
              ? source.calleeUserId
              : ''),
      lastSeq:
        typeof source.lastSeq === 'string'
          ? source.lastSeq
          : (typeof source.callId === 'string' ? source.callId : ''),
    },
  };
}

export function createDedupCache({ ttlSeconds, normalizeTokenInput }) {
  const cache = new Map(); // dedupKey -> expiresAtMs

  function cleanup() {
    const now = Date.now();
    for (const [key, expiresAtMs] of cache.entries()) {
      if (expiresAtMs <= now) {
        cache.delete(key);
      }
    }
  }

  function getKey(body) {
    if (!body || typeof body !== 'object') {
      return null;
    }
    const token = normalizeTokenInput(body.token);
    const data = body.data && typeof body.data === 'object' ? body.data : null;
    if (!token || !data) {
      return null;
    }
    const eventType = typeof data.type === 'string' ? data.type : 'unknown';
    const scopeId =
      (typeof data.groupId === 'string' && data.groupId) ||
      (typeof data.directPeerId === 'string' && data.directPeerId) ||
      '';
    const seq = typeof data.lastSeq === 'string' ? data.lastSeq : '';
    if (!scopeId || !seq) {
      return null;
    }
    return `${token}|${eventType}|${scopeId}|${seq}`;
  }

  function tryAcquire(body) {
    const resolvedTtlSeconds = Number.isFinite(ttlSeconds) && ttlSeconds > 0
      ? ttlSeconds
      : 30;
    const key = getKey(body);
    if (!key) {
      return { deduped: false, key: null };
    }
    cleanup();
    if (cache.has(key)) {
      return { deduped: true, key };
    }
    cache.set(key, Date.now() + resolvedTtlSeconds * 1000);
    return { deduped: false, key };
  }

  return {
    cache,
    cleanup,
    tryAcquire,
  };
}
