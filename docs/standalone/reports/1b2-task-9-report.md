# Task 9: Документация — Завершено

## Изменения в файлах

### 1. `apps/standalone/AGENTS.md`

Сделаны три изменения:

**П1 — Раздел "Network and TLS":** Заменён целиком с расширением описания TLS-клиента:

- Уточнено, что вебвью вызывает хост через команду shell
- Добавлены детали о `FingerprintPolicy::Pin`, таймаутах, и обработке ошибок
- Объяснено, что `certificate_mismatch` — это ошибка, полученная из цепи ошибок TLS
- Добавлено описание `host_request`: какие методы и маршруты он пропускает
- Уточнено, что ключ устройства не попадает в вебвью для маршрутов подключения

**П2 — Новый раздел "Device key and office session":** Добавлен после "Network and TLS":

- Описание хранения ключа в `device.json` в `app_local_data_dir` (а не `app_config_dir`)
- DPAPI на Windows, файл 0600 на других ОС
- Предупреждение о перемещаемых профилях (ведут к клонированию устройства)
- Описание сессии офиса (только в памяти вебвью, управление через хост)
- Функция смены пароля всеми офисными пользователями
- Обработка ошибок по кодам в `src/host/errors.ts`
- i18n и проверки форм

**П3 — Последний пункт "Verification":** Заменён с уточнением о тестировании DPAPI:

- Уточнено, что `standalone-windows-build` job компилирует AND тестирует через DPAPI
- Явно сказано, что настоящий профиль Windows, сервис, и киоск-режим требуют ручной проверки
- Результат на macOS не доказывает ничего Windows-специфичного

### 2. `apps/standalone/README.md`

**П4 — Пункт 2 раздела "Development":** Расширен с описанием поведения приложения:

- Добавлено описание поведения на свежем хосте (мастер) и инициализированном хосте (автоподключение)
- Описание экрана офиса через «Офис»
- Путь сохранения паiring в `device.json` в `app_local_data_dir`
- Специфичные пути для Windows (`%LOCALAPPDATA%\app.markiro.standalone`) и macOS (`~/Library/Application Support/app.markiro.standalone`)
- Инструкция удалить файл для переподключения

### 3. `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`

Изменения в разделе "### 5.2. Rust-часть приложения":

**П5a — Пункт "Клиент хоста":** Заменён с расширением команд и описанием маршрутов:

- Добавлены команды `device_status()` и `device_forget()`
- Добавлено описание `host_request`: какие маршруты он пропускает (`/v1/device[/…]`, `/v1/bootstrap`, `/v1/office/…`)
- Объяснено, что маршруты подключения возвращают ключ и доступны только своими командами
- Уточнено, что ключ не попадает в вебвью

**П5б — Пункт "Конфигурация устройства":** Заменён первый абзац:

- Уточнено, что `device.json` в `app_local_data_dir` (а не просто "каталог конфигурации")
- На Windows: `%LOCALAPPDATA%`, НЕ перемещаемый профиль
- Объяснение почему: ключ и отпечаток уйдут с профилем на другой ПК и устройство раздвоится
- Оставлено без изменений описание DPAPI и нижние ОС

## Проверки

### Prettier

```bash
node_modules/.bin/prettier --write apps/standalone/AGENTS.md apps/standalone/README.md docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md
```

**Результат:**

```
apps/standalone/AGENTS.md 45ms (unchanged)
apps/standalone/README.md 5ms (unchanged)
docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md 64ms (unchanged)
```

```bash
node_modules/.bin/prettier --check apps/standalone/AGENTS.md apps/standalone/README.md docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md
```

**Результат:**

```
Checking formatting...
All matched files use Prettier code style!
```

### git diff --check

```bash
git diff --check
```

**Результат:** нет вывода (все окей)

### Prettier не переформатировал неотредактированные части

Prettier прошёл без изменений (`unchanged`) — значит, он не переносил строки и не переформатировал ничего за пределами отредактированных строк.

## Коммит

```bash
git add apps/standalone/AGENTS.md apps/standalone/README.md docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md
git commit -m "docs(standalone): ключ устройства, сессия офиса и первый запуск приложения" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Проверка коммита

```bash
git log -1 --format=%B
```

**Результат:**

```
docs(standalone): ключ устройства, сессия офиса и первый запуск приложения

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

**SHA:** 63f2c99 (8 символов)

## Итоги

- ✅ П1: "Network and TLS" заменён дословно
- ✅ П2: "Device key and office session" добавлен дословно
- ✅ П3: Последний пункт Verification заменён дословно
- ✅ П4: Пункт 2 Development заменён дословно
- ✅ П5: Два пункта в 5.2 изменены дословно (остальное не тронуто)
- ✅ П6: Один коммит с тремя файлами, mensaje и трейлер ровно как в задаче
- ✅ Prettier: нет переносов в неотредактированных частях, все окей
- ✅ git diff --check: нет ошибок
- ✅ git log: трейлер ровно совпадает с требуемым
