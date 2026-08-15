# Приёмка юридических артефактов и готовность публикации — 2026-08-15

## Итог

Код и неизменяемые артефакты на исходном проверенном SHA
`25c24f06a7e1884539dd3f4cb1a9bddfe68d06c6` прошли доступную локальную
repository-, DB-, browser-, Lighthouse- и документную проверку. Восемь PDF
повторно подтверждены точным LibreOffice 26.2.5 и закреплённым veraPDF 1.30.2;
все 16 PDF-страниц и RU/EN HTML просмотрены локально. Временная БД удалена,
общая development-БД не изменялась.

Production-публикация не выполнялась и сейчас не одобряется этим отчётом.
Внешняя юридическая проверка, договорно-провайдерский gate, production
SmartCaptcha/Postbox, контролируемая доставка, печать/физическое сканирование и
live-проверка именно этой редакции не завершены. Текущий публичный сайт отвечает
по HTTPS, но обслуживает старый release `28e915fff83a53f573683952a3eec9544815a129`;
новые legal-маршруты на нём возвращают 404.

## Репозиторные проверки

Все команды выполнялись в изолированном worktree. Node.js и pnpm запускались
через зафиксированный Corepack; там, где package-wrapper не дошёл до тестов,
ниже отдельно указан прямой установленный эквивалент.

| Область                                     | Результат                                                                                                                                                        |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@markiro/domain`                           | PASS: 17 файлов, 228/228 тестов; typecheck, lint, build PASS.                                                                                                    |
| `@markiro/legal-documents artifacts:verify` | PASS: 12/12 неизменяемых файлов повторно сгенерированы, восемь PDF проверены и все tracked bytes совпали.                                                        |
| `@markiro/legal-documents`                  | PASS: 4 файла, 95/95 тестов; typecheck, lint, build PASS.                                                                                                        |
| `@markiro/landing`                          | PASS: 12 файлов, 133/133 тестов; Astro check 71 файл, 0 errors/warnings/hints; lint PASS; build 31 страница; built-site audit PASS.                              |
| `@markiro/db`                               | PASS: 25 файлов, 142/142 теста; typecheck, lint, build PASS.                                                                                                     |
| `@markiro/api`                              | PASS подтверждающим последовательным прогоном: 151 файл passed / 1 skipped; 1558 тестов passed / 2 skipped / 0 failed; typecheck, lint, build PASS.              |
| Production bundle                           | PASS: 296/296 тестов, без skip.                                                                                                                                  |
| Landing Playwright                          | PASS прямым runner: 96/96 тестов, 1 worker, desktop и mobile.                                                                                                    |
| Landing Lighthouse                          | PASS прямым runner: mobile performance 0.92 (прогоны 0.93/0.92/0.92), desktop performance 1.00; accessibility, best practices и SEO 1.00 для обеих конфигураций. |
| `git diff --check` до отчёта                | PASS.                                                                                                                                                            |
| `corepack pnpm format:check`                | FAIL на ранее существующем и не изменённом этим этапом `packages/domain/test/helpers/decode-data-matrix.ts`. Других файлов Prettier не назвал.                   |

### DB/API evidence и skips

Создана только уникальная БД `markiro_task6_20260815_2128`. Перед созданием
подтверждено отсутствие такого имени; применены все 45 миграций, journal
содержал 45 записей.

Первый configured API-запуск корректно остановился до тестов, потому что
локальный `.env` не содержит новых обязательных `PLATFORM_AUTH_URL` и
`SAAS_ADMIN_ORIGIN`. Повторный запуск использовал только безопасные loopback CI
значения. Параллельная штатная команда получила 150 файлов passed, 1 skipped,
1 failed; 1557 тестов passed, 2 skipped, 1 failed. Единственный сбой был
`test/auth-route-policy.test.ts` с `socket hang up`. Тот же файл отдельно прошёл
2/2 вне sandbox; sandbox-репродукция останавливалась на `listen EPERM
0.0.0.0`. Поэтому подтверждающим установленным эквивалентом выполнен полный
Vitest с `--no-file-parallelism`: 151 файл passed, 1 skipped; 1558 passed,
2 skipped, 0 failed.

Оба ожидаемых skip требуют `LOCAL_INFRA_SMOKE=1`: lifecycle локальных
Mailpit/MinIO и subprocess-smoke provision tenant owner. Это не является
production Postbox/mail evidence.

После API и DB gates удалена только `markiro_task6_20260815_2128`; запрос к
`pg_database` вернул 0. Общая БД `markiro` осталась доступной и не мигрировалась
этим этапом.

### Wrapper-only infrastructure failures

- `corepack pnpm test:landing:browser` не дошёл до Playwright: вложенный pnpm
  разрешился в 11.18.0, а browser-workspace требует 11.10.0. Прямой установленный
  `tools/production-browser/node_modules/.bin/playwright` прошёл 96/96.
- `corepack pnpm test:landing:lighthouse` остановился по той же причине до
  Lighthouse. Прямой `node scripts/lighthouse-landing.mjs` из browser-workspace
  прошёл.
- Первые две попытки прямого Playwright были ошибками относительного пути к
  runner/config и не запускали тесты; результатом считается последующий полный
  прогон 96/96.
- Сетевые команды в sandbox ожидаемо не могли bind/resolve localhost и публичный
  DNS. Подтверждающие read-only прогоны выполнены с разрешённым сетевым доступом.

## Локальная визуальная приёмка HTML

Локальная production-like сборка просмотрена в браузере при 1440×1200 и Pixel 7
412×839. Проверены 11 RU/EN маршрутов в обоих viewport: два реестра, четыре
документа на каждой локали и двуязычный verification URL. Для всех 22 сочетаний:

- ровно один `h1`, ожидаемый `lang`, непустой документ;
- горизонтального overflow нет;
- browser console errors отсутствуют;
- реестры RU/EN, политика RU desktop и EN Pixel дополнительно просмотрены
  целиком; иерархия, шрифты, таблицы, ссылки и мобильный flow визуально целы.

Full-page compositor встроенного браузера однажды продублировал sticky header в
мобильном raster screenshot. DOM, viewport screenshot и scroll geometry
подтвердили один реальный header; это ограничение capture, а не дефект страницы.

## Локальная документная приёмка

### Неизменяемость и точный toolchain

- `apps/landing/public/legal/artifacts.json`: 5 319 байт, SHA-256
  `f4c168170cdbff9127d89c803c072a2434efb303dc059e05e8baef27e3d0f16d`.
- Точный LibreOffice: `LibreOffice 26.2.5.2
cd7284b4cbbfeb507e630c1aac019f4157393acb`.
- Закреплённый veraPDF image:
  `docker.io/verapdf/cli@sha256:d5ee329657cf9bc4b2400392dd54c7d0a0ce9980ff6fa2da5590eebeec007cdb`,
  tool version 1.30.2.
- Exact verifier: PASS, восемь PDF/A-2b compliant, 12/12 tracked artifact bytes
  неизменны; локальный alpha LibreOffice не использовался.

### PDF

Все восемь PDF свежо отрендерены Poppler при 144 dpi и все 16 PNG просмотрены в
нативном размере: BRD EN/RU 1+1, DPA EN/RU 2+2, PD-01 EN/RU 3+3, PD-02 EN/RU
2+2. Результат 16/16 PASS: заголовки, кириллица/латиница, таблицы, переносы,
продолжения, Data Matrix, URL, номера страниц и нижние колонтитулы целы; clipping,
overlap и пропавших glyphs нет. `pdfinfo` подтвердил A4
595.304×841.89 pt для каждого файла и страницы 1/1/2/2/3/3/2/2.

Системный print-preview в диалоге печати свежо не проверялся. Проверены A4 page
boxes и полные растры, но это не выдаётся за print-preview или физическую печать.

### DOCX

Текущие хэши четырёх DOCX совпали с принятыми в Task 3:

| Файл                                    | SHA-256                                                            |
| --------------------------------------- | ------------------------------------------------------------------ |
| `markiro_mkr-brd-01_2026.08.01_en.docx` | `26fb2be7ec96bcecb067f104f97825c4a3044d653c646106ae830660853510ce` |
| `markiro_mkr-brd-01_2026.08.01_ru.docx` | `4044a5e26adc3557bcd4edea7ad0a2962a44e3f92c581d8fe040eff65bd1d63d` |
| `markiro_mkr-dpa-01_2026.08.01_en.docx` | `8620533200a79a7f7660e1c536d9c5f12d61a83d13eb9be88b7519fbd195ed24` |
| `markiro_mkr-dpa-01_2026.08.01_ru.docx` | `34e94767b255903f68179b5fb9177b6715eeb9286b7f94faa6c339002e344f2e` |

Поскольку exact verifier подтвердил неизменность всех 12 release bytes,
переиспользовано датированное Task 3 evidence: exact LibreOffice 26.2.5 открыл
четыре DOCX, 6/6 страниц совпали по raster SHA-256 с соответствующими PDF;
Microsoft Word for Mac 16.112 открыл/экспортировал все четыре, 6/6 страниц
прошли визуально. Fresh Word/LibreOffice GUI-прогон в Task 6 не выполнялся.
Windows Word совместимость не доказана.

## Физическая печать и сканирование

Не выполнялись. Документ не отправлялся на физический принтер. Нет evidence о
печати общей разновидности на A4 100%, сканировании Data Matrix двумя обычными
телефонами или производственным сканером, совпадении декодированного публичного
URL и SHA-256 скачанного live-файла. Более строгий физический gate runbook для
каждой разновидности документа также остаётся открытым.

## Внешняя юридическая приёмка

Gate **INCOMPLETE**:

- нет имени квалифицированного российского reviewer, даты и заключения по RU
  редакции `2026.08.01`, tenant/operator и Markiro/processor boundary;
- нет внешнего подтверждения согласованности информационных EN-переводов;
- runbook фиксирует последнее известное состояние на 2026-08-15:
  «уведомление в Роскомнадзор не подано»; независимого registry evidence в этом
  этапе не получено, поэтому gate не помечается завершённым;
- нет принятой внешней процедуры 12-месячного удаления заявок, durable mail
  payload и операционных копий с отдельным legal-hold основанием.

Repository checks не являются юридическим заключением.

## Provider, DNS и workflow evidence

### Read-only public baseline

- `markiro.app` A → `158.160.200.255`; AAAA не получен.
- TLS verification PASS: certificate CN/SAN `markiro.app`, Let's Encrypt YE1,
  `notBefore=2026-08-14 19:18:48 UTC`, `notAfter=2026-11-12 19:18:47 UTC`.
- `/` и `/en/` → 200; `/robots.txt`, `/sitemap.xml`, `/llms.txt` → 200;
  контрольный неизвестный URL → 404.
- Header `x-markiro-release-sha` на live root:
  `28e915fff83a53f573683952a3eec9544815a129`.
- `/legal/`, `/privacy/`, `/en/privacy/` и `/legal/manifest.json` → 404. Это
  подтверждает, что проверяемая legal-редакция ещё не live.
- Публичные MX, apex TXT и `_dmarc.markiro.app` в read-only запросе не найдены.
  DKIM acceptance определить нельзя без утверждённого selector/provider
  evidence.

### GitHub/provider baseline

- Workflow `Publish production images`: последний read-only результат success,
  SHA `a2c387fe3ba9a7de71553451fbadbd9524dfcb4d`.
- Workflow `Deploy production`: последний read-only dispatch success, SHA
  `28e915fff83a53f573683952a3eec9544815a129`.
- Workflow `Yandex infrastructure`: последние наблюдаемые PR-прогоны success.
- Для исходного проверенного SHA `25c24f06...` production publish/deploy evidence
  нет; Task 6 ничего не запускал и не менял.

Provider gate **INCOMPLETE**: нет внешнего evidence действующих договоров и
точных legal names для Yandex Cloud/Postbox/SmartCaptcha/mailbox processor; не
подтверждена российская граница первичного сбора/хранения именно этого контура;
не подтверждены Postbox identity, Easy DKIM, единственный SPF, DMARC, SMTP
credentials в secret store или production SmartCaptcha client/server pair.

## Live production evidence

Для текущего старого release подтверждены только публичная DNS/TLS reachability,
базовые страницы, crawler files, release header и настоящий 404. Это не
post-deploy acceptance проверяемой редакции.

Не выполнялись и не подтверждены:

- deploy candidate с обоими flags false и exact `404 + submission_disabled`;
- включение только API и контролируемая RU/EN доставка по два письма;
- получение internal/visitor писем, Reply-To, spam/junk и Postbox events;
- включённая форма, production SmartCaptcha и error contracts;
- live legal HTML, immutable files/hashes и verification URLs;
- отсутствие CRM placeholder именно на candidate live release;
- monitoring и rollback rehearsal.

Никакие production variables/secrets, DNS, provider identity, SmartCaptcha,
Postbox, Roskomnadzor state или сервисы этим этапом не изменялись.

## Решение и точные блокеры

Локальный candidate готов сохранить как проверенную release-кандидатную точку,
но запрашивать разрешение на production deploy/enablement пока рано. Сначала
нужны отдельные реальные evidence:

1. внешнее юридическое заключение с reviewer/date/version и translation check;
2. договоры/legal names и подтверждение российской storage boundary;
3. фактический Roskomnadzor status и утверждённая retention/deletion procedure;
4. physical A4/scan gate и отдельно не выполненный print-preview;
5. production Postbox DNS/identity и SmartCaptcha readiness без раскрытия
   секретов;
6. исправление либо отдельно осознанное принятие единственного repository-wide
   Prettier failure до release branch gate.

После закрытия блокеров требуется отдельное пользовательское одобрение точных
production targets. Порядок неизменяем: deploy legal-кода с формой/API disabled
→ API enable → контролируемая RU/EN доставка → edge enable → monitoring. Только
после одобренного deploy выполняется полный live gate; этот отчёт не подменяет
его локальными тестами.
