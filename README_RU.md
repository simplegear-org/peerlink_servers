# PeerLink server suite
Обновлено: 2026-05-04

Этот репозиторий содержит набор серверных сервисов для PeerLink:
- `relay` — HTTP relay и blob API (`store/fetch/ack`, `group/store`, `blob upload/download`)
- `signal` — bootstrap signaling сервер
- `coturn` — TURN/TLS сервер для WebRTC
- `haproxy` — reverse proxy и TLS termination
- `monitoring` — встроенный стек мониторинга (Grafana + Prometheus + Loki)

> Этот проект написан исключительно силами ИИ-агентов; я выступаю только в роли координатора и ведущего разработки. Ни один символ кода не написан вручную.

## Общая архитектура

Проект разворачивается в Docker Compose и работает как единая система:

- `relay` пересылает сообщения между WebRTC peer-ами
- `relay` хранит/отдает подписанные envelope и обслуживает blob API
- `signal` регистрирует и аутентифицирует стабильный `peerId` (v2) по Ed25519-подписи
- `coturn` обеспечивает TURN/TLS доступ по IP
- `haproxy` принимает HTTP/HTTPS и проксирует `relay` и `signal`

Вместо публичного домена используется self-signed сертификат для IP с длительным сроком действия.

Дополнительно в систему встроен стек мониторинга и логирования.

## Мониторинг

В систему встроен production-grade мониторинг:

### Компоненты

- Grafana — визуализация
- Prometheus — сбор и хранение метрик
- Loki — хранение логов
- Promtail — сбор логов
- cAdvisor — метрики контейнеров
- Node Exporter — метрики хоста
- Blackbox Exporter — проверка доступности сервисов

### Доступ
https://<IP>/monitor/

Логин по умолчанию:
admin / admin

### Что мониторится

- CPU / RAM / диск
- Docker контейнеры
- сеть
- доступность signal / relay
- TURN порты
- системные и контейнерные логи

### Хранение данных

- Prometheus: ограничение по времени и размеру
- Loki: ~7 дней
- Docker logs: авто-ротация

### Безопасность

- сервисы мониторинга слушают только `127.0.0.1`
- наружу открыт только Grafana
- используется тот же TLS сертификат

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

Сервис не выполняет регистрацию peer и не обслуживает signaling.

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

### coturn

Сервис `instrumentisto/coturn` работает в `network_mode: host` и предоставляет:
- TURN: 3478
- TURNS: 5349
- Relay-порты: `49152-51819` (UDP/TCP), используются для медиа relay-кандидатов.

Он использует self-signed сертификат на IP из `turnserver.conf`.

### haproxy

HAProxy принимает HTTP/HTTPS и маршрутизирует:
- `wss://<IP>:443` -> `signal:3000`
- `https://<IP>:444` -> `relay:4000`

Он работает в `network_mode: host` и использует сертификат `selfsigned.pem`.

TURN/TURNS не проксируется через HAProxy:
- `turn:<IP>:3478` и `turns:<IP>:5349` обслуживаются напрямую `coturn`,
- relay-порты `49152-51819` также открываются напрямую для media relay.

> `deploy.sh` ориентирован на Debian/Ubuntu и использует `apt`, `sudo`, Docker и OpenSSL.

## Конфигурация

### Docker Compose

Файл: `docker-compose.yml`

Содержит конфигурацию для всех четырёх сервисов. `coturn` и `haproxy` монтируют self-signed сертификат из хоста.

### TURN

Файл: `turnserver.conf`

Генерируется автоматически в `deploy.sh` с автоматически определённым IP:
- `external-ip=<CERT_IP>`
- `realm=<CERT_IP>`
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
```

`signal` будет слушать на `localhost:3000`, `relay` — на `localhost:4000`.

## Развёртывание

Файл: `deploy.sh`

Скрипт автоматически:
- обновляет систему
- устанавливает Docker и Docker Compose
- определяет IP-адрес сервера (используя `ip route`, `hostname -I` или внешний сервис)
- генерирует self-signed сертификат для найденного IP с длительным сроком действия
- генерирует `turnserver.conf` с правильным `external-ip` и `realm`
- запускает контейнеры

Запуск:

```bash
./deploy.sh
```

По умолчанию скрипт пытается определить IP автоматически. Если определение не удалось, используется `127.0.0.1`.

> Для запуска с кастомными TURN-учётными данными задайте переменные окружения `TURN_USER` и `TURN_PASSWORD` перед вызовом `./deploy.sh`.
>
> Пример:
> ```bash
> TURN_USER=myuser TURN_PASSWORD=strongpass ./deploy.sh
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

Relay API выполняет серверную проверку Ed25519-подписи как для сообщений (`store`), так и для подтверждений доставки (`ack`).
Для групповых операций также действует серверная проверка членства:

- `POST /relay/group/store`: отправитель и все получатели должны быть участниками группы
- `POST /relay/blob/upload`, `/relay/blob/upload/chunk`, `/relay/blob/upload/complete`:
  отправитель должен быть участником группы (если состав группы уже известен relay)

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
