// SPDX-License-Identifier: AGPL-3.0-only

function parseMaybeJson(value) {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch (_) {
    return trimmed;
  }
}

function collectServerCandidates(value, out = []) {
  const parsed = parseMaybeJson(value);
  if (!parsed) return out;
  if (typeof parsed === 'string') {
    out.push(parsed);
    return out;
  }
  if (Array.isArray(parsed)) {
    for (const item of parsed) collectServerCandidates(item, out);
    return out;
  }
  if (typeof parsed === 'object') {
    for (const key of ['url', 'uri', 'endpoint', 'signal', 'relay', 'turn', 'turns', 'host']) {
      if (parsed[key]) collectServerCandidates(parsed[key], out);
    }
    for (const key of ['servers', 'signalServers', 'relayServers', 'turnServers', 'iceServers', 'urls']) {
      if (parsed[key]) collectServerCandidates(parsed[key], out);
    }
  }
  return out;
}

function normalizeServerUrl(input) {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed || trimmed.length > 2048) return null;
  try {
    const turnMatch = trimmed.match(/^(turns?):([^/?#]+)(.*)$/i);
    const withScheme = turnMatch && !trimmed.includes('://')
      ? `${turnMatch[1].toLowerCase()}://${turnMatch[2]}${turnMatch[3] || ''}`
      : /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
        ? trimmed
        : `https://${trimmed}`;
    const url = new URL(withScheme);
    const scheme = url.protocol.replace(':', '').toLowerCase();
    if (!['http', 'https', 'ws', 'wss', 'turn', 'turns'].includes(scheme)) return null;
    const host = url.hostname.toLowerCase();
    if (!host || host === 'localhost' || host === '127.0.0.1' || host === '::1') return null;
    const defaultPort = scheme === 'wss' ? '443'
      : scheme === 'https' ? '443'
        : scheme === 'ws' ? '80'
          : scheme === 'http' ? '80'
            : scheme === 'turns' ? '5349'
              : '3478';
    const port = url.port || defaultPort;
    return {
      normalizedUrl: `${scheme}://${host}:${port}${url.pathname === '/' ? '' : url.pathname}`,
      scheme,
      host,
      port: Number.parseInt(port, 10),
    };
  } catch (_) {
    return null;
  }
}

export function normalizeEventType(value) {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!raw) return 'unknown';
  if (raw.includes('call')) return 'call';
  if (raw.includes('message') || raw.includes('direct')) return 'message';
  if (raw.includes('group')) return 'group';
  return raw.replace(/[^a-z0-9_:-]/g, '_').slice(0, 64) || 'unknown';
}

export function extractServersFromPayload(payload) {
  const source = payload && typeof payload === 'object' ? payload : {};
  const candidates = [
    ...collectServerCandidates(source.servers),
    ...collectServerCandidates(source.signalServers),
    ...collectServerCandidates(source.relayServers),
    ...collectServerCandidates(source.turnServers),
    ...collectServerCandidates(source.iceServers),
  ];
  const byUrl = new Map();
  for (const candidate of candidates) {
    const normalized = normalizeServerUrl(candidate);
    if (normalized) byUrl.set(normalized.normalizedUrl, normalized);
  }
  return [...byUrl.values()];
}
