# Yandex infrastructure: защищённый apply

Workflow `.github/workflows/yandex-infrastructure.yml` валидирует Terraform в
pull request и применяет один сохранённый plan только после ручного запуска на
точном SHA текущего `main` и approval GitHub Environment
`production-infrastructure`.

## Два независимых DNS gate

- `enable_public_dns` управляет только A records прямого app VM для admin,
  SaaS admin, kiosk и landing. Его текущее одобренное значение надо сохранять
  при изменении Station release origin.
- `enable_station_release_public_dns` управляет только CNAME
  `releases.markiro.app` на Station CDN. Значение по умолчанию — `false`.

Нельзя заменять один input другим. Первое создание release bucket, publisher,
certificate и CDN выполняется с `enable_station_release_public_dns=false`.
Включение release DNS — отдельный apply после certificate challenge, начального
baseline и публичных read-back проверок через provider host.

## Ручной apply

1. Убедитесь, что `target_sha` — полный 40-символьный SHA текущего `main`.
2. Зафиксируйте оба DNS input явно. Для первого release apply используйте
   `enable_station_release_public_dns=false`.
3. Остановитесь до запуска и получите одобрение владельца инфраструктуры на
   изменение. После запуска отдельно approve Environment
   `production-infrastructure`.
4. Проверьте напечатанный список Terraform address/actions. В нём не должно быть
   замены app VM, удаления PostgreSQL, базы, state/media/audit/release bucket,
   ослабления release policy или выдачи release-доступа app identity.
5. Workflow применяет ровно тот saved plan, который прошёл guard. Не запускайте
   пересчитанный plan вместо него.

OIDC exchange и получение state-backend credentials из Lockbox остаются
job-scoped. Publisher access key и secret key не добавляются в env этого job.
Workflow не вызывает `terraform output`, не прикладывает Terraform outputs как
artifact и не пишет чувствительные outputs в summary или лог. Их может получить
только одобренный оператор из защищённого state по процедуре
`station-release-origin-bootstrap.md`.

Не запускайте apply, cloud probe или DNS change во время проверки этого runbook.
Это отдельные внешние операции с человеческим approval.
