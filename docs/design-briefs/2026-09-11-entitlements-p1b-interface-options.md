# P1B: варианты интерфейса лицензирования устройств

Статус: проект для обсуждения, реализация не начата.
База исследования: `9da7a5223f9a8807988477c7113c669d615499f2`, merge PR #515.
Требования: [ФТ v1.2](../superpowers/specs/2026-09-10-catalog-entitlements-functional-requirements.md),
FR-DEV-01–05 и FR-LIF-01–08.

Три независимых исследования выполнены по `design-an-interface`. Ниже сохранены
различия интерфейсов и проверенные ограничения, а не три варианта одного фасада.
Общий resolver и admission P1A остаются принятым основанием.

## Задача и текущие владельцы

`StationDevicesService` создаёт reservation и управляет записью устройства.
`StationPairingService` владеет кодами, claim и заменой credential.
`EntitlementsService` считает общий `stations/maxStations` для Station и ТСД.
`SubscriptionLifecycleService` владеет коммерческой временной шкалой.
Кабинет и SaaS вызывают эти сценарии через разные границы авторизации.

Нужны отмена неиспользованного резерва, повторное подключение прежнего устройства,
явная замена другим устройством и выбор сохраняемых устройств при снижении лимита.
Offline не освобождает reservation; киоски остаются отдельными.
Коммерческая деактивация не должна отзывать security credential или удалять данные.

## A. Три метода и типизированные команды

```ts
interface WorkingDeviceLicensing {
  inspect(context: AuthorizedContext): Promise<PoolView>;
  preview(context: AuthorizedContext, change: Replacement | RetainedSelection): Promise<Preview>;
  apply(tx: OwnerTransaction, context: AuthorizedContext, command: DeviceCommand): Promise<Receipt>;
}

type DeviceCommand = Reserve | CancelReservation | VerifiedCredentialTransition | ConfirmPreview;
```

Пример: `preview(context, { type: "retain", changeId, deviceIds })`, затем
`apply(tx, context, { type: "confirm", previewId, requestId })`.
Обычный create вызывает `apply` с командой резервирования.

Внутри скрыты расчёт вместимости, tenant-проверки, свежесть preview, повтор запроса,
revision и аудит. Pairing остаётся владельцем секретов; его внутренняя команда
перехода недоступна в HTTP DTO кабинета.

Методов мало, но различия авторизации и lifecycle переезжают в union команд.
Особенно легко ошибочно сделать один универсальный endpoint, доступный нескольким
trust domains. Короткая сигнатура не делает такую реализацию автоматически безопасной.

## B. Декларация желаемого распределения

```ts
interface DeviceAllocationService {
  inspect(context: AuthorizedContext): Promise<AllocationView>;
  preview(context: AuthorizedContext, desired: DesiredAllocation): Promise<AllocationPreview>;
  reconcile(tx: OwnerTransaction, confirmation: PreviewConfirmation): Promise<Receipt>;
}

interface DesiredAllocation {
  boundary: CurrentBoundary | ConfirmedCommercialTransition;
  reservations: readonly ExplicitHeldOrReleasedReservation[];
  retained: { state: "unresolved" } | { state: "selected"; deviceIds: readonly string[] };
  requestId: string;
}
```

Пример: клиент описывает сохранённые reservations, явное освобождение старой,
новую reservation со ссылкой на предшественника и выбранный будущий retained set.
`preview` показывает разницу; владелец коммерческого изменения подтверждает её
через `reconcile` вместе со своей операцией.

Внутри скрыты нормализация полного документа, расчёт разницы, проверка переходов,
временной границы и совместимости клиентов. Отсутствующее устройство не означает
удаление: неполная декларация отклоняется. Освобождение всегда явно.

Этот вариант удобен для массовых изменений и нескольких будущих распределений.
Для обычного подключения одного устройства он требует большого документа.
Главный риск — спрятать разные гарантии безопасности и восстановления под общим
словом «привести к желаемому состоянию».

## C. Специализированные операции и отдельный выбор при downgrade

```ts
interface WorkingDevices {
  reserve(context: AuthorizedContext, input: ReservationInput): Promise<Reservation>;
  cancelReservation(context: AuthorizedContext, input: CancellationInput): Promise<Receipt>;
  prepareReplacement(
    context: AuthorizedContext,
    input: ReplacementInput,
  ): Promise<ReplacementPreview>;
  confirmReplacement(
    context: AuthorizedContext,
    input: PreviewConfirmation,
  ): Promise<ReplacementProgress>;
}

interface DeviceRetentionSelection {
  preview(context: AuthorizedContext, input: RetainedSelection): Promise<RetentionPreview>;
  confirm(context: AuthorizedContext, input: PreviewConfirmation): Promise<Receipt>;
}
```

Повторное подключение остаётся операцией pairing, дополненной проверкой прежнего
владельца данных. Для уже существующего re-pair не вводится второй коммерческий
preview без отдельной причины.

Пример: `reserve({ kind: "handheld", ... })` создаёт одно общее место.
`prepareReplacement(oldDevice, replacement)` показывает данные источника и
готовность восстановления. `confirmReplacement` возвращает фактическую стадию:
подготовлено, ожидает обновления/восстановления либо завершено.
Выбор для будущего тарифа проходит отдельные `preview` и `confirm`.

Внутри скрыты блокировки, атомарное освобождение/занятие места, принадлежность
данных, история перехода и точный аудит. Методов больше, зато обычное намерение
очевидно из вызова. Нет клиентских флагов `force`, `ignorePending` или `allowRecovery`.
Редкий новый сценарий потребует отдельного метода, а не расширения общего набора опций.

## Сравнение и рекомендация

Рекомендуется C: специализированные владельцы действий с общими внутренними
проверками и серверной проекцией A для экрана. От B полезна фиксация полного
результата выбора при downgrade, но универсальный reconciliation сейчас избыточен.

Это продолжает принятый P1A подход: операция владеет своей транзакцией, а resolver
считает права. HTTP-маршруты кабинета, платформы и pairing не объединяются.
Рекомендация основана на удобстве правильного вызова и скрытии транзакционных
инвариантов; количество строк будущей реализации не служит критерием выбора.

## Проверенные ограничения всех вариантов

1. Текущий счётчик — `station_devices.revoked_at IS NULL`:
   [entitlements.service.ts](../../apps/api/src/subscriptions/entitlements.service.ts).
   Security revoke удаляет ключ до своей транзакции:
   [station-devices.service.ts](../../apps/api/src/modules/station-devices/station-devices.service.ts).
   Ни retained set, ни перенос нельзя реализовать вызовом этого revoke.
2. ТСД при `STATION_CREDENTIAL_REVOKED` удаляет локальные журналы и очереди:
   [DeviceWipe.kt](../../apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/storage/DeviceWipe.kt),
   [AppShellViewModel.kt](../../apps/handheld/app/src/main/kotlin/app/markiro/handheld/AppShellViewModel.kt).
   Отмена wipe без добавления принадлежности данных создаст риск отправки старой
   очереди после pairing с другим tenant/device.
3. Station сохраняет данные, но ownership печатных событий зависит от старого ключа:
   [credential-recovery.ts](../../apps/station/src/lib/credential-recovery.ts),
   [product-labels/sync.ts](../../apps/station/src/lib/product-labels/sync.ts).
   Нужен проверенный путь восстановления прежнего ownership после ротации.
4. Сервер не знает содержимое отключённой локальной очереди. В preview это
   `unknown` либо наблюдение с временем; отсутствие задач на сервере не означает
   «данных нет».
5. Подготовленный выбор не является освобождением reservations. Для будущего
   реального переноса нужен отдельный коммерческий учёт с миграцией 1:1 прежних
   занятых мест и сохранением security-состояния.
6. Порядок блокировок сверяется по исходникам: source writer P1A берёт quota locks
   в числовом порядке, затем timeline, нужные строки, revision последней
   ([entitlement-sources.service.ts](../../apps/api/src/subscriptions/entitlement-sources.service.ts)).
   Вариант A первоначально предложил timeline первым; это исправлено при сравнении.
   Нельзя добавить quota lock после уже взятого timeline/row lock без согласования
   всех затрагиваемых путей.
7. Новые назначения и ограничения сначала подготовлены/shadow. Подписанные
   офлайн-права — P1C, включение новых ограничений — P1D. Нельзя сообщать о
   завершённом переносе до прекращения прежней authority в поддерживаемых границах.

Поэтому первая отдельная поставка —
[P1B.1: безопасное повторное подключение](../superpowers/specs/2026-09-11-entitlements-p1b1-device-recovery-design.md).
После неё отдельно проектируются назначения/перенос и retained selection;
оставшиеся онлайн-адаптеры не теряются из объёма P1B.
