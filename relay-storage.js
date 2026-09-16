// SPDX-License-Identifier: AGPL-3.0-only

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

function fsyncDirectory(directory) {
  let descriptor;
  try {
    descriptor = fs.openSync(directory, 'r');
    fs.fsyncSync(descriptor);
  } catch (error) {
    // Some development filesystems do not support directory fsync. Linux
    // production filesystems do; the preceding file fsync still protects the
    // snapshot contents when directory fsync is unavailable.
    if (!['EINVAL', 'ENOTSUP', 'EPERM'].includes(error.code)) throw error;
  } finally {
    if (descriptor != null) fs.closeSync(descriptor);
  }
}

class PersistentRelayMap extends Map {
  constructor(filePath, { encodeValue = (value) => value, decodeValue = (value) => value } = {}) {
    super();
    this.filePath = filePath;
    this.encodeValue = encodeValue;
    this.decodeValue = decodeValue;
    this.#load();
  }

  set(key, value) {
    super.set(key, value);
    this.#save();
    return this;
  }

  delete(key) {
    const deleted = super.delete(key);
    if (deleted) this.#save();
    return deleted;
  }

  #load() {
    try {
      this.#discardTemporarySnapshots();
      if (!fs.existsSync(this.filePath)) return;
      const entries = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      if (!Array.isArray(entries)) throw new Error('expected entry array');
      for (const entry of entries) {
        if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string') continue;
        const value = this.decodeValue(entry[1]);
        if (value !== null) super.set(entry[0], value);
      }
    } catch (error) {
      console.error(`[relay] could not load ${this.filePath}: ${error.message}`);
    }
  }

  #save() {
    const directory = path.dirname(this.filePath);
    fs.mkdirSync(directory, { recursive: true });
    const entries = [...this.entries()].map(([key, value]) => [key, this.encodeValue(value)]);
    const temporaryPath = `${this.filePath}.tmp-${process.pid}-${crypto.randomUUID()}`;
    let descriptor;

    try {
      descriptor = fs.openSync(temporaryPath, 'wx', 0o600);
      fs.writeFileSync(descriptor, JSON.stringify(entries), 'utf8');
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = null;

      fs.renameSync(temporaryPath, this.filePath);
      fsyncDirectory(directory);
    } catch (error) {
      if (descriptor != null) fs.closeSync(descriptor);
      try {
        fs.unlinkSync(temporaryPath);
      } catch (cleanupError) {
        if (cleanupError.code !== 'ENOENT') throw cleanupError;
      }
      throw error;
    }
  }

  #discardTemporarySnapshots() {
    const directory = path.dirname(this.filePath);
    const prefix = `${path.basename(this.filePath)}.tmp-`;

    if (!fs.existsSync(directory)) return;

    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.startsWith(prefix)) {
        fs.unlinkSync(path.join(directory, entry.name));
      }
    }
  }
}

export class RelayMessageStore extends PersistentRelayMap {
  constructor(dataDir) {
    super(path.join(dataDir, 'messages.json'));
  }
}

export class RelayBlobStore extends PersistentRelayMap {
  constructor(dataDir) {
    super(path.join(dataDir, 'blobs.json'));
  }
}

export class RelayGroupMembershipStore extends PersistentRelayMap {
  constructor(dataDir) {
    super(path.join(dataDir, 'group-memberships.json'), {
      encodeValue: (value) => (
        Number.isFinite(value.expiredAtMs)
          ? { expiredAtMs: value.expiredAtMs }
          : { ...value, memberPeerIds: [...value.memberPeerIds] }
      ),
      decodeValue: (value) => {
        if (!value || typeof value !== 'object') return null;
        if (Number.isFinite(value.expiredAtMs)) return { expiredAtMs: value.expiredAtMs };
        if (!Array.isArray(value.memberPeerIds)) return null;
        return { ...value, memberPeerIds: new Set(value.memberPeerIds) };
      },
    });
  }
}

export class RelayAckTombstoneStore extends PersistentRelayMap {
  constructor(dataDir) {
    super(path.join(dataDir, 'ack-tombstones.json'));
  }
}

export class RelayBlobUploadStore extends PersistentRelayMap {
  constructor(dataDir) {
    super(path.join(dataDir, 'blob-uploads.json'), {
      encodeValue: (value) => ({
        ...value,
        chunks: [...value.chunks.entries()].map(([index, bytes]) => [index, bytes.toString('base64')]),
      }),
      decodeValue: (value) => {
        if (!value || typeof value !== 'object' || !Array.isArray(value.chunks)) return null;
        const chunks = new Map();
        for (const entry of value.chunks) {
          if (!Array.isArray(entry) || !Number.isInteger(entry[0]) || typeof entry[1] !== 'string') continue;
          chunks.set(entry[0], Buffer.from(entry[1], 'base64'));
        }
        return { ...value, chunks };
      },
    });
  }
}
