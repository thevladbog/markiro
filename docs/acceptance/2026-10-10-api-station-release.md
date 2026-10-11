# Выборочный выпуск API и Станции

Дата согласования: 2026-10-10. Пользователь выбрал API и Станцию из `main`, включая
накопленные в этих компонентах изменения. Состав Станции: исправление TSPL SSCC,
складская перепечатка кодов единиц и коробов, выбор шаблонов, ручной ввод и
исправления по ревью. Целевая версия: **2.2.0-beta.1**.

## Границы

- API image и все ожидающие миграции выбранного source SHA обновляются вместе.
- Кабинет, SaaS Admin, киоск и лендинг сохраняют действующий `edge` image и web SHA.
- `vbtech-web`, Handheld и Signer этим выпуском не обновляются.
- Публикация candidate image bundle не означает выкладку его `edge`.
- Stable Станции и установка на заводские устройства не входят в beta-публикацию.

## Порядок

1. Слить проверенный отдельный PR выборочного deploy и PR складской перепечатки
   [#693](https://github.com/thevladbog/markiro/pull/693). Получить успешный CI точного
   source SHA `main`, содержащего оба изменения.
2. Дождаться успешного **Publish production images** этого SHA. Сверить run ID,
   manifest и immutable API digest.
3. Запустить защищённый **Deploy production** с этим `release_run_id`, exact
   `release_sha`, согласованным текущим `landing_demo_submission_state` и
   `scope=api-only`. Проверить healthy record, новый API digest и неизменные
   edge digest, container ID и `edgeReleaseSha`.
4. Повторно проверить, что **Publish station beta** с `bump=next-minor-beta`
   вычисляет **2.2.0-beta.1**. Если теги изменились, не выпускать другую версию
   автоматически. Следовать [beta runbook](../runbooks/station-beta-release.md)
   и обязательным условиям происхождения и publication baseline.
5. Сверить exact beta tag, source/base SHA, signatures и опубликованные manifests.
   Отдельно выполнить физическую приёмку перепечатки по документу
   `docs/acceptance/station-warehouse-reprint.md` из PR #693.

## Подготовленные проверки

Production contracts на отдельной ветке от `main`: 580/580. Yandex runtime
contracts: 117/117. Station release contracts: 462/462. Дополнительное
ревью проверило подготовку и откат только API, старые release records, отдельную
web identity, последующий full rollback и standalone diagnostics. Эти результаты
не доказывают живую выкладку, выпуск Windows installer или работу принтера TSC 210.

`pnpm format:check` и `git diff --check` прошли. Дополнительный ESLint-прогон
изменённых JavaScript modules показывает 17 прежних ошибок в трёх существующих
файлах; сравнение с исходным `main` подтвердило отсутствие новых ошибок.
Остальные изменённые JavaScript modules прошли ESLint без ошибок. Domain и
legal-documents пересобраны после перехода на отдельную ветку.

На момент подготовки PR #693 открыт, release dispatch не выполнялся. Публичный web SHA
прочитан как `9a0f5a36f6a6c622a5c1dfa225cb4e52d5d7c7e4`; GitHub beta channel —
`2.1.0-beta.9`. Перед запуском заново проверить обе исходные версии.
