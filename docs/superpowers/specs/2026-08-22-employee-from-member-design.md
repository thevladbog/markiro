# Создание оператора/сотрудника из зарегистрированного пользователя

Дата: 2026-08-22. Статус: одобрено пользователем (линковать сразу).

## Проблема

В админке «Операторы и сотрудники» операторы создаются только вручную (ФИО +
должность), хотя человек может уже быть зарегистрированным участником кабинета.
Связка `cabinet_employee_links` существует, но создаётся только со стороны
страницы «Команда» (`PUT /team/members/:id/employee`).

## Решение

При создании сотрудника дать выбор источника: «Ввести вручную» (как сейчас) или
«Выбрать из зарегистрированных». Во втором режиме показывается список участников
кабинета без привязанного сотрудника; выбор подставляет ФИО и должность
(редактируемые), а при сохранении сотрудник создаётся и сразу линкуется с
участником в одной транзакции.

## API (apps/api/src/modules/employees)

1. `GET /employees/linkable-members` — новый эндпоинт под
   `CABINET_CAPABILITY.OPERATIONS_WRITE` (список нужен только для формы
   создания; не требуем `MEMBERS_MANAGE`). Возвращает
   `{ items: [{ memberId, email, firstName, lastName, middleName, position }] }`
   для участников тенанта без записи в `cabinet_employee_links`, сортировка по
   email.
2. `POST /employees` — `createEmployeeSchema` получает опциональный
   `memberId: uuid`. Если передан:
   - участник проверяется в рамках тенанта (иначе 404);
   - в той же транзакции, что employee + pickup policy, создаётся
     `cabinet_employee_links` и audit-событие
     `team.member.employee_linked` (actor = текущий пользователь);
   - конкурентная линковка того же участника (unique index
     `cabinet_employee_links_tenant_member_uq`) → 409 Conflict.

## Admin UI (apps/admin/src/pages/employees)

- `api.ts`: `CreateEmployeeInput.memberId?: string | null`, тип
  `LinkableMemberDto`, хук `useLinkableMembers()` (ключ
  `["employees", "linkable-members"]`), инвалидация этого ключа при создании
  сотрудника.
- `EmployeeProfileForm.tsx` (режим `create`): RadioGroup «Источник» —
  `manual` / `member`. В режиме `member` — Select участников
  (метка: ФИО в порядке «фамилия имя отчество», fallback — email; должность в
  подписи). Выбор префиллит `fullName` и `role`; поля остаются редактируемыми.
  Сабмит в режиме `member` без выбранного участника — ошибка валидации.
  Пустой список — подсказка «нет доступных участников»; ошибка загрузки —
  inline-alert, ручной режим продолжает работать. В режиме `edit` ничего не
  меняется.
- i18n: новые ключи в `pages.employees.form` (ru/en).

## Тесты

- `apps/api/test/employees.e2e.test.ts`: linkable-members отдаёт владельца и
  скрывает его после линковки; создание с `memberId` создаёт связь (видно в
  БД/`GET /team`); повторный `memberId` → 409; чужой `memberId` → 404.
- `apps/admin/test/employees-routing.test.tsx` (или employees.test.tsx):
  переключение источника, префилл из выбранного участника, отправка
  `memberId`, валидация «участник не выбран».
