# Хостинг выпусков: `releases.markiro.app` на Timeweb S3

С 22.10.2026 выпуски станции, подписанта, ТСД и автонома лежат в отдельном бакете
Timeweb S3, а `https://releases.markiro.app` раздаёт их через edge платформы
(Caddy на хосте платформы). Yandex Object Storage, CDN и Terraform
`infra/yandex` удалены. Публичные URL не менялись: updater-эндпоинты станции и
подписанта, `latest.json` ТСД и страница `/skachat/` читают тот же домен.

## Как устроено

- **Бакет.** Один бакет выпусков в Timeweb S3, path-style:
  `https://s3.twcstorage.ru/<bucket>/<key>`, регион `ru-1`. Это не приватный
  бакет платформы (`S3_BUCKET`): preflight отклоняет совпадение имён.
- **Чтение.** Сайт `releases_routes` в `deploy/platform/Caddyfile` пропускает
  только `GET`/`HEAD` точных раскладок ниже. Он отбрасывает query string
  клиента (`?acl`, `?versionId`, листинги), а также заголовки `Authorization`,
  `Cookie` и `Origin`. Из ответа бакета убираются `x-amz-*`, `Server`,
  `Set-Cookie` и CORS-заголовки. Всё остальное, включая корень, листинг, другие
  префиксы и методы, получает `404` с `Cache-Control: no-store`. Ключа к бакету у
  edge нет: объекты читаются анонимно.
- **Кэш.** `Cache-Control` объекта главный. Издатели пишут
  `public, max-age=0, must-revalidate` на указатели и
  `public, max-age=31536000, immutable` на версии. Публикация станции сверяет
  это значение через `releases.markiro.app`. Если у объекта заголовка нет
  (например, у файлов автонома, загруженных из браузера), edge ставит
  `public, max-age=60, must-revalidate` на `latest.json` и `/download` и годовой
  `immutable` на файлы версии. Отсутствующий объект отдаётся как `404`, сбой
  бакета как `502`, оба с `no-store`: версию, запрошенную до публикации, браузер
  не запомнит как отсутствующую.
- **CORS.** `Access-Control-Allow-Origin: https://<MARKIRO_LANDING_DOMAIN>`
  ставится только на `GET`. Он нужен `fetchLatestRelease` на `/skachat/`.
  Preflight-запросы не нужны: это простой `GET`.
- **Загрузка.** Station, signer и handheld пишут из GitHub Actions ключом
  издателя. Автоном пишет SaaS API: браузер админки отправляет presigned PUT на
  `https://s3.twcstorage.ru`, и только этот origin разрешён в `connect-src`
  `saas_admin_csp` (`RELEASES_UPLOAD_ORIGIN` в `deploy/platform/preflight.mjs`).

| Путь                                                                                 | Что это                                 |
| ------------------------------------------------------------------------------------ | --------------------------------------- |
| `station/{beta,stable}/latest.json`, `handheld/{beta,stable}/latest.json`            | указатель канала                        |
| `signer/stable/latest.json`, `standalone/{beta,stable}/latest.json`                  | указатель канала                        |
| `station/download`, `station/beta/download`, `signer/download`                       | постоянная ссылка на текущий установщик |
| `handheld/download`, `handheld/beta/download`                                        | постоянная ссылка на текущий APK        |
| `{station,handheld}/{beta,stable}/releases/<version>/<file>`                         | неизменяемые файлы версии               |
| `signer/stable/releases/<version>/<file>`, `standalone/{beta,stable}/<x.y.z>/<file>` | неизменяемые файлы версии               |

`/download` — это копия объекта со своим `Content-Disposition`, а не редирект.

## Шаги владельца

Порядок важен: без шагов 1–6 ни один release-workflow не опубликует версию.

### 1. Бакет

Создайте в Timeweb Cloud бакет S3 в регионе `ru-1`, например
`markiro-releases`. Имя должно отличаться от приватного бакета платформы.
Если Timeweb позволяет, включите версионирование объектов.

### 2. Публичное чтение префиксов

Edge не подписывает запросы, поэтому вариант «приватный бакет и ключ у прокси»
не реализован. Бакету нужно анонимное чтение объектов
`station/*`, `signer/*`, `handheld/*` и `standalone/*`. Листинг давать не нужно.

- Если Timeweb поддерживает политику бакета, разрешите `s3:GetObject` для
  `Principal: "*"` ровно на эти четыре префикса, без `s3:ListBucket`.
- Если поддерживается только тип бакета «публичный», включите его и не кладите
  в этот бакет ничего, кроме выпусков. Прямые ссылки
  `https://s3.twcstorage.ru/<bucket>/...` при этом тоже станут публичными, и
  ограничения edge их не касаются.

Проверьте, что анонимное чтение существующего объекта даёт `200`, а листинг
бакета не даёт `200`:

```bash
curl -sS -o /dev/null -w '%{http_code}\n' "https://s3.twcstorage.ru/<bucket>/?list-type=2"
```

### 3. CORS бакета для загрузки автонома

Браузер SaaS-админки загружает установщик presigned PUT-запросом. Без CORS
раздел покажет «Хранилище не приняло файл». Правило:

```json
{
  "CORSRules": [
    {
      "AllowedOrigins": ["https://saas-admin.markiro.app"],
      "AllowedMethods": ["PUT"],
      "AllowedHeaders": ["content-type"],
      "MaxAgeSeconds": 3600
    }
  ]
}
```

Применить можно через панель Timeweb или любой S3-клиент, например:

```bash
aws s3api put-bucket-cors --endpoint-url https://s3.twcstorage.ru \
  --bucket <bucket> --cors-configuration file://releases-cors.json
```

Ключ берите из переменных окружения или профиля, не из аргументов команды.
`GET` в это правило не добавляйте: CORS для чтения отдаёт edge.

### 4. Ключи

Нужны два набора ключей:

- **Издатель** (GitHub Actions: станция, подписант, ТСД) — запись в
  `station/*`, `signer/*`, `handheld/*`.
- **SaaS API** (автоном) — запись в `standalone/*`.

Если Timeweb позволяет ограничить ключ префиксом или завести отдельного
S3-пользователя, ограничьте каждый ключ своими префиксами и не давайте права на
удаление. Если ключ видит весь бакет, учтите: утечка env платформы позволит
перезаписать выпуски станции. В таком случае храните ключ издателя только в
GitHub environments.

### 5. GitHub environments

`station-release` (станция и подписант):

- secret `RELEASES_S3_ACCESS_KEY_ID`;
- secret `RELEASES_S3_SECRET_ACCESS_KEY`;
- variable `RELEASES_S3_BUCKET` — имя бакета;
- variable `RELEASES_S3_ENDPOINT` — ровно `https://s3.twcstorage.ru`.

`handheld-release` (ТСД):

- secret `RELEASES_S3_ACCESS_KEY_ID`;
- secret `RELEASES_S3_SECRET_ACCESS_KEY`;
- variable `RELEASES_S3_BUCKET`.

Эндпоинт ТСД закреплён в самом workflow.

Секреты задавайте через stdin, а не аргументом:

```bash
gh secret set RELEASES_S3_ACCESS_KEY_ID --env station-release < "$access_key_file"
gh secret set RELEASES_S3_SECRET_ACCESS_KEY --env station-release < "$secret_key_file"
gh variable set RELEASES_S3_BUCKET --env station-release --body markiro-releases
gh variable set RELEASES_S3_ENDPOINT --env station-release --body https://s3.twcstorage.ru
```

Старые `YANDEX_STATION_RELEASE_*` удалите из обоих environments: workflow их
больше не читают.

### 6. Env платформы и выкатка edge

В защищённый `runtime.env` платформы (инвентарь — `deploy/platform/env.example`)
добавьте:

```text
MARKIRO_RELEASES_DOMAIN=releases.markiro.app
MARKIRO_RELEASES_BUCKET=<bucket>
RELEASES_S3_ENDPOINT=https://s3.twcstorage.ru
RELEASES_S3_REGION=ru-1
RELEASES_S3_BUCKET=<bucket>
RELEASES_S3_ACCESS_KEY_ID=<ключ SaaS API>
RELEASES_S3_SECRET_ACCESS_KEY=<секрет SaaS API>
```

Два `MARKIRO_RELEASES_*` обязательны: без них edge не стартует. Пять
`RELEASES_S3_*` задаются вместе или не задаются вовсе: без них раздел
«Выпуски автонома» пишет «не настроено». `RELEASES_S3_BUCKET` должен совпадать
с `MARKIRO_RELEASES_BUCKET`. Если задан `RELEASES_PUBLIC_ORIGIN`, он должен
равняться `https://<MARKIRO_RELEASES_DOMAIN>`. Всё это проверяет
`node deploy/platform/preflight.mjs`. Затем выпустите образы
(`release-platform-images.yml`) и выкатите платформу (`deploy-platform.yml`)
обычным путём.

### 7. DNS

Замените запись `releases.markiro.app`: вместо CNAME на CDN Yandex нужна
A-запись на хост платформы (тот же адрес, что у `markiro.app` и
`saas-admin.markiro.app`). Caddy получит сертификат сам, когда DNS укажет на
хост. Пока DNS не переключён, Caddy повторяет выпуск сертификата, а остальные
сайты платформы работают. Деплой-смоук платформы `releases.markiro.app` не
проверяет, поэтому выкатка не зависит от DNS.

### 8. Перенос уже выпущенных артефактов

Новый бакет пуст. Release-workflow рассчитаны на продолжение существующих
каналов, поэтому перенос нужно закончить **до** следующего выпуска:

- **Станция.** `mode=publish` требует полной пары `station/<channel>/latest.json`
  и `station/<channel>/download` и отказывает до первой записи. `seed-baseline`
  требует отсутствующего GitHub-канала и доказательства Terraform-плана, поэтому
  для повторного засева не подходит. Если сохранилась копия старого бакета,
  перенесите префикс `station/` целиком, сохранив `Content-Type`,
  `Cache-Control`, `Content-Disposition` и пользовательские метаданные. Без
  копии нужен отдельный инструмент, который собирает дерево `releases.markiro.app`
  из GitHub-зеркала `thevladbog/markiro-station-releases`. Он ещё не сделан.
  Пока дерева нет, станции с двумя источниками обновлений должны брать их из
  GitHub-зеркала: по коду updater (`apps/station/src-tauri/src/updater.rs`)
  сетевая или HTTP-ошибка основного источника переключает на GitHub. Вживую
  это не проверено.
- **Подписант.** `mode=publish` сверяет версию на GitHub и в бакете. Пустой
  бакет даёт расхождение, и workflow отказывает. Перенесите префикс `signer/`
  из копии старого бакета. Иначе нужен тот же инструмент восстановления из
  GitHub Release `signer-v*`.
- **ТСД.** GitHub-зеркала нет. Если `handheld/<channel>/latest.json` нет
  (`404`), `handheld-release` считает канал пустым и выпускает `versionCode 1`.
  Установленные терминалы такое обновление отклонят. **Не запускайте выпуск ТСД**,
  пока не восстановлен `handheld/` из копии старого бакета или указатель с
  текущим `versionCode`.
- **Автоном.** Переносить нечего: раздел «Выпуски автонома» публикует в новый
  бакет с первой загрузки.

### 9. Проверка после переключения

```bash
curl -sS -D - -o /dev/null https://releases.markiro.app/station/stable/latest.json
# 200, Content-Type: application/json, Cache-Control от объекта
curl -sS -o /dev/null -w '%{http_code}\n' https://releases.markiro.app/
# 404
curl -sS -o /dev/null -w '%{http_code}\n' 'https://releases.markiro.app/station/stable/latest.json?acl'
# 200: query отброшен, ACL не отдаётся
curl -sS -o /dev/null -D - -H 'Origin: https://markiro.app' \
  https://releases.markiro.app/standalone/stable/latest.json | grep -i '^access-control-allow-origin'
# access-control-allow-origin: https://markiro.app
curl -sS -o /dev/null -w '%{http_code}\n' -X PUT https://releases.markiro.app/station/stable/latest.json
# 404
```

Затем откройте `https://markiro.app/skachat/`: страница показывает версию из
`latest.json`, в консоли браузера нет CORS-ошибки. Проверьте также, что
установленная станция находит обновление в Центре обновлений.

## Что проверено и что нет

Автоматически проверяются конфигурация edge (`deploy/platform/test`), preflight,
контракты release-workflow и инструментов (`tools/*-release/test`) и
отказы сайта выпусков в CI-стенде платформы (`deploy/platform/smoke.mjs`):
корень, листинг, чужие префиксы и небезопасные методы дают `404`. Поведение
прокси (отброс query и учётных данных, `Cache-Control` объекта, `404`/`502` с
`no-store`, CORS только на `GET`) проверено вручную на `caddy:2.11.4-alpine` с
поддельным upstream.

Не проверены: живой Timeweb S3 (политика, CORS, условная запись `If-None-Match`,
которой пользуются издатели), DNS и TLS `releases.markiro.app`, публикация
каждым workflow и обновление установленной станции, подписанта и ТСД.
