# Production secrets для прямого MVP deploy

Runtime application values хранятся только в
`markiro-production-runtime` Lockbox. App VM получает payload через свой
service account и материализует `/etc/markiro/production.env` атомарно с mode 0600.

GitHub environment `production-deploy` содержит только:

- secret `YC_APP_DEPLOY_SSH_PRIVATE_KEY`;
- variable `YC_APP_PUBLIC_ADDRESS`;
- variable `APP_SSH_HOST_KEYS_B64`;
- variables `MARKIRO_DOMAIN`, `MARKIRO_SAAS_ADMIN_DOMAIN`, `MARKIRO_KIOSK_DOMAIN` и
  `MARKIRO_LANDING_DOMAIN`.

GHCR password не хранится постоянно: workflow использует job-scoped
`github.token` и передаёт его в `docker login --password-stdin`. Yandex IAM
token в application deploy не используется. Не печатайте payload Lockbox,
private key, SMTP credentials, database URL или S3 keys.

## DaData

Перед deploy версии с интеграцией DaData опубликуйте новую версию секрета
`markiro-production-runtime`: сохраните все существующие записи и добавьте
`DADATA_TOKEN` и `DADATA_SECRET`. Пустые значения допустимы — в этом случае
интеграция остаётся выключенной, а юридические данные и адреса вводятся вручную.
Чтобы включить подсказки, задайте реальные значения обоих ключей из защищённого
источника. Не печатайте и не сохраняйте их в Git.

После публикации новой версии Lockbox нужен новый immutable release SHA: уже
успешно развёрнутый SHA нельзя повторно перевести через `prepare`. Создайте
обычный scoped PR (например, с актуализацией этого runbook), дождитесь успешного
`Publish production images` для merge-коммита и передайте его run ID и SHA в
`Deploy production`. Не пересобирайте и не подменяйте образы под старым SHA.

## Evidence провайдера и локализации

Lockbox хранит только runtime values и не является реестром юридических оснований. В отдельной защищённой compliance-карточке перед включением формы зафиксируйте наименование провайдера, реквизиты договора с провайдером, используемые сервисы Postbox/SmartCaptcha/object storage и подтверждение, что первичный сбор и хранение выполняются в Российской Федерации. Секреты и персональные данные заявителей в эту карточку не копируются.

## Ротация SSH

Для ротации deploy key сначала добавьте новый Ed25519 public key в
`/home/markiro-deploy/.ssh/authorized_keys` через действующий ключ и проверьте
отдельное key-only подключение. Только после этого замените
`YC_APP_DEPLOY_SSH_PRIVATE_KEY` и Terraform variable
`YC_APP_DEPLOY_SSH_PUBLIC_KEY`; старый ключ удалите после успешного deploy.

При смене host key получите новый public host key из доверенного доступа к VM,
сверьте fingerprint и затем замените `APP_SSH_HOST_KEYS_B64`. Не формируйте это
значение слепым `ssh-keyscan` через недоверенную сеть.
