# Бакет релизов для автонома: apply и ключ SaaS API

Раздел «Выпуски автонома» в SaaS-админке кладёт подписанные установщики и
манифесты в тот же публичный бакет, что раздаёт станцию
(`releases.markiro.app`), под префикс `standalone/<channel>/<version>/`, а API
пишет `standalone/<channel>/latest.json`. Модуль
`infra/yandex/modules/station-releases` для этого:

- открывает `standalone/*` на публичное чтение (`AllowPublicReleaseObjects`);
- заводит отдельный сервисный аккаунт `markiro-standalone-release-api` и его
  статический ключ. Аккаунт получает `s3:GetObject` и `s3:PutObject` только на
  `standalone/*` и `s3:ListBucket` с условием `s3:prefix = standalone/*`.
  Удалять объекты он не может (`storage.uploader` этого не даёт): отказанная
  загрузка остаётся в разделе как «незавершённая». Ключ издателя станции
  платформе не передаётся, а в `standalone/*` издатель не пишет;
- добавляет CORS бакета: `PUT` с origin `https://${saas_admin_domain}`, заголовок
  `content-type`, `MaxAgeSeconds` 3600. Без этого браузер не загрузит файл по
  presigned-ссылке.

Секрет ключа шифруется тем же PGP-ключом оператора, что и секрет издателя
(`station_release_publisher_pgp_key`), и в state лежит только зашифрованным.

## 1. План и apply

Порядок тот же, что в
[bootstrap release origin](station-release-origin-bootstrap.md), шаги 1–2:
защищённый plan в workflow `yandex-infrastructure.yml`, просмотр плана, затем
apply с подтверждением владельца. Ожидаемые изменения в `module.station_releases`:

| Ресурс                                                                   | Действие |
| ------------------------------------------------------------------------ | -------- |
| `yandex_iam_service_account.standalone_release_api`                      | create   |
| `yandex_iam_service_account_static_access_key.standalone_release_api`    | create   |
| `yandex_storage_bucket_iam_binding.publisher_uploader` (второй участник) | update   |
| `yandex_storage_bucket_policy.releases` (политика вычисляется при apply) | update   |
| `yandex_storage_bucket.releases` (`cors_rule`)                           | update   |

Любой `delete` или `replace` в этом модуле — повод остановиться. Guard
`guard-production-plan.mjs` пропускает политику, неизвестную на этапе плана,
только пока сервисный аккаунт API создаётся в этом же плане и только с точными
ссылками конфигурации.

## 2. Ключ в env платформы

Из защищённого state, как в шаге 3 bootstrap-runbook, но с outputs API:

```bash
set -euo pipefail
set +x
umask 077

work_dir="$(mktemp -d)"
chmod 700 "$work_dir"
access_key_file="$work_dir/standalone-release-access-key-id"
encrypted_secret_file="$work_dir/standalone-release-encrypted-secret.b64"
encrypted_packet_file="$work_dir/standalone-release-encrypted-secret.gpg"
secret_key_file="$work_dir/standalone-release-secret-access-key"
bucket_file="$work_dir/standalone-release-bucket"

terraform -chdir=infra/yandex/production output -raw standalone_release_api_access_key_id > "$access_key_file"
terraform -chdir=infra/yandex/production output -raw standalone_release_api_encrypted_secret_key > "$encrypted_secret_file"
terraform -chdir=infra/yandex/production output -raw station_release_bucket_name > "$bucket_file"

openssl base64 -d -A -in "$encrypted_secret_file" -out "$encrypted_packet_file"
gpg --batch --quiet --decrypt "$encrypted_packet_file" > "$secret_key_file"
chmod 600 "$access_key_file" "$secret_key_file" "$bucket_file"
rm -f -- "$encrypted_secret_file" "$encrypted_packet_file"
```

Не используйте `terraform output -json` и не печатайте файлы в терминал.

Добавьте в защищённый `runtime.env` платформы (формат `KEY=value` без кавычек,
режим 0600; инвентарь — `deploy/platform/env.example`) все пять переменных:

```text
RELEASES_S3_ENDPOINT=https://storage.yandexcloud.net
RELEASES_S3_REGION=ru-central1
RELEASES_S3_BUCKET=<содержимое $bucket_file>
RELEASES_S3_ACCESS_KEY_ID=<содержимое $access_key_file>
RELEASES_S3_SECRET_ACCESS_KEY=<содержимое $secret_key_file>
```

Значения переносите редактором или через stdin, не аргументами команд.
Задавать нужно все пять сразу или ни одной: при частичном наборе API не
стартует, и `preflight` падает. `RELEASES_PUBLIC_ORIGIN` по умолчанию —
`https://releases.markiro.app`. Затем прогоните
`node deploy/platform/preflight.mjs` на этом файле и выкатите платформу обычным
путём. После того как платформа приняла env, удалите локальные plaintext-файлы
и `$work_dir`.

## 3. Проверка

1. В «Выпусках автонома» раздел больше не пишет «не настроено».
2. Загрузка подписанного пакета проходит. Ошибка «Хранилище не приняло файл»
   означает, что CORS или права ключа не применились.
3. После «Сделать последней» в канале `stable`
   `https://releases.markiro.app/standalone/stable/latest.json` отдаётся
   анонимно, а `https://releases.markiro.app/station/...` по-прежнему работает.
4. Ключ API не пишет вне `standalone/*`: `PutObject` в `station/` с этим ключом
   должен получить `AccessDenied`.

Страница `/skachat/` читает `latest.json` из браузера с `https://markiro.app`,
то есть кросс-доменно. Это изменение открывает CORS бакета только для `PUT` из
SaaS-админки; заголовок `Access-Control-Allow-Origin` для `GET` с лендинга на
CDN `releases.markiro.app` не настроен. Пока его нет, страница считает выпуск
недоступным. Это отдельная правка CDN-ресурса и guard.

Автоматика это не проверяет: контрактные тесты и guard видят только
конфигурацию и план, а живой CORS, права ключа и раздача через CDN проверяются
вручную.
