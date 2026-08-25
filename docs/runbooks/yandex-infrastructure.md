# Yandex infrastructure: plan и apply с раздельным approval

Workflow `.github/workflows/yandex-infrastructure.yml` валидирует Terraform в
pull request. Production dispatch разделён на два независимых ручных запуска:
`mode=plan` создаёт план под защитой GitHub Environment
`production-infrastructure`, а `mode=apply` применяет именно этот план только
после нового approval в отдельном Environment
`production-infrastructure-apply`.

Перед первым использованием разделённого workflow оператор должен создать и
защитить оба GitHub Environment, скопировать в них одинаковый утверждённый набор
variables из `yandex-infrastructure-secrets.md` и отдельным bootstrap apply
добавить точный OIDC subject для `production-infrastructure-apply`. Эта задача не
создаёт Environment и не выполняет bootstrap apply.

## Два независимых DNS gate

- `enable_public_dns` управляет только A records прямого app VM для admin,
  SaaS admin, kiosk и landing. Его текущее одобренное значение надо сохранять
  при изменении Station release origin.
- `enable_station_release_public_dns` управляет только CNAME
  `releases.markiro.app` на Station CDN. Значение по умолчанию — `false`.

Нельзя заменять один input другим. Первое создание release bucket, publisher,
certificate и CDN выполняется с `enable_station_release_public_dns=false`.
Включение release DNS — отдельная пара plan/apply после certificate challenge,
начального baseline и публичных read-back проверок через provider host.

## Запуск `mode=plan`

1. Убедитесь, что `target_sha` — полный 40-символьный SHA текущего `main`.
2. Зафиксируйте оба DNS input явно. Для первого release plan используйте
   `enable_station_release_public_dns=false`.
3. Оставьте `plan_key`, `plan_sha256`, `plan_version_id`, `plan_json_key`,
   `plan_json_sha256` и `plan_json_version_id` пустыми,
   `plan_review_confirmed=false`, запустите `mode=plan` и approve только
   Environment `production-infrastructure`.
4. Сохраните обе выданные тройки key/SHA-256/VersionId. Выполните полный
   operator-only retrieval и review из `yandex-infrastructure-apply.md`; один
   санитаризированный список Terraform address/actions не является review.
5. Проверьте каждый before/after/after_unknown, включая IAM, DNS, CDN и bucket
   policy. Не публикуйте binary plan или полный JSON.

Plan run никогда не применяет изменения. Он привязывает оба object key к точным
`GITHUB_RUN_ID` и `GITHUB_RUN_ATTEMPT`, затем загружает binary saved plan и полный
plan JSON только в защищённый versioned Terraform state bucket. Они не являются
GitHub artifact и не печатаются в log/summary.

## Запуск `mode=apply`

После полного локального просмотра обоих exact объектов остановитесь и получите
явное подтверждение владельца инфраструктуры на применение именно этого plan.

1. Запустите новый dispatch `mode=apply` с теми же точными `target_sha`,
   `enable_public_dns` и `enable_station_release_public_dns`.
2. Введите без изменения `plan_key`, `plan_sha256`, `plan_version_id`,
   `plan_json_key`, `plan_json_sha256`, `plan_json_version_id` и
   `plan_review_confirmed=true`.
3. Approve отдельный Environment `production-infrastructure-apply` только после
   того, как проверка плана завершена.

Apply run повторно проверяет SHA/ref и оба boolean input, ограниченный формат и
metadata object key, загружает только точную версию plan по переданному reviewer
`plan_version_id`, сверяет оба SHA-256, регенерирует JSON из binary plan,
byte/semantic-сравнивает его с exact escrow JSON, повторяет production guard и
затем применяет этот же файл. После успешного apply workflow удаляет обе точные
object versions; другие ключи и префиксы state bucket не затрагиваются.

## Остаточный план после ошибки

Если apply, hash/metadata validation или guard завершился ошибкой, оба plan object
намеренно остаются в escrow для расследования. Не запускайте их повторно
автоматически. Уполномоченный оператор сначала сверяет run, run attempt,
`target_sha`, оба DNS input, обе тройки key/hash/VersionId и состояние
инфраструктуры. Затем он либо запускает новый plan, либо после отдельного
подтверждения удаляет только оба exact keys под
`production/plans/<run-id>/<run-attempt>/<sha>/<flags>/` и точные
reviewer-сохранённые VersionId через `--version-id`.
Никогда не используйте unversioned/latest object lookup, не удаляйте
`production/plans/` целиком и не расширяйте доступ state-backend identity на
другой bucket или prefix.

OIDC exchange и получение state-backend credentials из Lockbox остаются
job-scoped. Publisher access key и secret key не добавляются в env этих jobs.
Workflow не вызывает `terraform output`, не прикладывает Terraform outputs как
artifact и не пишет чувствительные outputs в summary или лог. Их может получить
только одобренный оператор из защищённого state по процедуре
`station-release-origin-bootstrap.md`.

Не запускайте plan/apply, cloud probe или DNS change во время проверки этого
runbook. Это отдельные внешние операции с человеческим approval.
