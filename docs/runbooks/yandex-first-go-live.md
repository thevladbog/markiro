# Первый запуск Markiro в Yandex Cloud

Эта инструкция относится к MVP с одним клиентом. Рабочая схема: одна публичная
VM с Caddy и Docker Compose, приватный Managed PostgreSQL и приватный media S3.
Домены: `admin.markiro.app`, `saas-admin.markiro.app`, `kiosk.markiro.app` и
`markiro.app`.

## 1. Проверить выпуск образов

Смержите текущую ветку в `main` и дождитесь успешного workflow
**Publish production images**. Запишите его run ID и точный 40-символьный SHA.
Используются только digest-pinned образы из release manifest; тег `latest`
запрещён.

## 2. Проверить резервную копию

Перед изменением инфраструктуры убедитесь, что последняя автоматическая копия
Managed PostgreSQL успешно завершена и младше 24 часов. PostgreSQL, база, media
bucket, state bucket и KMS не должны удаляться или заменяться.

## 3. Применить упрощение инфраструктуры

Сначала запустите вручную **Yandex infrastructure** на текущем `main` в режиме
планирования:

```text
mode=plan
target_sha=<current-main-40-character-sha>
enable_public_dns=true
enable_station_release_public_dns=false
plan_key=
plan_sha256=
```

Approve Environment `production-infrastructure`. Workflow строит один saved
Terraform plan, проверяет запрет замены app VM и удаления PostgreSQL, базы, media
и временно сохранённого audit bucket, но ничего не применяет. Просмотрите
санитаризированный список изменений и сохраните выданные non-secret `plan_key` и
`plan_sha256`.

Ожидаемые удаления: ALB, backend/target groups, ALB subnet/address/security
group, Certificate Manager certificates, SWS/ARL, Audit Trails, облачные log
groups и deployment-controller/runner ресурсы. Ожидаемые сохранения: app VM и
её reserved IP, PostgreSQL, media, state, KMS, DNS zone и runtime secrets.

После явного подтверждения владельца инфраструктуры запустите новый dispatch с
теми же SHA и DNS flags:

```text
mode=apply
target_sha=<current-main-40-character-sha>
enable_public_dns=true
enable_station_release_public_dns=false
plan_key=<exact-key-from-reviewed-plan-run>
plan_sha256=<exact-64-hex-from-reviewed-plan-run>
```

Approve отдельный Environment `production-infrastructure-apply` только после
review. Workflow повторно проверит binding и SHA-256, применит точный escrowed
plan и удалит его точную версию после успеха.

## 4. Проверить прямой DNS

Все A-записи должны указывать на reserved public IP app VM:

```bash
dig +short A admin.markiro.app
dig +short A saas-admin.markiro.app
dig +short A kiosk.markiro.app
dig +short A markiro.app
```

На этом шаге проверяется только DNS. Caddy начнёт выпуск ACME-сертификатов после
запуска приложения на следующем шаге.

## 5. Запустить приложение

Approve environment `production-deploy` и вручную запустите **Deploy
production**:

```text
release_run_id=<successful-publish-run-id>
release_sha=<same-40-character-main-sha>
landing_demo_submission_state=<enabled-or-disabled>
```

Единственный GitHub-hosted job проверяет release manifest, подключается к app VM
по dedicated key-only SSH с pinned host keys, передаёт immutable Compose bundle,
выполняет migration, readiness и public smoke, затем фиксирует healthy release.
GitHub job использует только job-scoped token для GHCR и всегда удаляет временный
SSH key.

## 6. Проверить TLS и приложение

После запуска Caddy сам выпускает ACME-сертификаты. Проверьте HTTPS для всех
доменов; сертификаты Certificate Manager больше не используются.

Проверьте:

- `https://admin.markiro.app/health/ready` возвращает готовность API;
- `https://admin.markiro.app/docs` открывает документацию;
- `https://saas-admin.markiro.app/` отдаёт отдельную platform SPA и не отдаёт
  customer/device namespaces;
- `https://kiosk.markiro.app/` отдаёт kiosk PWA;
- kiosk не отдаёт SPA для зарезервированных `/api`, `/station` и `/kiosk`;
- отправку тестового письма через Cloud Postbox;
- запись и чтение тестового объекта в media bucket.

## 7. Удалить остаточные данные аудита

Audit Trails уже останавливаются инфраструктурным plan. До удаления audit bucket
снимите metadata-only инвентаризацию текущих объектов и версий. После проверки,
что эти данные не нужны для расследования или договора, удалите версии и bucket
отдельной явной операцией. Не затрагивайте media или state bucket.
