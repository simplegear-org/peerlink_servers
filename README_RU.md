# PeerLink server suite

PeerLink Servers — self-hosted серверный стек PeerLink X: durable Relay
доставка, bootstrap signaling, Push через FCM/APNs, contact invite и TURN.

## Сервисы

- **Relay** — хранение и доставка подписанных зашифрованных envelope и blob.
  См. [Relay](docs/public/RELAY.md).
- **Signal** — аутентифицированный WebSocket bootstrap signaling. См.
  [Signal](docs/public/SIGNAL.md).
- **Push** — регистрация устройств, FCM/APNs fanout, access-policy filtering и
  moderation delivery. См. [Push](docs/public/PUSH.md).
- **Invite** — подписанные durable short-token contact invite.
- **coturn** — TURN/TURNS media relay для звонков.
- **HAProxy / Push proxy** — TLS termination и маршрутизация сервисов.

## Деплой

Базовый Relay/Signal/TURN stack и Push stack разворачиваются независимо.
Команды, обязательные environment variables и rollout-проверки описаны в
соответствующих service guide выше.

## Документация

- [Индекс документации](docs/README.md)
- [Политика безопасности](docs/public/SECURITY.md)
- [Участие в проекте](docs/public/CONTRIBUTING.md)
- [История изменений](docs/public/CHANGELOG.md)
- [История лицензии](docs/public/LICENSE-HISTORY.md)
- [Сторонние лицензии](docs/public/THIRD_PARTY_NOTICES.md)

English overview: [README.md](README.md).

## Лицензия

PeerLink Servers распространяется под [AGPL-3.0-only](LICENSE). Условия
коммерческого лицензирования: [docs/public/COMMERCIAL-LICENSING.md](docs/public/COMMERCIAL-LICENSING.md).
