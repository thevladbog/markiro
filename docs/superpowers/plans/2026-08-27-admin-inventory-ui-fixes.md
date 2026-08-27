# Admin Inventory UI Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Исправить визуальные и UX-дефекты раздела «Инвентаризации» тенантной админки, найденные на скриншот-ревью всех шагов (список, создание, подготовка, терминалы, запуск, ход, закрытие, документы), плюс один API-баг генерации документов.

**Architecture:** Все правки локальны разделу `apps/admin/src/pages/inventory/` и его CSS; статусные тона выносятся в общий модуль раздела; переиспользуется `StatusChip` из `@markiro/ui` (проп `glyph` уже существует). Последняя задача — API (`inventory-document-runner`).

**Tech Stack:** React 19, react-i18next, vitest + Testing Library (apps/admin/test), CSS (`inventory.css`), NestJS + drizzle (задача 9).

## Global Constraints

- Тексты UI — русский в `apps/admin/src/i18n/ru.json`, английский в `en.json`; ключи добавлять/удалять в обоих файлах.
- Никаких инлайн-стилей в страницах админки — только классы в `apps/admin/src/pages/inventory/inventory.css`.
- Прогон перед сдачей: `pnpm --filter @markiro/admin test`, `pnpm --filter @markiro/admin typecheck`, `pnpm --filter @markiro/admin lint`, `pnpm format:check` (форматировать только затронутые пути — НЕ `prettier --write .`).
- Тестовый фильтр по файлу: `pnpm --filter @markiro/admin exec vitest run test/<file>` (`test -- <name>` не фильтрует).

**Контекст (как воспроизвести скриншоты):** одноразовая БД `markiro_admin_shots` в контейнере `sscc-00-format-postgres-1` (порт 5432), API — конфиг `api-shots` из `.claude/launch.json` (NODE_ENV=test), admin — конфиг `admin`; логин `shots@example.com` / `Password123!`, организация «ООО Демо Разлив». Сид: `/tmp/admin-shots/seed-flow.sh`. Скриншоты: `screenshots/admin-inventory/`.

---

### Task 1: Расклеить «Этап 1Параметры» — display:flex в stacked-подписях

Скриншоты `02-create`, `03-detail-draft`, `03-detail-ready`: «Этап 1Параметры», «ЭмитированEMITTED», «Линия розлива 1Назначено терминалов: 0» слиплись. Причина: в `inventory.css` вторая группа селекторов задаёт `flex-direction: column`, но не задаёт `display: flex` — spans остаются inline.

**Files:**

- Modify: `apps/admin/src/pages/inventory/inventory.css:174-182`
- Test: `apps/admin/test/inventory-css.test.ts` (новый)

**Interfaces:**

- Produces: класс-контракт `.mk-inventory-steps li > span:last-child { display: flex; … }` — используется задачами 1–6 как образец source-contract теста.

- [ ] **Step 1: Написать падающий source-contract тест**

```ts
// apps/admin/test/inventory-css.test.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(join(__dirname, "../src/pages/inventory/inventory.css"), "utf8");

describe("inventory.css contracts", () => {
  it("stacks step/upload/terminal captions as a flex column", () => {
    expect(css).toMatch(
      /\.mk-inventory-steps li > span:last-child,[^{]+\{[^}]*display:\s*flex;[^}]*flex-direction:\s*column;/s,
    );
  });
});
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `pnpm --filter @markiro/admin exec vitest run test/inventory-css.test.ts`
Expected: FAIL (нет `display: flex` в этой группе).

- [ ] **Step 3: Добавить display:flex во вторую группу селекторов**

В `inventory.css` заменить блок:

```css
.mk-inventory-steps li > span:last-child,
.mk-inventory-upload-slot__header > span,
.mk-inventory-import-attempt > span,
.mk-inventory-terminal-line > span,
.mk-inventory-list__stack {
  flex-direction: column;
  align-items: flex-start;
  min-width: 0;
}
```

на:

```css
.mk-inventory-steps li > span:last-child,
.mk-inventory-upload-slot__header > span,
.mk-inventory-import-attempt > span,
.mk-inventory-terminal-line > span,
.mk-inventory-list__stack {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  min-width: 0;
}
```

- [ ] **Step 4: Прогнать тест**

Run: `pnpm --filter @markiro/admin exec vitest run test/inventory-css.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/admin/src/pages/inventory/inventory.css apps/admin/test/inventory-css.test.ts
git commit -m "fix(admin): stack inventory step and upload captions vertically"
```

### Task 2: Статусные чипы — разные цвета и глифы на всех экранах

Скриншоты `01-list`, `03-detail-*`: «Закрыта» и «Готова к запуску» оба синие (info); в деталке чип всегда серый (`status="neutral"` захардкожен в `InventoryDetailPage.tsx:133`). Нужна одна карта тонов+глифов на весь раздел.

**Files:**

- Create: `apps/admin/src/pages/inventory/status.ts`
- Modify: `apps/admin/src/pages/inventory/index.tsx:24-31,48-51` (убрать локальный `STATUS_TONE`, использовать общий)
- Modify: `apps/admin/src/pages/inventory/InventoryDetailPage.tsx:131-135`
- Modify: `apps/admin/src/pages/inventory/InventoryLivePage.tsx:53-56`
- Test: `apps/admin/test/inventory-status-chip.test.tsx` (новый)

**Interfaces:**

- Produces: `INVENTORY_STATUS_CHIP: Record<Inventory["status"], { status: StatusChipStatus; glyph: string }>` и `inventoryStatusChipProps(status: Inventory["status"]): { status: StatusChipStatus; glyph: string }`.
- Consumes: `StatusChip` из `@markiro/ui` (проп `glyph?: ReactNode | null` существует с PR #324).

- [ ] **Step 1: Написать падающий тест карты статусов**

```tsx
// apps/admin/test/inventory-status-chip.test.tsx
import { describe, expect, it } from "vitest";
import { INVENTORY_STATUS_CHIP } from "../src/pages/inventory/status.js";

describe("inventory status chips", () => {
  it("gives every status a distinct tone+glyph pair", () => {
    const pairs = Object.values(INVENTORY_STATUS_CHIP).map((c) => `${c.status}:${c.glyph}`);
    expect(new Set(pairs).size).toBe(pairs.length);
  });

  it("separates closed from ready and keeps running green", () => {
    expect(INVENTORY_STATUS_CHIP.ready.status).toBe("info");
    expect(INVENTORY_STATUS_CHIP.closed.status).not.toBe(INVENTORY_STATUS_CHIP.ready.status);
    expect(INVENTORY_STATUS_CHIP.running.status).toBe("ok");
  });
});
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `pnpm --filter @markiro/admin exec vitest run test/inventory-status-chip.test.tsx`
Expected: FAIL — модуля `status.ts` нет.

- [ ] **Step 3: Создать общий модуль статусов**

```ts
// apps/admin/src/pages/inventory/status.ts
import type { StatusChipStatus } from "@markiro/ui";

import type { Inventory } from "./schemas.js";

/** Единая карта тон+глиф для чипов статуса инвентаризации во всём разделе. */
export const INVENTORY_STATUS_CHIP: Record<
  Inventory["status"],
  { status: StatusChipStatus; glyph: string }
> = {
  draft: { status: "neutral", glyph: "–" },
  preparing: { status: "warn", glyph: "◷" },
  ready: { status: "info", glyph: "●" },
  running: { status: "ok", glyph: "✓" },
  closed: { status: "neutral", glyph: "■" },
  completed: { status: "neutral", glyph: "✓" },
};

export function inventoryStatusChipProps(status: Inventory["status"]) {
  return INVENTORY_STATUS_CHIP[status];
}
```

- [ ] **Step 4: Применить в списке**

В `index.tsx` удалить локальную константу `STATUS_TONE` (строки 24–31) и заменить использование:

```tsx
import { inventoryStatusChipProps } from "./status.js";
// в колонке number:
<StatusChip
  {...inventoryStatusChipProps(row.status)}
  label={t(`pages.inventory.status.${row.status}`)}
/>;
```

- [ ] **Step 5: Применить в деталке и live**

`InventoryDetailPage.tsx` (строка 133):

```tsx
<StatusChip
  {...inventoryStatusChipProps(inventory.status)}
  label={t(`pages.inventory.status.${inventory.status}`)}
/>
```

`InventoryLivePage.tsx` (строки 53–56): заменить условный `status={data.status === "running" ? "ok" : "neutral"}` на

```tsx
<StatusChip
  {...inventoryStatusChipProps(data.status)}
  label={t(`pages.inventory.status.${data.status}`)}
/>
```

- [ ] **Step 6: Прогнать тесты раздела**

Run: `pnpm --filter @markiro/admin exec vitest run test/inventory-status-chip.test.tsx test/inventory-routing.test.tsx test/inventory-live.test.tsx`
Expected: PASS (если снапшоты/тексты в существующих тестах завязаны на старый чип — обновить ожидания в них, не ослабляя проверки).

- [ ] **Step 7: Commit**

```bash
git add apps/admin/src/pages/inventory/status.ts apps/admin/src/pages/inventory/index.tsx apps/admin/src/pages/inventory/InventoryDetailPage.tsx apps/admin/src/pages/inventory/InventoryLivePage.tsx apps/admin/test/inventory-status-chip.test.tsx
git commit -m "feat(admin): distinct tone+glyph chips for inventory statuses"
```

### Task 3: Единый заголовок деталки и хода инвентаризации

Скриншоты `03-detail-draft` («ИНВ-00001») и `03-detail-running` («Инвентаризация ИНВ-00013»): live-страница дублирует слово «Инвентаризация». Привести к короткой форме `inventory.number`.

**Files:**

- Modify: `apps/admin/src/pages/inventory/InventoryLivePage.tsx:47`
- Modify: `apps/admin/src/i18n/ru.json`, `apps/admin/src/i18n/en.json` (удалить неиспользуемый ключ `pages.inventory.live.title`)
- Test: `apps/admin/test/inventory-live.test.tsx` (обновить ожидание заголовка, если оно есть)

**Interfaces:**

- Consumes: `inventory.number: string` из `useInventory` (уже в компоненте).

- [ ] **Step 1: Найти и обновить ожидание в тесте live-страницы**

В `apps/admin/test/inventory-live.test.tsx` найти проверку заголовка (поиск по `Инвентаризация` / `live.title`). Если есть — заменить ожидание на короткий номер, например:

```tsx
expect(screen.getByRole("heading", { level: 1, name: "ИНВ-00013" })).toBeDefined();
```

Если проверки нет — добавить её в существующий рендер-тест live-страницы.

- [ ] **Step 2: Убедиться, что тест падает**

Run: `pnpm --filter @markiro/admin exec vitest run test/inventory-live.test.tsx`
Expected: FAIL (заголовок пока «Инвентаризация ИНВ-…»).

- [ ] **Step 3: Заменить заголовок**

`InventoryLivePage.tsx` строка 47:

```tsx
<h1>{inventory.number}</h1>
```

Удалить ключ `live.title` из `ru.json` и `en.json` (`grep -rn '"title"' apps/admin/src/i18n/*.json` в блоке `pages.inventory.live`).

- [ ] **Step 4: Прогнать тест**

Run: `pnpm --filter @markiro/admin exec vitest run test/inventory-live.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/admin/src/pages/inventory/InventoryLivePage.tsx apps/admin/src/i18n/ru.json apps/admin/src/i18n/en.json apps/admin/test/inventory-live.test.tsx
git commit -m "fix(admin): unify inventory detail and live page titles"
```

### Task 4: Стилизованный выбор файла вместо нативного «Choose File»

Скриншот `03-detail-draft`: шесть нативных `<input type="file">` с английским «Choose File / No file chosen». Заменить на кнопку в стиле дизайн-системы, скрыв нативный контрол.

**Files:**

- Create: `apps/admin/src/pages/inventory/FilePickerButton.tsx`
- Modify: `apps/admin/src/pages/inventory/InventoryDetailPage.tsx:258-270` (блок `<Input type="file" …>`)
- Modify: `apps/admin/src/pages/inventory/inventory.css` (заменить `.mk-inventory-file-control`)
- Test: `apps/admin/test/inventory-file-picker.test.tsx` (новый)

**Interfaces:**

- Produces: `FilePickerButton({ label, accept, disabled, busyLabel, busy, onFile }: { label: string; accept: string; disabled?: boolean; busy?: boolean; busyLabel: string; onFile: (file: File) => void })`.
- Consumes: `Button` из `@markiro/ui`; ключи i18n `pages.inventory.exports.chooseFile` (уже есть) и новый `pages.inventory.exports.uploading`.

- [ ] **Step 1: Написать падающий тест компонента**

```tsx
// apps/admin/test/inventory-file-picker.test.tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FilePickerButton } from "../src/pages/inventory/FilePickerButton.js";

describe("FilePickerButton", () => {
  it("opens the hidden input and forwards the picked file", () => {
    const onFile = vi.fn();
    render(
      <FilePickerButton label="Выбрать файл" busyLabel="Загрузка…" accept=".csv" onFile={onFile} />,
    );
    const input = screen.getByTestId("file-picker-input") as HTMLInputElement;
    expect(input.type).toBe("file");
    expect(input.className).toContain("mk-file-picker__input");
    const file = new File(["a"], "chz.csv", { type: "text/csv" });
    fireEvent.change(input, { target: { files: [file] } });
    expect(onFile).toHaveBeenCalledWith(file);
    expect(input.value).toBe("");
    expect(screen.getByRole("button", { name: "Выбрать файл" })).toBeDefined();
  });
});
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `pnpm --filter @markiro/admin exec vitest run test/inventory-file-picker.test.tsx`
Expected: FAIL — компонента нет.

- [ ] **Step 3: Реализовать компонент**

```tsx
// apps/admin/src/pages/inventory/FilePickerButton.tsx
import { useRef } from "react";
import { Button } from "@markiro/ui";

/** Кнопка дизайн-системы поверх скрытого нативного file-инпута. */
export function FilePickerButton({
  label,
  busyLabel,
  accept,
  disabled = false,
  busy = false,
  onFile,
}: {
  label: string;
  busyLabel: string;
  accept: string;
  disabled?: boolean;
  busy?: boolean;
  onFile: (file: File) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <span className="mk-file-picker">
      <input
        ref={inputRef}
        data-testid="file-picker-input"
        className="mk-file-picker__input"
        type="file"
        accept={accept}
        tabIndex={-1}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          if (file) onFile(file);
          event.currentTarget.value = "";
        }}
      />
      <Button
        variant="secondary"
        disabled={disabled || busy}
        onClick={() => inputRef.current?.click()}
      >
        {busy ? busyLabel : label}
      </Button>
    </span>
  );
}
```

CSS в `inventory.css` (заменить блок `.mk-inventory-file-control { margin: 12px 0; }`):

```css
.mk-file-picker {
  display: inline-flex;
  margin: 12px 0;
}

.mk-file-picker__input {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
}
```

- [ ] **Step 4: Заменить использование в деталке**

В `InventoryDetailPage.tsx` заменить блок `<Input className="mk-inventory-file-control" … type="file" …/>` на:

```tsx
<FilePickerButton
  label={t("pages.inventory.exports.chooseFile")}
  busyLabel={t("pages.inventory.exports.uploading")}
  accept=".csv,.zip,.xlsx"
  disabled={!canMutate}
  busy={upload.isPending}
  onFile={(file) => upload.mutate({ inventoryId: inventory.id, status, file })}
/>
```

Сохранить `aria-label` семантику: передавать label через окружающий `<label>`/`aria`, как было (`t("pages.inventory.exports.fileLabel", { status })`) — добавить проп `ariaLabel?: string`, если тест доступности этого требует. Добавить ключи:

- `ru.json`: `"uploading": "Загрузка…"` в `pages.inventory.exports`
- `en.json`: `"uploading": "Uploading…"`

- [ ] **Step 5: Прогнать тесты**

Run: `pnpm --filter @markiro/admin exec vitest run test/inventory-file-picker.test.tsx test/inventory-preparation.test.tsx`
Expected: PASS (в `inventory-preparation.test.tsx` заменить обращения к старому инпуту на `file-picker-input`, если он там используется).

- [ ] **Step 6: Commit**

```bash
git add apps/admin/src/pages/inventory/FilePickerButton.tsx apps/admin/src/pages/inventory/InventoryDetailPage.tsx apps/admin/src/pages/inventory/inventory.css apps/admin/src/i18n/ru.json apps/admin/src/i18n/en.json apps/admin/test/inventory-file-picker.test.tsx apps/admin/test/inventory-preparation.test.tsx
git commit -m "feat(admin): styled file picker for CHZ export uploads"
```

### Task 5: Live-метрики не алармят на нулях

Скриншоты `03-detail-running`, `03-detail-closed`: «Не найдено 0» — оранжевая, «Расхождения 0» — красная. Тон должен включаться только при ненулевом значении.

**Files:**

- Modify: `apps/admin/src/pages/inventory/InventoryLivePage.tsx:65-90` (вызовы `LiveMetric`)
- Test: `apps/admin/test/inventory-live.test.tsx`

**Interfaces:**

- Consumes: существующий `LiveMetric({ label, value, tone })` в том же файле — сигнатура не меняется.

- [ ] **Step 1: Написать падающий тест**

Добавить в `apps/admin/test/inventory-live.test.tsx` (рядом с существующим рендером live-страницы с нулевым прогрессом):

```tsx
it("keeps zero metrics neutral and colors only non-zero ones", () => {
  const missing = screen.getByText("Не найдено").closest(".mk-inventory-live-metric")!;
  expect(missing.className).not.toContain("mk-inventory-live-metric--warn");
  const discrepancies = screen.getByText("Расхождения").closest(".mk-inventory-live-metric")!;
  expect(discrepancies.className).not.toContain("mk-inventory-live-metric--error");
});
```

(Точную обвязку рендера взять из существующих тестов файла — там уже есть фикстура прогресса; при необходимости добавить второй кейс с ненулевыми значениями и обратными ожиданиями.)

- [ ] **Step 2: Убедиться, что тест падает**

Run: `pnpm --filter @markiro/admin exec vitest run test/inventory-live.test.tsx`
Expected: FAIL

- [ ] **Step 3: Сделать тон условным**

В `InventoryLivePage.tsx`:

```tsx
<LiveMetric
  label={t("pages.inventory.live.verified")}
  value={formatCount(data.verifiedCount, i18n.language)}
  tone={data.verifiedCount > 0 ? "ok" : undefined}
/>
<LiveMetric
  label={t("pages.inventory.live.missing")}
  value={formatCount(data.missingCount, i18n.language)}
  tone={data.missingCount > 0 ? "warn" : undefined}
/>
<LiveMetric
  label={t("pages.inventory.live.discrepancies")}
  value={formatCount(
    data.ineligibleCount + data.unknownCount + data.dateMismatchCount,
    i18n.language,
  )}
  tone={
    data.ineligibleCount + data.unknownCount + data.dateMismatchCount > 0
      ? "error"
      : undefined
  }
/>
```

- [ ] **Step 4: Прогнать тест**

Run: `pnpm --filter @markiro/admin exec vitest run test/inventory-live.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/admin/src/pages/inventory/InventoryLivePage.tsx apps/admin/test/inventory-live.test.tsx
git commit -m "fix(admin): live inventory metrics stay neutral at zero"
```

### Task 6: Чип «N из M терминалов в сети» не разваливается

Скриншот `03-detail-ready`: чип на шаге «Терминалы» переполняется — глиф в пилюле, текст выпал под неё. Чип не должен сжиматься и переносить текст.

**Files:**

- Modify: `apps/admin/src/pages/inventory/inventory.css` (блок `.mk-inventory-terminal-line`, строка ~250)
- Test: `apps/admin/test/inventory-css.test.ts`

- [ ] **Step 1: Дополнить source-contract тест**

```ts
it("keeps the terminal-line chip on one line", () => {
  expect(css).toMatch(
    /\.mk-inventory-terminal-line > \.mk-chip\s*\{[^}]*flex-shrink:\s*0;[^}]*white-space:\s*nowrap;/s,
  );
});
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `pnpm --filter @markiro/admin exec vitest run test/inventory-css.test.ts`
Expected: FAIL

- [ ] **Step 3: Добавить правило**

После блока `.mk-inventory-terminal-line { justify-content: space-between; }` в `inventory.css`:

```css
.mk-inventory-terminal-line > .mk-chip {
  flex-shrink: 0;
  white-space: nowrap;
}
```

- [ ] **Step 4: Прогнать тест**

Run: `pnpm --filter @markiro/admin exec vitest run test/inventory-css.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/admin/src/pages/inventory/inventory.css apps/admin/test/inventory-css.test.ts
git commit -m "fix(admin): terminal online chip no longer wraps"
```

### Task 7: Ширина колонки «Номер / Статус» в списке

Скриншот `01-list`: первая колонка занимает ~40% ширины при коротком содержимом — между статусом и продуктом пустота. `TableColumn` поддерживает `width`.

**Files:**

- Modify: `apps/admin/src/pages/inventory/index.tsx:39-53` (колонка `number`)
- Test: `apps/admin/test/inventory-routing.test.tsx` (или существующий тест списка — обновить, если он проверяет колонки)

- [ ] **Step 1: Задать ширину колонки**

В определении колонки `number` в `index.tsx` добавить `width`:

```tsx
{
  key: "number",
  title: t("pages.inventory.list.number"),
  width: 240,
  mono: true,
  render: (row) => ( /* без изменений */ ),
},
```

- [ ] **Step 2: Прогнать тесты списка и просмотреть глазами**

Run: `pnpm --filter @markiro/admin exec vitest run test/inventory-routing.test.tsx`
Expected: PASS. Затем открыть `http://localhost:5173/inventory` (стек из «Контекста» выше) и убедиться, что колонка сжалась, а статус стоит рядом с номером.

- [ ] **Step 3: Commit**

```bash
git add apps/admin/src/pages/inventory/index.tsx
git commit -m "fix(admin): compact number/status column in inventory list"
```

### Task 8: Ограничить ширину деталки — убрать пустую правую половину

Скриншоты `02-create`, `05-draft-step1-parameters`: степпер тянется на всю ширину 1920, карточка — 860px, справа пустота. Ограничить контентную колонку деталки/создания и выровнять степпер с карточкой.

**Files:**

- Modify: `apps/admin/src/pages/inventory/inventory.css:1-5` (блок `.mk-inventory-page`)
- Test: `apps/admin/test/inventory-css.test.ts`

- [ ] **Step 1: Дополнить source-contract тест**

```ts
it("caps the detail page content width", () => {
  expect(css).toMatch(/\.mk-inventory-page\s*\{[^}]*max-width:\s*1200px;/s);
});
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `pnpm --filter @markiro/admin exec vitest run test/inventory-css.test.ts`
Expected: FAIL

- [ ] **Step 3: Ограничить ширину страницы**

```css
.mk-inventory-page {
  display: flex;
  flex-direction: column;
  gap: 16px;
  max-width: 1200px;
}
```

Внимание: класс используется и списком (`index.tsx:89`) — список с таблицей тоже станет 1200px, это осознанное выравнивание раздела. Если существующие тесты завязаны на полную ширину — обновить.

- [ ] **Step 4: Прогнать тест и просмотреть глазами**

Run: `pnpm --filter @markiro/admin exec vitest run test/inventory-css.test.ts`
Expected: PASS. Открыть `/inventory/new` и деталку черновика на 1920×1080 — контент не должен выглядеть прижатым к левому краю с пустой половиной справа.

- [ ] **Step 5: Commit**

```bash
git add apps/admin/src/pages/inventory/inventory.css apps/admin/test/inventory-css.test.ts
git commit -m "fix(admin): cap inventory pages content width"
```

### Task 9: API — генерация документов падает GENERATION_FAILED на пустой инвентаризации

Скриншот `10-closed-bottom`: закрытая инвентаризация без единого скана → все 8 форматов падают `GENERATION_FAILED`, из-за чего «Завершить инвентаризацию» недостижимо. Пустой результат — валидный кейс (миграция `0084_inventory_document_artifact_empty_files` явно узаконила пустые файлы).

**Files:**

- Test: `apps/api/test/inventory-document-runner.test.ts` (добавить кейс)
- Modify: `apps/api/src/modules/inventories/inventory-document-runner.service.ts` (точное место укажет воспроизведение)

**Interfaces:**

- Consumes: существующие фикстуры/хелперы `inventory-document-runner.test.ts` (там уже есть сценарии рендера ранов — использовать их обвязку).

- [ ] **Step 1: Воспроизвести тестом**

В `apps/api/test/inventory-document-runner.test.ts` добавить кейс по образцу соседних: закрытая инвентаризация, у которой ноль событий/строк результата во всех источниках (`verified`, `protected`, `newBoxes` и т.д.), затем запуск обработчика рана для всех восьми форматов. Ожидание (желаемое поведение):

```ts
expect(run.status).toBe("succeeded");
expect(artifacts.every((a) => a.byteSize !== null)).toBe(true);
```

- [ ] **Step 2: Убедиться, что тест падает как на проде**

Run: `cd apps/api && pnpm exec vitest run test/inventory-document-runner.test.ts`
Expected: FAIL — статус `failed`, `errorCode: "GENERATION_FAILED"`. Зафиксировать в выводе реальное исключение рендерера (лог воркера печатает stack) — это и есть точное место фикса.

- [ ] **Step 3: Исправить рендерер по факту воспроизведения**

Править `inventory-document-runner.service.ts` (или конкретный формат-генератор, который бросил исключение из Step 2): пустой источник должен давать пустой файл (заголовок CSV/пустой XML-корень), а не исключение. Не менять контракт `INVENTORY_DOCUMENT_ARTIFACTS_NOT_READY` в `complete`.

- [ ] **Step 4: Прогнать тест**

Run: `cd apps/api && pnpm exec vitest run test/inventory-document-runner.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api/test/inventory-document-runner.test.ts apps/api/src/modules/inventories/
git commit -m "fix(api): render empty inventory documents instead of GENERATION_FAILED"
```

---

## Финальная проверка

- [ ] `pnpm --filter @markiro/admin test && pnpm --filter @markiro/admin typecheck && pnpm --filter @markiro/admin lint`
- [ ] `pnpm format:check`
- [ ] Прогнать скриншот-скрипт заново по стеку из «Контекста» и сравнить с `screenshots/admin-inventory/` (слипания исчезли, чипы разноцветные, файл-кнопки локализованы, нули нейтральны).
