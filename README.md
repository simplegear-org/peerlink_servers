# PeerLink server suite

PeerLink Servers is the self-hosted server stack for PeerLink X: durable Relay
delivery, bootstrap signaling, Push via FCM/APNs, contact invites and TURN.

## Services

- **Relay** — signed encrypted envelope and blob storage/delivery. See
  [Relay](docs/public/RELAY.md).
- **Signal** — authenticated WebSocket bootstrap signaling. See
  [Signal](docs/public/SIGNAL.md).
- **Push** — device registration, FCM/APNs fanout, access-policy filtering and
  moderation delivery. See [Push](docs/public/PUSH.md).
- **Invite** — signed, durable short-token contact invitations.
- **coturn** — TURN/TURNS media relay for calls.
- **HAProxy / Push proxy** — TLS termination and service routing.

## Deployment

The base Relay/Signal/TURN stack and Push stack are deployed independently.
Operational commands, required environment variables and rollout checks are
documented in the service guides above.

## Documentation

- [Documentation index](docs/README.md)
- [Security policy](docs/public/SECURITY.md)
- [Contributing](docs/public/CONTRIBUTING.md)
- [Changelog](docs/public/CHANGELOG.md)
- [License history](docs/public/LICENSE-HISTORY.md)
- [Third-party notices](docs/public/THIRD_PARTY_NOTICES.md)

Russian overview: [README_RU.md](README_RU.md).

## License

PeerLink Servers is distributed under [AGPL-3.0-only](LICENSE). Commercial
licensing information is in [docs/public/COMMERCIAL-LICENSING.md](docs/public/COMMERCIAL-LICENSING.md).
