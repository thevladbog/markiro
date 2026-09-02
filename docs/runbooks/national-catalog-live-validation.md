# National Catalog live read validation

Run this gate only against a tenant that the deployment owner has authorized for
National Catalog read validation. It makes only these GET requests:

- `/v3/categories` and an immediate conditional repeat;
- `/v3/attributes` для одной детерминированно выбранной категории;
- `/v3/feed-product` for a known, tenant-authorized GTIN;
- `/v3/product` for the same GTIN and an immediate conditional repeat.

Для одиночной карточки используется документированный параметр `gtin`; `gtins`
используется только для пакетного чтения. Отсутствие ETag или usage headers отмечается
как деградация контракта, но неизменный content hash остаётся безопасным fallback.

## Required evidence before enabling the integration

Record outside source control:

- tenant identity selected as `NATIONAL_CATALOG_SCHEMA_SOURCE_TENANT_ID`;
- the owner's confirmation that the tenant's current GIS MT token may perform
  these reads, including the role/right evidence for categories, attributes,
  own-card, and published-card access;
- a known GTIN that is safe to use as `NATIONAL_CATALOG_LIVE_GTIN`;
- method outcome, result count, and whether an ETag was present.

Do not record or print the bearer, encrypted token material, API key, response
headers, or raw product-card payload. `NATIONAL_CATALOG_LIVE_GTIN` is test data,
not a credential.

## Protected production run

Deploy the revision containing the diagnostic CLI, then start the protected
`Diagnose production runtime` GitHub Actions workflow with `national_catalog`
enabled. The workflow reuses the dedicated `markiro-deploy` SSH identity and
pinned host keys. It resolves exactly one running `api` container and executes
only `dist/national-catalog-live-diagnostic.js` inside it.

The production diagnostic selects the configured
`NATIONAL_CATALOG_SCHEMA_SOURCE_TENANT_ID`, queries only that tenant's active
encrypted ChZ token, and uses the configured known
`NATIONAL_CATALOG_LIVE_GTIN`. Other tenants and tokens may exist and do not
make the configured source ambiguous. The bearer is decrypted only inside the
API container, and the diagnostic uses the official production National Catalog
endpoint.

The workflow output is limited to a closed source-status enum, method outcome,
result count, ETag presence, and the aggregate pass/fail flag. Tenant, GTIN,
bearer, provider error message, headers, and payloads are never emitted. An
unexpected internal or transport failure produces only
`MARKIRO_NATIONAL_CATALOG_DIAGNOSTICS_FAILURE {"stage":"<stage>"}`. The stage
is restricted to `configuration`, `credential-validation`, `workspace-setup`,
`api-container-discovery-transport`, `api-container-discovery`,
`api-cli-transport`, `api-cli-exit`,
`api-cli-evidence-missing`, `api-cli-evidence-invalid`,
`api-cli-exit-mismatch`, `cleanup`, or `unknown`; arbitrary exception text is
never serialized.

## Explicit local or sandbox run

Use the deployment's existing secret store and local environment loader. Do not
place a bearer in a shell command, source file, test fixture, or terminal log.
The active token must already be encrypted in Markiro's `chz_api_tokens` store
for the configured source tenant; the test retrieves it only through
`ChzTokenService`.

Set these non-secret validation settings in the runtime environment:

```text
NATIONAL_CATALOG_BASE_URL=https://authorized-catalog-environment.example
NATIONAL_CATALOG_SCHEMA_SOURCE_TENANT_ID=authorized-tenant-id
NATIONAL_CATALOG_LIVE_GTIN=known-gtin
```

`NATIONAL_CATALOG_BASE_URL` must be the authorized environment selected by the
deployment owner. This configurable local/integration path deliberately has no
default production endpoint; the protected production diagnostic described
above is a separate path with the official endpoint pinned in code. Keep
`NATIONAL_CATALOG_REQUEST_TIMEOUT_MS` at its 15000 ms default unless an operator
has a documented reason to adjust it.

Run:

```bash
corepack pnpm --filter @markiro/api exec vitest run test/national-catalog.live.test.ts
```

The test skips when any of the three `NATIONAL_CATALOG_*` validation settings
above is absent. A skip, `forbidden`, or unsupported method result is a stop
gate: keep the integration disabled and obtain the tenant/right evidence before
starting persistence or feature work.

## Включение read-only импорта после merge

1. Зафиксируйте вне Git подтверждение владельца source tenant и права токена на
   categories, category-scoped attributes, feed-product и product.
2. Опубликуйте новую версию Lockbox по инструкции `yandex-secrets.md`, сохранив все
   существующие записи и предыдущую версию. Добавьте подтверждённый известный GTIN
   в `NATIONAL_CATALOG_LIVE_GTIN`; отдельный токен Национального каталога не добавляйте.
3. Разверните merge SHA только защищённым `Deploy production` и повторите этот
   диагностический gate. Сырые ответы и идентификаторы в evidence не копируйте.
4. Платформенный администратор с `catalog.write` вызывает
   `POST /platform/operations/national-catalog/schema-refresh`. Частичные ошибки и
   заблокированные типы не активируются автоматически.
5. Для каждой группы ЧЗ явно зафиксируйте решение через
   `POST /platform/operations/national-catalog/group-mappings/:code/review`: `exact`
   принимает ровно одну версию схемы, `ambiguous` — не менее двух кандидатов,
   `unmapped` — пустой список. JSON-отчёт следующего шага содержит подходящие
   `categoryIds` и `schemaVersionIds`. Этот шаг не активирует схему автоматически.
6. В защищённой операторской среде выполните
   `pnpm --filter @markiro/api report:national-catalog-matrix`. Exit code `2` означает,
   что остались ambiguous/unmapped группы: завершите review и повторите отчёт.
7. Если значения НК должны обновлять `name`, `print_name` или `shelf_life_days`,
   явно сохраните не более одного проверенного source mapping для каждого поля через
   `POST /platform/operations/national-catalog/schema-versions/:id/attribute-mappings/review`.
   Пустой список отключает такие переносы для версии. ЕГАИС-коды этим маршрутом не
   сопоставляются и автоматически из НК не импортируются.
8. Активируйте только просмотренную версию через
   `POST /platform/operations/national-catalog/schema-versions/:id/activate`.
9. Для tenant smoke вызовите `POST /products/:id/national-catalog/lookups`, выберите
   один snapshot при нескольких карточках, затем создайте preview через
   `POST /products/:id/national-catalog/import-previews`. Применение выполняется только
   существующим `regulatory-proposals/:proposalId/apply` с явным списком entry IDs.

Для аварийного выключения опубликуйте следующую версию Lockbox с пустыми
`NATIONAL_CATALOG_BASE_URL`, `NATIONAL_CATALOG_SCHEMA_SOURCE_TENANT_ID` и
`NATIONAL_CATALOG_LIVE_GTIN`, сохранив остальной payload, и снова используйте
защищённый deploy. Уже сохранённые snapshots, proposals и применённые значения не
удаляются и не переписываются.
