// SPDX-License-Identifier: AGPL-3.0-only

export function requireRequestObject(body, res) {
  if (body && typeof body === 'object') return true;
  res.status(400).json({ error: 'invalid body' });
  return false;
}

export function requireRequestFields(body, fields, res) {
  for (const field of fields) {
    if (!(field in body)) {
      res.status(400).json({ error: `missing ${field}` });
      return false;
    }
  }
  return true;
}
