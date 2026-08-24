# Применение инфраструктуры Yandex Cloud

Для MVP используется ручной workflow `.github/workflows/yandex-infrastructure.yml`.
Он не содержит фаз PostgreSQL, observability, ALB или DNS convergence и разделяет
планирование и применение на два независимых запуска.

1. Убедитесь, что target SHA равен текущему `main`.
2. Запустите **Yandex infrastructure** в `mode=plan` с пустыми `plan_key`,
   `plan_sha256` и `plan_version_id`. Используйте `enable_public_dns=true` только
   для прямого переключения customer admin, SaaS admin, kiosk и landing на app
   VM; независимо задайте текущее одобренное значение
   `enable_station_release_public_dns`.
3. Approve `production-infrastructure`. Этот run только сохраняет plan в
   защищённом state bucket и выдаёт non-secret `plan_key`, `plan_sha256` и
   точный `plan_version_id`.
4. Просмотрите напечатанный список Terraform address/actions. Запрещены замена
   `module.compute.yandex_compute_instance.app` и delete PostgreSQL, базы,
   media или audit bucket.
5. После явного подтверждения запустите новый dispatch `mode=apply` с теми же
   target SHA и обоими DNS flags, точными `plan_key`, `plan_version_id` и 64-hex
   `plan_sha256`.
6. Approve отдельный Environment `production-infrastructure-apply`. Apply run
   повторно проверяет target/input binding и hash, затем применяет ровно тот же
   saved plan. Не запускайте второй пересчитанный plan.

State backend credentials извлекаются из Lockbox через GitHub OIDC и существуют
только в процессе job. Не копируйте их в GitHub variables, логи или файлы repo.
