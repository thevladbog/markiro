# Station stable release runbook

Ручной выпуск Windows x64 stable-версии Markiro Station из одной явно принятой
beta. Workflow не выбирает «последнюю beta», не добавляет более новые изменения
из `main` и не устанавливает обновление на станции автоматически.

## Однократная настройка

1. Создайте GitHub Environment `station-stable` без required reviewers. Он
   сохраняет отдельную историю stable deployment, но не требует второго
   пользователя для запуска.
2. Добавьте в environment секреты `TAURI_SIGNING_PRIVATE_KEY` и
   `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, используя ту же пару ключей, что у
   beta-канала. Не печатайте, не скачивайте и не сравнивайте значения через
   логи или терминал. Публичный ключ остаётся в Tauri-конфигурации.
3. Убедитесь, что production API принимает Windows origin
   `http://tauri.localhost`, и выполните `pnpm verify:station-production-cors`.

## Первый stable после внедрения workflow

Сначала смержите stable tooling, затем выпустите новую beta из этого baseline.
Beta, чей `baseSha` предшествует файлам stable overlay/workflow, не допускается
к promotion. На новой beta выполните Windows/hardware checklist либо явно
примите оставшиеся ограничения; CI не доказывает работу сканера, принтера,
WebView2, touch, SmartScreen и сохранение локальных данных.

## Публикация

1. Откройте workflow `Publish station stable` только на ветке `main`.
2. Выберите `mode=publish`.
3. В `source_beta_tag` укажите точный принятый immutable tag, например
   `station-v1.0.0-beta.5`. Workflow никогда не подставляет newest beta.
4. Установите `acceptance_confirmed=true`. Это утверждение владельца релиза о
   принятии beta и известных ограничений, а не автоматически полученное
   доказательство hardware acceptance.
5. При необходимости добавьте короткие русские `highlights`; поле необязательно.
6. Workflow проверит release flags, все beta assets и хеши, evidence,
   `baseSha`, release-only diff и успешный CI ровно для `baseSha`. Stable
   пересобирается из этого source с `tauri.stable.conf.json`, а не из текущего
   более нового `main`.
7. Сначала публикуется обычный immutable release `station-vX.Y.Z`. Только после
   повторного скачивания и проверки всех файлов обновляется prerelease service
   release `station-stable-channel` и его `latest.json`:
   `https://github.com/thevladbog/markiro/releases/download/station-stable-channel/latest.json`.

После запуска проверьте, что versioned release не Draft и не Pre-release, tag
указывает на `releaseSha`, а комплект содержит NSIS installer, updater bundle,
signature, `latest.json`, `SHA256SUMS`, `release-notes.md` и
`release-evidence.json`. Сверьте `sourceBetaTag`, beta evidence digest,
`baseSha`, `releaseSha`, compare URL и SHA-256. Manifest stable-channel должен
байт-в-байт совпадать с `latest.json` immutable release.

## Восстановление channel promotion

Если immutable stable опубликован, но channel не обновился, повторите workflow
с тем же `source_beta_tag`, `acceptance_confirmed=true` и
`mode=promote-existing`. Режим заново проверяет beta и существующий normal
stable release, ничего не пересобирает и не изменяет versioned tag/assets. Он
заменяет только `station-stable-channel/latest.json`; при ошибке предыдущий
manifest восстанавливается. Не используйте этот режим для выбора более старого
stable или для обхода неуспешной публикации.

## Установка beta → stable и stable → stable

Переход с beta выполняется вручную immutable NSIS installer поверх текущей
Station и только вне активной смены. Перед установкой зафиксируйте состояние
pairing, SQLite, scanner/printer settings, scan journal, boxes, exceptions и
pending outbox. После перезапуска убедитесь, что эти данные сохранились и клиент
проверяет только stable channel.

Stable updater остаётся manual-only: разрешена проверка наличия версии, но нет
фоновой загрузки, установки, restart или блокировки линии. Установка во время
активной смены запрещена. Для stable → stable повторите проверку сохранности
данных, offline/reconnect и outbox.

## SmartScreen, откат и границы доказательства

Первая версия не имеет Authenticode. Tauri updater signature защищает
целостность updater bundle, но Windows может показать SmartScreen или
«неизвестный издатель». Сверьте SHA-256 и release provenance до ручного
подтверждения; не учите оператора обходить предупреждение вслепую.

Откат выполняется только вручную сохранённым immutable NSIS installer и только
в документированном совместимом окне схемы. Удаление Station SQLite или outbox
не является откатом. Все реальные результаты записываются в
`docs/acceptance/station-stable-release.md`; непроведённые проверки остаются
`NOT RUN`.
