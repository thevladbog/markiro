# Выпуски автонома: публикация дистрибутива из SaaS-админки

Спека: `docs/superpowers/specs/2026-10-20-standalone-download-trial-pricing-design.md`, раздел 5
(решение 5.4 — публичный бакет релизов). Код: `apps/api/src/modules/standalone-releases/`,
раздел «Выпуски автонома» в `apps/saas-admin`.

## Поток

1. Владелец собирает и подписывает пакет у себя: `tools/standalone-release/sign-update.mjs`,
   ключ выпусков офлайн. Получаются два файла:
   `markiro-standalone-<версия>-windows-x86_64-setup.exe` и
   `markiro-standalone-<версия>.update.jws`.
2. В разделе «Выпуски автонома» выбирает оба файла. Панель читает канал и версию из манифеста,
   просит у API подписанные ссылки на запись (`POST /api/platform/standalone-releases/uploads`)
   и грузит файлы в бакет напрямую из браузера (presigned PUT с заголовком
   `Content-Type: application/octet-stream`). Через API установщик не идёт.
3. `POST /api/platform/standalone-releases/registrations`: API сам читает оба объекта и
   регистрирует версию, только если
   - манифест подписан ключом выпусков, который знают хосты (`apps/standalone/proto/fixtures/trust-keys.json`,
     копия в `release-trust-keys.ts`, тест держит их равными);
   - `product`, `channel` и версия манифеста совпадают с путём;
   - версия выше всех уже зарегистрированных в канале;
   - размер и SHA-256 установщика равны полям манифеста.

   Регистрация — файл `standalone/<channel>/<версия>/release.json`. При отказе неподтверждённые
   файлы версии удаляются (если у ключа есть право на удаление; иначе папка видна в разделе как
   «незавершённая загрузка»).

4. «Сделать последней» (`PUT /api/platform/standalone-releases/<channel>/latest`) пишет
   `standalone/<channel>/latest.json` в формате спеки 5.3. Перед этим API заново сверяет байты
   версии с регистрацией и подпись манифеста с текущими ключами. Откат — та же кнопка у более
   ранней версии; файлы версий не удаляются.

Пути неизменяемы: на зарегистрированную версию ссылки на запись не выдаются, повторная
регистрация тех же байтов отвечает `unchanged`, других — отказ `standalone_release_immutable`.
Изменения в канале сериализуются `pg_advisory_xact_lock`.

**Панель ничего не подписывает.** Взлом панели может переключить указатель только на ранее
подписанный пакет; хост при обновлении всё равно проверяет манифест.

## Аудит (платформенный журнал)

| Действие                              | Когда                                                                             |
| ------------------------------------- | --------------------------------------------------------------------------------- |
| `standalone.release.upload.authorize` | выданы ссылки на запись                                                           |
| `standalone.release.register`         | `success` — версия зарегистрирована; `rejected` — отказ проверки (код в `reason`) |
| `standalone.release.latest.set`       | указатель перенесён (`after.direction`: `promote` или `rollback`) или отказ       |

`targetType` — `standalone_release`, `targetId` — `<channel>/<версия>`; в `after` — канал,
версия, `kid`, SHA-256 и размер установщика, SHA-256 манифеста.

## Конфигурация

`RELEASES_S3_ENDPOINT`, `RELEASES_S3_REGION`, `RELEASES_S3_BUCKET`, `RELEASES_S3_ACCESS_KEY_ID`,
`RELEASES_S3_SECRET_ACCESS_KEY` — все пять или ни одного. Без них раздел пишет «не настроено»,
готовность API от них не зависит; частичный набор роняет запуск и `preflight`.
`RELEASES_PUBLIC_ORIGIN` (по умолчанию `https://releases.markiro.app`) — откуда ссылки в
`latest.json`.

Загрузки идут path-style на `RELEASES_S3_ENDPOINT`, поэтому это и есть origin для CSP админки.
На платформе он закреплён: `RELEASES_UPLOAD_ORIGIN` в `deploy/platform/preflight.mjs` =
`https://s3.twcstorage.ru` (Timeweb S3, регион `ru-1`), и `saas_admin_csp` в
`deploy/platform/Caddyfile` разрешает `connect-src` ровно к нему (тест
`deploy/platform/test/contracts.test.mjs`). Переезд бакета — правка обоих мест одним коммитом.
`RELEASES_S3_BUCKET` равен `MARKIRO_RELEASES_BUCKET`, бакету, который edge раздаёт на
`releases.markiro.app`; как он устроен — [хостинг выпусков](../runbooks/release-hosting.md).

Диагностика автонома берёт «последнюю опубликованную сборку» из `standalone/stable/latest.json`
(кеш 60 с; без хранилища или при ошибке — «неизвестно», вердикта «устарела» нет).

## Шаги владельца

Бакет, публичное чтение `standalone/*`, CORS для `PUT` из SaaS-админки, отдельный ключ API и
env платформы описаны в [хостинге выпусков](../runbooks/release-hosting.md), шаги 1–7. После них:

1. В «Выпусках автонома» раздел больше не пишет «не настроено».
2. Загрузить подписанный пакет. Ошибка «Хранилище не приняло файл» означает, что CORS бакета
   или права ключа не применились.
3. Нажать «Сделать последней» в канале `stable`, проверить
   `https://releases.markiro.app/standalone/stable/latest.json` и страницу `/skachat/`: версия
   видна, в консоли браузера нет CORS-ошибки.

## Что не проверено автоматикой

Живая загрузка в бакет Timeweb, CORS, политика бакета и скачивание с `releases.markiro.app` —
только вручную на стенде. Тесты API работают с хранилищем в памяти и проверяют форму подписанной ссылки
(path-style, подписанный `content-type`, без контрольной суммы SDK).
