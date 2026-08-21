# Применение инфраструктуры Yandex Cloud

Для MVP используется один ручной workflow `.github/workflows/yandex-infrastructure.yml`.
Он не содержит фаз PostgreSQL, observability, ALB или DNS convergence.

1. Убедитесь, что target SHA равен текущему `main`.
2. Запустите **Yandex infrastructure** вручную с `enable_public_dns=true` только
   для прямого переключения customer admin, SaaS admin, kiosk и landing на app VM.
3. Approve `production-infrastructure`.
4. Просмотрите напечатанный список Terraform address/actions. Запрещены замена
   `module.compute.yandex_compute_instance.app` и delete PostgreSQL, базы,
   media или audit bucket.
5. Workflow применяет тот же saved plan. Не запускайте второй пересчитанный plan.

State backend credentials извлекаются из Lockbox через GitHub OIDC и существуют
только в процессе job. Не копируйте их в GitHub variables, логи или файлы repo.
