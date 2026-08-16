# Публикация и поисковая приёмка markiro.app

Этот runbook — операторский чек-лист. Он применяется только после отдельных одобрений production deploy, публичного DNS и каждого live-гейта ниже. Репозиторные проверки не разрешают автоматически переключать DNS, включать форму или отправлять реальные письма.

## Неизменяемые границы

1. Убедиться, что release SHA опубликован workflow **Publish production images**, а `MARKIRO_LANDING_DOMAIN=markiro.app` задан в environments `production-deploy` и `production-infrastructure`.
2. До соответствующего шага держать `PUBLIC_DEMO_SUBMISSION_ENABLED=false` в статической сборке и `LANDING_DEMO_SUBMISSION_ENABLED=false` в API. Эти флаги включаются и откатываются независимо.
3. Секреты Postbox и SmartCaptcha хранить только в установленном production secret store. Не записывать значения API key, SMTP password, server key, captcha token, cookies или данные формы в этот runbook, команды, отчёты и логи.
4. Не включать optional analytics/marketing. Форма создаёт только транзакционные письма и не означает согласия на маркетинг.
5. Эта возможность не подключает внешнюю CRM; любое CRM forwarding требует отдельного контракта, privacy review и release gate.
6. Сохранить release SHA, время и обезличенный результат каждого гейта. Code deploy, юридическое одобрение, Postbox/DNS, SmartCaptcha, контролируемая доставка, публичное включение, monitoring и rollback остаются отдельными наблюдаемыми решениями.

## Ограниченная диагностика Deploy production

При остановке workflow доверять только последней строке вида `MARKIRO_DEPLOY_FAILURE <stage>`. В публичном контракте допустимы ровно девять stage; сообщение не содержит причину, имена файлов, идентификаторы секретов, значения окружения или удалённый вывод. Значения секретов нельзя добавлять в команды, логи, issue, комментарии workflow или отчёты даже при ручном разборе.

Порядок стадий и ограниченное действие оператора:

1. `MARKIRO_DEPLOY_FAILURE configuration` — проверить наличие требуемых **имён** GitHub environment values, точный release SHA и настроенный pinned SSH host key. Не ослаблять host-key verification и не выводить значения; после исправления повторно запустить тот же failed deployment.
2. `MARKIRO_DEPLOY_FAILURE transfer` — проверить доступность VM, свободное место и совпадение pinned host key с отдельным доверенным источником. Не заменять immutable bundle и не создавать новый release; повторно запустить тот же failed deployment.
3. `MARKIRO_DEPLOY_FAILURE runtime-inventory` — кандидат уже передан, но read-only probe сравнил только имена ключей. Эта проверка выполняется до `reconcile-host` и до изменений unit-файлов, runtime environment, базы данных, контейнеров, сервисов или active release.
4. `MARKIRO_DEPLOY_FAILURE reconcile-host` — проверить утверждённый host contract и состояние reconciliation unit, не обходя его ad-hoc командами. После восстановления контракта повторно запустить тот же failed deployment.
5. `MARKIRO_DEPLOY_FAILURE runtime-env` — проверить доступ VM service account к metadata и Lockbox и состояние штатного materialization unit. Не читать и не печатать payload; после восстановления доступа повторно запустить тот же failed deployment.
6. `MARKIRO_DEPLOY_FAILURE prepare` — проверить наличие образов для того же release SHA, job-scoped registry access и обезличенный результат preparation/migration. Не переносить registry credentials в issue или постоянные файлы; повторно запустить тот же failed deployment.
7. `MARKIRO_DEPLOY_FAILURE smoke` — сохранить предыдущий active release, проверить readiness и точные публичные routes по production smoke runbook. После устранения причины повторно запустить тот же failed deployment; новый образ без отдельного решения не собирать.
8. `MARKIRO_DEPLOY_FAILURE finalize` — сверить candidate и active release по точному SHA и проверить штатный finalize contract. Не редактировать release record вручную; повторно запустить тот же failed deployment.
9. `MARKIRO_DEPLOY_FAILURE rollback` — автоматическое восстановление не подтверждено. Остановить повторные запуски, сохранить предыдущий active release и запросить отдельное одобрение на ручное восстановление; не удалять candidate, release records или durable data.

### Восстановление после `runtime-inventory`

1. Из committed `.env.production.example` получить отсортированный список: только имена ключей, без `=` и значений.
2. Для активной версии Lockbox получить тем же безопасным способом только имена ключей. Не выгружать payload в terminal, CI output или временный файл и не копировать значения секретов в логи, issue, чат или evidence.
3. Сравнить два набора имён: каждый ключ должен встречаться ровно один раз, лишних и пропущенных имён быть не должно. Значения не сравнивать и не записывать.
4. При расхождении создать новую версию Lockbox с исправленным набором имён штатным защищённым процессом. Предыдущую версию не удалять: сохранить возможность восстановить её отдельным одобренным действием. В операционном evidence фиксировать только release SHA, время, результат сравнения имён и непривилегированный идентификатор версии, если он разрешён принятой политикой.
5. После подтверждения набора имён повторно запустить тот же failed deployment для того же immutable release SHA. Не запускать reconcile, materialization, migration или service commands вручную и не подменять этот повтор новым deploy-кандидатом.

`runtime-inventory` доказывает только совпадение набора имён. `runtime-inventory` не доказывает SMTP delivery. `runtime-inventory` не доказывает captcha validity. `runtime-inventory` не доказывает database connectivity. `runtime-inventory` не доказывает application health. Эти проверки остаются отдельными release gates.

## Внешняя приёмка юридических документов и файлов

До включения формы завести датированную карточку evidence, не содержащую персональные данные посетителей и секреты. В ней должны быть отдельные результаты следующих гейтов:

1. Зафиксировать заключение квалифицированного российского юриста по опубликованным RU-текстам, границе tenant/operator и Markiro/processor, а также по информационным EN-переводам. Репозиторий и генератор не заменяют такое заключение.
2. Записать наименование провайдера обработки/доставки, реквизиты действующего документа «договор с провайдером» и отдельно подтверждённое место первичного сбора. Получить прямое подтверждение, что хранение в Российской Федерации применяется к этому контуру. Не переносить в карточку ключи, пароли или закрытые приложения к договору.
3. Явно записать состояние уведомления Роскомнадзор: на дату этой редакции **уведомление не подано**. Статус уведомления не является секретом; после подачи сохранить дату и регистрационный идентификатор во внешнем compliance evidence и выпустить новую редакцию текста, если это требуется. Репозиторные тесты не меняют этот статус.
4. Для каждого PDF сохранить успешный отчёт PDF/A-2b от точной версии `veraPDF 1.30.2`, совпадение SHA-256 с `/legal/artifacts.json` и результат извлечения текста. Затем открыть все страницы в `Microsoft Word` (для DOCX-шаблонов) и `LibreOffice 26.2.5`, проверить переносы, шрифты, колонтитулы и поля. Проверка в другой версии LibreOffice отмечается только как preview.
5. Напечатать каждую разновидность документа на физическом листе A4 в масштабе 100% и выполнить физическое сканирование Data Matrix телефоном и производственным сканером. Код обязан вернуть точный публичный URL редакции без персональных данных.
6. Настроить процедуру хранения заявок и писем не дольше `12 месяцев`: ежемесячно формировать обезличенный отчёт о сроках, а по достижении срока выполнять удаление из почтового ящика, durable mail payload и операционных копий по утверждённой процедуре. Legal hold или иной обязательный срок фиксируется отдельным основанием.

Тесты репозитория не доказывают юридическое одобрение, соответствие фактического файла PDF/A, корректность открытия в Microsoft Word, физическое сканирование распечатанного кода, наличие договора, российскую локализацию инфраструктуры или выполнение удаления из внешнего почтового ящика. Эти результаты принимаются только по внешнему evidence.

## Последовательность включения формы и писем

Не менять порядок. Переходить к следующему гейту можно только после фиксации результата текущего; при ошибке остановиться и выполнить подходящий rollback.

### Гейт 1. Развернуть код с двумя выключенными флагами

1. Собрать immutable edge image с `PUBLIC_DEMO_SUBMISSION_ENABLED=false` и подготовить защищённое окружение API с `LANDING_DEMO_SUBMISSION_ENABLED=false`. Запускать **Deploy production** только с `landing_demo_submission_state=disabled`, чтобы public smoke требовал точную пару `404 + submission_disabled`, не обращаясь к captcha или mail.
2. Тем же release SHA развернуть additive migration, API, mail worker и edge. Миграция добавляет возможность безопасно и не является сигналом включения формы.
3. Выполнить package, built-site, browser, Lighthouse и production bundle gates. Отдельно зафиксировать DB skips и недоступную внешнюю инфраструктуру.
4. Проверить readiness, отсутствие активной формы и plain 404 для `POST /api/demo-requests`; убедиться, что проверка не создала заявок или писем.

**Критерий выхода:** новый код работает, оба флага false, форма отсутствует, POST возвращает 404, реальная отправка не выполнялась.

### Гейт 2. Подготовить Postbox и DNS отправителя

1. Создать отдельный service account с узкой ролью `postbox.sender` и SMTP API key со scope `yc.postbox.send`. Сам ключ в runbook не записывать; передать его в production secret store по установленной процедуре.
2. Настроить Nodemailer на `postbox.cloud.yandex.net`: порт 587 с STARTTLS либо 465 с SMTPS, с обязательной проверкой TLS certificate.
3. Подтвердить sender identity домена `markiro.app` и статус acceptance в Postbox.
4. Проверить выданные Postbox записи Easy DKIM, единственную SPF-запись домена, включающую `spf.postbox.yandexcloud.net`, и опубликованную DMARC policy. Не создавать вторую SPF-запись.

**Критерий выхода:** Postbox принял identity, DKIM/SPF/DMARC проверены live, SMTP credentials находятся только в secret store. Флаги всё ещё false.

### Гейт 3. Одобрить право и настроить SmartCaptcha

1. Создать production client/server pair SmartCaptcha для утверждённого hostname. Публичный client key предназначен только для edge build; server key помещается только в secret store API.
2. Утвердить privacy policy, текст согласия на обработку персональных данных, cookie/vendor disclosure о SmartCaptcha и неизменяемую версию согласия.
3. Проверить canonical same-origin paths для privacy и consent документов. Убедиться, что landing и API собраны из одного release `@markiro/legal-documents` и используют его `CURRENT_DEMO_CONSENT_ID`; environment overrides для путей и версии согласия не применяются.
4. Настроить server key, но оставить оба feature flags false до фиксации юридического одобрения и production-конфигурации captcha.

**Критерий выхода:** юридические документы и consent version одобрены, production SmartCaptcha настроена, секреты не раскрыты, форма не опубликована.

### Гейт 4. Включить только API и выполнить контролируемую доставку

1. Оставить `PUBLIC_DEMO_SUBMISSION_ENABLED=false`. Задать API `LANDING_DEMO_SUBMISSION_ENABLED=true`, утверждённый `LANDING_ORIGIN`, `LANDING_DEMO_RECIPIENT=hello@v-b.tech`, публичный Reply-To и SmartCaptcha server key; перезапустить API тем же immutable release. Версия согласия берётся из того же release `@markiro/legal-documents`.
2. Убедиться, что публичная HTML-форма всё ещё отсутствует, а контролируемый `POST /api/demo-requests` теперь проходит только с валидным production captcha token.
3. Из контролируемых почтовых ящиков отправить контролируемую RU/EN пару: ровно одну RU- и одну EN-заявку. Не фиксировать в evidence значения полей формы, captcha tokens или адреса посетителей.
4. Для каждой заявки создать отдельный обезличенный request UUID и убедиться, что один и тот же request UUID связывает заявку, ровно две durable mail delivery rows и ровно две durable outbox rows. Обе доставки должны пройти из `queued` (или наблюдаемого `retrying`) в `sent`; состояние `failed` блокирует переход дальше.
5. Проверить получение внутреннего письма на `hello@v-b.tech` и confirmation в соответствующем контролируемом ящике посетителя. Проверить папки spam/junk и направление Reply-To: внутреннее письмо отвечает посетителю, confirmation отвечает на публичный адрес Markiro.

**Критерий выхода:** RU и EN запросы получили 202, для каждого создано и отправлено ровно два письма, оба адресата подтвердили arrival и Reply-To, spam/junk проверены.

### Гейт 5. Собрать и опубликовать форму

1. Указать только публичные build values: `PUBLIC_DEMO_SUBMISSION_ENABLED=true`, `PUBLIC_SMARTCAPTCHA_CLIENT_KEY` и `PUBLIC_PHONE`. Legal paths и consent ID в image берутся из release `@markiro/legal-documents`, а не из environment.
2. Собрать новый immutable edge image и развернуть его после проверки, что server flag остаётся true. Запустить **Deploy production** с `landing_demo_submission_state=enabled`: smoke отправляет только пустой JSON и требует `400 + invalid_request`, поэтому не вызывает SmartCaptcha и не создаёт письмо. Не передавать SmartCaptcha server key в build arguments или image layers.
3. Проверить RU и EN формы на desktop и mobile: тексты, ссылки на документы, consent, keyboard/focus flow, captcha fallback и отсутствие других публичных API routes. Зафиксировать точные стабильные пары: невалидный captcha даёт `400 + captcha_invalid`, недоступный/просроченный captcha provider даёт `503 + captcha_unavailable`, превышение лимита даёт `429 + rate_limited`; проверка только HTTP status без public error code не проходит гейт.
4. Проверить landing-only CSP и Caddy ordering: только exact `POST /api/demo-requests` проксируется; GET/HEAD/PUT, соседние и вложенные пути остаются 404.

**Критерий выхода:** публичная форма доступна в RU и EN только на утверждённом release; legal paths, captcha и server route согласованы.

### Гейт 6. Наблюдать после включения

1. Наблюдать раздельные rates ответов `202`, `400 + captcha_invalid`, `503 + captcha_unavailable` и `429 + rate_limited`, а также неожиданные изменения source/global rate limits. Обязательные обезличенные monitoring dimensions: `status/code`, `locale` и `source path`; не добавлять PII или captcha token.
2. Наблюдать классы captcha failure: rejected, unavailable/timeout и configuration error, не логируя token или данные посетителя.
3. Наблюдать переходы mail `queued`/`retrying`/`failed`/`sent`, возраст очереди и независимый результат двух доставок.
4. Сопоставлять Postbox delivery, bounce/rejection и abuse events с обезличенными request/delivery ids; отдельно следить за arrival внутреннего и confirmation письма.
5. При росте 503, captcha unavailable, застрявших `retrying`, terminal `failed`, bounce/rejection или признаках abuse остановить публичный приём по rollback ниже.

## Rollback формы и доставки

1. Сначала выключить публичную форму: пересобрать edge с `PUBLIC_DEMO_SUBMISSION_ENABLED=false`, развернуть его с `landing_demo_submission_state=enabled` (API на этом шаге ещё включён) и проверить, что форма исчезла в RU и EN.
2. Затем вернуть `LANDING_DEMO_SUBMISSION_ENABLED=false`, перезапустить API и выполнить public smoke с `MARKIRO_LANDING_DEMO_SUBMISSION_STATE=disabled`; exact `POST /api/demo-requests` должен вернуть `404 + submission_disabled`.
3. Не откатывать additive migration и сохранить уже созданные и queued письма. Их состояние разбирается через существующий mail operations flow; rollback не скрывает durable work и не отменяет queued mail.
4. Отзыв credentials выполняется отдельно как security-мера при подозрении на sender abuse или компрометацию. Обычный rollback формы сам по себе Postbox/SMTP credentials не отзывает.
5. DNS rollback и полный application rollback выполняются отдельно по production runbooks, если проблема затрагивает весь сайт, TLS или release, а не только форму.

## Публикация сайта и поисковая приёмка

Этот гейт не заменяет гейты формы выше и требует отдельного одобрения публичного DNS.

1. Запустить защищённый infrastructure workflow с точным SHA и явным `enable_public_dns=true`. Он публикует A records admin, kiosk и landing на один утверждённый адрес.
2. Дождаться точного совпадения authoritative и public DNS через `deploy/production/verify-dns.mjs`; лишний или устаревший адрес считается ошибкой.
3. Запустить **Deploy production** для того же immutable release.
4. Убедиться, что Caddy выпустил и обслуживает валидный TLS certificate для `markiro.app`. Не обходить ошибку ACME временным небезопасным сертификатом.
5. Выполнить production public smoke: все восемь страниц, `robots.txt`, `sitemap.xml`, `llms.txt`, release SHA, headers/cache policy, ожидаемое состояние `/api/demo-requests` и настоящий внешний 404.

## Внешняя ручная проверка

Проверять из сети, не использующей loopback или локальный hosts override:

- HTTP перенаправляет на HTTPS без цепочки; TLS hostname и срок действия корректны;
- canonical каждой страницы указывает на собственный URL вида `https://markiro.app/canonical-route/`;
- неизвестный URL возвращает HTTP 404, а не главную страницу;
- `robots.txt` разрешает Googlebot, Яндекс, Bingbot, OAI-SearchBot, Claude-SearchBot и PerplexityBot, но блокирует GPTBot и ClaudeBot;
- `sitemap.xml` содержит ровно восемь canonical routes, а `llms.txt` ссылается на те же материалы;
- Google Rich Results Test и Schema Markup Validator читают фактический URL без ошибок;
- Валидатор микроразметки в Яндекс Вебмастере распознаёт видимый JSON-LD без расхождения с текстом страницы.

Инструменты: [Google structured-data testing](https://developers.google.com/search/docs/appearance/structured-data), [Яндекс Валидатор микроразметки](https://yandex.ru/support/webmaster/ru/yandex-indexing/validator).

## Webmaster и отправка URL

1. Подтвердить ownership в Google Search Console, Яндекс Вебмастер и Bing Webmaster Tools. Токены подтверждения не добавлять в отчёты и логи.
2. Отправить `https://markiro.app/sitemap.xml` во все поддерживаемые панели.
3. Запросить обход главной и ключевых topic pages через URL inspection/reindex tools.
4. Передать новые или существенно изменённые URL через IndexNow по [официальному протоколу](https://www.indexnow.org/documentation). Не считать HTTP acceptance доказательством индексации.
5. Зафиксировать baseline в `docs/seo/search-console-baseline-template.md`.

## Независимое ревью перед публичным включением

До гейта 5 независимый reviewer проверяет tenant-scope compatibility additive migration, сам migration SQL, idempotency и concurrency двух доставок, fail-closed SmartCaptcha, source/global limits, отсутствие PII в логах, escaping шаблонов и Reply-To, Caddy route ordering и CSP isolation, disabled defaults, а также RU/EN accessibility. Проверенные замечания исправляются новым RED/GREEN cycle и повторным прогоном затронутых гейтов.

## Границы доказательств репозитория

- Тесты репозитория не доказывают юридическое одобрение.
- Тесты репозитория не доказывают работу live DNS/TLS.
- Тесты репозитория не доказывают приём sender identity в Postbox.
- Тесты репозитория не доказывают доставку письма во входящие.
- Тесты репозитория не доказывают размещение в спаме или вне спама.
- Тесты репозитория не доказывают отображение в почтовых клиентах.

Поэтому approved legal documents, live DNS/TLS, Postbox identity/Easy DKIM/SPF/DMARC, production SmartCaptcha keys, controlled RU+EN two-recipient delivery, spam placement и representative inbox-client rendering фиксируются только по отдельному live evidence. Ни один из этих гейтов нельзя отметить выполненным по результатам unit, integration, browser, Lighthouse или production bundle tests.

## Временные точки и границы доказательств

- **D0, только доступность (reachability):** DNS, TLS, HTTP, crawler parity и возможность получить контент. Отсутствие страницы или Markiro в поисковом/AI-ответе до индексации не блокирует релиз.
- **D7:** повторить coverage, queries и citations, если поисковые системы уже обнаружили URL.
- **D30:** повторить полный аудит и сравнить изменения, не подменяя отсутствие данных нулями.

Локальный Lighthouse даёт лабораторную оценку. field Core Web Vitals не являются Lighthouse-оценкой и записываются только после появления реальных полевых данных.

AI-поиск проверяется по `docs/seo/ai-search-query-pack.md`, результаты записываются по `docs/seo/ai-search-audit-template.md`. Ответы оцениваются по фактической точности и качеству citations, а не только по упоминанию бренда.

CRM integration остаётся отдельным release gate: включение формы, доставка писем или rollback не разрешают CRM forwarding и не меняют его статус.

## Стоп-условия

Остановить публикацию или выключить только затронутую возможность, если обнаружены: неверный DNS/TLS, cross-host утечка cabinet/kiosk, HTML 200 вместо ожидаемого 404, несовпадающий canonical, crawler cloaking, отклонение от exact demo-request route, captcha fail-open, tracker до consent или юридические тексты без одобрения. DNS rollback и application rollback выполнять по существующим production runbooks; не удалять durable data.
