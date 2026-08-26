# Station beta release runbook

Ручная публикация Windows-бета-версии Station. Автоматическая установка на
станциях не выполняется: оператор сам запускает установщик после проверки окна
смены и состояния outbox.

Принятую beta можно продвинуть в отдельный stable-канал только по процедуре
[Station stable release](station-stable-release.md). Beta, выпущенная до
внедрения stable tooling/overlay, для первого stable не подходит.

## Порядок rollout контракта шаблона короба

Новый контракт разворачивается только в таком порядке:

1. До миграции соберите tenant-scoped inventory количества шаблонов и всех
   planned/active aggregation-смен с пустым `box_label_template_id`. Отдельно
   зафиксируйте организации с нулём и несколькими шаблонами: они требуют
   административного решения и не должны попасть под автоматический выбор.
2. Примените миграцию базы данных, добавляющую
   `org_profiles.default_box_label_template_id`. Автоматический backfill
   выполняется только для организации, у которой ровно один tenant-owned
   шаблон: он становится default и snapshot для planned/active
   aggregation-смен с пустым binding. При нуле или нескольких шаблонах
   миграция намеренно оставляет default и смены без изменений; она никогда не
   выбирает один из нескольких шаблонов. До продолжения проверьте журнал
   миграций, новую tenant-scoped ссылку и результаты относительно inventory.
3. Разверните API, который понимает организационный default, требует
   эффективный шаблон для агрегации и сохраняет его snapshot в смене. API
   должен продолжать отдавать переходные item-label поля bundle явными
   `null`, чтобы установленная предыдущая beta могла прочитать ответ.
4. После API rollout новый Admin можно открыть уполномоченному администратору
   для remediation, но Station recovery ещё остаётся выключенным. Для каждой
   организации из списка с нулём или несколькими шаблонами явно
   создайте/выберите tenant-owned шаблон и задайте его как организационный
   default. Затем заполните тем же выбранным шаблоном пустой snapshot каждой
   затронутой planned/active aggregation-смены, не меняя уже заданные binding.
   Planned-смену можно исправить через поддерживаемое административное
   редактирование. Active-смена не редактируется обычным shift API: для неё
   требуется отдельно согласованная tenant-scoped data-remediation владельцем
   БД с inventory/dry-run, резервной копией, reviewed SQL, транзакцией,
   журналом изменения и post-check. Не пытайтесь повторно запускать
   применённую миграцию или выбирать шаблон автоматически.
5. Установку новой Station beta и Station recovery разрешайте для организации
   только после того, как задан её default, выполнена необходимая remediation
   и post-check подтвердил отсутствие пустых snapshot у её planned/active
   aggregation-смен. До этого Station не должна создавать или восстанавливать
   смену через новый контракт.

При rollback откатывайте приложения в обратном порядке, но не удаляйте
`org_profiles.default_box_label_template_id` и не удаляйте или не
переиспользуйте deprecated compatibility columns
`products.default_label_template_id` и `shifts.label_template_id`, пока хотя
бы одна поддерживаемая beta может отправлять или читать переходный bundle.
Сохраняйте явные `null` legacy-поля в bundle на всём beta-горизонте. Удаление
колонок выполняется только отдельной миграцией после закрытия updater/очередей
всех совместимых beta; rollback приложения сам по себе не является
разрешением на schema rollback.

## Обязательный порядок beta-релиза

Не запускайте workflow и не устанавливайте beta, пока не выполнен предыдущий
пункт. Успешная CI-сборка не заменяет live preflight или ручную проверку на
Windows.

1. В production runtime secret должно быть точное значение
   `STATION_ORIGIN=http://tauri.localhost`. Создайте новую версию секрета по
   процедуре [Yandex secrets](yandex-secrets.md), сохранив все существующие
   ключи; не печатайте и не переносите их в терминал, issue или release notes.
   Материализуйте эту версию через штатный deployment workflow.
2. На уже применённой production-конфигурации выполните live preflight:

   ```bash
   pnpm verify:station-production-cors
   ```

   Продолжать можно только при успешном результате. Проверка посылает точный
   Windows origin к `https://admin.markiro.app/station/pair`; её нельзя заменить
   browser/CI-проверкой или предположением о значении секрета.

3. Только после preflight запустите `Publish station beta` из `main` для
   проверенного commit SHA. Workflow собирает Windows installer; при `publish`
   или `promote-existing` он сам повторяет live preflight до продвижения
   immutable release или канала.
4. Проверьте опубликованные immutable installer, `SHA256SUMS`, updater bundle,
   подпись, `latest.json` и commit digest. Лишь затем допускается скачивание
   пакета на станцию.
5. Установите пакет вручную на целевую Windows-станцию и зафиксируйте результаты
   из [dual-origin acceptance record](../acceptance/station-dual-origin-release.md)
   и `docs/hardware-acceptance-checklist.md`: иконки, production pairing,
   touch/keyboard/scanner input, viewport и fullscreen. Это отдельное
   acceptance; workflow не закрывает эти пункты.
   Для beta с агрегацией и восстановлением печати отдельно выполните
   весь раздел `Aggregation and box-label recovery (next Station beta)`:
   новый issuer prefix с первым serial `0000001`, реальные EAN-13/KM,
   короб на 20 мест, отказ принтера с перезапуском, повторную печать того же
   SSCC, явный пропуск этикетки и scan-back GS1-128 на packaged Windows в 1280×800 и
   1024×768. До реального прогона все эти пункты остаются
   неотмеченными.
   Для beta с default шаблоном короба также выполните новые пункты этого
   раздела: Station-created смена с организационным default, явный per-shift
   override, validation без шаблона, конфликт удаления настроенного default,
   offline-blocked recovery и upgrade ранее затронутой активной смены. Для
   backfill используйте отдельного legacy-тенанта, у которого до миграции ровно
   один шаблон; не используйте tenant из проверки override A/B. В последнем
   случае на реальном принтере должен напечататься тот же короб и SSCC после
   backfill без повторного закрытия или allocation.

## Перед запуском

- Workflow `Publish station beta` запускается только из `main` после успешного
  CI для того же commit SHA. API production-сборки фиксирован:
  `https://admin.markiro.app`.
- Environment `station-beta` содержит только
  `TAURI_SIGNING_PRIVATE_KEY` и `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Приватный
  ключ хранится в зашифрованном офлайн-резерве; его нельзя печатать в логи,
  коммитить или копировать на станцию. Значение private key храните в исходном
  base64-формате, который выдаёт `tauri signer generate`, байт-в-байт: не
  декодируйте, не перекодируйте и не нормализуйте его.
- Отдельный Environment `station-release` разрешён только для ветки `main` и
  содержит точный инвентарь:
  secret `STATION_RELEASE_REPOSITORY_TOKEN`, ограниченный только публичным
  binary-only репозиторием `thevladbog/markiro-station-releases` и правом
  Contents read/write, secrets `YANDEX_STATION_RELEASE_ACCESS_KEY_ID` и
  `YANDEX_STATION_RELEASE_SECRET_ACCESS_KEY`, variables
  `YANDEX_STATION_RELEASE_BUCKET` и `YANDEX_STATION_RELEASE_ENDPOINT` со
  значением `https://storage.yandexcloud.net`. Не переносите signing secrets в
  `station-release`, а publisher credentials — в `station-beta`, job-wide env,
  аргументы, логи или artifacts. Обычный `${{ github.token }}` используется
  только для CI и сохранения source tag в приватном `thevladbog/markiro`; он не
  публикует бинарные releases.
- На текущем GitHub plan нативные required reviewers недоступны для private
  repository. Поэтому до build/sign и до доступа к `station-release` workflow
  запускает отдельный job без Environment и secrets: владелец репозитория должен
  передать `owner_confirmation=PUBLISH-STATION-BETA`, а `github.actor` должен
  точно совпасть с `github.repository_owner`. Это одно-владельческое ручное
  подтверждение, а не двухпользовательский approval; нативный reviewer потребует
  подходящего GitHub Enterprise plan.
- `STATION_ORIGIN` — production runtime secret, а не signing secret environment:
  перед beta он обязан быть равен `http://tauri.localhost`. Значение
  `tauri://localhost` не является Windows origin для этой сборки.
- Публичный ключ зашит в Tauri-конфигурацию. Потеря приватного ключа или пароля
  останавливает обновления; ротация выполняется через bridge-релиз.

## Публикация и повторное продвижение

Phase 3 требует двух отдельных normal publications. Первый dispatch создаёт
bootstrap beta — первый build с fixed dual-origin adapter. До него уже должен
быть принят Phase 2 pre-transition rollback baseline. После bootstrap
publication заполните bounded `BOOTSTRAP_READY`: оба migration path,
application/SQLite/pairing/settings/journals/boxes/exceptions/outbox preservation
и basic Windows/WebView2/scanner/printer operation. Только bootstrap Overall
`PASS` разрешает второй dispatch.

Второй dispatch создаёт validation/candidate beta, canonical version которой
строго больше bootstrap beta. Именно этот exact candidate упражняет beta → beta
primary/fallback/no-update/integrity/rollback сценарии `BETA_SIGN_OFF`; его tag,
`baseSha`, `releaseSha` и оба origin evidence hashes после Overall `PASS`
становятся единственным разрешённым source для первого stable. Не используйте
bootstrap beta или более новый найденный release как замену.

Для новой версии выберите `mode=publish` и `next-beta`, `next-patch-beta`,
`next-minor-beta` или `next-major-beta`. Обычная публикация разрешена только при
существующей полной паре Yandex mutable objects: `station/beta/latest.json` и
`station/beta/download`. Если отсутствует один или оба объекта либо metadata
alias не указывает на канонический immutable installer того же beta-канала,
workflow отказывает до первой channel mutation. GitHub
`station-beta-channel/latest.json` также обязан существовать и скачиваться в
полную резервную копию; workflow больше не создаёт пустой channel автоматически.

Workflow собирает и подписывает NSIS ровно один раз, затем из одного общего
набора строит строгие GitHub и Yandex trees. Он локально валидирует обе trees и
их common assets, публикует immutable GitHub release, затем только отсутствующий
immutable Yandex prefix, скачивает оба публичных origin в новые каталоги и
повторяет validation/comparison. Только после этого создаются все три backup и
mutable targets продвигаются в строгом порядке:

1. GitHub `station-beta-channel/latest.json`;
2. Yandex `station/beta/latest.json`;
3. Yandex `station/beta/download` — всегда последним, server-side copy из
   проверенного immutable installer.

Единый transaction trap при ошибке восстанавливает изменённые targets в
обратном порядке: Yandex alias, Yandex manifest, затем GitHub manifest. Каждое
восстановление читается публично и сравнивается с backup. Ошибка проверки
restoration — отдельный жёсткий отказ; immutable release или object при этом не
удаляется и не перезаписывается.

Если immutable release опубликован, но канал не обновился, запустите
`mode=promote-existing` и обязательно передайте точный canonical `repair_tag`
вида `station-vX.Y.Z-beta.N`. Workflow не ищет newest/latest release: он
запрашивает именно этот опубликованный non-draft prerelease, проверяет, что его
target SHA принадлежит публичному binary-only repository, а source `releaseSha`
берёт из evidence и приватного source tag, затем скачивает обе уже существующие public immutable
trees в новые каталоги, валидирует их и сравнивает common assets. Пустой или
неканонический `repair_tag` запрещён для `promote-existing`; непустой
`repair_tag` запрещён для `publish` и `seed-baseline`.

Режим `promote-existing` не пересобирает и не подписывает пакет, не создаёт
версию и не загружает никакой immutable object. После validation он требует полные
временные mutable backup и повторяет только описанную promotion transaction.
Backup существует для compensation внутри run и не является долговечным
workflow artifact после успешного завершения.

### Одноразовый beta baseline

`mode=seed-baseline` — отдельный защищённый одноразовый режим только для нового
strict dual-origin pre-transition beta. Нельзя retrofit или переупаковать старую
legacy beta с GitHub-only evidence: workflow обязан собрать и подписать новую
версию, опубликовать и повторно скачать её strict GitHub tree. Затем
`prepare-seed-immutable` требует либо полностью пустой Yandex immutable prefix,
либо уже полный exact prefix безопасного повтора: в первом случае условно
загружает все объекты, во втором ничего не пишет, а mixed/partial prefix
отклоняет. До первой mutable backup или write workflow публично скачивает обе
immutable trees в новые каталоги, валидирует их и сравнивает common assets.
Yandex tree в seed читается через фиксированный provider host
`https://storage.yandexcloud.net`, не через ещё выключенный release DNS.
Оператор передаёт точный JSON evidence отдельно одобренного и применённого
инфраструктурного plan, в котором
`enableStationReleasePublicDns` равно `false`; значение `true`, лишнее поле или
неверные SHA/VersionId останавливают команду. Workflow не включает DNS и не
принимает boolean default вместо evidence.

Protected publisher вызывает точный gate `--confirm-empty-channel-bootstrap`.
Только после dual-origin immutable proof workflow подтверждает отсутствие
`station-beta-channel` в новом публичном repository и read-only preflight
проверяет, что Yandex mutable pair полностью
пуста либо уже является полной byte-identical provider-verified pair безопасного
повтора; частичная или чужая pair запрещена. Затем workflow создаёт GitHub
channel release с manifest первым и передаёт скачанный public GitHub source в Task 5
`seed-baseline`, который повторяет preflight для защиты от race, создаёт Yandex
manifest и beta alias и при первой ошибке повторно применяет и проверяет полную
known-good pair. Общий trap удаляет только что созданный GitHub channel release,
если Task 5 сообщает ошибку. Bootstrap record и закрытый recovery backup сохраняются
отдельным workflow artifact. Release DNS остаётся выключенным до отдельного
STOP/plan/apply из
[bootstrap runbook](station-release-origin-bootstrap.md).

### Partial-origin recovery

Если версия есть только в одном immutable origin, содержит несовпадающие bytes
или один public origin не проходит validation, не запускайте
`promote-existing`, не копируйте surviving tree поверх второго origin и не
перезаписывайте существующий tag/key. Это partial-origin incident: сохраните
immutable evidence, проверьте audit/versioning и выпустите новую явно
авторизованную beta после исправления причины. `seed-baseline` применяется
только для первоначального DNS-disabled baseline и не является общим repair
режимом. Если обе immutable trees валидны, а сбой затронул только mutable
targets, используйте `promote-existing`.

## Установка на станции

Канонический URL обычной установки — stable alias
`https://releases.markiro.app/station/download`. Beta никогда не выбирается по
cookie, query или referrer и доступна только по явному URL
`https://releases.markiro.app/station/beta/download`.

Установленные старые GitHub-only клиенты не узнают новый origin от изменения на
сервере, а их прежний endpoint находится в теперь приватном source repository.
Поэтому автоматический переход через existing updater больше не считается
доступным. Для GitHub-reachable станции скачайте точный bootstrap beta installer
из публичного binary-only repository `thevladbog/markiro-station-releases`; в
restricted network, где GitHub заблокирован, используйте проверенный явный
Yandex beta URL. В обоих случаях выполните ручной install-over поверх
существующей установки и отдельно зафиксируйте путь доставки. Лишь после
`BOOTSTRAP_READY` установите строго более новую validation/candidate beta через
новый dual-origin adapter и выполните beta → beta acceptance.

До и после install-over зафиксируйте application ID `app.markiro.station`,
фактический абсолютный путь к SQLite и относительное имя
`sqlite:station-mirror.db`, Station identity, pairing, hardware settings,
журналы, короба, исключения и pending outbox. Путь берите из реально
установленной Windows Station, не восстанавливайте его по предположению о
профиле пользователя. Удаление или создание новой SQLite/outbox не является
migration или recovery.

Центр обновлений работает вручную (manual-only). Он подсвечивает релиз старше 7 дней
(срочно — старше 30), но не начинает действие без подтверждения оператора.
После подтверждения он скачивает подписанный пакет, устанавливает его и
перезапускает приложение; в фоне этого не происходит. При активной смене
установка заблокирована, но проверка обновлений и production work — сканирование,
печать, журнал, короба, исключения и outbox — не должны блокироваться. Перед
установкой убедитесь, что pending outbox синхронизирован либо зафиксирован по
процедуре восстановления смены; обновление не удаляет очередь.

Скачайте `*.exe` из immutable release и сравните его SHA-256 с записью в
`SHA256SUMS`. Для updater bundle отдельно проверьте подпись и соответствие
`latest.json`, затем запустите установщик вручную. SmartScreen может показать
предупреждение для новой неподписанной или ещё не имеющей репутации сборки.
Не обходите его вслепую: при расхождении отмените установку и сообщите release
owner. NSIS не имеет Authenticode: Tauri signature защищает updater bundle, но
не делает Windows installer Authenticode-signed. Тихой автоматической установки
нет.

До допуска beta к смене отметьте ручные результаты в hardware checklist: у
installer, taskbar и окна — новые Markiro icons (без старого белого круга);
pairing выполнен настоящим кодом из `admin.markiro.app`; touch keypad,
физическая клавиатура и scanner вводят данные; 1280×800 не имеет scroll/clip;
fullscreen выходит и возвращается обратно. При активной смене выход из
fullscreen требует явного подтверждения; после отмены, выхода и повторного
входа состояние смены и очередь не должны теряться.

Для проверки обновления иконки обязательно выполните Windows upgrade smoke на
реальных артефактах workflow `Publish station beta`. Сначала установите
предыдущий immutable `*.exe`, созданный шагом
`Build signed Windows NSIS updater artifacts`, и закрепите ярлык в taskbar.
Затем обновитесь через центр обновлений до следующей beta, собранной тем же
NSIS-шагом. После перезапуска проверьте установленную версию и отдельно иконки
ярлыка на рабочем столе, в меню «Пуск» и в taskbar: на всех трёх поверхностях
должен быть новый знак Markiro, а закэшированная иконка предыдущей beta должна
исчезнуть. Запишите обе версии, Windows build, workflow URL и скриншоты в
hardware checklist. Headless CI не заменяет эту проверку Windows Shell.

## Откат и ротация ключа

Если обе immutable trees валидны и совпадают, а сбой затронул только mutable
targets, используйте `mode=promote-existing` с exact `repair_tag`; он повторяет
backup/promotion без rebuild, signing или immutable upload. Transaction rollback
идёт в точном обратном порядке: Yandex alias, Yandex manifest, GitHub manifest,
с публичной проверкой каждого временного backup. При partial-origin mismatch
`promote-existing` запрещён: остановитесь, сохраните evidence и выпускайте новую
явно авторизованную beta.

Для отдельной post-success acceptance-проверки rollback возьмите точные
`BOOTSTRAP_BETA_TAG` и `VALIDATION_BETA_TAG` из двух заполненных identity tables.
До dispatch повторно проверьте обе immutable trees, target SHA и evidence hashes
для обеих beta. Сначала верните channel на bootstrap predecessor:

```bash
gh workflow run station-beta-release.yml --ref main \
  -f mode=promote-existing \
  -f owner_confirmation=PUBLISH-STATION-BETA \
  -f repair_tag="$BOOTSTRAP_BETA_TAG"
```

Protected run сначала создаёт полные временные backup текущих mutable targets,
затем продвигает GitHub manifest, Yandex manifest и beta alias последним. После
успеха публично скачайте оба channel manifest и
`https://releases.markiro.app/station/beta/download`, сравните их с выбранной
bootstrap immutable beta и сохраните workflow URL/evidence hash как
`BETA-ROLLBACK-01`. Затем немедленно восстановите exact candidate:

```bash
gh workflow run station-beta-release.yml --ref main \
  -f mode=promote-existing \
  -f owner_confirmation=PUBLISH-STATION-BETA \
  -f repair_tag="$VALIDATION_BETA_TAG"
```

После второго успешного run снова публично скачайте оба manifests и beta alias,
сравните их с validation/candidate immutable trees и сохраните отдельные
candidate-restoration workflow/evidence как `BETA-ROLLBACK-02`. Не записывайте
вымышленный durable backup path: каждый успешный run очищает временный backup.
При любом mismatch остановитесь; не overwrite/cross-copy immutable tree.

Если восстановление candidate или финальный read-back не прошли, установите beta
Overall `FAIL`, остановитесь для incident recovery и не оставляйте channel в
rollback, одновременно отмечая acceptance `PASS`. Overall может стать `PASS`
только когда exact validation/candidate beta снова подтверждена обоими channel
manifest и alias.

Для client rollback вручную установите предыдущий совместимый immutable
installer вне активной смены. Mutable channel является только указателем, а не
архивом; возврат pointer не делает автоматический downgrade уже обновлённой
Station. Не удаляйте SQLite, pairing/settings, журналы, короба, исключения или
outbox. При ротации сначала выпустите
bridge-релиз, подписанный старым ключом и принимающий новый публичный ключ, и
только после горизонта старых очередей переключайте secret и Tauri public key.
