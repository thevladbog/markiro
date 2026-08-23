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
bounded rollback к предыдущему healthy release только пока выполнены границы
совместимости данных ниже.
Если bounded rollback не завершился, используйте
[`yandex-recovery.md`](./yandex-recovery.md).

Caddy слушает 80/443 на VM и выпускает ACME TLS для customer admin, SaaS admin,
kiosk и landing. SaaS admin публикуется отдельным origin, который обслуживает
только platform SPA, `/api/platform-auth/*` и `/api/platform/*`; customer и
device namespaces там закрыты. API не публикует отдельный host port. Production
env материализуется из runtime Lockbox; `SAAS_ADMIN_ORIGIN` обязан точно
совпадать с `https://$MARKIRO_SAAS_ADMIN_DOMAIN`. Секреты не передаются в
аргументах или release archive.

### Граница rollback после миграции 0065

До первого несовместимого профильного write migration `0065` остаётся additive для предыдущего
API image. Несовместимым считается любой сохранённый seller с kind, отличным от `legal_entity`, или
любой сохранённый профиль с `actualSameAsLegal=false` и отдельным фактическим адресом.

После любого такого write rollback на API image до поддержки migration 0065 запрещён: старый API
не может достоверно прочитать non-legal seller и при следующей записи заменит отдельный фактический
адрес значением actual-equals-legal. Для forward recovery нужно повторно развернуть текущий или
исправленный API image; никогда не удалять и не откатывать migration `0065`. До восстановления
совместимого API остановите новые записи billing profiles, но не изменяйте исторические revisions
вручную.

## Защищённая выкладка v-b.tech

Слияние этого изменения не разрешает live dispatch. Для каждого живого запуска требуется новое
явное одобрение с exact v-b source SHA, exact OCI digest и состоянием формы. Разрешение охватывает
только выкладку статического сайта на существующую VM и сбор bounded evidence.

### Предварительные условия и границы

- Должен уже быть активен и валидирован Markiro-релиз с v-b executor. Слияние и публикация кода
  недостаточны: для выкладки этого Markiro-релиза необходимо отдельное защищённое
  production-одобрение через обычный **Deploy production**.
- Оба защищённых workflow используют environment `production-deploy` и уже настроенные переменные,
  host keys и SSH secret из раздела «Требования». Значения credentials в evidence и runbook не
  переносятся. Если executor contract отсутствует, сначала отдельно разверните и валидируйте
  executor-bearing Markiro release; v-b workflow должен завершиться до мутаций.
- Для `disabled` function path пуст. Для `enabled` до web deployment должны быть отдельно
  активированы exact `vbtech-contact-http`, SmartCaptcha и abuse controls; executor принимает только
  reviewed path `/d4egihdqfci0mhota3ac` и не изменяет Cloud Functions или IAM.
- Операция изменяет только `vbtech-web`, пересоздание общего `edge` и приватные записи жизненного
  цикла v-b. Она не охватывает API и миграции; PostgreSQL и другие изменения базы данных; IAM и
  service accounts; Lockbox; buckets и Object Storage; VPC и сетевой control plane; DNS; выпуск и
  активацию TLS-сертификата; публичную доступность; backend и активацию contact form; внешние email
  и captcha.

Private smoke использует существующий доверенный Markiro TLS transport и проверяет private
routing/content, release identity, заголовки, HTML-маршруты, redirect, 404 и выбранный contact
contract (`disabled` или `enabled`). Его успешный результат не доказывает публичный DNS, TLS v-b.tech или публичную
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

#### Фаза 5. Запустить Deploy v-b.tech web с явным подтверждением

Вручную запустите защищённый workflow **Deploy v-b.tech web** и передайте ровно пять inputs:

- `vbtech_release_sha` — одобренный exact source SHA;
- `vbtech_image_digest` — одобренный exact OCI digest;
- `submission_state` — состояние `disabled` или `enabled`, совпадающее с attested image;
- `confirm_private_deploy` — `true`, только после сверки двух значений выше.
- `confirm_enable` — `true` только для отдельно одобренного `enabled`; для `disabled` оставьте
  `false`.

Workflow повторно валидирует input shape, attestation, фактическое состояние HTML внутри image и
ACTIVE consent `VBT-PD-02/2026.08/01`. Для `enabled` executor принимает только точный reviewed
function path `/d4egihdqfci0mhota3ac`; произвольный upstream отклоняется. До удалённой мутации он сохраняет before
snapshot — strict runtime diagnostics version 3, а после успешной выкладки — after snapshot —
strict runtime diagnostics version 3. Перед мутацией он также требует активный executor contract.
Не используйте ручные SSH-команды как замену этому workflow.

#### Фаза 6. Проверить private smoke и evidence до/после

Hosted wrapper выводит оператору только эти санитизированные маркеры:

- `MARKIRO_VBTECH_DEPLOY_HEALTHY` — bounded deploy, service health, shared-edge recreation и private
  smoke route/content завершились;
- `MARKIRO_VBTECH_EXECUTOR_BOOTSTRAP_REQUIRED` — активный Markiro release не предоставляет нужный
  executor contract; v-b mutation не разрешена;
- `MARKIRO_VBTECH_REMOTE_DEPLOY_FAILURE` — любая иная hosted deployment failure.

VM-local `MARKIRO_VBTECH_DEPLOY_FAILURE <stage> [ROLLBACK <rollback-stage>]` не выводится hosted
wrapper. Поэтому по hosted output нельзя приписывать сбою primary stage или rollback-stage: при
failure сохраняйте generic marker и failed job conclusion. Сырые команды, environment, логи
контейнеров и HTML bodies не являются evidence.

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

#### Фаза 7. Передать управление public acceptance v-b.tech

После сохранения evidence не выполняйте из этого workflow DNS, Cloud Functions, IAM, database,
email или captcha mutation. Public TLS/routes, ACTIVE legal identity и controlled contact delivery
проверяются отдельным v-b.tech acceptance-контуром. При любой ошибке enabled acceptance сначала
разверните через этот же executor точный verified disabled image, затем отдельно отключайте backend.

### Интерпретация rollback

- **До попытки активации service/edge rollback не выполняется.** Если pending record уже создана, а
  pull или digest verification завершается ошибкой, исполнитель публикует для candidate failed
  state, не меняя service или `edge`. Если не удалось создать саму pending record, candidate record
  ещё нет и rollback также не начинается.

Компенсирующий rollback выполняется только если executor разрешил rollback для подтверждённого
состояния lifecycle transition.

- **Rollback первого запуска после активации, если он разрешён.** После попытки активации candidate
  service исполнитель удаляет candidate `vbtech-web`, пересоздаёт и проверяет подтверждённую
  Markiro-only конфигурацию общего `edge`, а затем публикует candidate failed state, если state ещё
  не подтверждён как failed. Другие Markiro services и cloud resources не входят в rollback.
- **Rollback замены после активации, если он разрешён.** Исполнитель восстанавливает точный selector
  и service предыдущего healthy v-b release, проверяет его health, пересоздаёт и проверяет общий
  `edge`, затем повторяет private route verification и публикует новый candidate failed, если state
  ещё не подтверждён как failed.
- **Indeterminate terminal-state failure.** Если после активации service, `edge` и private smoke
  публикация healthy state завершилась неопределённо либо вернула невалидный результат, executor
  запрещает rollback и не публикует failed state. Hosted operator видит
  `MARKIRO_VBTECH_REMOTE_DEPLOY_FAILURE`. Нужно немедленно остановить любые мутации, через
  защищённый **Diagnose production runtime** снять fresh strict runtime diagnostics version 3 и
  запросить отдельную диагностику. Нельзя утверждать, что service восстановлен или удалён либо
  что lifecycle state стал failed; не выполнять ad-hoc repair.
- При разрешённом rollback восстановление или удаление service и проверка `edge` происходят до
  публикации failed state. Если state уже авторитетно failed, повторная failed transition не
  создаётся. Ошибка самого rollback или допустимой failed transition остаётся видна hosted operator
  только как `MARKIRO_VBTECH_REMOTE_DEPLOY_FAILURE`, без primary stage и rollback-stage. Такой
  результат не разрешает изменения API, database, DNS, TLS или cloud; для дальнейшего действия
  нужен отдельный диагноз и одобрение.
