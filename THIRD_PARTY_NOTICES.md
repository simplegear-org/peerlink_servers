# Third-Party Notices

PeerLink Servers uses third-party open-source components. Their licenses remain
their own and are not changed by the PeerLink Servers AGPL-3.0-only licensing
transition.

## npm Dependencies

Primary direct dependencies from `package.json`:

- `express`
- `google-auth-library`
- `uuid`
- `ws`

Exact versions and package license metadata are recorded in `package-lock.json`.

## Runtime Images and Services

The deployment stack references third-party runtime components:

- Node.js base images
- coturn
- HAProxy
- nginx
- certbot

Review the relevant Docker image and operating-system package metadata for exact
versions used by a deployment.
