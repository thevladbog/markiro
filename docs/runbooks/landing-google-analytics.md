# Google Analytics для markiro.app через Google Tag Manager

Этот runbook фиксирует минимальную production-конфигурацию веб-аналитики лендинга. Он не разрешает рекламные пиксели, remarketing, передачу персональных данных или включение новых поставщиков аналитики.

## Идентификаторы

- Google Tag Manager container: `GTM-KZ6P7NVF`.
- GA4 web stream Measurement ID: `G-WSYRNLH3K9`.
- Production origin: `https://markiro.app`.

В этой release-конфигурации GTM-контейнер загружается сайтом только после согласия на категорию «Аналитика». Выбор только «Маркетинг» сохраняется, но не загружает контейнер, пока marketing-тегов нет. До выбора сайт ставит в очередь Google Consent Mode v2 со значениями `denied`; при изменении выбора передаются актуальные `analytics_storage`, `ad_storage`, `ad_user_data` и `ad_personalization`. Теги ниже дополнительно требуют `analytics_storage`.

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

## 3. Создать trigger событий клика

1. Открыть **Triggers → New → Custom Event**.
2. Название: `CE - Landing clicks`.
3. Event name:

   ```text
   ^landing_(demo_click|phone_click)$
   ```

4. Включить **Use regex matching**.
5. Trigger fires on: **All Custom Events**.

События приходят из сайта только при выданном analytics-consent:

| Event                 | Когда возникает           | Параметры                                    |
| --------------------- | ------------------------- | -------------------------------------------- |
| `landing_demo_click`  | Нажат CTA перехода к demo | `placement`: `header`, `hero` или `seo-hero` |
| `landing_phone_click` | Нажат публичный телефон   | `placement`: `header`, `hero` или `demo`     |

## 4. Создать GA4 tag событий клика

1. Открыть **Tags → New → Google Analytics: GA4 Event**.
2. Название: `GA4 - Landing clicks`.
3. Measurement ID: `G-WSYRNLH3K9`.
4. Event Name: `{{Event}}`.
5. Добавить event parameter:

   | Event Parameter | Value                 |
   | --------------- | --------------------- |
   | `placement`     | `{{DLV - placement}}` |

6. Trigger: `CE - Landing clicks`.
7. В **Advanced Settings → Consent Settings** потребовать `analytics_storage`.

## 5. Создать события жизненного цикла формы

1. Создать Custom Event trigger:
   - название `CE - Landing form lifecycle`;
   - Event name `^landing_(form_start|form_submit)$`;
   - включить **Use regex matching**;
   - All Custom Events.
2. Создать **Google Analytics: GA4 Event** tag:
   - название `GA4 - Landing form lifecycle`;
   - Measurement ID `G-WSYRNLH3K9`;
   - Event Name `{{Event}}`;
   - event parameters не добавлять;
   - trigger `CE - Landing form lifecycle`;
   - additional consent `analytics_storage`.

`landing_form_start` возникает при первом изменении поля. `landing_form_submit` возникает при реальной попытке отправить форму, включая Enter, но ещё не означает принятую заявку.

## 6. Создать событие ошибки формы

1. Создать Custom Event trigger:
   - название `CE - Landing form error`;
   - Event name `landing_form_error`;
   - All Custom Events.
2. Создать **Google Analytics: GA4 Event** tag:
   - название `GA4 - Landing form error`;
   - Measurement ID `G-WSYRNLH3K9`;
   - Event Name `landing_form_error`;
   - event parameter `error_class` = `{{DLV - error_class}}`;
   - trigger `CE - Landing form error`;
   - additional consent `analytics_storage`.

Допустимые значения `error_class`: `validation`, `unavailable`, `captcha`, `rate_limited`, `server`, `network`.

Параметры намеренно разделены по тегам: `placement` не прикрепляется к событиям формы, а `error_class` — к кликам или следующим попыткам. Не объединять эти теги в один общий tag с обеими Data Layer variables: значения Data Layer могут сохраняться между событиями.

## 7. Создать lead conversion

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

## 8. Настроить Enhanced Measurement

В GA4 открыть **Admin → Data Streams → markiro.app → Enhanced Measurement**:

- оставить Page views;
- оставить Scrolls;
- оставить Outbound clicks;
- оставить File downloads;
- выключить Form interactions, чтобы автоматические `form_start`/`form_submit` не дублировали точные события сайта.

Site search и Video engagement включать только после появления соответствующих функций.

## 9. Проверить до публикации

1. В GTM нажать **Preview**, подключить `https://markiro.app` через Tag Assistant.
2. В чистой сессии до выбора cookies убедиться, что запросов `gtm.js`, `g/collect` и analytics cookies нет.
3. Выбрать только «Маркетинг». Убедиться, что `gtm.js`, Google tag, `page_view` и GA4 events не появились.
4. Не перезагружая страницу, дополнительно включить «Аналитику». Проверить загрузку одного GTM container, одного Google tag и одного `page_view`.
5. Проверить CTA с placement `header`, `hero` и `seo-hero`.
6. Проверить три телефонных placement: `header`, `hero`, `demo`.
7. Начать заполнение формы, отправить невалидную форму, затем успешно отправить контролируемую тестовую заявку.
8. В Tag Assistant и GA4 DebugView подтвердить ровно по одному `landing_form_submit`, `landing_form_error` для ошибки и `generate_lead` для принятой заявки.
9. Убедиться, что `placement` есть только у click events, `error_class` — только у `landing_form_error`, а у `landing_form_start` и `landing_form_submit` нет параметров от предыдущих событий.
10. Проверить Reject all в новой чистой сессии: GA4-теги и события не должны срабатывать.

## 10. Опубликовать и принять

1. В GTM выбрать **Submit → Publish and Create Version**.
2. Version name: `markiro.app GA4 baseline`.
3. Description: `Consent-gated GA4 G-WSYRNLH3K9; landing funnel and generate_lead; no Ads or remarketing.`
4. После публикации повторить чистую production-сессию и проверить GA4 Realtime.
5. Зафиксировать время, GTM version, GA4 Measurement ID и обезличенный результат проверки. Не прикладывать значения cookies, form payload или visitor identifiers.

## Google Ads позже

После отдельного решения о рекламе связать Google Ads и GA4 и импортировать `generate_lead` как конверсию. Не создавать одновременно прямой Google Ads conversion tag и импорт той же GA4-конверсии: это даст двойной учёт. Remarketing разрешается только при marketing-consent и после обновления vendor disclosure.
