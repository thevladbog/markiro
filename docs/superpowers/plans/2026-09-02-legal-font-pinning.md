# Пин шрифтов IBM Plex для генерации legal-PDF — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Генерация legal-PDF перестаёт зависеть от установленных в системе шрифтов: четыре TTF IBM Plex вендорятся в `packages/legal-documents/fonts/` и подкладываются в одноразовый LibreOffice-профиль перед каждой конвертацией.

**Architecture:** `stageLibreOfficeFonts(profileDirectory)` в `generate-artifacts.ts` копирует вендоренные TTF в обе папки пользовательских шрифтов профиля (macOS-путь и Linux/XDG-путь) до запуска `soffice`. Состав и хэши вендоренных файлов пинятся тестом. Байты артефактов не меняются — манифест и аттестация не трогаются.

**Tech Stack:** TypeScript (ESM), vitest, node:fs/promises; LibreOffice 26.2.5 (`SOFFICE_BIN=/opt/homebrew/bin/soffice`), veraPDF через docker.

**Spec:** `docs/superpowers/specs/2026-09-02-legal-font-pinning-design.md`

## Global Constraints

- Байты всех 21 артефактов в `apps/landing/public/legal/` НЕ меняются; `deploy/production/*` НЕ меняется. Если после перегенерации `git status` показывает изменения в `apps/landing/public/legal/` — это провал, останавливайся и разбирайся.
- Вендорятся ровно четыре файла: `IBMPlexSans-Regular.ttf` (200500 байт, sha256 `975dcda37d80f038dcd143c22e33ca2d97a0cc5a929aace1c749153b0fe1afa5`), `IBMPlexSans-Bold.ttf` (200872, `9e6c74a889a700d707613d24548fe4ffa6bc59559a0689d2cf9e133bdcdafb2f`), `IBMPlexMono-Regular.ttf` (155940, `fe11304a5fe956d5744e9b6a246cc83d90425245e75a62230044966ca96a7f50`), `IBMPlexMono-Bold.ttf` (157924, `ca403c56931baef307d20ba64b69acb71abcad61f75e66414661d57484b690ec`). Источник копирования: `~/Library/Fonts/`.
- Генерация артефактов запускается только так: `SOFFICE_BIN=/opt/homebrew/bin/soffice VERAPDF_CONTAINER_RUNTIME="$(command -v docker)" pnpm --filter @markiro/legal-documents artifacts:generate` (из корня repo). Верификация — тот же префикс с `artifacts:verify`.
- Прогон тестов пакета: `pnpm --filter @markiro/legal-documents test` (фильтровать конкретный файл: `pnpm --filter @markiro/legal-documents test -- test/fonts.test.ts`).
- Форматирование: перед финальным коммитом `pnpm format:check` (поправить `pnpm format`, если ругается на новые файлы).
- Не использовать `git stash` (общий стек с другими сессиями).

---

### Task 1: Вендоринг шрифтов + пин-тест

**Files:**
- Create: `packages/legal-documents/fonts/IBMPlexSans-Regular.ttf` (копия из `~/Library/Fonts/`)
- Create: `packages/legal-documents/fonts/IBMPlexSans-Bold.ttf`
- Create: `packages/legal-documents/fonts/IBMPlexMono-Regular.ttf`
- Create: `packages/legal-documents/fonts/IBMPlexMono-Bold.ttf`
- Create: `packages/legal-documents/fonts/OFL.txt`
- Create: `packages/legal-documents/fonts/README.md`
- Test: `packages/legal-documents/test/fonts.test.ts`

**Interfaces:**
- Consumes: ничего.
- Produces: каталог `packages/legal-documents/fonts/` с ровно шестью файлами (4 × `.ttf` + `OFL.txt` + `README.md`). Task 2 читает `*.ttf` из него.

- [ ] **Step 1: Скопировать четыре TTF**

```bash
mkdir -p packages/legal-documents/fonts
cp ~/Library/Fonts/IBMPlexSans-Regular.ttf ~/Library/Fonts/IBMPlexSans-Bold.ttf ~/Library/Fonts/IBMPlexMono-Regular.ttf ~/Library/Fonts/IBMPlexMono-Bold.ttf packages/legal-documents/fonts/
shasum -a 256 packages/legal-documents/fonts/*.ttf
```

Expected: четыре sha256 совпадают с таблицей в Global Constraints. Если хоть один не совпал — STOP (системные шрифты изменились с момента спека, эскалируй).

- [ ] **Step 2: Скачать лицензию OFL**

```bash
curl -fsSL https://raw.githubusercontent.com/IBM/plex/master/LICENSE.txt -o packages/legal-documents/fonts/OFL.txt
grep -c "SIL OPEN FONT LICENSE Version 1.1" packages/legal-documents/fonts/OFL.txt
head -3 packages/legal-documents/fonts/OFL.txt
```

Expected: grep печатает `1` (или больше), head показывает копирайт IBM. Если URL умер — взять LICENSE.txt из любого репозитория github.com/IBM/plex* (это один и тот же OFL-текст) и указать фактический источник в README из Step 3.

- [ ] **Step 3: Написать README провенанса**

Создать `packages/legal-documents/fonts/README.md`:

```markdown
# Вендоренные шрифты IBM Plex

Эти четыре TTF — единственные начертания, встраиваемые в legal-PDF
(проверено `pdffonts` по всем 17 PDF релиза): курсивы и другие веса
не используются.

| Файл | Семейство | Версия | sha256 |
| --- | --- | --- | --- |
| `IBMPlexSans-Regular.ttf` | IBM Plex Sans | 3.005 | `975dcda37d80f038dcd143c22e33ca2d97a0cc5a929aace1c749153b0fe1afa5` |
| `IBMPlexSans-Bold.ttf` | IBM Plex Sans | 3.005 | `9e6c74a889a700d707613d24548fe4ffa6bc59559a0689d2cf9e133bdcdafb2f` |
| `IBMPlexMono-Regular.ttf` | IBM Plex Mono | 2.004 | `fe11304a5fe956d5744e9b6a246cc83d90425245e75a62230044966ca96a7f50` |
| `IBMPlexMono-Bold.ttf` | IBM Plex Mono | 2.004 | `ca403c56931baef307d20ba64b69acb71abcad61f75e66414661d57484b690ec` |

Источник: https://github.com/IBM/plex (лицензия — SIL OFL 1.1, см.
`OFL.txt`; разрешает редистрибуцию). Файлы байт-в-байт совпадают со
шрифтами машины, на которой сгенерирован и аттестован текущий релиз
артефактов, поэтому вендоринг не изменил байты PDF.

`stageLibreOfficeFonts()` (`src/cli/generate-artifacts.ts`) копирует их
в папку пользовательских шрифтов одноразового LibreOffice-профиля перед
каждой конвертацией, так что генерация работает и на машине без
установленных IBM Plex.

Ограничение: если в системе установлена *другая* версия Plex, какая из
двух копий победит при совпадении имени семейства — внутреннее
поведение LibreOffice. Дрейф ловится байт-сверкой с манифестом и
аттестацией (`artifacts:verify`, `deploy/production/verify-legal-artifacts.mjs`).

Состав и хэши каталога пинит `test/fonts.test.ts` — при замене файлов
обнови таблицу и тест сознательно.
```

- [ ] **Step 4: Написать пин-тест (сначала убедиться, что он падает на пустом каталоге не нужно — каталог уже заполнен; тест пишется как контракт)**

Создать `packages/legal-documents/test/fonts.test.ts`:

```ts
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const FONTS_ROOT = fileURLToPath(new URL("../fonts/", import.meta.url));

const PINNED_FONTS = [
  {
    name: "IBMPlexMono-Bold.ttf",
    bytes: 157924,
    sha256: "ca403c56931baef307d20ba64b69acb71abcad61f75e66414661d57484b690ec",
  },
  {
    name: "IBMPlexMono-Regular.ttf",
    bytes: 155940,
    sha256: "fe11304a5fe956d5744e9b6a246cc83d90425245e75a62230044966ca96a7f50",
  },
  {
    name: "IBMPlexSans-Bold.ttf",
    bytes: 200872,
    sha256: "9e6c74a889a700d707613d24548fe4ffa6bc59559a0689d2cf9e133bdcdafb2f",
  },
  {
    name: "IBMPlexSans-Regular.ttf",
    bytes: 200500,
    sha256: "975dcda37d80f038dcd143c22e33ca2d97a0cc5a929aace1c749153b0fe1afa5",
  },
] as const;

describe("vendored fonts", () => {
  it("contains exactly the pinned TTFs plus license and readme", () => {
    expect(readdirSync(FONTS_ROOT).sort()).toEqual([
      ...PINNED_FONTS.map(({ name }) => name),
      "OFL.txt",
      "README.md",
    ]);
  });

  it.each(PINNED_FONTS)("pins $name byte-for-byte", ({ name, bytes, sha256 }) => {
    const content = readFileSync(path.join(FONTS_ROOT, name));
    expect(content.byteLength).toBe(bytes);
    expect(createHash("sha256").update(content).digest("hex")).toBe(sha256);
    // TrueType magic: 0x00010000.
    expect([...content.subarray(0, 4)]).toEqual([0, 1, 0, 0]);
  });

  it("ships the SIL OFL 1.1 license text", () => {
    expect(readFileSync(path.join(FONTS_ROOT, "OFL.txt"), "utf8")).toContain(
      "SIL OPEN FONT LICENSE Version 1.1",
    );
  });
});
```

- [ ] **Step 5: Прогнать тест**

Run: `pnpm --filter @markiro/legal-documents test -- test/fonts.test.ts`
Expected: PASS (6 тестов: состав + 4 пина + лицензия).

- [ ] **Step 6: Проверить, что пакет отдаёт каталог**

`packages/legal-documents/package.json` уже экспортирует `"./assets/*": "./assets/*"`; для `fonts/` экспорт НЕ нужен (читается только внутри пакета через `import.meta.url`). Убедиться, что `files`-массива, который мог бы отфильтровать `fonts/` при publish, в package.json нет:

Run: `grep -n '"files"' packages/legal-documents/package.json || echo no-files-field`
Expected: `no-files-field` (пакет приватный, поле отсутствует).

- [ ] **Step 7: Commit**

```bash
git add packages/legal-documents/fonts packages/legal-documents/test/fonts.test.ts
git commit -m "feat(legal): vendor the four embedded IBM Plex faces with a byte pin"
```

---

### Task 2: stageLibreOfficeFonts + подключение к конвертации

**Files:**
- Modify: `packages/legal-documents/src/cli/generate-artifacts.ts` (импорты ~строка 3-17; новый код рядом с `libreOfficeEnvironment` ~строка 149-163; вызов в `convertPdf` внутри `createDefaultDependencies` ~строка 985-998)
- Test: `packages/legal-documents/test/fonts.test.ts` (дописать describe-блок)

**Interfaces:**
- Consumes: каталог `packages/legal-documents/fonts/*.ttf` из Task 1.
- Produces: `export const LIBREOFFICE_PROFILE_FONT_DIRECTORIES: readonly string[]` (относительные пути) и `export async function stageLibreOfficeFonts(profileDirectory: string): Promise<void>` в `src/cli/generate-artifacts.ts`. Task 3 полагается на то, что каждый вызов `convertPdf` стейджит шрифты.

- [ ] **Step 1: Дописать падающий тест на staging**

В конец `packages/legal-documents/test/fonts.test.ts` добавить (и дополнить импорты):

```ts
// В импорты сверху добавить:
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

import {
  LIBREOFFICE_PROFILE_FONT_DIRECTORIES,
  stageLibreOfficeFonts,
} from "../src/cli/generate-artifacts.js";

// В конец файла:
describe("stageLibreOfficeFonts", () => {
  it("copies every vendored TTF into both profile font directories", async () => {
    const profile = mkdtempSync(path.join(tmpdir(), "markiro-fonts-"));
    try {
      await stageLibreOfficeFonts(profile);
      expect(LIBREOFFICE_PROFILE_FONT_DIRECTORIES).toHaveLength(2);
      for (const directory of LIBREOFFICE_PROFILE_FONT_DIRECTORIES) {
        for (const { name, sha256 } of PINNED_FONTS) {
          const staged = readFileSync(path.join(profile, directory, name));
          expect(createHash("sha256").update(staged).digest("hex")).toBe(sha256);
        }
      }
    } finally {
      rmSync(profile, { force: true, recursive: true });
    }
  });
});
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `pnpm --filter @markiro/legal-documents test -- test/fonts.test.ts`
Expected: FAIL — `generate-artifacts.js` не экспортирует `stageLibreOfficeFonts` (ошибка импорта).

- [ ] **Step 3: Реализовать staging**

В `packages/legal-documents/src/cli/generate-artifacts.ts`:

1. В импорт из `node:fs/promises` добавить `copyFile` (список уже содержит `lstat, link, mkdir, …` — вставить по алфавиту).
2. Сразу после `libreOfficeProfileDirectory` (после ~строки 178) добавить:

```ts
// dist/cli/../../fonts and src/cli/../../fonts both resolve to the package
// root, mirroring INSTRUCTION_ASSETS_ROOT below.
const VENDORED_FONTS_ROOT = fileURLToPath(new URL("../../fonts/", import.meta.url));

// LibreOffice scans <UserInstallation>/user/fonts on every platform. The
// profile is anchored by HOME on macOS and by XDG_CONFIG_HOME elsewhere
// (libreOfficeEnvironment), so stage the fonts under both roots instead of
// branching on the platform.
export const LIBREOFFICE_PROFILE_FONT_DIRECTORIES: readonly string[] = [
  path.join("Library", "Application Support", "LibreOffice", "4", "user", "fonts"),
  path.join("xdg-config", "libreoffice", "4", "user", "fonts"),
];

export async function stageLibreOfficeFonts(profileDirectory: string): Promise<void> {
  const entries = await readdir(VENDORED_FONTS_ROOT, { withFileTypes: true });
  const fonts = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ttf"))
    .map(({ name }) => name);
  if (fonts.length === 0) {
    throw new Error(`Vendored IBM Plex fonts are missing at ${VENDORED_FONTS_ROOT}`);
  }
  for (const directory of LIBREOFFICE_PROFILE_FONT_DIRECTORIES) {
    const target = path.join(profileDirectory, directory);
    await mkdir(target, { recursive: true });
    for (const name of fonts) {
      await copyFile(path.join(VENDORED_FONTS_ROOT, name), path.join(target, name));
    }
  }
}
```

3. В `convertPdf` внутри `createDefaultDependencies` (~строка 985) добавить staging после `Promise.all` с mkdir'ами, до `runTextCommand`:

```ts
    convertPdf: async ({ sofficeBin, sourcePath, outputDirectory }) => {
      const profileDirectory = libreOfficeProfileDirectory(outputDirectory, sourcePath);
      await mkdir(profileDirectory, { recursive: true });
      await Promise.all([
        mkdir(path.join(profileDirectory, "tmp"), { recursive: true }),
        mkdir(path.join(profileDirectory, "xdg-cache"), { recursive: true }),
        mkdir(path.join(profileDirectory, "xdg-config"), { recursive: true }),
      ]);
      await stageLibreOfficeFonts(profileDirectory);
      return runTextCommand(
        sofficeBin,
        libreOfficePdfExportArguments(outputDirectory, sourcePath),
        libreOfficeEnvironment(profileDirectory),
      );
    },
```

- [ ] **Step 4: Прогнать тесты файла**

Run: `pnpm --filter @markiro/legal-documents test -- test/fonts.test.ts`
Expected: PASS (7 тестов: прежние 6 + staging).

- [ ] **Step 5: Прогнать все тесты пакета и сборку**

Run: `pnpm --filter @markiro/legal-documents build && pnpm --filter @markiro/legal-documents test`
Expected: сборка ок, все тесты PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/legal-documents/src/cli/generate-artifacts.ts packages/legal-documents/test/fonts.test.ts
git commit -m "feat(legal): stage vendored IBM Plex fonts into each LibreOffice conversion profile"
```

---

### Task 3: Эксперимент «машина без IBM Plex» + штатная перегенерация

Задача доказывает два утверждения приёмки: (а) без системных Plex генерация проходит и даёт байт-идентичный релиз; (б) со штатными шрифтами — тоже. Изменений кода в задаче нет; коммитится только результат «артефакты не изменились» (т.е. НИЧЕГО в `apps/landing/public/legal/`).

**Files:**
- Modify: нет (только временные перемещения шрифтов вне репозитория).

**Interfaces:**
- Consumes: `stageLibreOfficeFonts`, задействованный в `convertPdf` (Task 2).
- Produces: подтверждение байт-идентичности для отчёта в PR.

- [ ] **Step 1: Спрятать системные шрифты (с гарантией возврата)**

```bash
mkdir -p ~/plex-fonts-backup && mv ~/Library/Fonts/IBMPlex* ~/plex-fonts-backup/ && ls ~/Library/Fonts | grep -c IBMPlex || echo "system plex hidden"
```

Expected: `system plex hidden` (grep находит 0). ВАЖНО: шрифты обязаны вернуться на место в Step 3 даже при провале Step 2.

- [ ] **Step 2: Полная перегенерация без системных шрифтов**

```bash
SOFFICE_BIN=/opt/homebrew/bin/soffice VERAPDF_CONTAINER_RUNTIME="$(command -v docker)" pnpm --filter @markiro/legal-documents artifacts:generate
git status --short apps/landing/public/legal/
```

Expected: генерация завершилась «Validated 21 immutable legal artifacts …», `git status` по каталогу пуст (байт-идентично). Если генерация упала на font-substitution или байты изменились — вернуть шрифты (Step 3) и эскалировать: значит профильные шрифты не подхватываются, wiring из Task 2 надо диагностировать (первым делом проверить, что TTF реально лежат в `…/internal/libreoffice-home/<doc>/Library/Application Support/LibreOffice/4/user/fonts` — каталог `internal/` остаётся после прогона).

- [ ] **Step 3: Вернуть системные шрифты (безусловно)**

```bash
mv ~/plex-fonts-backup/IBMPlex* ~/Library/Fonts/ && rmdir ~/plex-fonts-backup && ls ~/Library/Fonts | grep -c IBMPlex
```

Expected: `32` (все семейство вернулось).

- [ ] **Step 4: Штатная перегенерация с системными шрифтами**

```bash
SOFFICE_BIN=/opt/homebrew/bin/soffice VERAPDF_CONTAINER_RUNTIME="$(command -v docker)" pnpm --filter @markiro/legal-documents artifacts:generate
SOFFICE_BIN=/opt/homebrew/bin/soffice VERAPDF_CONTAINER_RUNTIME="$(command -v docker)" pnpm --filter @markiro/legal-documents artifacts:verify
git status --short apps/landing/public/legal/ deploy/production/
```

Expected: generate «Validated 21 …», verify зелёный, git status по обоим каталогам пуст.

- [ ] **Step 5: Зафиксировать результат в отчёте задачи**

Коммита нет (нет изменений файлов). В отчёте задачи записать дословно: обе перегенерации байт-идентичны, verify зелёный.

---

### Task 4: Финальная верификация ветки

**Files:**
- Modify: возможно только форматирование новых файлов.

- [ ] **Step 1: Формат и линт**

```bash
pnpm format:check
pnpm --filter @markiro/legal-documents lint
```

Expected: оба зелёные. Если format:check ругается на новые файлы — `pnpm format`, перепроверить, добавить в коммит fixup.

- [ ] **Step 2: Полный тестовый прогон пакета + лендинга**

```bash
pnpm --filter @markiro/legal-documents test
pnpm --filter @markiro/landing test
```

Expected: PASS (лендинг проверяет манифест/артефакты — они не менялись, но прогон подтверждает).

- [ ] **Step 3: Чистота дерева и итог**

```bash
git status --short
git log --oneline origin/main..HEAD
```

Expected: дерево чистое; в ветке коммиты спека, Task 1 и Task 2 (+ возможный fixup форматирования).
