// SPDX-License-Identifier: AGPL-3.0-only

export async function runObservedServerChecker({
  env = process.env,
  schemaSql,
  defaultCheckIntervalMs,
  defaultCheckTimeoutMs,
}) {
  const databaseUrl = (env.PUSH_OBSERVABILITY_DATABASE_URL || env.DATABASE_URL || '').trim();
  if (!databaseUrl) throw new Error('PUSH_OBSERVABILITY_DATABASE_URL is required');
  const pg = await import('pg');
  const pool = new pg.Pool({ connectionString: databaseUrl });
  await pool.query(schemaSql);
  const intervalMs = Number.parseInt(env.PEERLINK_SERVER_CHECK_INTERVAL_MS || '', 10) || defaultCheckIntervalMs;
  const timeoutMs = Number.parseInt(env.PEERLINK_SERVER_CHECK_TIMEOUT_MS || '', 10) || defaultCheckTimeoutMs;

  async function tick() {
    const result = await pool.query(
      `select id, normalized_url, scheme, host, port
       from observed_servers
       where last_checked_at is null
          or last_checked_at < now() - ($1::int * interval '1 second')
       order by coalesce(last_checked_at, 'epoch'::timestamptz), last_seen_at desc
       limit 50`,
      [Math.max(30, Math.floor(intervalMs / 1000))],
    );
    for (const row of result.rows) {
      const startedAt = Date.now();
      const check = await checkServer(row, timeoutMs);
      const latencyMs = Date.now() - startedAt;
      await pool.query(
        `update observed_servers set
           status = $2,
           last_checked_at = now(),
           last_error = $3,
           capabilities_json = $4,
           last_check_latency_ms = $5
         where id = $1`,
        [row.id, check.status, check.error, check.capabilities, latencyMs],
      );
      await pool.query(
        `insert into server_checks (server_id, checked_at, status, latency_ms, error)
         values ($1, now(), $2, $3, $4)`,
        [row.id, check.status, latencyMs, check.error],
      );
      await pool.query(
        `insert into server_usage_hourly
          (server_id, bucket_at, failed_checks, avg_check_latency_ms, p95_check_latency_ms, status)
         values ($1, date_trunc('hour', now()), case when $2 in ('healthy', 'degraded') then 0 else 1 end, $3, $3, $2)
         on conflict (server_id, bucket_at) do update set
           failed_checks = server_usage_hourly.failed_checks + excluded.failed_checks,
           avg_check_latency_ms = coalesce((server_usage_hourly.avg_check_latency_ms + excluded.avg_check_latency_ms) / 2, excluded.avg_check_latency_ms),
           p95_check_latency_ms = greatest(coalesce(server_usage_hourly.p95_check_latency_ms, 0), excluded.p95_check_latency_ms),
           status = excluded.status`,
        [row.id, check.status, latencyMs],
      );
      console.log('[server-checker] checked', row.normalized_url, check.status, latencyMs, check.error || '');
    }
  }

  await tick();
  setInterval(() => {
    tick().catch((error) => {
      console.warn('[server-checker] tick failed:', error instanceof Error ? error.message : String(error));
    });
  }, intervalMs);
}

async function checkServer(row, timeoutMs) {
  if (row.scheme === 'turn' || row.scheme === 'turns') {
    return checkTcp(row.host, row.port, timeoutMs);
  }
  const baseScheme = row.scheme === 'ws' || row.scheme === 'wss'
    ? (row.scheme === 'wss' ? 'https' : 'http')
    : row.scheme;
  const baseUrl = `${baseScheme}://${row.host}:${row.port}`;
  try {
    const capabilities = await fetchJson(`${baseUrl}/relay/capabilities`, timeoutMs);
    return { status: 'healthy', error: null, capabilities };
  } catch (capabilitiesError) {
    try {
      await fetchJson(`${baseUrl}/health`, timeoutMs);
      return {
        status: 'degraded',
        error: capabilitiesError instanceof Error ? capabilitiesError.message.slice(0, 512) : String(capabilitiesError).slice(0, 512),
        capabilities: null,
      };
    } catch (healthError) {
      return {
        status: classifyCheckError(healthError),
        error: healthError instanceof Error ? healthError.message.slice(0, 512) : String(healthError).slice(0, 512),
        capabilities: null,
      };
    }
  }
}

async function fetchJson(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`http_${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function checkTcp(host, port, timeoutMs) {
  const net = await import('node:net');
  return await new Promise((resolve) => {
    const socket = net.createConnection({ host, port, timeout: timeoutMs });
    socket.once('connect', () => {
      socket.destroy();
      resolve({ status: 'healthy', error: null, capabilities: null });
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve({ status: 'blocked', error: 'tcp_timeout', capabilities: null });
    });
    socket.once('error', (error) => {
      socket.destroy();
      resolve({ status: classifyCheckError(error), error: error.message.slice(0, 512), capabilities: null });
    });
  });
}

function classifyCheckError(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('timeout') || message.includes('aborted') || message.includes('AbortError')) return 'blocked';
  if (message.includes('ENOTFOUND') || message.includes('ECONNREFUSED')) return 'dead';
  return 'dead';
}
