# Third-Party Notices

PeerLink Servers uses third-party open-source components. Their licenses remain
their own and are not changed by the PeerLink Servers AGPL-3.0-only licensing
transition.

## npm Dependencies

Primary direct dependencies from `package.json`:

- `express` 5.2.1 — MIT
- `google-auth-library` 9.15.1 — Apache-2.0
- `uuid` 13.0.2 — MIT
- `ws` 8.21.3 — MIT

These values are taken from the current `package-lock.json`.

## Runtime Images and Services

The deployment stack references third-party runtime components:

- Node.js base images
- coturn
- HAProxy
- nginx
- certbot

Review the relevant Docker image and operating-system package metadata for exact
versions used by a deployment.
