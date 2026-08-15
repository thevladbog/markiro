# Проверка юридических источников и страниц — 2026-08-15

## Результат

Первая фаза юридической системы Markiro собрана и проверена локально. Единый
типизированный источник содержит четыре документа на русском и английском;
русская редакция является определяющей. Лендинг публикует локализованные
HTML-страницы и реестр, а форма и API используют один неизменяемый идентификатор
согласия `MKR-PD-02/2026.08.01`.

Эта проверка подтверждает структуру, сборку и программные контракты. Она не
является юридическим заключением и не включает публикацию в production.

## Опубликованная в коде редакция

- Оператор: Богатырев Владислав Сергеевич.
- Редакция всех первых документов: `2026.08.01`.
- Дата начала действия: `2026-08-15`.
- Коды: `MKR-PD-01`, `MKR-PD-02`, `MKR-DPA-01`, `MKR-BRD-01`.
- Согласие формы: `MKR-PD-02/2026.08.01`.
- Русские исходники находятся в `packages/legal-documents/src/documents/`.

## Поведение и границы

- Добавлены 10 юридических маршрутов: реестр и четыре документа на каждой из
  двух локалей.
- Sitemap и `llms.txt` формируются из единого списка 26 индексируемых HTML-страниц.
- На английских юридических страницах есть ссылка на определяющую русскую
  редакцию; на всех документах видны код, редакция, дата действия и ссылка на
  локализованный реестр.
- В форме удалено сообщение о подключении CRM. Disabled-состояние сообщает
  только о временной недоступности онлайн-отправки и предлагает написать на
  `hello@v-b.tech`; все именованные поля и submit находятся в disabled fieldset,
  поэтому native GET не может вынести введённые данные в URL.
- Включённая английская форма ссылается на английские страницы согласия и
  политики; русская форма сохраняет русские маршруты.
- UI и API больше не принимают версию согласия из окружения; оба импортируют
  `CURRENT_DEMO_CONSENT_ID` из `@markiro/legal-documents`.
- Новые поля формы, аналитика, маркетинг, профилирование, UTM/query/referrer
  capture, CRM forwarding и cookie banner не добавлялись.
- Слово CRM в юридическом тексте используется только в утверждении об отсутствии
  передачи заявок. Referrer перечислен только как категория технических данных,
  которые может получить SmartCaptcha; код собственного сбора referrer не добавлен.

## Автоматические проверки

Все команды выполнялись в изолированном worktree на Node.js 24.

### `@markiro/legal-documents`

- `corepack pnpm --filter @markiro/legal-documents test` — PASS, 2 файла / 24 теста.
- `corepack pnpm --filter @markiro/legal-documents typecheck` — PASS.
- `corepack pnpm --filter @markiro/legal-documents lint` — PASS.
- `corepack pnpm --filter @markiro/legal-documents build` — PASS.

### `@markiro/landing`

- `corepack pnpm --filter @markiro/landing test` — PASS, 11 файлов / 113 тестов.
- `corepack pnpm --filter @markiro/landing typecheck` — PASS, 0 diagnostics.
- `corepack pnpm --filter @markiro/landing lint` — PASS.
- `corepack pnpm --filter @markiro/landing build` — PASS, 26 HTML-страниц.
- `corepack pnpm --filter @markiro/landing run audit` — PASS,
  `landing built-site audit passed`.

Без `run` команда `corepack pnpm --filter @markiro/landing audit` выбирает
встроенный сетевой audit pnpm, а не одноимённый package script; в sandbox она
остановилась на DNS. Для проверки собранного сайта использована однозначная
команда выше. Один параллельный запуск аудита также ожидаемо получил `ENOENT`,
поскольку стартовал до завершения build; последовательный build → audit прошёл.

### `@markiro/api`

Для DB-backed тестов создана только временная БД
`markiro_legal_phase1_20260815_1454`. Runtime-migrator успешно применил миграции
`0000`–`0044`.

- `corepack pnpm --filter @markiro/api test` — PASS, 151 файл passed / 1 skipped;
  1557 тестов passed / 2 skipped.
- `corepack pnpm --filter @markiro/api exec vitest run test/demo-request-pipeline.e2e.test.ts`
  — PASS, 1 файл / 5 тестов, без skip.
- `corepack pnpm --filter @markiro/api typecheck` — PASS.
- `corepack pnpm --filter @markiro/api lint` — PASS.
- `corepack pnpm --filter @markiro/api build` — PASS.

Два ожидаемых skip требуют `LOCAL_INFRA_SMOKE=1`: полный lifecycle через локальные
Mailpit/MinIO и subprocess-smoke provision tenant owner. Они не доказывались этим
прогоном. Видимые ERROR-логи полного набора относились к намеренно внедрённым
отказам в negative-path тестах; итог Vitest зелёный.

После тестов удалена только указанная временная БД. Запрос к `pg_database`
вернул `0`; общая development-БД и её journal не изменялись.

### Браузер, форматирование и diff

- `corepack pnpm test:yandex-runtime` — PASS, 33/33.
- `corepack pnpm test:production-bundle:contract` — PASS, 283/283.
- Прямой Playwright runner — PASS, 74/74: desktop и Pixel 7, все 26 HTML-маршрутов,
  RU/EN формы, отсутствие console/layout errors и горизонтального overflow,
  юридическая навигация, якоря, клавиатурный focus ring, sitemap/llms и реальные 404.
- После форматирования точечный legal browser run — PASS, 4/4.
- `corepack pnpm --dir tools/production-browser --ignore-workspace typecheck` — PASS.
- `corepack pnpm format:check` — PASS.
- `git diff --check` — PASS.

Корневая обёртка `corepack pnpm test:landing:browser` не дошла до Playwright:
Corepack запустил pnpm 11.18, тогда как изолированный browser workspace требует
11.10. После установки его frozen lockfile использован прямой локальный
Playwright binary. Первый sandbox-run не смог открыть `127.0.0.1` (`EPERM`),
поэтому подтверждающий прогон выполнен с разрешённым loopback.

## Проверка приватности и scope

Итоговый diff просмотрен относительно `227db0bd4`. Не добавлены:

- поля формы и произвольные клиентские идентификаторы;
- аналитические идентификаторы, web analytics, UTM/query capture или lead enrichment;
- передача в CRM или новый внешний получатель;
- provider secrets, SMTP/API credentials или production values;
- фиктивная подпись, печать, результат юридической проверки;
- утверждение о поданном уведомлении или наличии записи в реестре Роскомнадзора.

## Что эта проверка не доказывает

- юридическую корректность текста и внешнюю проверку юристом;
- качество и юридическую эквивалентность английского перевода;
- точные юридические наименования провайдеров и достаточность их договоров;
- фактическое размещение персональных данных в России;
- подачу уведомления в Роскомнадзор;
- PDF/A, DOCX, Data Matrix, скачиваемые бланки и физическую проверку кода;
- live DNS/TLS и содержимое реально опубликованного сайта;
- production SmartCaptcha и её договорно-техническую конфигурацию;
- Postbox sender identity и реальную доставку писем;
- production enablement и реальную отправку формы.

## Контрольная точка

Фаза 1 останавливается на review checkpoint. До включения production-формы нужно
принять русские исходники именно редакции `2026.08.01`. Генерация фирменных
PDF/DOCX, Data Matrix и публикационный workflow относятся к следующему плану
`docs/superpowers/plans/2026-08-15-legal-artifacts-and-publication.md`.
