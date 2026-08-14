# Публикация и поисковая приёмка markiro.app

Этот runbook применяется после отдельного одобрения production deploy и публичного DNS. Он не заменяет юридическую приёмку формы и не разрешает включать аналитику.

## До переключения DNS

1. Убедиться, что release SHA опубликован workflow **Publish production images**, а `MARKIRO_LANDING_DOMAIN=markiro.app` задан в environments `production-deploy` и `production-infrastructure`.
2. Оставить `PUBLIC_DEMO_SUBMISSION_ENABLED=false`, пока CRM не предоставила точный контракт, rate limit, idempotency, хранение и аудит заявок.
3. Не включать optional analytics/marketing до утверждения privacy policy, cookie policy, текста согласия на персональные данные и consent categories.
4. Выполнить package, built-site, browser, Lighthouse, production bundle и Terraform gates из плана `docs/superpowers/plans/2026-08-14-landing-search-ai-audit.md`.
5. Сохранить до-релизный SHA и время проверки; не сохранять cookies, form values, токены webmaster-сервисов или секреты.

## Публикация

1. Запустить защищённый infrastructure workflow с точным SHA и явным `enable_public_dns=true`. Он публикует A records admin, kiosk и landing на один утверждённый адрес.
2. Дождаться точного совпадения authoritative и public DNS через `deploy/production/verify-dns.mjs`; лишний или устаревший адрес считается ошибкой.
3. Запустить **Deploy production** для того же immutable release.
4. Убедиться, что Caddy выпустил и обслуживает валидный TLS certificate для `markiro.app`. Не обходить ошибку ACME временным небезопасным сертификатом.
5. Выполнить production public smoke: все восемь страниц, `robots.txt`, `sitemap.xml`, `llms.txt`, release SHA, headers/cache policy, запрет `/api/demo-requests` и настоящий внешний 404.

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

## Временные точки и границы доказательств

- **D0, только доступность (reachability):** DNS, TLS, HTTP, crawler parity и возможность получить контент. Отсутствие страницы или Markiro в поисковом/AI-ответе до индексации не блокирует релиз.
- **D7:** повторить coverage, queries и citations, если поисковые системы уже обнаружили URL.
- **D30:** повторить полный аудит и сравнить изменения, не подменяя отсутствие данных нулями.

Локальный Lighthouse даёт лабораторную оценку. field Core Web Vitals не являются Lighthouse-оценкой и записываются только после появления реальных полевых данных.

AI-поиск проверяется по `docs/seo/ai-search-query-pack.md`, результаты записываются по `docs/seo/ai-search-audit-template.md`. Ответы оцениваются по фактической точности и качеству citations, а не только по упоминанию бренда.

## Стоп-условия

Остановить публикацию или выключить только затронутую возможность, если обнаружены: неверный DNS/TLS, cross-host утечка cabinet/kiosk, HTML 200 вместо 404, несовпадающий canonical, crawler cloaking, публичный CRM endpoint без готового контракта, tracker до consent или юридические тексты без одобрения. DNS rollback и application rollback выполнять по существующим production runbooks; не удалять durable data.
