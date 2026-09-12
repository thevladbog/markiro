# P1B.3 — варианты подключения онлайн-операций

Статус: предложение для согласования, не разрешение реализации или rollout.
Проверенная база: `b313f90f6`, merged PR #549. Три независимых варианта подготовлены
по design-an-interface и сверены с текущими владельцами операций.

## A. Прямой вызов существующего фасада — рекомендация

```ts
const facts = await admission.capture(tenantId);
return db.transaction(async (tx) => {
  // Existing authorization, locks, validation and idempotent replay belong here.
  await admission.observe({
    facts,
    tenantId,
    actor: verifiedActor,
    operationId,
    scopeDigest: admissionScopeDigest(serverOwnedScope),
    runtime: observedRuntime,
    transaction: tx,
  });
  return existingWrite(tx);
});
```

Иллюстрация точки подключения, не универсальная замена транзакций. Сохраняются
`capture`, `observe`, `withAdmission`. Resolver, проверка свежести/proof и savepoint
уже скрыты фасадом. Владелец задаёт проверенную идентичность, смысл действия,
каноническую область и действующую готовность операции. Для запроса вне транзакции
используется существующий путь фасада без передачи transaction.

Преимущество: минимальный новый интерфейс и тот же способ подключения, что у ЧЗ/НК.
Цена: полноту всех альтернативных входов нужно подтверждать inventory и тестами
реального вызова. Наличие строки `observe` не доказывает правильную ветку или DI.

## B. Реестр привязок к этапам владельца

```ts
const context = await hooks.prepare("labelTemplate.update", verifiedIdentity);
await hooks.reached(context, "labelTemplate.beforeUpdate", {
  transaction: tx,
  current,
  validatedPatch,
  runtime,
});
```

Типизированный descriptor хранит operation, предикат применения, scope и runtime.
Общий механизм выбирает привязку и вызывает прежний фасад. HTTP metadata передаёт
контекст, но не пытается угадать эффект по GET/POST. Прямые worker-вызовы также
должны достигнуть зарегистрированного этапа.

Это централизует описание покрытия, но создаёт второй словарь owner points и
собственный механизм hooks. Для текущего набора операций цена выше пользы;
декларация может разойтись с реальной записью. Не выбран.

## C. Предметные контексты наблюдения

```ts
const shadow = await inventoryAdmission.prepareCreate(verifiedIdentity);
await shadow.observeLocked({ transaction: tx, inventoryId, parameters, runtime });
```

Отдельные InventoryAdmission/ExchangeAdmission скрывают operation ID и сбор
scope. Context означает подготовленное наблюдение, не разрешение на действие.
Это затрудняет случайное смешение идентичностей и предметных данных, но добавляет
слой адаптеров и типов поверх небольшого существующего фасада. Тип сам по себе
не доказывает удержание блокировки. Можно вернуться к этому варианту при реальном
повторении больших блоков, а не вводить его заранее.

## Вывод

Рекомендуется A с типизированными проверенными actor и закрытым инвентарём
operation → owner/method → новая работа/повтор/чтение/приём доказательств.
Общая коммерческая политика остаётся только в resolver/registry. Все варианты
сохраняют shadow: дополнительный отказ P1 наблюдается, действующие отказы безопасности,
подписки и квот исполняются прежними владельцами. Ошибка shadow означает unknown.

Проверенные опорные места: `apps/api/src/subscriptions/entitlement-admission.service.ts`,
`apps/api/test/entitlement-operation-inventory.test.ts`, `packages/platform-contracts/src/entitlements.ts`,
`InventoriesService.create/importEvidence`, `InventoryLifecycleService.start`,
`ExchangeController.import/query/success`, `ShiftsService` и `LabelTemplatesService`.
