<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./docs/assets/readme/logo-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="./docs/assets/readme/logo.svg">
    <img alt="Маркиро" src="./docs/assets/readme/logo.svg" width="280" height="64">
  </picture>
</p>

<p align="center"><a href="./README.md">English</a> · <strong>Русский</strong></p>

<p align="center">
  Offline-first процессы для «Честного знака»: сериализация, агрегация, прослеживаемость и работа производственной линии.
</p>

<p align="center">
  <a href="https://github.com/thevladbog/markiro/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/thevladbog/markiro/actions/workflows/ci.yml/badge.svg?branch=main"></a>
  <a href="https://github.com/thevladbog/markiro/actions/workflows/codeql.yml"><img alt="CodeQL" src="https://github.com/thevladbog/markiro/actions/workflows/codeql.yml/badge.svg"></a>
  <img alt="Node.js 24+" src="https://img.shields.io/badge/Node.js-24%2B-339933?logo=nodedotjs&logoColor=white">
  <img alt="pnpm 11.22" src="https://img.shields.io/badge/pnpm-11.22-F69220?logo=pnpm&logoColor=white">
  <img alt="TypeScript 6" src="https://img.shields.io/badge/TypeScript-6-3178C6?logo=typescript&logoColor=white">
  <img alt="Docker" src="https://img.shields.io/badge/Docker-ready-2496ED?logo=docker&logoColor=white">
  <img alt="PostgreSQL 17" src="https://img.shields.io/badge/PostgreSQL-17-4169E1?logo=postgresql&logoColor=white">
  <img alt="Tauri 2" src="https://img.shields.io/badge/Tauri-2-24C8DB?logo=tauri&logoColor=white">
  <a href="./LICENSE"><img alt="Проприетарная лицензия" src="https://img.shields.io/badge/License-Proprietary-17161A"></a>
</p>

![Скриншот линейной станции «Маркиро»](./docs/assets/readme/station.webp)

<p align="center"><em>Режим агрегации на линейной станции с поддержкой автономной работы — рендер встроенной галереи экранов приложения на фикстурных данных.</em></p>

## Что такое «Маркиро»?

«Маркиро» — единая промышленная платформа для российских производственных процессов с «Честным знаком». Она объединяет кабинет, линейную станцию, киоск, агрегацию и печать этикеток, прослеживаемость и внешние интеграции, не требуя постоянного подключения для безопасной работы производства.

Платформа учитывает реальные производственные условия: несколько терминалов в одной смене, локальные журналы устройств, отклонение дубликатов и кодов с чужим GTIN, деградацию оборудования, аудируемые действия по восстановлению и последующую синхронизацию с сервером.

## Зачем нужен продукт

- **Чтобы линия не останавливалась.** Станция и киоск сохраняют локальное состояние и восстанавливают работу после возвращения подключения.
- **Чтобы отклонять некорректные данные на месте.** Общая логика GS1/GTIN/KM выявляет повреждённые коды, дубликаты и коды другого товара до того, как они создадут проблемы в отчётности.
- **Чтобы агрегировать и печатать единообразно.** Пулы SSCC, операции с коробами и вывод в ZPL/TSPL опираются на общие доменные правила.
- **Чтобы замкнуть цикл инвентаризации.** Задания инвентаризации, пересчёт и переупаковка на станции и генерация документов ГИС МТ заменяют ручной обмен файлами с государственной системой.
- **Чтобы каждая граница безопасности была явной.** Для данных арендаторов, сессий кабинета, учётных данных устройств и идентификации операторов действуют отдельные механизмы контроля.
- **Чтобы интегрироваться с действующими системами.** API, обмен CommerceML/1C и агент подписания для True API «Честного знака» связывают «Маркиро» с существующими системами предприятия, сохраняя offline-first подход к восстановлению производства.

## Интерфейсы продукта

<table>
  <tr>
    <td width="50%"><a href="./docs/assets/readme/admin.webp"><img alt="Скриншот админ-панели «Маркиро»" src="./docs/assets/readme/admin.webp"></a></td>
    <td width="50%"><a href="./docs/assets/readme/kiosk.webp"><img alt="Скриншот киоска выдачи «Маркиро»" src="./docs/assets/readme/kiosk.webp"></a></td>
  </tr>
  <tr>
    <td><strong>Админ-панель.</strong> Обзор, товары, смены, инвентаризации, шаблоны этикеток, интеграции, биллинг, доступ в кабинет и операционный аудит.</td>
    <td><strong>Киоск «Выбытие».</strong> Выдача сотрудникам по пропускам с локальными лимитами, offline-снимками, очередью заказов и восстановлением.</td>
  </tr>
</table>

<p align="center"><em>Админ-панель снята на работающем локальном API с демонстрационными данными; экран киоска отрисован его собственными компонентами на фикстурных данных.</em></p>

## Основные возможности

| Область           | Что реализовано                                                                                                       |
| ----------------- | --------------------------------------------------------------------------------------------------------------------- |
| Коды и валидация  | Контрольные цифры GS1, нормализация GTIN, разбор KM, классификация сканов, обработка дубликатов и ошибок              |
| Производство      | Смены, сканирование на нескольких терминалах, offline-журналы, синхронизация, конфликты, действия операторов, дашборд |
| Агрегация         | Пулы SSCC, короба, этикетки коробов, аудит расформирования и повторной печати, общее состояние агрегации              |
| Инвентаризация    | Задания инвентаризации, пересчёт и переупаковка на станции, корректировки и поздние события, документы ГИС МТ         |
| Этикетки          | WYSIWYG-шаблоны, растеризация кириллицы, генерация ZPL/TSPL, привязка к товарам и сменам                              |
| Выбытие           | Сопряжённые киоски, распознавание пропусков, дневные лимиты, offline-очередь и карантин, сверка с кабинетом           |
| «Честный знак»    | Агент подписания для аутентификации в True API, шифрованное хранение токена, товарные группы, выгрузки статусов кодов |
| SaaS и интеграции | Мультитенантный кабинет, роли и возможности, биллинг и лимиты, обмен CommerceML/1C, почта, объектное хранилище        |

## Архитектура

```mermaid
flowchart LR
  Admin["Admin · React/Vite"] --> API["NestJS API"]
  Kiosk["Kiosk · React/Vite PWA"] --> API
  Station["Station · Tauri 2 + React"] -. "sync when connected" .-> API
  Station --> SQLite["Local SQLite journal"]
  Signer["Signer · Tauri 2 + React"] -- "True API token" --> API
  API -. "True API" .-> CHZ["Chestny ZNAK"]
  API --> PG["PostgreSQL 17"]
  Shared["domain · db · ui · email · platform-contracts"] --> Admin
  Shared --> Kiosk
  Shared --> Station
  Shared --> Signer
  Shared --> API
```

Подробнее о границах арендаторов, аутентификации, хранении данных, offline-синхронизации, развёртывании и эксплуатационных компромиссах — в [документе об архитектуре](./docs/architecture.md).

## Быстрый запуск

### Требования

- Node.js 24 или новее
- Corepack и pnpm 11.22.0
- Docker с Docker Compose

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm --filter '@markiro/api^...' --filter '@markiro/admin^...' build
if [ ! -e .env ]; then
  cp .env.example .env
fi
docker compose -f docker-compose.dev.yml up -d
set -a
source .env
set +a
pnpm --filter @markiro/db db:migrate
pnpm --filter @markiro/api dev
```

Запустите админ-панель в другом терминале:

```bash
pnpm --filter @markiro/admin dev
```

Админ-панель доступна по адресу `http://localhost:5173`; API и обозреватель Scalar OpenAPI — по адресам `http://localhost:3000` и `http://localhost:3000/docs`. Стек разработки также открывает Mailpit на `http://localhost:8025` и MinIO Console на `http://localhost:9001`. Значения из `.env.example` предназначены только для разработки.

<details>
<summary>Создать первого владельца арендатора</summary>

Соберите API, затем создайте активацию, не сохраняя пароль в истории командной оболочки:

```bash
pnpm --filter @markiro/api build
pnpm --silent --filter @markiro/api provision:tenant-owner -- \
  --email owner@example.com \
  --tenant-name "Первый завод" \
  --tenant-slug first-factory
```

Для одной и той же пары арендатора и адреса электронной почты команда идемпотентна и выводит только идентификаторы. Используйте `--renew-activation` только для неиспользованной активации с истёкшим сроком действия.
</details>

## Разработка

```text
apps/
  api/         NestJS API, auth, jobs, integrations
  admin/       React/Vite production cabinet
  kiosk/       Offline-first pickup PWA
  station/     Tauri/React line workstation
  signer/      Tauri/React Chestny ZNAK signing agent (Windows)
  landing/     Public marketing website
  saas-admin/  SaaS operator panel
packages/
  domain/              GS1, KM, SSCC, labels, shared policy
  db/                  PostgreSQL schema, migrations, SQLite mirror
  platform-contracts/  Shared platform, tenant, and agent API schemas
  email/               Transactional email templates
  ui/                  Shared design tokens and React components
  legal-documents/     Legal document sources and rendering
```

Точечная проверка во время разработки:

```bash
pnpm --filter @markiro/domain test
pnpm --filter @markiro/api exec vitest run test/relevant-file.test.ts
```

Полная проверка:

```bash
pnpm turbo lint typecheck test build --concurrency=1 --force
pnpm format:check
```

Для тестов, работающих с базой данных, требуется экспортированная переменная `DATABASE_URL`. Сообщайте отдельно о намеренно пропущенных тестах и проверках во внешней среде, браузере или на оборудовании.

## Документация

- [Руководство для агентов](./AGENTS.md)
- [Архитектура](./docs/architecture.md)
- [Дизайн-брифы](./docs/design-briefs/)
- [Эксплуатационные runbook’и](./docs/runbooks/)
- [Планы реализации](./docs/superpowers/plans/)
- [Дорожная карта MVP](./docs/superpowers/plans/2026-07-21-markiro-mvp-roadmap.md)
- [Обозреватель OpenAPI](http://localhost:3000/docs), когда API запущен

## Контрибуции, безопасность и поддержка

- Внешние контрибуции не принимаются; см. [CONTRIBUTING.md](./CONTRIBUTING.md).
- Об уязвимостях сообщайте приватно; см. [SECURITY.md](./SECURITY.md).
- Вопросы, баг-репорты и коммерческая лицензия — см. [SUPPORT.md](./SUPPORT.md).

## Лицензия

Copyright © 2026 Vladislav Bogatyrev. Репозиторий является проприетарным; все права защищены. Полный текст — в файле [LICENSE](./LICENSE).
