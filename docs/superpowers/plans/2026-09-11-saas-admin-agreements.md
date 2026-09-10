# SaaS-admin Agreements Registry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a platform-operator «Договоры» section that keeps a registry of client agreements, fills counterparty requisites from DaData, and renders the filled MKR-AGR-01 package (contract + 10 appendices) as DOCX.

**Architecture:** Five layers, mirroring the existing `offers` vertical exactly. `packages/legal-documents` turns its static contract text into `buildTenantAgreement(fields, locale)`. `packages/db` gains `platform_agreements` and `platform_agreement_documents`. `packages/platform-contracts` gains `platformAgreementContracts` plus two new capabilities. `apps/api` gains a `platform-agreements` module that renders DOCX at runtime and stores objects through `ObjectStorageService`. `apps/saas-admin` gains a `pages/agreements` section that reuses the existing DaData suggest fields.

**Tech Stack:** TypeScript (strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), Zod, Drizzle + Postgres, NestJS, React + Vite, `docx@9.7.1`, Vitest.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-09-11-saas-admin-agreements-design.md`. Every requirement there applies.
- The domain is named **agreement** in code, «Договоры» in UI copy. Never `contract` — `packages/platform-contracts` already owns that word.
- Statuses: `draft`, `in_review`, `sent`, `signed`, `terminated`. Free movement among the first three; `signed` → `terminated` only; nothing returns from `signed`.
- Fields are editable only while status is `draft`, `in_review` or `sent`.
- Byte-identity of the already published artifacts `markiro_mkr-dpa-01_2026.08-01_{ru,en}.docx` and `markiro_mkr-brd-01_2026.08-01_{ru,en}.docx` under `apps/landing/public/legal/files/` must never change. Task 1 pins this with a test.
- MKR-AGR-01 is **not** registered in `LEGAL_RELEASES`, has no landing route and no attestation entry. `verificationUrl` is always `https://markiro.app/legal/`.
- Attachment allowlist: `application/pdf`, `application/vnd.openxmlformats-officedocument.wordprocessingml.document`, `image/png`, `image/jpeg`. Size cap 20 MB.
- Presigned reads expire in at most 300 seconds — `ObjectStorageService.presignRead` throws above that.
- Run package commands with `CI=true` prefix in this repo; `pnpm` aborts otherwise when it wants to purge `node_modules`.
- Build dependencies before consumer tests: `CI=true pnpm turbo run build --filter='<pkg>^...'`.

## Deviation from the spec, decided while planning

The spec said draft renders are "streamed, not stored". There is no binary
streaming endpoint anywhere on the platform surface: `platform-reports`
and `platform-offers` both return JSON containing a presigned URL
(`apps/api/src/platform-reports/platform-reports.controller.ts:72`,
`apps/api/src/modules/platform-offers/offer-documents.service.ts:109`).
Inventing a first binary endpoint for this feature would fork the
convention.

Instead: a draft render writes to **one stable object key per agreement**
(`agreements/<id>/draft.docx`) and overwrites it on every render, backed
by a single `platform_agreement_documents` row with `kind = 'draft'`.
The bucket therefore holds at most one preview object per agreement — the
outcome the spec wanted — while download stays on the presigned-URL
convention. Signing writes a separate, immutable `kind = 'generated'`
object under a content-addressed key.

## File Structure

**`packages/legal-documents`**
- Modify `src/documents/tenant-agreement.ts` — export `buildTenantAgreement` instead of a frozen constant; owns the RU text and its fill points.
- Create `src/documents/tenant-agreement-fields.ts` — `TenantAgreementFields`, `PartyRequisites`, the `field()` helper. Kept separate so the API can import the types without pulling the 1,500-line text module into its type graph.
- Modify `src/index.ts` — re-export both.
- Modify `src/cli/render-agreement-draft.ts` — call `buildTenantAgreement({}, "ru")`.
- Modify `package.json` — `docx` moves to `dependencies`.
- Create `test/tenant-agreement.test.ts`.
- Modify `test/docx.test.ts` — add the published-bytes guard.

**`packages/db`**
- Create `src/schema/agreements.ts` — enum + two tables.
- Modify `src/schema/index.ts` — re-export.
- Create `migrations/0127_platform_agreements.sql` (number confirmed at generation time).
- Create `test/agreements-schema.test.ts`.

**`packages/platform-contracts`**
- Modify `src/platform-auth.ts` — two capabilities + role map.
- Create `src/agreements.ts` — requisites and endpoint schemas.
- Modify `src/index.ts` — re-export.
- Create `test/agreements.test.ts`.

**`apps/api/src/modules/platform-agreements/`**
- `platform-agreements.module.ts`, `platform-agreements.controller.ts`, `platform-agreements.service.ts` — CRUD, numbering, transitions, tenant linking.
- `agreement-documents.service.ts` — render, store, presign, attachments. Split from the CRUD service because it is the only part that touches `ObjectStorageService` and `docx`.
- `agreement-fields.ts` — maps a DB row to `TenantAgreementFields`. Pure, so it is unit-testable without a database.
- `dto.ts`.
- Tests under `apps/api/test/`.

**`apps/saas-admin/src/pages/agreements/`**
- `api.ts`, `AgreementsPage.tsx`, `CreateAgreementPage.tsx`, `AgreementDetailPage.tsx`, `AgreementRequisitesForm.tsx` (shared by create and detail), `AgreementDocumentsPanel.tsx`.
- Modify `src/app.tsx`, `src/layout/AppShell.tsx`, `src/i18n/ru.json`, `src/i18n/en.json`.

---

### Task 1: Template becomes a function of data

**Files:**
- Create: `packages/legal-documents/src/documents/tenant-agreement-fields.ts`
- Modify: `packages/legal-documents/src/documents/tenant-agreement.ts`
- Modify: `packages/legal-documents/src/index.ts`
- Modify: `packages/legal-documents/src/cli/render-agreement-draft.ts`
- Modify: `packages/legal-documents/package.json`
- Test: `packages/legal-documents/test/tenant-agreement.test.ts`
- Test: `packages/legal-documents/test/docx.test.ts`

**Interfaces:**
- Consumes: `LegalDocumentLocaleContent`, `LegalLocale`, `LegalBlock` from `../types.js`; `renderLegalDocxDraft` from `../artifacts/docx.js`.
- Produces: `buildTenantAgreement(fields: TenantAgreementFields, locale: LegalLocale): LegalDocumentLocaleContent`; types `TenantAgreementFields`, `PartyRequisites`, `PartyKind`; helper `agreementField(value, placeholder)`. Tasks 5 and 7 import all of these.

- [ ] **Step 1: Write the failing test**

Create `packages/legal-documents/test/tenant-agreement.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { buildTenantAgreement } from "../src/documents/tenant-agreement.js";
import type { TenantAgreementFields } from "../src/documents/tenant-agreement-fields.js";

const ORG_CUSTOMER: TenantAgreementFields["customer"] = {
  kind: "legal_entity",
  name: "ООО «Пример»",
  inn: "7701234567",
  kpp: "770101001",
  ogrn: "1027700000000",
  address: "101000, Москва, ул. Примерная, д. 1",
  email: "buh@example.ru",
  phone: "+7 495 000-00-00",
  bankName: "АО «Банк»",
  bic: "044525000",
  settlementAccount: "40702810000000000001",
  correspondentAccount: "30101810000000000002",
  taxRegime: null,
};

const IP_CUSTOMER: TenantAgreementFields["customer"] = {
  ...ORG_CUSTOMER,
  kind: "sole_proprietor",
  name: "ИП Иванов Иван Иванович",
  inn: "770123456789",
  kpp: null,
  ogrn: "312770000000001",
};

const flatten = (fields: TenantAgreementFields): string =>
  buildTenantAgreement(fields, "ru")
    .sections.flatMap(({ heading, blocks }) => [
      heading,
      ...blocks.flatMap((block) => {
        if (block.kind === "paragraph" || block.kind === "callout") return [block.text];
        if (block.kind === "table") return [...block.columns, ...block.rows.flat()];
        if (block.kind === "definition-list")
          return block.items.map(({ term, detail }) => `${term} ${detail}`);
        if (block.kind === "ordered-list" || block.kind === "unordered-list") return block.items;
        return [];
      }),
    ])
    .join("\n");

describe("buildTenantAgreement", () => {
  it("substitutes the header fields", () => {
    const text = flatten({
      number: "МКР-2026-0001",
      conclusionDate: "2026-09-11",
      city: "Краснодар",
      customer: ORG_CUSTOMER,
    });
    expect(text).toContain("МКР-2026-0001");
    expect(text).toContain("11.09.2026");
    expect(text).toContain("г. Краснодар");
    expect(text).not.toContain("[номер]");
    expect(text).not.toContain("[город]");
  });

  it("keeps the original placeholder for an unfilled field", () => {
    const text = flatten({ customer: ORG_CUSTOMER });
    expect(text).toContain("[номер]");
    expect(text).toContain("г. [город]");
    expect(text).toContain("[дата заключения]");
  });

  it("renders КПП as a value for an organisation and as не применяется for an ИП", () => {
    expect(flatten({ customer: ORG_CUSTOMER })).toContain("КПП: 770101001");
    const ip = flatten({ customer: IP_CUSTOMER });
    expect(ip).toContain("КПП: не применяется");
    expect(ip).not.toContain("[для организации; для ИП — не применяется]");
  });

  it("leaves appendix 1 and 3 placeholders untouched", () => {
    const text = flatten({ number: "МКР-2026-0001", customer: ORG_CUSTOMER });
    expect(text).toContain("[идентификатор; при первичном подключении");
    expect(text).toContain("[Старт / Цех / Производство / индивидуальный]");
  });

  it("rejects the English locale until the translation lands", () => {
    expect(() => buildTenantAgreement({ customer: ORG_CUSTOMER }, "en")).toThrow(
      /English tenant agreement is not available/,
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `CI=true pnpm --filter @markiro/legal-documents exec vitest run test/tenant-agreement.test.ts`
Expected: FAIL — cannot resolve `tenant-agreement-fields.js`, and `buildTenantAgreement` is not exported.

- [ ] **Step 3: Create the field types and helper**

Create `packages/legal-documents/src/documents/tenant-agreement-fields.ts`:

```ts
export type PartyKind = "individual" | "self_employed" | "sole_proprietor" | "legal_entity";

export interface PartyRequisites {
  readonly kind: PartyKind;
  readonly name: string;
  readonly inn: string | null;
  readonly kpp: string | null;
  readonly ogrn: string | null;
  readonly address: string | null;
  readonly email: string | null;
  readonly phone: string | null;
  readonly bankName: string | null;
  readonly bic: string | null;
  readonly settlementAccount: string | null;
  readonly correspondentAccount: string | null;
  readonly taxRegime: string | null;
}

export interface AgreementSignatory {
  readonly position: string | null;
  readonly fullName: string | null;
  readonly authorityBasis: string | null;
}

export interface AgreementTerms {
  readonly disputeVenue: string | null;
  readonly penaltyRatePercent: string | null;
  readonly penaltyCapPercent: string | null;
}

export interface TenantAgreementFields {
  readonly number?: string;
  /** Civil date, `YYYY-MM-DD`. Printed as `DD.MM.YYYY`. */
  readonly conclusionDate?: string;
  readonly city?: string;
  readonly contractor?: PartyRequisites;
  readonly customer: PartyRequisites;
  readonly signatory?: AgreementSignatory;
  readonly terms?: AgreementTerms;
}

/** Falls back to the literal the static draft used, so a half-filled
 * agreement still prints something a lawyer recognises as unfilled. */
export function agreementField(value: string | null | undefined, placeholder: string): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : placeholder;
}

export function agreementDate(value: string | null | undefined, placeholder: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value?.trim() ?? "");
  if (!match) return placeholder;
  return `${match[3]}.${match[2]}.${match[1]}`;
}

export function isSoleProprietorOrIndividual(kind: PartyKind): boolean {
  return kind !== "legal_entity";
}
```

- [ ] **Step 4: Convert the text module to a builder**

In `packages/legal-documents/src/documents/tenant-agreement.ts`:

1. Change the import line to:

```ts
import type { LegalBlock, LegalDocumentLocaleContent, LegalLocale } from "../types.js";
import {
  agreementDate,
  agreementField,
  isSoleProprietorOrIndividual,
  type PartyRequisites,
  type TenantAgreementFields,
} from "./tenant-agreement-fields.js";
```

2. Replace `export const TENANT_AGREEMENT_CONTENT = { ... } as const satisfies LegalDocumentLocaleContent;` with a function wrapper. This is a mechanical move: the existing object literal — title, summary and all 27 sections — is pasted verbatim into the `return`, and only the seven values in the table below become expressions. Nothing else in the 1,500 lines is rewritten, retyped or reworded. The `as const satisfies` suffix goes away because the return type is now declared on the function.

```ts
export function buildTenantAgreement(
  fields: TenantAgreementFields,
  locale: LegalLocale,
): LegalDocumentLocaleContent {
  if (locale !== "ru") {
    throw new Error("English tenant agreement is not available in this revision");
  }
  const { customer } = fields;
  const contractor = fields.contractor;
  const signatory = fields.signatory;
  const terms = fields.terms;

  const number = agreementField(fields.number, "[номер]");
  const city = agreementField(fields.city, "[город]");
  const conclusionDate = agreementDate(fields.conclusionDate, "[дата заключения]");

  return {
    locale: "ru",
    // Both literals move across byte-for-byte from the current module.
    title:
      "Договор о предоставлении права использования программы для ЭВМ «Маркиро», доступа к сервису и выполнении услуг и работ",
    summary:
      "Проект стандартного договора Маркиро с заказчиком-юридическим лицом или индивидуальным предпринимателем: простая (неисключительная) лицензия, доступ к серверной функциональности, а также услуги и работы по отдельным заданиям. Договор не считается заключённым, пока не заполнены поля в квадратных скобках и стороны не оформили его согласованным способом.",
    sections: [
      // The existing 27 section literals, pasted unchanged, with only the
      // seven fill points from the table below turned into expressions.
    ],
  };
}
```

3. Apply these fill points, and no others:

| Where | Was | Becomes |
| --- | --- | --- |
| section `storony`, table rows | `["Номер договора", "[номер]"]` | `["Номер договора", number]` |
| same table | `["Место заключения", "г. [город]"]` | `["Место заключения", \`г. ${city}\`]` |
| same table | `["Дата заключения", "[дата заключения]"]` | `["Дата заключения", conclusionDate]` |
| section `storony`, preamble paragraph | literal with `[ИНН Исполнителя]`, `[ОГРНИП Исполнителя]`, `[полное наименование юридического лица / ИП]`, `[ИНН Заказчика]`, `[номер]`, `[должность, Ф. И. О., основание полномочий]` | template string using `preamble(contractor, customer, signatory)` (helper below) |
| section `otvetstvennost`, п. 9.5 | `0,05 процента` and `10 процентов` | `agreementField(terms?.penaltyRatePercent, "0,05")` and `agreementField(terms?.penaltyCapPercent, "10")` |
| section `dokumenty`, п. 11.3 | `[Арбитражного суда Краснодарского края / иного согласованного компетентного суда]` | `agreementField(terms?.disputeVenue, "[Арбитражного суда Краснодарского края / иного согласованного компетентного суда]")` |
| section `rekvizity`, requisites table | the whole `rows` array | `requisitesRows(contractor, customer, signatory)` |

4. Add these module-level helpers below the builder:

```ts
const CONTRACTOR_DEFAULT_NAME = "ИП Богатырев Владислав Сергеевич";

function partyName(party: PartyRequisites | undefined, placeholder: string): string {
  return agreementField(party?.name, placeholder);
}

function kppCell(party: PartyRequisites | undefined, placeholder: string): string {
  if (!party) return `КПП: ${placeholder}`;
  if (isSoleProprietorOrIndividual(party.kind)) return "КПП: не применяется";
  return `КПП: ${agreementField(party.kpp, "[КПП]")}`;
}

function registryCell(party: PartyRequisites | undefined, placeholder: string): string {
  if (party && isSoleProprietorOrIndividual(party.kind)) {
    return `ОГРНИП: ${agreementField(party.ogrn, "[ОГРНИП]")}`;
  }
  return `ОГРН/ОГРНИП: ${agreementField(party?.ogrn, placeholder)}`;
}

function preamble(
  contractor: PartyRequisites | undefined,
  customer: PartyRequisites,
  signatory: AgreementSignatory | undefined,
): string {
  const representative = [signatory?.position, signatory?.fullName, signatory?.authorityBasis]
    .filter((part): part is string => Boolean(part?.trim()))
    .join(", ");
  return (
    `Индивидуальный предприниматель Богатырев Владислав Сергеевич, ` +
    `ИНН ${agreementField(contractor?.inn, "[ИНН Исполнителя]")}, ` +
    `ОГРНИП ${agreementField(contractor?.ogrn, "[ОГРНИП Исполнителя]")}, ` +
    `именуемый «Исполнитель», а в лицензионных отношениях — «Лицензиар», с одной стороны, и ` +
    `${partyName(customer, "[полное наименование юридического лица / ИП]")}, ` +
    `ИНН ${agreementField(customer.inn, "[ИНН Заказчика]")}, ` +
    `${registryCell(customer, "[номер]")}, ` +
    `в лице ${agreementField(representative, "[должность, Ф. И. О., основание полномочий]")}, ` +
    `именуемый «Заказчик», а в лицензионных отношениях — «Лицензиат», с другой стороны, ` +
    `совместно именуемые «Стороны», заключили настоящий договор (далее — «Договор»).`
  );
}

function requisitesRows(
  contractor: PartyRequisites | undefined,
  customer: PartyRequisites,
  signatory: AgreementSignatory | undefined,
): readonly (readonly string[])[] {
  return [
    [partyName(contractor, CONTRACTOR_DEFAULT_NAME), partyName(customer, "[полное наименование / Ф. И. О. ИП]")],
    [`ИНН: ${agreementField(contractor?.inn, "[ИНН]")}`, `ИНН: ${agreementField(customer.inn, "[ИНН]")}`],
    [`ОГРНИП: ${agreementField(contractor?.ogrn, "[ОГРНИП]")}`, registryCell(customer, "[номер]")],
    ["КПП: не применяется", kppCell(customer, "[для организации; для ИП — не применяется]")],
    [
      `Адрес для корреспонденции: ${agreementField(contractor?.address, "[адрес]")}`,
      `Юридический/почтовый адрес: ${agreementField(customer.address, "[адрес]")}`,
    ],
    [
      `E-mail: ${agreementField(contractor?.email, "hello@v-b.tech")}`,
      `E-mail: ${agreementField(customer.email, "[адрес]")}`,
    ],
    [
      `Телефон: ${agreementField(contractor?.phone, "+7 934 355-14-90")}`,
      `Телефон: ${agreementField(customer.phone, "[номер]")}`,
    ],
    [
      `Банк: ${agreementField(contractor?.bankName, "[банк]")}`,
      `Банк: ${agreementField(customer.bankName, "[банк]")}`,
    ],
    [`БИК: ${agreementField(contractor?.bic, "[БИК]")}`, `БИК: ${agreementField(customer.bic, "[БИК]")}`],
    [
      `Р/с: ${agreementField(contractor?.settlementAccount, "[счёт]")}`,
      `Р/с: ${agreementField(customer.settlementAccount, "[счёт]")}`,
    ],
    [
      `К/с: ${agreementField(contractor?.correspondentAccount, "[счёт]")}`,
      `К/с: ${agreementField(customer.correspondentAccount, "[счёт]")}`,
    ],
    [
      `Налоговый режим на дату подписания: ${agreementField(contractor?.taxRegime, "НПД")}`,
      `Подписант: ${agreementField(
        [signatory?.position, signatory?.fullName].filter(Boolean).join(", "),
        "[должность, Ф. И. О.]",
      )}`,
    ],
    ["", `Основание полномочий: ${agreementField(signatory?.authorityBasis, "[документ]")}`],
  ];
}
```

The `SIGNATURES`, `PROCESSING_SIGNATURES` and `TRANSFER_SIGNATURES` constants stay as they are but move inside the module scope unchanged; they are already `satisfies LegalBlock`.

- [ ] **Step 5: Export from the package index**

In `packages/legal-documents/src/index.ts` add:

```ts
export { buildTenantAgreement } from "./documents/tenant-agreement.js";
export { TENANT_AGREEMENT_PASSPORT_CONTENT } from "./documents/tenant-agreement-passport.js";
export {
  agreementDate,
  agreementField,
  isSoleProprietorOrIndividual,
} from "./documents/tenant-agreement-fields.js";
export type {
  AgreementSignatory,
  AgreementTerms,
  PartyKind,
  PartyRequisites,
  TenantAgreementFields,
} from "./documents/tenant-agreement-fields.js";
```

- [ ] **Step 6: Update the CLI**

In `packages/legal-documents/src/cli/render-agreement-draft.ts` replace the import and the `content` value:

```ts
import { buildTenantAgreement } from "../documents/tenant-agreement.js";
```

```ts
      content: buildTenantAgreement({ customer: EMPTY_CUSTOMER }, "ru"),
```

and add above `DRAFTS`:

```ts
// An entirely unfilled customer keeps every square-bracket placeholder,
// which is exactly what the blank template should print.
const EMPTY_CUSTOMER = {
  kind: "legal_entity",
  name: "",
  inn: null,
  kpp: null,
  ogrn: null,
  address: null,
  email: null,
  phone: null,
  bankName: null,
  bic: null,
  settlementAccount: null,
  correspondentAccount: null,
  taxRegime: null,
} as const satisfies TenantAgreementFields["customer"];
```

- [ ] **Step 7: Move `docx` to runtime dependencies**

In `packages/legal-documents/package.json` move `"docx": "9.7.1"` out of `devDependencies` into a new `dependencies` block, keeping the exact pin. Then run `CI=true pnpm install --frozen-lockfile`; if it reports the lockfile is out of date, run `CI=true pnpm install` and commit the lockfile change together with the manifest.

- [ ] **Step 8: Add the published-bytes guard**

Append to `packages/legal-documents/test/docx.test.ts`:

```ts
describe("published artifacts are unchanged", () => {
  const PUBLISHED = [
    ["MKR-DPA-01", "ru"],
    ["MKR-DPA-01", "en"],
    ["MKR-BRD-01", "ru"],
    ["MKR-BRD-01", "en"],
  ] as const;

  it.each(PUBLISHED)("regenerates %s/%s byte-for-byte", async (code, locale) => {
    const bytes = await renderLegalDocx({
      code,
      revision: "2026.08/01",
      effectiveDate: "2026-08-15",
      locale,
      kind: "template-docx",
      verificationUrl: `https://markiro.app/d/${code}/2026.08/01/15.08.2026`,
    });
    const published = await readFile(
      new URL(
        `../../../apps/landing/public/legal/files/markiro_${code.toLowerCase()}_2026.08-01_${locale}.docx`,
        import.meta.url,
      ),
    );
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      createHash("sha256").update(published).digest("hex"),
    );
  });
});
```

Add `import { createHash } from "node:crypto";` and `import { readFile } from "node:fs/promises";` to the top of the file.

- [ ] **Step 9: Run the package gates**

Run: `CI=true pnpm --filter @markiro/legal-documents run test`
Expected: PASS, including the five new `buildTenantAgreement` tests and four `published artifacts` cases.

Run: `CI=true pnpm --filter @markiro/legal-documents run typecheck && CI=true pnpm --filter @markiro/legal-documents run lint`
Expected: both silent.

Run: `CI=true pnpm --filter @markiro/legal-documents run agreement:draft`
Expected: two paths printed under `.local/`. Open the DOCX and confirm the requisites table still shows placeholders.

- [ ] **Step 10: Commit**

```bash
git add packages/legal-documents pnpm-lock.yaml
git commit -m "feat(legal): make the tenant agreement a function of its fields"
```

---

### Task 2: Database schema and migration

**Files:**
- Create: `packages/db/src/schema/agreements.ts`
- Modify: `packages/db/src/schema/index.ts`
- Create: `packages/db/migrations/0127_platform_agreements.sql` (confirm the next index in `migrations/meta/_journal.json`)
- Test: `packages/db/test/agreements-schema.test.ts`

**Interfaces:**
- Consumes: `organization` from `./auth.js`, `platformUsers` from `./platform-auth.js`.
- Produces: `platformAgreementStatus`, `platformAgreements`, `platformAgreementDocuments`, `platformAgreementDocumentKind`. Tasks 5–8 import these from `@markiro/db`.

- [ ] **Step 1: Write the failing test**

Create `packages/db/test/agreements-schema.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { platformAgreementDocuments, platformAgreements } from "../src/schema/agreements.js";

describe("platform agreements schema", () => {
  it("keeps the tenant link optional", () => {
    expect(platformAgreements.tenantId.notNull).toBe(false);
  });

  it("stores the counterparty INN as its own indexed column", () => {
    expect(platformAgreements.counterpartyInn.name).toBe("counterparty_inn");
  });

  it("requires a checksum on every document row", () => {
    expect(platformAgreementDocuments.sha256.notNull).toBe(true);
    expect(platformAgreementDocuments.byteSize.notNull).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `CI=true pnpm --filter @markiro/db exec vitest run test/agreements-schema.test.ts`
Expected: FAIL — cannot resolve `../src/schema/agreements.js`.

- [ ] **Step 3: Write the schema**

Create `packages/db/src/schema/agreements.ts`:

```ts
import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  date,
  foreignKey,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import { organization } from "./auth.js";
import { platformUsers } from "./platform-auth.js";

export const platformAgreementStatus = pgEnum("platform_agreement_status", [
  "draft",
  "in_review",
  "sent",
  "signed",
  "terminated",
]);

export const platformAgreementDocumentKind = pgEnum("platform_agreement_document_kind", [
  "draft",
  "generated",
  "attachment",
]);

export const platformAgreements = pgTable(
  "platform_agreements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    number: text("number").notNull(),
    status: platformAgreementStatus("status").notNull().default("draft"),
    conclusionDate: date("conclusion_date"),
    city: text("city"),
    tenantId: text("tenant_id"),
    counterpartyInn: text("counterparty_inn"),
    counterparty: jsonb("counterparty").$type<Record<string, unknown>>().notNull(),
    contractor: jsonb("contractor").$type<Record<string, unknown>>().notNull(),
    terms: jsonb("terms").$type<Record<string, unknown>>().notNull(),
    signedAt: timestamp("signed_at", { withTimezone: true }),
    signedSnapshot: jsonb("signed_snapshot").$type<Record<string, unknown>>(),
    terminatedAt: timestamp("terminated_at", { withTimezone: true }),
    terminationReason: text("termination_reason"),
    createdByPlatformUserId: text("created_by_platform_user_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("platform_agreements_number_uq").on(table.number),
    index("platform_agreements_status_idx").on(table.status),
    index("platform_agreements_tenant_idx").on(table.tenantId),
    index("platform_agreements_counterparty_inn_idx").on(table.counterpartyInn),
    foreignKey({
      name: "platform_agreements_tenant_fk",
      columns: [table.tenantId],
      foreignColumns: [organization.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "platform_agreements_creator_fk",
      columns: [table.createdByPlatformUserId],
      foreignColumns: [platformUsers.id],
    }).onDelete("restrict"),
    check(
      "platform_agreements_signed_consistency",
      sql`(${table.status} in ('signed', 'terminated')) = (${table.signedSnapshot} is not null and ${table.signedAt} is not null)`,
    ),
    check(
      "platform_agreements_terminated_consistency",
      sql`(${table.status} = 'terminated') = (${table.terminatedAt} is not null)`,
    ),
    check(
      "platform_agreements_inn_format",
      sql`${table.counterpartyInn} is null or ${table.counterpartyInn} ~ '^[0-9]{10}$|^[0-9]{12}$'`,
    ),
  ],
);

export const platformAgreementDocuments = pgTable(
  "platform_agreement_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agreementId: uuid("agreement_id")
      .notNull()
      .references(() => platformAgreements.id, { onDelete: "cascade" }),
    kind: platformAgreementDocumentKind("kind").notNull(),
    filename: text("filename").notNull(),
    mediaType: text("media_type").notNull(),
    objectKey: text("object_key").notNull(),
    sha256: text("sha256").notNull(),
    byteSize: bigint("byte_size", { mode: "number" }).notNull(),
    rendererVersion: text("renderer_version"),
    uploadedByPlatformUserId: text("uploaded_by_platform_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("platform_agreement_documents_object_key_uq").on(table.objectKey),
    index("platform_agreement_documents_agreement_idx").on(table.agreementId, table.createdAt),
    foreignKey({
      name: "platform_agreement_documents_uploader_fk",
      columns: [table.uploadedByPlatformUserId],
      foreignColumns: [platformUsers.id],
    }).onDelete("restrict"),
    check(
      "platform_agreement_documents_checksum_format",
      sql`${table.sha256} ~ '^[0-9a-f]{64}$'`,
    ),
    check("platform_agreement_documents_size_positive", sql`${table.byteSize} > 0`),
    check(
      "platform_agreement_documents_provenance",
      sql`(${table.kind} = 'attachment' and ${table.uploadedByPlatformUserId} is not null and ${table.rendererVersion} is null) or (${table.kind} in ('draft', 'generated') and ${table.uploadedByPlatformUserId} is null and ${table.rendererVersion} is not null)`,
    ),
  ],
);
```

- [ ] **Step 4: Re-export and generate the migration**

Add `export * from "./agreements.js";` to `packages/db/src/schema/index.ts`, keeping the existing alphabetical position.

Run: `set -a; source .env; set +a; CI=true pnpm --filter @markiro/db db:generate`
Expected: a new SQL file appears under `packages/db/migrations/`. Read it and confirm it creates both enums, both tables, all indexes, both foreign keys and all six check constraints — Drizzle silently drops checks it cannot serialise, so this review is not optional.

- [ ] **Step 5: Run the tests**

Run: `CI=true pnpm --filter @markiro/db exec vitest run test/agreements-schema.test.ts`
Expected: PASS.

Run: `CI=true pnpm --filter @markiro/db run test`
Expected: PASS. The migration-journal test will fail if the generated file was not added to `meta/_journal.json`.

- [ ] **Step 6: Build so consumers see the new tables**

Run: `CI=true pnpm --filter @markiro/db run build`
Expected: silent. `@markiro/db` ships compiled `dist`; skipping this makes Tasks 5–8 compile against stale output.

- [ ] **Step 7: Commit**

```bash
git add packages/db
git commit -m "feat(db): add platform agreements and their documents"
```

---

### Task 3: Platform capabilities

**Files:**
- Modify: `packages/platform-contracts/src/platform-auth.ts:19-61`
- Test: `packages/platform-contracts/test/platform-auth.test.ts` (create if absent)
- Modify: every fixture that builds a `platformPrincipal` — find them with the grep in Step 3.

**Interfaces:**
- Produces: capabilities `"agreements.read"` and `"agreements.write"` on `platformCapabilitySchema`. Tasks 5–8 pass them to `@RequirePlatformCapabilities`; Task 9 passes them to `hasCapability`.

- [ ] **Step 1: Write the failing test**

Append to `packages/platform-contracts/test/platform-auth.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  platformCapabilitiesForRole,
  platformPrincipalSchema,
} from "../src/platform-auth.js";

describe("agreement capabilities", () => {
  it("gives write access to platform_admin and accountant only", () => {
    expect(platformCapabilitiesForRole.platform_admin).toContain("agreements.write");
    expect(platformCapabilitiesForRole.accountant).toContain("agreements.write");
    expect(platformCapabilitiesForRole.support).not.toContain("agreements.write");
  });

  it("gives read access to every role", () => {
    for (const role of ["platform_admin", "support", "accountant"] as const) {
      expect(platformCapabilitiesForRole[role]).toContain("agreements.read");
    }
  });

  it("still rejects a principal whose capabilities do not match its role", () => {
    const result = platformPrincipalSchema.safeParse({
      userId: "user-1",
      role: "support",
      capabilities: [...platformCapabilitiesForRole.support, "agreements.write"],
      twoFactorReady: true,
    });
    expect(result.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `CI=true pnpm --filter @markiro/platform-contracts exec vitest run test/platform-auth.test.ts`
Expected: FAIL — `agreements.write` is not in the enum, so `toContain` fails.

- [ ] **Step 3: Add the capabilities**

In `packages/platform-contracts/src/platform-auth.ts`, add `"agreements.read"` and `"agreements.write"` to `platformCapabilitySchema` after `"billing.write"`, then update `platformCapabilitiesForRole`:

- `platform_admin`: add both, after `"billing.write"`.
- `accountant`: add both, after `"billing.write"`.
- `support`: add `"agreements.read"` only, after `"catalog.read"`.

- [ ] **Step 4: Update every principal fixture**

Run: `grep -rln "twoFactorReady" apps/api/test apps/saas-admin/src packages/platform-contracts/test | sort`

For each hit that hard-codes a capability array, extend it from `platformCapabilitiesForRole[role]` instead of listing strings, so the next capability addition does not break it again. Where a test deliberately asserts an exact array, add the two new values.

- [ ] **Step 5: Run the affected suites**

Run: `CI=true pnpm --filter @markiro/platform-contracts run test && CI=true pnpm --filter @markiro/platform-contracts run build`
Expected: PASS, then silent build.

Run: `CI=true pnpm --filter @markiro/api exec vitest run test/platform-auth.guard.test.ts`
Expected: PASS. If the file name differs, run the whole `apps/api` suite filtered on `platform` and fix every principal fixture the failure names.

- [ ] **Step 6: Commit**

```bash
git add packages/platform-contracts apps/api/test apps/saas-admin/src
git commit -m "feat(platform): add agreements read and write capabilities"
```

---

### Task 4: Zod contracts for the agreements API

**Files:**
- Create: `packages/platform-contracts/src/agreements.ts`
- Modify: `packages/platform-contracts/src/index.ts`
- Test: `packages/platform-contracts/test/agreements.test.ts`

**Interfaces:**
- Consumes: `platformTimestampSchema`, `platformUuidSchema`, `platformTenantIdSchema` from `./primitives.js`.
- Produces: `platformAgreementContracts` with `list`, `detail`, `create`, `update`, `transition`, `linkTenant`, `unlinkTenant`, `tenantCandidates`, `documents.list`, `documents.render`, `documents.download`, `attachments.upload`, `attachments.delete`; types `AgreementSummary`, `AgreementDetail`, `AgreementRequisitesInput`, `CreateAgreementInput`, `UpdateAgreementInput`, `AgreementStatus`. Tasks 5–11 import these.

- [ ] **Step 1: Write the failing test**

Create `packages/platform-contracts/test/agreements.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { platformAgreementContracts } from "../src/agreements.js";

const LEGAL_ENTITY = {
  kind: "legal_entity",
  name: "ООО «Пример»",
  inn: "7701234567",
  kpp: "770101001",
  ogrn: "1027700000000",
  address: "101000, Москва",
  email: "buh@example.ru",
  phone: "+7 495 000-00-00",
  bankName: "АО «Банк»",
  bic: "044525000",
  settlementAccount: "40702810000000000001",
  correspondentAccount: "30101810000000000002",
};

describe("platformAgreementContracts", () => {
  it("accepts a legal entity counterparty", () => {
    expect(
      platformAgreementContracts.create.body.safeParse({ counterparty: LEGAL_ENTITY }).success,
    ).toBe(true);
  });

  it("rejects a ten-digit INN on a sole proprietor", () => {
    const result = platformAgreementContracts.create.body.safeParse({
      counterparty: { ...LEGAL_ENTITY, kind: "sole_proprietor", inn: "7701234567", ogrnip: "312770000000001" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown fields", () => {
    const result = platformAgreementContracts.create.body.safeParse({
      counterparty: LEGAL_ENTITY,
      sneaky: true,
    });
    expect(result.success).toBe(false);
  });

  it("requires a termination reason only when terminating", () => {
    expect(
      platformAgreementContracts.transition.body.safeParse({ status: "sent" }).success,
    ).toBe(true);
    expect(
      platformAgreementContracts.transition.body.safeParse({ status: "terminated" }).success,
    ).toBe(false);
    expect(
      platformAgreementContracts.transition.body.safeParse({
        status: "terminated",
        terminationReason: "Соглашение сторон",
      }).success,
    ).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `CI=true pnpm --filter @markiro/platform-contracts exec vitest run test/agreements.test.ts`
Expected: FAIL — cannot resolve `../src/agreements.js`.

- [ ] **Step 3: Write the contracts**

Create `packages/platform-contracts/src/agreements.ts`:

```ts
import { z } from "zod";

import { platformTenantIdSchema, platformTimestampSchema, platformUuidSchema } from "./primitives.js";

export const agreementStatusSchema = z.enum([
  "draft",
  "in_review",
  "sent",
  "signed",
  "terminated",
]);
export type AgreementStatus = z.infer<typeof agreementStatusSchema>;

const bankFields = {
  address: z.string().trim().min(1).max(1_000).nullable(),
  email: z.string().trim().email().max(320).nullable(),
  phone: z.string().trim().min(1).max(64).nullable(),
  bankName: z.string().trim().min(1).max(300).nullable(),
  bic: z
    .string()
    .regex(/^\d{9}$/)
    .nullable(),
  settlementAccount: z
    .string()
    .regex(/^\d{20}$/)
    .nullable(),
  correspondentAccount: z
    .string()
    .regex(/^\d{20}$/)
    .nullable(),
};
const commonRequisites = {
  name: z.string().trim().min(1).max(500),
  ...bankFields,
};

const individualRequisites = z
  .object({
    ...commonRequisites,
    kind: z.literal("individual"),
    inn: z
      .string()
      .regex(/^\d{12}$/)
      .nullable(),
  })
  .strict();
const selfEmployedRequisites = z
  .object({
    ...commonRequisites,
    kind: z.literal("self_employed"),
    inn: z.string().regex(/^\d{12}$/),
  })
  .strict();
const soleProprietorRequisites = z
  .object({
    ...commonRequisites,
    kind: z.literal("sole_proprietor"),
    inn: z.string().regex(/^\d{12}$/),
    ogrnip: z.string().regex(/^\d{15}$/),
  })
  .strict();
const legalEntityRequisites = z
  .object({
    ...commonRequisites,
    kind: z.literal("legal_entity"),
    inn: z.string().regex(/^\d{10}$/),
    kpp: z.string().regex(/^\d{9}$/),
    ogrn: z.string().regex(/^\d{13}$/),
  })
  .strict();

export const agreementRequisitesSchema = z.discriminatedUnion("kind", [
  individualRequisites,
  selfEmployedRequisites,
  soleProprietorRequisites,
  legalEntityRequisites,
]);
export type AgreementRequisitesInput = z.infer<typeof agreementRequisitesSchema>;

export const agreementSignatorySchema = z
  .object({
    position: z.string().trim().min(1).max(300).nullable(),
    fullName: z.string().trim().min(1).max(300).nullable(),
    authorityBasis: z.string().trim().min(1).max(500).nullable(),
  })
  .strict();

export const agreementTermsSchema = z
  .object({
    disputeVenue: z.string().trim().min(1).max(500).nullable(),
    penaltyRatePercent: z
      .string()
      .regex(/^\d{1,2}(,\d{1,3})?$/)
      .nullable(),
    penaltyCapPercent: z
      .string()
      .regex(/^\d{1,3}(,\d{1,2})?$/)
      .nullable(),
  })
  .strict();

const agreementSummarySchema = z
  .object({
    id: platformUuidSchema,
    number: z.string(),
    status: agreementStatusSchema,
    counterpartyName: z.string(),
    counterpartyInn: z.string().nullable(),
    conclusionDate: z.string().nullable(),
    tenantId: platformTenantIdSchema.nullable(),
    signedAt: platformTimestampSchema.nullable(),
    createdAt: platformTimestampSchema,
  })
  .strict();
export type AgreementSummary = z.infer<typeof agreementSummarySchema>;

const agreementDocumentSchema = z
  .object({
    id: platformUuidSchema,
    kind: z.enum(["draft", "generated", "attachment"]),
    filename: z.string(),
    mediaType: z.string(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    byteSize: z.number().int().positive(),
    createdAt: platformTimestampSchema,
  })
  .strict();

const agreementDetailSchema = agreementSummarySchema
  .extend({
    city: z.string().nullable(),
    counterparty: agreementRequisitesSchema,
    contractor: agreementRequisitesSchema,
    signatory: agreementSignatorySchema,
    terms: agreementTermsSchema,
    terminatedAt: platformTimestampSchema.nullable(),
    terminationReason: z.string().nullable(),
    editable: z.boolean(),
    documents: z.array(agreementDocumentSchema).readonly(),
  })
  .strict();
export type AgreementDetail = z.infer<typeof agreementDetailSchema>;

const createBody = z
  .object({
    number: z.string().trim().min(1).max(120).optional(),
    conclusionDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    city: z.string().trim().min(1).max(200).optional(),
    counterparty: agreementRequisitesSchema,
    signatory: agreementSignatorySchema.optional(),
    terms: agreementTermsSchema.optional(),
  })
  .strict();
export type CreateAgreementInput = z.infer<typeof createBody>;

const updateBody = createBody.partial({ counterparty: true }).strict();
export type UpdateAgreementInput = z.infer<typeof updateBody>;

const transitionBody = z
  .object({
    status: agreementStatusSchema,
    terminationReason: z.string().trim().min(1).max(1_000).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.status === "terminated" && !value.terminationReason) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["terminationReason"],
        message: "Termination requires a reason",
      });
    }
    if (value.status !== "terminated" && value.terminationReason) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["terminationReason"],
        message: "Only termination accepts a reason",
      });
    }
  });

const listQuery = z
  .object({
    status: agreementStatusSchema.optional(),
    withoutTenant: z.coerce.boolean().optional(),
    search: z.string().trim().min(1).max(200).optional(),
  })
  .strict();
export type AgreementListQuery = z.infer<typeof listQuery>;

// There is no `documents.list`: the detail response already embeds the
// document rows, and a second endpoint would be a second source of truth
// for the same list.
export const platformAgreementContracts = {
  list: {
    query: listQuery,
    response: z.object({ agreements: z.array(agreementSummarySchema).readonly() }).strict(),
  },
  detail: {
    params: platformUuidSchema,
    response: z.object({ agreement: agreementDetailSchema }).strict(),
  },
  create: {
    body: createBody,
    response: z.object({ agreement: agreementDetailSchema }).strict(),
  },
  update: {
    params: platformUuidSchema,
    body: updateBody,
    response: z.object({ agreement: agreementDetailSchema }).strict(),
  },
  transition: {
    params: platformUuidSchema,
    body: transitionBody,
    response: z.object({ agreement: agreementDetailSchema }).strict(),
  },
  linkTenant: {
    params: platformUuidSchema,
    body: z.object({ tenantId: platformTenantIdSchema }).strict(),
    response: z.object({ agreement: agreementDetailSchema }).strict(),
  },
  unlinkTenant: {
    params: platformUuidSchema,
    response: z.object({ agreement: agreementDetailSchema }).strict(),
  },
  tenantCandidates: {
    params: platformUuidSchema,
    response: z
      .object({
        candidates: z
          .array(
            z
              .object({ tenantId: platformTenantIdSchema, name: z.string(), inn: z.string().nullable() })
              .strict(),
          )
          .readonly(),
      })
      .strict(),
  },
  documents: {
    render: {
      params: platformUuidSchema,
      response: z.object({ document: agreementDocumentSchema }).strict(),
    },
    download: {
      params: z.object({ id: platformUuidSchema, documentId: platformUuidSchema }).strict(),
      response: z.object({ url: z.string().url() }).strict(),
    },
  },
  attachments: {
    upload: {
      params: platformUuidSchema,
      response: z.object({ document: agreementDocumentSchema }).strict(),
    },
    delete: {
      params: z.object({ id: platformUuidSchema, documentId: platformUuidSchema }).strict(),
      response: z.object({ deleted: z.literal(true) }).strict(),
    },
  },
} as const;
```

- [ ] **Step 4: Export from the index**

Add to `packages/platform-contracts/src/index.ts`:

```ts
export { agreementStatusSchema, agreementRequisitesSchema, platformAgreementContracts } from "./agreements.js";
export type {
  AgreementDetail,
  AgreementListQuery,
  AgreementRequisitesInput,
  AgreementStatus,
  AgreementSummary,
  CreateAgreementInput,
  UpdateAgreementInput,
} from "./agreements.js";
```

- [ ] **Step 5: Run the tests and build**

Run: `CI=true pnpm --filter @markiro/platform-contracts run test && CI=true pnpm --filter @markiro/platform-contracts run typecheck && CI=true pnpm --filter @markiro/platform-contracts run build`
Expected: PASS, silent, silent.

- [ ] **Step 6: Commit**

```bash
git add packages/platform-contracts
git commit -m "feat(platform-contracts): add the agreements API contracts"
```

---

### Task 5: API module — CRUD, numbering and transitions

**Files:**
- Create: `apps/api/src/modules/platform-agreements/platform-agreements.module.ts`
- Create: `apps/api/src/modules/platform-agreements/platform-agreements.controller.ts`
- Create: `apps/api/src/modules/platform-agreements/platform-agreements.service.ts`
- Create: `apps/api/src/modules/platform-agreements/dto.ts`
- Modify: `apps/api/src/app.module.ts`
- Test: `apps/api/test/platform-agreements.e2e-spec.ts`

**Interfaces:**
- Consumes: `platformAgreementContracts` (Task 4), `platformAgreements` (Task 2), `RequirePlatformCapabilities`, `RequestWithPlatformPrincipal`, `PlatformApiProtectedOk`, `PlatformApiProtectedCreated`, `parsePlatformResponse`, `ZodValidationPipe`.
- Produces: `PlatformAgreementsService` with `list`, `detail`, `create`, `update`, `transition`, `linkTenant`, `unlinkTenant`, `tenantCandidates`, and the exported helpers `nextAgreementNumber(existing: readonly string[], year: number): string` and `isTransitionAllowed(from: AgreementStatus, to: AgreementStatus): boolean`. Tasks 6–8 and 11 rely on these names.

- [ ] **Step 1: Write the failing unit tests for the pure helpers**

Create `apps/api/test/agreement-transitions.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  isTransitionAllowed,
  nextAgreementNumber,
} from "../src/modules/platform-agreements/platform-agreements.service";

describe("nextAgreementNumber", () => {
  it("starts a fresh year at one", () => {
    expect(nextAgreementNumber([], 2026)).toBe("МКР-2026-0001");
  });

  it("continues from the highest sequence of the same year", () => {
    expect(nextAgreementNumber(["МКР-2026-0001", "МКР-2026-0007"], 2026)).toBe("МКР-2026-0008");
  });

  it("ignores other years and manually typed numbers", () => {
    expect(nextAgreementNumber(["МКР-2025-0099", "договор от руки"], 2026)).toBe("МКР-2026-0001");
  });
});

describe("isTransitionAllowed", () => {
  it("allows free movement among the editable statuses", () => {
    expect(isTransitionAllowed("draft", "in_review")).toBe(true);
    expect(isTransitionAllowed("sent", "draft")).toBe(true);
  });

  it("allows signing from sent and terminating from signed", () => {
    expect(isTransitionAllowed("sent", "signed")).toBe(true);
    expect(isTransitionAllowed("signed", "terminated")).toBe(true);
  });

  it("never returns from signed to an editable status", () => {
    expect(isTransitionAllowed("signed", "draft")).toBe(false);
    expect(isTransitionAllowed("signed", "sent")).toBe(false);
    expect(isTransitionAllowed("terminated", "signed")).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `CI=true pnpm --filter @markiro/api exec vitest run test/agreement-transitions.test.ts`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Write the service with the two pure helpers**

Create `apps/api/src/modules/platform-agreements/platform-agreements.service.ts`. Start with the helpers, which stay module-level exports so they are testable without Nest:

```ts
import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import type { AgreementStatus } from "@markiro/platform-contracts";

const NUMBER_PATTERN = /^МКР-(\d{4})-(\d{4})$/;

export function nextAgreementNumber(existing: readonly string[], year: number): string {
  let highest = 0;
  for (const candidate of existing) {
    const match = NUMBER_PATTERN.exec(candidate);
    if (!match || Number(match[1]) !== year) continue;
    highest = Math.max(highest, Number(match[2]));
  }
  return `МКР-${year}-${String(highest + 1).padStart(4, "0")}`;
}

const ALLOWED_TRANSITIONS: Readonly<Record<AgreementStatus, readonly AgreementStatus[]>> = {
  draft: ["in_review", "sent"],
  in_review: ["draft", "sent"],
  sent: ["draft", "in_review", "signed"],
  signed: ["terminated"],
  terminated: [],
};

export function isTransitionAllowed(from: AgreementStatus, to: AgreementStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export const EDITABLE_STATUSES: readonly AgreementStatus[] = ["draft", "in_review", "sent"];

export function isEditable(status: AgreementStatus): boolean {
  return EDITABLE_STATUSES.includes(status);
}
```

Then the module-level pieces the service needs. `EMPTY_TERMS` is what an
agreement created without terms stores, so the JSONB column never holds
`null` and `toAgreementFields` never has to guess:

```ts
const EMPTY_TERMS = {
  disputeVenue: null,
  penaltyRatePercent: null,
  penaltyCapPercent: null,
} as const;

/** Postgres reports a unique violation as SQLSTATE 23505 with the
 * constraint name in `constraint`; the driver surfaces it on the error
 * object rather than in the message. */
function isUniqueViolation(error: unknown, constraint: string): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: unknown; constraint?: unknown; cause?: unknown };
  if (candidate.code === "23505" && candidate.constraint === constraint) return true;
  return candidate.cause !== undefined && isUniqueViolation(candidate.cause, constraint);
}
```

Confirm that shape against the driver in use before relying on it: run
`grep -rn "23505" apps/api/src` and copy whatever the existing modules
already do. If the repo has a shared helper, use it instead of this one.

The contractor requisites come from the operator billing profile that
`/settings/organization` already edits, never from operator input on the
agreement form:

```ts
private async loadContractorRequisites(): Promise<AgreementRequisitesInput> {
  const [profile] = await this.db
    .select()
    .from(operatorBillingProfiles)
    .limit(1);
  if (!profile) {
    throw new ConflictException(
      "Operator billing profile is not configured; fill it in Настройки → Наша организация first",
    );
  }
  return {
    kind: profile.kind,
    name: profile.displayName,
    inn: profile.inn,
    ...(profile.kind === "legal_entity"
      ? { kpp: profile.kpp, ogrn: profile.ogrn }
      : profile.kind === "sole_proprietor"
        ? { ogrnip: profile.ogrnip }
        : {}),
    address: profile.legalAddressRaw,
    email: profile.contactEmail,
    phone: profile.contactPhone,
    bankName: null,
    bic: null,
    settlementAccount: null,
    correspondentAccount: null,
  } as AgreementRequisitesInput;
}
```

Read `packages/db/src/schema/billing.ts` for the real column names on
`operatorBillingProfiles` and `operatorBankAccounts` before writing this
— the bank fields live on the separate accounts table, so the default
account has to be joined in rather than left null. The failing case
above is deliberate: creating an agreement before the operator profile
exists would silently print a contract with the seller's requisites
blank.

Then the injectable service. `create` computes the number inside the transaction and retries once on the unique-constraint conflict, because two operators clicking at the same second is the only way this races:

```ts
@Injectable()
export class PlatformAgreementsService {
  constructor(private readonly db: DatabaseService) {}

  async create(principal: PlatformPrincipal, input: CreateAgreementInput) {
    const contractor = await this.loadContractorRequisites();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await this.db.transaction(async (tx) => {
          const number =
            input.number ??
            nextAgreementNumber(
              (await tx.select({ number: platformAgreements.number }).from(platformAgreements)).map(
                (row) => row.number,
              ),
              new Date().getUTCFullYear(),
            );
          const [row] = await tx
            .insert(platformAgreements)
            .values({
              number,
              status: "draft",
              conclusionDate: input.conclusionDate ?? null,
              city: input.city ?? null,
              counterpartyInn: input.counterparty.inn ?? null,
              counterparty: input.counterparty,
              contractor,
              terms: input.terms ?? EMPTY_TERMS,
              createdByPlatformUserId: principal.userId,
            })
            .returning();
          if (!row) throw new Error("Agreement insert returned no row");
          return row;
        });
      } catch (error) {
        if (attempt === 0 && isUniqueViolation(error, "platform_agreements_number_uq")) continue;
        throw error;
      }
    }
    throw new ConflictException("Could not allocate an agreement number");
  }
}
```

`update` loads the row, throws `ConflictException` when `isEditable(row.status)` is false, and writes only the provided keys. `transition` throws `ConflictException` when `isTransitionAllowed` is false; the `signed` target additionally requires the document render from Task 7, so for now it sets `signedAt` and `signedSnapshot` from the current field values — Task 7 replaces that with a call into the document service.

`detail` maps the row to the contract shape and sets `editable: isEditable(row.status)`.

Every mutating method writes an audit row through the existing platform audit helper, with the agreement id as the target and, for `transition`, `{ from, to }` in the metadata. Copy the exact call shape from `apps/api/src/modules/platform-offers/platform-offers.service.ts`.

- [ ] **Step 4: Run the unit tests**

Run: `CI=true pnpm --filter @markiro/api exec vitest run test/agreement-transitions.test.ts`
Expected: PASS, nine assertions.

- [ ] **Step 5: Write the controller and module**

`platform-agreements.controller.ts` follows `platform-offers.controller.ts` exactly: `@ApiTags("platform-agreements")`, `@Controller("platform/agreements")`, every handler carrying `@PlatformApiProtectedOk`/`Created`, a `@RequirePlatformCapabilities(...)` and `parsePlatformResponse`. Read is `agreements.read`; create, update, transition, link, unlink are `agreements.write`.

A handler without a policy decorator is denied by the global guard with `missing_policy` — that is the desired failure, but it means every new route needs the decorator explicitly.

Register `PlatformAgreementsModule` in `apps/api/src/app.module.ts` beside `PlatformOffersModule`.

- [ ] **Step 6: Write the e2e test**

Create `apps/api/test/platform-agreements.e2e-spec.ts` following the offers e2e file for bootstrapping. Cover:

```
- creates a draft with an auto-allocated number and returns editable: true
- rejects create for a support principal with 403
- allows update while sent and rejects it after signing with 409
- rejects the transition signed -> draft with 409
- writes an audit row with the exact actor, target and { from, to } metadata
- rejects a create body with an unknown field with 400
```

- [ ] **Step 7: Run the e2e suite**

Run: `set -a; source .env; set +a; CI=true pnpm --filter @markiro/api exec vitest run test/platform-agreements.e2e-spec.ts`
Expected: PASS. Without `DATABASE_URL` these tests skip; a skip is not a pass — report it as unverified.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/modules/platform-agreements apps/api/src/app.module.ts apps/api/test
git commit -m "feat(api): add the platform agreements module"
```

---

### Task 6: Tenant linking and candidates by INN

**Files:**
- Modify: `apps/api/src/modules/platform-agreements/platform-agreements.service.ts`
- Modify: `apps/api/src/modules/platform-agreements/platform-agreements.controller.ts`
- Test: `apps/api/test/platform-agreements-tenant-link.e2e-spec.ts`

**Interfaces:**
- Consumes: `PlatformAgreementsService` (Task 5), `tenantBillingProfiles` from `@markiro/db`.
- Produces: `linkTenant(principal, id, tenantId)`, `unlinkTenant(principal, id)`, `tenantCandidates(principal, id)` returning `{ tenantId, name, inn }[]`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/platform-agreements-tenant-link.e2e-spec.ts` with these cases:

```
- suggests only tenants whose billing profile INN equals the agreement INN
- returns an empty candidate list when the agreement has no INN
- links a tenant and reflects it in the detail response
- unlinks and leaves the agreement otherwise unchanged
- rejects linking a tenant that does not exist with 404
- allows linking after signing, because the link is registry metadata and not contract text
```

The last case is the one worth stating out loud: signing freezes the printed document, not the operator's bookkeeping. Assert that linking a signed agreement leaves `signedSnapshot` byte-identical.

- [ ] **Step 2: Run it to verify it fails**

Run: `set -a; source .env; set +a; CI=true pnpm --filter @markiro/api exec vitest run test/platform-agreements-tenant-link.e2e-spec.ts`
Expected: FAIL — the routes return 404.

- [ ] **Step 3: Implement the three methods**

```ts
async tenantCandidates(principal: PlatformPrincipal, id: string) {
  const agreement = await this.requireAgreement(id);
  if (!agreement.counterpartyInn) return { candidates: [] };
  const rows = await this.db
    .select({
      tenantId: tenantBillingProfiles.tenantId,
      name: tenantBillingProfiles.displayName,
      inn: tenantBillingProfiles.inn,
    })
    .from(tenantBillingProfiles)
    .where(eq(tenantBillingProfiles.inn, agreement.counterpartyInn));
  return { candidates: rows };
}
```

`linkTenant` verifies the tenant exists in `organization`, sets `tenantId`, and audits `platform.agreement.tenant_linked` with both the old and the new value. `unlinkTenant` sets it to `null` and audits the mirror event. Neither touches `signedSnapshot`.

Confirm the column name for the tenant display name in `packages/db/src/schema/billing.ts` before writing the select — the plan assumes `displayName`, and the profile schema in `packages/platform-contracts/src/commercial.ts:114` has both `fullName` and `displayName`.

- [ ] **Step 4: Run the test**

Run: `set -a; source .env; set +a; CI=true pnpm --filter @markiro/api exec vitest run test/platform-agreements-tenant-link.e2e-spec.ts`
Expected: PASS, six cases.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/platform-agreements apps/api/test
git commit -m "feat(api): link agreements to tenants with INN candidates"
```

---

### Task 7: Document rendering and storage

**Files:**
- Create: `apps/api/src/modules/platform-agreements/agreement-fields.ts`
- Create: `apps/api/src/modules/platform-agreements/agreement-documents.service.ts`
- Modify: `apps/api/src/modules/platform-agreements/platform-agreements.controller.ts`
- Modify: `apps/api/src/modules/platform-agreements/platform-agreements.module.ts`
- Modify: `apps/api/package.json` — add `"@markiro/legal-documents": "workspace:*"` to `dependencies` if it is not already there
- Test: `apps/api/test/agreement-fields.test.ts`
- Test: `apps/api/test/platform-agreements-documents.e2e-spec.ts`

**Interfaces:**
- Consumes: `buildTenantAgreement`, `TenantAgreementFields` (Task 1); `renderLegalDocxDraft` from `@markiro/legal-documents/artifacts`; `ObjectStorageService` from `apps/api/src/modules/storage/object-storage.service`.
- Produces: `toAgreementFields(row): TenantAgreementFields`; `AgreementDocumentsService` with `renderDraft(principal, id)`, `renderSigned(tx, agreement)`, `download(principal, id, documentId)`.

- [ ] **Step 1: Write the failing unit test for the mapper**

Create `apps/api/test/agreement-fields.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { toAgreementFields } from "../src/modules/platform-agreements/agreement-fields";

const ROW = {
  number: "МКР-2026-0001",
  conclusionDate: "2026-09-11",
  city: "Краснодар",
  counterparty: { kind: "legal_entity", name: "ООО «Пример»", inn: "7701234567", kpp: "770101001" },
  contractor: { kind: "sole_proprietor", name: "ИП Богатырев Владислав Сергеевич", inn: "231000000000" },
  terms: { disputeVenue: null, penaltyRatePercent: null, penaltyCapPercent: null },
  signatory: { position: "Генеральный директор", fullName: "Иванов И. И.", authorityBasis: "Устав" },
};

describe("toAgreementFields", () => {
  it("carries the header through", () => {
    const fields = toAgreementFields(ROW as never);
    expect(fields.number).toBe("МКР-2026-0001");
    expect(fields.city).toBe("Краснодар");
  });

  it("fills every requisite key so the template never sees undefined", () => {
    const fields = toAgreementFields(ROW as never);
    expect(fields.customer.bic).toBeNull();
    expect(fields.customer.correspondentAccount).toBeNull();
    expect(fields.customer.kpp).toBe("770101001");
  });
});
```

The second case matters because the JSONB column holds whatever an older revision wrote; the mapper normalises missing keys to `null` rather than letting `undefined` reach `agreementField`.

- [ ] **Step 2: Run it to verify it fails**

Run: `CI=true pnpm --filter @markiro/api exec vitest run test/agreement-fields.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the mapper**

`agreement-fields.ts` reads the row's JSONB columns, coerces each requisite key with `?? null`, and returns `TenantAgreementFields`. It is pure: no database, no storage, no Nest.

- [ ] **Step 4: Write the documents service**

```ts
const RENDERER_VERSION = "agreement-docx-v1";
const DOCX_MEDIA_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

@Injectable()
export class AgreementDocumentsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly storage: ObjectStorageService,
  ) {}

  async renderDraft(principal: PlatformPrincipal, id: string) {
    const agreement = await this.requireAgreement(id);
    const bytes = await this.render(agreement, "ПРОЕКТ ДОГОВОРА");
    // One stable key per agreement: re-rendering a preview overwrites it
    // instead of accumulating objects for every click.
    const objectKey = `agreements/${agreement.id}/draft.docx`;
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    await this.storage.putVerified(objectKey, bytes, DOCX_MEDIA_TYPE, sha256);
    return this.upsertDocumentRow({
      agreementId: agreement.id,
      kind: "draft",
      filename: `${agreement.number}-проект.docx`,
      mediaType: DOCX_MEDIA_TYPE,
      objectKey,
      sha256,
      byteSize: bytes.byteLength,
      rendererVersion: RENDERER_VERSION,
    });
  }

  private async render(agreement: AgreementRow, classLabel: string): Promise<Buffer> {
    const content = buildTenantAgreement(toAgreementFields(agreement), "ru");
    const bytes = await renderLegalDocxDraft({
      code: "MKR-AGR-01",
      revision: "2026.09/01",
      effectiveDate: "2026-09-10",
      locale: "ru",
      verificationUrl: "https://markiro.app/legal/",
      classLabel,
      operatorProfileId: "operator-2026-08-15",
      content,
    });
    return Buffer.from(bytes);
  }
}
```

`renderSigned` runs inside the signing transaction from Task 5, renders with the label `"ДОГОВОР"`, writes to the content-addressed key `agreements/${id}/signed-${sha256}.docx`, and inserts a `kind: "generated"` row. It never overwrites: the unique constraint on `object_key` makes a second identical render a no-op conflict rather than a silent replacement.

`download` presigns with `presignRead(objectKey, 300, { downloadFilename: document.filename })` and returns `{ url }`.

Wire `transition` in Task 5's service so that moving to `signed` calls `renderSigned` and stores `signedSnapshot` in the same transaction.

- [ ] **Step 5: Write the e2e test**

Create `apps/api/test/platform-agreements-documents.e2e-spec.ts`:

```
- renders a draft and returns a document row with a 64-hex sha256 and a positive byteSize
- rendering twice keeps exactly one draft row for the agreement
- signing produces a generated row whose sha256 differs from the draft
- the generated DOCX contains the agreement number in its document.xml
- download returns a presigned URL and never the object key
- a support principal is refused the render with 403
```

For the fourth case, unzip the stored buffer with `fflate` and assert `word/document.xml` contains the number — that is the only assertion that proves the fields actually reached the file rather than the template being rendered blank.

- [ ] **Step 6: Run the suites**

Run: `CI=true pnpm --filter @markiro/api exec vitest run test/agreement-fields.test.ts`
Expected: PASS.

Run: `set -a; source .env; set +a; CI=true pnpm --filter @markiro/api exec vitest run test/platform-agreements-documents.e2e-spec.ts`
Expected: PASS, six cases.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/platform-agreements apps/api/test apps/api/package.json
git commit -m "feat(api): render and store the filled agreement DOCX"
```

---

### Task 8: Attachments

**Files:**
- Modify: `apps/api/src/modules/platform-agreements/agreement-documents.service.ts`
- Modify: `apps/api/src/modules/platform-agreements/platform-agreements.controller.ts`
- Test: `apps/api/test/platform-agreements-attachments.e2e-spec.ts`

**Interfaces:**
- Produces: `uploadAttachment(principal, id, file)`, `deleteAttachment(principal, id, documentId)`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/platform-agreements-attachments.e2e-spec.ts`:

```
- accepts a PDF and stores it with a server-computed sha256
- rejects an executable renamed to .pdf with 400, checking magic bytes and not the extension
- rejects a 21 MB upload with 413
- never puts the client filename into the object key
- deletes an attachment and removes the object
- refuses upload for a support principal with 403
- refuses deletion of a generated document with 400
```

The fourth case asserts the stored `object_key` matches `^agreements/[0-9a-f-]{36}/attachments/[0-9a-f-]{36}$` — a client-supplied name must never reach the bucket path.

- [ ] **Step 2: Run it to verify it fails**

Run: `set -a; source .env; set +a; CI=true pnpm --filter @markiro/api exec vitest run test/platform-agreements-attachments.e2e-spec.ts`
Expected: FAIL — the route does not exist.

- [ ] **Step 3: Implement the upload**

```ts
const ATTACHMENT_MEDIA_TYPES = new Map<string, readonly number[]>([
  ["application/pdf", [0x25, 0x50, 0x44, 0x46]],
  [
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    [0x50, 0x4b, 0x03, 0x04],
  ],
  ["image/png", [0x89, 0x50, 0x4e, 0x47]],
  ["image/jpeg", [0xff, 0xd8, 0xff]],
]);
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

function assertAllowedAttachment(mediaType: string, body: Buffer): void {
  const signature = ATTACHMENT_MEDIA_TYPES.get(mediaType);
  if (!signature) throw new BadRequestException("Unsupported attachment type");
  if (body.byteLength === 0) throw new BadRequestException("Empty attachment");
  if (body.byteLength > MAX_ATTACHMENT_BYTES) throw new PayloadTooLargeException("Attachment too large");
  const matches = signature.every((byte, index) => body[index] === byte);
  if (!matches) throw new BadRequestException("Attachment content does not match its declared type");
}
```

The object key is `agreements/${agreementId}/attachments/${randomUUID()}`; the client filename is stored only in the `filename` column and reappears solely through `presignRead`'s `downloadFilename`.

Deletion removes the object first with `deleteConfirmed`, then the row, and refuses any `kind` other than `attachment`.

- [ ] **Step 4: Run the test**

Run: `set -a; source .env; set +a; CI=true pnpm --filter @markiro/api exec vitest run test/platform-agreements-attachments.e2e-spec.ts`
Expected: PASS, seven cases.

- [ ] **Step 5: Run the whole API package gate**

Run: `set -a; source .env; set +a; CI=true pnpm --filter @markiro/api run test`
Expected: PASS. Report any skipped suites and why.

Run: `CI=true pnpm --filter @markiro/api run typecheck && CI=true pnpm --filter @markiro/api run lint`
Expected: both silent.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/platform-agreements apps/api/test
git commit -m "feat(api): accept signed-copy attachments on agreements"
```

---

### Task 9: saas-admin — API client, list page and navigation

**Files:**
- Create: `apps/saas-admin/src/pages/agreements/api.ts`
- Create: `apps/saas-admin/src/pages/agreements/AgreementsPage.tsx`
- Modify: `apps/saas-admin/src/app.tsx`
- Modify: `apps/saas-admin/src/layout/AppShell.tsx:52-66`
- Modify: `apps/saas-admin/src/i18n/ru.json`, `apps/saas-admin/src/i18n/en.json`
- Test: `apps/saas-admin/src/pages/agreements/AgreementsPage.test.tsx`

**Interfaces:**
- Consumes: `platformApiFetch` from `../../api/client.js`; `platformAgreementContracts` (Task 4).
- Produces: `listAgreements`, `getAgreement`, `createAgreement`, `updateAgreement`, `transitionAgreement`, `linkAgreementTenant`, `unlinkAgreementTenant`, `agreementTenantCandidates`, `renderAgreementDraft`, `downloadAgreementDocument`, `uploadAgreementAttachment`, `deleteAgreementAttachment`. Tasks 10 and 11 import all of these.

- [ ] **Step 1: Write the failing test**

Create `apps/saas-admin/src/pages/agreements/AgreementsPage.test.tsx`:

```tsx
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AgreementsPage } from "./AgreementsPage.js";

vi.mock("./api.js", () => ({
  listAgreements: vi.fn().mockResolvedValue({
    agreements: [
      {
        id: "11111111-1111-4111-8111-111111111111",
        number: "МКР-2026-0001",
        status: "sent",
        counterpartyName: "ООО «Пример»",
        counterpartyInn: "7701234567",
        conclusionDate: "2026-09-11",
        tenantId: null,
        signedAt: null,
        createdAt: "2026-09-11T00:00:00.000Z",
      },
    ],
  }),
}));

describe("AgreementsPage", () => {
  it("shows the number, counterparty and a marker for an unlinked tenant", async () => {
    render(<AgreementsPage />);
    await waitFor(() => expect(screen.getByText("МКР-2026-0001")).toBeInTheDocument());
    expect(screen.getByText("ООО «Пример»")).toBeInTheDocument();
    expect(screen.getByText("7701234567")).toBeInTheDocument();
    expect(screen.getByText("Тенант не привязан")).toBeInTheDocument();
  });
});
```

Match the render helper and provider wrapper used by `apps/saas-admin/src/pages/offers/OffersPage.test.tsx`; if that file wraps the component in a query client, do the same here rather than rendering bare.

- [ ] **Step 2: Run it to verify it fails**

Run: `CI=true pnpm --filter @markiro/saas-admin exec vitest run src/pages/agreements/AgreementsPage.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the API client**

`api.ts` mirrors `pages/offers/api.ts` one function at a time: parse the input with the same schema the controller validates with, then call `platformApiFetch` with the matching `responseSchema`.

```ts
export function listAgreements(query: AgreementListQuery = {}) {
  const validated = platformAgreementContracts.list.query.parse(query);
  const search = new URLSearchParams(
    Object.entries(validated).map(([key, value]) => [key, String(value)]),
  ).toString();
  return platformApiFetch(`/agreements${search ? `?${search}` : ""}`, {
    responseSchema: platformAgreementContracts.list.response,
  });
}
```

`uploadAgreementAttachment` posts `FormData` and therefore must not set `Content-Type` by hand — check how `platformApiFetch` builds headers before writing it, and extend the helper rather than bypassing it.

- [ ] **Step 4: Write the list page**

Columns: номер, контрагент, ИНН, статус, дата заключения, тенант, дата подписания. Filters: a status select and a «Без тенанта» toggle, both driving the `list` query. Status labels come from i18n, never from the raw enum, and the status is communicated with both a label and a shape or icon — colour alone is not enough.

- [ ] **Step 5: Register the route and the nav item**

In `app.tsx` add the lazy imports beside the offers ones and the routes `/agreements`, `/agreements/new`, `/agreements/:id`.

In `AppShell.tsx` the commerce group becomes:

```tsx
        ...(hasCapability("catalog.read")
          ? [item("catalog", t("shell.catalog"), "/catalog", "03")]
          : []),
        ...(hasCapability("agreements.read")
          ? [item("agreements", t("shell.agreements"), "/agreements", "04")]
          : []),
        ...(hasCapability("billing.read")
          ? [
              item("offers", t("shell.offers"), "/offers", "05"),
              item("invoices", t("shell.invoices"), "/invoices", "06"),
              item("acts", t("shell.acts"), "/billing-acts", "07"),
              item("payments", t("shell.payments"), "/payments", "08"),
              item("billing-requests", t("shell.billingRequests"), "/billing-requests", "09"),
            ]
          : []),
```

and the platform group shifts to `10`–`13`, settings to `14`. The ordinals are cosmetic, but they must stay contiguous or the rail reads as if items are missing.

- [ ] **Step 6: Add the i18n keys**

Add `shell.agreements` (`"Договоры"` / `"Agreements"`) plus an `agreements.*` block covering the column headings, the five status labels, the filter labels and `agreements.list.noTenant` (`"Тенант не привязан"` / `"No tenant linked"`). Both files get the same key set — a key present in only one locale is a silent fallback at runtime.

- [ ] **Step 7: Run the tests**

Run: `CI=true pnpm --filter @markiro/saas-admin exec vitest run src/pages/agreements`
Expected: PASS.

Run: `CI=true pnpm --filter @markiro/saas-admin run typecheck`
Expected: silent.

- [ ] **Step 8: Commit**

```bash
git add apps/saas-admin/src
git commit -m "feat(saas-admin): add the agreements list and navigation entry"
```

---

### Task 10: saas-admin — create page with DaData

**Files:**
- Create: `apps/saas-admin/src/pages/agreements/AgreementRequisitesForm.tsx`
- Create: `apps/saas-admin/src/pages/agreements/CreateAgreementPage.tsx`
- Test: `apps/saas-admin/src/pages/agreements/AgreementRequisitesForm.test.tsx`

**Interfaces:**
- Consumes: `OrganizationSuggestField`, `AddressSuggestField`, `BankSuggestField` from `../legal/`; `createAgreement` (Task 9).
- Produces: `AgreementRequisitesForm` with props `{ value: AgreementRequisitesInput; onChange(next: AgreementRequisitesInput): void; disabled?: boolean }`. Task 11 renders the same component read-only.

- [ ] **Step 1: Write the failing test**

Create `apps/saas-admin/src/pages/agreements/AgreementRequisitesForm.test.tsx`:

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AgreementRequisitesForm } from "./AgreementRequisitesForm.js";

const EMPTY = {
  kind: "legal_entity",
  name: "",
  inn: "",
  kpp: "",
  ogrn: "",
  address: null,
  email: null,
  phone: null,
  bankName: null,
  bic: null,
  settlementAccount: null,
  correspondentAccount: null,
} as const;

describe("AgreementRequisitesForm", () => {
  it("keeps a manual edit after a suggestion filled the same field", () => {
    const onChange = vi.fn();
    render(<AgreementRequisitesForm value={{ ...EMPTY, name: "ООО «Из DaData»" }} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("Наименование"), {
      target: { value: "ООО «Правленое вручную»" },
    });
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ name: "ООО «Правленое вручную»" }),
    );
  });

  it("hides КПП and ОГРН for a sole proprietor and shows ОГРНИП instead", () => {
    render(
      <AgreementRequisitesForm
        value={{ ...EMPTY, kind: "sole_proprietor", inn: "770123456789", ogrnip: "312770000000001" } as never}
        onChange={vi.fn()}
      />,
    );
    expect(screen.queryByLabelText("КПП")).not.toBeInTheDocument();
    expect(screen.getByLabelText("ОГРНИП")).toBeInTheDocument();
  });

  it("disables every control when disabled is set", () => {
    render(<AgreementRequisitesForm value={EMPTY} onChange={vi.fn()} disabled />);
    expect(screen.getByLabelText("Наименование")).toBeDisabled();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `CI=true pnpm --filter @markiro/saas-admin exec vitest run src/pages/agreements/AgreementRequisitesForm.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the requisites form**

The component renders the four `kind` variants against the discriminated union from Task 4. Read `apps/saas-admin/src/pages/legal/LegalProfileForm.tsx` first and follow the same field ordering, labels and validation messages — this is a second surface over the same domain, and two different phrasings for the same ИНН error is a defect.

Selecting a DaData organisation suggestion fills `name`, `inn`, `kpp`, `ogrn` and `address`; every field remains a normal editable input afterwards, so a later manual edit simply wins. Bank selection fills `bankName`, `bic` and `correspondentAccount`.

- [ ] **Step 4: Write the create page**

Three grouped sections in one form: контрагент (the requisites form), подписант, and условия (суд, ставка и предел неустойки), then номер, дата и город as optional overrides. Submitting calls `createAgreement` and navigates to `/agreements/:id`.

Leave the number field empty by default with placeholder text saying it will be allocated automatically — an operator who types over it must be doing it deliberately.

- [ ] **Step 5: Run the tests**

Run: `CI=true pnpm --filter @markiro/saas-admin exec vitest run src/pages/agreements`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/saas-admin/src/pages/agreements
git commit -m "feat(saas-admin): create agreements with DaData requisites"
```

---

### Task 11: saas-admin — detail page, transitions, documents

**Files:**
- Create: `apps/saas-admin/src/pages/agreements/AgreementDetailPage.tsx`
- Create: `apps/saas-admin/src/pages/agreements/AgreementDocumentsPanel.tsx`
- Test: `apps/saas-admin/src/pages/agreements/AgreementDetailPage.test.tsx`

**Interfaces:**
- Consumes: everything produced by Tasks 9 and 10.

- [ ] **Step 1: Write the failing test**

Create `apps/saas-admin/src/pages/agreements/AgreementDetailPage.test.tsx` covering:

```
- renders the requisites form disabled when editable is false
- offers only the transitions the current status allows
- asks for a termination reason before allowing the terminated transition
- shows tenant candidates and links the chosen one
- lists documents with their size and offers a download
- rejects an attachment whose type is outside the allowlist before any request is sent
```

The second case is the one that keeps the client honest: the server already refuses an illegal transition, and the UI must not offer it in the first place. Import the same `isTransitionAllowed`-shaped table rather than hard-coding the list twice — export the allowed map from the contracts package if that is the cleanest way to share it.

- [ ] **Step 2: Run it to verify it fails**

Run: `CI=true pnpm --filter @markiro/saas-admin exec vitest run src/pages/agreements/AgreementDetailPage.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the detail page and documents panel**

The page shows the header fields, the requisites form (disabled when `editable` is false), the signatory and terms, the tenant link block with candidates, and the documents panel.

The documents panel lists rows with kind, filename, size and creation time; offers «Сформировать проект» (calls `renderAgreementDraft`), a download action per row, an upload control, and deletion only for `attachment` rows.

Client-side type checking on upload is a courtesy that saves a round trip, not a control — the server check from Task 8 is the real one, and both must exist.

- [ ] **Step 4: Run the full saas-admin gate**

Run: `CI=true pnpm --filter @markiro/saas-admin run test && CI=true pnpm --filter @markiro/saas-admin run typecheck && CI=true pnpm --filter @markiro/saas-admin run lint && CI=true pnpm --filter @markiro/saas-admin run build`
Expected: PASS, then three silent commands.

- [ ] **Step 5: Verify in the browser**

Start the preview with the saas-admin entry from `.claude/launch.json` (add one if it is missing, following the existing entries), then walk the flow: create an agreement with a real ИНН through DaData, generate the draft, download it, open it and confirm the requisites table shows the entered values rather than placeholders. Screenshot the detail page.

Automated DOM tests are not browser confirmation; state both results separately.

- [ ] **Step 6: Commit**

```bash
git add apps/saas-admin/src/pages/agreements
git commit -m "feat(saas-admin): agreement detail, transitions and documents"
```

---

### Task 12: CI wiring, docs and final gates

**Files:**
- Modify: `tools/ci/affected.mjs`
- Modify: `.github/workflows/ci.yml` if the new paths do not already map to the api and saas-admin jobs
- Modify: `README.md` and `README.ru.md` if they enumerate saas-admin sections
- Modify: `docs/architecture.md` if it lists platform capabilities

**Interfaces:** none — this task only wires and verifies.

- [ ] **Step 1: Check the affected-job mapping**

Read `tools/ci/affected.mjs` and confirm that `apps/api/src/modules/platform-agreements/**`, `apps/saas-admin/src/pages/agreements/**`, `packages/db/src/schema/agreements.ts` and `packages/platform-contracts/src/agreements.ts` all resolve to jobs that actually run. A path that maps to nothing means the surface ships unverified.

- [ ] **Step 2: Confirm the OpenAPI document covers the new routes**

Run the API's OpenAPI coverage gate — the repo has one, find it with `grep -rn "openapi" apps/api/package.json`. Every new handler carries `@PlatformApiProtectedOk`/`Created`, so coverage should pass; if it fails, the missing decorator is the bug, not the gate.

- [ ] **Step 3: Update the docs that enumerate surfaces**

Run: `grep -rn "Предложения\|billing-acts" README.ru.md docs/architecture.md`
Add «Договоры» wherever the platform sections are enumerated, and add the two new capabilities wherever capabilities are listed.

- [ ] **Step 4: Run the broad gate**

Run: `set -a; source .env; set +a; CI=true pnpm turbo lint typecheck test build --concurrency=1`
Expected: PASS across every package. Record any skipped database-backed suites explicitly.

Run: `CI=true pnpm format:check`
Expected: `All matched files use Prettier code style!`

Run: `CI=true pnpm test:production-bundle:contract`
Expected: PASS. This proves the legal-artifact attestation is untouched — it must be, because MKR-AGR-01 is never published.

Run: `git diff --check`
Expected: no output.

- [ ] **Step 5: Verify the published artifacts one more time**

Run: `CI=true pnpm --filter @markiro/legal-documents exec vitest run test/docx.test.ts -t "published artifacts"`
Expected: PASS, four cases. `docx` moved to runtime dependencies in Task 1 and the template became a function; this is the check that neither changed a published byte.

- [ ] **Step 6: Commit**

```bash
git add tools/ci .github README.md README.ru.md docs/architecture.md
git commit -m "chore: wire agreements into CI and the surface docs"
```

---

## Final report contents

The completion report must list, separately:

- behaviour changed and the files or areas touched;
- automated checks run and their results, naming any suite that skipped and why;
- the browser walkthrough from Task 11 Step 5, reported as manual verification and not merged into the automated results;
- anything not run, with the reason.

State plainly that no PDF is produced, that MKR-AGR-01 remains unpublished, and that the English translation is a separate spec.
