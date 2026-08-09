# Yandex Cloud: прямой MVP

Terraform сохраняет минимальную production-схему для одного клиента:

- одна app VM, 2 vCPU / 4 GiB, с reserved public IPv4;
- Caddy и Docker Compose напрямую на 80/443;
- приватный Managed PostgreSQL, 50 GiB SSD, 14-day backups;
- приватный versioned media bucket;
- versioned remote state, runtime Lockbox и KMS;
- две A-записи: admin и kiosk на app VM.

ALB, Certificate Manager, SWS/ARL, Audit Trails, Cloud Logging/Monitoring,
self-hosted runner и deployment controller не входят в MVP.

Корни Terraform:

- `bootstrap`: state, Lockbox, три service accounts, infrastructure OIDC и KMS grants;
- `production`: network, app VM, PostgreSQL, media/audit buckets и DNS.

Audit bucket временно защищён до metadata-only инвентаризации и отдельного
решения об удалении его версий. PostgreSQL, database, media, state, runtime
secrets и KMS удалять запрещено.

Проверки:

```bash
~/terraform/terraform fmt -check -recursive infra/yandex
node infra/yandex/scripts/check-toolchain.mjs
node --test infra/yandex/test/*.test.mjs
node --test deploy/yandex/test/*.test.mjs
```

Применение выполняется вручную через protected workflow **Yandex
infrastructure**. Application deploy выполняется отдельно через **Deploy
production** по pinned SSH и exact release manifest.
