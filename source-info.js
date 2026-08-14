// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from 'fs';

const packageJson = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
);

export const sourceVersion = process.env.SOURCE_VERSION || packageJson.version;
export const sourceTag = `source-v${sourceVersion}`;
export const sourceCodeUrl =
  process.env.SOURCE_CODE_URL ||
  `https://github.com/simplegear-org/peerlink_servers/tree/${sourceTag}`;

export function sourceInfo() {
  return {
    project: 'PeerLink Servers',
    version: sourceVersion,
    license: 'AGPL-3.0-only',
    source: sourceCodeUrl,
  };
}
