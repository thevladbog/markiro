# Bootstrap Yandex Cloud для MVP

Bootstrap уже выполнен. Повторять его для обычного deploy не нужно.

Сохраняются только:

- versioned Terraform state bucket с `prevent_destroy`;
- Lockbox `markiro-production-runtime`;
- Lockbox `markiro-production-state-backend`;
- service accounts `terraform`, `state` и `app`;
- GitHub OIDC credential только для `production-infrastructure`;
- KMS grants, необходимые Terraform и app.

Registry secret, runner registration secret, audit identity/log group и
deployment controller удаляются упрощающим bootstrap plan. HMAC state backend
не создаётся Terraform и не должен попадать в shell history или GitHub logs.
Любое изменение bootstrap сначала проверяется отдельным saved plan; state bucket,
runtime secret, state-backend secret и KMS key удалять запрещено.
