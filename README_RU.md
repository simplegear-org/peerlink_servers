# PeerLink server suite

Этот репозиторий содержит набор серверных сервисов для PeerLink:
- `relay` — HTTP relay и blob API (`store/fetch/ack`, `group/store`, `blob upload/download`)
- `signal` — bootstrap signaling сервер
- `push` — сервер отправки push через Firebase Cloud Messaging (FCM)
- `coturn` — TURN сервер для WebRTC, с опциональным TURNS на 5349
- `haproxy` — reverse proxy и TLS termination

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

HTTP-сервис, который хранит токены устройств и отправляет push:
- обычные события/уведомления через FCM и APNs alert
- входящие звонки через data-only FCM и APNs VoIP (канал выбирает сервер)
- metadata-only moderation reports, appeals и ручной peer policy status для UGC/moderation flow
- banned peer не может регистрировать устройства, отправлять signed push fanout или создавать новые reports; решение `warning`/`ban` принимает только модератор
- при ручном `warning`/`ban` push best-effort отправляет пользователю `moderation_policy`; payload содержит `messageKey`, `reportCount` и `reporterCount`, а клиент показывает текст на локали пользователя
- Moderator UI предзаполняет note причиной с количеством жалоб и числом уникальных жалобщиков без раскрытия их Peer ID; клиент при `banned` локально закрывает коммуникационный UI и оставляет appeal
- `GET /moderation/status` возвращает `signedStatus`, если задан `MODERATION_STATUS_SIGNING_PRIVATE_KEY`

- `POST /send` — отправка push (`{ token, data, notification? }`)
- `POST /devices/register` — регистрация/обновление устройства (`userId`, `deviceId`, `messageToken`, `messageProvider`, `voipToken?`, `platform`)
- `POST /devices/unregister` — деактивация устройства
- `GET /devices/by-user/:userId` — список устройств пользователя
- `POST /events/push` — универсальный signed fanout push-событий по устройствам получателей
- `POST /moderation/reports` — прием жалоб
- `GET /moderation/status` — текущий moderation score/status по `peerId`
- `POST /moderation/appeals` — прием апелляций
- `GET /admin/reports`, `POST /admin/reports/:id/action`, `POST /admin/moderation/peers/:peerId/action` — metadata-only очередь и ручные действия `warn`/`ban`
- `GET /admin/moderation/reported-peers` — агрегат пользователей, на которых пожаловались: всего/direct/group
- `GET /admin/moderation/reporters` — агрегат пользователей, которые жалуются: всего/direct/group
- `GET /health` — статус конфигурации FCM и защитных механизмов

Security-логика push разнесена по отдельным модулям:
- `devices/registry.js` — in-memory registry message/VoIP токенов устройств
- `devices/routes.js` — маршруты `/devices/*`
- `delivery/dedup-cache.js` — TTL-cache для дедупликации push-событий
- `delivery/providers.js` — клиенты FCM/APNs и проверка APNs topic
- `moderation/routes.js` — клиентские и admin маршруты модерации
- `observability.js` — facade `PushObservability` и bootstrap Postgres schema
- `observability/server-discovery.js` — извлечение/нормализация server URL из push payload
- `observability/metrics.js` — Prometheus metrics builder и counters
- `observability/moderation-helpers.js` — moderation score mappers и policy helpers
- `observability/server-checker.js` — health checker observed servers
- `security/signed-requests.js` — Ed25519-проверка write-запросов и replay cache
- `security/identity-bindings.js` — v2 binding `peerId -> signingPub` и soft enforcement
- `push.js` только подключает эти проверки к нужным маршрутам

Обновление уже развернутого push stack выполняется одной командой:

```bash
./update-push.sh
```

Скрипт подгружает `.env.push.local`, сбрасывает checkout на `origin/main`,
делает `docker compose pull` для images из обновленного
`docker-compose.push.yml`, затем `docker compose up -d --no-build`,
перезапускает `push-proxy` и `moderation-ui`, чтобы nginx заново разрешил
актуальные IP контейнеров, и показывает статус с последними логами
`push`/`server-checker`.

Для write-endpoint’ов `push` используется relay-подобная Ed25519 проверка:
- обязательные поля: `id`, `from`, `ts`, `sig`, `signingPub`
- для `/devices/register` поле `from` должно совпадать с `userId`
- payload `/devices/register`:
  - `messageToken` обязателен,
  - `messageProvider` (`fcm`/`apns`, по умолчанию `fcm`),
  - `voipToken` опционален (для iOS/macOS),
  - legacy-подпись: `id|from|deviceId|messageToken|messageProvider|voipToken|platform|appVersion|ts`
  - новые клиенты добавляют `identitySchemaVersion=2`, `identityNonce`, `identityProofSig`
  - v2-подпись register: `id|from|deviceId|messageToken|messageProvider|voipToken|platform|appVersion|identitySchemaVersion|identityNonce|identityProofSig|ts`
  - identity proof payload: `peerlink_identity_binding_v2|peerId|signingPub|identityNonce`
- `/devices/register` проверяет `peerId == SHA-256("uid:v2:" + signingPub + ":" + identityNonce)` и сохраняет binding `peerId -> signingPub`
- режим миграции soft: legacy-клиенты без binding продолжают работать, но если binding уже есть, mismatch ключа отклоняется для `/events/push`, `/moderation/reports` и `/moderation/appeals`
- для `/events/push` поле `from` должно совпадать с `senderUserId`
- anti-replay по `id` через TTL-кэш на стороне сервиса
- `POST /events/push` принимает `senderUserId`, `recipientUserIds`, app-defined `payload`, опциональные `notification` и `delivery`.
- standard delivery идет на message-токены через FCM/APNs alert или silent push; VoIP delivery идет на APNs VoIP (`apns-push-type: voip`).
- FCM `data` нормализуется к строковым значениям; вложенные объекты вроде `servers` сериализуются в JSON.
- Если `notification.title/body` не переданы, standard delivery остается silent/data-only. Android `call_invite` использует этот путь, чтобы клиент сам решил foreground/fullscreen отображение.

Moderation policy хранится в Postgres observability DB:
- жалобы только увеличивают счетчики по `reportedPeerId`
- `warning` и `banned` выставляет только модератор, автоматических переходов по числу жалоб нет
- `banned` peer не может регистрировать устройства, отправлять signed push fanout или создавать новые reports; relay/bootstrap не требуют доступа к moderation DB
- admin endpoints защищены `MODERATION_ADMIN_TOKEN` или, если он не задан, `PUSH_API_TOKEN`
- клиентские `POST /moderation/reports` и `POST /moderation/appeals` защищены
  Ed25519-подписью peer, без доставки admin token в приложение
- отдельный moderator UI поднимается в push-only compose на `127.0.0.1:4501`

### coturn

Сервис `coturn/coturn` работает в `network_mode: host` и предоставляет:
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

### Доступность исходного кода

PeerLink Servers публикует source metadata для AGPL source availability:

```text
GET /.well-known/peerlink-source
```

Relay и push отдают этот endpoint по HTTP. Bootstrap signaling также включает
эти metadata в WebSocket payload `register_ack`.

Официальные deployments должны задавать:

- `SOURCE_VERSION`
- `SOURCE_CODE_URL`

Для официальных source snapshot-ов `SOURCE_CODE_URL` должен указывать на
immutable public source tag запущенной версии.

Если оператор разворачивает измененную AGPL-версию и обязан предоставить
Corresponding Source, `SOURCE_CODE_URL` должен указывать на исходный код именно
его развернутой версии, а не просто на upstream PeerLink repository.

Этот механизм помогает пользователям найти исходный код. Операторы остаются
ответственными за соблюдение лицензии.

### Docker Compose

Файл: `docker-compose.yml`

Содержит конфигурацию для всех четырёх сервисов. `coturn` и `haproxy` монтируют self-signed сертификат из хоста.

### TURN

Файл: `turnserver.conf`

Генерируется автоматически в `deploy.sh`:
- `listening-ip=<PUBLIC_IP>`
- `relay-ip=<PUBLIC_IP>`
- `external-ip=<PUBLIC_IP>`
- `realm=<PUBLIC_HOST>`
- `lt-cred-mech`
- `user=<turn-user>:<turn-password>`
- `cert=/etc/coturn/certs/fullchain.pem`
- `pkey=/etc/coturn/private/privkey.pem`

> Примечание: `deploy.sh` генерирует TURN-конфиг с long-term credentials. TURN username/password должны совпадать с конфигурацией клиента.

### HAProxy

Файл: `haproxy.cfg`

Настраивает HTTPS termination только для `signal` и `relay`.

## Быстрая установка

Для воспроизводимого source deployment checkout-ните public source tag и
соберите контейнеры из этого исходного кода:

```bash
git clone https://github.com/simplegear-org/peerlink_servers.git
cd peerlink_servers
git checkout source-v1.1.0
docker compose build
docker compose up -d
```

Для автоматической установки текущего/default ref:

```bash
wget -qO- https://raw.githubusercontent.com/simplegear-org/peerlink_servers/main/bootstrap.sh | bash
```

Для установки конкретного public source tag:

```bash
wget -qO- https://raw.githubusercontent.com/simplegear-org/peerlink_servers/main/bootstrap.sh | bash -s -- https://github.com/simplegear-org/peerlink_servers.git source-v1.1.0
```

### Source-build и official image modes

Default public self-hosted model — source-build mode: `docker-compose.yml` и
`docker-compose.push.yml` собирают PeerLink server containers из текущего
checked-out source tree.

Official prebuilt image mode можно использовать через image variables вроде
`PUSH_IMAGE`, но release deployment должен использовать version-specific image
tags или immutable digests, а не floating `latest` tags.

Runtime source metadata должны описывать реально запущенный source. Official
deployments могут задавать `SOURCE_VERSION` и `SOURCE_CODE_URL`, но эти
значения должны соответствовать реально запущенному image/source.

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

Теперь отдельный push-стек включает:
- `push` на внутреннем `4500`
- `push-proxy` (`nginx`) на публичных `80/443`
- `certbot` для первичного выпуска сертификата
- `certbot-renewer` для автоматического продления сертификатов
- `push-observability-db` для каталога найденных self-hosted серверов
- `server-checker` для проверки найденных relay/signal/TURN endpoint-ов
- `prometheus` и `grafana` для метрик и графиков

Используйте отдельный файл для push-стека:

```bash
docker compose -f docker-compose.push.yml build
docker compose -f docker-compose.push.yml up -d
```

Обязательные переменные окружения:
- `PUSH_PUBLIC_HOST`
- `LETSENCRYPT_EMAIL`, если `PUSH_TLS_PROVIDER=letsencrypt`
- `PUSH_TLS_PROVIDER` (`letsencrypt` по умолчанию или `cloudflare_origin`)
- `PUSH_ORIGIN_CERT_PEM`, если `PUSH_TLS_PROVIDER=cloudflare_origin`
- `PUSH_ORIGIN_KEY_PEM`, если `PUSH_TLS_PROVIDER=cloudflare_origin`
- `PUSH_API_TOKEN`
- `FCM_PROJECT_ID`
- `FCM_CREDENTIALS_JSON`
- `APNS_TEAM_ID`
- `APNS_KEY_ID`
- `APNS_PRIVATE_KEY`
- `APNS_VOIP_TOPIC` (должен оканчиваться на `.voip`)
- `APNS_MESSAGES_TOPIC` (полный app topic для alert-push, без `.voip`)
- `PUSH_OBSERVABILITY_POSTGRES_PASSWORD`
- `GRAFANA_ADMIN_PASSWORD`

Готовый скрипт запуска:

```bash
cp .env.push.example .env.push.local
# заполните .env.push.local
bash ./deploy-push.sh
```

Bootstrap для чистого Debian:

```bash
apt-get update && apt-get install -y ca-certificates curl && curl -fsSL https://raw.githubusercontent.com/simplegear-org/peerlink_servers/main/bootstrap-push.sh -o bootstrap-push.sh && REPO_URL=https://github.com/simplegear-org/peerlink_servers.git bash bootstrap-push.sh
```

Что теперь делает `deploy-push.sh`:
- ставит Docker Engine и Docker Compose plugin на чистом Debian/Ubuntu
- готовит каталоги для `nginx`, ACME webroot и состояния Let's Encrypt
- поднимает `push` и `push-proxy` во временном HTTP-режиме
- выпускает сертификат через `certbot --webroot`
- переключает `nginx` на HTTPS
- запускает отдельный контейнер с циклом автопродления
- умеет `PUSH_TLS_PROVIDER=cloudflare_origin` с Cloudflare Origin CA вместо certbot для оранжевого облака
- запускает Postgres, Prometheus, Grafana и checker для мониторинга push/server discovery

Публичный endpoint push API:

```text
https://<PUSH_PUBLIC_HOST>
```

### Мониторинг push и self-hosted серверов

`push` отдаёт внутренний `GET /metrics` для Prometheus. Этот endpoint не
проксируется наружу через публичный `push-proxy`.

Self-hosted серверы извлекаются из `payload.servers`, `signalServers`,
`relayServers`, `turnServers` и `iceServers` в `/events/push` и `/send`.
Postgres хранит полный список серверов, счётчики сообщений/звонков, статус
проверки и latency последней проверки.

Grafana доступна только на origin-хосте.

Для сайта публикуйте только свежие healthy серверы:

```sql
select normalized_url
from observed_servers
where status = 'healthy'
  and last_checked_at > now() - interval '15 minutes'
  and seen_count >= 3
order by last_check_latency_ms asc nulls last, last_seen_at desc;
```

## Лицензирование

PeerLink Servers — open-source ПО, распространяемое под GNU Affero General
Public License version 3 only (AGPL-3.0-only).

Коммерческое использование под AGPL-3.0-only разрешено.

Организации, которым нужны другие proprietary, OEM, white-label или enterprise
условия, могут запросить отдельное коммерческое соглашение.

См.:

- LICENSE
- LICENSE-HISTORY.md
- COMMERCIAL-LICENSING.md
- BRANDING.md
- SECURITY.md
- CONTRIBUTING.md
- CLA-POLICY.md
- GITHUB_PUBLIC_MIRROR_SETTINGS.md
- SOURCE_SNAPSHOT.md
- THIRD_PARTY_NOTICES.md

## Модель репозитория

Этот репозиторий является публичным mirror-репозиторием исходных snapshot-ов
PeerLink Servers.

Разработка ведется в отдельном development-репозитории.

Этот репозиторий содержит чистые snapshot-ы исходного кода, соответствующие
публичным релизам PeerLink Servers.

Git-история здесь представляет публичные source snapshot-ы и не предназначена
для воспроизведения внутренней истории разработки проекта.

Публичный mirror содержит минимальный source-distribution набор для
опубликованных серверов: license и third-party notices, brand/security/
contributor policy documents, публичные README, package manifests,
Docker/Compose/deploy scripts, runtime server source и `source-info.js`.

Рекомендация для Cloudflare:
- для этого стека по умолчанию использовать `DNS only` (серое облако)

Почему:
- проще выпуск и отладка Let's Encrypt
- прямой TLS termination на origin
- меньше промежуточных слоев при диагностике FCM/APNs

Если позже захочешь включить proxy Cloudflare:
- ставь `Full (strict)`
- не кэшируй API hostname/path

Для постоянного оранжевого облака используй Cloudflare Origin CA:

```env
PUSH_TLS_PROVIDER=cloudflare_origin
PUSH_ORIGIN_CERT_PEM='-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----'
PUSH_ORIGIN_KEY_PEM='-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----'
```

В Cloudflare:
- DNS record для `PUSH_PUBLIC_HOST`: `Proxied`
- SSL/TLS mode: `Full (strict)`
- Origin certificate должен включать `PUSH_PUBLIC_HOST`

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

### TURN compatibility credentials

PeerLink X сейчас использует фиксированные TURN compatibility credentials:

- Username: `peerlink`
- Password: `peerlink`

Эти значения являются частью текущего client/server compatibility contract
PeerLink X и не предназначены для роли секретных административных credentials.

Изменение этих значений в self-hosted PeerLink Servers deployment не позволит
текущим клиентам PeerLink X использовать этот TURN server, если клиент тоже не
обновлён на те же credentials.

Поэтому для текущих PeerLink X deployment operators должны оставлять эти
compatibility credentials без изменений.

Защиту TURN resources следует строить через network restrictions, allocation
limits и bandwidth limits, а не через трактовку этих credentials как секретных
access-control credentials.

`./deploy.sh` по умолчанию применяет bandwidth limits:

- `TURN_MAX_BPS=10000000`
- `TURN_BPS_CAPACITY=100000000`

Coturn resource limits можно изменить перед deployment:

- `TURN_TOTAL_QUOTA`
- `TURN_USER_QUOTA`
- `TURN_MAX_BPS`
- `TURN_BPS_CAPACITY`

Эти значения опциональны и должны быть неотрицательными целыми числами. Пустое
значение отключает default. С `TURN_TOTAL_QUOTA` и `TURN_USER_QUOTA` нужно быть
осторожным: текущие deployment могут полагаться на один TURN server, а клиенты
PeerLink X используют один TURN username, поэтому низкие allocation quotas могут
сломать легитимные одновременные звонки.

Если нужно использовать другую ОС, `deploy.sh` потребуется адаптировать.

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
Для операций доставки в группу действует серверная проверка членства:

- `POST /relay/group/store`: отправитель и все получатели должны быть участниками группы
- `POST /relay/blob/upload`, `/relay/blob/upload/chunk`, `/relay/blob/upload/complete`:
  storage-only запись подписанного blob; членство группы здесь не проверяется, потому что авторизация доставки выполняется на `/relay/group/store`
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
- `FCM_CREDENTIALS_JSON` (JSON service account строкой; в `.env.push.local` весь JSON нужно обернуть в одинарные кавычки; если не задан, используется ADC)

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
