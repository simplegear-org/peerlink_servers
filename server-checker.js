// SPDX-License-Identifier: AGPL-3.0-only

import { runServerChecker } from './observability.js';

runServerChecker().catch((error) => {
  console.error('[server-checker] fatal:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
