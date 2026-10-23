# Автоном / Яндекс Диск: условия и статус OAuth-проверки

Дата: 2026-10-22. Статус: **PKCE PASS / REFRESH С CLIENTSECRET PASS — Windows/DPAPI NOT RUN**.
Живая проверка выполнена на macOS. Windows-служба и сама интеграция бэкапов не проверены.

## Выбранная схема

Собственное приложение клиента типа «Для авторизации пользователей», два scope
`cloud_api:disk.app_folder` + `login:info`, redirect
`http://127.0.0.1:45711/oauth/yandex/callback`, Authorization Code + PKCE S256.
Нет общего ClientID/ClientSecret Markiro, ручного импорта токена и OAuth-брокера. Выбранная
после второго прогона схема: персональный ClientSecret клиента в DPAPI службы хоста, refresh
напрямую к Яндексу; код по-прежнему получается через PKCE без секрета.

Выбор клиента не означает использование типа «Для доступа к API или отладки»: его redirect
фиксирован Яндексом. Отличие отражено в
[инструкции](../runbooks/standalone-yandex-disk-registration.md), §3 спецификации и задаче 0 плана.

## Подтверждено в подготовке

- В начале подготовки приложения и Windows-среды не было. Позже 2026-10-22 пользователь разрешил
  создание тестового приложения и принятие условий; при следующем чтении UI приложение уже было
  создано. Проверено существование, название, два scope и сохранённый redirect; дубликат не создавался.
- Тестовый ClientID: `dacd86d869664a09847d6a54e6f26fac` (публичный).
- Название: «Автоном — резервные копии — тест». Тип: для авторизации, платформа Web.
- Страница: [приложение клиента](https://oauth.yandex.ru/client/dacd86d869664a09847d6a54e6f26fac).
- Redirect: `http://127.0.0.1:45711/oauth/yandex/callback`. В UI подтверждены только
  доступ к папке приложения Диска и базовая информация аккаунта. Это проверка настроек,
  а не доказательство готовности всех API. Живая выдача токенов проверена отдельно ниже.
- Локальная ОС — macOS. ClientID записан в этом отчёте; Windows-среды по-прежнему нет.
- Код хоста на базе `c77195aad00e03ac619baad3cde93ec0ee9cb0be` использует службу `MarkiroHost`
  под `NT AUTHORITY\LocalService` по умолчанию (`apps/standalone/host/src/install.rs`).
- Документация Яндекса явно допускает обмен authorization code без client_secret при передаче
  code_verifier; живая выдача на этом приложении также подтверждена ниже.
- Документация refresh описывает выдачу пары и предупреждает: access_token при успехе может
  остаться прежним. Поэтому сравнение строк токенов не будет единственным критерием успеха.

## Живой результат 2026-10-22, 23:20:07 MSK

[Машинный отчёт без секретов](standalone-yandex-disk-oauth-2026-10-22.json) совпадает с результатом
одноразового Python diagnostic process на macOS. Служба/продуктовый код не запускались.

1. Браузерный вход: response_type=code, PKCE S256, случайный verifier и одноразовый state,
   указанный loopback redirect. Пользователь подтвердил два разрешения.
2. `POST https://oauth.yandex.ru/token`: поля grant_type=authorization_code, client_id,
   code, code_verifier; **нет client_secret и Basic Authorization**. Ответ HTTP 200,
   получены access_token и refresh_token, expires_in=31536000 секунд.
3. Полученным access token: чтение корня `app:/` через Disk resources → HTTP 200, type=dir;
   запрос базовой информации аккаунта через login:info → HTTP 200. Листинг пользовательских
   файлов и запись файлов на Диск не выполнялись.
4. `POST https://oauth.yandex.ru/token`: grant_type=refresh_token, тот же client_id,
   полученный refresh_token; **нет client_secret и Basic Authorization**. Ответ **HTTP 400,
   error=invalid_client**. Новая пара не получена; проверка папки после refresh не выполнялась.
5. Диагностический callback с синтетическим неверным state → HTTP 400 локального listener.
   Это проверка собственного listener, не отрицательная проверка PKCE на стороне Яндекса.

Токены находились только в памяти процесса. В JSON/документы записаны статусы, наличие полей
и срок, без кода/verifier/state/значений токенов. Секрет приложения не передавался.
Проверка не включала подстановку секрета, альтернативный grant или параметры refresh вне
описанного запроса. Поэтому вывод ограничен: **текущая пара приложение/flow не прошла refresh
без секрета**, а не «проверены все возможные варианты OAuth Яндекса».

После первого прогона по §3 спецификации реализация была остановлена. Пользователь затем явно
разрешил отдельный тест с ClientSecret и, при успехе, переход к DPAPI-хранению на хосте. Первый
FAIL сохранён как история, а не переписан в PASS. Права приложения в аккаунте не отзывались.

## Повтор с ClientSecret: 2026-10-22, 23:27:22 MSK

[Машинный отчёт второго прогона](standalone-yandex-disk-secret-refresh-2026-10-22.json).

- Новый Authorization Code + S256 без ClientSecret: HTTP 200, получена пара access/refresh.
- Прямое чтение app:/ и базовой информации аккаунта до refresh: оба HTTP 200.
- Refresh: `POST https://oauth.yandex.ru/token`, form fields `grant_type=refresh_token`,
  `client_id`, `client_secret`, `refresh_token`. Ответ HTTP 200, оба токена присутствуют,
  expires_in=31535999 секунд. HTTP Basic Authorization не использовался.
- После refresh: app:/ HTTP 200, type=dir; login:info HTTP 200, аккаунт тот же.
- Access token остался прежним; это допустимый успешный ответ, не критерий отказа.
- В HTTP-клиенте диагностического процесса были только три внешних origin:
  `https://oauth.yandex.ru`, `https://cloud-api.yandex.net`, `https://login.yandex.ru`.
  Программная allowlist отклоняет другие origins до запроса; редиректы HTTP не следуются.
  Markiro endpoints не вызывались. Это не packet capture всего компьютера или Windows-продукта.
- Секрет считан из поля приложения в браузере в переменную без вывода значения, затем отправлен
  локальной форме POST → памяти диагностического процесса. Первый локальный POST был отклонён
  Origin-проверкой до запросов к Яндексу; исправлена политика local form Referrer-Policy на same-origin,
  строгие Origin/nonce проверки сохранены. Второй POST прошёл. На сервер Markiro секрет не передавался.
- В файлах пробы/документах сохранены только metadata, имена полей и boolean результаты.
  ClientSecret и токены не сохранялись в файлы, env/args или evidence; в отчёте их значений нет.
  По окончании одноразовый процесс завершает работу, credentials не переносятся в продукт.

**Вывод:** direct Yandex refresh с персональным секретом этого приложения подтверждён на macOS.
DPAPI, LocalService, restart и закрытый офис не проверены; в продукте хранение ещё не реализовано.
Решение о DPAPI — утверждённое пользователем направление, а не результат Windows-теста.
Для восстановления копии сохраняем PKCE без секрета; для последующего расписания пользователь
вводит ClientSecret из кабинета клиента, который должна защищать сама служба на новом ПК.

## Матрица проверок

| Проверка                                             | Среда / доказательство                                                             | Статус                    |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------- |
| Приложение клиента, нужные scopes, принятый redirect | Регистрация владельцем, публичный ClientID и безопасное описание настроек          | PASS (UI)                 |
| Code + S256 без ClientSecret                         | macOS, живой grant; HTTP status/наличие нужных полей, без значений токенов         | PASS (HTTP 200)           |
| Неверный verifier и replay code                      | Отдельные попытки с безопасными кодами отказов                                     | NOT RUN                   |
| Refresh без секрета                                  | Тот же ClientID и refresh grant, затем разрешённая операция app:/                  | FAIL (400 invalid_client) |
| Refresh с ClientSecret                               | Прямой token endpoint, затем app:/ и тот же аккаунт, всё HTTP 200                  | PASS (macOS)              |
| Истечение/отзыв/повторный вход                       | Безопасный код ошибки и переход в reauth_required                                  | NOT RUN                   |
| Одинаковая папка после смены ПК                      | Два профиля с прежним ClientID и тем же аккаунтом                                  | NOT RUN                   |
| Смена ClientID                                       | Чужой контекст не использует старый refresh; прежний профиль сохранён после cancel | NOT RUN                   |
| Закрытый офис, LocalService refresh                  | Реальная Windows-служба, без процесса офиса, затем restart                         | NOT RUN                   |
| DPAPI/ACL, работа без Windows login                  | Новый запуск службы из собственного secret store                                   | NOT RUN                   |

Процесс/подпроцесс на macOS не закрывает Windows-пункты. PKCE grant сам по себе не закрывает refresh.
Успешный refresh не закрывает backup upload, проверку комплекта или restore drill.
Отрицательный вариант без секрета и положительный с секретом учитываются отдельно; не утверждать,
что прежняя схема без секрета заработала. Последующие секретные запросы требуют текущего разрешения
и защищённого пути передачи. Продуктовых и Windows-проверок этот результат не заменяет.

## Правила записи результатов

Фиксировать дату, ОС/версию, публичный ClientID (либо его отпечаток), scopes, redirect, тип
grant, факт отсутствия client_secret/Basic Authorization, HTTP status и безопасный error code.
Для refresh отдельно фиксировать рабочий доступ к папке после ответа и возможность restart.
Не сохранять request/response bodies с токенами, callback code/verifier/state, подписанные URLs,
пароли, recovery keys, скриншоты страницы с ClientSecret или настоящую базу предприятия.

Источники: [PKCE](https://yandex.ru/dev/id/doc/ru/codes/code-url),
[refresh](https://yandex.ru/dev/id/doc/ru/tokens/refresh-client),
[регистрация](https://yandex.ru/dev/id/doc/ru/register-auth),
[API-only redirect](https://yandex.ru/dev/id/doc/ru/register-api).
