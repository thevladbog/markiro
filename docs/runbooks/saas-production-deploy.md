# Production deploy через Docker Compose

MVP разворачивается одним GitHub-hosted job напрямую на app VM. ALB, self-hosted
runner, deployment controller и rehearsal workflow не участвуют.

## Требования

- успешный **Publish production images** на текущем `main`;
- environment `production-deploy`;
- variable `YC_APP_PUBLIC_ADDRESS`;
- variable `APP_SSH_HOST_KEYS_B64` с проверенными host keys app VM;
- variables `MARKIRO_DOMAIN`, `MARKIRO_KIOSK_DOMAIN` и `MARKIRO_LANDING_DOMAIN`;
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

Caddy слушает 80/443 на VM и выпускает ACME TLS для admin, kiosk и landing. API не
публикует отдельный host port. Production env материализуется из runtime
Lockbox; секреты не передаются в аргументах или release archive.

## Приватная выкладка v-b.tech

Слияние этого изменения не разрешает live dispatch. Для каждого живого запуска требуется новое
явное одобрение с exact v-b source SHA и exact OCI digest. Разрешение охватывает только приватную
выкладку статического сайта на существующую VM с выключенной отправкой и сбор read-only evidence.

### Предварительные условия и границы

- Должен уже быть активен и валидирован Markiro-релиз с v-b executor. Слияние и публикация кода
  недостаточны: для выкладки этого Markiro-релиза необходимо отдельное защищённое
  production-одобрение через обычный **Deploy production**.
- Оба защищённых workflow используют environment `production-deploy` и уже настроенные переменные,
  host keys и SSH secret из раздела «Требования». Значения credentials в evidence и runbook не
  переносятся. Если executor contract отсутствует, сначала отдельно разверните и валидируйте
  executor-bearing Markiro release; v-b workflow должен завершиться до мутаций.
- В этой фазе неизменны `VBTECH_SUBMISSION_STATE=disabled`; function origin не требуется, backend
  формы не создаётся и контактная отправка не включается.
- Операция изменяет только `vbtech-web`, пересоздание общего `edge` и приватные записи жизненного
  цикла v-b. Она не охватывает API и миграции; PostgreSQL и другие изменения базы данных; IAM и
  service accounts; Lockbox; buckets и Object Storage; VPC и сетевой control plane; DNS; выпуск и
  активацию TLS-сертификата; публичную доступность; backend и активацию contact form; внешние email
  и captcha.

Private smoke использует существующий доверенный Markiro TLS transport и проверяет private
routing/content, release identity, заголовки, HTML-маршруты, redirect, 404 и disabled contact
contract. Его успешный результат не доказывает публичный DNS, TLS v-b.tech или публичную
доступность.

### Последовательность оператора

#### Фаза 1. Смержить и опубликовать код Markiro executor

Смержите проверенный executor code и дождитесь его публикации как части обычного immutable Markiro
release. Это только bootstrap artifact, а не разрешение на production deployment.

#### Фаза 2. Отдельно одобрить и развернуть Markiro-релиз с executor

Получите отдельное production-одобрение для точного Markiro release и выполните защищённый
**Deploy production**. После его успешной smoke-проверки убедитесь, что этот executor-bearing
Markiro release остаётся active и validated. Только после этого доступен bootstrap contract для
независимого v-b deployment.

#### Фаза 3. Снять и прочитать read-only baseline version 3

Запустите защищённый **Diagnose production runtime** и сохраните его санитизированную строку
`MARKIRO_RUNTIME_DIAGNOSTICS`. Принимать можно только строгий snapshot version 3. Проверьте active
Markiro identity, текущую active v-b identity или `null`, единственную project-labelled Compose
network, allowlisted состояния `api`, `edge`, `vbtech-web` и resource counters. Этот шаг read-only и
не разрешает исправлять состояние вручную.

#### Фаза 4. Отдельно одобрить exact v-b source SHA и exact OCI digest

Одобрение должно буквально назвать один lowercase 40-character exact source SHA из `main` и один
lowercase `sha256:` exact OCI digest образа `ghcr.io/thevladbog/vbtech-web`. Сверьте их с
опубликованным attested artifact. Не подменяйте digest тегом.

#### Фаза 5. Запустить Deploy v-b.tech private web с явным подтверждением

Вручную запустите защищённый workflow **Deploy v-b.tech private web** и передайте ровно три inputs:

- `vbtech_release_sha` — одобренный exact source SHA;
- `vbtech_image_digest` — одобренный exact OCI digest;
- `confirm_private_deploy` — `true`, только после сверки двух значений выше.

Workflow повторно валидирует input shape и attestation, затем до и после: runtime diagnostics
version 3. Перед удалённой мутацией он также требует активный executor contract. Не используйте
ручные SSH-команды как замену этому workflow.

#### Фаза 6. Проверить private smoke и evidence до/после

Успешная строка `MARKIRO_VBTECH_DEPLOY_HEALTHY` означает, что bounded deploy, service health,
shared-edge recreation и private smoke route/content завершились. Ошибка публикуется только как
санитизированная строка
`MARKIRO_VBTECH_DEPLOY_FAILURE <stage> [ROLLBACK <rollback-stage>]`; сырые команды, environment,
логи контейнеров и HTML bodies не являются evidence.

Оба встроенных snapshot должны быть строгими runtime diagnostics version 3. В
`MARKIRO_VBTECH_CAPACITY_DELTA` прочитайте:

- `beforeRelease` и `afterRelease`: Markiro release SHA, v-b release SHA и v-b image digest до и
  после;
- `cpuBusyBasisPointsDelta`;
- `memoryAvailableBytesDelta`;
- `rootFilesystemAvailableBytesDelta`.

Отдельно зафиксируйте `MARKIRO_VBTECH_DEPLOY_HEALTHY` как успешный статус private smoke
route/content и сверьте after identity с одобренными SHA и digest.

Это сравнение — только фактический before/after snapshot одной операции. Оно не задаёт capacity
threshold, не рекомендует resize и не доказывает длительную нагрузочную устойчивость. Private smoke
не заменяет public DNS, v-b TLS или public reachability acceptance.

#### Фаза 7. Остановиться до DNS, сертификата v-b.tech, backend и contact activation

После сохранения evidence остановитесь. Не создавайте DNS records, не запускайте выпуск или
активацию сертификата v-b.tech, не публикуйте сайт наружу, не подключайте backend/contact form,
email или captcha. Каждая такая операция находится за отдельным reviewed approval boundary.

### Интерпретация rollback

- **Rollback первого запуска.** Исполнитель удаляет только failed candidate `vbtech-web`, помечает
  его приватную lifecycle record как failed и пересоздаёт подтверждённую Markiro-only конфигурацию
  общего `edge`. Другие Markiro services и cloud resources не входят в rollback.
- **Rollback замены.** Исполнитель восстанавливает точный selector и service предыдущего healthy
  v-b release, проверяет его health, пересоздаёт и проверяет общий `edge`, затем повторяет private
  route verification и помечает новый candidate failed.
- Если rollback сам не завершился, оператор получает только primary stage и стабильный
  rollback-stage. Такой результат не разрешает изменения API, database, DNS, TLS или cloud; для
  дальнейшего действия нужен отдельный диагноз и одобрение.
