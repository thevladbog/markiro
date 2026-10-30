# Хостинг выпусков: `releases.markiro.app` и неизменяемый каталог

Timeweb S3 хранит версии байтов. PostgreSQL-каталог определяет, какая точная версия
принадлежит публичному пути. Caddy раздаёт только результат внутреннего API resolver.
Развёртывание, DNS/TLS, публикация и обновление установленного устройства — отдельные
gates; наличие кода в main не доказывает ни один из них.

## Защита от перезаписи

Поведенческая проверка Timeweb показала, что `If-None-Match: *` не предотвращает
повторный PUT. Нельзя заменять защиту на HEAD+PUT или считать 200 подтверждением
неизменяемости. Legacy conditional-write guards сохраняются, но действующие
Station/handheld/standalone publisher paths используют каталог:

1. Аутентифицированный издатель создаёт intent с точными version/sourceSha/именами,
   размерами, MIME и SHA256. Product source SHA отделён от workflow tooling SHA.
2. Загружает только выданные `product/_uploads/<intent>/<name>` staging keys и
   сохраняет VersionId каждого ответа в приватном durable журнале.
3. API читает **точные версии**, проверяет полные байты и канонический product
   manifest/signature/evidence, сохраняет локальный receipt и versioned S3 receipt.
   Только затем одна DB-транзакция фиксирует весь набор файлов и аудит.
4. Издатель проверяет полный публичный readback, затем меняет канал отдельным CAS
   по исходной revision и operation ID. `latest.json` и `/download` читают одну
   привязку канала. Lost response не разрешает новый ID, повторный PUT или
   автоматическое удаление GitHub-канала/S3-объектов.

Чтение существующего пути всегда использует записанный VersionId и SHA256.
Замена current S3 head не меняет релиз. Resolver проверяет весь файл до HEAD/range/
отправки байтов, использует приватный bounded cache и disk reserve. Нет места,
нет exact version или недоступна DB — ошибка, без fallback к текущему объекту.

## Публичные маршруты

| Путь                                                                                 | Назначение               |
| ------------------------------------------------------------------------------------ | ------------------------ |
| `station/{beta,stable}/latest.json`, `handheld/{beta,stable}/latest.json`            | указатель канала         |
| `signer/stable/latest.json`, `standalone/{beta,stable}/latest.json`                  | указатель канала         |
| `station/download`, `station/beta/download`, `signer/download`                       | текущий установщик       |
| `handheld/download`, `handheld/beta/download`                                        | текущий APK              |
| `{station,handheld}/{beta,stable}/releases/<version>/<file>`                         | точная immutable binding |
| `signer/stable/releases/<version>/<file>`, `standalone/{beta,stable}/<x.y.z>/<file>` | точная immutable binding |

Caddy разрешает только GET/HEAD, отбрасывает query, Authorization, Cookie, Origin
и upstream служебные заголовки. Internal resolver недоступен через обычные tenant/
SaaS hosts. Кэш: версии — `public, max-age=31536000, immutable`, pointers/download —
`no-cache`, ошибки — `no-store`. CORS чтения разрешает только landing origin.
Публичное чтение S3 может оставаться для диагностики, но не участвует в принятой
раздаче. `/download` отдаёт проверенные байты, не redirect на S3.

## Настройка до rollout

- Отдельный `markiro-releases`, endpoint `https://s3.twcstorage.ru`, регион `ru-1`.
  Не использовать backup/media bucket. Versioning включён, current/noncurrent
  lifecycle expiry для upload и ledger prefixes отсутствует. Это проверяется
  фактически, не только по названию настройки в панели.
- Publisher key: GetObject/PutObject только `station/*`, `signer/*`, `handheld/*`.
  SaaS API key: GetObject/PutObject и ограниченный ListBucket только `standalone/*`.
  Catalog key: GetObjectVersion в четырёх release prefixes; PutObject,
  GetObjectVersion и ListBucketVersions только `_publication-ledger/*`.
  Без DeleteObject/DeleteObjectVersion, управления бакетом и доступа к копиям.
- S3 CORS: только origin SaaS admin, PUT и нужные signing/checksum headers;
  ExposeHeaders включает `x-amz-version-id`, чтобы сохранить точную запись.
  Проверить старый VersionId и denial matrix отдельно, без вывода ключей.
- `station-release` и `handheld-release`: secrets `RELEASES_S3_ACCESS_KEY_ID`,
  `RELEASES_S3_SECRET_ACCESS_KEY`, variable `RELEASES_S3_BUCKET`; для Station
  `RELEASES_S3_ENDPOINT=https://s3.twcstorage.ru`. Существующие signing secrets
  остаются в protected environments. OIDC использует `id-token: write` и audience
  `markiro-release-catalog`, exact repo/owner/main/environment/workflow SHA pins.
  Новый tooling SHA требует reviewed pin; одного имени workflow недостаточно.
- Платформа: `MARKIRO_RELEASES_DOMAIN`, `MARKIRO_RELEASES_BUCKET` и пять
  `RELEASES_S3_*` для SaaS upload. Catalog использует отдельные
  `RELEASE_CATALOG_S3_ENDPOINT`, `RELEASE_CATALOG_S3_REGION`,
  `RELEASE_CATALOG_S3_BUCKET`, `RELEASE_CATALOG_S3_ACCESS_KEY_ID`,
  `RELEASE_CATALOG_S3_SECRET_ACCESS_KEY`, `RELEASE_CATALOG_CACHE_DIR`,
  `RELEASE_CATALOG_JOURNAL_DIR`, `RELEASE_CATALOG_CACHE_BYTES`,
  `RELEASE_CATALOG_OBJECT_BYTES`, `RELEASE_CATALOG_DISK_RESERVE_BYTES`,
  `RELEASE_CATALOG_DOWNLOADS`, `RELEASE_CATALOG_TIMEOUT_MS`,
  `RELEASE_CATALOG_WRITERS_ENABLED`, `RELEASE_CATALOG_PUBLISHERS_JSON`.
- До выкатки измерить свободный диск и крупнейшие accepted artifacts, выбрать
  явные capacity/object/reserve bounds. Cache и journal — приватные отдельные
  mounts `/opt/markiro-platform/release-catalog/{cache,journal}`, uid/gid1000,
  mode0700, один API/coordinator. Не создавать/chown mounts как side effect.
  Защищённый host boundary добавляет `compose.catalog.yml` к base+compact только
  при полной проверенной конфигурации каталога. Без неё base+compact не требуют
  каталогов cache/journal; передать произвольный Compose-файл через runtime нельзя.
  Bootstrap только platform-only с `RELEASE_CATALOG_WRITERS_ENABLED=false`.

Не выкатывать неполный runtime.env: preflight должен пройти до protected dispatch.
Секреты передаются штатным защищённым способом, не в аргументах, логах или Git.

### GitHub environments

`station-release` (Station publisher):

- secret `RELEASES_S3_ACCESS_KEY_ID`;
- secret `RELEASES_S3_SECRET_ACCESS_KEY`;
- variable `RELEASES_S3_BUCKET`;
- variable `RELEASES_S3_ENDPOINT`.

`handheld-release` (ТСД publisher):

- secret `RELEASES_S3_ACCESS_KEY_ID`;
- secret `RELEASES_S3_SECRET_ACCESS_KEY`;
- variable `RELEASES_S3_BUCKET`.

Секреты передаются через stdin из защищённых файлов, например:

```bash
gh secret set RELEASES_S3_ACCESS_KEY_ID --env station-release < "$access_key_file"
gh secret set RELEASES_S3_SECRET_ACCESS_KEY --env station-release < "$secret_key_file"
```

Старые `YANDEX_STATION_RELEASE_*` не используются новым publisher. Их удаление
не заменяет проверку нового хранилища и не должно затрагивать независимые копии.

## История и перенос

Следовать [импорту и recovery](release-catalog-recovery.md). Полный текущий GitHub
listing не доказывает всю выданную историю. Недоступные старые байты оставляют
reserved404/write409; неизвестная верхняя граница закрывает namespace.

- **Станция.** Сначала импорт/резервация всей доказанной истории, затем read-only
  resolver и readback. `station-release-reseed.yml` принимает exact GitHub tags,
  releaseSha и canonical origin conversion; пересобирает только origin metadata,
  не бинарники. `owner_confirmation=RESEED-STATION-RELEASES`, `beta_tag`, `stable_tag`
  остаются обязательным reviewed вводом. Пустой каталог требует revision0, а не
  просто HTTP404. Публикация идёт через intent/VersionId/commit/CAS, журнал всегда
  сохраняется в workflow artifact. `seed-baseline` закрыт: старый Terraform proof
  не является admission каталога. Не запускать reseed по двум heads как замену
  инвентаризации. Stable сохраняет exact-beta source/binary provenance.
- **Подписант.** Только проверенный исторический import/read. Новые релизы и
  publisher API исключены; отсутствие исходного набора не разрешает новый baseline.
- **ТСД.** Сохранить занятые старые версии даже без APK. Первый новый выпуск —
  `1.7.0 (16)` после `1.6.1 (15)` при доказанно пустом канале и явном
  `empty_channel_confirmation=1.6.1 (15)`. Это не разрешение включить namespace
  с недоказанной историей. См. [выпуск ТСД](handheld-release.md).
- **Автоном.** 1.0.0 уже выпущен. Сохранить оригинальные installer и signed update
  manifest. 1.1.0 — кандидат; его подпись и клиентское обновление требуют отдельной
  проверки. SaaS UI считает hashes до загрузки, сохраняет intent при retry и
  никогда не удаляет байты после неоднозначного результата регистрации.

## Защищённый запуск и проверка

1. Exact reviewed main CI, образ и source closure; fresh backup, изолированный
   restore и независимые encrypted Mac/Timeweb copies с каталогом и журналом.
2. Runtime/mount/IAM/versioning/lifecycle/OIDC gates; writers disabled; approved
   history import. Затем protected rollout read-only resolver.
3. Проверить intended host и строгий TLS до A-записи `releases.markiro.app` на
   платформу. DNS и release-host smoke проверять отдельно от обычного deploy smoke.
4. Полные SHA/signature readbacks, GET/HEAD/range/ETag, denied routes, cache и
   уникальный technical byte-swap: заменить current S3 version и доказать, что
   resolver продолжает возвращать первоначальную pinned версию. Все версии сохранить.
5. Только для доказанного namespace — отдельный reviewed writer epoch activation
   и protected publication/reseed. Проверять exact source, revision, original
   VersionIds и полные публичные байты после каждой операции.

Ни локальные тесты, ни CI не доказывают Windows updater, CryptoAPI/DPAPI,
установленный ТСД, сканер, принтер или заводскую смену. Указывать эти проверки
отдельно. При отказе — сохранить journals и закрыть раздачу/публикацию; не откатывать
Caddy к mutable anonymous S3 и не очищать immutable copies.

## Формат образов платформы

Защищённый `release-platform-images.yml` выбирает classic Docker image store
(`overlay2`, `containerd-snapshotter=false`) на обоих эфемерных GitHub-hosted
runner до сборки или загрузки образов. Production daemon не перенастраивается.
Это сохраняет контракт одиночного Linux/amd64 manifest и точного config ID.

После каждого push издатель применяет тот же строгий registry validator, что и
production admission. OCI index, другая платформа, несовпадающий config ID или
ошибка чтения оставляют incomplete evidence и не создают complete manifest.
Привязки исходников, CI, archive SHA256, image ID и protected approval сохраняются.

### Initial read-only Autonom catalog

The separately protected `bootstrap-release-catalog.yml` workflow fills an initially empty `standalone/stable` catalog without enabling runtime writers. It imports only reviewed, already issued signed files through `CatalogHistoryOperator`, reserves the known issued history and commits the initial pointer by ledger-backed revision 0→1. Normal API publication still requires an active epoch and real caller authorization. Other namespaces stay closed. This is not a general writer activation or a new application deployment.

Before dispatch, select an exact executor commit with successful main-push CI and verify its `release-catalog-bootstrap-<SHA>` artifact: the manifest must identify the accepted compatible product, and both tooling files must pass full hash checks. A missing compatibility artifact means this path is unavailable; green unrelated application CI cannot substitute for it. Install exact reviewed source closure side by side, then independently reread the private operation file, input bytes, compiled tooling, accepted runtime/schema and all preserved journal/configuration guards. Prepare the operation directory, dedicated node-owned IPC directory and read-only input explicitly; the workflow never creates or changes catalog mount ownership.

A later main may change unrelated application or database sources while this operator still runs in the previously accepted immutable API image. The producer then admits only the frozen PR809 overlay: exact source hash, compiled JavaScript hash/size and runtime-script hash/size must all match the reviewed two-file payload. It emits the same verified buffers, never newer application/DB output. Any payload change rejects this frozen path; the original source-wide compatibility assertion remains unchanged. The selected executor’s successful main-push CI and its matching artifact are still mandatory. A cancelled CI run, a PR artifact or a different current-main artifact cannot substitute for them. No application rollout or schema migration is authorized by this compatibility path.

Main-push CI keeps its running check when another main commit arrives; later main pushes share the same queue rather than starting a competing main run. Stale PR checks still cancel on a newer PR revision.

To keep an already reviewed operation independent of unrelated merges, dispatch from the create-only tag `catalog-bootstrap-<full executor SHA>`. The tag must point to that exact commit; never move or delete it. Add only that exact tag name as a `tag` deployment policy for `production-deploy`, preserving the `main` policy and independent required reviewer with self-review disabled. Do not grant a wildcard tag policy. The workflow accepts only `main` or this full-SHA tag, and the host independently checks the run SHA, workflow, actor, first attempt and distinct reviewer. Successful historical main-push CI, its exact artifact and all accepted runtime/input guards remain mandatory; moving `main` is not an operation input. A platform upgrade remains main-only. An executor not admitted by successful main CI or incompatible with the accepted runtime is still rejected.

Host operation files live in `/opt/markiro-platform/catalog-bootstrap-operations/<execution UUID>/`. Protected workflow inputs bind their exact SHA256 and the successful CI attempt. The accepted API image and every API/edge/PostgreSQL ID and recipe are pinned. Secrets cross transport stdin and a private minimal worker env file; no license/CHZ/signing credentials are copied into that worker. Prepared operations have no queue expiry. Exact independent approval and active-run identity are rechecked before stop and every database mutation, together with complete active publisher/deployment pagination and physical guards.

The canonical deployment lock spans worker preparation, stopping only the API, import/channel commit, proof of worker exit, restarting the same API and final physical checks. Edge and PostgreSQL remain running; no Compose replacement or migration runs. The immutable plan pins two distinct existing network IDs: the API egress network and the internal PostgreSQL network. The worker is created on egress, attached to the database network before start, and its exact two-network membership is checked before API stop and every mutation; PostgreSQL stays on its internal network only. No new production network is created. The worker first proves database connectivity using the unchanged verify-full TLS URL and the accepted read-only CA mount while API stays healthy. It then waits at its first guard request; no mutation reply is sent until API is actually stopped. A failed or revoked preflight drains only that exact owned worker. A known failed worker resumes the unchanged core API after physical checks, while retaining every receipt and occupied name. An unconfirmed workload, source drift or failed restart retains the lock and requires observation/reconciliation. Never replay a failed host operation blindly.

The execution UUID is distinct from the stable catalog-operation UUID. After a _confirmed terminal failure_, a newly reviewed protected execution may reuse the exact original catalog input/UUID and existing immutable bindings; the library repairs a lost acknowledgement without moving a second pointer or repeating an ambiguous PUT. Live-worker uncertainty or a retained lock must first be reconciled. No journal, receipt, name or object is deleted to make progress.

After actual success, independently verify the public pointer, signed manifest, full installer hash/size, HEAD/ranges/cache behavior and rejected paths. Preserve independent receipt copies. A technical test key may prove old-version reads after a current-object replacement; do not replace release files or use a mutable-current fallback. Windows/device acceptance remains a separate check.
