# Восстановление вперёд после неудачной активации b793

Статус: проект для независимого review и утверждения владельцем. Реализация и production-действия по этому проекту не начаты.

## Задача и подтверждённое состояние

Вернуть работоспособность Markiro на выбранной версии 6e32b3bf5970ed8793293bcc7e80aef342836e53, затем продолжить первоначальную подготовку релизов. Данные текущего PostgreSQL сохраняются. Каталог запускается только с writers=false и закрытыми недоказанными namespaces.

Активация 40177697655 attempt1, executor 6aa96c08459b5144e18a7ed791b8b2f49091cf85, завершилась ошибкой 25 октября 2026 в 09:01:06Z. Фактический журнал b793db93-0e6b-4b1c-bb5e-5afc3a16230a: seq14/api-started/recovery-required/migrationEntered=true, SHA256 4d5d63263a61f00c5e118621c1cca35b767f0bbb57b01ad38831ffc6429de37c. API и edge старой версии остановлены; новых приложений и активных процессов операции не осталось. Lock отсутствует. Физический PostgreSQL 2f303834612d21cba2896342c69ea43fc1ef53ef7cb54d38c8653b19d0d667b3 здоров, system ID 7698396358009868314, 202 миграции вместо 197. Текущие schema/migration hashes сохранены в activation-40177697655-observation.json.

Исходный exception не сохранён: workflow сообщает generic delivery failure. Текущая canonical projection совпадает с утверждённой, exact Compose config проходит. Изолированно воспроизведён дефект внутреннего порядка freshness: cleanup observation снимается перед потенциально долгим writer-fence adapter и может устареть до финальной проверки. Это доказанный воспроизводимый механизм отказа, но не доказательство точного exception этого запуска.

## Не допускается

- Повторять 40177697655, его phase input, UUID или consumption.
- Запускать старые контейнеры после migration latch, откатывать SQL или восстанавливать старый dump поверх текущей БД.
- Редактировать старые журналы, admissions, конфигурации, bootstrap, backup runtimes, копии либо срок их действия.
- Запускать приложения вручную через SSH/Compose, обходить protected approval или использовать approved=true как замену реальному GitHub authorization.
- Увеличивать TTL 30 секунд, убирать role/TLS/config/source/cleanup/fence проверки или скрывать исходный отказ.
- Включать publishers, менять DNS, импортировать историю или выпускать клиентские версии до отдельного принятия восстановленной платформы.

## Предложенное ограниченное расширение

Добавить в существующий protected upgrade workflow две отдельные фазы: post-migration-prepare и post-migration-activate. Каждая — новый run attempt1, main-only, exact executor/CI/product artifact, прежняя production concurrency group и distinct second-account approval. Новый UUID выбирается один раз только после утверждения проекта и проверок main.

Новая immutable admission имеет отдельный вид forward-recovery. Она привязана к точным байтам и полной canonical chain неудачной b793, включая before-activate, prepare/activate consumptions, оба исходных phase inputs и исходный dispatch/approval. Дополнительно сохраняются прежние пять authorities, цепочка accepted recovery и архивированный returned-old082e. Старые per-operation деревья и все данные остаются на месте.

Новая admission допускает только terminal recovery-required после миграции, точно наблюдаемый post-migration schema/migration digest и физическую БД, полное отсутствие активных старых/новых приложений, migrator, probes и phase processes. Неизвестное состояние или неподтверждённое завершение запрещает продолжение. Добавить отдельный read-only verifier полного упорядоченного набора migration hashes/timestamps против точного accepted product source/artifact closure. Текущий upgrade-schema.mjs только хеширует наблюдаемый ledger и считает строки, поэтому не заменяет эту новую проверку. Повторять полное сравнение на protected boundaries; число строк или переданный оператором digest недостаточны. Однократная read-only сверка после отказа уже подтвердила точное совпадение всех 202 записей с SQL hashes/timestamps Git 6e32; она не заменяет повторные runtime checks. Если ledger либо schema изменятся, admission недействительна; требуется новое расследование, а не автоматическое принятие новых хешей.

Только target-wide ownership index переводится на новую операцию через canonical общий lock/guardPersistence. До rename создаётся durable intent; старый index сохраняется renameat2(RENAME_NOREPLACE), fsync обоих родителей, полная проверка байтов/dev/inode/uid/gid/mode/size/mtime и запись нового ctime, затем durable success receipt. Исторические state/phase/worker деревья не перемещаются. Любая неопределённость durability сохраняет lock и запрещает follow-up. Формат нового index/journal должен однозначно различать forward-recovery и обычный upgrade; никакой перепривязки старого journal к новому executor.

### Post-migration prepare

Перед первым dispatch: исправление, точные PR/main CI и независимый review; изолированная репетиция именно отказа после миграции и восстановления вперёд; новый source closure/worker provenance; текущий source/PG/schema/container/process/disk/config/IAM inventory.

После отдельного approval: новый журнал с migrationEntered=true с самого начала; проверка точных baseline hashes и отсутствия всех writers. Существующий withUpgradeBackupRuntime отвергает migrationEntered=true и остаётся неизменным. Для новой фазы нужен отдельный типизированный post-migration capability, выдаваемый только под общим lock и привязанный к новой admission, точному immutable failed predecessor, физической БД, текущим schema/ledger и доказанному отсутствию writers. Создаётся новый operation-specific runtime descriptor; старые descriptors не редактируются. Через этот capability переиспользуются внутренние dump/restore/copy модули: свежий dump текущей уже мигрированной БД, inventory с release-catalog rows/local journal, полный изолированный restore с 10 проверками и подтверждённой очисткой. Прежние pre-migration admissions, preparation и observation guards не ослабляются; новая ветка имеет отдельные проверки. Старые backup/copies b793 остаются историческими. Если pipeline не может доказать текущую структуру/ACL, prepare падает, без урезанного backup.

Затем создаются новые encrypted Mac и Timeweb дочерние копии без перезаписи; полная authenticated decrypt/hash проверка, exact VersionId/full GET/private ACL/versioning. Recovery key не загружается. Свежие actual key-continuity probe, PG/TLS/roles, retained-intent projection и source hold привязываются к новой операции и новому backup. API/edge всё время остановлены.

### Post-migration activate

Новый protected run и immutable phase admission привязаны к точному подготовленному forward-recovery state. Входы готовы и независимо прочитаны до запроса второго аккаунта.

До каждого старта повторяются исходные authorities/source/config/image/physical PG/schema/migration ledger/backup/copies/keys/fence/projection/approval checks. Target остаётся строго той же physical database, продукт — 6e32 и ранее принятые API/edge digests. Эта фаза НИКОГДА не запускает migrator и не пишет SQL migrations. Canonical проверка полного ledger должна доказать, что все migrations выбранного product уже применены в точности, без неизвестных/частичных записей.

Запускать только candidate API, затем candidate edge через штатные exact Compose files/проверенные environment. PostgreSQL никогда не является целью замены. До старта сохранить точные metadata старых API/edge и image evidence. В фиксированном Compose project markiro-platform штатный up заменит остановленные старые API/edge и может удалить эти два старых контейнера. Прямые команды start/stop/rm по их IDs запрещены; прежние журналы/metadata/images/configs сохраняются, восстановление старых контейнеров не обещается. Это ограниченное замещение является частью запрашиваемого утверждения. Не пересоздавать PG. Новые приложения должны иметь новые ID, точные image/config/env/mount/network/UID/ports; platform-only profile, catalog writers=false, publishers empty. Сохранить полный schema/source/operation terminal evidence и выполнить независимые strict TLS/admin/API checks до приёмки.

При отказе убрать только точно наблюдаемые собственные probe resources и остановить только собственные candidate workloads; неизвестный исход сохраняет lock. Cleanup не должен адресовать retained old IDs, PostgreSQL или архивы; допустимо только описанное выше штатное Compose-замещение приложений в рамках утверждённой попытки forward start, включая случай последующего отказа проверки запуска; возврат старых контейнеров не выполняется. Повтор и новый run автоматически не создаются. Последующая попытка требует нового явно рассмотренного terminal predecessor.

## Freshness и диагностика

Исправить воспроизведённый внутренний порядок без изменения 30-секундного контракта. Сохранить раннюю проверку отсутствия restore resources; после долгого writer-fence/probe adapter повторно измерить и полностью проверить cleanup. Финальный синхронный recheck проверяет возраст ОБОИХ последних фактических observations. Если повторное cleanup измерение успело состарить fence, отказ сохраняется. Changed/missing resources, future timestamps, wrong producer/identity или stale observations по-прежнему отвергаются. Не подставлять Date.now вместо времени реального измерения и не добавлять blind retry.

До новой production delivery добавить bounded приватный diagnostic record для первого исходного исключения до cleanup, сохраняя терминальный отказ при ошибке записи. Публичный вывод только code/category/phase/boundary, basename/числовой exit status при наличии, terminationConfirmed/durabilityUncertain. argv/stdout/stderr/env/credentials не выводить и не загружать в GitHub artifacts. Не выполнять старую activation ради получения более подробного лога.

## Проверки реализации

1. RED/GREEN регрессии: медленный writer fence при свежих final facts; foreign cleanup, stale final cleanup/fence, expiry во время последнего observe, неверные exact resource bindings, поздний spawn. Все прежние rejection tests сохраняются.
2. Admission/state/store/transport tests: новый тип и phases, exact failed-chain/index guards, consumption once, new protected run approval, current product vs executor distinction, запрет старого возврата/SQL restore/migrator, crash/fsync ambiguity.
3. Реальная изолированная репетиция: применить candidate migrations на generated data, вызвать отказ перед API start, сохранить failed journal, пройти новую подготовку/dump/restore и forward start на той же изолированной PG; доказать отсутствие второго migrator и старых starts. Отдельно отказ/cleanup/termination и оба конца boundaries. Никакого production network/customer data.
4. Проверить весь PR three-dot diff, scoped lint/format и affected platform/backup/production contract suites, exact PR CI+CodeQL/review, merge и exact main CI. CI rehearsal и production acceptance остаются разными доказательствами.
5. Только после новых approvals — actual prepare, свежие копии и отдельная actual activation с независимым readback. DNS/TLS каталога, история, writer epoch и релизы остаются следующими самостоятельными gates.

## Решения владельца и предложенные оператором

Владелец уже разрешил необходимые scoped fixes и protected deployments, хранение проверенных Mac/Timeweb copies и начало обслуживания по готовности. Утверждённый прежний план не содержит post-migration recovery и явно запрещает старый return после latch; поэтому это расширение требуется утвердить до реализации.

Предложение оператора: сохранить уже мигрированную БД, восстановить вперёд на том же принятом продукте; без SQL rollback/restore-overwrite, без повторной миграции, без старта старых приложений. Окно обслуживания продолжается до фактически проверенного healthy. Срок пока не обещается: требуются реализация, review/CI и отдельные два protected approvals.

Независимый builder review выявил и потребовал явно включить три пункта: допустимое штатное замещение остановленных API/edge, отдельный guarded backup capability после миграции и новый exact product-ledger verifier. Эти уточнения включены; других решений владельца, кроме утверждения полного forward-only проекта с этим ограниченным замещением, review не потребовал.
