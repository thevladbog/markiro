# Включение ключа офлайн-лицензий автонома

Выпуск подписанных офлайн-лицензий включается группой из четырёх записей
`markiro-production-runtime`: `STANDALONE_LICENSE_ISSUER`, `STANDALONE_LICENSE_KID`,
`STANDALONE_LICENSE_PRIVATE_KEY_PEM`, `STANDALONE_LICENSE_KEYSET_JSON`. Пока группы нет, API работает,
а подтверждение выпуска отвечает `409 standalone_license_signing_unavailable`.

## Изменение настройки

1. Проверьте ACTIVE-версию `markiro-production-runtime` и совпадение имён ключей с
   `.env.production.example`: все четыре имени группы либо присутствуют, либо отсутствуют целиком.
2. Создайте новую версию с явным `base-version-id` текущей версии и единственным изменением: четыре
   записи группы. Предыдущую версию сохраните для восстановления. Значения (закрытый PEM, набор
   открытых ключей) не выгружайте в terminal, CI output и чат.
3. Выпустите новый immutable release SHA и выполните защищённый `Deploy production`
   (`scope=api-only` достаточно) с точными run ID и SHA успешного `Publish production images`.
   Уже успешно развёрнутый SHA нельзя повторно активировать через `prepare`. Сохраните действующее
   состояние формы landing. Материализацию окружения и перезапуск API выполняет deployment.
4. Проверьте на карточке тенанта «Оборудование» в SaaS-админке, что выпуск офлайн-лицензии доступен.

Порядок ключей, формат набора и ротация — в `docs/operations/standalone-licenses.md`.
