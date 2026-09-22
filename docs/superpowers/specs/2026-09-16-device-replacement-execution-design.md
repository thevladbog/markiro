# Исполнение замены рабочего устройства

Статус: проект согласован владельцем продукта 2026-09-16 в части двух режимов
замены; документ фиксирует полный протокол перед планом реализации.

Основание: ФТ `Markiro_Catalog_Entitlements_Functional_Requirements_EN.md`,
FR-DEV-04, FR-LIF-01, FR-LIF-03–06 и AC-23/33; существующий проект
[P1B.2](2026-09-12-entitlements-p1b2-device-licensing-design.md); подготовка
замены из
[плана 2026-09-12](../plans/2026-09-12-device-replacement-preparation.md).
База: `origin/main` на `d26129dc45b18389e1b20ed330b482a6493d5580`.

## 1. Проблема и результат

Текущий экран умеет рассчитать, сохранить и отменить проект замены. Он намеренно
возвращает `execution.available = false`, всегда считает локальные журналы,
очереди и печать неизвестными и не переносит лицензионное место. Поэтому
подготовленный проект нельзя завершить, даже когда старое устройство доступно и
полностью синхронизировано.

После этой поставки авторизованный администратор сможет выполнить замену Station
или ТСД двумя способами:

1. **Обычная замена** переводит старое устройство в управляемое завершение,
   запрещает ему начинать новую работу, получает достоверный локальный отчёт,
   дожидается безопасного состояния и только затем переносит место.
2. **Аварийная замена** применяется, когда старое оборудование недоступно.
   Облачный credential отзывается немедленно, место переносится, а начало новой
   работы на целевом устройстве откладывается до безопасной границы уже выданной
   офлайн-власти. Оставшиеся данные можно позднее выгрузить отдельным
   recovery-credential, который не разрешает новую работу.

Оба режима сохраняют исходное устройство, серверные и локальные доказательства,
идемпотентность операций и полный аудит. Замена не удаляет журналы, не
пересчитывает исторические факты и не создаёт второе оплачиваемое место.

## 2. Выбранный подход

Рассматривались три варианта:

- серверный переключатель без участия устройства быстрее, но не знает о
  несинхронизированных данных и может оставить две действующие офлайн-власти;
- обязательный drain безопасен для доступного устройства, но навсегда блокирует
  замену сломанного или утраченного оборудования;
- двухрежимный протокол сочетает подтверждённый drain и контролируемую аварийную
  замену с отложенным допуском и recovery-путём.

Принят третий вариант. Он использует действующие credential generation,
offline-grant readiness, локальные outbox и recovery ownership вместо создания
параллельной системы идентичности.

## 3. Границы поставки

В поставку входят:

- durable intent и отчёт готовности для Station и ТСД;
- блокировка новой работы на старом устройстве после начала обычной замены;
- атомарный перенос assignment и лицензионного места после подтверждённого
  прекращения облачной власти старого устройства;
- создание новой durable device-записи и резерва подключения;
- обычное и аварийное исполнение, история и аудит;
- безопасная граница для ранее выданных offline grants;
- ограниченный recovery-code для старого устройства после аварийной замены;
- одинаковый кабинетный и платформенный интерфейс;
- RU/EN тексты и совместимость со старыми клиентами.

В поставку не входят перенос локальной базы на новое устройство, автоматическое
копирование локальных журналов между компьютерами и физическая диагностика
сломавшегося оборудования. Новое устройство начинает с новой локальной базы.
Синхронизированные факты остаются на сервере; несинхронизированные факты
выгружаются со старого носителя обычным или recovery-путём.

## 4. Модель состояния

Состояния проекта замены:

| Состояние   | Значение                                                                                         |
| ----------- | ------------------------------------------------------------------------------------------------ |
| `prepared`  | Проект сохранён, старое устройство работает как прежде                                           |
| `draining`  | Запрошено обычное завершение; новая работа запрещена, восстановление и отправка данных разрешены |
| `ready`     | Получен свежий отчёт той же credential generation, все обязательные каналы готовы                |
| `executing` | Зафиксировано намерение cutover; идёт возобновляемый отзыв credential и перенос assignment       |
| `completed` | Новая запись устройства и резерв места созданы, старый полный credential недействителен          |
| `cancelled` | Проект отменён до начала необратимого cutover                                                    |

`completed` дополняется полями исполнения:

- `mode`: `normal | emergency`;
- `targetDeviceId`;
- `executedAt`;
- `newWorkAllowedAt`;
- `recoveryState`: `not_required | required | draining | completed`;
- `sourceCredentialEpoch` и фактическая граница offline authority;
- сохранённый readiness snapshot либо аварийное основание.

После перехода в `executing` отмена недоступна. Повтор той же команды продолжает
или возвращает прежний результат. Фоновый repair завершает шаги после падения
процесса. Целевое устройство не получает производственный допуск до подтверждения
отзыва облачного credential старого устройства.

## 5. Отчёт локальной готовности

### 5.1 Запрос

Обычная замена создаёт durable readiness intent, привязанный к:

- tenant, source device и replacement preparation;
- текущей credential generation/epoch;
- revision проекта и server request ID;
- версии коммерческих условий и offline-grant configuration;
- времени запроса и сроку актуальности.

Сервер прекращает выдачу новых device/task grants для источника и отклоняет
создание новой смены, инвентаризации или другой производственной работы. Уже
созданные факты, закрытие текущей работы, синхронизация, чтение и recovery
остаются доступны по действующим правилам.

Station и ТСД сохраняют intent локально до подтверждённого ответа сервера.
Перезапуск приложения не снимает drain. Клиент атомарно прекращает использование
локальных grants для старта новой работы, сохраняет journals/outboxes и повторяет
неподтверждённый отчёт с тем же request ID.

### 5.2 Нормализованный отчёт

Отчёт содержит только метаданные, а не сырые маркировочные коды, PIN, ключи или
содержимое журналов:

- `clientBuild`, `storageRevision`, `credentialEpoch`;
- идентификатор intent и monotonic local report sequence;
- `pending.scans`, `pending.inventories`, `pending.shiftClosures`;
- `pending.productLabels`, `pending.boxes`, `pending.exceptions`;
- `conflicts` и `unknownPrints`;
- активные локальные task IDs и их типы;
- установленные offline grant IDs и максимальный `notAfter`;
- digest канонического состояния и верхние durable sequence по поддерживаемым
  журналам;
- время клиента только как наблюдение; серверное `receivedAt` остаётся
  авторитетным.

Конкретные SQLite/Room таблицы различаются между Station и ТСД, но оба клиента
публикуют одну строгую проекцию. Счётчик `0` означает выполненный запрос к
поддерживаемому хранилищу. `unsupported` означает старую версию клиента и не
преобразуется в ноль.

### 5.3 Условие готовности

Обычное исполнение разрешено, когда последний отчёт:

- относится к текущему intent, device и credential epoch;
- принят после начала drain и не старше установленного сервером короткого TTL;
- не содержит активной работы, pending outbox, конфликтов или неизвестного
  результата печати;
- подтверждает отсутствие установленного grant, разрешающего новую работу;
- соответствует текущим entitlement, assignment и replacement revisions;
- получен от клиента, поддерживающего все обязательные каналы своего kind.

Изменение значимых фактов переводит `ready` обратно в `draining`. Heartbeat без
изменения фактов не инвалидирует отчёт. Клиент не может сам объявить перенос
безопасным: сервер повторно вычисляет результат из отчёта, выданных grants,
облачных очередей и текущих revisions.

## 6. Обычное исполнение

1. Администратор нажимает «Подготовить устройство к замене».
2. Сервер создаёт intent и включает admission override `draining`.
3. Клиент показывает постоянный экран завершения, блокирует новую работу,
   завершает разрешённые текущие операции и отправляет очереди.
4. Клиент публикует отчёты до состояния `ready`.
5. Администратор подтверждает исполнение по свежему preview.
6. Сервер долговечно записывает execution intent со статусом `executing`.
7. Полный API credential источника отзывается идемпотентно. Ошибка или потеря
   ответа оставляет возобновляемое `executing`, но не создаёт целевое устройство.
8. В quota-locked транзакции сервер:
   - переводит старый assignment в `released` с причиной
     `replacement_transferred`;
   - создаёт новую station-device запись с выбранными name/kind;
   - создаёт для неё `reserved` assignment, занимающий переданное место;
   - завершает preparation и execution;
   - повышает entitlement/device decision revisions;
   - пишет immutable working-device event и точный platform/cabinet audit.
9. Интерфейс предлагает выпустить одноразовый pairing code через общий механизм
   кодов подключения.

Отзыв credential и перенос assignment образуют recoverable state machine, потому
что действующий путь security revoke уже не обещает атомарность внешнего auth
вызова и бизнес-транзакции. Инвариант жёсткий: новый operational authority не
возникает до подтверждённого отзыва старого cloud credential. Repair повторяет
только незавершённый шаг и никогда не создаёт второй target.

Потерянный ответ с plaintext pairing code не требует хранения кода открытым
текстом. Пользователь выпускает новый код; предыдущий live code для target
погашается. Повтор execution возвращает тот же target без нового места.

## 7. Аварийное исполнение

Аварийная операция требует `credentials.manage` в кабинете либо
`tenants.write + billing.write` на платформе, свежую повторную проверку principal,
непустое основание до 1000 символов и явное подтверждение последствий.

Сервер вычисляет `newWorkAllowedAt` из собственных записей всех выданных старому
credential epoch device/task grants. Если точная активная выдача неизвестна,
используется консервативная максимальная граница действующей policy. Клиентское
время или заявление об удалённом grant не сокращает эту границу.

Далее применяется тот же execution state machine, но readiness snapshot может
быть отсутствующим или блокирующим. Новое устройство разрешается подключить
сразу, однако до `newWorkAllowedAt` получает состояние ожидания: чтение настройки,
обновление и восстановительные операции доступны, новая производственная работа
и новые offline grants запрещены. Старый cloud credential уже отозван; возможная
автономная работа старого устройства ограничена ранее выданным grant и не
продлевается.

Execution сохраняет `recoveryState = required`, известный последний локальный
отчёт, server-side pending facts, основание, actor и вычисленную offline boundary.
Предупреждение остаётся видимым до подтверждённого восстановления либо явного
закрытия кейса с отдельным аудитом.

## 8. Recovery старого устройства

После аварийной замены администратор может выпустить короткоживущий одноразовый
recovery pairing code только для исходного durable device ID. Redemption требует,
чтобы локальный owner в Station/ТСД совпал с tenant, device ID, kind и server
origin. Несовпадение запечатывает данные и не перепривязывает их к target.

Выданный credential имеет purpose `replacement_evidence_recovery`, связан с
execution ID и credential epoch. API guard разрешает ему только перечисленные
маршруты чтения, выгрузки ранее созданных событий, получения acknowledgements и
readiness report. Создание смен, заданий, кодов, печатных работ, изменение
каталога и получение новых offline grants запрещены deny-by-default.

Station/ТСД входят в существующий recovery UI, не очищают БД и не меняют owner.
После отправки очередей публикуется финальный readiness report. При нулевых
обязательных каналах сервер помечает recovery `completed` и отзывает ограниченный
credential. Неопределённая печать и конфликты требуют явного решения; они не
исчезают из-за нажатия «завершить».

Если носитель утрачен окончательно, уполномоченный администратор может закрыть
recovery как `evidence_unavailable` с отдельным основанием. Это не создаёт
отсутствующие факты и не меняет прежние журналы; история навсегда показывает,
что локальная полнота не подтверждена.

## 9. Контракты и маршруты

Существующие preview/confirm/cancel маршруты остаются совместимыми. Контракт
наблюдения перестаёт требовать постоянные `unknown/available:false` и допускает
реальное readiness-состояние.

Кабинетные маршруты:

- `POST /device-licensing/replacements/:preparationId/drain`;
- `POST /device-licensing/replacements/:preparationId/execute/preview`;
- `POST /device-licensing/replacements/:preparationId/execute`;
- `POST /device-licensing/replacements/:preparationId/emergency/preview`;
- `POST /device-licensing/replacements/:preparationId/emergency/execute`;
- `POST /device-licensing/replacements/:preparationId/recovery-code`;
- `POST /device-licensing/replacements/:preparationId/recovery/close`.

Platform routes имеют тот же хвост под
`/platform/tenants/:tenantId/device-licensing`. Platform reader видит состояние,
но mutations требуют writer capabilities.

Device routes используют station trust domain и поддерживают kind
`station | handheld`:

- `GET /station/device-replacement-intent`;
- `POST /station/device-replacement-readiness`.

Все mutation body — строгие Zod-объекты с UUID `requestId`. Preview имеет digest,
server `asOf`, expiry и expected revisions. Unchanged retry возвращает прежний
receipt; изменённое тело под тем же request ID даёт domain conflict. Неверная
tenant/device/credential связь возвращает общий authorization error без утечки
существования чужого проекта.

Pairing-code body/response сохраняют текущую внешнюю форму. Внутренне код получает
purpose `normal | replacement_recovery`; normal code нельзя использовать для
исходного released device, recovery code — для target или нового owner.

## 10. Хранилище и события

Новые таблицы разделяют намерение, client report и исполнение:

- `working_device_replacement_readiness_intents` — один текущий intent на
  preparation/source, request identity, credential epoch, revisions и state;
- `working_device_replacement_readiness_reports` — append-only reports с payload
  digest, server received time, normalized counters и eligibility result;
- `working_device_replacement_executions` — уникальный execution на preparation,
  mode, target ID, recoverable step, offline boundary и recovery state;
- расширение pairing-code purpose и credential metadata для recovery.

Сырые секреты, pairing codes и API keys не сохраняются в этих таблицах. Payload
readiness ограничен по размеру, строгий и не содержит маркировочных кодов.
Tenant/device composite foreign keys обязательны. Уникальные request constraints
включают tenant и actor domain; один preparation создаёт не более одного target.

`working_device_events` получает действия `replacement_drain_requested`,
`replacement_ready`, `replacement_execution_started`,
`replacement_transferred`, `replacement_recovery_started`,
`replacement_recovery_completed` и `replacement_recovery_unavailable`.
События содержат точные before/after assignment projections, actor, request ID и
receipt. Client readiness report отдельно пишет ограниченный device audit без
секретов и сырых payload.

Все schema changes идут новыми forward migrations. Уже применённые миграции
0135–0156 не переписываются. Ограничения для существующих крупных таблиц
добавляются `NOT VALID` и валидируются последующей миграцией, если полная проверка
может удерживать блокировку.

## 11. Допуск и коммерческие инварианты

- `prepared` ничего не меняет в работе устройства.
- `draining` запрещает только новую производственную область; sync, close,
  recovery, чтение и выгрузка доказательств сохраняются.
- released source после transfer не занимает место.
- reserved target занимает ровно переданное место, поэтому usage не меняется.
- target до `newWorkAllowedAt` не получает новую производственную область или
  offline grant, даже если pairing завершён.
- security revoke всегда сильнее оплаченной лицензии и recovery credential.
- замена не меняет тариф, подписку, дополнения, счета, КП или цены.
- lifecycle policy не требуется для создания коммерческих сущностей. Для
  аварийной offline boundary используется только уже действующая policy; её
  отсутствие не блокирует продажу и не создаёт бессрочную власть.
- retention selection и replacement не могут назначить один slot двум активным
  operational authorities. Их writers используют общий quota/timeline lock order
  и повышают общий decision revision.

## 12. Интерфейс кабинета и SaaS

Карточка проекта показывает:

- исходное и целевое имя/kind;
- состояние проекта и время последнего достоверного отчёта;
- отдельные строки журналов, scan/inventory/closure outbox, labels/boxes,
  conflicts и unknown print;
- server-side активную работу;
- offline authority и безопасную границу;
- конкретные блокирующие причины и требуемое действие.

Доступные действия зависят от состояния: начать завершение, обновить, исполнить,
аварийно заменить, выпустить код подключения target, выпустить recovery code,
закрыть утрату данных. Аварийный dialog показывает рассчитанную сервером границу,
требует основание и явный checkbox. Он не использует скрытое force-поле.

После execution pairing code выпускается отдельным явным действием. При потере
ответа UI не предполагает, что код известен: предлагает выпустить новый, погасив
предыдущий. Неоднозначные execution/recovery ответы сохраняют request identity и
повторяют тот же запрос. Domain conflict обновляет факты и требует нового
подтверждения.

История различает обычную и аварийную замену, отображает actor/time/result и не
выдаёт `evidence_unavailable` за успешно синхронизированное состояние. Все тексты
есть на русском и английском, кнопки доступны с клавиатуры, статусы не кодируются
только цветом.

## 13. Совместимость и rollout

Старые Station/ТСД не получают intent, который они не умеют сохранить. Для них
обычный режим показывает `client_upgrade_required`; текущая работа не меняется.
Аварийный режим остаётся доступен с консервативной offline boundary. Ни один
tenant не получает drain или новое ограничение без созданного проекта замены.

Развёртывание выполняется в порядке:

1. совместимые DB migrations и API, принимающий старые клиенты;
2. Station и ТСД с durable intent/report/recovery;
3. web UI исполнения;
4. production smoke на тестовом tenant;
5. включение обычного исполнения только после подтверждения минимальных версий
   поддерживаемых клиентов.

Глобальный permissive fallback не вводится. Неизвестный recovery route закрыт.
При смешанном парке старые устройства продолжают прежнюю работу, пока оператор
не начнёт их замену.

## 14. Ошибки и восстановление

- Смена credential epoch, assignment, entitlement или target после preview даёт
  stale и требует нового preview.
- Потеря ответа readiness сохраняет локальный outbox и тот же request ID.
- Потеря ответа execution возобновляет `executing`; target не дублируется.
- Ошибка revoke оставляет source в drain, target отсутствует, repair повторяет
  revoke.
- Ошибка транзакции transfer после revoke оставляет source без новой работы;
  repair завершает перенос по durable execution intent.
- Потеря ответа pairing-code issuance решается новым кодом, без нового target.
- Recovery upload использует существующую per-record идемпотентность и
  quarantine. Один ошибочный record не удаляет остальные.
- Истёкший или повторно использованный recovery code не изменяет owner и данные.
- Клиентский clock не сокращает offline boundary и не доказывает готовность.

## 15. Проверяемая приёмка

1. Обычная Station и ТСД с пустыми очередями переходят `prepared → draining →
ready → executing → completed`; usage до и после одинаков.
2. Любой pending channel, active task, conflict, unknown print, установленный
   grant или unsupported storage блокирует обычное исполнение с точной причиной.
3. Restart Station/ТСД сохраняет drain и неподтверждённый report; новая работа не
   возобновляется.
4. Конкурентные execute, revoke, re-pair, retention selection, quota change и
   entitlement boundary дают один target и согласованный audit либо stale/conflict.
5. Потеря ответа на каждом шаге повторяется без второго устройства, места,
   credential, события или pairing code assumption.
6. Emergency отзывает cloud credential и создаёт target, но server и client
   блокируют новую работу до вычисленного `newWorkAllowedAt`.
7. Recovery code принимает только исходный owner, разрешает только перечисленные
   evidence routes и после drain отзывается; попытка создать новую работу
   запрещена.
8. Окончательная утрата носителя сохраняется как `evidence_unavailable`, не как
   нулевые очереди.
9. Cross-tenant, cabinet/device/platform separation, свежие capabilities и точные
   actor/target/result audit assertions проверены отрицательными тестами.
10. Старые клиенты и существующие prepared/cancelled rows продолжают читаться;
    без активной замены их admission и offline grants не меняются.
11. Контракты, OpenAPI и route inventories совпадают; DB/contracts/API/admin/SaaS,
    Station и Android gates проходят в требуемом порядке.
12. Локальная браузерная проверка покрывает оба кабинета, RU/EN, desktop/narrow,
    обычный и аварийный сценарий. Production smoke проверяет точный release SHA.

Автоматические проверки не доказывают работу на промышленном ТСД, Windows,
реальном сканере или принтере. Эти аппаратные проверки фиксируются отдельно и не
подменяются зелёным CI.
