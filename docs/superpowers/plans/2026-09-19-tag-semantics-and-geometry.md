# Единая семантика и геометрия тегов — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** развести глиф и тон тега, чтобы глиф отвечал за фазу жизненного цикла, тон — за требуемое внимание, и привести все теги кабинета к единой геометрии 22px.

**Architecture:** `packages/ui` получает словарь из 11 фаз, тон `done`, четыре категорийных тона и общий CSS-класс `.mk-tag` с тремя именованными размерами. `StatusChip` перестаёт принимать тон и принимает фазу; `Badge` остаётся тегом категории и счётчика. Приложения переписывают таблицы соответствий в терминах фаз; ни одна страница больше не выбирает тон самостоятельно.

**Tech Stack:** TypeScript (strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), React 19, Vitest + jsdom + Testing Library, CSS-переменные без препроцессора, pnpm workspace, Turbo.

## Global Constraints

- Спека: `docs/superpowers/specs/2026-09-19-tag-semantics-and-geometry-design.md`. Она согласована; отступления требуют отдельного решения.
- Высота тега в кабинете — ровно 22px, поля `0 8px`, зазор 5px, скругление `var(--r-1)`, рамка 1px, шрифт 600 12px, коробка глифа ровно 12×12px.
- Серый тон `neutral` допустим только в фазах `draft`, `retired`, `dismantled`, `none`. Ни одна фаза завершения не может быть серой.
- Глиф выводится только из фазы. Ни одно приложение не назначает тон и не назначает глиф.
- Категорийные тона назначаются внутри одной оси в фиксированном порядке `violet`, `teal`, `magenta`, `steel`.
- Моноширинный шрифт остаётся только у числового и кодового содержимого, через явный признак `mono`.
- Киоск сохраняет высоту 40px, станция — 34px. Уменьшать их нельзя: это принятые решения о читаемости с расстояния.
- Каждый тег несёт глиф **и** подпись. Цвет никогда не является единственным носителем смысла.
- `@markiro/ui` экспортирует скомпилированный `dist`. После изменений в пакете и перед тестами потребителей выполняется `pnpm --filter @markiro/ui build`.
- TypeScript строгий: никаких `any`, `!` и широких приведений. Типы только `import type`.
- Коммиты на ветке `claude/tag-size-alignment-b781d4`. Стадировать только явные пути.

## Порядок и зависимости

Задачи 1–4 меняют `packages/ui` и выполняются строго по порядку: каждая следующая опирается на типы предыдущей. Задача 5 снимает накладки станции и киоска и обязана идти сразу за 4, иначе эти поверхности временно сломаются. Задачи 6–14 независимы друг от друга и могут выполняться в любом порядке после 5. Задача 15 опирается на результат всех предыдущих и идёт после них. Задача 16 — финальная.

## Структура файлов

| Файл                                                                         | Ответственность                                                  | Задача  |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------- | ------- |
| `packages/ui/src/tokens.css`                                                 | токен `done` и четыре категорийных токена, светлая и тёмная темы | 1       |
| `packages/ui/vitest.config.ts`                                               | виртуальный модуль с исходником `tokens.css` для тестов          | 1       |
| `packages/ui/test/tokens.test.ts`                                            | новый: паритет светлой и тёмной темы для новых токенов           | 1       |
| `packages/ui/src/components.css`                                             | класс `.mk-tag`, размеры, тона, коробка глифа                    | 2       |
| `packages/ui/src/components/StatusChip.tsx`                                  | словарь фаз, проп `phase`, проп `size`                           | 3       |
| `packages/ui/src/components/Badge.tsx`                                       | категорийные тона, проп `size`, проп `mono`                      | 4       |
| `packages/ui/src/components/index.ts`                                        | экспорт `TagPhase`, `TagSize`; снятие `StatusChipStatus`         | 3, 4    |
| `packages/ui/test/components.test.tsx`                                       | тесты обоих компонентов                                          | 2, 3, 4 |
| `apps/station/src/station.css`, `apps/station/src/ui/ShiftCard.tsx`          | размер `floor` вместо мёртвых правил                             | 5       |
| `apps/kiosk/src/ui/StatusStrip.tsx`                                          | размер `wall` вместо инлайнового стиля                           | 5       |
| страницы `apps/admin`, `apps/saas-admin`                                     | таблицы соответствий в терминах фаз                              | 6–13    |
| `apps/signer/src/pages/Status.tsx`, `packages/ui/src/entitlements/index.tsx` | механическая миграция                                            | 14      |

---

### Задача 1: Токены `done` и категорийные

**Files:**

- Modify: `packages/ui/src/tokens.css` (блок `:root`, около строки 55; блок `[data-theme="dark"]`, около строки 120)
- Modify: `packages/ui/vitest.config.ts:8-22`
- Create: `packages/ui/test/tokens.test.ts`
- Modify: `packages/ui/test/styles.d.ts`

**Interfaces:**

- Consumes: ничего.
- Produces: CSS-переменные `--done-fg`, `--done-bg`, `--done-border`; `--cat-violet-fg`, `--cat-violet-bg`, `--cat-violet-border`; те же тройки для `teal`, `magenta`, `steel`. Задачи 2–4 ссылаются на них по этим именам.

- [ ] **Шаг 1: Расширить виртуальный модуль тестов исходником токенов**

В `packages/ui/vitest.config.ts` заменить тело плагина `ui-test-raw-css`:

```ts
    {
      name: "ui-test-raw-css",
      enforce: "pre",
      resolveId(source) {
        return source === "virtual:ui-component-styles" || source === "virtual:ui-token-styles"
          ? `\0${source}`
          : undefined;
      },
      load(id) {
        if (id === "\0virtual:ui-component-styles") {
          const styles = readFileSync(new URL("./src/components.css", import.meta.url), "utf8");
          return `export default ${JSON.stringify(styles)}`;
        }

        if (id === "\0virtual:ui-token-styles") {
          const styles = readFileSync(new URL("./src/tokens.css", import.meta.url), "utf8");
          return `export default ${JSON.stringify(styles)}`;
        }

        return undefined;
      },
    },
```

В `packages/ui/test/styles.d.ts` добавить второе объявление:

```ts
declare module "virtual:ui-component-styles" {
  const content: string;
  export default content;
}

declare module "virtual:ui-token-styles" {
  const content: string;
  export default content;
}
```

- [ ] **Шаг 2: Написать падающий тест**

Создать `packages/ui/test/tokens.test.ts`:

```ts
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import tokenStyles from "virtual:ui-token-styles";

const NEW_TOKENS = [
  "--done-fg",
  "--done-bg",
  "--done-border",
  "--cat-violet-fg",
  "--cat-violet-bg",
  "--cat-violet-border",
  "--cat-teal-fg",
  "--cat-teal-bg",
  "--cat-teal-border",
  "--cat-magenta-fg",
  "--cat-magenta-bg",
  "--cat-magenta-border",
  "--cat-steel-fg",
  "--cat-steel-bg",
  "--cat-steel-border",
] as const;

beforeAll(() => {
  const style = document.createElement("style");
  style.textContent = tokenStyles;
  document.head.append(style);
});

afterEach(() => {
  document.documentElement.dataset.theme = "";
});

describe("токены тегов", () => {
  /**
   * Тёмная тема — не украшение: цех и склад работают на ней. Токен, забытый
   * в блоке [data-theme="dark"], молча наследует светлое значение и даёт
   * нечитаемую подпись, поэтому паритет проверяется явно.
   */
  it.each(NEW_TOKENS)("объявляет %s в обеих темах разными значениями", (token) => {
    document.documentElement.dataset.theme = "";
    const light = getComputedStyle(document.documentElement).getPropertyValue(token).trim();

    document.documentElement.dataset.theme = "dark";
    const dark = getComputedStyle(document.documentElement).getPropertyValue(token).trim();

    expect(light).toMatch(/^#[0-9a-f]{6}$/);
    expect(dark).toMatch(/^#[0-9a-f]{6}$/);
    expect(dark).not.toBe(light);
  });

  it("держит тон done отдельно от ok и от neutral", () => {
    const root = getComputedStyle(document.documentElement);
    expect(root.getPropertyValue("--done-fg").trim()).not.toBe(
      root.getPropertyValue("--ok-fg").trim(),
    );
    expect(root.getPropertyValue("--done-fg").trim()).not.toBe(
      root.getPropertyValue("--fg-2").trim(),
    );
  });
});
```

- [ ] **Шаг 3: Запустить тест и убедиться, что он падает**

```bash
pnpm --filter @markiro/ui exec vitest run test/tokens.test.ts
```

Ожидается: падение на первом же токене — `expect(received).toMatch(...)` получает пустую строку, потому что `--done-fg` не объявлен.

- [ ] **Шаг 4: Добавить токены в светлую тему**

В `packages/ui/src/tokens.css`, сразу после блока `semantic: syncing` (перед строкой `--focus-ring: #1a4f9c;`), вставить:

```css
/* semantic: завершено штатно — остывший зелёный.
     Отделён от --ok-* насыщенностью, от --fg-2 оттенком: закрытая смена не
     «идёт» и не «архив». Контраст подписи к фону 6.30:1. */
--done-fg: #3f5e4a;
--done-bg: #edf2ee;
--done-border: #dae4dd;

/* Категорийные тона: равноправные виды, а не статусы. Насыщенность ниже
     статусной намеренно — ошибка обязана кричать громче категории.
     Оттенки удалены от статусных (5°, 35°, 150°, 215°). */
--cat-violet-fg: #563091;
--cat-violet-bg: #f1ebfb;
--cat-violet-border: #e2d6f5;
--cat-teal-fg: #0e5b63;
--cat-teal-bg: #e2f3f5;
--cat-teal-border: #c9e6ea;
--cat-magenta-fg: #8e2a63;
--cat-magenta-bg: #fbe9f3;
--cat-magenta-border: #f4d5e7;
--cat-steel-fg: #3f4756;
--cat-steel-bg: #ebedf1;
--cat-steel-border: #d9dde4;
```

- [ ] **Шаг 5: Добавить токены в тёмную тему**

В блоке `[data-theme="dark"]`, сразу после тройки `--info-*` (перед строкой `--focus-ring: #6db2ff;`), вставить:

```css
--done-fg: #9cc2a9;
--done-bg: #1a251d;
--done-border: #2c3d32; /* 7.91:1 */

--cat-violet-fg: #b3a0e0;
--cat-violet-bg: #241c3a;
--cat-violet-border: #3b2f5c; /* 6.72:1 */
--cat-teal-fg: #79c4cb;
--cat-teal-bg: #0f2b2f;
--cat-teal-border: #1c484e; /* 7.30:1 */
--cat-magenta-fg: #e094ba;
--cat-magenta-bg: #32172a;
--cat-magenta-border: #532642; /* 6.82:1 */
--cat-steel-fg: #a9b3c4;
--cat-steel-bg: #1f212a;
--cat-steel-border: #353947; /* 7.36:1 */
```

- [ ] **Шаг 6: Запустить тест и убедиться, что он проходит**

```bash
pnpm --filter @markiro/ui exec vitest run test/tokens.test.ts
```

Ожидается: PASS, 16 тестов.

- [ ] **Шаг 7: Коммит**

```bash
git add packages/ui/src/tokens.css packages/ui/vitest.config.ts packages/ui/test/tokens.test.ts packages/ui/test/styles.d.ts
git commit -m "feat(ui): токен done и четыре категорийных тона"
```

---

### Задача 2: Класс `.mk-tag` — единая геометрия

**Files:**

- Modify: `packages/ui/src/components.css` (добавить блок в конец файла)
- Modify: `packages/ui/test/components.test.tsx:44-52` (блок `beforeAll`)

**Interfaces:**

- Consumes: токены из задачи 1.
- Produces: классы `.mk-tag`, `.mk-tag--office`, `.mk-tag--floor`, `.mk-tag--wall`, `.mk-tag--wrap`, `.mk-tag--mono`, `.mk-tag__glyph` и десять классов тона `.mk-tag--{neutral,ok,done,warn,error,info,violet,teal,magenta,steel}`. Задачи 3 и 4 навешивают их через `cn`.

- [ ] **Шаг 1: Убедиться, что тесты компонентов подгружают токены**

Открыть `packages/ui/test/components.test.tsx`, найти блок `beforeAll` (около строки 44) и привести его к виду, который уже используется в `operational-components.test.tsx`:

```tsx
beforeAll(() => {
  const style = document.createElement("style");
  style.textContent = `${tokenStyles}\n${componentStyles}`;
  document.head.append(style);
});
```

Добавить импорт рядом с существующим импортом `componentStyles`:

```tsx
import tokenStyles from "virtual:ui-token-styles";
```

- [ ] **Шаг 2: Написать падающий тест на геометрию**

Тесты геометрии живут в задаче 4, а не здесь: они обращаются к пропам `phase` и `size` и к тону `violet`, которых до задач 3 и 4 не существует, и любой написанный сейчас тест оставил бы `typecheck` красным на двух задачах подряд. Класс проверяется там, где появляется его потребитель.

- [ ] **Шаг 2: Добавить класс `.mk-tag` в components.css**

В конец `packages/ui/src/components.css` добавить:

```css
/* Теги. Одна геометрия для тега фазы (StatusChip) и тега категории (Badge):
   раньше они различались на 8px высоты и читались как два разных набора.
   Геометрия живёт здесь, а не в инлайновом style компонента, — иначе
   накладки приложений молча проигрывают инлайну и оказываются мёртвыми. */
.mk-tag {
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid transparent;
  border-radius: var(--r-1);
  font-family: var(--font-ui);
  line-height: 1;
  white-space: nowrap;
}

.mk-tag--office {
  height: 22px;
  min-height: 22px;
  min-width: 22px;
  gap: 5px;
  padding: 0 8px;
  font-size: 12px;
  font-weight: 600;
}

.mk-tag--floor {
  height: 34px;
  min-height: 34px;
  min-width: 34px;
  gap: 7px;
  padding: 0 14px;
  font-size: 15px;
  font-weight: 700;
}

.mk-tag--wall {
  height: 40px;
  min-height: 40px;
  min-width: 40px;
  gap: 8px;
  padding: 0 16px;
  font-size: 16px;
  font-weight: 600;
}

.mk-tag__glyph {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
}

/* Натуральная ширина у ✓ ✕ ⧉ ⟳ ▸ разная, поэтому без фиксированной коробки
   подписи в столбце тегов не встают друг под друга. */
.mk-tag--office .mk-tag__glyph {
  width: 12px;
  height: 12px;
  font-size: 11px;
}

.mk-tag--floor .mk-tag__glyph {
  width: 16px;
  height: 16px;
  font-size: 15px;
}

.mk-tag--wall .mk-tag__glyph {
  width: 18px;
  height: 18px;
  font-size: 17px;
}

.mk-tag--mono {
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
}

/* Идёт после размеров намеренно: специфичность та же, решает порядок. */
.mk-tag--wrap {
  height: auto;
  white-space: normal;
}

.mk-tag--neutral {
  border-color: var(--line);
  background: var(--surface-panel);
  color: var(--fg-2);
}

.mk-tag--ok {
  border-color: var(--ok-border);
  background: var(--ok-bg);
  color: var(--ok-fg);
}

.mk-tag--done {
  border-color: var(--done-border);
  background: var(--done-bg);
  color: var(--done-fg);
}

.mk-tag--warn {
  border-color: var(--warn-border);
  background: var(--warn-bg);
  color: var(--warn-fg);
}

.mk-tag--error {
  border-color: var(--err-border);
  background: var(--err-bg);
  color: var(--err-fg);
}

.mk-tag--info {
  border-color: var(--info-border);
  background: var(--info-bg);
  color: var(--info-fg);
}

.mk-tag--violet {
  border-color: var(--cat-violet-border);
  background: var(--cat-violet-bg);
  color: var(--cat-violet-fg);
}

.mk-tag--teal {
  border-color: var(--cat-teal-border);
  background: var(--cat-teal-bg);
  color: var(--cat-teal-fg);
}

.mk-tag--magenta {
  border-color: var(--cat-magenta-border);
  background: var(--cat-magenta-bg);
  color: var(--cat-magenta-fg);
}

.mk-tag--steel {
  border-color: var(--cat-steel-border);
  background: var(--cat-steel-bg);
  color: var(--cat-steel-fg);
}
```

- [ ] **Шаг 3: Убедиться, что существующие тесты пакета не сломались**

```bash
pnpm --filter @markiro/ui exec vitest run
pnpm --filter @markiro/ui typecheck
```

Ожидается: PASS. Новый CSS пока никем не используется и ничего не должен менять; подключение токенов в `beforeAll` — единственное изменение в тестах.

- [ ] **Шаг 4: Коммит**

```bash
git add packages/ui/src/components.css packages/ui/test/components.test.tsx
git commit -m "feat(ui): класс mk-tag с единой геометрией и тремя размерами"
```

---

### Задача 3: `StatusChip` принимает фазу

**Files:**

- Modify: `packages/ui/src/components/StatusChip.tsx` (полная замена)
- Modify: `packages/ui/src/components/index.ts:42-43`
- Modify: `packages/ui/test/components.test.tsx:199-219`

**Interfaces:**

- Consumes: классы `.mk-tag*` из задачи 2, токены из задачи 1.
- Produces:
  - `type TagPhase = "draft" | "planned" | "active" | "running" | "done" | "attention" | "duplicate" | "failed" | "retired" | "dismantled" | "none"`
  - `type TagSize = "office" | "floor" | "wall"`
  - `interface StatusChipProps { phase: TagPhase; label: ReactNode; size?: TagSize }` плюс остальные атрибуты `<span>`, кроме `children`
  - `const PHASE_GLYPH: Record<TagPhase, string>` — экспортируется для теста инварианта в задаче 15
  - Типы `StatusChipStatus` и проп `solid` удалены; задачи 6–14 обязаны на них не ссылаться.

- [ ] **Шаг 1: Переписать тесты `StatusChip` под фазы**

В `packages/ui/test/components.test.tsx` заменить весь блок `describe("StatusChip", ...)` на:

```tsx
describe("StatusChip", () => {
  /**
   * Инвариант всей затеи. Раньше глиф читался из тона таблицей STATUS, и
   * активная смена получала галочку только потому, что её тон оказался `ok`.
   * Теперь фаза выбирает и глиф, и тон, а вызывающая сторона — ни того, ни
   * другого.
   */
  it.each([
    ["draft", "✎"],
    ["planned", "◷"],
    ["active", "▸"],
    ["running", "⟳"],
    ["done", "✓"],
    ["attention", "!"],
    ["duplicate", "⧉"],
    ["failed", "✕"],
    ["retired", "✕"],
    ["dismantled", "⊘"],
    ["none", "·"],
  ] as const)("фаза %s рисует глиф %s", (phase, glyph) => {
    const { container } = render(<StatusChip phase={phase} label="Подпись" />);

    expect(container.querySelector(".mk-tag__glyph")?.textContent).toBe(glyph);
    expect(screen.getByText("Подпись")).toBeDefined();
  });

  it("не даёт серый тон ни одной фазе завершения", () => {
    const { container } = render(<StatusChip phase="done" label="Закрыта" />);
    const chip = container.querySelector(".mk-tag");

    expect(chip?.className).toContain("mk-tag--done");
    expect(chip?.className).not.toContain("mk-tag--neutral");
  });

  it("сохраняет класс-зацепку mk-chip для накладок приложений", () => {
    const { container } = render(<StatusChip phase="active" label="Активна" />);
    expect(container.querySelector(".mk-chip")).not.toBeNull();
  });

  it("по умолчанию берёт офисный размер", () => {
    const { container } = render(<StatusChip phase="active" label="Активна" />);
    expect(container.querySelector(".mk-tag")?.className).toContain("mk-tag--office");
  });
});
```

- [ ] **Шаг 2: Запустить тесты и убедиться, что они падают**

```bash
pnpm --filter @markiro/ui exec vitest run test/components.test.tsx -t "StatusChip"
```

Ожидается: ошибка типов — проп `phase` не существует у `StatusChipProps`.

- [ ] **Шаг 3: Переписать компонент**

Полностью заменить содержимое `packages/ui/src/components/StatusChip.tsx`:

```tsx
import type { HTMLAttributes, ReactNode } from "react";

import { cn } from "../cn.js";

/**
 * Тег фазы. Глиф и тон выводятся из фазы жизненного цикла и только из неё:
 * до этого глиф читался из тона (`ok` всегда давал `✓`), а тон назначался
 * заново на каждой странице, из-за чего активная смена получала галочку, а
 * отменённый документ — глиф дубликата.
 *
 * Словарь фаз и правило серого — в спеке
 * `docs/superpowers/specs/2026-09-19-tag-semantics-and-geometry-design.md`.
 */
export type TagPhase =
  | "draft"
  | "planned"
  | "active"
  | "running"
  | "done"
  | "attention"
  | "duplicate"
  | "failed"
  | "retired"
  | "dismantled"
  | "none";

/** Кабинет, цех и настенный планшет читают с разного расстояния. */
export type TagSize = "office" | "floor" | "wall";

type PhaseTone = "neutral" | "ok" | "done" | "warn" | "error" | "info";

interface PhaseConfig {
  glyph: string;
  tone: PhaseTone;
}

/**
 * `failed` и `retired` делят глиф `✕` намеренно: форма исхода у них одна —
 * терминальный отрицательный результат, а различается срочность, и её несёт
 * тон. Серый допустим только здесь: draft, retired, dismantled, none.
 */
const PHASE: Record<TagPhase, PhaseConfig> = {
  draft: { glyph: "✎", tone: "neutral" },
  planned: { glyph: "◷", tone: "info" },
  active: { glyph: "▸", tone: "ok" },
  running: { glyph: "⟳", tone: "info" },
  done: { glyph: "✓", tone: "done" },
  attention: { glyph: "!", tone: "warn" },
  duplicate: { glyph: "⧉", tone: "warn" },
  failed: { glyph: "✕", tone: "error" },
  retired: { glyph: "✕", tone: "neutral" },
  dismantled: { glyph: "⊘", tone: "neutral" },
  none: { glyph: "·", tone: "neutral" },
};

export const PHASE_GLYPH: Record<TagPhase, string> = Object.fromEntries(
  Object.entries(PHASE).map(([phase, config]) => [phase, config.glyph]),
) as Record<TagPhase, string>;

export const PHASE_TONE: Record<TagPhase, string> = Object.fromEntries(
  Object.entries(PHASE).map(([phase, config]) => [phase, config.tone]),
) as Record<TagPhase, string>;

export interface StatusChipProps extends Omit<HTMLAttributes<HTMLSpanElement>, "children"> {
  phase: TagPhase;
  /**
   * Подпись обязательна: тег без слова читается только по цвету, а цвет не
   * может быть единственным носителем смысла. Переводом занимается вызывающая
   * сторона — компонент не знает про i18n.
   */
  label: ReactNode;
  size?: TagSize;
}

export function StatusChip({ phase, label, size = "office", className, ...rest }: StatusChipProps) {
  const config = PHASE[phase];

  return (
    <span
      className={cn(
        "mk-tag",
        `mk-tag--${size}`,
        `mk-tag--${config.tone}`,
        "mk-chip",
        `mk-chip--${phase}`,
        className,
      )}
      {...rest}
    >
      <span className="mk-tag__glyph" aria-hidden="true">
        {config.glyph}
      </span>
      <span>{label}</span>
    </span>
  );
}
```

- [ ] **Шаг 4: Обновить экспорты**

В `packages/ui/src/components/index.ts` заменить строки 42–43:

```ts
export { StatusChip } from "./StatusChip.js";
export type { StatusChipProps, TagPhase, TagSize } from "./StatusChip.js";
```

`PHASE_GLYPH` и `PHASE_TONE` наружу намеренно не выходят. Публичный способ узнать тон фазы — это и есть та дыра, через которую в приложения вернётся выбор тона вручную; тест инварианта в задаче 16 импортирует их прямо из `../src/components/StatusChip.js`. По той же причине в `apps/signer/src/pages/Status.tsx` не возникает конфликта имён с его локальной таблицей.

- [ ] **Шаг 5: Запустить тесты и убедиться, что они проходят**

```bash
pnpm --filter @markiro/ui exec vitest run test/components.test.tsx -t "StatusChip"
```

Ожидается: PASS, 14 тестов.

- [ ] **Шаг 6: Коммит**

```bash
git add packages/ui/src/components/StatusChip.tsx packages/ui/src/components/index.ts packages/ui/test/components.test.tsx
git commit -m "feat(ui): StatusChip выводит глиф и тон из фазы жизненного цикла"
```

---

### Задача 4: `Badge` получает категорийные тона

**Files:**

- Modify: `packages/ui/src/components/Badge.tsx` (полная замена)
- Modify: `packages/ui/src/components/index.ts:39-40`
- Modify: `packages/ui/test/components.test.tsx:1288-1332`

**Interfaces:**

- Consumes: классы `.mk-tag*` из задачи 2, токены из задачи 1.
- Produces:
  - `type BadgeTone = "neutral" | "ok" | "warn" | "error" | "info" | "violet" | "teal" | "magenta" | "steel"`
  - `interface BadgeProps { tone?: BadgeTone; size?: TagSize; mono?: boolean; wrap?: boolean }`
  - Тон `accent` удалён; задачи 6–14 обязаны на него не ссылаться.

- [ ] **Шаг 1: Переписать тесты `Badge`**

В `packages/ui/test/components.test.tsx` заменить весь блок `describe("Badge", ...)` на:

```tsx
describe("Badge", () => {
  it("рисует счётчик моноширинно по явному признаку", () => {
    render(<Badge mono>12</Badge>);
    const badge = screen.getByText("12");

    expect(badge.className).toContain("mk-tag--neutral");
    expect(badge.className).toContain("mk-tag--mono");
  });

  /**
   * Словесная подпись моноширинной быть не должна: у IBM Plex Mono пробел в
   * полную ячейку, и двухсловный тег читается с двойным пробелом. В station.css
   * это лечилось вручную через word-spacing: -0.35ch.
   */
  it("не включает моно для словесной подписи", () => {
    render(<Badge>Разобрана</Badge>);
    expect(screen.getByText("Разобрана").className).not.toContain("mk-tag--mono");
  });

  it.each(["violet", "teal", "magenta", "steel"] as const)(
    "поддерживает категорийный тон %s",
    (tone) => {
      render(<Badge tone={tone}>Агрегация</Badge>);
      expect(screen.getByText("Агрегация").className).toContain(`mk-tag--${tone}`);
    },
  );

  /**
   * Дефолт остаётся nowrap: однословный тег, разорванный на две строки, хуже
   * широкого, и на это опирается каждая существующая точка вызова.
   */
  it("держит короткий тег в одну строку на фиксированной высоте", () => {
    render(<Badge>Разобрана</Badge>);
    const badge = screen.getByText("Разобрана");

    expect(badge.className).toContain("mk-tag--office");
    expect(badge.className).not.toContain("mk-tag--wrap");
    expect(getComputedStyle(badge).height).toBe("22px");
  });

  /**
   * `wrap` нужен длинной подписи в узкой колонке: nowrap заставляет тег
   * отдавать всю строку в min-content колонки, из-за чего таблицу паллет в
   * панели смены выносило в горизонтальное переполнение и тег обрезало.
   */
  it("даёт длинной подписи перенос и рост выше одной строки", () => {
    render(<Badge wrap>Состав изменился после закрытия</Badge>);
    const badge = screen.getByText("Состав изменился после закрытия");

    expect(badge.className).toContain("mk-tag--wrap");
    expect(getComputedStyle(badge).height).toBe("auto");
    expect(getComputedStyle(badge).minHeight).toBe("22px");
  });

  it("сохраняет класс-зацепку mk-badge для накладок приложений", () => {
    render(<Badge>Разобрана</Badge>);
    expect(screen.getByText("Разобрана").className).toContain("mk-badge");
  });

  it("всё ещё позволяет вызывающей стороне переопределить перенос через style", () => {
    render(
      <Badge wrap style={{ whiteSpace: "nowrap" }}>
        Состав изменился после закрытия
      </Badge>,
    );
    expect(screen.getByText("Состав изменился после закрытия").style.whiteSpace).toBe("nowrap");
  });
});

describe("геометрия тега", () => {
  /**
   * Смысл всей затеи: тег с глифом и тег без глифа обязаны иметь одну
   * высоту. Раньше это были 24px против 16px, и в ячейке таблицы смен они
   * читались как два несвязанных набора.
   */
  it("даёт одинаковую высоту тегу фазы и тегу категории", () => {
    render(
      <div>
        <StatusChip phase="done" label="Закрыта" />
        <Badge tone="violet">Валидация</Badge>
      </div>,
    );

    const chip = screen.getByText("Закрыта").closest(".mk-tag");
    const badge = screen.getByText("Валидация");

    expect(chip).not.toBeNull();
    expect(getComputedStyle(chip as Element).height).toBe("22px");
    expect(getComputedStyle(badge).height).toBe("22px");
  });

  it("держит коробку глифа квадратной, чтобы подписи вставали в колонку", () => {
    const { container } = render(<StatusChip phase="duplicate" label="Дубликат" />);

    const glyph = container.querySelector(".mk-tag__glyph");
    expect(glyph).not.toBeNull();

    const box = getComputedStyle(glyph as Element);
    expect(box.width).toBe("12px");
    expect(box.height).toBe("12px");
  });

  it.each([
    ["office", "22px"],
    ["floor", "34px"],
    ["wall", "40px"],
  ] as const)("размер %s даёт высоту %s", (size, height) => {
    render(<StatusChip phase="active" label="Активна" size={size} />);

    const chip = screen.getByText("Активна").closest(".mk-tag");
    expect(getComputedStyle(chip as Element).height).toBe(height);
  });
});
```

- [ ] **Шаг 2: Запустить тесты и убедиться, что они падают**

```bash
pnpm --filter @markiro/ui exec vitest run test/components.test.tsx -t "Badge"
```

Ожидается: ошибка типов — пропов `mono` и тона `violet` не существует.

- [ ] **Шаг 3: Переписать компонент**

Полностью заменить содержимое `packages/ui/src/components/Badge.tsx`:

```tsx
import type { HTMLAttributes } from "react";

import { cn } from "../cn.js";
import type { TagSize } from "./StatusChip.js";

/**
 * Тег категории и счётчика. Глифа не несёт никогда: глиф закреплён за фазой
 * жизненного цикла, и тег категории фазой не является.
 *
 * Категорийные тона равногромкие — среди них нет «лучшего» и нет «мёртвого».
 * До этого двум равноправным режимам смены доставались `neutral` и `accent`,
 * и «Валидация» читалась как архив, а «Агрегация» как успех.
 */
export type BadgeTone =
  "neutral" | "ok" | "warn" | "error" | "info" | "violet" | "teal" | "magenta" | "steel";

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
  size?: TagSize;
  /** Числа, коды и номера — моноширинно с табличными цифрами. Слова — нет. */
  mono?: boolean;
  /**
   * Разрешить длинной подписи перенос. Признак включается явно, потому что
   * nowrap-тег отдаёт всю свою строку в min-content контейнера, а в узкой
   * колонке таблицы это выталкивает остальные колонки и обрезает сам тег.
   */
  wrap?: boolean;
}

export function Badge({
  tone = "neutral",
  size = "office",
  mono = false,
  wrap = false,
  className,
  children,
  ...rest
}: BadgeProps) {
  return (
    <span
      className={cn(
        "mk-tag",
        `mk-tag--${size}`,
        `mk-tag--${tone}`,
        mono && "mk-tag--mono",
        wrap && "mk-tag--wrap",
        "mk-badge",
        `mk-badge--${tone}`,
        className,
      )}
      {...rest}
    >
      {children}
    </span>
  );
}
```

- [ ] **Шаг 4: Обновить экспорты**

В `packages/ui/src/components/index.ts` строки 39–40 остаются прежними по форме; убедиться, что они выглядят так:

```ts
export { Badge } from "./Badge.js";
export type { BadgeProps, BadgeTone } from "./Badge.js";
```

- [ ] **Шаг 5: Запустить весь набор тестов пакета**

```bash
pnpm --filter @markiro/ui exec vitest run
```

Ожидается: PASS целиком, включая блок «геометрия тега».

- [ ] **Шаг 6: Собрать пакет и прогнать гейты**

```bash
pnpm --filter @markiro/ui build
pnpm --filter @markiro/ui typecheck
pnpm --filter @markiro/ui lint
```

Ожидается: все три без ошибок.

- [ ] **Шаг 7: Коммит**

```bash
git add packages/ui/src/components/Badge.tsx packages/ui/src/components/index.ts packages/ui/test/components.test.tsx
git commit -m "feat(ui): Badge получает категорийные тона и явный моноширинный признак"
```

---

### Задача 5: Размеры для станции и киоска, снятие мёртвых накладок

**Files:**

- Modify: `apps/station/src/ui/ShiftCard.tsx:85-97`
- Modify: `apps/station/src/station.css:2300-2318`
- Modify: `apps/kiosk/src/ui/StatusStrip.tsx:94-122`

**Interfaces:**

- Consumes: `TagSize`, `TagPhase`, `StatusChip`, `Badge` из задач 3 и 4.
- Produces: ничего для последующих задач.

**Почему это обязано идти сразу за задачей 4.** Правила `.shift-card__heading .mk-chip { height: 34px; padding: 0 14px; border-radius: 999px; font: 700 15px/1 ... }` сегодня мертвы — инлайновый стиль компонента их перебивает. После переезда геометрии в классы они оживают и с удельным весом `(0,2,0)` побеждают `.mk-tag--floor`. Оставить их — значит получить два источника истины.

- [ ] **Шаг 1: Написать падающий тест на размер станции**

Создать `apps/station/test/shift-card-tag-size.test.tsx`. У `ShiftCardProps` обязательны `productName`, `counterpartyLabel`, `actionLabel`, `active`, `disabled` и `onSelect`, поэтому базовые пропы вынесены в хелпер:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ShiftCard } from "../src/ui/ShiftCard.js";

const base = {
  productName: "Сыр «Российский»",
  counterpartyLabel: "Контрагент",
  actionLabel: "Выбрать",
  active: false,
  disabled: false,
  onSelect: () => {},
} as const;

describe("теги карточки смены", () => {
  /**
   * Цех читает карточку с расстояния. Офисные 22px здесь нечитаемы, поэтому
   * размер задаётся пропом, а не накладкой в station.css: накладка была
   * мертва, её перебивал инлайновый стиль компонента.
   */
  it("берёт цеховой размер, а не офисный", () => {
    const { container } = render(
      <ShiftCard {...base} number="СМ-101" status="active" statusLabel="Активна" />,
    );

    const status = container.querySelector(".shift-card__status");
    expect(status?.className).toContain("mk-tag--floor");
    expect(status?.className).not.toContain("mk-tag--office");
  });

  it("ставит фазу active, а не галочку завершения", () => {
    const { container } = render(
      <ShiftCard {...base} number="СМ-101" status="active" statusLabel="Активна" />,
    );

    expect(container.querySelector(".shift-card__status .mk-tag__glyph")?.textContent).toBe("▸");
    expect(screen.getByText("Активна")).toBeDefined();
  });

  /**
   * `closing` — отдельная фаза: смена ещё не закрыта, закрытие идёт. Раньше
   * она попадала в ту же ветку, что и `planned`, и получала глиф ожидания.
   */
  it("отличает закрывающуюся смену от запланированной и от закрытой", () => {
    const closing = render(
      <ShiftCard {...base} number="СМ-101" status="closing" statusLabel="Закрывается" />,
    );
    expect(closing.container.querySelector(".shift-card__status .mk-tag__glyph")?.textContent).toBe(
      "⟳",
    );

    const closed = render(
      <ShiftCard {...base} number="СМ-102" status="closed" statusLabel="Закрыта" />,
    );
    expect(closed.container.querySelector(".shift-card__status .mk-tag__glyph")?.textContent).toBe(
      "✓",
    );
  });

  it("рисует номер смены тегом категории без глифа", () => {
    const { container } = render(
      <ShiftCard {...base} number="СМ-101" status="active" statusLabel="Активна" />,
    );

    const number = container.querySelector(".shift-card__number");
    expect(number?.className).toContain("mk-badge");
    expect(number?.querySelector(".mk-tag__glyph")).toBeNull();
  });
});
```

- [ ] **Шаг 2: Запустить тест и убедиться, что он падает**

```bash
pnpm turbo run build --filter='@markiro/station^...'
pnpm --filter @markiro/station exec vitest run test/shift-card-tag-size.test.tsx
```

Ожидается: падение — класса `mk-tag--floor` нет, номер смены рисуется `StatusChip` с `glyph={null}`.

- [ ] **Шаг 3: Переписать теги карточки смены**

В `apps/station/src/ui/ShiftCard.tsx` заменить блок строк 85–97:

```tsx
{
  number ? (
    <Badge className="shift-card__number" size="floor" mono>
      {number}
    </Badge>
  ) : null;
}
<StatusChip
  className="shift-card__status"
  size="floor"
  phase={SHIFT_CARD_STATUS_TO_PHASE[status ?? "planned"]}
  label={statusLabel ?? status}
/>;
```

Рядом с объявлением `ShiftCardProps` добавить таблицу — union здесь четырёхзначный, и `closing` это самостоятельная фаза, а не разновидность ожидания:

```tsx
const SHIFT_CARD_STATUS_TO_PHASE: Record<NonNullable<ShiftCardProps["status"]>, TagPhase> = {
  planned: "planned",
  active: "active",
  closing: "running",
  closed: "done",
};
```

Добавить `Badge` в существующий импорт из `@markiro/ui` в этом файле.

- [ ] **Шаг 4: Снять мёртвые правила из station.css**

В `apps/station/src/station.css` удалить блок, задающий геометрию (строки 2300–2308 в текущей редакции):

```css
/* Number and status render as floor-sized chips (like the status bar tags). */
.shift-card__heading .mk-chip {
  height: 34px;
  min-width: 0;
  padding: 0 14px;
  overflow: hidden;
  border-radius: 999px;
  font: 700 15px/1 var(--font-ui);
}
```

Заменить его на правило, которое оставляет только то, что размер не покрывает:

```css
/* Размер задан пропом size="floor"; здесь остаётся только обрезка длинного
   номера и подписи — геометрию трогать нельзя, она живёт в .mk-tag--floor. */
.shift-card__heading .mk-tag {
  min-width: 0;
  overflow: hidden;
}
```

Затем удалить блок `.shift-card__number.mk-chip { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }` целиком — его заменяет проп `mono`.

Блок `.shift-card__heading .mk-chip > span:last-child` оставить без изменений: он отвечает за многоточие в подписи и геометрии не задаёт. Заменить в его селекторе `.mk-chip` на `.mk-tag`.

- [ ] **Шаг 5: Запустить тест и убедиться, что он проходит**

```bash
pnpm --filter @markiro/station exec vitest run test/shift-card-tag-size.test.tsx
```

Ожидается: PASS, 3 теста.

- [ ] **Шаг 6: Перевести киоск на размер `wall`**

В `apps/kiosk/src/ui/StatusStrip.tsx` удалить строку с инлайновым стилем:

```tsx
const chip = { height: 40, padding: "0 16px", font: "600 16px/1 var(--font-ui)" } as const;
```

и заменить три точки вызова (строки 102, 108, 121) на:

```tsx
<StatusChip size="wall" phase={online ? "active" : "attention"} label={onlineLabel} />
```

```tsx
{
  age !== "fresh" ? <StatusChip size="wall" phase="attention" label={staleLabel} /> : null;
}
```

```tsx
{
  quarantined > 0 ? <StatusChip size="wall" phase="attention" label={quarantineLabel} /> : null;
}
```

Комментарий над строкой 94, объясняющий выбор 40px, переписать так, чтобы он ссылался на размер `wall`, а не на инлайновый стиль, и сохранял исходное обоснование про чтение с расстояния от настенного планшета.

В `apps/kiosk/src/kiosk.css` заменить `.kiosk-status-strip .mk-chip` на `.kiosk-status-strip .mk-tag` и `.kiosk-status-strip .mk-chip > span:last-child` на `.kiosk-status-strip .mk-tag > span:last-child`.

- [ ] **Шаг 7: Прогнать гейты станции и киоска**

```bash
pnpm turbo run build --filter='@markiro/kiosk^...'
pnpm --filter @markiro/station exec vitest run
pnpm --filter @markiro/kiosk exec vitest run
pnpm --filter @markiro/station typecheck
pnpm --filter @markiro/kiosk typecheck
```

Ожидается: всё зелёное. `UpdateCenter.tsx:133-135` в станции всё ещё использует старый проп — исправить его здесь же: `status={primarySource ? "ok" : "info"}` превращается в `phase={primarySource ? "active" : "planned"}`.

- [ ] **Шаг 8: Коммит**

```bash
git add apps/station/src/ui/ShiftCard.tsx apps/station/src/station.css apps/station/src/pages/UpdateCenter.tsx apps/station/test/shift-card-tag-size.test.tsx apps/kiosk/src/ui/StatusStrip.tsx apps/kiosk/src/kiosk.css
git commit -m "feat(station,kiosk): именованные размеры тегов вместо разовых накладок"
```

---

### Задача 6: Смены в кабинете

Это страница со скриншотов, с которых начался разбор. Здесь же исчезает главная претензия: серая «Закрыта» и зелёная «Агрегация» против серой «Валидации».

**Files:**

- Modify: `apps/admin/src/pages/shifts/index.tsx:36-44,186,199-205`
- Modify: `apps/admin/src/pages/shifts/ShiftDetailsPanel.tsx` (таблица соответствий, строки 454, 528, 257-264)
- Modify: `apps/admin/src/pages/shifts/export-history.tsx` (таблица соответствий, строка 235)
- Modify: `apps/admin/src/pages/shifts/shifts.css:17`
- Test: `apps/admin/test/shifts-tag-semantics.test.tsx` (создать)

**Interfaces:**

- Consumes: `TagPhase`, `StatusChip`, `Badge`, `BadgeTone` из задач 3 и 4.
- Produces: ничего для последующих задач.

- [ ] **Шаг 1: Написать падающий тест**

Создать `apps/admin/test/shifts-tag-semantics.test.tsx`:

```tsx
import { describe, expect, it } from "vitest";

import { SHIFT_STATUS_TO_PHASE, SHIFT_MODE_TO_TONE } from "../src/pages/shifts/index.js";

describe("семантика тегов смены", () => {
  /**
   * Закрытая смена — не архив, а штатно завершённая работа. Серый читается
   * как «сущности больше нет», и именно с этой жалобы начался разбор.
   */
  it("даёт закрытой смене тон завершения, а не серый", () => {
    expect(SHIFT_STATUS_TO_PHASE.closed).toBe("done");
  });

  it("даёт активной смене фазу active, а не галочку", () => {
    expect(SHIFT_STATUS_TO_PHASE.active).toBe("active");
  });

  it("даёт запланированной смене фазу ожидания", () => {
    expect(SHIFT_STATUS_TO_PHASE.planned).toBe("planned");
  });

  /**
   * Валидация и агрегация — два равноправных режима, а не хороший и плохой.
   * Оба обязаны получить категорийный тон; ни один не может быть серым.
   */
  it("красит оба режима смены равногромкими категорийными тонами", () => {
    const tones = [SHIFT_MODE_TO_TONE.validation, SHIFT_MODE_TO_TONE.aggregation];

    expect(new Set(tones).size).toBe(2);
    for (const tone of tones) {
      expect(["violet", "teal", "magenta", "steel"]).toContain(tone);
    }
  });
});
```

- [ ] **Шаг 2: Запустить тест и убедиться, что он падает**

```bash
pnpm turbo run build --filter='@markiro/admin^...'
pnpm --filter @markiro/admin exec vitest run test/shifts-tag-semantics.test.tsx
```

Ожидается: падение импорта — `SHIFT_STATUS_TO_PHASE` не экспортируется.

- [ ] **Шаг 3: Переписать таблицы в `shifts/index.tsx`**

Заменить строки 36–44:

```tsx
export const SHIFT_STATUS_TO_PHASE: Record<ShiftStatus, TagPhase> = {
  planned: "planned",
  active: "active",
  closed: "done",
};

/**
 * Валидация и агрегация равноправны. Раньше одна была `neutral`, вторая
 * `accent`, и таблица смен подсказывала, что агрегация «лучше».
 */
export const SHIFT_MODE_TO_TONE: Record<ShiftDto["mode"], BadgeTone> = {
  validation: "violet",
  aggregation: "teal",
};
```

Заменить импорт типов в строке 20 на:

```tsx
import type { BadgeTone, SelectOption, TagPhase, TableColumn } from "@markiro/ui";
```

Строку 186 заменить на:

```tsx
<Badge tone={SHIFT_MODE_TO_TONE[row.mode]}>{t(`pages.shifts.mode.${row.mode}`)}</Badge>
```

Строки 199–205 заменить на:

```tsx
<StatusChip
  phase={SHIFT_STATUS_TO_PHASE[row.status]}
  label={t(`pages.shifts.status.${row.status}`)}
/>;
{
  row.lateDataAt && <Badge tone="warn">{t("pages.shifts.table.lateData")}</Badge>;
}
```

- [ ] **Шаг 4: Переписать `ShiftDetailsPanel.tsx`**

Удалить локальную таблицу `STATUS_TO_CHIP` и импортировать общую:

```tsx
import { SHIFT_STATUS_TO_PHASE } from "./index.js";
```

Строку 454 заменить на:

```tsx
              phase={SHIFT_STATUS_TO_PHASE[shift.status]}
              label={t(`pages.shifts.status.${shift.status}`)}
```

Строку 528 (`<Badge tone="neutral">{t(\`pages.shifts.mode.${shift.mode}\`)}</Badge>`) заменить на:

```tsx
<Badge tone={SHIFT_MODE_TO_TONE[shift.mode]}>{t(`pages.shifts.mode.${shift.mode}`)}</Badge>
```

добавив `SHIFT_MODE_TO_TONE` в тот же импорт. Строки 257–264 (`Badge tone="neutral" wrap` для разобранной паллеты и `Badge tone="warn" wrap` для изменившегося состава) заменить на теги фазы:

```tsx
<StatusChip phase="dismantled" label={t("pages.shifts.pallets.disassembled")} />
```

```tsx
<StatusChip phase="attention" label={t("pages.shifts.pallets.contentsChangedAfterClose")} />
```

Комментарий выше про сжатие «Закрыта» и перенос подписи сохранить, дополнив его тем, что перенос теперь недоступен: тег фазы всегда в одну строку, а колонка рассчитана на `.mk-shift-details__pallet-status` со стопкой.

- [ ] **Шаг 5: Переписать `export-history.tsx`**

Заменить таблицу соответствий:

```tsx
export const EXPORT_STATUS_TO_PHASE: Record<ShiftExportStatus, TagPhase> = {
  queued: "planned",
  processing: "running",
  ready: "done",
  failed: "failed",
};
```

Строку 235 заменить на:

```tsx
              phase={EXPORT_STATUS_TO_PHASE[item.status]}
              label={t(`pages.shifts.exports.status.${item.status}`)}
```

- [ ] **Шаг 6: Обновить селектор в shifts.css**

Строку 17 заменить на:

```css
.mk-shifts-table__stack > span:not(.mk-tag) {
```

- [ ] **Шаг 7: Запустить тесты и убедиться, что они проходят**

```bash
pnpm --filter @markiro/admin exec vitest run test/shifts-tag-semantics.test.tsx
pnpm --filter @markiro/admin exec vitest run test/shifts.test.tsx test/shift-details.test.tsx
```

Ожидается: PASS. Существующие тесты смен, если они опираются на подписи, менять не нужно — подписи не изменились.

- [ ] **Шаг 8: Коммит**

```bash
git add apps/admin/src/pages/shifts apps/admin/test/shifts-tag-semantics.test.tsx
git commit -m "feat(admin): фазы вместо тонов на страницах смен"
```

---

### Задача 7: Поиск по коду

**Files:**

- Modify: `apps/admin/src/pages/code-search/BoxCard.tsx:29-33,126-131,161`
- Modify: `apps/admin/src/pages/code-search/PalletCard.tsx:39-43,174,253-256`
- Modify: `apps/admin/src/pages/code-search/CodeCard.tsx:24-38,172,182-184`
- Modify: `apps/admin/src/pages/code-search/index.tsx:41-47,176`
- Test: `apps/admin/test/code-search-tag-semantics.test.tsx` (создать)

**Interfaces:**

- Consumes: `TagPhase`, `BadgeTone` из задач 3 и 4.
- Produces: ничего.

**Решение, требующее подтверждения.** Состояния кода (`free`, `aggregated`, `written_off`) — не вполне жизненный цикл. План исходит из того, что это всё же фазы: `free` → `active`, `aggregated` → `done`, `written_off` → `retired`. Если при разборе окажется, что «свободен» уместнее как категория, поменять именно эту таблицу, остальные не трогать.

- [ ] **Шаг 1: Написать падающий тест**

Создать `apps/admin/test/code-search-tag-semantics.test.tsx`:

```tsx
import { describe, expect, it } from "vitest";

import { BOX_STATUS_TO_PHASE } from "../src/pages/code-search/BoxCard.js";
import {
  PALLET_STATUS_TO_PHASE,
  PALLET_KIND_TO_TONE,
} from "../src/pages/code-search/PalletCard.js";
import { CODE_STATUS_TO_PHASE } from "../src/pages/code-search/CodeCard.js";

describe("семантика тегов поиска по коду", () => {
  /**
   * «Открыт» у короба и «Активна» у смены — одно понятие. Раньше короб был
   * синим с глифом синхронизации, а смена зелёной с галочкой.
   */
  it("выравнивает открытый короб и открытую паллету по фазе active", () => {
    expect(BOX_STATUS_TO_PHASE.open).toBe("active");
    expect(PALLET_STATUS_TO_PHASE.open).toBe("active");
  });

  it("даёт закрытому коробу и паллете тон завершения", () => {
    expect(BOX_STATUS_TO_PHASE.closed).toBe("done");
    expect(PALLET_STATUS_TO_PHASE.closed).toBe("done");
  });

  it("отличает расформирование от завершения", () => {
    expect(BOX_STATUS_TO_PHASE.disassembled).toBe("dismantled");
    expect(PALLET_STATUS_TO_PHASE.disassembled).toBe("dismantled");
  });

  it("не оставляет ни одному виду паллеты серый тон", () => {
    const tones = Object.values(PALLET_KIND_TO_TONE);
    expect(new Set(tones).size).toBe(tones.length);
    for (const tone of tones) {
      expect(["violet", "teal", "magenta", "steel"]).toContain(tone);
    }
  });

  it("раскладывает состояния кода по фазам", () => {
    expect(CODE_STATUS_TO_PHASE.free).toBe("active");
    expect(CODE_STATUS_TO_PHASE.aggregated).toBe("done");
    expect(CODE_STATUS_TO_PHASE.written_off).toBe("retired");
  });
});
```

- [ ] **Шаг 2: Запустить тест и убедиться, что он падает**

```bash
pnpm --filter @markiro/admin exec vitest run test/code-search-tag-semantics.test.tsx
```

Ожидается: падение импорта — таблицы не экспортируются под новыми именами.

- [ ] **Шаг 3: Переписать `BoxCard.tsx`**

Заменить строки 29–33:

```tsx
export const BOX_STATUS_TO_PHASE: Record<BoxCardDto["status"], TagPhase> = {
  open: "active",
  closed: "done",
  disassembled: "dismantled",
};
```

Строки 126–131 заменить на:

```tsx
if (state === "displaced") {
  return <StatusChip phase="attention" label={t("pages.codeSearch.boxCard.displaced")} />;
}
if (state === "removed") {
  return <StatusChip phase="failed" label={t("pages.codeSearch.boxCard.removed")} />;
}
return null;
```

Строку 161 заменить на `phase={BOX_STATUS_TO_PHASE[box.status]}`.

- [ ] **Шаг 4: Переписать `PalletCard.tsx`**

Заменить строки 39–43 и добавить таблицу видов:

```tsx
export const PALLET_STATUS_TO_PHASE: Record<PalletCardDto["status"], TagPhase> = {
  open: "active",
  closed: "done",
  disassembled: "dismantled",
};

/** Складская и сменная паллеты равноправны: ни одна не «лучше» другой. */
export const PALLET_KIND_TO_TONE: Record<PalletCardDto["kind"], BadgeTone> = {
  warehouse: "steel",
  shift: "violet",
};
```

Если фактический union видов паллеты отличается от `warehouse | shift`, сверить его по `PalletCardDto` и заполнить таблицу целиком, назначая тона в порядке `violet`, `teal`, `magenta`, `steel`.

Строку 174 заменить на:

```tsx
<StatusChip phase="dismantled" label={t("pages.codeSearch.palletCard.boxDisassembled")} />
```

Строки 253–255 заменить на:

```tsx
<Badge tone={PALLET_KIND_TO_TONE[pallet.kind]}>
  {t(`pages.codeSearch.palletCard.kind.${pallet.kind}`)}
</Badge>
```

Строку 256 заменить на `phase={PALLET_STATUS_TO_PHASE[pallet.status]}`.

- [ ] **Шаг 5: Переписать `CodeCard.tsx`**

Заменить строки 24–38:

```tsx
export const CODE_STATUS_TO_PHASE: Record<CodeStatus, TagPhase> = {
  free: "active",
  aggregated: "done",
  written_off: "retired",
};

// Состояния Честного знака не зависят от локальной агрегации.
// Неизвестное состояние остаётся без значения, а не «в порядке».
const CHZ_STATUS_TO_PHASE = new Map<string, TagPhase>([
  ["EMITTED", "planned"],
  ["APPLIED", "running"],
  ["INTRODUCED", "active"],
  ["RETIRED", "retired"],
  ["WRITTEN_OFF", "retired"],
  ["WITHDRAWN", "retired"],
]);
```

Ключи совпадают с текущей картой `CHZ_STATUS_TO_CHIP` один к одному. Содержательное изменение — три состояния вывода из оборота (`RETIRED`, `WRITTEN_OFF`, `WITHDRAWN`) перестают быть `warn` с глифом дубликата и становятся `retired`, а `EMITTED` и `APPLIED` расходятся: эмиссия это ожидание, нанесение — уже идущий процесс.

Строку 172 заменить на `phase={CODE_STATUS_TO_PHASE[card.status]}`.

Строки 182–184 заменить на тег категории — статус Честного знака здесь показывался без глифа через `glyph={null}`, то есть он и раньше не был фазой:

```tsx
<Badge tone="steel">{chzLabel}</Badge>
```

где `chzLabel` — выражение из существующего пропа `label` этой точки вызова, перенесённое без изменений.

- [ ] **Шаг 6: Переписать `code-search/index.tsx`**

Заменить строки 41–47 на импорт общей таблицы вместо локальной копии:

```tsx
import { CODE_STATUS_TO_PHASE } from "./CodeCard.js";
```

Строку 176 заменить на `phase={CODE_STATUS_TO_PHASE[row.status]}`.

- [ ] **Шаг 7: Запустить тесты**

```bash
pnpm --filter @markiro/admin exec vitest run test/code-search-tag-semantics.test.tsx test/code-search.test.tsx test/box-card.test.tsx test/code-card.test.tsx
```

Ожидается: PASS.

- [ ] **Шаг 8: Коммит**

```bash
git add apps/admin/src/pages/code-search apps/admin/test/code-search-tag-semantics.test.tsx
git commit -m "feat(admin): фазы вместо тонов в поиске по коду"
```

---

### Задача 8: Дезагрегация

**Files:**

- Modify: `apps/admin/src/pages/disaggregation/index.tsx:42-48,117`
- Modify: `apps/admin/src/pages/disaggregation/DocumentDetail.tsx:55-75,477,525`
- Test: `apps/admin/test/disaggregation-tag-semantics.test.tsx` (создать)

**Interfaces:**

- Consumes: `TagPhase`.
- Produces: ничего.

- [ ] **Шаг 1: Написать падающий тест**

Создать `apps/admin/test/disaggregation-tag-semantics.test.tsx`:

```tsx
import { describe, expect, it } from "vitest";

import {
  DOCUMENT_STATUS_TO_PHASE,
  LINE_STATUS_TO_PHASE,
} from "../src/pages/disaggregation/DocumentDetail.js";

describe("семантика тегов дезагрегации", () => {
  /**
   * Отменённый документ получал тон `warn`, а вместе с ним — глиф дубликата
   * `⧉`. Это самый наглядный случай того, как глиф выводился из тона.
   */
  it("не даёт отменённому документу глиф дубликата", () => {
    expect(DOCUMENT_STATUS_TO_PHASE.cancelled).toBe("retired");
    expect(DOCUMENT_STATUS_TO_PHASE.cancelled).not.toBe("duplicate");
  });

  it("даёт применённому документу тон завершения", () => {
    expect(DOCUMENT_STATUS_TO_PHASE.applied).toBe("done");
  });

  it("оставляет черновик черновиком", () => {
    expect(DOCUMENT_STATUS_TO_PHASE.draft).toBe("draft");
  });

  it("отличает настоящий дубликат строки от прочих предупреждений", () => {
    expect(LINE_STATUS_TO_PHASE.duplicate).toBe("duplicate");
    expect(LINE_STATUS_TO_PHASE.not_closed).toBe("attention");
    expect(LINE_STATUS_TO_PHASE.shift_open).toBe("attention");
  });

  it("разводит ненайденный и списанный код по терминальным фазам", () => {
    expect(LINE_STATUS_TO_PHASE.not_found).toBe("failed");
    expect(LINE_STATUS_TO_PHASE.written_off).toBe("retired");
  });
});
```

- [ ] **Шаг 2: Запустить тест и убедиться, что он падает**

```bash
pnpm --filter @markiro/admin exec vitest run test/disaggregation-tag-semantics.test.tsx
```

Ожидается: падение импорта.

- [ ] **Шаг 3: Переписать таблицы в `DocumentDetail.tsx`**

Заменить строки 55–75:

```tsx
export const DOCUMENT_STATUS_TO_PHASE: Record<DocumentDetailDto["status"], TagPhase> = {
  draft: "draft",
  applied: "done",
  cancelled: "retired",
};

export const LINE_STATUS_TO_PHASE: Record<string, TagPhase> = {
  ok: "done",
  not_found: "failed",
  written_off: "retired",
  not_closed: "attention",
  shift_open: "attention",
  already_disassembled: "dismantled",
  duplicate: "duplicate",
};
```

Строку 477 заменить на:

```tsx
              phase={LINE_STATUS_TO_PHASE[line.status] ?? "none"}
              label={t(`pages.disaggregation.lineStatus.${line.status}`)}
```

Строку 525 заменить на `phase={DOCUMENT_STATUS_TO_PHASE[doc.status]}`.

- [ ] **Шаг 4: Переписать `disaggregation/index.tsx`**

Заменить строки 42–48 на импорт общей таблицы:

```tsx
import { DOCUMENT_STATUS_TO_PHASE } from "./DocumentDetail.js";
```

Строку 117 заменить на `phase={DOCUMENT_STATUS_TO_PHASE[row.status]}`.

Если локальный union `Exclude<StatusFilter, "all">` не совпадает с `DocumentDetailDto["status"]`, оставить локальную таблицу, но заполнить её теми же тремя парами, что выше.

- [ ] **Шаг 5: Запустить тесты**

```bash
pnpm --filter @markiro/admin exec vitest run test/disaggregation-tag-semantics.test.tsx test/disaggregation.test.tsx
```

Ожидается: PASS.

- [ ] **Шаг 6: Коммит**

```bash
git add apps/admin/src/pages/disaggregation apps/admin/test/disaggregation-tag-semantics.test.tsx
git commit -m "feat(admin): фазы вместо тонов в дезагрегации"
```

---

### Задача 9: Самовывоз

**Files:**

- Modify: `apps/admin/src/pages/pickup/index.tsx:41-47,182,220-227`
- Modify: `apps/admin/src/pages/pickup/OrderDetail.tsx:34-40,354`
- Modify: `apps/admin/src/pages/pickup/Rejections.tsx:156`
- Test: `apps/admin/test/pickup-tag-semantics.test.tsx` (создать)

**Interfaces:**

- Consumes: `TagPhase`, `BadgeTone`.
- Produces: ничего.

- [ ] **Шаг 1: Написать падающий тест**

Создать `apps/admin/test/pickup-tag-semantics.test.tsx`:

```tsx
import { describe, expect, it } from "vitest";

import { PICKUP_STATUS_TO_PHASE, DEVICE_KIND_TO_TONE } from "../src/pages/pickup/index.js";

describe("семантика тегов самовывоза", () => {
  /**
   * Ожидающая заявка — не предупреждение. Тон `warn` давал ей глиф дубликата
   * и уравнивал очередь с неисправностью.
   */
  it("не считает ожидание проблемой", () => {
    expect(PICKUP_STATUS_TO_PHASE.pending).toBe("planned");
  });

  it("даёт выданной заявке тон завершения", () => {
    expect(PICKUP_STATUS_TO_PHASE.punched).toBe("done");
  });

  it("разводит списание и отмену в одну терминальную фазу без тревоги", () => {
    expect(PICKUP_STATUS_TO_PHASE.writtenoff).toBe("retired");
    expect(PICKUP_STATUS_TO_PHASE.cancelled).toBe("retired");
  });

  it("красит виды устройства равногромкими категорийными тонами", () => {
    const tones = Object.values(DEVICE_KIND_TO_TONE);
    expect(new Set(tones).size).toBe(tones.length);
    for (const tone of tones) {
      expect(["violet", "teal", "magenta", "steel"]).toContain(tone);
    }
  });
});
```

- [ ] **Шаг 2: Запустить тест и убедиться, что он падает**

```bash
pnpm --filter @markiro/admin exec vitest run test/pickup-tag-semantics.test.tsx
```

Ожидается: падение импорта.

- [ ] **Шаг 3: Переписать `pickup/index.tsx`**

Заменить строки 41–47:

```tsx
export const PICKUP_STATUS_TO_PHASE: Record<PickupOrderStatus, TagPhase> = {
  pending: "planned",
  punched: "done",
  writtenoff: "retired",
  cancelled: "retired",
};

/** Киоск и ТСД — два равноправных вида устройства выдачи. */
export const DEVICE_KIND_TO_TONE: Record<"kiosk" | "handheld", BadgeTone> = {
  kiosk: "violet",
  handheld: "teal",
};
```

Строку 182 заменить на:

```tsx
<Badge tone={DEVICE_KIND_TO_TONE[row.device.kind]}>
  {t(`pages.pickup.deviceKind.${row.device.kind}`)}
</Badge>
```

Строку 220 заменить на `phase={PICKUP_STATUS_TO_PHASE[row.status]}`.

Строки 225–227 заменить на:

```tsx
<StatusChip
  phase="attention"
  label={t("pages.pickup.conflicts.badge", { count: row.conflictCount })}
/>
```

- [ ] **Шаг 4: Переписать `OrderDetail.tsx`**

Удалить локальную таблицу строк 34–40 и импортировать общую:

```tsx
import { PICKUP_STATUS_TO_PHASE } from "./index.js";
```

Строку 354 заменить на `phase={PICKUP_STATUS_TO_PHASE[order.status]}`.

- [ ] **Шаг 5: Переписать `Rejections.tsx`**

Строку 156 заменить на:

```tsx
              phase={row.acknowledgedAt ? "done" : "attention"}
```

- [ ] **Шаг 6: Запустить тесты**

```bash
pnpm --filter @markiro/admin exec vitest run test/pickup-tag-semantics.test.tsx test/pickup-detail.test.tsx
```

Ожидается: PASS.

- [ ] **Шаг 7: Коммит**

```bash
git add apps/admin/src/pages/pickup apps/admin/test/pickup-tag-semantics.test.tsx
git commit -m "feat(admin): фазы вместо тонов в самовывозе"
```

---

### Задача 10: Сотрудники, команда, линии, устройства

**Files:**

- Modify: `apps/admin/src/pages/employees/index.tsx:42-46,250`
- Modify: `apps/admin/src/pages/employees/EmployeeBadgesSection.tsx:133,144`
- Modify: `apps/admin/src/pages/employees/EmployeeStationAccessSection.tsx:224`
- Modify: `apps/admin/src/pages/team/TeamPage.tsx` (таблица `DELIVERY_TONE` и строки 127, 144, 234, 238, 260)
- Modify: `apps/admin/src/pages/lines/index.tsx:132,136`
- Modify: `apps/admin/src/pages/devices/index.tsx:161`, `apps/admin/src/pages/devices/DeviceLicensingPanel.tsx:124`, `apps/admin/src/pages/devices/DeviceReplacementPanel.tsx:295`
- Test: `apps/admin/test/people-tag-semantics.test.tsx` (создать)

**Interfaces:**

- Consumes: `TagPhase`.
- Produces: ничего.

- [ ] **Шаг 1: Написать падающий тест**

Создать `apps/admin/test/people-tag-semantics.test.tsx`:

```tsx
import { describe, expect, it } from "vitest";

import { EMPLOYEE_STATUS_TO_PHASE } from "../src/pages/employees/index.js";
import { DELIVERY_STATUS_TO_PHASE } from "../src/pages/team/TeamPage.js";

describe("семантика тегов людей и устройств", () => {
  it("отличает действующего сотрудника от выведенного", () => {
    expect(EMPLOYEE_STATUS_TO_PHASE.active).toBe("active");
    expect(EMPLOYEE_STATUS_TO_PHASE.archived).toBe("retired");
  });

  /**
   * Доставка приглашения — конвейер, и у него есть фаза «выполняется».
   * Раньше `sending` и `queued` были одинаково синими с глифом синхронизации.
   */
  it("разводит очередь и отправку по разным фазам", () => {
    expect(DELIVERY_STATUS_TO_PHASE.queued).toBe("planned");
    expect(DELIVERY_STATUS_TO_PHASE.sending).toBe("running");
    expect(DELIVERY_STATUS_TO_PHASE.retrying).toBe("attention");
  });

  it("считает доставленным и отправленным одну фазу завершения", () => {
    expect(DELIVERY_STATUS_TO_PHASE.sent).toBe("done");
    expect(DELIVERY_STATUS_TO_PHASE.delivered).toBe("done");
  });

  it("разводит сбой доставки и отмену", () => {
    expect(DELIVERY_STATUS_TO_PHASE.failed).toBe("failed");
    expect(DELIVERY_STATUS_TO_PHASE.canceled).toBe("retired");
  });
});
```

- [ ] **Шаг 2: Запустить тест и убедиться, что он падает**

```bash
pnpm --filter @markiro/admin exec vitest run test/people-tag-semantics.test.tsx
```

Ожидается: падение импорта.

- [ ] **Шаг 3: Переписать таблицы**

В `apps/admin/src/pages/employees/index.tsx` заменить строки 42–46:

```tsx
export const EMPLOYEE_STATUS_TO_PHASE: Record<EmployeeStatus, TagPhase> = {
  active: "active",
  archived: "retired",
};
```

Строку 250 заменить на `phase={EMPLOYEE_STATUS_TO_PHASE[row.status]}`.

В `apps/admin/src/pages/team/TeamPage.tsx` заменить таблицу `DELIVERY_TONE`:

```tsx
export const DELIVERY_STATUS_TO_PHASE: Record<string, TagPhase> = {
  queued: "planned",
  sending: "running",
  retrying: "attention",
  sent: "done",
  delivered: "done",
  failed: "failed",
  canceled: "retired",
};
```

- [ ] **Шаг 4: Переписать точки вызова**

Заменить по одной, сохраняя выражения `label` без изменений:

| Файл и строка                            | Было                                                                  | Стало                                                                           |
| ---------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `EmployeeBadgesSection.tsx:133`          | `status="ok"`                                                         | `phase="active"`                                                                |
| `EmployeeBadgesSection.tsx:144`          | `status="neutral"`                                                    | `phase="retired"`                                                               |
| `EmployeeStationAccessSection.tsx:224`   | `status={access.active ? "ok" : "neutral"}`                           | `phase={access.active ? "active" : "retired"}`                                  |
| `TeamPage.tsx:127`                       | `status={invitation.accessStatus === "pending" ? "info" : "neutral"}` | `phase={invitation.accessStatus === "pending" ? "planned" : "none"}`            |
| `TeamPage.tsx:144`                       | `status={DELIVERY_TONE[...] ?? "neutral"}`                            | `phase={DELIVERY_STATUS_TO_PHASE[invitation.delivery?.status ?? ""] ?? "none"}` |
| `TeamPage.tsx:234`                       | `status={employee.status === "active" ? "ok" : "neutral"}`            | `phase={employee.status === "active" ? "active" : "retired"}`                   |
| `TeamPage.tsx:238`                       | `status={employee.operatorAccess ? "ok" : "neutral"}`                 | `phase={employee.operatorAccess ? "active" : "none"}`                           |
| `TeamPage.tsx:260`                       | `status="neutral"`                                                    | `phase="none"`                                                                  |
| `lines/index.tsx:132`                    | `status="neutral"`                                                    | `phase="none"`                                                                  |
| `lines/index.tsx:136`                    | `status={online ? "ok" : "neutral"}`                                  | `phase={online ? "active" : "none"}`                                            |
| `devices/DeviceReplacementPanel.tsx:295` | `status="neutral"`                                                    | `phase="running"`                                                               |

Для `devices/index.tsx:161` и `devices/DeviceLicensingPanel.tsx:124` открыть многострочные выражения и перевести каждую ветку по правилу: `ok` → `active`, `info` → `planned` для ожидания и `running` для выполняющегося действия, `warn` → `attention`, `error` → `failed`, `neutral` → `none` для отсутствия значения и `retired` для выведенного устройства.

- [ ] **Шаг 5: Запустить тесты**

```bash
pnpm --filter @markiro/admin exec vitest run test/people-tag-semantics.test.tsx test/employees-routing.test.tsx test/employee-badges.test.tsx test/employee-station-access.test.tsx test/device-licensing.test.tsx
```

Ожидается: PASS.

- [ ] **Шаг 6: Коммит**

```bash
git add apps/admin/src/pages/employees apps/admin/src/pages/team apps/admin/src/pages/lines apps/admin/src/pages/devices apps/admin/test/people-tag-semantics.test.tsx
git commit -m "feat(admin): фазы вместо тонов у сотрудников, команды, линий и устройств"
```

---

### Задача 11: Интеграции и агенты подписанта

**Files:**

- Modify: `apps/admin/src/pages/integrations/index.tsx:30-38,103`
- Modify: `apps/admin/src/pages/integrations/ChannelPage.tsx:41-49,688`
- Modify: `apps/admin/src/pages/integrations/JournalSessionRow.tsx:9-15,114,243`
- Modify: `apps/admin/src/pages/integrations/SignerAgentsPanel.tsx:35-46,204,288,294`
- Test: `apps/admin/test/integrations-tag-semantics.test.tsx` (создать)

**Interfaces:**

- Consumes: `TagPhase`, `BadgeTone`.
- Produces: ничего.

- [ ] **Шаг 1: Написать падающий тест**

Создать `apps/admin/test/integrations-tag-semantics.test.tsx`:

```tsx
import { describe, expect, it } from "vitest";

import { CHANNEL_STATE_TO_PHASE } from "../src/pages/integrations/index.js";
import {
  TOKEN_STATUS_TO_PHASE,
  AGENT_STATUS_TO_PHASE,
} from "../src/pages/integrations/SignerAgentsPanel.js";

describe("семантика тегов интеграций", () => {
  it("отличает работающий канал от молчащего и от сломанного", () => {
    expect(CHANNEL_STATE_TO_PHASE.working).toBe("active");
    expect(CHANNEL_STATE_TO_PHASE.silent).toBe("attention");
    expect(CHANNEL_STATE_TO_PHASE.error).toBe("failed");
  });

  /**
   * Ненастроенный канал — единственный законный случай серого здесь:
   * значения нет и не ожидается.
   */
  it("оставляет ненастроенному каналу фазу отсутствия значения", () => {
    expect(CHANNEL_STATE_TO_PHASE.not_configured).toBe("none");
  });

  it("считает недоступность поводом для внимания, а не справкой", () => {
    expect(CHANNEL_STATE_TO_PHASE.unavailable).toBe("attention");
  });

  it("разводит истекающий и истёкший токен", () => {
    expect(TOKEN_STATUS_TO_PHASE.expiring).toBe("attention");
    expect(TOKEN_STATUS_TO_PHASE.expired).toBe("failed");
    expect(TOKEN_STATUS_TO_PHASE.none).toBe("none");
  });

  it("считает отозванного агента выведенным, а не пустым", () => {
    expect(AGENT_STATUS_TO_PHASE.revoked).toBe("retired");
    expect(AGENT_STATUS_TO_PHASE.active).toBe("active");
  });
});
```

- [ ] **Шаг 2: Запустить тест и убедиться, что он падает**

```bash
pnpm --filter @markiro/admin exec vitest run test/integrations-tag-semantics.test.tsx
```

Ожидается: падение импорта.

- [ ] **Шаг 3: Переписать таблицы**

В `apps/admin/src/pages/integrations/index.tsx` заменить строки 30–38:

```tsx
export const CHANNEL_STATE_TO_PHASE: Record<ChannelState, TagPhase> = {
  working: "active",
  error: "failed",
  silent: "attention",
  not_configured: "none",
  unavailable: "attention",
};
```

Строку 103 заменить на `phase={CHANNEL_STATE_TO_PHASE[channel.state]}`.

В `apps/admin/src/pages/integrations/ChannelPage.tsx` удалить локальную копию строк 41–49 и импортировать общую таблицу:

```tsx
import { CHANNEL_STATE_TO_PHASE } from "./index.js";
```

Строку 688 заменить на `phase={CHANNEL_STATE_TO_PHASE[channel.state]}`.

В `apps/admin/src/pages/integrations/JournalSessionRow.tsx` заменить строки 9–15:

```tsx
const OUTCOME_TO_PHASE: Record<string, TagPhase> = {
  ok: "done",
  warn: "attention",
  error: "failed",
  running: "running",
};
```

Строку 114 заменить на `phase={phase}`, переименовав локальную переменную `status` в `phase` выше по файлу. Строку 243 заменить на `phase={OUTCOME_TO_PHASE[key] ?? "none"}`.

В `apps/admin/src/pages/integrations/SignerAgentsPanel.tsx` заменить строки 35–46:

```tsx
export const TOKEN_STATUS_TO_PHASE: Record<SignerTokenStatus["status"], TagPhase> = {
  none: "none",
  active: "active",
  expiring: "attention",
  expired: "failed",
};

export const AGENT_STATUS_TO_PHASE: Record<SignerAgentStatus, TagPhase> = {
  active: "active",
  revoked: "retired",
};
```

Строку 204 заменить на `phase={AGENT_STATUS_TO_PHASE[agent.status]}`, строку 288 — на `phase={TOKEN_STATUS_TO_PHASE[data.token.status]}`.

Строки 294–296 (`<Badge tone="neutral">` для типа токена) заменить на категорийный тон — тип токена это вид, а не фаза:

```tsx
<Badge tone="steel">
  {t(`pages.integrations.channel.signer.tokenType.${data.token.tokenType}`)}
</Badge>
```

- [ ] **Шаг 4: Запустить тесты**

```bash
pnpm --filter @markiro/admin exec vitest run test/integrations-tag-semantics.test.tsx test/integrations.test.tsx test/signer-agents.test.tsx
```

Ожидается: PASS. Если каких-то из перечисленных файлов тестов нет, запустить только существующие.

- [ ] **Шаг 5: Коммит**

```bash
git add apps/admin/src/pages/integrations apps/admin/test/integrations-tag-semantics.test.tsx
git commit -m "feat(admin): фазы вместо тонов в интеграциях и у агентов подписанта"
```

---

### Задача 12: Остальные страницы кабинета

Инвентаризация, каталог, дашборд, биллинг, этикетки, приглашения, конфликты, паллеты.

**Files:**

- Modify: `apps/admin/src/pages/inventory/ChzExportsPanel.tsx:97`, `InventoryDocuments.tsx:363`, `InventoryLateEvents.tsx:156`, `InventoryLivePage.tsx:61,133,208,240`, `InventoryDetailPage.tsx:131,170,336-338,537`, `index.tsx:44`
- Modify: `apps/admin/src/pages/catalog/index.tsx:360-362`, `catalog/national-catalog/ChzStatus.tsx:12,30`
- Modify: `apps/admin/src/pages/dashboard/index.tsx:282,345,390`
- Modify: `apps/admin/src/pages/billing/BillingSections.tsx:53`, `ServicePeriodDetailPage.tsx:95,144`, `ServicePeriodsPage.tsx:64`
- Modify: `apps/admin/src/pages/labels/index.tsx:154-172`
- Modify: `apps/admin/src/pages/invitations/InvitationPage.tsx:110`
- Modify: `apps/admin/src/pages/conflicts/index.tsx:221`
- Modify: `apps/admin/src/pages/pallets/index.tsx:150-205`
- Modify: `apps/admin/src/layout/AppShell.tsx:347`
- Test: `apps/admin/test/labels-tag-semantics.test.tsx` (создать)

**Interfaces:**

- Consumes: `TagPhase`, `BadgeTone`.
- Produces: ничего.

**Решение, требующее подтверждения.** У выгрузок Честного знака состояния `ready` и `imported` в плане обе становятся `done` и различаются только подписью. Если при разборе выяснится, что от администратора после `ready` ещё ожидается действие, поменять `ready` на `attention`.

- [ ] **Шаг 1: Написать падающий тест на теги карточки шаблона**

Создать `apps/admin/test/labels-tag-semantics.test.tsx`:

```tsx
import { describe, expect, it } from "vitest";

import { PURPOSE_TO_TONE } from "../src/pages/labels/index.js";

describe("семантика тегов карточки шаблона этикетки", () => {
  /**
   * Назначение шаблона — самая широкая категорийная ось в продукте: три
   * равноправных значения. Ни одно из них не может быть серым.
   */
  it("красит три назначения тремя разными категорийными тонами", () => {
    const tones = [PURPOSE_TO_TONE.box, PURPOSE_TO_TONE.product_duplicate, PURPOSE_TO_TONE.pallet];

    expect(new Set(tones).size).toBe(3);
    for (const tone of tones) {
      expect(["violet", "teal", "magenta", "steel"]).toContain(tone);
    }
  });
});
```

- [ ] **Шаг 2: Запустить тест и убедиться, что он падает**

```bash
pnpm --filter @markiro/admin exec vitest run test/labels-tag-semantics.test.tsx
```

Ожидается: падение импорта.

- [ ] **Шаг 3: Переписать карточку шаблона этикетки**

В `apps/admin/src/pages/labels/index.tsx` рядом с `PURPOSE_BADGE_KEY` (строка 87) добавить:

```tsx
export const PURPOSE_TO_TONE: Record<LabelTemplatePurpose, BadgeTone> = {
  box: "violet",
  product_duplicate: "teal",
  pallet: "magenta",
};
```

Строки 153–172 заменить на:

```tsx
        <Badge mono>
          {t("pages.labels.sizeBadge", {
            width: item.widthMm.toFixed(1),
            height: item.heightMm.toFixed(1),
          })}
        </Badge>
        <Badge tone={PURPOSE_TO_TONE[item.purpose]}>{t(PURPOSE_BADGE_KEY[item.purpose])}</Badge>
        <Badge
          tone="steel"
          {...(scope.title ? { title: scope.title } : {})}
          style={{
            maxWidth: "100%",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {scope.label}
        </Badge>
        {item.enabled ? null : (
          <StatusChip phase="retired" label={t("pages.labels.disabledBadge")} />
        )}
```

Добавить `StatusChip` и тип `BadgeTone` в импорты файла.

- [ ] **Шаг 4: Переписать выгрузки Честного знака**

В `apps/admin/src/pages/inventory/ChzExportsPanel.tsx` заменить таблицу:

```tsx
const RUN_STATE_TO_PHASE: Record<ChzExportRunState, TagPhase> = {
  queued: "planned",
  ordered: "running",
  ready: "done",
  imported: "done",
  failed: "failed",
};
```

Строки 97–99 заменить на:

```tsx
<StatusChip
  phase={RUN_STATE_TO_PHASE[run.state]}
  label={t(`pages.inventory.chzExports.state.${run.state}`)}
/>
```

заменив импорт `Badge` на `StatusChip`, если `Badge` в файле больше не используется.

- [ ] **Шаг 5: Переписать паллеты**

В `apps/admin/src/pages/pallets/index.tsx` добавить таблицу видов и заменить точки вызова:

Таблицу не дублировать — взять ту, что задача 7 уже экспортировала из карточки паллеты, иначе два списка разойдутся при следующем добавлении вида:

```tsx
import { PALLET_KIND_TO_TONE } from "../code-search/PalletCard.js";
```

Строки 150–152 заменить на:

```tsx
<Badge tone={PALLET_KIND_TO_TONE[row.kind]}>{t(`pages.pallets.kind.${row.kind}`)}</Badge>
```

Строки 195–205 заменить на теги фазы:

```tsx
{
  row.disassembledAt ? (
    <StatusChip phase="dismantled" label={t("pages.pallets.disassembled")} />
  ) : null;
}
{
  row.contentsChangedAfterClose ? (
    <StatusChip phase="attention" label={t("pages.pallets.contentsChangedAfterClose")} />
  ) : null;
}
{
  row.rejectedMembershipCount > 0 ? (
    <StatusChip
      phase="failed"
      label={t("pages.pallets.rejections", {
        count: new Intl.NumberFormat(i18n.language).format(row.rejectedMembershipCount),
      })}
    />
  ) : null;
}
```

- [ ] **Шаг 6: Перевести оставшиеся точки вызова**

Заменить по одной, сохраняя выражения `label`:

| Файл и строка                     | Было                                                                           | Стало                                                                         |
| --------------------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| `catalog/index.tsx:360`           | `status="neutral"`                                                             | `phase="retired"`                                                             |
| `catalog/index.tsx:362`           | `status={row.status === "active" ? "ok" : "warn"}`                             | `phase={row.status === "active" ? "active" : "attention"}`                    |
| `ChzStatus.tsx:12`                | `status={key === "published" ? "ok" : key === "errors" ? "error" : "neutral"}` | `phase={key === "published" ? "done" : key === "errors" ? "failed" : "none"}` |
| `ChzStatus.tsx:30`                | `status="warn"`                                                                | `phase="attention"`                                                           |
| `dashboard/index.tsx:345`         | `status="info"`                                                                | `phase="running"`                                                             |
| `dashboard/index.tsx:390`         | `status={shift.lateDataAt ? "warn" : "info"}`                                  | `phase={shift.lateDataAt ? "attention" : "active"}`                           |
| `InventoryLateEvents.tsx:156`     | `status={event.resolution === "pending" ? "warn" : "neutral"}`                 | `phase={event.resolution === "pending" ? "attention" : "done"}`               |
| `InventoryLivePage.tsx:208`       | `status={box.state === "invalidated" ? "error" : "info"}`                      | `phase={box.state === "invalidated" ? "failed" : "active"}`                   |
| `InventoryLivePage.tsx:240`       | `status={event.classification === "expected" ? "ok" : "warn"}`                 | `phase={event.classification === "expected" ? "done" : "attention"}`          |
| `InventoryDetailPage.tsx:336`     | `<Badge tone="ok">`                                                            | `<StatusChip phase="done" label={t("pages.inventory.exports.ready")} />`      |
| `InventoryDetailPage.tsx:338`     | `<Badge>`                                                                      | `<StatusChip phase="none" label={t("pages.inventory.exports.missing")} />`    |
| `InventoryDetailPage.tsx:537`     | `status={line.onlineStations > 0 ? "ok" : "neutral"}`                          | `phase={line.onlineStations > 0 ? "active" : "none"}`                         |
| `ServicePeriodDetailPage.tsx:95`  | `status={period.state === "active" && !exhausted ? "ok" : "neutral"}`          | `phase={period.state === "active" && !exhausted ? "active" : "retired"}`      |
| `ServicePeriodDetailPage.tsx:144` | `status={entry.classification === "product_defect" ? "warn" : "neutral"}`      | `phase={entry.classification === "product_defect" ? "attention" : "none"}`    |
| `ServicePeriodsPage.tsx:64`       | `status={period.state === "active" && !exhausted ? "ok" : "neutral"}`          | `phase={period.state === "active" && !exhausted ? "active" : "retired"}`      |
| `InvitationPage.tsx:110`          | `status="info"`                                                                | `phase="planned"`                                                             |
| `conflicts/index.tsx:221`         | `<Badge tone="neutral">`                                                       | `<StatusChip phase="done" label={t("pages.conflicts.reviewed")} />`           |
| `AppShell.tsx:347`                | `<Badge>{item.badge}</Badge>`                                                  | `<Badge mono>{item.badge}</Badge>`                                            |

- [ ] **Шаг 7: Переписать два вспомогательных отображателя тона**

В `apps/admin/src/pages/inventory/InventoryDocuments.tsx` заменить функцию `statusTone` (строки 63–74):

```tsx
function statusPhase(status: InventoryDocumentRun["status"]): TagPhase {
  switch (status) {
    case "queued":
      return "planned";
    case "processing":
      return "running";
    case "ready":
      return "done";
    case "failed":
      return "failed";
  }
}
```

и строку 364 — на `phase={statusPhase(item.status)}`.

В `apps/admin/src/pages/billing/BillingSections.tsx` заменить функцию `chipStatusFor` (строки 24–42). Перечень значений взят из `apps/admin/src/i18n/ru.json`, ветка `pages.billing.status`, и покрывает все семь видов целиком:

```tsx
function chipPhaseFor(value: string): TagPhase {
  if (["active", "trial", "normal", "managed", "published"].includes(value)) return "active";
  if (["paid", "completed", "confirmed"].includes(value)) return "done";
  if (["pending_activation", "scheduled", "new", "ordered"].includes(value)) return "planned";
  if (["issued", "in_progress", "under_review", "offer_prepared"].includes(value)) return "running";
  if (
    [
      "approaching",
      "reached",
      "exceeded",
      "overdue",
      "awaiting_payment",
      "clarification_required",
      "partially_paid",
      "read_only",
      "unmanaged",
    ].includes(value)
  )
    return "attention";
  if (["cancelled", "revoked", "superseded", "expired"].includes(value)) return "retired";
  if (value === "draft") return "draft";
  return "none";
}
```

Содержательные изменения против прежней функции: `cancelled`, `revoked` и `expired` уезжают из `warn` в `retired` — отмена и истечение это вывод из оборота, а не повод для тревоги; `ordered` и `in_progress` расходятся на ожидание и выполнение; неизвестное значение больше не притворяется справкой `info`, а честно становится «значения нет».

Строку 53 заменить на `phase={chipPhaseFor(value)}`.

- [ ] **Шаг 8: Перевести оставшиеся выражения тона**

В `dashboard/index.tsx:282`, `InventoryLivePage.tsx:61,133`, `InventoryDetailPage.tsx:131,170` и `inventory/index.tsx:44` тон приходит из локальной переменной или общего отображателя статуса инвентаризации. Открыть каждое определение и перевести ветки по правилу из задачи 10: `ok` у действующей сущности → `active`, `ok` у завершённого действия → `done`, `info` у ожидания → `planned`, `info` у выполняющегося → `running`, `warn` → `attention`, `error` → `failed`, `neutral` при отсутствии значения → `none`, `neutral` у выведенной сущности → `retired`.

- [ ] **Шаг 9: Запустить тесты кабинета целиком**

```bash
pnpm --filter @markiro/admin exec vitest run
pnpm --filter @markiro/admin typecheck
```

Ожидается: PASS. Любая оставшаяся ссылка на `status=` у `StatusChip` даст ошибку типов — это и есть проверка полноты.

- [ ] **Шаг 10: Коммит**

```bash
git add apps/admin/src apps/admin/test/labels-tag-semantics.test.tsx
git commit -m "feat(admin): фазы вместо тонов на остальных страницах кабинета"
```

---

### Задача 13: Платформенная панель

**Files:**

- Modify: `apps/saas-admin/src/pages/agreements/AgreementsPage.tsx`, `AgreementDetailPage.tsx`
- Modify: `apps/saas-admin/src/pages/billing/invoice-status.ts`, `BillingPage.tsx`, `InvoiceDetailPage.tsx`
- Modify: `apps/saas-admin/src/pages/catalog/CatalogPage.tsx`, `CatalogVersionPanel.tsx`, `OfflineGrant*.tsx`
- Modify: `apps/saas-admin/src/pages/tenants/*.tsx`, `team/TeamPage.tsx`, `payments/PaymentsPage.tsx`, `offers/*.tsx`, `billing-acts/*.tsx`, `billing-requests/BillingRequestsPage.tsx`, `service-periods/ServicePeriodsPage.tsx`, `audit/AuditPage.tsx`, `overview/*.tsx`, `reports/ReportsPage.tsx`, `national-catalog/NationalCatalogPage.tsx`, `legal/BankAccountsPanel.tsx`
- Test: `apps/saas-admin/test/tag-semantics.test.ts` (создать)

**Interfaces:**

- Consumes: `TagPhase`.
- Produces: ничего.

**Решение, требующее подтверждения.** Договор в состояниях `in_review` и `sent` получает `attention` и `running` соответственно. Граница между ними в продукте нечёткая; если она означает одно и то же, свести оба к `running`.

- [ ] **Шаг 1: Написать падающий тест**

Создать `apps/saas-admin/test/tag-semantics.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { AGREEMENT_STATUS_TO_PHASE } from "../src/pages/agreements/AgreementsPage.js";
import { invoiceStatusPhase } from "../src/pages/billing/invoice-status.js";
import { CATALOG_STATUS_TO_PHASE } from "../src/pages/catalog/CatalogPage.js";

describe("семантика тегов платформенной панели", () => {
  it("даёт подписанному договору тон завершения", () => {
    expect(AGREEMENT_STATUS_TO_PHASE.signed).toBe("done");
  });

  /**
   * Расторгнутый договор получал `warn`, а с ним — глиф дубликата.
   * Расторжение это вывод из оборота, а не предупреждение.
   */
  it("не даёт расторгнутому договору глиф дубликата", () => {
    expect(AGREEMENT_STATUS_TO_PHASE.terminated).toBe("retired");
  });

  it("оставляет черновик договора черновиком", () => {
    expect(AGREEMENT_STATUS_TO_PHASE.draft).toBe("draft");
  });

  it("считает частичную оплату поводом для внимания", () => {
    expect(invoiceStatusPhase("partially_paid")).toBe("attention");
    expect(invoiceStatusPhase("paid")).toBe("done");
    expect(invoiceStatusPhase("cancelled")).toBe("retired");
    expect(invoiceStatusPhase("draft")).toBe("draft");
  });

  /**
   * Опубликованная позиция каталога — действующая, а не завершённая:
   * она прямо сейчас продаётся.
   */
  it("считает опубликованную позицию каталога действующей", () => {
    expect(CATALOG_STATUS_TO_PHASE.published).toBe("active");
    expect(CATALOG_STATUS_TO_PHASE.draft).toBe("draft");
    expect(CATALOG_STATUS_TO_PHASE.retired).toBe("retired");
  });
});
```

- [ ] **Шаг 2: Запустить тест и убедиться, что он падает**

```bash
pnpm turbo run build --filter='@markiro/saas-admin^...'
pnpm --filter @markiro/saas-admin exec vitest run test/tag-semantics.test.ts
```

Ожидается: падение импорта.

- [ ] **Шаг 3: Переписать три опорные таблицы**

В `apps/saas-admin/src/pages/agreements/AgreementsPage.tsx`:

```tsx
export const AGREEMENT_STATUS_TO_PHASE: Record<AgreementStatus, TagPhase> = {
  draft: "draft",
  in_review: "attention",
  sent: "running",
  signed: "done",
  terminated: "retired",
};
```

`AgreementDetailPage.tsx` импортирует эту таблицу вместо своей копии.

В `apps/saas-admin/src/pages/billing/invoice-status.ts` заменить `TONES` и экспортируемую функцию:

```ts
const PHASES: Record<Invoice["status"], TagPhase> = {
  draft: "draft",
  issued: "running",
  partially_paid: "attention",
  paid: "done",
  cancelled: "retired",
};

export function invoiceStatusPhase(status: Invoice["status"]): TagPhase {
  return PHASES[status];
}
```

Удалить прежний экспорт `invoiceStatusTone` и поправить три его вызова в `BillingPage.tsx:87`, `InvoiceDetailPage.tsx:254` и `billing-acts/CreateBillingActPage.tsx:361`.

В `apps/saas-admin/src/pages/catalog/CatalogPage.tsx`:

```tsx
export const CATALOG_STATUS_TO_PHASE = {
  draft: "draft",
  published: "active",
  retired: "retired",
} as const satisfies Record<string, TagPhase>;
```

В `apps/saas-admin/src/pages/tenants/TenantsPage.tsx` заменить `STATUS_TONE` (строки 27–36). `superseded` и `cancelled` были одинаково серыми, а `unmanaged` — жёлтым наравне с ожиданием активации:

```tsx
export const SUBSCRIPTION_STATUS_TO_PHASE = {
  pending_activation: "planned",
  scheduled: "planned",
  trial: "active",
  active: "active",
  expired: "retired",
  superseded: "retired",
  cancelled: "retired",
  unmanaged: "none",
} as const satisfies Record<string, TagPhase>;
```

`TenantPage.tsx:143` импортирует эту таблицу вместо своей копии.

- [ ] **Шаг 4: Перевести остальные точки вызова**

Пройти по всем оставшимся `<StatusChip status=` в `apps/saas-admin/src` и перевести каждую ветку по правилу:

| Было                              | Стало       |
| --------------------------------- | ----------- |
| `ok` у действующей сущности       | `active`    |
| `ok` у завершённого действия      | `done`      |
| `info` у ожидания                 | `planned`   |
| `info` у выполняющегося действия  | `running`   |
| `warn`                            | `attention` |
| `error`                           | `failed`    |
| `neutral` при отсутствии значения | `none`      |
| `neutral` у выведенной сущности   | `retired`   |

Конкретные точки: `BillingRequestsPage.tsx:173`, `OffersPage.tsx:275`, `OfferDetailPage.tsx:73`, `OfferDocuments.tsx:76`, `PaymentsPage.tsx:172-179,199`, `BillingActsPage.tsx:101`, `BillingActDetailPage.tsx:80`, `CreateBillingActPage.tsx:360`, `OfflineGrantActivationPanel.tsx:189`, `OfflineGrantPoliciesPanel.tsx:144`, `OfflineGrantReadinessPanel.tsx:132`, `CatalogVersionPanel.tsx:650,1100`, `SubscriptionPanel.tsx:108,172`, `TenantsPage.tsx:27,91`, `TenantPage.tsx:143`, `DeviceReplacementPanel.tsx:294`, `DeviceLicensingPanel.tsx:134,152`, `team/TeamPage.tsx:96`, `AuditPage.tsx:68`, `ServicePeriodsPage.tsx:50`, `OverviewPage.tsx:108`, `NationalCatalogPage.tsx:112`, `InvoiceDetailPage.tsx:351`, `BankAccountsPanel.tsx:157`, `HealthSummary.tsx:12`, `DecisionQueue.tsx:41`, `ReportsPage.tsx:525`, `AgreementDetailPage.tsx:254`.

Селекторы `.mk-chip` в `apps/saas-admin/src/global.css:4019` заменить на `.mk-tag`.

- [ ] **Шаг 5: Запустить тесты и гейты**

```bash
pnpm --filter @markiro/saas-admin exec vitest run
pnpm --filter @markiro/saas-admin typecheck
```

Ожидается: PASS. Оставшийся `status=` даст ошибку типов.

- [ ] **Шаг 6: Коммит**

```bash
git add apps/saas-admin
git commit -m "feat(saas-admin): фазы вместо тонов в платформенной панели"
```

---

### Задача 14: Подписант и entitlements

**Files:**

- Modify: `apps/signer/src/pages/Status.tsx:84-87` и таблица `PHASE_TONE` выше по файлу
- Modify: `packages/ui/src/entitlements/index.tsx:94-101`

**Interfaces:**

- Consumes: `TagPhase`.
- Produces: ничего.

- [ ] **Шаг 1: Переписать подписант**

Заменить локальную таблицу `PHASE_TONE` (строки 11–18). Ключи совпадают с текущими один к одному:

```tsx
const SIGNER_PHASE_TO_TAG_PHASE = {
  unpaired: "none",
  idle: "active",
  reconnecting: "attention",
  unavailable: "failed",
  working: "running",
  degraded: "attention",
} as const satisfies Record<string, TagPhase>;
```

Содержательные изменения: `unpaired` перестаёт быть просто серым и становится «значения нет» с точкой; `idle` — это рабочее состояние агента, а не успех разовой операции, поэтому `active`; `degraded` уезжает из `error` в `attention` — деградация не равна недоступности, и раньше они были неразличимы.

Строки 84–87 заменить на:

```tsx
<StatusChip
  phase={SIGNER_PHASE_TO_TAG_PHASE[status.phase]}
  label={t(`status.phase.${status.phase}`)}
/>
```

- [ ] **Шаг 2: Переписать entitlements**

В `packages/ui/src/entitlements/index.tsx` строки 94–101 заменить `status="info"` на `phase="planned"`, сохранив выражение `label` без изменений.

- [ ] **Шаг 3: Запустить гейты**

```bash
pnpm --filter @markiro/ui build
pnpm --filter @markiro/ui exec vitest run
pnpm --filter @markiro/signer exec vitest run
pnpm --filter @markiro/signer typecheck
```

Ожидается: PASS.

- [ ] **Шаг 4: Коммит**

```bash
git add apps/signer/src/pages/Status.tsx packages/ui/src/entitlements/index.tsx
git commit -m "feat(signer,ui): фазы вместо тонов в подписанте и карточке прав"
```

---

### Задача 15: Ревизия подписей

Спека требует: там, где подпись спорит с новым глифом, правится текст, а не глиф. Словарь фаз выбирался так, чтобы существующие подписи оставались верными, поэтому правки ожидаются точечные — но проверить обязаны все, и на обоих языках.

**Files:**

- Modify (по результату проверки): `apps/admin/src/i18n/ru.json`, `apps/admin/src/i18n/en.json`, `apps/saas-admin/src/i18n/ru.json`, `apps/saas-admin/src/i18n/en.json`

**Interfaces:**

- Consumes: фазы, назначенные в задачах 6–14.
- Produces: ничего.

- [ ] **Шаг 1: Выписать подписи, чей смысл разошёлся с фазой**

Прочитать подписи у семи мест, где фаза поменяла смысл сильнее всего, и решить по каждому, верен ли текст:

| Ключ                                    | Новая фаза и глиф | Что проверяем                                                     |
| --------------------------------------- | ----------------- | ----------------------------------------------------------------- |
| `pages.codeSearch.status.free`          | `active` `▸`      | «Свободен» с глифом «идёт» — не читается ли как «печатается»      |
| `pages.codeSearch.chz.APPLIED`          | `running` `⟳`     | нанесение как процесс, а не как факт                              |
| `integrations.state.unavailable`        | `attention` `!`   | «Недоступен» перестал быть справкой и стал поводом вмешаться      |
| `pages.billing.status.access.unmanaged` | `none` `·`        | «Не под управлением» — это отсутствие значения, а не тревога      |
| `pages.billing.status.access.read_only` | `attention` `!`   | «Только чтение» — ограничение, требующее внимания                 |
| `status.phase.idle` (подписант)         | `active` `▸`      | «Простой» с глифом «идёт» — почти наверняка требует другого слова |
| `status.phase.degraded` (подписант)     | `attention` `!`   | деградация перестала быть неотличимой от недоступности            |

Строку `status.phase.idle` подписанта ожидаемо придётся переписать: «Простой» рядом с `▸` противоречив. Подобрать формулировку, описывающую рабочее дежурное состояние агента.

- [ ] **Шаг 2: Внести правки в русские файлы**

Править только те ключи, по которым шаг 1 дал расхождение. Ни один ключ не удалять и не добавлять: наборы ключей зафиксированы тестом соответствия языков.

- [ ] **Шаг 3: Внести те же правки в английские файлы**

Для каждого исправленного русского ключа исправить английский. Наборы ключей в паре файлов обязаны остаться идентичными.

- [ ] **Шаг 4: Прогнать тесты соответствия языков**

```bash
pnpm --filter @markiro/admin exec vitest run test/i18n-lockstep.test.ts
pnpm --filter @markiro/saas-admin exec vitest run test/i18n-lockstep.test.ts
pnpm --filter @markiro/signer exec vitest run
```

Ожидается: PASS. Если файла с таким именем нет, найти фактический тест соответствия ключей командой `grep -rln "en.json" apps/admin/test apps/saas-admin/test` и запустить его.

- [ ] **Шаг 5: Коммит**

```bash
git add apps/admin/src/i18n apps/saas-admin/src/i18n apps/signer/src
git commit -m "fix(i18n): подписи статусов под новый словарь фаз"
```

Если шаг 1 не выявил ни одного расхождения, коммит не делать и отметить это в отчёте — это допустимый исход.

---

### Задача 16: Инвариант словаря фаз и финальные гейты

**Files:**

- Modify: `packages/ui/test/components.test.tsx` (добавить блок в конец)

**Interfaces:**

- Consumes: `PHASE_GLYPH`, `PHASE_TONE` из задачи 3.
- Produces: ничего.

- [ ] **Шаг 1: Написать тест инварианта**

В конец `packages/ui/test/components.test.tsx` добавить:

```tsx
describe("инвариант словаря фаз", () => {
  const PHASES = Object.keys(PHASE_GLYPH) as TagPhase[];

  it("даёт каждой фазе непустой глиф", () => {
    for (const phase of PHASES) {
      expect(PHASE_GLYPH[phase].length).toBeGreaterThan(0);
    }
  });

  /**
   * Правило серого из спеки. Серый читается как «сущности больше нет»,
   * поэтому фаза завершения серой быть не может — именно с этого начался
   * разбор: закрытая смена выглядела как ненастроенный канал.
   */
  it("допускает серый только там, где значения действительно нет", () => {
    const grey = PHASES.filter((phase) => PHASE_TONE[phase] === "neutral");

    expect(new Set(grey)).toEqual(new Set(["draft", "retired", "dismantled", "none"]));
  });

  it("не оставляет ни одну фазу без тона из разрешённого набора", () => {
    const allowed = new Set(["neutral", "ok", "done", "warn", "error", "info"]);

    for (const phase of PHASES) {
      expect(allowed.has(PHASE_TONE[phase])).toBe(true);
    }
  });
});
```

`PHASE_GLYPH` и `PHASE_TONE` не экспортируются из `components/index.ts` намеренно, поэтому импорт идёт прямо из модуля:

```tsx
import { PHASE_GLYPH, PHASE_TONE } from "../src/components/StatusChip.js";
import type { TagPhase } from "../src/components/StatusChip.js";
```

- [ ] **Шаг 2: Запустить тест**

```bash
pnpm --filter @markiro/ui exec vitest run test/components.test.tsx -t "инвариант"
```

Ожидается: PASS, 3 теста.

- [ ] **Шаг 3: Прогнать все затронутые пакеты**

```bash
pnpm turbo lint typecheck test build --concurrency=1 --force --filter=@markiro/ui --filter=@markiro/admin --filter=@markiro/saas-admin --filter=@markiro/kiosk --filter=@markiro/station --filter=@markiro/signer
```

Ожидается: всё зелёное. Пропуски тестов из-за отсутствия `DATABASE_URL` зафиксировать отдельно — они не относятся к этому изменению, но должны быть названы в отчёте.

- [ ] **Шаг 4: Проверить форматирование и отсутствие мусора**

```bash
git diff --check
pnpm format:check
```

Ожидается: без вывода и без ошибок.

- [ ] **Шаг 5: Проверить, что старый API нигде не остался**

```bash
grep -rn "StatusChipStatus\|status=\"ok\"\|status=\"warn\"\|status=\"neutral\"\|tone=\"accent\"" --include="*.tsx" --include="*.ts" apps packages
```

Ожидается: пусто. Любое совпадение — пропущенная точка вызова.

- [ ] **Шаг 6: Коммит**

```bash
git add packages/ui/test/components.test.tsx
git commit -m "test(ui): инвариант словаря фаз и правила серого"
```

---

## Проверка в браузере

Автоматические тесты не подтверждают визуальный результат. После задачи 16 открыть на светлой и тёмной теме и сверить со спекой:

- смены — таблица и панель подробностей, ради которых всё затевалось;
- поиск по коду — карточки короба, паллеты и кода;
- дезагрегация — список и строки документа;
- самовывоз — список заявок;
- интеграции — список каналов;
- платформенная панель — договоры, счета, каталог.

Станция и киоск проверяются отдельно: `size="floor"` и `size="wall"` не подтверждаются офисными тестами, а карточка смены на станции меняет глифы с `● ■ ◷` на словарные.

В отчёте разделить автоматические проверки и браузерные, и назвать всё, что не запускалось.

---

## Поправка по ходу исполнения, 19.09.2026

Ревью задачи 6 нашло дефект плана. Задача 6 заменяла `<Badge tone="warn" wrap>`
на `<StatusChip phase="attention">` в колонке статуса паллеты, а у тега фазы
пропа `wrap` не было. Обоснование в плане — «тег фазы короткий, а колонка
полагается на вертикальную стопку» — неверно: подпись та же самая, тег фазы
вдобавок шире на глиф, а стопка не меняет `min-content` колонки, потому что
каждый её тег всё равно отдаёт свою полную ширину. Это вернуло бы
задокументированное в том же файле переполнение панели 720px.

Решение владельца: `wrap` получает и тег фазы. Перенос это вопрос вёрстки, а не
семантики, и класс `.mk-tag--wrap` из задачи 2 уже универсален.

Изменения к задачам 3 и 6, выполненные отдельным коммитом после ревью задачи 6:

- `StatusChipProps` получает `wrap?: boolean`, компонент навешивает
  `mk-tag--wrap`, добавлен тест на `height: auto` и сохранение `min-height`.
- Обе точки вызова в `ShiftDetailsPanel.tsx` получают `wrap`, комментарий
  переписан на фактическое положение дел.
- Ассертация переноса в `apps/admin/test/pallets.test.tsx` восстановлена.

Спека обновлена в разделах «Геометрия» и «Изменения в API».
