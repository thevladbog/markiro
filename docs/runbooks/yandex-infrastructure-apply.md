# Применение инфраструктуры Yandex Cloud

Для MVP используется ручной workflow `.github/workflows/yandex-infrastructure.yml`.
Он разделяет планирование и применение на два независимых защищённых запуска.

1. Убедитесь, что target SHA равен текущему `main`.
2. Запустите **Yandex infrastructure** в `mode=plan` с пустыми `plan_key`,
   `plan_sha256`, `plan_version_id`, `plan_json_key`, `plan_json_sha256` и
   `plan_json_version_id`; `plan_review_confirmed=false`. Явно задайте оба DNS
   flag.
3. Approve `production-infrastructure`. Run сохраняет в versioned state bucket
   точные версии binary plan и полного plan JSON и выдаёт key, SHA-256 и
   VersionId каждого объекта.
4. Уполномоченный оператор скачивает именно эти версии локально и проводит
   полный review по процедуре ниже. Санитаризированного address/actions в логе
   недостаточно.
5. После явного подтверждения запустите `mode=apply` с теми же target SHA и DNS
   flags, обеими точными тройками и `plan_review_confirmed=true`.
6. Approve отдельный Environment `production-infrastructure-apply`. Apply run
   проверяет оба объекта, регенерирует JSON из binary plan, сравнивает его
   byte-for-byte и семантически с escrow JSON, повторяет fail-closed guard и
   только затем применяет saved plan.

## Полный локальный review точных защищённых версий

Команды выполняет только уполномоченный оператор на доверенной машине с доступом
к state bucket. Не вставляйте полный plan/JSON в GitHub log, artifact, comment,
summary или чат. Подставьте шесть значений из одного plan run:

```bash
umask 077
review_dir="$(mktemp -d)"
export YC_STATE_BUCKET_NAME=<exact-state-bucket>
export TARGET_SHA=<exact-plan-target-sha>
export PLAN_KEY=<exact-production.tfplan-key>
export PLAN_VERSION_ID=<exact-binary-version-id>
export PLAN_SHA256=<exact-binary-sha256>
export PLAN_JSON_KEY=<exact-production-plan.json-key>
export PLAN_JSON_VERSION_ID=<exact-json-version-id>
export PLAN_JSON_SHA256=<exact-json-sha256>

test "$(git rev-parse HEAD)" = "$TARGET_SHA"

aws s3api get-object --endpoint-url https://storage.yandexcloud.net \
  --bucket "$YC_STATE_BUCKET_NAME" --key "$PLAN_KEY" \
  --version-id "$PLAN_VERSION_ID" "$review_dir/production.tfplan" >/dev/null
aws s3api get-object --endpoint-url https://storage.yandexcloud.net \
  --bucket "$YC_STATE_BUCKET_NAME" --key "$PLAN_JSON_KEY" \
  --version-id "$PLAN_JSON_VERSION_ID" "$review_dir/production-plan.json" >/dev/null
printf '%s  %s\n' "$PLAN_SHA256" "$review_dir/production.tfplan" | sha256sum --check
printf '%s  %s\n' "$PLAN_JSON_SHA256" "$review_dir/production-plan.json" | sha256sum --check

terraform -chdir=infra/yandex/production init -backend=false -lockfile=readonly
terraform -chdir=infra/yandex/production show -json \
  "$review_dir/production.tfplan" > "$review_dir/regenerated-plan.json"
cmp "$review_dir/production-plan.json" "$review_dir/regenerated-plan.json"
jq --slurp -e '.[0] == .[1]' \
  "$review_dir/production-plan.json" "$review_dir/regenerated-plan.json" >/dev/null
jq '.resource_changes[] | {
  address,
  type,
  actions: .change.actions,
  before: .change.before,
  after: .change.after,
  after_unknown: .change.after_unknown
}' "$review_dir/production-plan.json" | less
jq '.configuration.root_module.module_calls.station_releases.module.resources[] |
  select(.address == "yandex_storage_bucket_policy.releases" or
         .address == "yandex_iam_service_account_static_access_key.publisher" or
         .address == "yandex_storage_bucket_iam_binding.publisher_uploader" or
         .address == "yandex_cdn_resource.releases" or
         .address == "yandex_dns_recordset.public_release") |
  {address, expressions}
' "$review_dir/production-plan.json" | less
```

Review должен охватить каждый resource change и все security-relevant значения,
особенно principals/actions/roles, DNS type/name/data, CDN origin group и origin,
bucket ACL/policy/versioning. Provider-computed ID допустим только когда guard и
локальный review подтверждают ровно ожидаемую configuration reference для этой
IAM/topology-связи; literal unknown, отсутствующая, лишняя или альтернативная
reference и любое неклассифицированное значение требуют нового plan. Только
после успешных hash/byte/semantic checks и содержательного review можно выставить
`plan_review_confirmed=true`.

После apply typed AWS SDK helper удаляет и проверяет отсутствие обеих точных
object versions. Только явный 404/NoSuchKey/NoSuchVersion считается отсутствием;
auth, throttle, server, timeout, transport и unknown error завершают cleanup
ошибкой.

Если apply или validation завершились ошибкой, оба объекта намеренно остаются в
escrow для расследования. Никогда не используйте unversioned/latest lookup, не
удаляйте `production/plans/` целиком и не расширяйте state-backend access.

State backend credentials извлекаются из Lockbox через GitHub OIDC и существуют
только в процессе job. Не копируйте их в GitHub variables, логи или файлы repo.
