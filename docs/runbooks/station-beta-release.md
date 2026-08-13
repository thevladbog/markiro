# Station beta release runbook

Ручная публикация Windows-бета-версии Station. Автоматическая установка на
станциях не выполняется: оператор сам запускает установщик после проверки окна
смены и состояния outbox.

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
   из `docs/hardware-acceptance-checklist.md`: иконки, production pairing,
   touch/keyboard/scanner input, viewport и fullscreen. Это отдельное
   acceptance; workflow не закрывает эти пункты.
   Для beta с агрегацией и восстановлением печати отдельно выполните
   весь раздел `Aggregation and box-label recovery (next Station beta)`:
   новый issuer prefix с первым serial `0000001`, реальные EAN-13/KM,
   короб на 20 мест, отказ принтера с перезапуском, повторную печать того же
   SSCC, явный пропуск этикетки и scan-back GS1-128 на packaged Windows в 1280×800 и
   1024×768. До реального прогона все эти пункты остаются
   неотмеченными.

## Перед запуском

- Workflow `Publish station beta` запускается только из `main` после успешного
  CI для того же commit SHA. API production-сборки фиксирован:
  `https://admin.markiro.app`.
- Environment `station-beta` содержит только
  `TAURI_SIGNING_PRIVATE_KEY` и `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Приватный
  ключ хранится в зашифрованном офлайн-резерве; его нельзя печатать в логи,
  коммитить или копировать на станцию.
- `STATION_ORIGIN` — production runtime secret, а не signing secret environment:
  перед beta он обязан быть равен `http://tauri.localhost`. Значение
  `tauri://localhost` не является Windows origin для этой сборки.
- Публичный ключ зашит в Tauri-конфигурацию. Потеря приватного ключа или пароля
  останавливает обновления; ротация выполняется через bridge-релиз.

## Публикация и повторное продвижение

Для новой версии выберите `mode=publish` и `next-beta`, `next-patch-beta` или
`next-minor-beta`. Workflow собирает подписанный NSIS-пакет, проверяет
`latest.json`, SHA-256, подпись и commit digest, затем публикует immutable
`station-v…-beta.N` и обновляет mutable `station-beta-channel/latest.json`.

Если immutable release опубликован, но канал не обновился, запустите
`mode=promote-existing`. Этот режим не пересобирает пакет и не создаёт новую
версию: скачивает опубликованные файлы, валидирует их и заменяет только
указатель канала. При ошибке предыдущий `latest.json` восстанавливается, если
он существовал.

## Установка на станции

Центр обновлений работает вручную. Он подсвечивает релиз старше 7 дней
(срочно — старше 30), но не начинает действие без подтверждения оператора.
После подтверждения он скачивает подписанный пакет, устанавливает его и
перезапускает приложение; в фоне этого не происходит. При активной смене
установка заблокирована. Перед установкой убедитесь, что pending outbox синхронизирован либо
зафиксирован по процедуре восстановления смены; обновление не удаляет очередь.

Скачайте `*.exe` из immutable release и сравните его SHA-256 с записью в
`SHA256SUMS`. Для updater bundle отдельно проверьте подпись и соответствие
`latest.json`, затем запустите установщик вручную. SmartScreen может показать
предупреждение для новой неподписанной или ещё не имеющей репутации сборки.
Не обходите его вслепую: при расхождении отмените установку и сообщите release
owner. Тихой автоматической установки нет.

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

Для отката вручную установите предыдущий immutable installer. Mutable channel
является только указателем, а не архивом; старый `latest.json` восстанавливается
через `promote-existing`/GitHub release upload. При ротации сначала выпустите
bridge-релиз, подписанный старым ключом и принимающий новый публичный ключ, и
только после горизонта старых очередей переключайте secret и Tauri public key.
