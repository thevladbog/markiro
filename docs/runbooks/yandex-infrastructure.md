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
3. Оставьте `plan_key` и `plan_sha256` пустыми, запустите `mode=plan` и approve
   только Environment `production-infrastructure`.
4. Проверьте выведенный санитаризированный список Terraform address/actions. В
   нём не должно быть замены app VM, удаления PostgreSQL, базы,
   state/media/audit/release bucket, ослабления release policy или выдачи
   release-доступа app identity.
5. Сохраните два non-secret идентификатора из notice успешного run: точный
   `plan_key` под `production/plans/` и `plan_sha256`. Не публикуйте сам plan.

Plan run никогда не применяет изменения. Он загружает binary saved plan только
в защищённый versioned Terraform state bucket. План не является GitHub artifact,
не печатается в лог или summary, и его полный JSON также не сохраняется там.

## Запуск `mode=apply`

После просмотра списка изменений остановитесь и получите явное подтверждение
владельца инфраструктуры на применение именно этого saved plan.

1. Запустите новый dispatch `mode=apply` с теми же точными `target_sha`,
   `enable_public_dns` и `enable_station_release_public_dns`.
2. Введите без изменения полученные `plan_key` и 64-символьный
   `plan_sha256`.
3. Approve отдельный Environment `production-infrastructure-apply` только после
   того, как проверка плана завершена.

Apply run повторно проверяет SHA/ref и оба boolean input, ограниченный формат и
metadata object key, загружает точную версию plan, сверяет SHA-256, повторяет
`terraform show -json` и production guard, затем применяет этот же файл. После
успешного apply workflow удаляет точный object `VersionId`; другие ключи и
префиксы state bucket не затрагиваются.

## Остаточный план после ошибки

Если apply, hash/metadata validation или guard завершился ошибкой, plan object
намеренно остаётся в escrow для расследования. Не запускайте его повторно
автоматически. Уполномоченный оператор сначала сверяет run, `target_sha`, оба
DNS input, `plan_key`, `plan_sha256` и состояние инфраструктуры. Затем он либо
запускает новый plan, либо после отдельного подтверждения удаляет только точный
key `production/plans/<run-id>/<sha>/<flags>/production.tfplan` и его точный
`version-id`/`VersionId`. Никогда не удаляйте `production/plans/` целиком и не
расширяйте доступ state-backend identity на другой bucket или prefix.

OIDC exchange и получение state-backend credentials из Lockbox остаются
job-scoped. Publisher access key и secret key не добавляются в env этих jobs.
Workflow не вызывает `terraform output`, не прикладывает Terraform outputs как
artifact и не пишет чувствительные outputs в summary или лог. Их может получить
только одобренный оператор из защищённого state по процедуре
`station-release-origin-bootstrap.md`.

Не запускайте plan/apply, cloud probe или DNS change во время проверки этого
runbook. Это отдельные внешние операции с человеческим approval.
