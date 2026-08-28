# GitHub Environments для Yandex infrastructure и Station release

Этот документ — инвентарь ручной настройки. Код и Terraform не создают GitHub
Environment `station-release`, не записывают GitHub secrets и не меняют правила
защиты Environment.

## GitHub Environments для plan и apply

Environment `production-infrastructure` используется только запуском
`mode=plan`. Отдельный Environment `production-infrastructure-apply`
используется только запуском `mode=apply`, после проверки точного сохранённого
плана. Оба Environment должны разрешать deployment только из `main` и содержать
один и тот же утверждённый набор GitHub variables. Оба требуют required
reviewers `thevladbog` и `thevladbog-2` с включённым `prevent self-review`.
Дополнительно до входа в apply Environment workflow требует
`github.actor == github.repository_owner` и точный
`owner_confirmation=APPLY-YANDEX-INFRASTRUCTURE`; этот gate не заменяет approval
другого reviewer.

- `YC_CLOUD_ID`
- `YC_FOLDER_ID`
- `YC_OIDC_AUDIENCE`
- `YC_TERRAFORM_SERVICE_ACCOUNT_ID`
- `YC_STATE_BACKEND_SECRET_ID`
- `YC_STATE_BUCKET_NAME`
- `YC_ZONE`
- `YC_APP_SUBNET_CIDR`
- `YC_DATA_SUBNET_CIDR`
- `YC_APP_DEPLOY_SSH_PUBLIC_KEY`
- `YC_KMS_KEY_ID`
- `YC_APP_SERVICE_ACCOUNT_ID`
- `YC_RUNTIME_SECRET_ID`
- `YC_DATABASE_NAME`
- `YC_DATABASE_DISK_SIZE_GB`
- `YC_MEDIA_BUCKET_NAME`
- `YC_AUDIT_BUCKET_NAME`
- `YC_STATION_RELEASE_BUCKET_NAME`
- `MARKIRO_DOMAIN`
- `MARKIRO_SAAS_ADMIN_DOMAIN`
- `MARKIRO_KIOSK_DOMAIN`
- `MARKIRO_LANDING_DOMAIN`
- `MARKIRO_STATION_RELEASE_DOMAIN` со значением `releases.markiro.app`
- `YC_STATION_RELEASE_PUBLISHER_PGP_KEY` — base64-encoded PGP public key
- `YC_DNS_ZONE_ID`

PGP private key остаётся только у утверждённого оператора и никогда не попадает
в GitHub, Terraform, репозиторий, логи или artifacts. State-backend access/secret
keys остаются в Lockbox; не переносите их в GitHub variables или secrets.

До первого apply разделённого workflow отдельным одобренным bootstrap apply
создайте точный workload-identity subject для Environment
`production-infrastructure-apply`. Существующий subject
`production-infrastructure` сохраняется для plan. Не используйте wildcard
subject и не переносите state-backend credentials в GitHub. Эта настройка и
создание самих Environment выполняются оператором, а не этим runbook/test task.

## GitHub Environment `station-release`

GitHub Environment `station-release` должен разрешать deployment только из
`main`, требовать required reviewers `thevladbog` и `thevladbog-2` и запрещать
самоодобрение через `prevent self-review`. Такой же reviewer gate обязателен для
`station-beta` и `station-stable`. Проверяемый workflow gate до build/sign и до
доступа к publisher secrets остаётся дополнительным: `github.actor` обязан
совпасть с `github.repository_owner`, а `owner_confirmation` — с точным маркером
канала `PUBLISH-STATION-BETA` или `PUBLISH-STATION-STABLE`. Точный инвентарь
Environment:

- secret `STATION_RELEASE_REPOSITORY_TOKEN`: fine-grained token с Contents
  read/write только для публичного binary-only repository
  `thevladbog/markiro-station-releases`; доступ к source repository
  `thevladbog/markiro` этому token не выдаётся;
- secret `YANDEX_STATION_RELEASE_ACCESS_KEY_ID`;
- secret `YANDEX_STATION_RELEASE_SECRET_ACCESS_KEY`;
- variable `YANDEX_STATION_RELEASE_BUCKET`;
- variable `YANDEX_STATION_RELEASE_ENDPOINT` со значением
  `https://storage.yandexcloud.net`.

Не дублируйте release token или publisher credentials в repository/organization secrets,
`production-infrastructure`, `station-beta`, `station-stable`, workflow env,
Terraform variables или command arguments. Release workflow в последующих
задачах получает их только под защитой `station-release`; значения должны
передаваться publisher через ограниченные файлы/stdin, а не через job/step env
или shell arguments.

Первичную запись secret values выполняйте только через GitHub UI либо через
stdin-команды из `station-release-origin-bootstrap.md`. Не вставляйте значения в
shell history, issue, PR, chat, job summary или artifact.

## Ротация

Создайте новый отдельный publisher key через одобренный Terraform apply с новым
PGP public key, перенесите зашифрованный output по bootstrap-процедуре, проверьте
ограниченный release-prefix доступ и только затем отзовите старый key. Любое
изменение Environment secrets — самостоятельная approval-bearing операция.
