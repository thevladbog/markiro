# Киоск «Для себя»: сенсорный flow, SSCC и персональная политика — design handoff

> **Статус:** визуальный flow согласован 2026-08-13; системный handoff ожидает
> финального подтверждения перед `writing-plans`.
>
> **Следующий этап:** после подтверждения этого документа — отдельный
> implementation plan с миграциями, API-контрактами, kiosk/admin UI и тестами.
>
> **Связанные решения:**
> `2026-07-23-pickup-kiosk-design.md`,
> `2026-07-24-pickup-kiosk-b-app-offline-design.md`,
> `2026-07-29-aggregation-boxes-design.md`,
> `2026-08-06-kiosk-fullscreen-redesign.md`,
> `2026-08-06-admin-employees-redesign.md`.

## 1. Результат

Киоск «Для себя» становится постоянно включённым тёмным сенсорным интерфейсом
для планшетов, прайс-чекеров и моноблоков со сканером штрихкодов. Сотрудник:

1. входит по бейджу;
2. сканирует отдельные КМ DataMatrix и/или SSCC транспортных коробов;
3. выбирает «Через кассу» либо, при наличии права, «Списание»;
4. проверяет итог и подтверждает;
5. видит честный результат: подтверждение сервера, локальную offline-очередь или
   отказ.

SSCC — одна неделимая позиция. Содержимое короба не раскрывается на киоске и не
может участвовать в частичной операции. Количество бутылок и точный состав берутся
из tenant-scoped данных сервера, а не из введённого пользователем значения.

## 2. Что этот документ меняет

В конфликтующих местах этот handoff заменяет UI и бизнес-flow предыдущих kiosk
спецификаций:

- минимальные целевые поверхности теперь **480×800 portrait** и
  **800×480 landscape**;
- страница и рабочая область не прокручиваются;
- корзина поддерживает КМ и SSCC;
- выбор операции переносится после набора корзины, непосредственно перед
  подтверждением;
- лимит перестаёт быть настройкой конкретного киоска и становится политикой
  tenant + employee;
- зелёный результат показывается только после подтверждения сервера;
- вход поддерживает tenant branding с bundled Markiro fallback.

Неизменными остаются device-token trust domain, PBKDF2 badge digest, IndexedDB
journal/outbox, `deviceSeq`, admission proof, tenant isolation и текущая
поддержка legacy offline payloads.

## 3. Зафиксированные решения

1. Интерфейс полностью сенсорный; аппаратный сканер остаётся основным вводом.
2. Тема только тёмная. Светлая заливка используется для основного действия, а
   не как фон экрана.
3. Цвет сообщает результат:
   - зелёный — сервер подтвердил;
   - янтарный — локально сохранено, ожидает отправки;
   - красный — отказ или блокирующая ошибка;
   - нейтральный белый/серый — действие, выбор и обычное состояние.
     Иконка и текст обязательны: цвет не является единственным носителем статуса.
4. На экране привязки всегда отображается логотип Markiro; код состоит ровно из
   8 цифр и вводится крупной цифровой клавиатурой либо сканером.
5. На экране входа показываются имя и логотип компании. Если логотип отсутствует,
   не загрузился или недоступен offline, показывается bundled логотип Markiro.
6. Вход сопровождается анимацией сканирования бейджа без подписи «Зона
   сканирования».
7. В landscape вход делится на две равные смысловые колонки: анимация по центру
   левой, текст по левому краю правой. Branding остаётся сверху.
8. В строках корзины DataMatrix-иконка означает отдельную бутылку, иконка короба —
   SSCC. Технические подписи «ЧЗ» и «SSCC» не используются как основной
   визуальный различитель.
9. Короб не раскрывается, не редактируется по бутылкам и удаляется только целиком.
10. Смешанная корзина из коробов и отдельных бутылок разрешена.
11. Количество короба участвует в лимите и итогах как количество бутылок. В
    согласованном примере один короб содержит 12 бутылок; реальное значение
    всегда приходит из данных короба.
12. Лимит считается по сотруднику суммарно по всем киоскам tenant.
13. Tenant может полностью выключить лимиты. При включённой политике у каждого
    сотрудника отдельно задаётся «Ограничено: N бутылок в день» либо «Без
    лимита».
14. Право «Может оформлять списание» независимо от режима лимита.
15. Сотрудник без права списания не видит лишний шаг: его операция сразу
    оформляется «Через кассу». Сотрудник с правом выбирает «Через кассу» или
    «Списание» перед подтверждением.
16. Для списания обязательна активная tenant-причина.
17. Основная финальная кнопка называется «Подтвердить N бутылок». «Отправить» не
    используется, потому что offline операция может остаться на устройстве.

## 4. Пользовательский flow

```text
не привязан
  → привязка устройства
  → вход по бейджу
  → сканирование КМ / SSCC
  → продолжить
  → [есть право списания?]
      нет → подтверждение «Через кассу»
      да  → выбор операции
              «Через кассу» → подтверждение
              «Списание» → причина → подтверждение
  → результат
      server accepted → зелёный успех
      offline/timeout  → янтарная очередь
      server rejected  → красный отказ
  → вход
```

«Назад» сохраняет текущую корзину. «Отменить» и «Выйти» требуют подтверждения,
если корзина не пустая, затем очищают только текущую сессию. Неактивность
возвращает на вход по существующей timeout-политике; незавершённая корзина не
превращается в заказ сама.

## 5. Экранный handoff

### 5.1 Привязка

- Верх: Markiro wordmark, статус сети и «не привязан».
- Заголовок: «Введите 8-значный код».
- Восемь отдельных ячеек с tabular цифрами; пустая ячейка показывает точку.
- Клавиатура: `1–9`, «Очистить», `0`, «Удалить».
- «Подключить киоск» disabled, пока введено не ровно 8 цифр.
- Ошибка кода остаётся на этом экране, окрашивает только сообщение/границу в
  `err`, не всю клавиатуру.
- Сканер может передать восемь цифр тем же обработчиком, что и касания.

### 5.2 Вход

- Branding: `organization.logo` + `organization.name`; Markiro mark — fallback.
- Центр portrait: анимация бейджа, eyebrow «Киоск для сотрудников», заголовок
  «Отсканируйте пропуск», краткая инструкция.
- Landscape: левая половина содержит только центрированную анимацию, правая —
  eyebrow, заголовок и инструкцию с одинаковым левым краем.
- Footer: имя/место киоска и Markiro.
- Unknown/revoked/inactive badge: красное предметное сообщение и возврат в режим
  ожидания нового скана; имя сотрудника не угадывается и не раскрывается.

### 5.3 Сканирование и корзина

- Statusbar: сеть, количество записей очереди, время.
- Session header: ФИО; effective limit (`лимит 30 · осталось 17` либо `без
ограничений`); позиции/бутылки; «Выйти».
- Last-scan feedback:
  - иконка типа;
  - «Бутылка добавлена» или «Короб добавлен»;
  - product name;
  - для короба — количество бутылок.
- Строка отдельной бутылки: DataMatrix icon, название, безопасный хвост кода,
  `1 шт`, цена при `showPrices`.
- Строка короба: box icon, название единственного продукта, хвост SSCC,
  `N шт`, суммарная цена при `showPrices`.
- Название — одна строка с ellipsis. Полный текст доступен через accessible
  name и в диалоге строки.
- Тап по строке открывает нейтральный touch-dialog с деталями и действием
  «Удалить из корзины». Для короба удаляется вся строка; состава и выбора
  количества в диалоге нет.
- Нижний итог всегда виден: позиции, бутылки, сумма и «Продолжить».
- Позиция — одна строка корзины; бутылки — сумма отдельных КМ и содержимого
  коробов.

### 5.4 Переполнение

Прокрутка списка запрещена. Используется явная пагинация с большими кнопками
«Назад»/«Далее» и счётчиком `X / Y`.

| Минимальная поверхность | Строк на странице | Поведение                                          |
| ----------------------- | ----------------: | -------------------------------------------------- |
| 480×800 portrait        |                 5 | Итог и CTA закреплены снизу                        |
| 800×480 landscape       |                 3 | Feedback слева, корзина справа, итог на всю ширину |

На неполной последней странице пустое место остаётся пустым; строки не
растягиваются. Переход между страницами не меняет порядок. Добавленный скан
переводит на страницу новой строки и кратко подсвечивает её нейтральной обводкой.

### 5.5 Выбор операции

- Две крупные карточки: «Через кассу» и «Списание».
- «Через кассу»: «Подготовить товары для последующей продажи».
- «Списание»: «Потребуется причина».
- Карточка списания существует только при `canWriteoff=true`; право повторно
  проверяет сервер.
- Операция применяется ко всей корзине.

### 5.6 Причина списания

- Активные причины tenant показываются touch-grid.
- Одновременно выбрана ровно одна причина.
- При 1–6 причинах pager отсутствует. При большем количестве — страницы по 6,
  без scroll.
- Архивированная после bootstrap причина может присутствовать offline, но сервер
  вправе отклонить её как `unknown_reason`.

### 5.7 Подтверждение

- ФИО показывается один раз в session header.
- Тип операции «Через кассу»/«Списание» показывается один раз рядом с заголовком
  «Всё верно?».
- Метрики: всего бутылок и сумма (если цены включены).
- Состав: количество коробов и отдельных бутылок.
- Список использует те же иконки и атомарные строки. При переполнении — pager,
  не scroll.
- CTA: «Подтвердить N бутылок»; вторичная кнопка «Назад».
- Кнопка блокируется на время локальной записи в journal, а не только HTTP.

### 5.8 Результаты

**Server accepted — зелёный.** «Товары приняты», номер операции, количество и
сумма. Только этот экран является успехом.

**Queued offline — янтарный.** «Ожидает отправки», явная фраза «Это ещё не
подтверждённый успех», размер очереди. Пользователь может завершить сессию;
journal переживает restart.

**Rejected — красный.** Конкретная причина и восстановимое действие. Для SSCC:
«Короб …000014 отклонён целиком; 12 бутылок не попали в операцию». Внутренний
список КМ не раскрывается.

Если сервер принял часть независимых строк и отклонил другие, экран сообщает
оба числа и сохраняет конфликтные строки для повторной обработки. Один короб
никогда не оказывается частично в принятой и частично в отклонённой части.

## 6. Responsive layout

### 6.1 Общие ограничения

- `html`, `body`, `#root`, shell: `height: 100dvh`, `min-height: 0`,
  `overflow: hidden`.
- Каждый screen занимает рабочую область целиком; page scroll, body scroll и
  скрытые gesture-only действия запрещены.
- Минимальный support: 480×800 portrait и 800×480 landscape. Ниже этих размеров
  показывается фиксированный диагностический экран «Экран устройства слишком
  мал» с фактическим размером; рабочий flow не обрезается молча.
- Перестройка определяется `orientation`/aspect ratio, а не user agent.
- Safe-area insets входят во внутренние padding, не увеличивая внешний размер.

### 6.2 Каркас

- Statusbar: 30 px.
- Session header: 65 px.
- Основной floor CTA: не менее `--control-floor` (64 px).
- Обычная touch target: не менее 48×48 px; компактные targets допустимы только
  внутри связанной 48 px области.
- Portrait scan: feedback 158 px, затем гибкая корзина, checkout 116 px.
- Landscape scan: колонки приблизительно 45/55; feedback слева, basket справа,
  checkout 96 px на всю ширину.
- Отступы строятся только на `--sp-*`; радиусы — `--r-*`.

## 7. Production tokens

Прототип не является источником production CSS. Реализация использует
`@markiro/ui`; новый параллельный token set не создаётся.

| Роль                 | Token                                   | Dark value сейчас    |
| -------------------- | --------------------------------------- | -------------------- |
| Фон устройства       | `--surface-page`                        | `#131216`            |
| Карточка             | `--surface-card`                        | `#1c1b21`            |
| Поднятая поверхность | `--surface-panel`                       | `#232228`            |
| Основной текст       | `--fg-1`                                | `#fafaf8`            |
| Вторичный текст      | `--fg-2`, `--fg-3`                      | `#b6b3ab`, `#8e8b83` |
| Границы              | `--line`, `--line-strong`               | `#2e2d33`, `#45444b` |
| Нейтральный CTA      | `--surface-inverse` + `--fg-on-inverse` | светлый на тёмном    |
| Server success       | `--ok-*`                                | зелёный semantic     |
| Offline/wait         | `--warn-*`                              | янтарный semantic    |
| Refusal              | `--err-*`                               | красный semantic     |
| Focus                | `--focus-ring`                          | контрастный ring     |

`--accent` не окрашивает обычные кнопки. Он допустим в модуле Markiro; зелёный
semantic появляется в flow только у подтверждённого результата.

Typography: IBM Plex Sans для интерфейса, IBM Plex Mono для кода, времени,
счётчиков и табличных цифр. Шрифты bundled; CDN запрещён. Заголовки на минимальной
поверхности используют существующий `--floor-title`, но могут снижаться до 28 px
через kiosk component variant, если 34 px прототипа не проходит локализацию.

## 8. Motion и touch feedback

| Элемент           | Trigger                | Motion                                               |   Duration |
| ----------------- | ---------------------- | ---------------------------------------------------- | ---------: |
| Scanner beam      | экран входа            | вертикальный проход по бейджу, alternate ease-in-out |    2100 ms |
| Touch control     | pointer down           | `translateY(1px)`                                    |      70 ms |
| Цвет/граница      | state change           | linear/ease без overshoot                            |     120 ms |
| Новый scan result | successful local parse | fade/outline, без перемещения layout                 | 120–180 ms |

При `prefers-reduced-motion: reduce` beam фиксируется в центре, остальные
переходы отключаются либо сокращаются до мгновенного state change.

## 9. Cart и SSCC domain rules

### 9.1 Локальная модель

```ts
type KioskCartLine =
  | {
      kind: "km";
      rawKm: string;
      kmKey: string;
      productId: string;
      unitCount: 1;
    }
  | {
      kind: "box";
      boxId: string;
      sscc: string;
      productId: string;
      bottleCount: number;
      contentKeys: readonly string[]; // внутренний дедуп, не UI
      registryVersion: string;
    };
```

### 9.2 Допустимый короб

SSCC принимается только если короб:

- принадлежит tenant привязанного киоска;
- закрыт (`sscc` и `closedAt` заданы);
- не disassembled;
- не имеет active removed/displaced contents и
  `contentsChangedAfterClose=false`;
- содержит хотя бы один действующий KM;
- содержит один вид продукции; product определяется сервером;
- каждый active `box_items.code_hash` разрешается через tenant `code_registry`
  и каноническую запись `codes`.

Склад/линия/место не являются фильтром: в системе короб доступен на уровне
tenant. `shiftId` используется только для происхождения и аудита.

### 9.3 Дедуп и атомарность

- Повторный отдельный `kmKey` не добавляется.
- Повторный SSCC не добавляется.
- Если отдельный KM уже входит в добавленный короб, это duplicate.
- Если добавляемый короб содержит KM, уже добавленный отдельно или внутри
  другого короба, весь новый короб отклоняется локально.
- Сервер повторяет все проверки в одной tenant-scoped транзакции.
- При любом конфликте одного member KM короб не расширяется частично: либо все
  его bottle rows приняты, либо ни одна.
- Независимые loose-KM строки сохраняют текущую per-item conflict семантику;
  response обязан отличать принятые строки от конфликтных.

SSCC normalizer относится к `@markiro/domain`: хранение/API используют ровно 18
цифр без `(00)`. Scanner boundary может удалить AIM `]C1`, печатное `(00)` или
GS1 AI `00`, после чего обязан проверить check digit. Произвольные 18 цифр без
валидной контрольной цифры не являются SSCC.

## 10. Политика лимитов и разрешений

### 10.1 Новая модель

`dayLimitPerEmployee` на `kiosks` больше не является источником бизнес-правила.
Добавляются две tenant-scoped сущности:

```text
pickup_tenant_policies
  tenant_id PK/FK organization
  limits_enabled boolean not null default true
  updated_at timestamptz not null

employee_pickup_policies
  tenant_id
  employee_id
  limit_mode limited | unlimited
  day_limit integer not null check > 0
  can_writeoff boolean not null default false
  updated_at timestamptz not null
  PK (tenant_id, employee_id)
  composite FK → employees(tenant_id, id)
```

`day_limit` сохраняется и при `unlimited`, чтобы возврат в limited не терял
последнее значение. Значение игнорируется, когда tenant policy выключена или
`limit_mode=unlimited`.

Создание сотрудника транзакционно создаёт policy row: `limited`, 5,
`can_writeoff=false`. При включённых лимитах active employee без policy row —
ошибка конфигурации, а не неявный unlimited.

### 10.2 Effective policy

```text
limit applies = tenant.limitsEnabled && employee.limitMode == limited
writeoff allowed = employee.canWriteoff
```

Лимит считается в бутылках по всем неотменённым заказам сотрудника на всех
киосках tenant. Короб в 12 бутылок расходует 12. Текущий server-authoritative
cross-kiosk count и split `takenTodayElsewhere + this kiosk journal` сохраняются,
но limit берётся из employee policy. Граница суток пока остаётся текущей UTC;
tenant timezone не вводится скрыто в рамках редизайна и требует отдельного
продуктового решения.

### 10.3 Миграция legacy kiosk limits

- Для tenant с активным киоском `limits_enabled=true`; без активных киосков —
  `false`.
- Для каждого существующего сотрудника создаётся `limited` policy.
- Начальный `day_limit` — максимальный `dayLimitPerEmployee` среди активных
  киосков tenant; если киосков нет — 5. Maximum соответствует наибольшему
  allowance, который уже был доступен сотруднику через один из киосков, и не
  создаёт новый отказ после upgrade.
- `can_writeoff=false`: право нельзя выводить из свободного текста роли.
- Legacy kiosk field остаётся только на совместимый переходный релиз, не
  редактируется в новом admin UI и больше не участвует в enforcement. Удаление
  колонки — отдельная последующая миграция после обновления клиентов.

### 10.4 Admin UI

Tenant setting: «Ограничивать выдачу сотрудникам» с пояснением «Лимит считается
суммарно по всем киоскам tenant». Выключение не стирает персональные значения.

В карточке сотрудника отдельный раздел «Киоск “Для себя”»:

- режим: «Ограничено» / «Без лимита»;
- `N бутылок в день` при limited;
- «Может оформлять списание».

Нужна массовая операция для выбранных сотрудников: назначить limited + N либо
unlimited. Право списания массово не включается по умолчанию и меняется отдельным
явным действием.

## 11. API handoff

### 11.1 Существующий контракт, который сохраняется

- Pair code: `^\d{8}$`.
- Badge identity: ровно одно из `badgeDigest` или legacy `badgeCode`.
- `(tenantId, kioskId, deviceSeq)` — idempotency key.
- Legacy `POST /kiosk/orders` payload с `items: [{ rawKm }]` продолжает
  приниматься до закрытия offline queue horizon.

### 11.2 Bootstrap additions

```ts
interface KioskBootstrapDto {
  // existing fields...
  branding: {
    organizationName: string;
    logoUrl: string | null;
    logoRevision: string | null;
  };
  pickupPolicy: {
    limitsEnabled: boolean;
  };
  employees: Array<{
    // existing fields...
    limitMode: "limited" | "unlimited";
    dayLimit: number;
    canWriteoff: boolean;
    takenTodayElsewhere: number;
  }>;
  boxRegistry: {
    version: string;
    generatedAt: string;
  };
}
```

Логотип загружается через same-origin API/object route и сохраняется blob в
IndexedDB/cache storage. Kiosk login не зависит от runtime внешнего URL.

### 11.3 Compact box registry

Полный список active closed boxes tenant не встраивается без ограничений в один
bootstrap JSON. Device-auth endpoint отдаёт versioned snapshot/delta страницами:

```ts
interface KioskBoxRegistryRow {
  boxId: string;
  sscc: string;
  productId: string;
  bottleCount: number;
  contentKeys: string[];
  updatedAt: string;
}
```

`contentKeys` — canonical KM keys либо их стабильные tenant-scoped digests для
локального overlap detection; raw KM содержимое короба в UI не передаётся.
Snapshot записывается во временную IndexedDB version и активируется только после
полной загрузки всех страниц. Delta поддерживает `upsert` и `remove` для
disassembled/changed boxes.

### 11.4 Order request

```ts
interface CreateOrderDtoVNext {
  // existing identity, sequence, reason, timestamps and admission fields...
  items: Array<{ rawKm: string }>;
  boxes?: Array<{ sscc: string }>;
}
```

Требование: `items.length + boxes.length >= 1`. SSCC canonical, уникален в
request. `admissionProof` payload digest включает boxes в стабильном порядке.

Response расширяется без изменения legacy `conflicts`:

```ts
interface BoxConflict {
  sscc: string;
  bottleCount: number | null;
  reason:
    | "unknown_box"
    | "box_not_closed"
    | "box_disassembled"
    | "box_contents_changed"
    | "mixed_product_box"
    | "duplicate"
    | "over_limit";
}

interface CreateOrderResultDto {
  // existing fields...
  boxConflicts: BoxConflict[];
  acceptedBoxes: Array<{ sscc: string; bottleCount: number }>;
}
```

Server расширяет accepted box в точные `pickup_order_items` внутри той же
transaction, которой создаётся заказ и применяется лимит. Client-supplied
`bottleCount`, product или KM list не принимаются.

## 12. Persistence и audit

Добавляется `pickup_order_boxes`:

```text
id uuid PK
tenant_id
order_id
box_id
sscc char(18)
product_id
bottle_count integer check > 0
unit_price numeric(12,2) nullable
created_at timestamptz
unique (tenant_id, order_id, box_id)
composite tenant FKs → pickup_orders, boxes, products
```

`pickup_order_items` получает nullable `order_box_id` с tenant composite FK.
Каждый expanded KM сохраняется обычной строкой для существующего экспорта,
дедупа и аудита; `order_box_id` позволяет снова собрать одну неделимую строку в
admin/kiosk presentation. Snapshot `sscc`, product, count и price остаётся в
заказе, даже если производственный короб позднее получил exception.

Audit для policy mutations проверяет actor, tenant, employee, before/after
limit mode/value и `canWriteoff`. Order audit различает loose KM и SSCC source,
не записывая badge plaintext.

## 13. Offline и восстановление

- Branding, employees, reasons, products и box registry хранятся локально.
- Box registry имеет собственные `version/generatedAt`, но использует тот же
  staleness warning/block подход, что и bootstrap. Stale offline snapshot может
  принять короб локально; сервер остаётся авторитетом и может отклонить при
  sync.
- Перед любым network attempt операция сначала целиком записывается в journal.
- Queued payload хранит `boxes[].sscc`, но не дублирует raw содержимое короба.
- Retry идемпотентен по существующему `deviceSeq`.
- Terminal rejection остаётся в quarantine с понятной причиной. Следующий вход
  того же сотрудника показывает непросмотренный результат до начала новой
  корзины.
- Restart, повторная привязка и смена ориентации не теряют queue/journal.
- Серверный success после фонового sync не перекрашивает уже закрытый amber
  экран задним числом; результат показывается при следующем входе сотрудника
  или в admin reconciliation.

## 14. Accessibility

- Все интерактивные строки и карточки — семантические `button`, не clickable
  `div`.
- Focus order повторяет визуальный порядок; `:focus-visible` использует
  `--focus-ring`.
- Сканер не блокирует клавиатурную навигацию и не крадёт focus у диалога.
- Last-scan result и outcomes объявляются через bounded `aria-live`; повторный
  скан не создаёт бесконечную очередь announcement.
- Иконки типа имеют accessible label «Отдельная бутылка»/«Короб»; декоративные
  SVG скрыты.
- Status содержит иконку + текст; `success/warning/error` не различаются только
  цветом.
- Touch target минимум 48 px, основной CTA 64 px.
- Анимация соблюдает `prefers-reduced-motion`.
- Русская и английская локализации обязательны; длинные product names и
  employee names проверяются отдельно.

## 15. Ошибки и edge cases

| Ситуация                            | Поведение                                             |
| ----------------------------------- | ----------------------------------------------------- |
| Пустая корзина                      | «Продолжить» disabled                                 |
| Duplicate KM                        | не добавлять; предметный neutral/warn feedback        |
| KM уже в коробе                     | не добавлять отдельную бутылку                        |
| Короб пересекается с корзиной       | отклонить весь новый короб                            |
| Unknown SSCC online                 | красное сообщение, корзина не меняется                |
| Unknown SSCC offline                | не добавлять: offline registry не подтверждает состав |
| Registry stale, box later changed   | локально queued; серверный box conflict               |
| Box member over limit               | весь короб получает `over_limit`                      |
| Employee limited, остаток 5, box 12 | короб не добавляется/не подтверждается целиком        |
| Tenant limits disabled              | limit UI показывает «Без ограничений tenant»          |
| Employee unlimited                  | numeric day limit не применяется                      |
| Нет права списания                  | choice/reason screens пропускаются                    |
| Нет активных причин                 | списание disabled с объяснением администратору        |
| Logo absent/broken/offline          | bundled Markiro logo, company name сохраняется        |
| Много cart lines                    | 5 portrait / 3 landscape, pager, итог видим           |
| Много confirmation lines            | pager, итог и CTA видимы                              |
| Много причин                        | страницы по 6, не scroll                              |
| Ни одна строка не принята сервером  | order не создаётся; красный отказ                     |
| Часть строк принята                 | explicit partial result; короб не дробится            |

## 16. Проверка

### 16.1 Domain и DB

- SSCC normalization: plain 18 digits, `00` prefix, `(00)`, AIM `]C1`, invalid
  check digit, malformed/oversized inputs.
- Tenant isolation для box registry, box expansion, policies и logo route.
- Box eligibility: open, disassembled, changed, removed/displaced, mixed product,
  missing canonical code.
- KM↔box и box↔box overlap.
- Atomic all-or-none expansion одного box.
- Migration: equal and divergent kiosk limits, tenant without kiosks, archived
  employee, policy row creation, composite FKs/checks.
- Cross-kiosk count с limited/unlimited/tenant-off и box quantities.
- Exact audit before/after.

### 16.2 API

- Legacy item-only payload остаётся валидным.
- New mixed request, replay по `deviceSeq`, admission payload digest with boxes.
- Old queued `badgeCode` и current `badgeDigest` paths.
- Permission denial для writeoff, archived reason, revoked badge/kiosk.
- Per-box conflicts do not expose KM list.
- Subscription/admission behavior не регрессирует.

### 16.3 Kiosk automated

- Pairing keypad ровно 8 цифр.
- Branding fallback and cached blob.
- Login motion/reduced motion.
- KM and box row icons/labels.
- 5 portrait rows, 3 landscape rows, pager boundaries and long titles.
- Operation choice branching by `canWriteoff`.
- Confirmation contains one visible operation label.
- Green only on server accepted; amber offline; red rejected.
- IndexedDB restart, old queue migration, quarantine and stale registry.

Before diagnosing fresh-worktree kiosk import failures, build
`@markiro/domain` and `@markiro/ui`.

### 16.4 Browser acceptance

For every screen and state at 480×800 and 800×480:

- `document.documentElement.scrollHeight === window.innerHeight`;
- shell/screen `scrollHeight === clientHeight`;
- no control or text outside viewport;
- primary CTA visible without scroll;
- portrait login centered; landscape login columns aligned;
- cart overflow matches 5/3 rows;
- long Russian/English copy and 100+ cart positions page correctly;
- rotation resets pagination to a valid page without losing cart.

### 16.5 External acceptance

Отдельно, не подменяя автоматическими тестами:

- физический планшет/прайс-чекер в обеих ориентациях;
- HID scanner and Web Serial where supported;
- DataMatrix with GS separators and real GS1-128 SSCC label;
- installed PWA restart offline;
- яркость/выгорание при длительной работе;
- реальная tenant logo asset and object-storage behavior.

## 17. Предполагаемые области изменений

- `packages/domain`: SSCC scanner normalization/validation helpers.
- `packages/db`: tenant/employee pickup policies, order-box provenance,
  migrations and schema tests.
- `apps/api`: kiosk bootstrap, box registry, order admission/create, employee and
  tenant policy admin API, branding route, OpenAPI tests.
- `apps/kiosk`: screens/state machine, responsive layout, IndexedDB registry,
  mixed cart, sync/quarantine, i18n and tests.
- `apps/admin`: tenant policy, employee per-policy and bulk assignment, company
  logo management/fallback preview.
- `packages/ui`: only reusable variants/tokens required by multiple surfaces;
  kiosk CSS must not fork production tokens.

## 18. Non-goals

- раскрытие состава короба или частичный отбор из него;
- склады/места хранения и привязка короба к складу;
- сканирование паллет;
- прямая интеграция киоска с ККТ или ГИС МТ;
- runtime CDN, облачные шрифты или внешняя logo dependency;
- светлая тема киоска;
- автоматическая выдача права списания по названию должности;
- изменение station operator trust domain или объединение кабинетных и
  производственных учётных записей.
