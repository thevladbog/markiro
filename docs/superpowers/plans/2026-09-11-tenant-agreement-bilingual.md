# Bilingual MKR-AGR-01 Agreement Form Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Print the standard Markiro client agreement as one document with Russian in the left column and English in the right, selected per agreement record in the saas-admin registry.

**Architecture:** The agreement module splits by locale — a shared dispatcher, a Russian section builder and an English one of identical shape. A `pairLocaleContent` walker zips the two trees and throws on any structural divergence, which is the mechanical guard against a clause silently missing from one column. A new two-column renderer in `docx.ts` emits one borderless table per section, reusing the existing block renderer inside each cell; four appendices that are Russian accounting forms render full width. `platform_agreements.document_form` selects the path.

**Tech Stack:** TypeScript (strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), `docx@9.7.1`, Zod 4, Drizzle ORM + Postgres, NestJS, React/Vite, Vitest.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-09-11-tenant-agreement-bilingual-design.md`.
- The customer stays Russian. `PartyRequisites` and `PartyKind` do not change.
- Bilingual sections: preamble, body 1–12, appendices 1, 2, 3, 4, 9, 10.
- Russian-only sections, exact ids: `prilozhenie-5`, `prilozhenie-6`, `prilozhenie-7`, `prilozhenie-8`.
- The single-locale render path must stay byte-identical. Every published artifact is pinned by a test added in PR #501; it must keep passing without edits.
- `AGREEMENT_CODE = "MKR-AGR-01"`, `AGREEMENT_REVISION = "2026.09/01"` (`apps/api/src/modules/platform-agreements/agreement-documents.service.ts:33-34`).
- Order, assignment, invoice and statement numbers stay placeholders in both columns. Only the agreement's own number, conclusion date, city, requisites, signatory, penalty rate, penalty cap and dispute venue are filled.
- Workspace packages export compiled `dist`. After changing `@markiro/legal-documents`, `@markiro/db` or `@markiro/platform-contracts`, build them before running consumer tests: `pnpm turbo run build --filter='@markiro/api^...'`.
- Never hand-edit `pnpm-lock.yaml`. No new dependencies are required by this plan.

## Translation Glossary

Every translation task uses these renderings. Inconsistent terminology across
tasks is the main way a multi-task translation goes wrong, so this table is
binding, not advisory.

| Russian                                    | English                                    |
| ------------------------------------------ | ------------------------------------------ |
| Исполнитель                                | the Contractor                             |
| Заказчик                                   | the Customer                               |
| Стороны / Сторона                          | the Parties / the Party                    |
| простая (неисключительная) лицензия        | simple (non-exclusive) licence             |
| программа для ЭВМ «Маркиро»                | the Markiro computer program               |
| Личный кабинет                             | the Cabinet                                |
| Станция                                    | the Station                                |
| Приложение № N                             | Appendix No. N                             |
| Заказ (Приложение № 1)                     | the Order                                  |
| Задание (Приложение № 4)                   | the Assignment                             |
| счёт на оплату                             | invoice                                    |
| акт                                        | statement                                  |
| вознаграждение                             | fee                                        |
| неустойка                                  | penalty                                    |
| ГК РФ                                      | the Civil Code of the Russian Federation   |
| персональные данные                        | personal data                              |
| поручение на обработку персональных данных | personal data processing instruction       |
| налог на профессиональный доход (НПД)      | tax on professional income                 |
| ИНН / КПП / ОГРН / ОГРНИП                  | TIN / KPP / PSRN / PSRNSP                  |
| БИК                                        | BIC                                        |
| расчётный счёт / корреспондентский счёт    | settlement account / correspondent account |
| простая электронная подпись (ПЭП)          | simple electronic signature                |

British spelling (`licence` as the noun, `organisation`) throughout, matching
the existing English instruction set.

## File Structure

**`packages/legal-documents`**

- Modify `src/documents/tenant-agreement.ts` — becomes the dispatcher: `buildTenantAgreement`, the title and summary per locale, and nothing else.
- Create `src/documents/tenant-agreement-parts.ts` — the shared field helpers (`partyName`, `kppCell`, `registryCell`, `representative`, `preamble`, `requisitesRows`), imported by both locale builders so neither imports the other.
- Create `src/documents/tenant-agreement-ru.ts` — the Russian section builder, moved verbatim.
- Create `src/documents/tenant-agreement-en.ts` — the English section builder, identical in shape.
- Create `src/documents/tenant-agreement-bilingual.ts` — `pairLocaleContent`, `BilingualContent`, `AGREEMENT_MONOLINGUAL_SECTION_IDS`.
- Modify `src/artifacts/docx.ts` — thread an available width through `legalTableColumnWidths` / `renderTable` / `renderBlock`; add `renderLegalDocxBilingual`.
- Modify `src/index.ts` — export `pairLocaleContent`, `renderLegalDocxBilingual`, `AGREEMENT_MONOLINGUAL_SECTION_IDS` from the root entry (node10/CommonJS resolution cannot see subpath exports).
- Test `test/tenant-agreement.test.ts`, create `test/tenant-agreement-bilingual.test.ts`, `test/docx-bilingual.test.ts`.

**`packages/db`**

- Modify `src/schema/agreements.ts` — `documentForm` column plus its check constraint.
- Create `migrations/NNNN_<generated>.sql`.

**`packages/platform-contracts`**

- Modify `src/agreements.ts` — `agreementDocumentFormSchema`, field on summary/detail/create/update.

**`apps/api`**

- Modify `src/modules/platform-agreements/platform-agreements.service.ts` — accept and persist the form.
- Modify `src/modules/platform-agreements/agreement-documents.service.ts` — pick the render path, filename suffix, renderer version.

**`apps/saas-admin`**

- Modify `src/pages/agreements/CreateAgreementPage.tsx`, `AgreementDetailPage.tsx`, `AgreementsPage.tsx`, `api.ts`.

---

### Task 1: Split the agreement module by locale

A pure move. Output must not change — the existing agreement tests are the
proof. Splitting first keeps every later task working in a file it can hold
in context: the Russian builder is already 1695 lines and the English one
will be comparable.

**Files:**

- Modify: `packages/legal-documents/src/documents/tenant-agreement.ts`
- Create: `packages/legal-documents/src/documents/tenant-agreement-ru.ts`
- Test: `packages/legal-documents/test/tenant-agreement.test.ts` (unchanged, must keep passing)

**Interfaces:**

- Consumes: `TenantAgreementFields`, `agreementField`, `agreementDate`, `isSoleProprietorOrIndividual` from `./tenant-agreement-fields.js`.
- Produces: `buildRuAgreementSections(fields: TenantAgreementFields): readonly LegalDocumentLocaleContent["sections"][number][]` from `tenant-agreement-ru.ts`; `buildTenantAgreement(fields, locale)` keeps its current signature and export path.

- [ ] **Step 1: Run the existing agreement tests to record the green baseline**

Run: `pnpm --filter @markiro/legal-documents exec vitest run test/tenant-agreement.test.ts`
Expected: PASS. Note the test count — the same count must pass at the end of this task.

- [ ] **Step 2: Create the Russian builder file**

Move everything from `tenant-agreement.ts` that produces sections into
`packages/legal-documents/src/documents/tenant-agreement-ru.ts`, and the
shared field helpers (`partyName`, `kppCell`, `registryCell`,
`representative`, `preamble`, `requisitesRows`) into
`packages/legal-documents/src/documents/tenant-agreement-parts.ts`. Both
locale builders import the helpers from there, so neither imports the other.
The Russian file's shape:

```ts
import type { LegalDocumentLocaleContent } from "../types.js";
import type { TenantAgreementFields } from "./tenant-agreement-fields.js";
import { agreementDate, agreementField } from "./tenant-agreement-fields.js";
import {
  kppCell,
  partyName,
  preamble,
  registryCell,
  representative,
  requisitesRows,
} from "./tenant-agreement-parts.js";

export type AgreementSection = LegalDocumentLocaleContent["sections"][number];

export function buildRuAgreementSections(
  fields: TenantAgreementFields,
): readonly AgreementSection[] {
  // ... the existing section array, moved verbatim
}
```

- [ ] **Step 3: Reduce the dispatcher**

`tenant-agreement.ts` becomes:

```ts
import type { LegalDocumentLocaleContent, LegalLocale } from "../types.js";
import { buildRuAgreementSections } from "./tenant-agreement-ru.js";
import type { TenantAgreementFields } from "./tenant-agreement-fields.js";

export function buildTenantAgreement(
  fields: TenantAgreementFields,
  locale: LegalLocale,
): LegalDocumentLocaleContent {
  if (locale !== "ru") {
    throw new Error("English tenant agreement is not available in this revision");
  }
  return {
    locale: "ru",
    title:
      "Договор о предоставлении права использования программы для ЭВМ «Маркиро», доступа к сервису и выполнении услуг и работ",
    summary:
      "Проект стандартного договора Маркиро с заказчиком-юридическим лицом или индивидуальным предпринимателем: простая (неисключительная) лицензия, доступ к серверной функциональности, а также услуги и работы по отдельным заданиям. Договор не считается заключённым, пока не заполнены поля в квадратных скобках и стороны не оформили его согласованным способом.",
    sections: buildRuAgreementSections(fields),
  };
}
```

- [ ] **Step 4: Run the tests to prove the move changed nothing**

Run: `pnpm --filter @markiro/legal-documents exec vitest run`
Expected: PASS, same count as Step 1, including the published-artifact byte-identity cases.

- [ ] **Step 5: Typecheck, lint, build**

Run: `pnpm --filter @markiro/legal-documents typecheck lint build`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add packages/legal-documents/src/documents
git commit -m "refactor(legal-documents): split the agreement builder by locale"
```

---

### Task 2: English structural clone and the pairing walker

The English tree arrives complete but untranslated: every section, in order,
with the same block kinds — carrying Russian text for now. That makes the
structural-equality invariant true from this commit onward, so translation
becomes safely incremental instead of a single 1700-line leap that cannot be
reviewed.

**Files:**

- Create: `packages/legal-documents/src/documents/tenant-agreement-en.ts`
- Create: `packages/legal-documents/src/documents/tenant-agreement-bilingual.ts`
- Modify: `packages/legal-documents/src/documents/tenant-agreement.ts`
- Modify: `packages/legal-documents/src/index.ts`
- Test: `packages/legal-documents/test/tenant-agreement-bilingual.test.ts`

**Interfaces:**

- Consumes: `buildRuAgreementSections`, `AgreementSection` (Task 1).
- Produces: `buildEnAgreementSections(fields): readonly AgreementSection[]`; `AGREEMENT_MONOLINGUAL_SECTION_IDS: ReadonlySet<string>`; `pairLocaleContent(ru, en, monolingualSectionIds): BilingualContent`; types `BilingualContent`, `BilingualSection`. Task 5 renders `BilingualContent`; Task 7 calls `pairLocaleContent`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/legal-documents/test/tenant-agreement-bilingual.test.ts
import { describe, expect, it } from "vitest";

import {
  AGREEMENT_MONOLINGUAL_SECTION_IDS,
  pairLocaleContent,
} from "../src/documents/tenant-agreement-bilingual.js";
import { buildTenantAgreement } from "../src/documents/tenant-agreement.js";
import type { PartyRequisites } from "../src/documents/tenant-agreement-fields.js";

const ORG_CUSTOMER: PartyRequisites = {
  kind: "legal_entity",
  name: "ООО «Ромашка»",
  inn: "7707083893",
  kpp: "770701001",
  ogrn: "1027700132195",
  address: "г. Москва, ул. Тверская, д. 1",
  email: "buh@romashka.example",
  phone: "+7 495 000-00-00",
  bankName: "ПАО Сбербанк",
  bic: "044525225",
  settlementAccount: "40702810000000000001",
  correspondentAccount: "30101810400000000225",
  taxRegime: "ОСНО",
};

const FILLED = {
  number: "MKR-2026-0001",
  conclusionDate: "2026-09-11",
  city: "Краснодар",
  customer: ORG_CUSTOMER,
} as const;

const BLANK = { customer: { ...ORG_CUSTOMER, name: "", inn: null, kpp: null } } as const;

describe("bilingual agreement", () => {
  for (const [label, fields] of [
    ["filled", FILLED],
    ["blank", BLANK],
  ] as const) {
    it(`pairs the ${label} agreement without structural divergence`, () => {
      const ru = buildTenantAgreement(fields, "ru");
      const en = buildTenantAgreement(fields, "en");
      expect(() => pairLocaleContent(ru, en, AGREEMENT_MONOLINGUAL_SECTION_IDS)).not.toThrow();
    });
  }

  it("marks exactly the four Russian accounting forms as monolingual", () => {
    expect([...AGREEMENT_MONOLINGUAL_SECTION_IDS].sort()).toEqual([
      "prilozhenie-5",
      "prilozhenie-6",
      "prilozhenie-7",
      "prilozhenie-8",
    ]);
  });

  it("every monolingual id exists in the document", () => {
    const ids = new Set(buildTenantAgreement(FILLED, "ru").sections.map((s) => s.id));
    for (const id of AGREEMENT_MONOLINGUAL_SECTION_IDS) {
      expect(ids.has(id)).toBe(true);
    }
  });

  it("renders monolingual sections once, across both columns", () => {
    const paired = pairLocaleContent(
      buildTenantAgreement(FILLED, "ru"),
      buildTenantAgreement(FILLED, "en"),
      AGREEMENT_MONOLINGUAL_SECTION_IDS,
    );
    const invoice = paired.sections.find((s) => s.id === "prilozhenie-5");
    expect(invoice?.bilingual).toBe(false);
    const preamble = paired.sections.find((s) => s.id === "storony");
    expect(preamble?.bilingual).toBe(true);
  });

  it("throws when a section is missing from one side", () => {
    const ru = buildTenantAgreement(FILLED, "ru");
    const en = buildTenantAgreement(FILLED, "en");
    const short = { ...en, sections: en.sections.slice(0, -1) };
    expect(() => pairLocaleContent(ru, short, AGREEMENT_MONOLINGUAL_SECTION_IDS)).toThrow(
      /section count/i,
    );
  });

  it("throws when block kinds diverge at the same position", () => {
    const ru = buildTenantAgreement(FILLED, "ru");
    const en = buildTenantAgreement(FILLED, "en");
    const mangled = {
      ...en,
      sections: en.sections.map((section, index) =>
        index === 1
          ? { ...section, blocks: [{ kind: "callout", tone: "info", text: "x" } as const] }
          : section,
      ),
    };
    expect(() => pairLocaleContent(ru, mangled, AGREEMENT_MONOLINGUAL_SECTION_IDS)).toThrow(
      /predmet/,
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @markiro/legal-documents exec vitest run test/tenant-agreement-bilingual.test.ts`
Expected: FAIL — cannot resolve `tenant-agreement-bilingual.js`.

- [ ] **Step 3: Write the pairing module**

```ts
// packages/legal-documents/src/documents/tenant-agreement-bilingual.ts
import type { LegalBlock, LegalDocumentLocaleContent } from "../types.js";

/**
 * The four Russian accounting forms. They are primary documents filled in
 * Russian for the tax authority, so an English column beside them would
 * suggest an invoice can be issued in English.
 */
export const AGREEMENT_MONOLINGUAL_SECTION_IDS: ReadonlySet<string> = new Set([
  "prilozhenie-5",
  "prilozhenie-6",
  "prilozhenie-7",
  "prilozhenie-8",
]);

export interface BilingualSection {
  readonly id: string;
  readonly startsPage?: boolean;
  readonly bilingual: boolean;
  readonly ru: { readonly heading: string; readonly blocks: readonly LegalBlock[] };
  readonly en: { readonly heading: string; readonly blocks: readonly LegalBlock[] };
}

export interface BilingualContent {
  readonly title: { readonly ru: string; readonly en: string };
  readonly summary: { readonly ru: string; readonly en: string };
  readonly sections: readonly BilingualSection[];
}

/**
 * Zips two locale trees of the same document. Throws on any divergence: the
 * one failure a bilingual contract hides is a clause present in one column
 * and absent from the other, and no reader checks that by eye.
 */
export function pairLocaleContent(
  ru: LegalDocumentLocaleContent,
  en: LegalDocumentLocaleContent,
  monolingualSectionIds: ReadonlySet<string>,
): BilingualContent {
  if (ru.sections.length !== en.sections.length) {
    throw new Error(
      `Bilingual agreement section count differs: ru=${ru.sections.length}, en=${en.sections.length}`,
    );
  }

  const sections = ru.sections.map((ruSection, index) => {
    // Non-null: the lengths were compared above.
    const enSection = en.sections[index] as (typeof en.sections)[number];
    if (ruSection.id !== enSection.id) {
      throw new Error(
        `Bilingual agreement section order differs at ${index}: ru=${ruSection.id}, en=${enSection.id}`,
      );
    }
    if (ruSection.blocks.length !== enSection.blocks.length) {
      throw new Error(
        `Bilingual agreement block count differs in ${ruSection.id}: ru=${ruSection.blocks.length}, en=${enSection.blocks.length}`,
      );
    }
    ruSection.blocks.forEach((ruBlock, blockIndex) => {
      // Non-null: the lengths were compared above.
      const enBlock = enSection.blocks[blockIndex] as LegalBlock;
      assertSameShape(ruSection.id, blockIndex, ruBlock, enBlock);
    });

    return {
      id: ruSection.id,
      ...(ruSection.startsPage === true ? { startsPage: true as const } : {}),
      bilingual: !monolingualSectionIds.has(ruSection.id),
      ru: { heading: ruSection.heading, blocks: ruSection.blocks },
      en: { heading: enSection.heading, blocks: enSection.blocks },
    } satisfies BilingualSection;
  });

  return {
    title: { ru: ru.title, en: en.title },
    summary: { ru: ru.summary, en: en.summary },
    sections,
  };
}

function assertSameShape(
  sectionId: string,
  blockIndex: number,
  ru: LegalBlock,
  en: LegalBlock,
): void {
  const where = `${sectionId}[${blockIndex}]`;
  if (ru.kind !== en.kind) {
    throw new Error(`Bilingual agreement block kind differs in ${where}: ${ru.kind} vs ${en.kind}`);
  }
  if (ru.kind === "ordered-list" || ru.kind === "unordered-list") {
    const enList = en as Extract<LegalBlock, { kind: "ordered-list" | "unordered-list" }>;
    if (ru.items.length !== enList.items.length) {
      throw new Error(
        `Bilingual agreement list length differs in ${where}: ${ru.items.length} vs ${enList.items.length}`,
      );
    }
  }
  if (ru.kind === "definition-list") {
    const enList = en as Extract<LegalBlock, { kind: "definition-list" }>;
    if (ru.items.length !== enList.items.length) {
      throw new Error(
        `Bilingual agreement definition count differs in ${where}: ${ru.items.length} vs ${enList.items.length}`,
      );
    }
  }
  if (ru.kind === "table") {
    const enTable = en as Extract<LegalBlock, { kind: "table" }>;
    if (ru.columns.length !== enTable.columns.length || ru.rows.length !== enTable.rows.length) {
      throw new Error(
        `Bilingual agreement table shape differs in ${where}: ${ru.columns.length}x${ru.rows.length} vs ${enTable.columns.length}x${enTable.rows.length}`,
      );
    }
  }
}
```

- [ ] **Step 4: Write the English structural clone**

```ts
// packages/legal-documents/src/documents/tenant-agreement-en.ts
import type { TenantAgreementFields } from "./tenant-agreement-fields.js";
import type { AgreementSection } from "./tenant-agreement-ru.js";
import { buildRuAgreementSections } from "./tenant-agreement-ru.js";

/**
 * The English tree is built section by section in later tasks. Until a
 * section is translated it carries the Russian text, so the structural
 * invariant holds from the first commit and translation stays reviewable in
 * pieces. `AGREEMENT_MONOLINGUAL_SECTION_IDS` names the four sections that
 * stay Russian permanently.
 */
export function buildEnAgreementSections(
  fields: TenantAgreementFields,
): readonly AgreementSection[] {
  return buildRuAgreementSections(fields);
}
```

- [ ] **Step 5: Wire the dispatcher and the package entry**

In `tenant-agreement.ts`, replace the `locale !== "ru"` throw:

```ts
export function buildTenantAgreement(
  fields: TenantAgreementFields,
  locale: LegalLocale,
): LegalDocumentLocaleContent {
  if (locale === "en") {
    return {
      locale: "en",
      title:
        "Agreement on granting the right to use the Markiro computer program, access to the service and performance of services and works",
      summary:
        "Draft of the standard Markiro agreement with a customer that is a legal entity or a sole proprietor: a simple (non-exclusive) licence, access to server-side functionality, and services and works under separate assignments. The agreement is not concluded until the bracketed fields are completed and the parties have executed it in an agreed manner.",
      sections: buildEnAgreementSections(fields),
    };
  }
  return {
    locale: "ru",
    title: "…",
    summary: "…",
    sections: buildRuAgreementSections(fields),
  };
}
```

In `packages/legal-documents/src/index.ts` add to the root entry — node10 and
CommonJS resolution cannot see subpath exports, which is why PR #501 moved
`renderLegalDocxDraft` to the root:

```ts
export {
  AGREEMENT_MONOLINGUAL_SECTION_IDS,
  pairLocaleContent,
} from "./documents/tenant-agreement-bilingual.js";
export type { BilingualContent, BilingualSection } from "./documents/tenant-agreement-bilingual.js";
```

- [ ] **Step 6: Delete the obsolete assertion in the existing test**

`packages/legal-documents/test/tenant-agreement.test.ts:96` asserts that the
English build throws. Replace it:

```ts
it("builds an English tree of the same shape", () => {
  const en = buildTenantAgreement({ customer: ORG_CUSTOMER }, "en");
  expect(en.locale).toBe("en");
  expect(en.sections).toHaveLength(
    buildTenantAgreement({ customer: ORG_CUSTOMER }, "ru").sections.length,
  );
});
```

- [ ] **Step 7: Run the tests**

Run: `pnpm --filter @markiro/legal-documents exec vitest run`
Expected: PASS, including the six new bilingual cases and the unchanged published-artifact cases.

- [ ] **Step 8: Typecheck, lint, build, commit**

```bash
pnpm --filter @markiro/legal-documents typecheck lint build
git add packages/legal-documents/src packages/legal-documents/test
git commit -m "feat(legal-documents): pair the agreement's locale trees structurally"
```

---

### Task 3: Governing-language and Russian-forms clauses

Both clauses change the Russian template, so they land before translation
rather than after: translating text that is about to change wastes the work
and risks the two columns drifting.

**Files:**

- Modify: `packages/legal-documents/src/documents/tenant-agreement-ru.ts`
- Test: `packages/legal-documents/test/tenant-agreement.test.ts`

**Interfaces:**

- Consumes: `buildRuAgreementSections` (Task 1).
- Produces: nothing new. Section `dokumenty` gains two `paragraph` blocks.

- [ ] **Step 1: Write the failing test**

```ts
it("states that the Russian text prevails and that the forms are Russian", () => {
  const text = sectionText(buildTenantAgreement({ customer: ORG_CUSTOMER }, "ru"), "dokumenty");
  expect(text).toContain("преимущественную силу имеет русский текст");
  expect(text).toContain("Приложений № 5–8 приводятся на русском языке");
});
```

Add the helper beside the existing ones in the file:

```ts
function sectionText(content: LegalDocumentLocaleContent, id: string): string {
  const section = content.sections.find((candidate) => candidate.id === id);
  if (!section) throw new Error(`No section ${id}`);
  return JSON.stringify(section.blocks);
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @markiro/legal-documents exec vitest run test/tenant-agreement.test.ts`
Expected: FAIL — neither string is present.

- [ ] **Step 3: Add the clauses**

In `tenant-agreement-ru.ts`, in the section whose `id` is `dokumenty`, append
two blocks to its `blocks` array:

```ts
{
  kind: "paragraph",
  text: "Договор может быть оформлен в двуязычной форме, в которой русский и английский тексты расположены параллельно. Английский текст приводится для удобства Сторон; при любом расхождении между русским и английским текстами преимущественную силу имеет русский текст.",
},
{
  kind: "paragraph",
  text: "Формы документов, приведённые в Приложениях № 5–8, являются первичными учётными документами и приводятся на русском языке независимо от формы оформления Договора.",
},
```

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @markiro/legal-documents exec vitest run`
Expected: PASS. The bilingual structural tests still pass because the English
tree currently clones the Russian one.

- [ ] **Step 5: Typecheck, lint, build, commit**

```bash
pnpm --filter @markiro/legal-documents typecheck lint build
git add packages/legal-documents
git commit -m "feat(legal-documents): add the governing-language and Russian-forms clauses"
```

---

### Task 4: Width-aware table rendering

`legalTableColumnWidths` and `renderTable` compute from the module constant
`CONTENT_WIDTH`. In a bilingual document a table sits inside a half-width
cell, so it would overflow. This task threads an available width through and
changes nothing for existing callers — it is separated from Task 5 because it
touches the render path of every published artifact, and a reviewer should be
able to judge the byte-identity risk on its own.

**Files:**

- Modify: `packages/legal-documents/src/artifacts/docx.ts:593-700`
- Test: `packages/legal-documents/test/docx.test.ts` (add cases)

**Interfaces:**

- Produces: `legalTableColumnWidths(columnCount, ratios, contentWidth?)` — third parameter defaults to the A4 text column; `renderBlock(block, locale, keepNext?, contentWidth?)`; `renderTable(block, keepNext?, contentWidth?)`.

- [ ] **Step 1: Write the failing test**

```ts
import { legalTableColumnWidths } from "../src/artifacts/docx.js";

describe("legalTableColumnWidths", () => {
  it("defaults to the full text column", () => {
    expect(legalTableColumnWidths(2, undefined).reduce((a, b) => a + b, 0)).toBe(9638);
  });

  it("fills exactly the width it is given", () => {
    expect(legalTableColumnWidths(3, undefined, 4700).reduce((a, b) => a + b, 0)).toBe(4700);
  });

  it("honours ratios inside a narrower width", () => {
    expect(legalTableColumnWidths(2, [3, 1], 4000)).toEqual([3000, 1000]);
  });
});
```

`9638` is `PAGE_WIDTH - PAGE_MARGIN * 2` = `11906 - 2268`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @markiro/legal-documents exec vitest run test/docx.test.ts`
Expected: FAIL — `legalTableColumnWidths` takes two parameters, so the third
is ignored and the totals are 9638.

- [ ] **Step 3: Thread the width**

```ts
export function legalTableColumnWidths(
  columnCount: number,
  ratios: readonly number[] | undefined,
  contentWidth: number = CONTENT_WIDTH,
): readonly number[] {
  if (columnCount < 1) throw new Error("Legal table needs at least one column");
  if (!Number.isFinite(contentWidth) || contentWidth <= 0) {
    throw new Error("Legal table content width must be a positive number");
  }
  // ... unchanged validation of `effective` ...
  const widths: number[] = [];
  let assigned = 0;
  for (let index = 0; index < columnCount - 1; index += 1) {
    // Non-null: the loop stays inside `effective`, which has `columnCount` entries.
    const width = Math.round((contentWidth * (effective[index] as number)) / total);
    widths.push(width);
    assigned += width;
  }
  // The last column absorbs the rounding so the row always spans the text column.
  widths.push(contentWidth - assigned);
  return widths;
}
```

Give `renderTable` and `renderBlock` the same optional parameter and pass it
down; inside `renderTable` replace the two `CONTENT_WIDTH` uses (the
`legalTableColumnWidths` call and `width: { size: CONTENT_WIDTH, ... }`) with
`contentWidth`:

```ts
function renderBlock(
  block: LegalBlock,
  locale: LegalLocale,
  keepNext = false,
  contentWidth: number = CONTENT_WIDTH,
): readonly FileChild[] {
```

```ts
function renderTable(
  block: Extract<LegalBlock, { kind: "table" }>,
  keepNext = false,
  contentWidth: number = CONTENT_WIDTH,
): readonly FileChild[] {
  const widths = legalTableColumnWidths(block.columns.length, block.columnRatios, contentWidth);
```

- [ ] **Step 4: Run the full package suite**

Run: `pnpm --filter @markiro/legal-documents exec vitest run`
Expected: PASS. The published-artifact byte-identity cases are the proof that
defaulting preserved existing output exactly.

- [ ] **Step 5: Typecheck, lint, build, commit**

```bash
pnpm --filter @markiro/legal-documents typecheck lint build
git add packages/legal-documents
git commit -m "refactor(legal-documents): let legal tables render into a given width"
```

---

### Task 5: The two-column DOCX renderer

**Files:**

- Modify: `packages/legal-documents/src/artifacts/docx.ts`
- Modify: `packages/legal-documents/src/index.ts`
- Test: `packages/legal-documents/test/docx-bilingual.test.ts`

**Interfaces:**

- Consumes: `BilingualContent` (Task 2); width-aware `renderBlock` (Task 4).
- Produces: `renderLegalDocxBilingual(input: LegalDocxBilingual, assets?: LegalDocxAssets): Promise<Uint8Array>` where `LegalDocxBilingual` is `Omit<LegalDocxDraft, "content"> & { readonly content: BilingualContent }`. Task 7 calls it.

- [ ] **Step 1: Write the failing test**

```ts
// packages/legal-documents/test/docx-bilingual.test.ts
import { unzipSync } from "fflate";
import { describe, expect, it } from "vitest";

import { renderLegalDocxBilingual } from "../src/artifacts/docx.js";
import {
  AGREEMENT_MONOLINGUAL_SECTION_IDS,
  pairLocaleContent,
} from "../src/documents/tenant-agreement-bilingual.js";
import { buildTenantAgreement } from "../src/documents/tenant-agreement.js";
// ORG_CUSTOMER as in Task 2.

async function renderXml(): Promise<string> {
  const content = pairLocaleContent(
    buildTenantAgreement({ number: "MKR-2026-0001", customer: ORG_CUSTOMER }, "ru"),
    buildTenantAgreement({ number: "MKR-2026-0001", customer: ORG_CUSTOMER }, "en"),
    AGREEMENT_MONOLINGUAL_SECTION_IDS,
  );
  const bytes = await renderLegalDocxBilingual({
    code: "MKR-AGR-01",
    revision: "2026.09/01",
    effectiveDate: "2026-09-11",
    locale: "ru",
    verificationUrl: "https://markiro.app/verify",
    classLabel: "ПРОЕКТ ДОГОВОРА",
    operatorProfileId: "operator-2026-08-15",
    content,
  });
  const entry = unzipSync(bytes)["word/document.xml"];
  if (!entry) throw new Error("no document.xml");
  return new TextDecoder().decode(entry);
}

describe("renderLegalDocxBilingual", () => {
  it("emits one table per section", async () => {
    const xml = await renderXml();
    const tables = xml.match(/<w:tbl>/g)?.length ?? 0;
    // 44 section tables plus the metadata table on the first page.
    expect(tables).toBeGreaterThanOrEqual(45);
  });

  it("carries the agreement number in both columns", async () => {
    const xml = await renderXml();
    expect(xml.split("MKR-2026-0001").length - 1).toBeGreaterThanOrEqual(2);
  });

  it("renders a Russian accounting form once, not twice", async () => {
    const xml = await renderXml();
    expect(xml.split("Форма счёта на оплату").length - 1).toBe(1);
  });

  it("renders a bilingual heading on both sides", async () => {
    const xml = await renderXml();
    expect(xml).toContain("Приложение № 9");
    expect(xml).toContain("Appendix No. 9");
  });
});
```

The last case passes only once Task 12 translates appendix 9. Mark it
`it.skip` in this task with the comment `// Unskipped by Task 12.` and
unskip it there.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @markiro/legal-documents exec vitest run test/docx-bilingual.test.ts`
Expected: FAIL — `renderLegalDocxBilingual` is not exported.

- [ ] **Step 3: Implement the renderer**

The two renderers differ only in their `children`, so extract everything else
rather than copying it. First refactor `renderLegalDocxDraft`: move the whole
`new Document({...})` construction into a helper that takes the body children,
and have the existing function call it. That refactor must leave output
byte-identical — the published-artifact cases prove it.

```ts
function legalDocxDocument(
  input: LegalDocxMeta & {
    readonly classLabel: string;
    readonly operatorProfileId: LegalOperatorProfileId;
  },
  title: string,
  summary: string,
  children: readonly FileChild[],
): Document {
  // The body of the current `new Document({...})` in renderLegalDocxDraft,
  // with `source.title` → `title`, `source.summary` → `summary` and the
  // section flatMap replaced by `...children`.
}
```

`renderLegalDocxDraft` then becomes the same function it is today with its
`children` array passed in, and the bilingual renderer is:

```ts
const BILINGUAL_GUTTER = 240;
const BILINGUAL_COLUMN_WIDTH = Math.floor((CONTENT_WIDTH - BILINGUAL_GUTTER) / 2);

export interface LegalDocxBilingual extends Omit<LegalDocxDraft, "content"> {
  readonly content: BilingualContent;
}

export async function renderLegalDocxBilingual(
  input: LegalDocxBilingual,
  assets: LegalDocxAssets = {},
): Promise<Uint8Array> {
  const operator = OPERATOR_PROFILES[input.operatorProfileId];
  const document = legalDocxDocument(input, input.content.title.ru, input.content.summary.ru, [
    new Paragraph({
      heading: HeadingLevel.TITLE,
      children: [new TextRun(input.content.title.ru)],
      spacing: { before: 220, after: 60 },
    }),
    new Paragraph({
      heading: HeadingLevel.TITLE,
      children: [new TextRun(input.content.title.en)],
      spacing: { before: 0, after: 140 },
    }),
    new Paragraph({
      style: "DocumentSummary",
      children: [new TextRun(input.content.summary.ru)],
      spacing: { after: 60 },
    }),
    new Paragraph({
      style: "DocumentSummary",
      children: [new TextRun(input.content.summary.en)],
      spacing: { after: 220 },
    }),
    createMetadataTable(input, operator),
    ...input.content.sections.flatMap((section, index) =>
      renderBilingualSection(section, index, input.locale, assets),
    ),
  ]);

  return normalizeDocx(await Packer.toBuffer(document), input.effectiveDate);
}
```

```ts
function renderBilingualSection(
  section: BilingualSection,
  index: number,
  locale: LegalLocale,
  assets: LegalDocxAssets,
): readonly FileChild[] {
  for (const block of section.ru.blocks) {
    if (block.kind === "step") {
      // An instruction screenshot has no meaning in an 8 cm contract column,
      // and silently overflowing is worse than refusing.
      throw new Error(`Bilingual rendering does not support step blocks (${section.id})`);
    }
  }

  const pageBreakBefore = index > 0 && section.startsPage === true;
  const width = section.bilingual ? BILINGUAL_COLUMN_WIDTH : CONTENT_WIDTH;

  const columnChildren = (heading: string, blocks: readonly LegalBlock[]): readonly FileChild[] => [
    new Paragraph({
      heading: HeadingLevel.HEADING_1,
      children: [new TextRun(heading)],
    }),
    ...blocks.flatMap((block, blockIndex) =>
      renderBlock(block, locale, blocks[blockIndex + 1]?.kind === "table", width),
    ),
  ];

  const cell = (children: readonly FileChild[], size: number): TableCell =>
    new TableCell({
      verticalAlign: VerticalAlign.TOP,
      width: { size, type: WidthType.DXA },
      margins: { top: 0, bottom: 0, left: 0, right: 0 },
      children: [...children],
    });

  const columns = section.bilingual
    ? [
        cell(columnChildren(section.ru.heading, section.ru.blocks), BILINGUAL_COLUMN_WIDTH),
        cell([], BILINGUAL_GUTTER),
        cell(columnChildren(section.en.heading, section.en.blocks), BILINGUAL_COLUMN_WIDTH),
      ]
    : [cell(columnChildren(section.ru.heading, section.ru.blocks), CONTENT_WIDTH)];

  return [
    ...(pageBreakBefore
      ? [new Paragraph({ pageBreakBefore: true, spacing: { before: 0, after: 0 }, children: [] })]
      : []),
    new Table({
      width: { size: CONTENT_WIDTH, type: WidthType.DXA },
      columnWidths: section.bilingual
        ? [BILINGUAL_COLUMN_WIDTH, BILINGUAL_GUTTER, BILINGUAL_COLUMN_WIDTH]
        : [CONTENT_WIDTH],
      layout: TableLayoutType.FIXED,
      borders: {
        top: NO_BORDER,
        bottom: NO_BORDER,
        left: NO_BORDER,
        right: NO_BORDER,
        insideHorizontal: NO_BORDER,
        insideVertical: NO_BORDER,
      },
      rows: [new TableRow({ children: [...columns] })],
    }),
    // Word merges tables that touch, so consecutive sections need a spacer.
    new Paragraph({ spacing: { before: 0, after: 120 }, children: [] }),
  ];
}
```

Note the page break moved out of the heading paragraph: the heading now lives
inside a table cell, and `pageBreakBefore` on a paragraph inside a cell does
not break the page. An empty paragraph before the table does.

Export from `src/index.ts`:

```ts
export { renderLegalDocxBilingual } from "./artifacts/docx.js";
export type { LegalDocxBilingual } from "./artifacts/docx.js";
```

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @markiro/legal-documents exec vitest run`
Expected: PASS (one skipped case, unskipped by Task 12).

- [ ] **Step 5: Render a document and look at it**

```bash
pnpm --filter @markiro/legal-documents exec tsx src/cli/render-agreement-draft.ts
```

Open the produced DOCX. Confirm by eye: two columns, headings side by side,
appendix 5 spanning the page, no text clipped at a column edge, appendices
starting on their own pages. Record what you saw in the commit message — this
is the only check that catches a column that renders but reads badly.

- [ ] **Step 6: Typecheck, lint, build, commit**

```bash
pnpm --filter @markiro/legal-documents typecheck lint build
git add packages/legal-documents
git commit -m "feat(legal-documents): render the agreement in two columns"
```

---

### Task 6: The `document_form` column

**Files:**

- Modify: `packages/db/src/schema/agreements.ts`
- Create: `packages/db/migrations/NNNN_<generated>.sql`
- Test: `packages/db/test/` — the existing agreements schema test

**Interfaces:**

- Produces: `platformAgreementDocumentForm` pgEnum; `platformAgreements.documentForm` column, `notNull`, default `'ru'`.

- [ ] **Step 1: Write the failing test**

Add to the agreements schema test:

```ts
it("stores the document form and defaults it to Russian", async () => {
  const [row] = await db
    .insert(platformAgreements)
    .values({ ...baseAgreement(), number: "MKR-FORM-1" })
    .returning();
  expect(row?.documentForm).toBe("ru");

  const [bilingual] = await db
    .insert(platformAgreements)
    .values({ ...baseAgreement(), number: "MKR-FORM-2", documentForm: "ru_en" })
    .returning();
  expect(bilingual?.documentForm).toBe("ru_en");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `set -a; source .env; set +a; pnpm --filter @markiro/db exec vitest run test/agreements.test.ts`
Expected: FAIL — `documentForm` is not a property of the insert type.

- [ ] **Step 3: Add the column**

```ts
export const platformAgreementDocumentForm = pgEnum("platform_agreement_document_form", [
  "ru",
  "ru_en",
]);
```

Inside `platformAgreements`, after `city`:

```ts
// Russian-only or the two-column Russian/English form. A property of the
// record rather than a download option: the stored document is the copy
// that gets signed, and two files under one number cannot be told apart
// later.
documentForm: platformAgreementDocumentForm("document_form").notNull().default("ru"),
```

- [ ] **Step 4: Generate and inspect the migration**

```bash
set -a; source .env; set +a
pnpm --filter @markiro/db db:generate
```

Read the generated SQL. It must create the enum type and add one column with
`NOT NULL DEFAULT 'ru'` — nothing else. If it contains unrelated statements,
the shared development database has drifted; see `AGENTS.md` on inspecting the
migration journal rather than editing application code.

- [ ] **Step 5: Apply, test, build**

```bash
set -a; source .env; set +a
pnpm --filter @markiro/db db:migrate
pnpm --filter @markiro/db exec vitest run
pnpm --filter @markiro/db build
```

Expected: PASS. If `offer-variant-online-migration.test.ts` fails with a
count mismatch, this migration added indexes it counts — but this one adds
none, so a failure there means something else changed.

- [ ] **Step 6: Typecheck, lint, commit**

```bash
pnpm --filter @markiro/db typecheck lint
git add packages/db/src/schema/agreements.ts packages/db/migrations packages/db/test
git commit -m "feat(db): record the agreement's document form"
```

---

### Task 7: Contract and API render path

**Files:**

- Modify: `packages/platform-contracts/src/agreements.ts`
- Modify: `apps/api/src/modules/platform-agreements/platform-agreements.service.ts`
- Modify: `apps/api/src/modules/platform-agreements/agreement-documents.service.ts`
- Test: `packages/platform-contracts/test/agreements.test.ts`, `apps/api/test/platform-agreements.e2e.test.ts`

**Interfaces:**

- Consumes: `pairLocaleContent`, `AGREEMENT_MONOLINGUAL_SECTION_IDS`, `renderLegalDocxBilingual` (Tasks 2, 5); `platformAgreements.documentForm` (Task 6).
- Produces: `agreementDocumentFormSchema = z.enum(["ru", "ru_en"])`; `documentForm` on `agreementSummarySchema`, `agreementDetailSchema`, `createBody` (optional, defaults to `ru`) and `updateBody` (optional).

- [ ] **Step 1: Write the failing contract test**

```ts
it("accepts both document forms and rejects anything else", () => {
  expect(
    platformAgreementContracts.create.body.parse({
      counterparty: LEGAL_ENTITY,
      documentForm: "ru_en",
    }).documentForm,
  ).toBe("ru_en");
  expect(() =>
    platformAgreementContracts.create.body.parse({
      counterparty: LEGAL_ENTITY,
      documentForm: "en",
    }),
  ).toThrow();
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @markiro/platform-contracts exec vitest run test/agreements.test.ts`
Expected: FAIL — the schema is `.strict()`, so `documentForm` is rejected as
an unknown key.

- [ ] **Step 3: Add the field**

```ts
export const agreementDocumentFormSchema = z.enum(["ru", "ru_en"]);
export type AgreementDocumentForm = z.infer<typeof agreementDocumentFormSchema>;
```

Add `documentForm: agreementDocumentFormSchema` to `agreementSummarySchema`
(and therefore to the detail schema, which extends it),
`documentForm: agreementDocumentFormSchema.optional()` to `createBody` and
to `updateBody`.

- [ ] **Step 4: Run the contract tests, then build**

```bash
pnpm --filter @markiro/platform-contracts exec vitest run
pnpm --filter @markiro/platform-contracts build
```

- [ ] **Step 5: Write the failing API test**

```ts
it("renders the bilingual form when the record asks for it", async () => {
  const created = await createAgreement(app, token, {
    counterparty: LEGAL_ENTITY,
    documentForm: "ru_en",
  });
  const response = await request(app.getHttpServer())
    .post(`/platform/agreements/${created.id}/documents/draft`)
    .set("Authorization", `Bearer ${token}`)
    .expect(201);
  const document = response.body.agreement.documents.at(-1);
  expect(document.filename).toContain("_ru-en");
});

it("keeps the Russian filename for a Russian-form agreement", async () => {
  const created = await createAgreement(app, token, { counterparty: LEGAL_ENTITY });
  const response = await request(app.getHttpServer())
    .post(`/platform/agreements/${created.id}/documents/draft`)
    .set("Authorization", `Bearer ${token}`)
    .expect(201);
  expect(response.body.agreement.documents.at(-1).filename).not.toContain("_ru-en");
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `set -a; source .env; set +a; pnpm --filter @markiro/api exec vitest run test/platform-agreements.e2e.test.ts`
Expected: FAIL — the filename has no suffix.

- [ ] **Step 7: Wire the service**

In `platform-agreements.service.ts`, persist `documentForm` on create and on
update, guarded by the existing `isAgreementEditable` check that already
guards the other fields — no new rule.

In `agreement-documents.service.ts`:

```ts
export const AGREEMENT_RENDERER_VERSION = "agreement-docx-v2";
```

```ts
private async render(agreement: AgreementRow, classLabel: string): Promise<Buffer> {
  const fields = toAgreementFields({
    number: agreement.number,
    conclusionDate: agreement.conclusionDate,
    city: agreement.city,
    counterparty: parseRequisites(agreement.counterparty, "counterparty"),
    contractor: parseRequisites(agreement.contractor, "contractor"),
    signatory: parseSignatory(agreement.terms),
    terms: parseTerms(agreement.terms),
  });
  const meta = {
    code: AGREEMENT_CODE,
    revision: AGREEMENT_REVISION,
    effectiveDate: AGREEMENT_EFFECTIVE_DATE,
    locale: "ru" as const,
    verificationUrl: REGISTRY_URL,
    classLabel,
    operatorProfileId: "operator-2026-08-15" as const,
  };

  if (agreement.documentForm === "ru_en") {
    const bytes = await renderLegalDocxBilingual({
      ...meta,
      content: pairLocaleContent(
        buildTenantAgreement(fields, "ru"),
        buildTenantAgreement(fields, "en"),
        AGREEMENT_MONOLINGUAL_SECTION_IDS,
      ),
    });
    return Buffer.from(bytes);
  }

  const bytes = await renderLegalDocxDraft({ ...meta, content: buildTenantAgreement(fields, "ru") });
  return Buffer.from(bytes);
}
```

Filenames — a suffix in both places that build one:

```ts
private formSuffix(agreement: AgreementRow): string {
  return agreement.documentForm === "ru_en" ? "_ru-en" : "";
}
```

`renderDraft`: `` `${agreement.number}-проект${this.formSuffix(agreement)}.docx` ``
`recordSignedDocument`: `` `${agreement.number}${this.formSuffix(agreement)}.docx` ``

The object key does not change: `agreements/<id>/draft.docx` is per agreement
and regeneration replaces it, which is exactly the "one agreement, one
generated original" invariant.

- [ ] **Step 8: Run the API tests**

```bash
set -a; source .env; set +a
pnpm turbo run build --filter='@markiro/api^...'
pnpm --filter @markiro/api exec vitest run test/platform-agreements.e2e.test.ts
pnpm --filter @markiro/api exec vitest run test/platform-contract-openapi.test.ts
```

Expected: PASS. `platform-contract-openapi.test.ts` pins
`CURRENT_SHARED_SCHEMAS`; adding an enum schema raises it, so update the
number to whatever the test reports rather than guessing.

- [ ] **Step 9: Run the whole API suite**

Run: `set -a; source .env; set +a; pnpm --filter @markiro/api exec vitest run`
Expected: PASS. Running the full suite here is not optional — in PR #501 the
route-inventory and OpenAPI tests were missed exactly because only the
focused file was run.

- [ ] **Step 10: Typecheck, lint, commit**

```bash
pnpm --filter @markiro/platform-contracts typecheck lint
pnpm --filter @markiro/api typecheck lint
git add packages/platform-contracts apps/api
git commit -m "feat(api): render the agreement in the form the record asks for"
```

---

### Task 8: saas-admin form selector

**Files:**

- Modify: `apps/saas-admin/src/pages/agreements/api.ts`
- Modify: `apps/saas-admin/src/pages/agreements/CreateAgreementPage.tsx`
- Modify: `apps/saas-admin/src/pages/agreements/AgreementDetailPage.tsx`
- Modify: `apps/saas-admin/src/pages/agreements/AgreementsPage.tsx`
- Test: `apps/saas-admin/test/agreements.test.tsx`

**Interfaces:**

- Consumes: `AgreementDocumentForm`, `agreementDocumentFormSchema` (Task 7).

- [ ] **Step 1: Write the failing test**

```tsx
it("sends the chosen document form when creating an agreement", async () => {
  const user = userEvent.setup();
  renderWithProviders(<CreateAgreementPage />, { me: PLATFORM_ADMIN_ME });
  await user.selectOptions(await screen.findByLabelText(/форма документа/i), "ru_en");
  await user.click(screen.getByRole("button", { name: /создать/i }));
  await waitFor(() => expect(lastCreateBody()).toMatchObject({ documentForm: "ru_en" }));
});

it("disables the form selector once the agreement is no longer editable", async () => {
  renderWithProviders(<AgreementDetailPage />, {
    me: PLATFORM_ADMIN_ME,
    agreement: { ...SIGNED_AGREEMENT, editable: false },
  });
  expect(await screen.findByLabelText(/форма документа/i)).toBeDisabled();
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @markiro/saas-admin exec vitest run test/agreements.test.tsx`
Expected: FAIL — no control matches `форма документа`.

- [ ] **Step 3: Add the control**

In both forms, a `Select` from `@markiro/ui` with two options. In the detail
page it takes `disabled` from the same `editable` flag that already disables
the other fields — the spec has no separate rule for the form.

```tsx
<Select
  label={t("agreements.documentForm.label")}
  value={documentForm}
  disabled={!agreement.editable}
  onChange={(event) => setDocumentForm(event.target.value as AgreementDocumentForm)}
>
  <option value="ru">{t("agreements.documentForm.ru")}</option>
  <option value="ru_en">{t("agreements.documentForm.ruEn")}</option>
</Select>
```

Dictionary entries, placed beside the other `agreements.*` keys rather than in
a new namespace:

```json
"documentForm": {
  "label": "Форма документа",
  "ru": "Русская",
  "ruEn": "Двуязычная (рус/англ)",
  "badgeRu": "RU",
  "badgeRuEn": "RU + EN"
}
```

In the registry row and the detail header show the badge, not the sentence —
the column is narrow:

```tsx
<Badge tone="neutral">
  {t(
    agreement.documentForm === "ru_en"
      ? "agreements.documentForm.badgeRuEn"
      : "agreements.documentForm.badgeRu",
  )}
</Badge>
```

Check the actual component and prop names in
`apps/saas-admin/src/pages/agreements/AgreementRequisitesForm.tsx` before
writing this — reuse whatever `Select` and `Badge` that file already uses
rather than importing a different one.

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @markiro/saas-admin exec vitest run`
Expected: PASS. Do not touch `apps/saas-admin/test/render.tsx`: this slice
adds no capability, and its fixtures derive capabilities from
`platformCapabilitiesForRole` for a reason.

- [ ] **Step 5: Typecheck, lint, build, commit**

```bash
pnpm --filter @markiro/saas-admin typecheck lint build
git add apps/saas-admin
git commit -m "feat(saas-admin): choose the agreement's document form"
```

---

### Tasks 9–12: Translation

Four tasks of the same shape. Each replaces Russian strings in
`tenant-agreement-en.ts` with English ones for a group of sections, keeping
the structure identical — same section ids in the same order, same block
kinds, same list lengths, same table shapes. The structural test from Task 2
guards that on every commit.

**Method for each task:**

1. Copy the group's sections from `tenant-agreement-ru.ts` into
   `tenant-agreement-en.ts`, replacing the clone's delegation for those
   sections only. The function keeps delegating to
   `buildRuAgreementSections` for everything not yet translated:

   ```ts
   export function buildEnAgreementSections(
     fields: TenantAgreementFields,
   ): readonly AgreementSection[] {
     const translated = new Map<string, AgreementSection>([
       ...bodySections(fields).map((section) => [section.id, section] as const),
     ]);
     return buildRuAgreementSections(fields).map(
       (section) => translated.get(section.id) ?? section,
     );
   }
   ```

   This keeps order and count correct by construction: the English tree is
   always the Russian tree with some sections substituted.

2. Translate using the glossary in Global Constraints. Do not improve, shorten
   or reorganise the Russian text while translating — a bilingual document
   whose columns say different things is worse than one that reads stiffly.
3. Keep every square-bracket placeholder in the English text, with the bracket
   contents translated: `[номер]` becomes `[number]`, `[город]` becomes
   `[city]`. The fill helpers are shared, so a filled agreement substitutes in
   both columns from the same value.
4. Add the task's acceptance test, run the suite, commit.

**Files (all four tasks):**

- Modify: `packages/legal-documents/src/documents/tenant-agreement-en.ts`
- Test: `packages/legal-documents/test/tenant-agreement-bilingual.test.ts`

---

### Task 9: Translate the preamble and body sections 1–12

Section ids: `storony`, `predmet`, `obekt-litsenzii`, `zakaz`, `tsena`,
`uslugi`, `priemka`, `ekspluatatsiya`, `dannye`, `otvetstvennost`, `srok`,
`dokumenty`, `rekvizity`.

- [ ] **Step 1: Write the failing test**

```ts
it("translates the body", () => {
  const en = buildTenantAgreement(FILLED, "en");
  const byId = new Map(en.sections.map((section) => [section.id, section]));
  expect(byId.get("predmet")?.heading).toBe("1. Subject matter and structure of the agreement");
  expect(byId.get("tsena")?.heading).toBe("4. Price, settlements and tax status");
  expect(byId.get("rekvizity")?.heading).toBe("12. Requisites and signatures");
  expect(JSON.stringify(byId.get("dokumenty")?.blocks)).toContain("the Russian text shall prevail");
  // The preamble carries the agreement number in both columns.
  expect(byId.get("storony")?.heading).toContain("MKR-2026-0001");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @markiro/legal-documents exec vitest run test/tenant-agreement-bilingual.test.ts`
Expected: FAIL — the headings are still Russian.

- [ ] **Step 3: Translate the thirteen sections** following the method above.

- [ ] **Step 4: Run the suite**

Run: `pnpm --filter @markiro/legal-documents exec vitest run`
Expected: PASS, structural cases included.

- [ ] **Step 5: Typecheck, lint, build, commit**

```bash
pnpm --filter @markiro/legal-documents typecheck lint build
git add packages/legal-documents
git commit -m "feat(legal-documents): translate the agreement body"
```

---

### Task 10: Translate appendices 1 and 2

Section ids: `prilozhenie-1`, `prilozhenie-1-kvoty`,
`prilozhenie-1-voznagrazhdenie`, `prilozhenie-1-podgotovka`,
`prilozhenie-1-izmeneniya`, `prilozhenie-2`, `prilozhenie-2-podderzhka`,
`prilozhenie-2-sreda`, `prilozhenie-2-okonchanie`, `prilozhenie-2-vygruzka`.

- [ ] **Step 1: Write the failing test**

```ts
it("translates appendices 1 and 2", () => {
  const byId = new Map(buildTenantAgreement(FILLED, "en").sections.map((s) => [s.id, s]));
  expect(byId.get("prilozhenie-1")?.heading).toBe(
    "Appendix No. 1. Order for the grant of rights and access",
  );
  expect(byId.get("prilozhenie-2")?.heading).toBe(
    "Appendix No. 2. Support and wind-down regulations",
  );
  // The order number stays a placeholder: it is filled when the order is placed.
  expect(JSON.stringify(byId.get("prilozhenie-1")?.blocks)).toContain("[number]");
});
```

- [ ] **Step 2: Run it to verify it fails.** Expected: FAIL — headings still Russian.
- [ ] **Step 3: Translate the ten sections.**
- [ ] **Step 4: Run the suite.** Expected: PASS.
- [ ] **Step 5: Typecheck, lint, build, commit**

```bash
pnpm --filter @markiro/legal-documents typecheck lint build
git add packages/legal-documents
git commit -m "feat(legal-documents): translate appendices 1 and 2"
```

---

### Task 11: Translate appendices 3 and 4

Section ids: `prilozhenie-3`, `prilozhenie-3-roli`,
`prilozhenie-3-obyazannosti`, `prilozhenie-3-intsidenty`,
`prilozhenie-3-obrashcheniya`, `prilozhenie-3-kontakty`, `prilozhenie-4`,
`prilozhenie-4-sostav`, `prilozhenie-4-abonement`, `prilozhenie-4-rezultaty`,
`prilozhenie-4-soglasovanie`.

Appendix 3 is the personal data processing instruction. Translate the legal
bases and the controller/processor roles literally — these track 152-ФЗ, not
GDPR, and substituting GDPR vocabulary would misdescribe the obligation.
"Оператор" in this appendix is the data controller, not the Markiro platform
operator; keep the two apart.

- [ ] **Step 1: Write the failing test**

```ts
it("translates appendices 3 and 4", () => {
  const byId = new Map(buildTenantAgreement(FILLED, "en").sections.map((s) => [s.id, s]));
  expect(byId.get("prilozhenie-3")?.heading).toBe(
    "Appendix No. 3. Personal data processing instruction",
  );
  expect(byId.get("prilozhenie-4")?.heading).toBe(
    "Appendix No. 4. Assignment for services / works",
  );
  expect(JSON.stringify(byId.get("prilozhenie-3-roli")?.blocks)).toContain("Federal Law");
});
```

- [ ] **Step 2: Run it to verify it fails.** Expected: FAIL — headings still Russian.
- [ ] **Step 3: Translate the eleven sections.**
- [ ] **Step 4: Run the suite.** Expected: PASS.
- [ ] **Step 5: Typecheck, lint, build, commit**

```bash
pnpm --filter @markiro/legal-documents typecheck lint build
git add packages/legal-documents
git commit -m "feat(legal-documents): translate appendices 3 and 4"
```

---

### Task 12: Translate appendices 9 and 10, and finish

Section ids: `prilozhenie-9`, `prilozhenie-9-litsa`, `prilozhenie-9-pep`,
`prilozhenie-9-dokazatelstva`, `prilozhenie-9-svedeniya`, `prilozhenie-10`.

Appendices 5–8 stay Russian and are never touched.

- [ ] **Step 1: Write the failing test and unskip the renderer case**

```ts
it("translates appendices 9 and 10 and leaves the forms Russian", () => {
  const byId = new Map(buildTenantAgreement(FILLED, "en").sections.map((s) => [s.id, s]));
  expect(byId.get("prilozhenie-9")?.heading).toBe(
    "Appendix No. 9. Contacts and electronic interaction",
  );
  expect(byId.get("prilozhenie-10")?.heading).toBe(
    "Appendix No. 10. Form of confirmation of data transfer and deletion",
  );
  for (const id of AGREEMENT_MONOLINGUAL_SECTION_IDS) {
    expect(byId.get(id)?.heading).toMatch(/^Приложение № /);
  }
});
```

In `test/docx-bilingual.test.ts`, remove `.skip` from
`renders a bilingual heading on both sides`.

- [ ] **Step 2: Run it to verify it fails.** Expected: FAIL on both files.
- [ ] **Step 3: Translate the six sections.**
- [ ] **Step 4: Run the full package suite.**

Run: `pnpm --filter @markiro/legal-documents exec vitest run`
Expected: PASS, no skipped cases.

- [ ] **Step 5: Render and read the finished document**

```bash
pnpm --filter @markiro/legal-documents exec tsx src/cli/render-agreement-draft.ts
```

Read both columns of at least the body and appendix 3 side by side. Check the
requisites table in section 12 at its 8 cm column width; if it is unreadable,
the spec's fallback is to add `rekvizity` to
`AGREEMENT_MONOLINGUAL_SECTION_IDS` and give the field labels bilingual
captions instead. Record the decision in the commit message.

- [ ] **Step 6: Typecheck, lint, build, commit**

```bash
pnpm --filter @markiro/legal-documents typecheck lint build
git add packages/legal-documents
git commit -m "feat(legal-documents): translate appendices 9 and 10"
```

---

## Final Verification

- [ ] **Full gates**

```bash
set -a; source .env; set +a
pnpm turbo lint typecheck test build --concurrency=1 --force
pnpm format:check
```

Report skips explicitly. A missing `DATABASE_URL` silently skips the
database-backed suites, which is how a schema regression reaches CI.

- [ ] **Live browser walkthrough**

Start the API and saas-admin from `.claude/launch.json`, sign in with a real
platform session and TOTP, then: create an agreement with `documentForm`
`ru_en`, fill the counterparty through DaData, generate the draft, download
it and open it. Confirm the stored DOCX has both columns and carries the
number, counterparty, TIN, KPP, city, date and signatory in both.

This step is not optional. In PR #501 the object-key allowlist rejected the
new namespace and only a live run caught it, because the unit tests stub
storage.

- [ ] **Check the diff against the target**

```bash
git fetch origin main
git diff --stat origin/main...HEAD
git diff --check
```

- [ ] **State the limits in the final report**

Automated checks and live browser checks reported separately. The English
legal text has not been reviewed by a lawyer; say so plainly, as the spec
requires.
