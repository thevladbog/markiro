# Production deploy через Docker Compose

MVP разворачивается одним GitHub-hosted job напрямую на app VM. ALB, self-hosted
runner, deployment controller и rehearsal workflow не участвуют.

## Требования

- успешный **Publish production images** на текущем `main`;
- environment `production-deploy`;
- variable `YC_APP_PUBLIC_ADDRESS`;
- variable `APP_SSH_HOST_KEYS_B64` с проверенными host keys app VM;
- variables `MARKIRO_DOMAIN`, `MARKIRO_SAAS_ADMIN_DOMAIN`, `MARKIRO_KIOSK_DOMAIN` и
  `MARKIRO_LANDING_DOMAIN`;
- secret `YC_APP_DEPLOY_SSH_PRIVATE_KEY` для пользователя `markiro-deploy`.

## Запуск

Вручную запустите **Deploy production** с exact release run ID и 40-символьным
SHA. Workflow проверяет успешный release run и manifest, затем вызывает
`deploy/yandex/remote-deploy.mjs`.

Удалённая последовательность неизменна: transfer, prepare, migrations, start,
readiness, public smoke, finalize. При ошибке после prepare выполняется один
bounded rollback к предыдущему healthy release. Миграции должны оставаться
backward-compatible с предыдущим образом.
Если bounded rollback не завершился, используйте
[`yandex-recovery.md`](./yandex-recovery.md).

Caddy слушает 80/443 на VM и выпускает ACME TLS для customer admin, SaaS admin,
kiosk и landing. SaaS admin публикуется отдельным origin, который обслуживает
только platform SPA, `/api/platform-auth/*` и `/api/platform/*`; customer и
device namespaces там закрыты. API не публикует отдельный host port. Production
env материализуется из runtime Lockbox; `SAAS_ADMIN_ORIGIN` обязан точно
совпадать с `https://$MARKIRO_SAAS_ADMIN_DOMAIN`. Секреты не передаются в
аргументах или release archive.
