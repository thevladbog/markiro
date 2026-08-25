# Google Analytics для markiro.app через Google Tag Manager

Этот runbook фиксирует минимальную production-конфигурацию веб-аналитики лендинга. Он не разрешает рекламные пиксели, remarketing, передачу персональных данных или включение новых поставщиков аналитики.

## Идентификаторы

- Google Tag Manager container: `GTM-KZ6P7NVF`.
- GA4 web stream Measurement ID: `G-WSYRNLH3K9`.
- Production origin: `https://markiro.app`.

GTM-контейнер загружается сайтом только после согласия на категорию «Аналитика» или «Маркетинг». До выбора сайт передаёт Google Consent Mode v2 со значениями `denied`; при изменении выбора передаются актуальные `analytics_storage`, `ad_storage`, `ad_user_data` и `ad_personalization`. Теги ниже дополнительно ограничиваются собственной категорией consent, чтобы analytics-тег не сработал при выборе только маркетинга.

## Границы данных

В GA4 нельзя передавать имя, email, телефон, компанию, текст полей, captcha token, request UUID, содержимое заявки или иные идентификаторы посетителя. Допустимы только имя события и перечисленные ниже неперсональные параметры.

Не включать Google Ads, Conversion Linker, remarketing или сторонние шаблоны в рамках этой конфигурации. Для них нужны отдельные marketing-consent, privacy review и release gate.

## 1. Создать переменные Data Layer

В GTM открыть **Variables → User-Defined Variables → New** и создать:

| Имя в GTM           | Тип                 | Data Layer Variable Name |
| ------------------- | ------------------- | ------------------------ |
| `DLV - placement`   | Data Layer Variable | `placement`              |
| `DLV - error_class` | Data Layer Variable | `errorClass`             |

Обе переменные используют Data Layer Version 2. Встроенная переменная `Event` должна быть включена.

## 2. Создать Google tag

1. Открыть **Tags → New → Google tag**.
2. Название: `GA4 - Google tag - markiro.app`.
3. Tag ID: `G-WSYRNLH3K9`.
4. Trigger: `Initialization - All Pages`.
5. В **Advanced Settings → Consent Settings** выбрать **Require additional consent for tag to fire** и добавить `analytics_storage`.
6. Сохранить, но пока не публиковать контейнер.

Google tag отвечает за `page_view`, автоматически собираемые события и включённые возможности Enhanced Measurement. Отдельный GA4 configuration tag не создавать.

## 3. Создать trigger микро-событий

1. Открыть **Triggers → New → Custom Event**.
2. Название: `CE - Landing micro events`.
3. Event name:

   ```text
   ^landing_(demo_click|phone_click|form_start|form_submit|form_error)$
   ```

4. Включить **Use regex matching**.
5. Trigger fires on: **All Custom Events**.

События приходят из сайта только при выданном analytics-consent:

| Event                 | Когда возникает                                 | Параметры                                                                                    |
| --------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `landing_demo_click`  | Нажат CTA перехода к demo                       | `placement`: `header`, `hero` или `seo-hero`                                                 |
| `landing_phone_click` | Нажат публичный телефон                         | `placement`: `header`, `hero` или `demo`                                                     |
| `landing_form_start`  | Первое изменение поля формы                     | нет                                                                                          |
| `landing_form_submit` | Реальная попытка отправить форму, включая Enter | нет                                                                                          |
| `landing_form_error`  | Проверка или отправка завершилась ошибкой       | `errorClass`: `validation`, `unavailable`, `captcha`, `rate_limited`, `server` или `network` |

## 4. Создать GA4 tag микро-событий

1. Открыть **Tags → New → Google Analytics: GA4 Event**.
2. Название: `GA4 - Landing micro events`.
3. Measurement ID: `G-WSYRNLH3K9`.
4. Event Name: `{{Event}}`.
5. Добавить event parameters:

   | Event Parameter | Value                   |
   | --------------- | ----------------------- |
   | `placement`     | `{{DLV - placement}}`   |
   | `error_class`   | `{{DLV - error_class}}` |

6. Trigger: `CE - Landing micro events`.
7. В **Advanced Settings → Consent Settings** потребовать `analytics_storage`.

Пустые необязательные параметры не должны подменяться строками `undefined`, `null` или `not set` через Custom JavaScript.

## 5. Создать lead conversion

1. Создать Custom Event trigger:
   - название `CE - Landing form success`;
   - Event name `landing_form_success`;
   - All Custom Events.
2. Создать **Google Analytics: GA4 Event** tag:
   - название `GA4 - Generate lead - demo form`;
   - Measurement ID `G-WSYRNLH3K9`;
   - Event Name `generate_lead`;
   - parameter `method` = `demo_form`;
   - parameter `form_id` = `landing_demo`;
   - trigger `CE - Landing form success`;
   - additional consent `analytics_storage`.
3. Не задавать `value` и `currency`, пока бизнес не утвердит воспроизводимую денежную оценку заявки.
4. После первого поступления события открыть GA4 **Admin → Events / Key events** и отметить `generate_lead` как key event.

`landing_form_success` возникает только после принятого API-ответа `202`; клик по кнопке или клиентская валидация не считаются лидом.

## 6. Настроить Enhanced Measurement

В GA4 открыть **Admin → Data Streams → markiro.app → Enhanced Measurement**:

- оставить Page views;
- оставить Scrolls;
- оставить Outbound clicks;
- оставить File downloads;
- выключить Form interactions, чтобы автоматические `form_start`/`form_submit` не дублировали точные события сайта.

Site search и Video engagement включать только после появления соответствующих функций.

## 7. Проверить до публикации

1. В GTM нажать **Preview**, подключить `https://markiro.app` через Tag Assistant.
2. В чистой сессии до выбора cookies убедиться, что запросов `gtm.js`, `g/collect` и analytics cookies нет.
3. Выбрать только «Аналитика». Проверить один Google tag и один `page_view`.
4. Проверить CTA с placement `header`, `hero` и `seo-hero`.
5. Проверить три телефонных placement: `header`, `hero`, `demo`.
6. Начать заполнение формы, отправить невалидную форму, затем успешно отправить контролируемую тестовую заявку.
7. В Tag Assistant и GA4 DebugView подтвердить ровно по одному `landing_form_submit`, `landing_form_error` для ошибки и `generate_lead` для принятой заявки.
8. Проверить Reject all в новой чистой сессии: GA4-теги и события не должны срабатывать.
9. Проверить выбор только «Маркетинг»: GA4-теги не должны срабатывать из-за required `analytics_storage`.

## 8. Опубликовать и принять

1. В GTM выбрать **Submit → Publish and Create Version**.
2. Version name: `markiro.app GA4 baseline`.
3. Description: `Consent-gated GA4 G-WSYRNLH3K9; landing funnel and generate_lead; no Ads or remarketing.`
4. После публикации повторить чистую production-сессию и проверить GA4 Realtime.
5. Зафиксировать время, GTM version, GA4 Measurement ID и обезличенный результат проверки. Не прикладывать значения cookies, form payload или visitor identifiers.

## Google Ads позже

После отдельного решения о рекламе связать Google Ads и GA4 и импортировать `generate_lead` как конверсию. Не создавать одновременно прямой Google Ads conversion tag и импорт той же GA4-конверсии: это даст двойной учёт. Remarketing разрешается только при marketing-consent и после обновления vendor disclosure.
