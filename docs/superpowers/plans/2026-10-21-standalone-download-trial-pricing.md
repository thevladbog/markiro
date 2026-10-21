# План: автоном с лендинга — скачать, попробовать, купить

**Дата:** 21 октября 2026.
**Спека:** `docs/superpowers/specs/2026-10-20-standalone-download-trial-pricing-design.md` (далее «спека»).
**Макеты:** `docs/design-briefs/landing-new.pen` в основной копии репозитория
(`/Users/thevladbog/PRSOME/q/docs/design-briefs/landing-new.pen`, файл не в git; ассеты рядом в
`landing-new-assets/`). Фреймы: `HN · Главная …` (светлая, тёмная, 390), `HS-A`/`HS-B` и `-M`
(`/skachat/`), `HP`/`HP-M` (`/stoimost/`), `HM-MENU` (меню 390), `HF` (состояния форм), заметки
«кнопки и ссылки» и «SmartScreen».

Каждый пакет — своя сессия, своя ветка от `origin/main`, свой PR. Пакеты одной волны не трогают
общих файлов. Перед PR — `git fetch origin main`, проверки по таблице корневого `AGENTS.md`,
трёхточечный дифф против `origin/main`. Push и PR — только с разрешения владельца.

## Волна 0 — владелец

- **П1.** Тарифы и дополнения в каталоге SaaS-админки (таблица из обсуждения 2026-10-20), признак
  «доступна офлайн-клиентам», квоты и возможности по разделу 3 спеки.
- Создать Telegram-бота (@BotFather), получить токен и chat id — для П2 (`LEAD_TELEGRAM_*`).

## Волна 1 — параллельно

### П2. Лиды, оповещения, сводка, раздел «Заявки»

Спека, раздел 15 целиком. Владеет файлами:

- `packages/db`: `src/schema/landing-leads.ts` (`landing_leads`, `landing_lead_events`,
  `lead_notifications`), экспорт в индексе схемы, **одна** новая миграция (номер — от `origin/main`
  на момент работы), тесты схемы.
- `packages/platform-contracts`: новый `src/landing-leads.ts` — публичная схема запроса
  (`landingLeadRequestSchema`, `.strict()`), список путей `LANDING_LEAD_SOURCE_PATHS`
  (`/`, `/skachat/`, `/stoimost/`), схемы платформенного API лидов; в `src/platform-auth.ts` —
  возможности `leads.read`, `leads.write` (порядок ролей сверяется точно).
- `packages/email`: шаблоны `landing-download-link`, `landing-invoice-request-confirmation`,
  `landing-lead-notification` (владельцу: скачивание и запрос счёта), `landing-lead-digest`;
  превью и тест рендера.
- `apps/api`: модуль `landing-leads` — публичный контроллер `POST /api/landing-leads` (лимит,
  honeypot, SmartCaptcha, согласие — как `demo-requests`), репозиторий с upsert лида и событием в
  одной транзакции, письма через `MailDeliveryService.enqueue`, outbox `lead_notifications`;
  Telegram-клиент по образцу `ChatwootClient`; платформенный контроллер лидов
  (`@RequirePlatformCapabilities`); в `platform-jobs.service.ts` — расписания: отправка оповещений
  (каждую минуту), сводка (`0 6 * * *`), обезличивание (ежедневно), с правкой `checkReady()` и
  `test/platform-jobs.test.ts`; в `mail-jobs.service.ts` — новые виды в оба списка разрешённых для
  `platform-only`; `DemoRequestRepository` дополнительно пишет лид (`demo_request`); `env.ts` —
  `LEAD_TELEGRAM_ENABLED`, `LEAD_TELEGRAM_BOT_TOKEN`, `LEAD_TELEGRAM_CHAT_ID`, `LEAD_ADMIN_BASE_URL`
  (или существующий `SAAS_ADMIN_ORIGIN`), `LEAD_RETENTION_MONTHS`.
- Инвентари env и деплоя: `.env.example`, `.env.production.example`, `deploy/platform/env.example`,
  `deploy/platform/host/config.mjs`, `deploy/platform/preflight.mjs`, `deploy/yandex/runtime-env.mjs`
  (группы необязательных ключей), их тесты.
- `apps/saas-admin`: раздел `/leads` (список, фильтры, карточка, смена статуса, заметка, следующий
  контакт, «Написал», «Создать клиента без кабинета» / связать с существующим), пункт меню со
  счётчиком новых (бейдж `OperationalRailItem`), i18n ru/en, тесты компонентов и API-клиента.

Не трогает: `apps/landing`, `apps/standalone`, `standalone-licenses`, `standalone-sites`.

Проверки: тесты API на e2e пайплайн формы (идемпотентность `requestId`, upsert без затирания,
отказ при неверном согласии/капче), outbox Telegram (повтор, выключенный флаг, нет ПД в тексте),
сводка (выбор лидов по разделам 15.5, пустая не уходит), обезличивание, отказ без возможности,
точный аудит. Пакеты `db`, `platform-contracts`, `email`, `api`, `saas-admin` — test, typecheck, lint,
build. Telegram и SMTP вживую не проверяются — отметить в отчёте.

### П3. Лендинг: главная, `/skachat/`, `/stoimost/`

Спека, разделы 2, 3, 8, 9; макеты из `.pen`. Владеет только `apps/landing` (и
`tools/production-browser`, если его проверки лендинга ломаются от новой разметки).

- Новая главная по фрейму `HN · Главная` (светлая и тёмная тема через токены, мобильная 390, меню
  `HM-MENU`); фильм остаётся отдельной страницей `/kak-rabotaet/`.
- `/skachat/` (`HS-A`/`HS-B`): форма почта + компания + согласие + SmartCaptcha →
  `POST /api/landing-leads` с `intent: "download"`; после успеха — состояние «Ссылка готова» с данными
  из `https://releases.markiro.app/standalone/stable/latest.json` (формат — спека 5.3). Нет файла или
  ошибка — честное состояние «Версия готовится, ссылку пришлём письмом».
- `/stoimost/` (`HP`): сетка, таблица, допы, запуск, примеры, сравнение, форма «Получить счёт»
  (`intent: "invoice"`, ИНН 10/12 цифр, тариф, почта, согласие), FAQ; JSON-LD `Product`/`Offer`.
- Состояния форм по фрейму `HF`; UTM и referrer сохраняются при первом заходе (sessionStorage) и
  уходят в форму.
- Переключатель темы (системная / светлая / тёмная), экраны продукта тёмные в обеих темах.
- Тексты — голос бренда (`.agents/product-marketing.md`), без тире-конструкций «не X, а Y»; цены из
  спеки 3.2.
- Ассеты: скопировать нужные из `landing-new-assets/` в `apps/landing/public/` (скриншоты `*-r3`,
  `*-r4`, логотипы клиентов, этикетки), оптимизировать (webp/avif).
- CSP лендинга: `connect-src` для `https://releases.markiro.app`.
- Навигация, подвал, sitemap, `llms.txt`, IndexNow — обновить под новые страницы.

**Контракт с П2** (код П2 может ещё не быть в `main`): эндпоинт `/api/landing-leads`, тело — спека
15.3, ответ `{accepted: true, requestId}`, ошибки — как у `demo-requests`. Формы помечаются
`form[data-lead-form]`, путь — `location.pathname`. Тест паритета путей с
`LANDING_LEAD_SOURCE_PATHS` добавляется, когда П2 в `main`; до этого — локальный список в тесте с
пометкой в PR.

Проверки: `pnpm --filter @markiro/landing` test, typecheck, lint, build (в свежем worktree — через
turbo); браузерная проверка страниц в обеих темах и на 390 px; Lighthouse и CSP — отдельно.

### П4. Демо-данные в мастере автонома

Спека, раздел 7; открытый вопрос О4 (SSCC демо-коробов). Владеет только `apps/standalone` (хост,
мастер, офис, станция) и своей спекой. Сначала короткая спека по `apps/standalone/AGENTS.md`
(изоляция демо-объектов, исключение из выгрузок, удаление одним действием, SSCC), вопрос О4 —
владельцу до кода. Проверки — по строке `apps/standalone` таблицы `AGENTS.md`, включая
`cargo test --workspace`.

## Волна 2 — после слияния П2

### П5. «Выпуски автонома» и `latest.json`

Спека, раздел 5 (решение 5.4 — публичный бакет `releases.markiro.app`, префикс `standalone/`).
`apps/api` (модуль `standalone-releases`: presigned PUT, проверка JWS манифеста ключами выпусков из
`apps/standalone/proto/fixtures/trust-keys.json` через `verifyStandaloneUpdateManifest`
`@markiro/domain`, сверка SHA-256 и размера, неизменяемые пути, `latest.json`, откат, аудит), env
`RELEASES_S3_*`, возможность `standaloneReleases.manage`, `apps/saas-admin` раздел «Выпуски
автонома». Внешнее, за владельцем: ключи к бакету, CORS бакета для PUT из админки, CSP
`connect-src` админки.

### П6. Демо-файл лицензии и автосвязь лида

Спека 4.2–4.3 и 15.6: источник `offline_demo` в контракте и схеме БД (миграция), ветка в
`StandaloneLicenseIssuanceService`, вид «Демо» в `StandaloneLicenseIssue.tsx`; при регистрации
площадки — связь лида по ИНН (`StandaloneSitesService`), событие и статус `trial`.

П5 и П6 можно вести параллельно: П5 без миграций, П6 — одна миграция.

## Волна 3

### П7. Договор-оферта

После ответов юриста (О1) и бухгалтера (О2): документ в `packages/legal-documents`, артефакты,
аттестация, `pnpm test:production-bundle:contract`. Соглашение пробного периода в мастере (О6) —
вместе с ним.

## Интеграция

После П2 и П3 — тест паритета путей форм лендинга с `LANDING_LEAD_SOURCE_PATHS`; живая проверка
формы на стенде (письма, Telegram, запись лида), браузерная проверка сайта. Деплой — существующими
workflow, отдельным решением владельца.
