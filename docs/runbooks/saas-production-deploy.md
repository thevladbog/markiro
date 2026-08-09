# Production deploy через Docker Compose

MVP разворачивается одним GitHub-hosted job напрямую на app VM. ALB, self-hosted
runner, deployment controller и rehearsal workflow не участвуют.

## Требования

- успешный **Publish production images** на текущем `main`;
- environment `production-deploy`;
- variable `YC_APP_PUBLIC_ADDRESS`;
- variable `APP_SSH_HOST_KEYS_B64` с проверенными host keys app VM;
- variables `MARKIRO_DOMAIN` и `MARKIRO_KIOSK_DOMAIN`;
- secret `YC_APP_DEPLOY_SSH_PRIVATE_KEY` для пользователя `markiro-deploy`.

## Запуск

Вручную запустите **Deploy production** с exact release run ID и 40-символьным
SHA. Workflow проверяет успешный release run и manifest, затем вызывает
`deploy/yandex/remote-deploy.mjs`.

Удалённая последовательность неизменна: transfer, prepare, migrations, start,
readiness, public smoke, finalize. При ошибке после prepare выполняется один
bounded rollback к предыдущему healthy release. Миграции должны оставаться
backward-compatible с предыдущим образом.

Caddy слушает 80/443 на VM и выпускает ACME TLS для admin и kiosk. API не
публикует отдельный host port. Production env материализуется из runtime
Lockbox; секреты не передаются в аргументах или release archive.
