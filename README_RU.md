# PeerLink server suite
Обновлено: 2026-05-16

Этот репозиторий содержит набор серверных сервисов для PeerLink:
- `relay` — HTTP relay и blob API (`store/fetch/ack`, `group/store`, `blob upload/download`)
- `signal` — bootstrap signaling сервер
- `push` — сервер отправки push через Firebase Cloud Messaging (FCM)
- `coturn` — TURN сервер для WebRTC, с опциональным TURNS на 5349
- `haproxy` — reverse proxy и TLS termination

> Этот проект написан исключительно силами ИИ-агентов; я выступаю только в роли координатора и ведущего разработки. Ни один символ кода не написан вручную.

## Общая архитектура

Проект разворачивается в Docker Compose и работает как единая система:

- `relay` пересылает сообщения между WebRTC peer-ами
- `relay` хранит/отдает подписанные envelope и обслуживает blob API
- `signal` регистрирует и аутентифицирует стабильный `peerId` (v2) по Ed25519-подписи
- `coturn` обеспечивает TURN-доступ через единый публичный host
- `haproxy` принимает HTTP/HTTPS и проксирует `relay` и `signal`

Контракт деплоя одинаковый и для домена, и для IP:
- `wss://PUBLIC_HOST:443` для bootstrap
- `https://PUBLIC_HOST:444` для relay
- `turn:PUBLIC_HOST:3478?transport=udp`
- `turn:PUBLIC_HOST:3478?transport=tcp`
- опционально `turns:PUBLIC_HOST:5349?transport=tcp`

`PUBLIC_HOST` — это адрес, к которому подключаются клиенты. `PUBLIC_IP` —
реальный внешний IP, который coturn использует как `external-ip`.

## Требования

- Debian/Ubuntu-подобная система для `deploy.sh`
- `bash`, `curl`, `sudo`
- Docker и Docker Compose (устанавливаются скриптом)
- OpenSSL

## Сервисы

### relay

Файл: `relay.js`

Сервис хранит подписанные сообщения и blob-данные. Поддерживает:
- `store/fetch/ack` для очереди сообщений,
- `group/store` для fan-out в групповых чатах,
- `blob/upload`, `blob/upload/chunk`, `blob/upload/complete`, `blob/:blobId` для передачи payload.
- relay-driven push hint для групповых сообщений с дедупликацией на стороне `push`.

Сервис не выполняет регистрацию peer и не обслуживает signaling.

Модель проверки relay:
- `GET /health` проверяет базовую живость и сетевую доступность
- `GET /relay/capabilities` отдаёт metadata о совместимости протокола
- `POST /relay/probe` выполняет лёгкий probe совместимости без подписи
  реального envelope и без изменения состояния relay

Это позволяет клиенту различать "сервер достижим по сети" и "сервер
совместим с текущим PeerLink relay protocol".

### signal

Файл: `signal.js`

Это bootstrap signaling-сервер со следующими возможностями:
- регистрация стабильного `peerId` (v2) через WebSocket
- безопасная проверка подписи регистрации
- обратная совместимость проверки подписи для legacy payload (v1)
- переустановка существующей сессии (`takeover`) при смене клиента или сети
- пересылка `signal` сообщений другому peer
- `ping/pong` heartbeat
- стабильные snapshots по `peers_request` (только реально онлайн peerId)
- серверный `lastSeenMs` в snapshots `peers`
- push `presence_update` для переходов `online/offline`

### push

Файл: `push.js`

HTTP-сервис, который хранит FCM-токены устройств и отправляет push в
FCM (`firebase.google.com`) через service account.

- `POST /send` — отправка push (`{ token, data, notification? }`)
- `POST /devices/register` — регистрация/обновление устройства (`userId`, `deviceId`, `token`, `platform`)
- `POST /devices/unregister` — деактивация устройства
- `GET /devices/by-user/:userId` — список устройств пользователя
- `POST /events/message` — fanout push-событий по устройствам получателей:
  - `group_update` для групповых чатов
  - `direct_update` для индивидуальных чатов
- `GET /health` — статус конфигурации FCM и защитных механизмов

Для write-endpoint’ов `push` используется relay-подобная Ed25519 проверка:
- обязательные поля: `id`, `from`, `ts`, `sig`, `signingPub`
- для `/devices/register` поле `from` должно совпадать с `userId`
- для `/events/message` поле `from` должно совпадать с `senderUserId`
- anti-replay по `id` через TTL-кэш на стороне сервиса
- для `POST /events/message` поддерживается контракт `push-v1.1`:
  - `schemaVersion=push-v1.1`,
  - подписанные relay-метаданные `relay.serverId`, `relay.scopeKind`, опционально `relay.blobId`, `relay.relayMessageId`,
  - если `schemaVersion` отсутствует, сохраняется backward-compatible проверка legacy-подписи.
- fanout `POST /events/message` отправляет в FCM одновременно `notification` (title/body) и `data` (технические поля `type`, `groupId` или `directPeerId`, `messageId` (`lastSeq`), `senderUserId`, `schemaVersion`, relay-метаданные), чтобы повысить видимость уведомлений на iOS в фоне.

### coturn

Сервис `instrumentisto/coturn` работает в `network_mode: host` и предоставляет:
- TURN: 3478
- опциональный TURNS: 5349
- Relay-порты: `49152-51819` (UDP/TCP), используются для медиа relay-кандидатов.

Он использует self-signed сертификат для `PUBLIC_HOST` и объявляет
`external-ip=PUBLIC_IP` в `turnserver.conf`.

### haproxy

HAProxy принимает HTTP/HTTPS и маршрутизирует:
- `wss://<IP>:443` -> `signal:3000`
- `https://<IP>:444` -> `relay:4000`

Для домена и для IP используется одна и та же схема: вместо `<IP>` берётся
`PUBLIC_HOST`.

Он работает в `network_mode: host` и использует сертификат `selfsigned.pem`.

TURN/TURNS не проксируется через HAProxy:
- `turn:PUBLIC_HOST:3478` и опциональный `turns:PUBLIC_HOST:5349` обслуживаются напрямую `coturn`,
- relay-порты `49152-51819` также открываются напрямую для media relay.

> `deploy.sh` ориентирован на Debian/Ubuntu и использует `apt`, `sudo`, Docker и OpenSSL.

## Конфигурация

### Docker Compose

Файл: `docker-compose.yml`

Содержит конфигурацию для всех четырёх сервисов. `coturn` и `haproxy` монтируют self-signed сертификат из хоста.

### TURN

Файл: `turnserver.conf`

Генерируется автоматически в `deploy.sh`:
- `external-ip=<PUBLIC_IP>`
- `realm=<PUBLIC_HOST>`
- `cert=/etc/coturn/certs/fullchain.pem`
- `pkey=/etc/coturn/private/privkey.pem`

> Примечание: по умолчанию `deploy.sh` использует примерный TURN-пользователь/пароль (`TURN_USER` / `TURN_PASSWORD`). Для боевого развёртывания замените их на надёжные значения и используйте корректные сертификаты.

### HAProxy

Файл: `haproxy.cfg`

Настраивает HTTPS termination только для `signal` и `relay`.

## Быстрая установка

Для автоматической установки скачайте и запустите bootstrap-скрипт:

```bash
wget -qO- https://raw.githubusercontent.com/simplegear-org/peerlink_servers/main/bootstrap.sh | bash
```

Или клонируйте репозиторий и запустите вручную:

```bash
git clone https://github.com/simplegear-org/peerlink_servers.git
cd peerlink_servers
./deploy.sh
```

### Локальный запуск

Для запуска серверов без Docker:

```bash
npm install
npm run start:signal
npm run start:relay
npm run start:push
```

`signal` будет слушать на `localhost:3000`, `relay` — на `localhost:4000`,
`push` — на `localhost:4500`.

### Отдельный деплой push через Docker Compose

Используйте отдельный файл для сервиса `push`:

```bash
docker compose -f docker-compose.push.yml up -d
```

Обязательные переменные окружения:
- `PUSH_API_TOKEN`
- `FCM_PROJECT_ID`
- `FCM_CREDENTIALS_JSON`

Готовый скрипт запуска:

```bash
cp .env.push.example .env.push.local
# заполните .env.push.local
bash ./deploy-push.sh
```

### Быстрый smoke-check relay

Проверка сетевой живости:

```bash
curl -i http://127.0.0.1:4000/health
```

Проверка protocol capabilities:

```bash
curl -i http://127.0.0.1:4000/relay/capabilities
```

Проверка protocol probe:

```bash
curl -i http://127.0.0.1:4000/relay/probe \
  -H 'Content-Type: application/json' \
  -d '{"v":"1","client":"peerlink-health-check"}'
```

## Развёртывание

Файл: `deploy.sh`

Скрипт автоматически:
- обновляет систему
- устанавливает Docker и Docker Compose
- определяет IP-адрес сервера (используя `ip route`, `hostname -I` или внешний сервис)
- использует `PUBLIC_HOST` для client-facing URL и сертификата CN/SAN
- использует `PUBLIC_IP` для coturn `external-ip`
- генерирует self-signed сертификат для `PUBLIC_HOST`
- генерирует `turnserver.conf` с правильным `external-ip` и `realm`
- запускает контейнеры

Запуск:

```bash
./deploy.sh
```

По умолчанию:
- `PUBLIC_IP` определяется автоматически; если определить не удалось, используется `127.0.0.1`
- `PUBLIC_HOST` по умолчанию равен `PUBLIC_IP`

Поведение self-hosted со стороны клиента:
- приложение просит у пользователя только один host: домен или IP
- перед деплоем приложение показывает preview итоговых endpoint-ов, которые будут добавлены в конфиг
- после `Deployment complete!` приложение делает короткий retry readiness-проверок bootstrap/relay/turn, чтобы дать контейнерам прогреться
- bootstrap и relay должны работать с сгенерированным self-signed сертификатом для `PUBLIC_HOST`
- текущие рекомендуемые TURN-записи, которые приложение добавляет автоматически:
  - `turn:PUBLIC_HOST:3478?transport=udp`
  - `turn:PUBLIC_HOST:3478?transport=tcp`

> Для запуска с кастомными TURN-учётными данными задайте переменные окружения `TURN_USER` и `TURN_PASSWORD` перед вызовом `./deploy.sh`.
>
> Пример:
> ```bash
> PUBLIC_HOST=peerlink.example.com TURN_USER=myuser TURN_PASSWORD=strongpass ./deploy.sh
> ```
>
> Если нужно использовать другую ОС, `deploy.sh` потребуется адаптировать.

## API signaling

Клиенты работают с сообщениями в формате:

```json
{
  "v": "1",
  "id": "string",
  "type": "string",
  "payload": {}
}
```

Поддерживаемые типы:
- `register`
- `register_ack`
- `signal`
- `ping`
- `pong`
- `peers_request`
- `peers`
- `presence_update`
- `error`

### Регистрация

Для `register` требуется криптографическая аутентификация:

```json
{
  "v": "1",
  "id": "1741590000123456",
  "type": "register",
  "payload": {
    "peerId": "PEER_ID",
    "client": {
      "name": "peerlink",
      "protocol": "1"
    },
    "capabilities": ["webrtc", "signal-relay"],
    "auth": {
      "scheme": "peerlink-ed25519-v1",
      "peerId": "PEER_ID",
      "timestampMs": 1741590002123,
      "nonce": "1741590002123456",
      "signingPublicKey": "BASE64",
      "signature": "BASE64",
      "legacyPeerId": "OPTIONAL_LEGACY_ID",
      "identityProfile": {
        "stableUserId": "PEER_ID",
        "endpointId": "OPTIONAL_ENDPOINT_ID",
        "fcmTokenHash": "OPTIONAL_HASH"
      }
    }
  }
}
```

#### Проверки регистрации

Сервер проверяет:
- `auth.scheme == peerlink-ed25519-v1`
- `auth.peerId == payload.peerId`
- `timestampMs` в пределах допустимого окна
- `nonce` не использовался ранее
- `signingPublicKey` является валидным Ed25519-ключом
- `signature` валидна для канонического payload
- если передан `identityProfile.stableUserId`, он должен совпадать с `payload.peerId`

Канонический payload подписи (v2):

```json
{
  "purpose": "bootstrap-register",
  "protocol": "1",
  "peerId": "PEER_ID",
  "timestampMs": 1741590002123,
  "nonce": "1741590002123456",
  "signingPublicKey": "BASE64",
  "legacyPeerId": "OPTIONAL_LEGACY_ID",
  "identityProfile": {
    "stableUserId": "PEER_ID",
    "endpointId": "OPTIONAL_ENDPOINT_ID",
    "fcmTokenHash": "OPTIONAL_HASH"
  }
}
```

Legacy-формат канонического payload (v1 fallback):

```json
{
  "purpose": "bootstrap-register",
  "protocol": "1",
  "peerId": "PEER_ID",
  "timestampMs": 1741590002123,
  "nonce": "1741590002123456",
  "signingPublicKey": "BASE64"
}
```

Сервер сначала проверяет подпись по v2-представлению, затем по v1 для обратной совместимости.

### Takeover старой сессии

Если приходит новый валидный `register` с тем же `peerId`:
- старая сессия закрывается
- новая становится активной
- клиент получает `register_ack`

Это поддерживает смену сети и восстановление после разрыва.

### Ошибки

Пример ответа ошибки:

```json
{
  "v": "1",
  "id": "srv-error-1",
  "type": "error",
  "payload": {
    "code": "INVALID_REGISTER_AUTH",
    "message": "signature verification failed"
  }
}
```

Типовые коды:
- `INVALID_JSON`
- `INVALID_VERSION`
- `INVALID_REGISTER`
- `INVALID_REGISTER_AUTH`
- `NOT_REGISTERED`
- `INVALID_SIGNAL`
- `PEER_NOT_FOUND`
- `SESSION_REPLACED`
- `UNKNOWN_TYPE`

## HTTP API relay

Сервис relay предоставляет следующие HTTP-эндпоинты:

- `GET /health`
  - возвращает статус сервиса
- `POST /relay/store`
  - сохраняет сообщение для получателя
  - в теле запроса обязательны: `id`, `from`, `to`, `ts`, `ttl`, `payload`, `sig`, `signingPub`
- `POST /relay/group/store`
  - выполняет fan-out одного сообщения на несколько получателей
  - в теле запроса обязательны: `id`, `from`, `groupId`, `recipients[]`, `ts`, `ttl`, `payload`, `sig`, `signingPub`
- `POST /relay/group/members/update`
  - обновляет авторитетный состав участников группы на relay
  - обязательные поля: `id`, `from`, `groupId`, `ownerPeerId`, `memberPeerIds[]`, `ts`, `ttl`, `sig`, `signingPub`
  - `from` должен совпадать с `ownerPeerId`
- `GET /relay/fetch?to=<recipient>&cursor=<id>&limit=<n>`
  - получает ожидающие сообщения для получателя
  - поддерживает пагинацию через `cursor`
- `POST /relay/ack`
  - подтверждает доставку сообщения
  - в теле запроса обязательны: `id`, `from`, `to`, `ts`, `sig`, `signingPub`
- `POST /relay/blob/upload`
  - single-shot загрузка blob payload
  - обязательные поля: `id`, `from`, `groupId`, `fileName`, `mimeType`, `ts`, `ttl`, `payload`, `sig`, `signingPub`
- `POST /relay/blob/upload/chunk`
  - загрузка части blob payload
  - обязательные поля: `id`, `from`, `groupId`, `fileName`, `mimeType`, `ts`, `ttl`, `chunkIndex`, `totalChunks`, `payload`
- `POST /relay/blob/upload/complete`
  - завершение chunked-upload и финальная проверка подписи blob
  - обязательные поля: `id`, `from`, `groupId`, `fileName`, `mimeType`, `ts`, `ttl`, `sig`, `signingPub`
- `GET /relay/blob/:blobId`
  - получение blob payload по идентификатору
- `POST /relay/push/register` (internal)
  - регистрирует связку `peerId -> token` для отправки push
  - обязательные поля: `peerId`, `token`
- `POST /relay/push/unregister` (internal)
  - удаляет связку `peerId -> token`
  - обязательные поля: `peerId`, `token`
- `GET /relay/push/health` (internal)
  - статус push-подсистемы (`providerConfigured`, `registeredPeers`)

Relay API выполняет серверную проверку Ed25519-подписи как для сообщений (`store`), так и для подтверждений доставки (`ack`).
Для групповых операций также действует серверная проверка членства:

- `POST /relay/group/store`: отправитель и все получатели должны быть участниками группы
- `POST /relay/blob/upload`, `/relay/blob/upload/chunk`, `/relay/blob/upload/complete`:
  отправитель должен быть участником группы (если состав группы уже известен relay)
- после успешного `POST /relay/group/store` relay отправляет push-hint `group_update` получателям
  (дедуп выполняется на стороне `push` сервиса)

Настройки relay push:
- `PUSH_PROVIDER_URL` — endpoint фактической отправки push (`{ token, data }`)
- `PUSH_PROVIDER_BEARER` — optional bearer для `PUSH_PROVIDER_URL`
- `PUSH_INTERNAL_TOKEN` — optional bearer для internal endpoint-ов `/relay/push/*`

Настройки `push`:
- `PORT` — порт сервиса (по умолчанию `4500`)
- `PUSH_API_TOKEN` — optional bearer-токен для защиты endpoint-ов (дополнительный слой)
- `PUSH_MAX_DEVICES_PER_USER` — ограничение числа устройств на пользователя (по умолчанию `20`)
- `PUSH_SIGNATURE_SKEW_SECONDS` — допустимое окно для `ts` подписи (по умолчанию `120`)
- `PUSH_SIGNED_ID_TTL_SECONDS` — TTL anti-replay кэша `id` (по умолчанию `300`)
- `FCM_PROJECT_ID`
- `FCM_CREDENTIALS_JSON` (JSON service account строкой; если не задан, используется ADC)

### Multi-node план без персистентного хранилища

1. Запускать минимум `3` relay-ноды за L4/L7 балансировщиком (round-robin/least-conn), без sticky-сессий как обязательного условия.
2. Push оставить только как wakeup-hint: доставка данных и подтверждения (`fetch/ack`) остаются через relay API.
3. Клиент регистрирует push-токен не в одну ноду, а в `N` relay (`/relay/push/register` fan-out на shortlist).
4. Дедуп push выполнять централизованно на `push` сервисе по ключу `token+groupId+lastSeq`.
5. При перезапуске `push` in-memory дедуп кэш очищается; кратковременные дубли push допустимы.
6. Клиент всегда держит fallback-path: periodic fetch + fetch при reconnect, чтобы outage push/FCM не ломал получение сообщений.
7. Для `signal` запускать минимум `2-3` bootstrap-ноды; клиент держит несколько `wss` endpoint и делает re-register/takeover при переключении.
8. Добавить health-check и авто-исключение dead-нод на стороне клиента/оркестратора, чтобы не упираться в одну недоступную ноду.

Подписываемые payload:

- store: `id|from|to|ts|ttl|` + декодированные байты `payload`
- group-store: `id|from|groupId|recipient1,recipient2,...|ts|ttl|` + декодированные байты `payload`
- group-members-update: `id|from|groupId|ownerPeerId|member1,member2,...|ts|ttl`
- ack: `id|from|to|ts`
- blob-upload / blob-complete: `id|from|groupId|fileName|mimeType|ts|ttl|` + декодированные байты blob payload

Поведение валидации:

- некорректный body/поля -> `400`
- невалидная подпись -> `401` (`{"error":"invalid signature"}`)
- нарушение членства в группе -> `403`
- конфликт owner в `/relay/group/members/update` -> `409`

### Успешная регистрация

```json
{
  "v": "1",
  "id": "srv-ack-1",
  "type": "register_ack",
  "payload": {
    "peerId": "PEER_ID",
    "sessionId": null
  }
}
```

## Рекомендуемая эксплуатация

- Используйте HAProxy для HTTPS termination и прокси.
- Для IP-сертификата принимается self-signed сертификат с IP SAN.
- На клиенте нужно доверить сертификат вручную.
- На production полезно хранить состояние `peer` и `nonce` вне памяти процесса.
- Можно добавить метрики по `register_ack`, `INVALID_REGISTER_AUTH`, `SESSION_REPLACED`, времени восстановления.
