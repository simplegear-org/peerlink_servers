// SPDX-License-Identifier: AGPL-3.0-only

function escapeLabel(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

function metricLine(name, labels, value) {
  const labelEntries = Object.entries(labels || {}).filter(([, item]) => item !== undefined && item !== null);
  const suffix = labelEntries.length
    ? `{${labelEntries.map(([key, item]) => `${key}="${escapeLabel(item)}"`).join(',')}}`
    : '';
  return `${name}${suffix} ${Number.isFinite(value) ? value : 0}`;
}

export class CounterMap {
  constructor() {
    this.values = new Map();
  }

  inc(labels, delta = 1) {
    const key = JSON.stringify(labels || {});
    this.values.set(key, (this.values.get(key) || 0) + delta);
  }

  lines(name) {
    return [...this.values.entries()].map(([key, value]) => metricLine(name, JSON.parse(key), value));
  }
}

function aggregateDevices(devicesByUser, labelsFor) {
  const values = new Map();
  for (const device of iterEnabledDevices(devicesByUser)) {
    const key = JSON.stringify(labelsFor(device));
    values.set(key, (values.get(key) || 0) + 1);
  }
  return values;
}

function* iterEnabledDevices(devicesByUser) {
  for (const devices of devicesByUser.values()) {
    for (const device of devices.values()) {
      if (device.enabled) yield device;
    }
  }
}

export async function buildPushMetrics({
  devicesByUser,
  tokenToOwner,
  voipDevicesByUser,
  voipTokenToOwner,
  dedupCache,
  signedRequestReplayCacheSize = 0,
  counters,
  observedServersSize,
  dbReady,
  pool,
}) {
  const lines = [
    '# HELP peerlink_push_registered_users Registered users with message devices.',
    '# TYPE peerlink_push_registered_users gauge',
    metricLine('peerlink_push_registered_users', {}, devicesByUser.size),
    '# HELP peerlink_push_registered_devices Registered message device tokens.',
    '# TYPE peerlink_push_registered_devices gauge',
    metricLine('peerlink_push_registered_devices', {}, tokenToOwner.size),
    '# HELP peerlink_push_registered_voip_devices Registered VoIP device tokens.',
    '# TYPE peerlink_push_registered_voip_devices gauge',
    metricLine('peerlink_push_registered_voip_devices', {}, voipTokenToOwner.size),
    '# HELP peerlink_push_dedup_cache_entries Current dedup cache size.',
    '# TYPE peerlink_push_dedup_cache_entries gauge',
    metricLine('peerlink_push_dedup_cache_entries', {}, dedupCache.size),
    '# HELP peerlink_push_replay_cache_entries Current signed request replay cache size.',
    '# TYPE peerlink_push_replay_cache_entries gauge',
    metricLine('peerlink_push_replay_cache_entries', {}, signedRequestReplayCacheSize),
    '# HELP peerlink_push_device_register_total Device register calls.',
    '# TYPE peerlink_push_device_register_total counter',
    ...counters.registers.lines('peerlink_push_device_register_total'),
    '# HELP peerlink_push_device_unregister_total Device unregister calls.',
    '# TYPE peerlink_push_device_unregister_total counter',
    ...counters.unregisters.lines('peerlink_push_device_unregister_total'),
    '# HELP peerlink_push_events_total Push events accepted.',
    '# TYPE peerlink_push_events_total counter',
    ...counters.events.lines('peerlink_push_events_total'),
    '# HELP peerlink_push_sent_total Push deliveries sent.',
    '# TYPE peerlink_push_sent_total counter',
    ...counters.sent.lines('peerlink_push_sent_total'),
    '# HELP peerlink_push_failed_total Push deliveries failed.',
    '# TYPE peerlink_push_failed_total counter',
    ...counters.failed.lines('peerlink_push_failed_total'),
    '# HELP peerlink_push_deduped_total Push events deduped.',
    '# TYPE peerlink_push_deduped_total counter',
    ...counters.deduped.lines('peerlink_push_deduped_total'),
    '# HELP peerlink_observed_servers_total Servers observed in push payloads.',
    '# TYPE peerlink_observed_servers_total gauge',
    metricLine('peerlink_observed_servers_total', {}, observedServersSize),
    '# HELP peerlink_push_observability_postgres_up Postgres observability state.',
    '# TYPE peerlink_push_observability_postgres_up gauge',
    metricLine('peerlink_push_observability_postgres_up', {}, dbReady ? 1 : 0),
  ];

  for (const [labels, value] of aggregateDevices(devicesByUser, (device) => ({
    platform: device.platform || 'unknown',
    provider: device.messageProvider || 'unknown',
  })).entries()) {
    lines.push(metricLine('peerlink_push_registered_devices_by_platform', JSON.parse(labels), value));
  }
  for (const [labels, value] of aggregateDevices(voipDevicesByUser, (device) => ({
    platform: device.platform || 'unknown',
  })).entries()) {
    lines.push(metricLine('peerlink_push_registered_voip_devices_by_platform', JSON.parse(labels), value));
  }

  if (dbReady) {
    try {
      const result = await pool.query(
        `select status, count(*)::int as count
         from observed_servers
         group by status`,
      );
      lines.push('# HELP peerlink_observed_servers_by_status Servers by latest checker status.');
      lines.push('# TYPE peerlink_observed_servers_by_status gauge');
      for (const row of result.rows) {
        lines.push(metricLine('peerlink_observed_servers_by_status', { status: row.status }, row.count));
      }
      const moderation = await pool.query(
        `select
           count(*)::int as total,
           count(*) filter (where status = 'pending')::int as pending,
           count(*) filter (where status in ('resolved', 'rejected'))::int as processed
         from moderation_reports`,
      );
      lines.push('# HELP peerlink_moderation_reports Reports by processing state.');
      lines.push('# TYPE peerlink_moderation_reports gauge');
      const moderationRow = moderation.rows[0] || {};
      lines.push(metricLine('peerlink_moderation_reports', { state: 'total' }, moderationRow.total || 0));
      lines.push(metricLine('peerlink_moderation_reports', { state: 'pending' }, moderationRow.pending || 0));
      lines.push(metricLine('peerlink_moderation_reports', { state: 'processed' }, moderationRow.processed || 0));
    } catch (_) {
      lines.push(metricLine('peerlink_push_observability_postgres_query_error', {}, 1));
    }
  }

  return `${lines.join('\n')}\n`;
}
