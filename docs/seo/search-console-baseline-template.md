# Шаблон search visibility baseline

- Дата и часовой пояс:
- Release SHA:
- Период: `D0 | D7 | D30`

## Reachability

| Проверка                           | Результат | Evidence без секретов |
| ---------------------------------- | --------- | --------------------- |
| Authoritative/public DNS совпадают |           |                       |
| TLS и HTTP→HTTPS                   |           |                       |
| Восемь canonical routes: HTTP 200  |           |                       |
| Неизвестный URL: HTTP 404          |           |                       |
| robots/sitemap/llms доступны       |           |                       |
| Crawler parity                     |           |                       |

## Webmaster systems

| Система               | Ownership | Sitemap status | Discovered | Indexed | Ошибки/исключения | Дата данных |
| --------------------- | --------- | -------------- | ---------: | ------: | ----------------- | ----------- |
| Google Search Console |           |                |            |         |                   |             |
| Яндекс Вебмастер      |           |                |            |         |                   |             |
| Bing Webmaster        |           |                |            |         |                   |             |

Не записывать verification tokens. Нулевое значение допустимо только если интерфейс явно вернул `0`; отсутствие данных отмечать как `нет данных`.

## Search performance

| Route/query group | Impressions | Clicks | CTR | Average position | Period |
| ----------------- | ----------: | -----: | --: | ---------------: | ------ |
| Branded           |             |        |     |                  |        |
| Category          |             |        |     |                  |        |
| SSCC/aggregation  |             |        |     |                  |        |
| Offline/recovery  |             |        |     |                  |        |
| Kiosk/1C          |             |        |     |                  |        |

## Performance evidence

- Lighthouse mobile/desktop commit and lab scores:
- Field Core Web Vitals source, population and period:
- Field data status: `доступны | недостаточно данных | отсутствуют`.

Лабораторные Lighthouse scores не подставлять в field Core Web Vitals.
