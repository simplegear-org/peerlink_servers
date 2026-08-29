// SPDX-License-Identifier: AGPL-3.0-only

export function createDeviceRegistry({ maxDevicesPerUser }) {
  const devicesByUser = new Map();
  const tokenToOwner = new Map();
  const voipDevicesByUser = new Map();
  const voipTokenToOwner = new Map();

  function devicePublicView(device) {
    return {
      userId: device.userId,
      deviceId: device.deviceId,
      platform: device.platform,
      appVersion: device.appVersion,
      enabled: device.enabled,
      lastSeenAt: device.lastSeenAt,
      updatedAt: device.updatedAt,
    };
  }

  function ensureUserDevices(userId) {
    let devices = devicesByUser.get(userId);
    if (!devices) {
      devices = new Map();
      devicesByUser.set(userId, devices);
    }
    return devices;
  }

  function ensureVoipUserDevices(userId) {
    let devices = voipDevicesByUser.get(userId);
    if (!devices) {
      devices = new Map();
      voipDevicesByUser.set(userId, devices);
    }
    return devices;
  }

  function registerDevice({ userId, deviceId, token, platform, appVersion, messageProvider = 'fcm' }) {
    return registerDeviceGeneric({
      userId,
      deviceId,
      token,
      platform,
      appVersion,
      messageProvider,
      ensureDevices: ensureUserDevices,
      devicesByUserMap: devicesByUser,
      tokenToOwnerMap: tokenToOwner,
    });
  }

  function registerVoipDevice({ userId, deviceId, token, platform, appVersion }) {
    return registerDeviceGeneric({
      userId,
      deviceId,
      token,
      platform,
      appVersion,
      ensureDevices: ensureVoipUserDevices,
      devicesByUserMap: voipDevicesByUser,
      tokenToOwnerMap: voipTokenToOwner,
    });
  }

  function registerDeviceGeneric({
    userId,
    deviceId,
    token,
    platform,
    appVersion,
    messageProvider,
    ensureDevices,
    devicesByUserMap,
    tokenToOwnerMap,
  }) {
    const devices = ensureDevices(userId);
    const now = Date.now();
    const previousOwner = tokenToOwnerMap.get(token);
    if (previousOwner && (previousOwner.userId !== userId || previousOwner.deviceId !== deviceId)) {
      const previousDevices = devicesByUserMap.get(previousOwner.userId);
      const previousDevice = previousDevices?.get(previousOwner.deviceId);
      if (previousDevice && previousDevice.token === token) {
        previousDevice.enabled = false;
        previousDevice.updatedAt = now;
        previousDevices.set(previousOwner.deviceId, previousDevice);
      }
    }
    if (!devices.has(deviceId) && devices.size >= Math.max(1, maxDevicesPerUser)) {
      let oldest = null;
      for (const candidate of devices.values()) {
        if (!oldest || candidate.lastSeenAt < oldest.lastSeenAt) {
          oldest = candidate;
        }
      }
      if (oldest) {
        devices.delete(oldest.deviceId);
        if (tokenToOwnerMap.get(oldest.token)?.deviceId === oldest.deviceId) {
          tokenToOwnerMap.delete(oldest.token);
        }
      }
    }
    const existing = devices.get(deviceId);
    const device = {
      userId,
      deviceId,
      token,
      platform,
      appVersion,
      messageProvider: messageProvider || 'fcm',
      enabled: true,
      lastSeenAt: now,
      updatedAt: now,
      createdAt: existing?.createdAt ?? now,
    };
    devices.set(deviceId, device);
    tokenToOwnerMap.set(token, { userId, deviceId });
    return device;
  }

  function unregisterDevice({ userId, deviceId, token }) {
    return unregisterDeviceGeneric({
      userId,
      deviceId,
      token,
      devicesByUserMap: devicesByUser,
      tokenToOwnerMap: tokenToOwner,
    });
  }

  function unregisterVoipDevice({ userId, deviceId, token }) {
    return unregisterDeviceGeneric({
      userId,
      deviceId,
      token,
      devicesByUserMap: voipDevicesByUser,
      tokenToOwnerMap: voipTokenToOwner,
    });
  }

  function unregisterDeviceGeneric({ userId, deviceId, token, devicesByUserMap, tokenToOwnerMap }) {
    const devices = devicesByUserMap.get(userId);
    if (!devices) return false;
    const device = devices.get(deviceId);
    if (!device) return false;
    if (device.token !== token) return false;
    device.enabled = false;
    device.updatedAt = Date.now();
    devices.set(deviceId, device);
    if (tokenToOwnerMap.get(token)?.userId === userId && tokenToOwnerMap.get(token)?.deviceId === deviceId) {
      tokenToOwnerMap.delete(token);
    }
    return true;
  }

  function getActiveTokensForUsers(userIds) {
    return getActiveTokensForUsersFromMap(userIds, devicesByUser);
  }

  function getActiveVoipTokensForUsers(userIds) {
    return getActiveTokensForUsersFromMap(userIds, voipDevicesByUser);
  }

  function hasActiveVoipTokenForDevice({ userId, deviceId }) {
    const device = voipDevicesByUser.get(userId)?.get(deviceId);
    return Boolean(device?.enabled && device.token);
  }

  function getActiveTokensForUsersFromMap(userIds, devicesByUserMap) {
    const tokens = [];
    for (const userId of userIds) {
      const devices = devicesByUserMap.get(userId);
      if (!devices) continue;
      for (const device of devices.values()) {
        if (device.enabled && device.token) {
          tokens.push({
            userId,
            deviceId: device.deviceId,
            token: device.token,
            platform: device.platform || '',
            messageProvider: device.messageProvider || 'fcm',
          });
        }
      }
    }
    return tokens;
  }

  function getDevice({ userId, deviceId }) {
    return devicesByUser.get(userId)?.get(deviceId) || null;
  }

  function listDevicesForUser(userId) {
    return Array.from((devicesByUser.get(userId) || new Map()).values()).map(devicePublicView);
  }

  function stats() {
    return {
      users: devicesByUser.size,
      tokens: tokenToOwner.size,
      voipUsers: voipDevicesByUser.size,
      voipTokens: voipTokenToOwner.size,
      maxDevicesPerUser,
    };
  }

  return {
    maps: {
      devicesByUser,
      tokenToOwner,
      voipDevicesByUser,
      voipTokenToOwner,
    },
    devicePublicView,
    getActiveTokensForUsers,
    getActiveVoipTokensForUsers,
    getDevice,
    hasActiveVoipTokenForDevice,
    listDevicesForUser,
    registerDevice,
    registerVoipDevice,
    stats,
    unregisterDevice,
    unregisterVoipDevice,
  };
}

export function shouldInvalidateVoipToken(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('"reason":"BadDeviceToken"')
    || message.includes('"reason":"Unregistered"');
}
