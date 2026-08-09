# Production secrets для прямого MVP deploy

Runtime application values хранятся только в
`markiro-production-runtime` Lockbox. App VM получает payload через свой
service account и материализует `/etc/markiro/production.env` атомарно с mode 0600.

GitHub environment `production-deploy` содержит только:

- secret `YC_APP_DEPLOY_SSH_PRIVATE_KEY`;
- variable `YC_APP_PUBLIC_ADDRESS`;
- variable `APP_SSH_HOST_KEYS_B64`;
- variables `MARKIRO_DOMAIN` и `MARKIRO_KIOSK_DOMAIN`.

GHCR password не хранится постоянно: workflow использует job-scoped
`github.token` и передаёт его в `docker login --password-stdin`. Yandex IAM
token в application deploy не используется. Не печатайте payload Lockbox,
private key, SMTP credentials, database URL или S3 keys.
