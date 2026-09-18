# Chestny ZNAK KM Orders — Cloud, API and Admin Implementation Plan (phase 1, part A)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Order marking codes from СУЗ (OMS API 3.0) from the admin cabinet, keep the fetched codes as an encrypted per-tenant pool, and issue them as TXT/CSV files or as a browser print page for a label printer.

**Architecture:** A new `chz-km-orders` API module (fetch-injected СУЗ client, pg-boss state-machine runner, issue endpoints) sits next to `chz-exports` and reuses its durable-claim pattern. Signing and СУЗ authentication are signer-agent tasks (`sign_detached`, `oms_auth`) that the cloud enqueues and the Windows agent fulfils (part B plan). The admin gets a regrouped sidebar, a «Заказы кодов» section and a shell-less print page that renders the `product_km` label template with the existing canvas renderer.

**Tech Stack:** NestJS + Drizzle/Postgres + pg-boss (API), Zod contracts (`@markiro/platform-contracts`), React/Vite + TanStack Query + react-i18next (admin), Vitest, `@markiro/domain` for pure rules.

**Spec:** `docs/superpowers/specs/2026-09-18-chz-km-orders-design.md`. **Companion plan:** `docs/superpowers/plans/2026-09-19-chz-km-orders-signer.md` (Rust agent). Part B must ship before the sandbox run, but every task here is testable without it (tests complete signer tasks by writing the task row).

## Global Constraints

- TypeScript strict with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`; no `any`, no non-null assertions to hide uncertainty (repo AGENTS.md).
- Every tenant query is tenant-scoped; every new cabinet route declares `@RequirePermissions` and a subscription policy and is added to `apps/api/test/subscription-route-inventory.test.ts` (apps/api/AGENTS.md).
- Raw marking codes are stored only encrypted (AES-256-GCM via `ChzCryptoService`, key `CHZ_TOKEN_ENCRYPTION_KEY`) and never appear in logs, the integration journal, pg-boss payloads or error messages (spec «Security and audit»).
- Codes in СУЗ JSON carry the GS separator as the escape `\u001d`; parse responses with `JSON.parse`, never as text (spec «СУЗ facts»).
- СУЗ hosts: production `https://suzgrid.crpt.ru`, sandbox `https://suz.sandbox.crptech.ru`, methods under `/api/v3/`; ≤ 150 000 codes per `GET /codes` call; `X-Signature` is a detached CMS signature over the exact request body bytes.
- One order = one GTIN; quantity 1..150 000; issues are contiguous by `seq` and never return to the pool.
- Migrations: add a new file, never rewrite an applied one; run `pnpm --filter @markiro/db build` before API tests.
- Admin copy goes through `apps/admin/src/i18n/ru.json` and `en.json`; UI uses `@markiro/ui` components and tokens only.
- Commit after every task; stage explicit paths.

## Deviations from the spec (decided while planning, flag to the owner in the PR)

1. The stock «Этикетка КМ» prints the serial through the existing `km.code` field with `textFormat: "km_without_crypto"` and the GTIN through `product.gtin`; no new `km.gtin`/`km.serial` label fields are added (they would touch the label model, ZPL/TSPL emitters and the Station).
2. The print dialog lets the admin pick any enabled `product_km` template eligible for the product's category, with the stock one preselected. Organisation/category default tables for this purpose are a follow-up, not part of this plan.
3. Migration index: this plan uses `0165_chz_km_orders`. Open PR #605 also claims 0165; whichever merges second renumbers (file name, journal `idx`/`tag`) before merge.

## File structure

**Domain (`packages/domain`)**

- `src/chz/km-orders.ts` — template-id map, order body builder, TXT/CSV serialisers, file name.
- `src/labels/km-defaults.ts` — `KM_LABEL_TEMPLATE_NAME`, `buildKmLabelTemplates()`, `assertKmTemplate()`.
- `src/product-labels/contracts.ts` — `LabelTemplatePurpose` gains `"product_km"`.
- `src/index.ts` — exports.

**DB (`packages/db`)**

- `src/schema/chz.ts` — task types, `chzOmsTokens`, `chzKmOrderStateEnum`, `chzKmOrders`, `chzKmCodes`, `chzKmIssues`.
- `src/schema/labels.ts` — purpose CHECK gains `product_km`.
- `migrations/0165_chz_km_orders.sql` (+ journal/snapshot) — tables, enum, CHECK, stock KM template seed.
- `test/chz-km-orders.test.ts` — schema + migration runtime test.

**Contracts (`packages/platform-contracts`)**

- `src/chz-signer.ts` — task union, `oms_auth` and `sign_detached` payloads, signature completion body.
- `fixtures/chz-signer/task-oms-auth.json`, `task-sign-detached.json`, `task-complete-signature.json`.

**API (`apps/api`)**

- `src/modules/integrations/channel-registry.ts` — `omsId`, `omsConnection`, `omsContactPerson`.
- `src/modules/signer-agents/chz-constants.ts` — `CHZ_OMS_BASE_URLS`, `CHZ_OMS_TOKEN_TTL_MS`, `buildChzOmsAuthPayload`.
- `src/modules/signer-agents/chz-crypto.service.ts` — `encryptWithAad`/`decryptWithAad`.
- `src/modules/signer-agents/signer-tasks.service.ts` — claim/complete per task type.
- `src/modules/signer-agents/signer-scheduler.service.ts` — `oms_auth` refresh.
- `src/modules/signer-agents/signer-agents.service.ts`, `dto.ts` — `omsToken` in the overview.
- `src/modules/chz-km-orders/oms.types.ts`, `oms.client.ts` — СУЗ client.
- `src/modules/chz-km-orders/chz-oms-token.service.ts` — decrypt-on-demand СУЗ token.
- `src/modules/chz-km-orders/dto.ts` — request/response schemas and OpenAPI objects.
- `src/modules/chz-km-orders/chz-km-orders.service.ts` — preflight, create, list, get, retry, issue, file, codes.
- `src/modules/chz-km-orders/chz-km-order-runner.service.ts` — state machine.
- `src/modules/chz-km-orders/chz-km-orders.controller.ts`, `chz-km-orders.module.ts`.
- `src/jobs/jobs.module.ts` — `run-chz-km-order` queue, worker chain, boot reconciliation.
- `src/modules/label-templates/dto.ts`, `label-templates.service.ts` — `product_km`.
- `src/modules/platform-tenants/tenant-provisioning.service.ts` — seed the stock KM template.
- `src/app.module.ts` — register `ChzKmOrdersModule`.

**Admin (`apps/admin`)**

- `src/layout/AppShell.tsx` — regrouped `NAV_ITEMS`.
- `src/pages/km-orders/api.ts`, `schemas.ts`, `index.tsx`, `KmOrderPage.tsx`, `CreateKmOrderDialog.tsx`, `IssueKmCodesDialog.tsx`, `KmOrderPrintPage.tsx`, `km-orders.css`.
- `src/app.tsx` — routes `/km-orders`, `/km-orders/:orderId`, `/km-orders/:orderId/issues/:issueId/print`.
- `src/pages/labels/preview-data.ts`, `src/pages/labels/editor/index.tsx`, `src/pages/labels/index.tsx` — `product_km` purpose.
- `src/pages/integrations/ChannelPage.tsx`, `SignerAgentsPanel.tsx`, `api.ts` — СУЗ settings and token status.
- `src/i18n/ru.json`, `en.json`.

---

### Task 1: Domain — СУЗ order body, template map and code-file serialisers

**Files:**

- Create: `packages/domain/src/chz/km-orders.ts`
- Modify: `packages/domain/src/index.ts`
- Test: `packages/domain/test/chz-km-orders.test.ts`

**Interfaces:**

- Produces: `CHZ_UNIT_TEMPLATE_ID_BY_GROUP: Readonly<Record<string, number>>`, `chzUnitTemplateIdFor(alias: string): number | null`, `buildChzKmOrderBody(input: ChzKmOrderBodyInput): string`, `serializeKmCodesTxt(codes: readonly string[]): Uint8Array`, `serializeKmCodesCsv(codes: readonly string[]): Uint8Array`, `kmOrderIssueFileName(gtin14: string, fromSeq: number, toSeq: number, format: "txt" | "csv"): string`, type `ChzKmOrderBodyInput`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/domain/test/chz-km-orders.test.ts
import { describe, expect, it } from "vitest";
import {
  buildChzKmOrderBody,
  chzUnitTemplateIdFor,
  kmOrderIssueFileName,
  serializeKmCodesCsv,
  serializeKmCodesTxt,
} from "../src/index.js";

const GS = "\u001d";

describe("chzUnitTemplateIdFor", () => {
  it("maps beer to template 18 and refuses groups with several UNIT templates", () => {
    expect(chzUnitTemplateIdFor("beer")).toBe(18);
    expect(chzUnitTemplateIdFor("nabeer")).toBe(28);
    expect(chzUnitTemplateIdFor("otp")).toBeNull();
    expect(chzUnitTemplateIdFor("unknown")).toBeNull();
  });
});

describe("buildChzKmOrderBody", () => {
  it("is byte-stable and follows the documented key order", () => {
    const body = buildChzKmOrderBody({
      productGroupAlias: "beer",
      gtin14: "04607034690014",
      quantity: 5000,
      templateId: 18,
      contactPerson: "Ковалёва М. А.",
      productionOrderId: "7f2c1a1e-0000-4000-8000-000000000001",
    });
    expect(body).toBe(
      '{"productGroup":"beer","products":[{"gtin":"04607034690014","quantity":5000,' +
        '"serialNumberType":"OPERATOR","templateId":18,"cisType":"UNIT"}],' +
        '"attributes":{"releaseMethodType":"PRODUCTION","contactPerson":"Ковалёва М. А.",' +
        '"productionOrderId":"7f2c1a1e-0000-4000-8000-000000000001"}}',
    );
  });
  it("omits contactPerson when absent", () => {
    const body = buildChzKmOrderBody({
      productGroupAlias: "beer",
      gtin14: "04607034690014",
      quantity: 1,
      templateId: 18,
      productionOrderId: "7f2c1a1e-0000-4000-8000-000000000001",
    });
    expect(JSON.parse(body).attributes).toEqual({
      releaseMethodType: "PRODUCTION",
      productionOrderId: "7f2c1a1e-0000-4000-8000-000000000001",
    });
  });
});

describe("code file serialisers", () => {
  const codes = [`010460703469001421AbC1234${GS}93dGVz`, `010460703469001421XyZ9876${GS}93AAAA`];
  it("writes TXT as one raw code per LF line with the raw GS byte and no BOM", () => {
    const bytes = serializeKmCodesTxt(codes);
    expect(bytes[0]).toBe(0x30);
    const text = Buffer.from(bytes).toString("utf8");
    expect(text).toBe(`${codes[0]}\n${codes[1]}\n`);
    expect(text.includes("\u001d")).toBe(true);
  });
  it("writes CSV with a code header and quoted values", () => {
    const text = Buffer.from(serializeKmCodesCsv([`a"b${GS}c`])).toString("utf8");
    expect(text).toBe(`code\n"a""b${GS}c"\n`);
  });
  it("names the file after the GTIN and the range", () => {
    expect(kmOrderIssueFileName("04607034690014", 1201, 1500, "txt")).toBe(
      "km-04607034690014-1201-1500.txt",
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @markiro/domain exec vitest run test/chz-km-orders.test.ts`
Expected: FAIL — `buildChzKmOrderBody` is not exported from `../src/index.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/domain/src/chz/km-orders.ts
/**
 * Chestny ZNAK order-management station (СУЗ, OMS API 3.0) rules that are
 * independent of transport: which KM template a product group emits for
 * `cisType: UNIT`, the exact bytes of an order body, and the files an issue
 * is exported as. The API signs and sends the body produced here verbatim.
 */

/**
 * `templateId` for `cisType: "UNIT"` per СУЗ table 270, keyed by the
 * `chz_product_groups.alias` the True API uses. Only groups with exactly one
 * UNIT template are listed; a group with two (for example `otp` 14/15) needs
 * a per-product choice this phase does not offer, so it is deliberately absent.
 */
export const CHZ_UNIT_TEMPLATE_ID_BY_GROUP: Readonly<Record<string, number>> = {
  beer: 18,
  nabeer: 28,
  water: 16,
  milk: 20,
  tobacco: 4,
  ncp: 22,
  lp: 10,
  shoes: 1,
  perfumery: 9,
  tires: 7,
  electronics: 8,
  bicycle: 11,
  wheelchairs: 12,
  softdrinks: 29,
  vetpharma: 50,
};

export function chzUnitTemplateIdFor(productGroupAlias: string): number | null {
  return Object.hasOwn(CHZ_UNIT_TEMPLATE_ID_BY_GROUP, productGroupAlias)
    ? (CHZ_UNIT_TEMPLATE_ID_BY_GROUP[productGroupAlias] ?? null)
    : null;
}

export interface ChzKmOrderBodyInput {
  productGroupAlias: string;
  gtin14: string;
  quantity: number;
  templateId: number;
  contactPerson?: string | undefined;
  /** Our own order id; СУЗ echoes it back as `productionOrderId`. */
  productionOrderId: string;
}

/**
 * The bytes that get signed AND sent. Key order is fixed by construction
 * (object literal order), so the same input always yields the same string;
 * the runner persists this string and never re-serialises it.
 */
export function buildChzKmOrderBody(input: ChzKmOrderBodyInput): string {
  const attributes: Record<string, string> = { releaseMethodType: "PRODUCTION" };
  if (input.contactPerson !== undefined && input.contactPerson.length > 0) {
    attributes.contactPerson = input.contactPerson;
  }
  attributes.productionOrderId = input.productionOrderId;
  return JSON.stringify({
    productGroup: input.productGroupAlias,
    products: [
      {
        gtin: input.gtin14,
        quantity: input.quantity,
        serialNumberType: "OPERATOR",
        templateId: input.templateId,
        cisType: "UNIT",
      },
    ],
    attributes,
  });
}

const encoder = new TextEncoder();

/** One full code per LF-terminated line, raw GS byte, UTF-8 without BOM — the shape of ЧЗ's own files. */
export function serializeKmCodesTxt(codes: readonly string[]): Uint8Array {
  return encoder.encode(codes.map((code) => `${code}\n`).join(""));
}

/** Single `code` column, every value quoted, quotes doubled. */
export function serializeKmCodesCsv(codes: readonly string[]): Uint8Array {
  const lines = codes.map((code) => `"${code.replaceAll('"', '""')}"\n`);
  return encoder.encode(`code\n${lines.join("")}`);
}

export function kmOrderIssueFileName(
  gtin14: string,
  fromSeq: number,
  toSeq: number,
  format: "txt" | "csv",
): string {
  return `km-${gtin14}-${fromSeq}-${toSeq}.${format}`;
}
```

Add to `packages/domain/src/index.ts` (next to the other `chz`/inventory exports):

```ts
export {
  CHZ_UNIT_TEMPLATE_ID_BY_GROUP,
  buildChzKmOrderBody,
  chzUnitTemplateIdFor,
  kmOrderIssueFileName,
  serializeKmCodesCsv,
  serializeKmCodesTxt,
  type ChzKmOrderBodyInput,
} from "./chz/km-orders.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @markiro/domain exec vitest run test/chz-km-orders.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/domain/src/chz/km-orders.ts packages/domain/src/index.ts packages/domain/test/chz-km-orders.test.ts
git commit -m "feat(domain): СУЗ order body, UNIT template map and KM code file serialisers"
```

---

### Task 2: Domain — `product_km` label purpose, validation and stock template

**Files:**

- Modify: `packages/domain/src/product-labels/contracts.ts:17`
- Create: `packages/domain/src/labels/km-defaults.ts`
- Modify: `packages/domain/src/index.ts`
- Test: `packages/domain/test/km-label-template.test.ts`

**Interfaces:**

- Consumes: `assertDuplicateTemplate`, `labelTemplateSpecSchema`, `DomainError`, `DefaultLabelTemplate` (from `labels/defaults.ts`).
- Produces: `LabelTemplatePurpose` union with `"product_km"`; `KM_LABEL_TEMPLATE_NAME = "Этикетка КМ 58×40"`; `buildKmLabelTemplates(): DefaultLabelTemplate[]`; `assertKmTemplate(spec: LabelTemplateSpec): void` throwing `DomainError("KM_LABEL_TEMPLATE_INVALID")`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/domain/test/km-label-template.test.ts
import { describe, expect, it } from "vitest";
import {
  assertKmTemplate,
  buildKmLabelTemplates,
  KM_LABEL_TEMPLATE_NAME,
  labelTemplateSpecSchema,
  type LabelTemplatePurpose,
} from "../src/index.js";

describe("KM label template", () => {
  it("ships one stock 58×40 template with a km.code Data Matrix and a crypto-free serial line", () => {
    const [template] = buildKmLabelTemplates();
    expect(template?.name).toBe(KM_LABEL_TEMPLATE_NAME);
    const spec = labelTemplateSpecSchema.parse(template?.spec);
    expect([spec.widthMm, spec.heightMm]).toEqual([58, 40]);
    const dm = spec.elements.find((e) => e.kind === "barcode");
    expect(dm).toMatchObject({ format: "datamatrix", data: "km.code" });
    expect(
      spec.elements.some(
        (e) => e.kind === "field" && e.field === "km.code" && e.textFormat === "km_without_crypto",
      ),
    ).toBe(true);
    expect(() => assertKmTemplate(spec)).not.toThrow();
  });

  it("refuses a template without a km.code Data Matrix with its own error code", () => {
    const [template] = buildKmLabelTemplates();
    const spec = labelTemplateSpecSchema.parse(template?.spec);
    const broken = { ...spec, elements: spec.elements.filter((e) => e.kind !== "barcode") };
    expect(() => assertKmTemplate(broken)).toThrowError(
      expect.objectContaining({ code: "KM_LABEL_TEMPLATE_INVALID" }),
    );
  });

  it("widens the purpose union", () => {
    const purpose: LabelTemplatePurpose = "product_km";
    expect(purpose).toBe("product_km");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @markiro/domain exec vitest run test/km-label-template.test.ts`
Expected: FAIL — `buildKmLabelTemplates` not exported; TypeScript error on `"product_km"`.

- [ ] **Step 3: Write minimal implementation**

In `packages/domain/src/product-labels/contracts.ts` replace line 17:

```ts
export type LabelTemplatePurpose = "box" | "product_duplicate" | "pallet" | "product_km";
```

Create `packages/domain/src/labels/km-defaults.ts`:

```ts
import { DomainError } from "../errors.js";
import type { DefaultLabelTemplate } from "./defaults.js";
import { assertDuplicateTemplate } from "./duplicate.js";
import type { LabelTemplateSpec } from "./model.js";

/** The stock label for codes ordered from СУЗ and printed in the office (spec 2026-09-18). */
export const KM_LABEL_TEMPLATE_NAME = "Этикетка КМ 58×40";

/**
 * Data Matrix on the left (24 mm, comfortably above the 12-dot floor at
 * 203 dpi), product name and GTIN on the right, and the crypto-free
 * `01…21…` line along the bottom so a person can read which code this is.
 * Resolution-neutral like every stock template since spec 2026-09-10.
 */
export function buildKmLabelTemplates(): DefaultLabelTemplate[] {
  return [
    {
      name: KM_LABEL_TEMPLATE_NAME,
      spec: {
        widthMm: 58,
        heightMm: 40,
        dpi: 203,
        language: "zpl",
        elements: [
          {
            kind: "barcode",
            id: "km",
            xMm: 2,
            yMm: 2,
            format: "datamatrix",
            data: "km.code",
            sizeMm: 24,
          },
          {
            kind: "field",
            id: "name",
            xMm: 28,
            yMm: 3,
            field: "product.printName",
            fontSizePt: 9,
            bold: true,
            maxWidthMm: 28,
            maxLines: 3,
          },
          {
            kind: "text",
            id: "cap-gtin",
            xMm: 28,
            yMm: 19,
            text: "GTIN",
            fontSizePt: 5,
            maxWidthMm: 28,
          },
          {
            kind: "field",
            id: "gtin",
            xMm: 28,
            yMm: 21.5,
            field: "product.gtin",
            fontSizePt: 7,
            maxWidthMm: 28,
          },
          {
            kind: "field",
            id: "serial",
            xMm: 2,
            yMm: 29,
            field: "km.code",
            textFormat: "km_without_crypto",
            fontSizePt: 6,
            maxWidthMm: 54,
            maxLines: 1,
          },
        ],
      },
    },
  ];
}

/** Same geometry rules as a duplicate label, reported under this purpose's own code. */
export function assertKmTemplate(spec: LabelTemplateSpec): void {
  try {
    assertDuplicateTemplate(spec);
  } catch (error) {
    if (error instanceof DomainError) {
      throw new DomainError(
        "KM_LABEL_TEMPLATE_INVALID",
        "KM labels require one in-bounds product Data Matrix and no SSCC",
      );
    }
    throw error;
  }
}
```

If `labelTemplateSpecSchema` rejects any property name above (check `packages/domain/src/labels/model.ts` element schemas for `text`, `field`, `barcode`), rename to the schema's exact keys before proceeding; the test parses the spec, so a mismatch fails loudly.

Add to `packages/domain/src/index.ts`:

```ts
export {
  KM_LABEL_TEMPLATE_NAME,
  assertKmTemplate,
  buildKmLabelTemplates,
} from "./labels/km-defaults.js";
```

- [ ] **Step 4: Run tests, typecheck, build**

Run: `pnpm --filter @markiro/domain exec vitest run test/km-label-template.test.ts && pnpm --filter @markiro/domain typecheck && pnpm --filter @markiro/domain build`
Expected: PASS; typecheck surfaces every `Record<LabelTemplatePurpose, …>` that must now carry `product_km` (admin `preview-data.ts` is fixed in Task 17; domain-internal ones fix here).

- [ ] **Step 5: Commit**

```bash
git add packages/domain/src/product-labels/contracts.ts packages/domain/src/labels/km-defaults.ts packages/domain/src/index.ts packages/domain/test/km-label-template.test.ts
git commit -m "feat(domain): product_km label purpose with a stock 58×40 KM template"
```

---

### Task 3: DB schema and migration 0165

**Files:**

- Modify: `packages/db/src/schema/chz.ts`
- Modify: `packages/db/src/schema/labels.ts:64-67`
- Create: `packages/db/migrations/0165_chz_km_orders.sql` (+ `meta/_journal.json`, `meta/0165_snapshot.json` via drizzle-kit)
- Test: `packages/db/test/chz-km-orders.test.ts`

**Interfaces:**

- Produces: `CHZ_SIGNER_TASK_TYPES = ["true_api_auth", "oms_auth", "sign_detached"]`, tables `chzOmsTokens`, `chzKmOrders`, `chzKmCodes`, `chzKmIssues`, enum `chzKmOrderStateEnum`, constants `CHZ_KM_ORDER_STATES`, `CHZ_KM_CODE_STATUSES`, `CHZ_KM_ISSUE_KINDS`, row types `ChzKmOrderRow`, `ChzKmCodeRow`, `ChzKmIssueRow`, `ChzOmsTokenRow`.

- [ ] **Step 1: Write the failing schema test**

```ts
// packages/db/test/chz-km-orders.test.ts
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "../src/schema.js";
import {
  CHZ_SIGNER_TASK_TYPES,
  chzKmCodes,
  chzKmIssues,
  chzKmOrders,
  chzOmsTokens,
} from "../src/schema/chz.js";
import { copyMigrationsThroughIndex } from "./support/legacy-migrations.js";

describe("chz km orders schema", () => {
  it("declares the three signer task types", () => {
    expect([...CHZ_SIGNER_TASK_TYPES]).toEqual(["true_api_auth", "oms_auth", "sign_detached"]);
  });
  it("carries order, code and issue columns", () => {
    expect(Object.keys(chzKmOrders)).toEqual(
      expect.arrayContaining([
        "tenantId",
        "productId",
        "gtin14",
        "quantity",
        "state",
        "requestBody",
        "omsOrderId",
        "fetchedCount",
        "issuedCount",
        "deadlineAt",
      ]),
    );
    expect(Object.keys(chzKmCodes)).toEqual(
      expect.arrayContaining([
        "tenantId",
        "orderId",
        "seq",
        "encryptedCode",
        "codeNonce",
        "codeTag",
        "codeHash",
        "blockId",
        "status",
        "issueId",
      ]),
    );
    expect(Object.keys(chzKmIssues)).toEqual(
      expect.arrayContaining(["kind", "format", "fromSeq", "toSeq", "count"]),
    );
    expect(Object.keys(chzOmsTokens)).toEqual(
      expect.arrayContaining(["sourceOmsConnection", "expiresAt"]),
    );
  });
});

const databaseUrl = process.env.DATABASE_URL;
const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));

describe.skipIf(!databaseUrl)("chz km orders migration", () => {
  const databaseName = `markiro_chz_km_orders_${randomUUID().replaceAll("-", "_")}`;
  const scratchUrl = new URL(databaseUrl ?? "postgres://invalid");
  scratchUrl.pathname = `/${databaseName}`;
  scratchUrl.search = "";
  const maintenancePool = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({ connectionString: scratchUrl.toString() });
  const db = drizzle(pool, { schema });
  let temporaryRoot = "";
  let created = false;
  const tenantId = `km-${randomUUID()}`;
  const userId = `km-user-${randomUUID()}`;
  const productId = randomUUID();

  beforeAll(async () => {
    await maintenancePool.query(`CREATE DATABASE "${databaseName}"`);
    created = true;
    temporaryRoot = await mkdtemp(join(tmpdir(), "markiro-chz-km-orders-"));
    const legacy = join(temporaryRoot, "migrations");
    await copyMigrationsThroughIndex({
      sourceFolder: migrationsFolder,
      targetFolder: legacy,
      lastIncludedIndex: 164,
    });
    await migrate(drizzle(pool), { migrationsFolder: legacy });
    await pool.query(
      `INSERT INTO organization (id, name, slug, created_at) VALUES ($1, 'KM tenant', $2, now())`,
      [tenantId, tenantId],
    );
    await migrate(drizzle(pool), { migrationsFolder });
    await pool.query(
      `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at) VALUES ($1, 'U', $2, true, now(), now())`,
      [userId, `${userId}@example.com`],
    );
    await pool.query(
      `INSERT INTO products (id, tenant_id, name, gtin14, chz_product_group_code) VALUES ($1, $2, 'Сидр', '04607034690014', 12)`,
      [productId, tenantId],
    );
  }, 120_000);

  afterAll(async () => {
    await pool.end();
    if (created) await maintenancePool.query(`DROP DATABASE "${databaseName}"`);
    await maintenancePool.end();
    if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
  });

  it("seeds the stock KM template for an existing tenant exactly once", async () => {
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM label_templates WHERE tenant_id = $1 AND purpose = 'product_km' AND name = 'Этикетка КМ 58×40'`,
      [tenantId],
    );
    expect(rows[0]).toEqual({ n: 1 });
  });

  it("accepts a created order and refuses issued > fetched", async () => {
    const [order] = await db
      .insert(chzKmOrders)
      .values({
        tenantId,
        productId,
        gtin14: "04607034690014",
        productGroupAlias: "beer",
        productGroupCode: 12,
        templateId: 18,
        quantity: 10,
        requestBody: "{}",
        createdByUserId: userId,
        deadlineAt: new Date(Date.now() + 48 * 3600_000),
      })
      .returning({ id: chzKmOrders.id, state: chzKmOrders.state });
    expect(order?.state).toBe("created");
    await expect(
      db.update(chzKmOrders).set({ issuedCount: 1 }).where(schema.eq(chzKmOrders.id, order!.id)),
    ).rejects.toThrow(/chz_km_orders_counts_check/);
  });

  it("refuses a completed order whose fetched count is short", async () => {
    await expect(
      db.insert(chzKmOrders).values({
        tenantId,
        productId,
        gtin14: "04607034690014",
        productGroupAlias: "beer",
        productGroupCode: 12,
        templateId: 18,
        quantity: 10,
        requestBody: "{}",
        createdByUserId: userId,
        state: "completed",
        omsOrderId: randomUUID(),
        fetchedCount: 9,
        deadlineAt: new Date(),
      }),
    ).rejects.toThrow(/chz_km_orders_state_consistency_check/);
  });
});
```

(`schema.eq` is not exported from the schema barrel: import `eq` from `drizzle-orm` instead and use `eq(chzKmOrders.id, …)`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `set -a; source .env; set +a; pnpm --filter @markiro/db exec vitest run test/chz-km-orders.test.ts`
Expected: FAIL — `chzKmOrders` is not exported.

- [ ] **Step 3: Write the schema**

Append to `packages/db/src/schema/chz.ts` (and extend the import from `./platform.js` with `products`; the `products` table already carries `unique(tenant_id, id)` — verify with `grep -n "products_tenant_id_uq\|unique(\"products" packages/db/src/schema/platform.ts`; if absent, add `unique("products_tenant_id_uq").on(t.tenantId, t.id)` there and let the migration create it):

```ts
export const CHZ_SIGNER_TASK_TYPES = ["true_api_auth", "oms_auth", "sign_detached"] as const;
```

(replace the existing one-element array), then:

```ts
/** One СУЗ client token per tenant; same encryption shape as `chz_api_tokens`. */
export const chzOmsTokens = pgTable(
  "chz_oms_tokens",
  {
    tenantId: text("tenant_id")
      .primaryKey()
      .references(() => organization.id),
    encryptedToken: bytea("encrypted_token").notNull(),
    tokenNonce: bytea("token_nonce").notNull(),
    tokenTag: bytea("token_tag").notNull(),
    sourceOmsConnection: text("source_oms_connection").notNull(),
    sourceTrueApiBaseUrl: text("source_true_api_base_url").notNull(),
    obtainedAt: timestamp("obtained_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    agentId: uuid("agent_id"),
    certThumbprint: text("cert_thumbprint"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "chz_oms_tokens_tenant_agent_fk",
      columns: [t.tenantId, t.agentId],
      foreignColumns: [chzSignerAgents.tenantId, chzSignerAgents.id],
    }),
  ],
);

export const CHZ_KM_ORDER_STATES = [
  "created",
  "signing",
  "submitted",
  "buffer_pending",
  "buffer_active",
  "fetching",
  "completed",
  "rejected",
  "failed",
] as const;
export type ChzKmOrderState = (typeof CHZ_KM_ORDER_STATES)[number];
export const chzKmOrderStateEnum = pgEnum("chz_km_order_state", CHZ_KM_ORDER_STATES);

export const CHZ_KM_CODE_STATUSES = ["available", "issued"] as const;
export const CHZ_KM_ISSUE_KINDS = ["export", "print"] as const;
export const CHZ_KM_ISSUE_FORMATS = ["txt", "csv"] as const;

/**
 * One СУЗ order for one GTIN. `request_body` is the exact byte string the
 * agent signed and the runner sent: a retry re-sends it verbatim, and it is
 * the evidence of what was ordered.
 */
export const chzKmOrders = pgTable(
  "chz_km_orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    productId: uuid("product_id").notNull(),
    gtin14: char("gtin14", { length: 14 }).notNull(),
    productGroupAlias: text("product_group_alias").notNull(),
    productGroupCode: integer("product_group_code")
      .notNull()
      .references(() => chzProductGroups.code),
    templateId: integer("template_id").notNull(),
    quantity: integer("quantity").notNull(),
    state: chzKmOrderStateEnum("state").notNull().default("created"),
    requestBody: text("request_body").notNull(),
    signerTaskId: uuid("signer_task_id"),
    omsOrderId: uuid("oms_order_id"),
    bufferStatus: text("buffer_status"),
    bufferExpiresAt: timestamp("buffer_expires_at", { withTimezone: true }),
    availableCodes: integer("available_codes"),
    totalPassed: integer("total_passed"),
    fetchedCount: integer("fetched_count").notNull().default(0),
    issuedCount: integer("issued_count").notNull().default(0),
    rejectionReason: text("rejection_reason"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    attempts: integer("attempts").notNull().default(0),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    deadlineAt: timestamp("deadline_at", { withTimezone: true }).notNull(),
    createdByUserId: text("created_by_user_id")
      .notNull()
      .references(() => user.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("chz_km_orders_tenant_id_uq").on(t.tenantId, t.id),
    foreignKey({
      name: "chz_km_orders_tenant_product_fk",
      columns: [t.tenantId, t.productId],
      foreignColumns: [products.tenantId, products.id],
    }),
    index("chz_km_orders_tenant_created_idx").on(t.tenantId, t.createdAt),
    index("chz_km_orders_unfinished_idx")
      .on(t.tenantId)
      .where(sql`${t.state} not in ('completed', 'rejected', 'failed')`),
    check("chz_km_orders_quantity_check", sql`${t.quantity} between 1 and 150000`),
    check(
      "chz_km_orders_counts_check",
      sql`${t.issuedCount} >= 0 and ${t.issuedCount} <= ${t.fetchedCount} and ${t.fetchedCount} <= ${t.quantity} and ${t.attempts} >= 0`,
    ),
    check(
      "chz_km_orders_state_consistency_check",
      sql`(${t.state} = 'created' and ${t.omsOrderId} is null and ${t.errorCode} is null)
        or (${t.state} = 'signing' and ${t.signerTaskId} is not null and ${t.omsOrderId} is null and ${t.errorCode} is null)
        or (${t.state} in ('submitted', 'buffer_pending', 'buffer_active', 'fetching') and ${t.omsOrderId} is not null and ${t.errorCode} is null)
        or (${t.state} = 'completed' and ${t.omsOrderId} is not null and ${t.fetchedCount} = ${t.quantity} and ${t.errorCode} is null)
        or (${t.state} = 'rejected' and ${t.omsOrderId} is not null and ${t.rejectionReason} is not null)
        or (${t.state} = 'failed' and ${t.errorCode} is not null)`,
    ),
  ],
);

/** A batch handed to the office: a contiguous `seq` range of one order. */
export const chzKmIssues = pgTable(
  "chz_km_issues",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    orderId: uuid("order_id").notNull(),
    kind: text("kind").notNull(),
    format: text("format"),
    fromSeq: integer("from_seq").notNull(),
    toSeq: integer("to_seq").notNull(),
    count: integer("count").notNull(),
    createdByUserId: text("created_by_user_id")
      .notNull()
      .references(() => user.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("chz_km_issues_tenant_id_uq").on(t.tenantId, t.id),
    foreignKey({
      name: "chz_km_issues_tenant_order_fk",
      columns: [t.tenantId, t.orderId],
      foreignColumns: [chzKmOrders.tenantId, chzKmOrders.id],
    }),
    index("chz_km_issues_order_idx").on(t.tenantId, t.orderId, t.createdAt),
    check("chz_km_issues_kind_check", sql`${t.kind} in ('export', 'print')`),
    check(
      "chz_km_issues_format_check",
      sql`(${t.kind} = 'export' and ${t.format} in ('txt', 'csv')) or (${t.kind} = 'print' and ${t.format} is null)`,
    ),
    check(
      "chz_km_issues_range_check",
      sql`${t.fromSeq} >= 1 and ${t.toSeq} >= ${t.fromSeq} and ${t.count} = ${t.toSeq} - ${t.fromSeq} + 1`,
    ),
  ],
);

/**
 * One row per emitted code. The raw code lives only in the three encrypted
 * columns (AAD `tenantId/orderId/seq`); `code_hash` is `kmHash` of the parsed
 * code so a later scan of the same unit joins without decrypting anything.
 */
export const chzKmCodes = pgTable(
  "chz_km_codes",
  {
    tenantId: tenantId(),
    orderId: uuid("order_id").notNull(),
    seq: integer("seq").notNull(),
    encryptedCode: bytea("encrypted_code").notNull(),
    codeNonce: bytea("code_nonce").notNull(),
    codeTag: bytea("code_tag").notNull(),
    codeHash: char("code_hash", { length: 64 }).notNull(),
    blockId: uuid("block_id").notNull(),
    status: text("status").notNull().default("available"),
    issueId: uuid("issue_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.orderId, t.seq] }),
    foreignKey({
      name: "chz_km_codes_tenant_order_fk",
      columns: [t.tenantId, t.orderId],
      foreignColumns: [chzKmOrders.tenantId, chzKmOrders.id],
    }),
    foreignKey({
      name: "chz_km_codes_tenant_issue_fk",
      columns: [t.tenantId, t.issueId],
      foreignColumns: [chzKmIssues.tenantId, chzKmIssues.id],
    }),
    uniqueIndex("chz_km_codes_tenant_hash_uq").on(t.tenantId, t.codeHash),
    index("chz_km_codes_available_idx")
      .on(t.tenantId, t.orderId, t.seq)
      .where(sql`${t.status} = 'available'`),
    check("chz_km_codes_seq_check", sql`${t.seq} >= 1`),
    check("chz_km_codes_hash_check", sql`${t.codeHash} ~ '^[0-9a-f]{64}$'`),
    check(
      "chz_km_codes_status_check",
      sql`(${t.status} = 'available' and ${t.issueId} is null) or (${t.status} = 'issued' and ${t.issueId} is not null)`,
    ),
  ],
);

export type ChzOmsTokenRow = typeof chzOmsTokens.$inferSelect;
export type ChzKmOrderRow = typeof chzKmOrders.$inferSelect;
export type ChzKmCodeRow = typeof chzKmCodes.$inferSelect;
export type ChzKmIssueRow = typeof chzKmIssues.$inferSelect;
```

In `packages/db/src/schema/labels.ts` change the purpose CHECK to:

```ts
    check(
      "label_templates_purpose_check",
      sql`${t.purpose} IN ('box', 'product_duplicate', 'pallet', 'product_km')`,
    ),
```

and widen its `$type<…>()` to `"box" | "product_duplicate" | "pallet" | "product_km"`.

- [ ] **Step 4: Generate and review the migration**

Run: `set -a; source .env; set +a; pnpm --filter @markiro/db db:generate --name chz_km_orders`
Expected: `migrations/0165_chz_km_orders.sql` plus journal/snapshot entries. Open the SQL and confirm: the enum, four tables, the `label_templates_purpose_check` drop/add, every CHECK above, and the partial indexes. Then append the stock template seed at the end of the file (same pattern as 0164; the spec JSON must be byte-identical to `buildKmLabelTemplates()[0].spec` — copy it from `node -e 'import("@markiro/domain").then(m => console.log(JSON.stringify(m.buildKmLabelTemplates()[0].spec)))'` after `pnpm --filter @markiro/domain build`):

```sql
--> statement-breakpoint
-- Stock KM label for tenants that already exist; new tenants get it from
-- tenant-provisioning.service.ts (`buildKmLabelTemplates()`). (tenant_id,
-- name, purpose) is the seed identity, so a re-run cannot duplicate it.
INSERT INTO label_templates (id, tenant_id, name, purpose, spec)
SELECT gen_random_uuid(), o.id, 'Этикетка КМ 58×40', 'product_km', '<SPEC JSON>'::jsonb
FROM organization o
WHERE NOT EXISTS (
  SELECT 1 FROM label_templates lt
  WHERE lt.tenant_id = o.id AND lt.name = 'Этикетка КМ 58×40' AND lt.purpose = 'product_km'
);
```

- [ ] **Step 5: Run the DB tests, typecheck, lint, build**

Run: `set -a; source .env; set +a; pnpm --filter @markiro/db exec vitest run test/chz-km-orders.test.ts && pnpm --filter @markiro/db test && pnpm --filter @markiro/db typecheck && pnpm --filter @markiro/db lint && pnpm --filter @markiro/db build`
Expected: PASS. If `packages/db/test` has a label-purpose test enumerating the three purposes, extend it with `product_km`.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/schema/chz.ts packages/db/src/schema/labels.ts packages/db/migrations/0165_chz_km_orders.sql packages/db/migrations/meta packages/db/test/chz-km-orders.test.ts
git commit -m "feat(db): СУЗ tokens, KM orders, codes and issues; product_km purpose; migration 0165"
```

---

### Task 4: Platform contracts — signer task union and fixtures

**Files:**

- Modify: `packages/platform-contracts/src/chz-signer.ts`
- Create: `packages/platform-contracts/fixtures/chz-signer/task-oms-auth.json`, `task-sign-detached.json`, `task-complete-signature.json`
- Test: `packages/platform-contracts/test/chz-signer.test.ts`

**Interfaces:**

- Produces: `chzOmsAuthPayloadSchema`, `chzSignDetachedPayloadSchema`, `chzSignerTaskSchema` (discriminated union on `type`), `chzSignerSignatureCompleteSchema`, `chzSignerTaskCompleteBodySchema = z.union([chzSignerTaskCompleteSchema, chzSignerSignatureCompleteSchema])`, types `ChzOmsAuthPayload`, `ChzSignDetachedPayload`, `ChzSignerSignatureComplete`, `ChzSignerTaskCompleteBody`.

- [ ] **Step 1: Write the failing test**

Append to `packages/platform-contracts/test/chz-signer.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { chzSignerContracts } from "../src/index.js";

const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`../fixtures/chz-signer/${name}`, import.meta.url), "utf8"));

describe("signer task union", () => {
  it("parses an oms_auth task", () => {
    const task = chzSignerContracts.task.parse(fixture("task-oms-auth.json"));
    expect(task.type).toBe("oms_auth");
    if (task.type === "oms_auth") expect(task.payload.omsConnection).toMatch(/^[0-9a-f-]{36}$/);
  });
  it("parses a sign_detached task and its signature completion", () => {
    const task = chzSignerContracts.task.parse(fixture("task-sign-detached.json"));
    expect(task.type).toBe("sign_detached");
    const done = chzSignerContracts.taskCompleteBody.parse(fixture("task-complete-signature.json"));
    expect("signatureBase64" in done).toBe(true);
  });
  it("rejects an unknown task type", () => {
    expect(() =>
      chzSignerContracts.task.parse({ id: crypto.randomUUID(), type: "nope", payload: {} }),
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @markiro/platform-contracts exec vitest run test/chz-signer.test.ts`
Expected: FAIL — fixture files missing / `taskCompleteBody` undefined.

- [ ] **Step 3: Write the contracts and fixtures**

In `packages/platform-contracts/src/chz-signer.ts` replace `chzSignerTaskSchema` and extend the exports:

```ts
export const chzOmsAuthPayloadSchema = z
  .object({
    trueApiBaseUrl: z.url(),
    /** СУЗ-issued: hex-shaped only, so `z.guid()` — `z.uuid()` refuses СУЗ's own documented example. */
    omsConnection: z.guid(),
    inn: innSchema.optional(),
  })
  .strict();

export const chzSignDetachedPayloadSchema = z
  .object({
    purpose: z.literal("oms_order"),
    orderId: z.uuid(),
    /** Exact request body bytes, base64. Order bodies are well under 1 KB; the cap only bounds abuse. */
    dataBase64: z
      .string()
      .regex(/^[A-Za-z0-9+/]+={0,2}$/)
      .min(4)
      .max(256 * 1024),
  })
  .strict();

export const chzSignerTaskSchema = z.discriminatedUnion("type", [
  z
    .object({
      id: z.uuid(),
      type: z.literal("true_api_auth"),
      payload: chzTrueApiAuthPayloadSchema,
    })
    .strict(),
  z
    .object({ id: z.uuid(), type: z.literal("oms_auth"), payload: chzOmsAuthPayloadSchema })
    .strict(),
  z
    .object({
      id: z.uuid(),
      type: z.literal("sign_detached"),
      payload: chzSignDetachedPayloadSchema,
    })
    .strict(),
]);

export const chzSignerSignatureCompleteSchema = z
  .object({
    signatureBase64: z
      .string()
      .regex(/^[A-Za-z0-9+/]+={0,2}$/)
      .min(4)
      .max(64 * 1024),
    certThumbprint: z.string().trim().min(1).max(128),
  })
  .strict();

export const chzSignerTaskCompleteBodySchema = z.union([
  chzSignerTaskCompleteSchema,
  chzSignerSignatureCompleteSchema,
]);

export type ChzOmsAuthPayload = z.infer<typeof chzOmsAuthPayloadSchema>;
export type ChzSignDetachedPayload = z.infer<typeof chzSignDetachedPayloadSchema>;
export type ChzSignerSignatureComplete = z.infer<typeof chzSignerSignatureCompleteSchema>;
export type ChzSignerTaskCompleteBody = z.infer<typeof chzSignerTaskCompleteBodySchema>;
```

and add to `chzSignerContracts`: `omsAuthPayload: chzOmsAuthPayloadSchema, signDetachedPayload: chzSignDetachedPayloadSchema, signatureComplete: chzSignerSignatureCompleteSchema, taskCompleteBody: chzSignerTaskCompleteBodySchema`.

Fixtures:

```json
// task-oms-auth.json
{
  "id": "6d2a1b7e-4c1f-4b7e-9c3a-1a2b3c4d5e6f",
  "type": "oms_auth",
  "payload": {
    "trueApiBaseUrl": "https://markirovka.sandbox.crptech.ru/api/v3/true-api",
    "omsConnection": "11b1abc1-f1ee-11db-1a11-f11ac11111e1"
  }
}
```

```json
// task-sign-detached.json
{
  "id": "3f0e0f5e-8d1c-4d7a-9b1a-222222222222",
  "type": "sign_detached",
  "payload": {
    "purpose": "oms_order",
    "orderId": "7f2c1a1e-0000-4000-8000-000000000001",
    "dataBase64": "eyJwcm9kdWN0R3JvdXAiOiJiZWVyIn0="
  }
}
```

```json
// task-complete-signature.json
{
  "signatureBase64": "MIIE5QYJKoZIhvcNAQcCoIIE1jCCBNICAQExDjAMBggqhQMHAQECAgUAMAsGCSqGSIb3DQEHAQ==",
  "certThumbprint": "AB120F0000000000000000000000000000000000"
}
```

- [ ] **Step 4: Run tests and build**

Run: `pnpm --filter @markiro/platform-contracts test && pnpm --filter @markiro/platform-contracts typecheck && pnpm --filter @markiro/platform-contracts build`
Expected: PASS. (The Rust fixture test in `apps/signer/signer-core/src/contracts.rs` reads the same folder; part B adds the Rust side.)

- [ ] **Step 5: Commit**

```bash
git add packages/platform-contracts/src/chz-signer.ts packages/platform-contracts/fixtures/chz-signer packages/platform-contracts/test/chz-signer.test.ts
git commit -m "feat(contracts): oms_auth and sign_detached signer tasks with shared fixtures"
```

---

### Task 5: API signer-agents — СУЗ settings, task claim/complete per type, `oms_auth` scheduling

**Files:**

- Modify: `apps/api/src/modules/integrations/channel-registry.ts:118-125`
- Modify: `apps/api/src/modules/signer-agents/chz-constants.ts`
- Modify: `apps/api/src/modules/signer-agents/chz-crypto.service.ts`
- Modify: `apps/api/src/modules/signer-agents/signer-tasks.service.ts`
- Modify: `apps/api/src/modules/signer-agents/signer-scheduler.service.ts`
- Modify: `apps/api/src/modules/signer-agents/signer-agent-tasks.controller.ts`, `dto.ts`, `signer-agents.service.ts`
- Test: `apps/api/test/chz-signer-task-payload.test.ts`, `apps/api/test/signer-agent-tasks.e2e.test.ts`, `apps/api/test/signer-scheduler.e2e.test.ts`, `apps/api/test/chz-crypto.test.ts`

**Interfaces:**

- Produces: `CHZ_OMS_BASE_URLS = { production: "https://suzgrid.crpt.ru/api/v3", sandbox: "https://suz.sandbox.crptech.ru/api/v3" }`, `CHZ_OMS_TOKEN_TTL_MS = 10 * 3600_000`, `buildChzOmsAuthPayload(settings): ChzOmsAuthPayload | null`, `ChzCryptoService.encryptWithAad(aad, value)` / `decryptWithAad(aad, payload)`, `chzSignerSettingsSchema` with `omsId?`, `omsConnection?`, `omsContactPerson?`, `SignerAgentsOverviewDto.omsToken: SignerTokenStatusDto`.

- [ ] **Step 1: Write the failing tests**

Add to `apps/api/test/chz-signer-task-payload.test.ts`:

```ts
import { buildChzOmsAuthPayload } from "../src/modules/signer-agents/chz-constants";

describe("CHZ oms_auth payload", () => {
  it("is null without an OMS connection and carries the connection otherwise", () => {
    expect(buildChzOmsAuthPayload({ environment: "sandbox" })).toBeNull();
    expect(
      buildChzOmsAuthPayload({
        environment: "sandbox",
        omsId: "cdf12109-10d3-11e6-8b6f-0050569977a1",
        omsConnection: "11b1abc1-f1ee-11db-1a11-f11ac11111e1",
        mchdInn: "7712345678",
      }),
    ).toEqual({
      trueApiBaseUrl: "https://markirovka.sandbox.crptech.ru/api/v3/true-api",
      omsConnection: "11b1abc1-f1ee-11db-1a11-f11ac11111e1",
      inn: "7712345678",
    });
  });
});
```

Add to `apps/api/test/chz-crypto.test.ts`:

```ts
it("binds a ciphertext to its AAD", () => {
  const service = new ChzCryptoService(Buffer.alloc(32, 7));
  const sealed = service.encryptWithAad("t/o/1", "010460703469001421AbC\u001d93dGVz");
  expect(service.decryptWithAad("t/o/1", sealed)).toBe("010460703469001421AbC\u001d93dGVz");
  expect(() => service.decryptWithAad("t/o/2", sealed)).toThrow();
});
```

Add to `apps/api/test/signer-agent-tasks.e2e.test.ts` (inside the describe, reusing `pairAgent`):

```ts
async function setOmsSettings(): Promise<void> {
  await db
    .insert(schema.integrationChannels)
    .values({
      tenantId,
      type: "chestny_znak",
      settings: {
        environment: "sandbox",
        omsId: "cdf12109-10d3-11e6-8b6f-0050569977a1",
        omsConnection: "11b1abc1-f1ee-11db-1a11-f11ac11111e1",
      },
    })
    .onConflictDoUpdate({
      target: [schema.integrationChannels.tenantId, schema.integrationChannels.type],
      set: {
        settings: {
          environment: "sandbox",
          omsId: "cdf12109-10d3-11e6-8b6f-0050569977a1",
          omsConnection: "11b1abc1-f1ee-11db-1a11-f11ac11111e1",
        },
      },
    });
}

it("completes an oms_auth task into chz_oms_tokens", async () => {
  const { agentId, secret } = await pairAgent();
  await setOmsSettings();
  const [row] = await db
    .insert(schema.chzSignerTasks)
    .values({
      tenantId,
      type: "oms_auth",
      payload: {
        trueApiBaseUrl: "https://markirovka.sandbox.crptech.ru/api/v3/true-api",
        omsConnection: "11b1abc1-f1ee-11db-1a11-f11ac11111e1",
      },
    })
    .returning({ id: schema.chzSignerTasks.id });
  const next = await request(app!.getHttpServer())
    .get("/signer-agent/tasks/next?wait=0")
    .set("x-signer-token", secret)
    .expect(200);
  expect(next.body.task).toMatchObject({ id: row!.id, type: "oms_auth" });
  const expiresAt = new Date(Date.now() + 10 * 3600_000).toISOString();
  await request(app!.getHttpServer())
    .post(`/signer-agent/tasks/${row!.id}/complete`)
    .set("x-signer-token", secret)
    .send({ token: "2f2222c2-cbc2-22ff-bc2c-2222222fbef2", expiresAt, certThumbprint: "AB12" })
    .expect(204);
  const [token] = await db
    .select()
    .from(schema.chzOmsTokens)
    .where(eq(schema.chzOmsTokens.tenantId, tenantId));
  expect(token).toMatchObject({
    agentId,
    sourceOmsConnection: "11b1abc1-f1ee-11db-1a11-f11ac11111e1",
  });
  expect(Buffer.from(token!.encryptedToken).toString("utf8")).not.toContain("2f2222c2");
});

it("completes a sign_detached task by storing the signature on the task", async () => {
  const { secret } = await pairAgent();
  const [row] = await db
    .insert(schema.chzSignerTasks)
    .values({
      tenantId,
      type: "sign_detached",
      payload: { purpose: "oms_order", orderId: randomUUID(), dataBase64: "eyJhIjoxfQ==" },
    })
    .returning({ id: schema.chzSignerTasks.id });
  await request(app!.getHttpServer())
    .get("/signer-agent/tasks/next?wait=0")
    .set("x-signer-token", secret)
    .expect(200);
  await request(app!.getHttpServer())
    .post(`/signer-agent/tasks/${row!.id}/complete`)
    .set("x-signer-token", secret)
    .send({ signatureBase64: "MIIE5QYJKoZIhvcNAQcCoIIE1g==", certThumbprint: "AB12" })
    .expect(204);
  const [task] = await db
    .select()
    .from(schema.chzSignerTasks)
    .where(eq(schema.chzSignerTasks.id, row!.id));
  expect(task).toMatchObject({
    status: "completed",
    resultSummary: { signatureBase64: "MIIE5QYJKoZIhvcNAQcCoIIE1g==", certThumbprint: "AB12" },
  });
});

it("refuses a token body for a sign_detached task", async () => {
  const { secret } = await pairAgent();
  const [row] = await db
    .insert(schema.chzSignerTasks)
    .values({
      tenantId,
      type: "sign_detached",
      payload: { purpose: "oms_order", orderId: randomUUID(), dataBase64: "eyJhIjoxfQ==" },
    })
    .returning({ id: schema.chzSignerTasks.id });
  await request(app!.getHttpServer())
    .get("/signer-agent/tasks/next?wait=0")
    .set("x-signer-token", secret)
    .expect(200);
  await request(app!.getHttpServer())
    .post(`/signer-agent/tasks/${row!.id}/complete`)
    .set("x-signer-token", secret)
    .send({ token: "x", expiresAt: new Date().toISOString(), certThumbprint: "AB12" })
    .expect(400);
  await request(app!.getHttpServer())
    .post(`/signer-agent/tasks/${row!.id}/fail`)
    .set("x-signer-token", secret)
    .send({ errorCode: "NETWORK", message: "cleanup" })
    .expect(204);
});
```

(`randomUUID` from `node:crypto`; add the import.) Add to `apps/api/test/signer-scheduler.e2e.test.ts` a case that, with an active agent and channel settings carrying `omsConnection` but no `chz_oms_tokens` row, `scheduler.run()` inserts exactly one `oms_auth` task, and with settings lacking `omsConnection` inserts none.

- [ ] **Step 2: Run tests to verify they fail**

Run: `set -a; source .env; set +a; pnpm --filter @markiro/api exec vitest run test/chz-signer-task-payload.test.ts test/chz-crypto.test.ts test/signer-agent-tasks.e2e.test.ts test/signer-scheduler.e2e.test.ts`
Expected: FAIL — `buildChzOmsAuthPayload`/`encryptWithAad` undefined; e2e completes return 400/500.

- [ ] **Step 3: Implement**

`channel-registry.ts`:

```ts
export const chzSignerSettingsSchema = z
  .object({
    environment: z.enum(["production", "sandbox"]).default("production"),
    mchdInn: z
      .string()
      .regex(/^\d{10}(\d{2})?$/)
      .optional(),
    /** СУЗ identifier from the tenant's СУЗ cabinet settings. */
    /**
     * `z.guid()`, not `z.uuid()`: СУЗ issues these and documents them only as
     * hex-shaped (`[0-9a-fA-F]{8}-…`), so a real installation id can carry a
     * non-RFC-4122 variant nibble — СУЗ's own documented example does. Our own
     * identifiers stay `z.uuid()`.
     */
    omsId: z.guid().optional(),
    /** The installation registered for Markiro in the СУЗ cabinet; one token per installation. */
    omsConnection: z.guid().optional(),
    omsContactPerson: z.string().trim().min(1).max(128).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.omsId === undefined) !== (value.omsConnection === undefined)) {
      ctx.addIssue({
        code: "custom",
        message: "omsId and omsConnection must be set together",
        path: ["omsConnection"],
      });
    }
  });
```

`chz-constants.ts` additions:

```ts
import type { ChzOmsAuthPayload } from "@markiro/platform-contracts";

export const CHZ_OMS_BASE_URLS = {
  production: "https://suzgrid.crpt.ru/api/v3",
  sandbox: "https://suz.sandbox.crptech.ru/api/v3",
} as const;

/** СУЗ documents a 10-hour client token and returns no expiry with it. */
export const CHZ_OMS_TOKEN_TTL_MS = 10 * 3600_000;

export function buildChzOmsAuthPayload(settings: {
  environment: keyof typeof CHZ_TRUE_API_BASE_URLS;
  omsConnection?: string | undefined;
  mchdInn?: string | undefined;
}): ChzOmsAuthPayload | null {
  if (!settings.omsConnection) return null;
  return {
    trueApiBaseUrl: CHZ_TRUE_API_BASE_URLS[settings.environment],
    omsConnection: settings.omsConnection,
    ...(settings.mchdInn ? { inn: settings.mchdInn } : {}),
  };
}
```

`chz-crypto.service.ts`: rename the bodies of `encrypt`/`decrypt` into `encryptWithAad(aad: string, value: string)` / `decryptWithAad(aad: string, payload)` (identical code with `Buffer.from(aad, "utf8")` as AAD) and keep `encrypt(tenantId, token)` / `decrypt(tenantId, payload)` as one-line delegations.

`signer-tasks.service.ts`:

- `tryClaim` returns `chzSignerTaskSchema.parse({ id: task.id, type: task.type, payload: task.payload })`.
- `complete(tenantId, agentId, taskId, body: ChzSignerTaskCompleteBody)` first reads the claimed task row (`select … for update` inside the transaction, same `where` as today), parses `type`, then:
  - `true_api_auth`: existing code path (requires `"token" in body`, else `BadRequestException("token body required")`).
  - `oms_auth`: require `"token" in body`; parse payload with `chzOmsAuthPayloadSchema`; load settings; if `payload.omsConnection !== settings.omsConnection` or the True API base URL differs from `CHZ_TRUE_API_BASE_URLS[settings.environment]` → mark the task `failed` with `CHZ_OMS_CONNECTION_CHANGED` and stop; else `obtainedAt = new Date()`, `expiresAt = min(new Date(body.expiresAt), obtainedAt + CHZ_OMS_TOKEN_TTL_MS)`, upsert `chzOmsTokens` (`sourceOmsConnection: payload.omsConnection`, `sourceTrueApiBaseUrl: payload.trueApiBaseUrl`, encrypted token via `crypto.encrypt`), update agent cert fields as today, journal «СУЗ token refreshed».
  - `sign_detached`: require `"signatureBase64" in body`, else 400; update the task to `completed` with `resultSummary: { signatureBase64: body.signatureBase64, certThumbprint: body.certThumbprint }`; journal «Detached signature delivered» with `{ taskId, orderId: payload.orderId }` only.

`signer-agent-tasks.controller.ts`: `@ApiZodBody(chzSignerTaskCompleteBodySchema)` and `@Body(new ZodValidationPipe(chzSignerTaskCompleteBodySchema)) body: ChzSignerTaskCompleteBody`. `dto.ts`: the task OpenAPI schema becomes a `oneOf` of the three task shapes (`type` enum per branch) and `nextTaskOpenApiSchema` keeps `nullable`.

`signer-scheduler.service.ts`: extract the per-tenant loop body into `refreshTokenKind(now, tenantId, kind)` where `kind = "true_api_auth" | "oms_auth"`; for `oms_auth` read `chzOmsTokens`, skip when `buildChzOmsAuthPayload(settings) === null`, insert `{ type: "oms_auth", payload }` with `onConflictDoNothing()`. Degradation journal line for the СУЗ token: «СУЗ token expired; signer agent has not refreshed it».

`signer-agents.service.ts` / `dto.ts`: `overview()` selects `chzOmsTokens` for the tenant and returns `omsToken: this.tokenStatus(omsToken ?? null)` (the status helper only needs `expiresAt`/`obtainedAt`/`certThumbprint`; pass `tokenType: null` for СУЗ); add `omsToken` to `signerAgentsOverviewOpenApiSchema.required` and `properties`.

- [ ] **Step 4: Run the tests, then the package gates**

Run: `set -a; source .env; set +a; pnpm --filter @markiro/api exec vitest run test/chz-signer-task-payload.test.ts test/chz-crypto.test.ts test/signer-agent-tasks.e2e.test.ts test/signer-scheduler.e2e.test.ts test/signer-agents.e2e.test.ts test/openapi-coverage.test.ts`
Expected: PASS. Then `pnpm --filter @markiro/api typecheck && pnpm --filter @markiro/api lint`.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/integrations/channel-registry.ts apps/api/src/modules/signer-agents apps/api/test/chz-signer-task-payload.test.ts apps/api/test/chz-crypto.test.ts apps/api/test/signer-agent-tasks.e2e.test.ts apps/api/test/signer-scheduler.e2e.test.ts
git commit -m "feat(api): СУЗ settings, oms_auth and sign_detached signer tasks, СУЗ token refresh"
```

---

### Task 6: СУЗ (OMS) client with injected fetch

**Files:**

- Create: `apps/api/src/modules/chz-km-orders/oms.types.ts`, `apps/api/src/modules/chz-km-orders/oms.client.ts`
- Test: `apps/api/test/chz-oms-client.test.ts`

**Interfaces:**

- Produces: `OmsAuth { baseUrl: string; clientToken: string; omsId: string }`, `OmsResult<T>` (same four outcomes as `TrueApiResult`), `OmsBufferInfo { bufferStatus, availableCodes, leftInBuffer, totalCodes, totalPassed, expiredDate: number | null, rejectionReason: string | null }`, `OmsCodesBlock { codes: string[]; blockId: string }`, `OmsBlockSummary { blockId: string; quantity: number }`, `OmsClient` with `createOrder(auth, body: string, signatureBase64: string)`, `getBufferStatus(auth, orderId, gtin14)`, `getCodes(auth, orderId, gtin14, quantity)`, `listBlocks(auth, orderId, gtin14)`, `retryBlock(auth, blockId)`; `OmsClientDependencies` = `TrueApiClientDependencies` shape.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/test/chz-oms-client.test.ts
import { describe, expect, it } from "vitest";
import { OmsClient, type OmsClientDependencies } from "../src/modules/chz-km-orders/oms.client";

const auth = {
  baseUrl: "https://suz.sandbox.crptech.ru/api/v3",
  clientToken: "tok",
  omsId: "cdf12109-10d3-11e6-8b6f-0050569977a1",
};
const deps = (fetchImpl: OmsClientDependencies["fetch"]): OmsClientDependencies => ({
  fetch: fetchImpl,
  scheduleAbort: () => () => {},
});

describe("OmsClient", () => {
  it("posts the body bytes verbatim with clientToken and X-Signature", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const client = new OmsClient(
      deps(async (url, init) => {
        calls.push({ url: String(url), init: init as RequestInit });
        return new Response(
          JSON.stringify({
            omsId: auth.omsId,
            orderId: "b024ae09-ef7c-449e-b461-05d8eb116c79",
            expectedCompleteTimestamp: 5100,
          }),
          { status: 200 },
        );
      }),
    );
    const body = '{"productGroup":"beer"}';
    const result = await client.createOrder(auth, body, "c2ln");
    expect(result).toEqual({
      status: "ok",
      value: { orderId: "b024ae09-ef7c-449e-b461-05d8eb116c79", expectedCompleteMs: 5100 },
    });
    expect(calls[0]!.url).toBe(`${auth.baseUrl}/order?omsId=${auth.omsId}`);
    const headers = new Headers(calls[0]!.init.headers);
    expect(headers.get("clientToken")).toBe("tok");
    expect(headers.get("X-Signature")).toBe("c2ln");
    expect(calls[0]!.init.body).toBe(body);
  });

  it("parses codes as JSON so the GS escape becomes the raw separator", async () => {
    const client = new OmsClient(
      deps(
        async () =>
          new Response(
            '{"omsId":"x","codes":["010460165303004621=rxDV3M\\u001d93VXQI"],"blockId":"012cc7b0-c9e4-4511-8058-2de1f97a87b0"}',
            { status: 200 },
          ),
      ),
    );
    const result = await client.getCodes(
      auth,
      "b024ae09-ef7c-449e-b461-05d8eb116c79",
      "04601653030046",
      1,
    );
    expect(result).toEqual({
      status: "ok",
      value: {
        codes: ["010460165303004621=rxDV3M\u001d93VXQI"],
        blockId: "012cc7b0-c9e4-4511-8058-2de1f97a87b0",
      },
    });
  });

  it("maps buffer status, including a rejected order's reason", async () => {
    const client = new OmsClient(
      deps(
        async () =>
          new Response(
            JSON.stringify([
              {
                omsId: "x",
                orderId: "y",
                leftInBuffer: -1,
                totalCodes: -1,
                availableCodes: -1,
                unavailableCodes: -1,
                totalPassed: -1,
                gtin: "04606038003172",
                bufferStatus: "REJECTED",
                rejectionReason: "Order declined: 0106",
                templateId: 18,
              },
            ]),
            { status: 200 },
          ),
      ),
    );
    const result = await client.getBufferStatus(auth, "y", "04606038003172");
    expect(result).toEqual({
      status: "ok",
      value: {
        bufferStatus: "REJECTED",
        availableCodes: -1,
        leftInBuffer: -1,
        totalCodes: -1,
        totalPassed: -1,
        expiredDate: null,
        rejectionReason: "Order declined: 0106",
      },
    });
  });

  it("classifies 401 as unauthorized, 4xx as rejected with the message, 5xx and 429 as unavailable", async () => {
    const mk = (status: number, body: string) =>
      new OmsClient(deps(async () => new Response(body, { status })));
    expect(await mk(401, "").getBufferStatus(auth, "y", "04606038003172")).toEqual({
      status: "unauthorized",
    });
    expect(
      await mk(
        400,
        '{"fieldErrors":[{"fieldName":"gtin","fieldError":"bad"}],"globalErrors":["nope"]}',
      ).getBufferStatus(auth, "y", "04606038003172"),
    ).toMatchObject({ status: "rejected", code: "400" });
    expect(await mk(429, "").getBufferStatus(auth, "y", "04606038003172")).toEqual({
      status: "unavailable",
    });
    expect(await mk(503, "").getBufferStatus(auth, "y", "04606038003172")).toEqual({
      status: "unavailable",
    });
  });

  it("refuses more than 150000 codes per call before any request", async () => {
    const client = new OmsClient(
      deps(async () => {
        throw new Error("must not be called");
      }),
    );
    await expect(client.getCodes(auth, "y", "04606038003172", 150_001)).rejects.toThrow(RangeError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @markiro/api exec vitest run test/chz-oms-client.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// apps/api/src/modules/chz-km-orders/oms.types.ts
import type { TrueApiClientDependencies } from "../chz-exports/true-api.types";
export type OmsClientDependencies = TrueApiClientDependencies;
export interface OmsAuth {
  baseUrl: string;
  clientToken: string;
  omsId: string;
}
export type OmsResult<T> =
  | { status: "ok"; value: T }
  | { status: "unauthorized" }
  | { status: "rejected"; code: string; message: string }
  | { status: "unavailable" };
export interface OmsCreatedOrder {
  orderId: string;
  expectedCompleteMs: number;
}
export interface OmsBufferInfo {
  bufferStatus: string;
  availableCodes: number;
  leftInBuffer: number;
  totalCodes: number;
  totalPassed: number;
  expiredDate: number | null;
  rejectionReason: string | null;
}
export interface OmsCodesBlock {
  codes: string[];
  blockId: string;
}
export interface OmsBlockSummary {
  blockId: string;
  quantity: number;
}
```

```ts
// apps/api/src/modules/chz-km-orders/oms.client.ts
import { Injectable } from "@nestjs/common";
import { productionTrueApiClientDependencies } from "../chz-exports/true-api.types";
import type {
  OmsAuth,
  OmsBlockSummary,
  OmsBufferInfo,
  OmsClientDependencies,
  OmsCodesBlock,
  OmsCreatedOrder,
  OmsResult,
} from "./oms.types";
export type { OmsClientDependencies } from "./oms.types";

const REQUEST_TIMEOUT_MS = 15_000;
const CODES_TIMEOUT_MS = 120_000;
/** СУЗ's documented ceiling for one `GET /codes` call. */
export const OMS_CODES_CALL_LIMIT = 150_000;
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

@Injectable()
export class OmsClient {
  constructor(
    private readonly dependencies: OmsClientDependencies = productionTrueApiClientDependencies,
  ) {}

  /** `body` is sent byte-for-byte: it is what the detached signature covers. */
  createOrder(
    auth: OmsAuth,
    body: string,
    signatureBase64: string,
  ): Promise<OmsResult<OmsCreatedOrder>> {
    return this.request(
      auth,
      `/order?omsId=${encodeURIComponent(auth.omsId)}`,
      REQUEST_TIMEOUT_MS,
      { method: "POST", body, headers: { "X-Signature": signatureBase64 } },
      async (response) => {
        const payload = (await response.json()) as Record<string, unknown>;
        const orderId = payload.orderId;
        const expected = payload.expectedCompleteTimestamp;
        if (typeof orderId !== "string" || !UUID.test(orderId)) return null;
        return { orderId, expectedCompleteMs: typeof expected === "number" ? expected : 0 };
      },
    );
  }

  getBufferStatus(
    auth: OmsAuth,
    orderId: string,
    gtin14: string,
  ): Promise<OmsResult<OmsBufferInfo>> {
    const query = new URLSearchParams({ omsId: auth.omsId, orderId, gtin: gtin14 });
    return this.request(
      auth,
      `/order/status?${query}`,
      REQUEST_TIMEOUT_MS,
      {},
      async (response) => {
        const payload: unknown = await response.json();
        const row = Array.isArray(payload)
          ? (payload[0] as Record<string, unknown> | undefined)
          : undefined;
        if (!row || typeof row.bufferStatus !== "string") return null;
        return {
          bufferStatus: row.bufferStatus,
          availableCodes: intOr(row.availableCodes, -1),
          leftInBuffer: intOr(row.leftInBuffer, -1),
          totalCodes: intOr(row.totalCodes, -1),
          totalPassed: intOr(row.totalPassed, -1),
          expiredDate: typeof row.expiredDate === "number" ? row.expiredDate : null,
          rejectionReason:
            typeof row.rejectionReason === "string" && row.rejectionReason.length > 0
              ? row.rejectionReason.slice(0, 500)
              : null,
        };
      },
    );
  }

  getCodes(
    auth: OmsAuth,
    orderId: string,
    gtin14: string,
    quantity: number,
  ): Promise<OmsResult<OmsCodesBlock>> {
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > OMS_CODES_CALL_LIMIT) {
      throw new RangeError(`GET /codes accepts 1..${OMS_CODES_CALL_LIMIT} codes`);
    }
    const query = new URLSearchParams({
      omsId: auth.omsId,
      orderId,
      gtin: gtin14,
      quantity: String(quantity),
    });
    return this.request(auth, `/codes?${query}`, CODES_TIMEOUT_MS, {}, parseCodesBlock);
  }

  listBlocks(
    auth: OmsAuth,
    orderId: string,
    gtin14: string,
  ): Promise<OmsResult<OmsBlockSummary[]>> {
    const query = new URLSearchParams({ omsId: auth.omsId, orderId, gtin: gtin14 });
    return this.request(
      auth,
      `/order/codes/blocks?${query}`,
      REQUEST_TIMEOUT_MS,
      {},
      async (response) => {
        const payload = (await response.json()) as Record<string, unknown>;
        if (!Array.isArray(payload.blocks)) return null;
        return payload.blocks.flatMap((block) => {
          const record = block as Record<string, unknown>;
          return typeof record.blockId === "string" && UUID.test(record.blockId)
            ? [{ blockId: record.blockId, quantity: intOr(record.quantity, 0) }]
            : [];
        });
      },
    );
  }

  retryBlock(auth: OmsAuth, blockId: string): Promise<OmsResult<OmsCodesBlock>> {
    const query = new URLSearchParams({ omsId: auth.omsId, blockId });
    return this.request(auth, `/order/codes/retry?${query}`, CODES_TIMEOUT_MS, {}, parseCodesBlock);
  }

  private async request<T>(
    auth: OmsAuth,
    path: string,
    timeoutMs: number,
    init: RequestInit,
    parse: (response: Response) => Promise<T | null>,
  ): Promise<OmsResult<T>> {
    const controller = new AbortController();
    const cancelAbort = this.dependencies.scheduleAbort(controller, timeoutMs);
    try {
      const headers = new Headers(init.headers);
      headers.set("Accept", "application/json");
      if (init.body) headers.set("Content-Type", "application/json");
      headers.set("clientToken", auth.clientToken);
      const response = await this.dependencies.fetch(`${auth.baseUrl}${path}`, {
        ...init,
        headers,
        signal: controller.signal,
      });
      if (response.status === 401) return { status: "unauthorized" };
      if (response.status === 429) return { status: "unavailable" };
      if (response.status >= 400 && response.status < 500) {
        return {
          status: "rejected",
          code: String(response.status),
          message: await rejectionMessage(response),
        };
      }
      if (!response.ok) return { status: "unavailable" };
      const value = await parse(response);
      return value === null ? { status: "unavailable" } : { status: "ok", value };
    } catch {
      return { status: "unavailable" };
    } finally {
      cancelAbort();
    }
  }
}

async function parseCodesBlock(response: Response): Promise<OmsCodesBlock | null> {
  const payload = (await response.json()) as Record<string, unknown>;
  const codes = payload.codes;
  const blockId = payload.blockId;
  if (!Array.isArray(codes) || typeof blockId !== "string" || !UUID.test(blockId)) return null;
  if (!codes.every((code) => typeof code === "string" && code.length > 0 && code.length <= 1024))
    return null;
  return { codes: codes as string[], blockId };
}

/** СУЗ error bodies: `{fieldErrors:[{fieldName,fieldError}], globalErrors:[…]}` or `{error_message}`; joined, capped, no token echo possible. */
async function rejectionMessage(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as Record<string, unknown>;
    const parts: string[] = [];
    if (Array.isArray(payload.globalErrors))
      parts.push(...payload.globalErrors.filter((e): e is string => typeof e === "string"));
    if (Array.isArray(payload.fieldErrors)) {
      for (const error of payload.fieldErrors) {
        const record = error as Record<string, unknown>;
        if (typeof record.fieldError === "string")
          parts.push(`${String(record.fieldName ?? "")}: ${record.fieldError}`);
      }
    }
    const single = payload.error_message ?? payload.errorMessage ?? payload.message;
    if (typeof single === "string") parts.push(single);
    return parts.join("; ").slice(0, 500);
  } catch {
    return "";
  }
}

function intOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) ? value : fallback;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @markiro/api exec vitest run test/chz-oms-client.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/chz-km-orders/oms.types.ts apps/api/src/modules/chz-km-orders/oms.client.ts apps/api/test/chz-oms-client.test.ts
git commit -m "feat(api): СУЗ OMS client with injected fetch"
```

---

### Task 7: СУЗ token service

**Files:**

- Create: `apps/api/src/modules/chz-km-orders/chz-oms-token.service.ts`
- Test: `apps/api/test/chz-oms-token.service.test.ts`

**Interfaces:**

- Consumes: `chzOmsTokens`, `ChzCryptoService`, `chzSignerSettingsSchema`, `CHZ_OMS_BASE_URLS`, `buildChzOmsAuthPayload`.
- Produces: `ChzOmsTokenService.getActiveToken(tenantId): Promise<ChzOmsTokenResult>` where `ChzOmsTokenResult = {status:"ok"; auth: OmsAuth; obtainedAt: Date} | {status:"unconfigured"} | {status:"missing"} | {status:"expired"} | {status:"undecryptable"} | {status:"settings_missing"}`; `hasUsableToken(tenantId)`; `invalidateAndRequestRefresh(tenantId, obtainedAt)`; `requestRefresh(tenantId)`.

- [ ] **Step 1: Write the failing test**

Copy the structure of `apps/api/test/chz-token.service.test.ts` (DB-backed, `describe.skipIf(!ready)`), seeding an organisation with `createOrganization` from `./support/subscription-fixtures`, a `chestny_znak` channel with `environment: "sandbox"`, `omsId`, `omsConnection`, and a `chz_oms_tokens` row encrypted with `new ChzCryptoService(key).encrypt(tenantId, "tok")`. Assert:

```ts
expect(await service.getActiveToken(tenantId)).toMatchObject({
  status: "ok",
  auth: {
    baseUrl: "https://suz.sandbox.crptech.ru/api/v3",
    clientToken: "tok",
    omsId: "cdf12109-10d3-11e6-8b6f-0050569977a1",
  },
});
```

plus: `settings_missing` when the channel lacks `omsId`; `expired` when `expiresAt` is in the past; `requestRefresh` inserts one `oms_auth` task and a second call inserts none (partial unique index).

- [ ] **Step 2: Run test to verify it fails**

Run: `set -a; source .env; set +a; pnpm --filter @markiro/api exec vitest run test/chz-oms-token.service.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Mirror `chz-token.service.ts` exactly, with these differences: table `schema.chzOmsTokens`; the settings read returns `settings_missing` unless `omsId` and `omsConnection` are present; `auth = { baseUrl: CHZ_OMS_BASE_URLS[settings.environment], clientToken, omsId: settings.omsId }`; a token whose `sourceOmsConnection !== settings.omsConnection` is reported as `missing` (a stale token for an old installation must not be used); `requestRefresh` inserts `{ type: "oms_auth", payload: buildChzOmsAuthPayload(settings) }` and returns without inserting when the payload is `null`.

- [ ] **Step 4: Run test to verify it passes**

Run: `set -a; source .env; set +a; pnpm --filter @markiro/api exec vitest run test/chz-oms-token.service.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/chz-km-orders/chz-oms-token.service.ts apps/api/test/chz-oms-token.service.test.ts
git commit -m "feat(api): decrypt-on-demand СУЗ token service"
```

---

### Task 8: Orders service, DTOs and controller (create, list, get, retry)

**Files:**

- Create: `apps/api/src/modules/chz-km-orders/dto.ts`, `chz-km-orders.service.ts`, `chz-km-orders.controller.ts`, `chz-km-orders.module.ts`
- Modify: `apps/api/src/app.module.ts` (import `ChzKmOrdersModule.forRoot(env)`)
- Modify: `apps/api/test/subscription-route-inventory.test.ts` (route keys)
- Test: `apps/api/test/chz-km-orders.e2e.test.ts`, `apps/api/test/chz-km-orders-openapi.test.ts`

**Interfaces:**

- Produces: routes `GET /chz-km-orders`, `POST /chz-km-orders`, `GET /chz-km-orders/:id`, `POST /chz-km-orders/:id/retry`; `ChzKmOrderDto`, `ChzKmOrderListItemDto`, `CreateChzKmOrderDto {productId: uuid; quantity: int 1..150000; contactPerson?: string}`; preflight codes `CHZ_KM_ORDER_PREFLIGHT_CODES = ["OMS_SETTINGS_MISSING","AGENT_NOT_PAIRED","OMS_TOKEN_UNAVAILABLE","PRODUCT_NOT_FOUND","PRODUCT_ARCHIVED","PRODUCT_GTIN_MISSING","PRODUCT_GROUP_MISSING","PRODUCT_GROUP_UNSUPPORTED"]`; `ChzKmOrdersService.enqueue` uses `PgBossService.enqueueChzKmOrder` (Task 10; until then the service takes an injected `{ enqueueChzKmOrder }` interface named `ChzKmOrderQueue`).
- `ChzKmOrderDto` fields: `id, productId, productName, gtin14, productGroupAlias, templateId, quantity, state, omsOrderId, bufferStatus, bufferExpiresAt, availableCodes, fetchedCount, issuedCount, availableForIssue (= fetchedCount − issuedCount), rejectionReason, errorCode, errorMessage, attempts, createdBy: {id, name}, createdAt, updatedAt, issues: ChzKmIssueDto[]` (list items omit `issues`). `ChzKmIssueDto: {id, kind, format, fromSeq, toSeq, count, createdBy, createdAt}`.

- [ ] **Step 1: Write the failing e2e test**

`apps/api/test/chz-km-orders.e2e.test.ts`, bootstrapped like `chz-exports.e2e.test.ts` (override `OmsClient` with a fake whose every method answers `unavailable`, spy on `globalThis.fetch`, clean `chz_km_orders` rows in `afterAll`). Cases:

```ts
it("refuses an order until СУЗ settings, an agent and a token exist", async () => {
  const agent = request.agent(app!.getHttpServer());
  const tenantId = await signUpAndActivate(agent);
  const productId = await seedProduct(tenantId, {
    gtin14: "04607034690014",
    chzProductGroupCode: 12,
  });
  const res = await agent.post("/chz-km-orders").send({ productId, quantity: 10 }).expect(422);
  expect(res.body).toMatchObject({
    code: "CHZ_KM_ORDER_PREFLIGHT_FAILED",
    blockedBy: expect.arrayContaining([
      "OMS_SETTINGS_MISSING",
      "AGENT_NOT_PAIRED",
      "OMS_TOKEN_UNAVAILABLE",
    ]),
  });
});

it("creates an order in state created with the exact request body and lists it", async () => {
  const { agent, tenantId, productId } = await readyTenant(); // settings + paired agent + encrypted oms token
  const created = await agent
    .post("/chz-km-orders")
    .send({ productId, quantity: 10, contactPerson: "Ковалёва М. А." })
    .expect(201);
  expect(created.body).toMatchObject({
    state: "created",
    quantity: 10,
    gtin14: "04607034690014",
    templateId: 18,
    fetchedCount: 0,
    issuedCount: 0,
  });
  const [row] = await db
    .select()
    .from(schema.chzKmOrders)
    .where(eq(schema.chzKmOrders.id, created.body.id));
  expect(JSON.parse(row!.requestBody)).toMatchObject({
    productGroup: "beer",
    products: [
      {
        gtin: "04607034690014",
        quantity: 10,
        templateId: 18,
        cisType: "UNIT",
        serialNumberType: "OPERATOR",
      },
    ],
    attributes: {
      releaseMethodType: "PRODUCTION",
      contactPerson: "Ковалёва М. А.",
      productionOrderId: created.body.id,
    },
  });
  const list = await agent.get("/chz-km-orders").expect(200);
  expect(list.body.orders.map((o: { id: string }) => o.id)).toContain(created.body.id);
});

it("denies another tenant's order", async () => {
  const { agent, productId } = await readyTenant();
  const created = await agent.post("/chz-km-orders").send({ productId, quantity: 1 }).expect(201);
  const other = request.agent(app!.getHttpServer());
  await signUpAndActivate(other);
  await other.get(`/chz-km-orders/${created.body.id}`).expect(404);
  await other.post(`/chz-km-orders/${created.body.id}/retry`).expect(404);
});

it("refuses retry unless the order failed", async () => {
  const { agent, productId } = await readyTenant();
  const created = await agent.post("/chz-km-orders").send({ productId, quantity: 1 }).expect(201);
  await agent.post(`/chz-km-orders/${created.body.id}/retry`).expect(409);
});
```

`readyTenant()` inserts the `chestny_znak` channel settings (`environment: "sandbox"`, `omsId`, `omsConnection`), pairs an agent through `/signer-agents/pairing-code` + `/signer-agent/pair`, inserts a `chz_oms_tokens` row with `crypto.encrypt(tenantId, "tok")` and `expiresAt` one hour ahead, and seeds a product with `gtin14`, `chzProductGroupCode: 12` (beer), `status: "active"`.

- [ ] **Step 2: Run test to verify it fails**

Run: `set -a; source .env; set +a; pnpm --filter @markiro/api exec vitest run test/chz-km-orders.e2e.test.ts`
Expected: FAIL — 404 on every route (module not registered).

- [ ] **Step 3: Implement**

`dto.ts` — Zod schemas and OpenAPI objects following `chz-exports/dto.ts`:

```ts
export const createChzKmOrderSchema = z.object({
  productId: z.uuid(),
  quantity: z.number().int().min(1).max(150_000),
  contactPerson: z.string().trim().min(1).max(128).optional(),
});
export const chzKmOrderIdSchema = z.uuid();
export const CHZ_KM_ORDER_PREFLIGHT_CODES = [
  "OMS_SETTINGS_MISSING",
  "AGENT_NOT_PAIRED",
  "OMS_TOKEN_UNAVAILABLE",
  "PRODUCT_NOT_FOUND",
  "PRODUCT_ARCHIVED",
  "PRODUCT_GTIN_MISSING",
  "PRODUCT_GROUP_MISSING",
  "PRODUCT_GROUP_UNSUPPORTED",
] as const;
export const CHZ_KM_ORDER_NOT_FAILED_CODE = "CHZ_KM_ORDER_NOT_FAILED" as const;
```

plus `chzKmOrderOpenApiSchema`, `chzKmOrderListOpenApiSchema`, `createChzKmOrderOpenApiSchema` with every field of the DTOs above (`additionalProperties: false`, `required` complete).

`chz-km-orders.service.ts`:

```ts
@Injectable()
export class ChzKmOrdersService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly omsTokens: ChzOmsTokenService,
    @Inject(CHZ_KM_ORDER_QUEUE) private readonly queue: ChzKmOrderQueue,
  ) {}

  async preflight(
    tenantId: string,
    productId: string,
  ): Promise<{ blockedBy: ChzKmOrderPreflightCode[]; product: OrderProduct | null }> {
    const blocked: ChzKmOrderPreflightCode[] = [];
    const settings = await this.loadSettings(tenantId);
    if (!settings.omsId || !settings.omsConnection) blocked.push("OMS_SETTINGS_MISSING");
    const [agent] = await this.db
      .select({ id: schema.chzSignerAgents.id })
      .from(schema.chzSignerAgents)
      .where(
        and(
          eq(schema.chzSignerAgents.tenantId, tenantId),
          eq(schema.chzSignerAgents.status, "active"),
        ),
      )
      .limit(1);
    if (!agent) blocked.push("AGENT_NOT_PAIRED");
    if (!(await this.omsTokens.hasUsableToken(tenantId))) blocked.push("OMS_TOKEN_UNAVAILABLE");
    const [product] = await this.db
      .select({
        id: schema.products.id,
        name: schema.products.name,
        gtin14: schema.products.gtin14,
        archived: schema.products.archived,
        groupCode: schema.products.chzProductGroupCode,
        groupAlias: schema.chzProductGroups.alias,
      })
      .from(schema.products)
      .leftJoin(
        schema.chzProductGroups,
        eq(schema.chzProductGroups.code, schema.products.chzProductGroupCode),
      )
      .where(and(eq(schema.products.tenantId, tenantId), eq(schema.products.id, productId)));
    if (!product) return { blockedBy: [...blocked, "PRODUCT_NOT_FOUND"], product: null };
    if (product.archived) blocked.push("PRODUCT_ARCHIVED");
    if (!product.gtin14) blocked.push("PRODUCT_GTIN_MISSING");
    let templateId: number | null = null;
    if (product.groupCode === null || product.groupAlias === null)
      blocked.push("PRODUCT_GROUP_MISSING");
    else {
      templateId = chzUnitTemplateIdFor(product.groupAlias);
      if (templateId === null) blocked.push("PRODUCT_GROUP_UNSUPPORTED");
    }
    return {
      blockedBy: blocked,
      product:
        templateId === null ||
        !product.gtin14 ||
        product.groupCode === null ||
        product.groupAlias === null
          ? null
          : {
              id: product.id,
              name: product.name,
              gtin14: product.gtin14,
              groupCode: product.groupCode,
              groupAlias: product.groupAlias,
              templateId,
            },
    };
  }

  async create(
    tenantId: string,
    actorUserId: string,
    input: CreateChzKmOrderDto,
  ): Promise<ChzKmOrderDto> {
    const { blockedBy, product } = await this.preflight(tenantId, input.productId);
    if (blockedBy.length > 0 || product === null)
      throw new UnprocessableEntityException({ code: "CHZ_KM_ORDER_PREFLIGHT_FAILED", blockedBy });
    const settings = await this.loadSettings(tenantId);
    const id = randomUUID();
    const requestBody = buildChzKmOrderBody({
      productGroupAlias: product.groupAlias,
      gtin14: product.gtin14,
      quantity: input.quantity,
      templateId: product.templateId,
      contactPerson: input.contactPerson ?? settings.omsContactPerson,
      productionOrderId: id,
    });
    await this.db.insert(schema.chzKmOrders).values({
      id,
      tenantId,
      productId: product.id,
      gtin14: product.gtin14,
      productGroupAlias: product.groupAlias,
      productGroupCode: product.groupCode,
      templateId: product.templateId,
      quantity: input.quantity,
      requestBody,
      createdByUserId: actorUserId,
      deadlineAt: new Date(Date.now() + ORDER_DEADLINE_MS),
    });
    await this.queue.enqueueChzKmOrder(tenantId, id);
    return this.get(tenantId, id);
  }
  // list(tenantId), get(tenantId, id) (404 when absent), retry(tenantId, actor, id): UPDATE … SET state='created', errorCode=null, errorMessage=null, signerTaskId=null, claimedAt=null, deadlineAt=now+48h, updatedAt=now WHERE tenant_id AND id AND state='failed'; 0 rows → 409 {code: CHZ_KM_ORDER_NOT_FAILED}; then enqueue.
}
export const ORDER_DEADLINE_MS = 48 * 3600_000;
export const CHZ_KM_ORDER_QUEUE = "CHZ_KM_ORDER_QUEUE";
export interface ChzKmOrderQueue {
  enqueueChzKmOrder(tenantId: string, orderId: string): Promise<string | null>;
}
```

`get` joins `products.name` and `user.name` for `createdBy`, and selects the order's issues ordered by `createdAt desc`. `list` returns `{ orders: ChzKmOrderListItemDto[] }` ordered by `createdAt desc`, capped at 200.

`chz-km-orders.controller.ts` — `@Controller("chz-km-orders")`, `@UseGuards(TenantGuard, AuthorizationGuard, SubscriptionAccessGuard)`, `@AllowSubscriptionReadOnly("read")` on the class; reads with `@RequirePermissions(CABINET_CAPABILITY.OPERATIONS_READ)`; `POST` and `retry` with `OPERATIONS_WRITE` + `@RequireSubscriptionWrite()`; every route carries `@ApiOperation`, response schema, `@ApiZodValidationError()`, `@ApiHttpErrors(...)` (the OpenAPI coverage gate fails otherwise).

`chz-km-orders.module.ts` — `forRoot(env)` providing `OmsClient` via factory (same reason as `TrueApiClient`), `ChzOmsTokenService`, `ChzCryptoService` factory, `JournalService`, `ChzKmOrdersService`, `{ provide: CHZ_KM_ORDER_QUEUE, useExisting: PgBossService }` — `JobsModule` must export `PgBossService`; check `apps/api/src/jobs/jobs.module.ts` `exports` and how `ChzExportsModule` obtains `PgBossService` (it injects the class directly, so `JobsModule` is global or exported; follow that). Register in `app.module.ts` next to `ChzExportsModule.forRoot(env)`.

Route inventory: add `"GET /chz-km-orders (ChzKmOrdersController.list)"`, `"GET /chz-km-orders/:id (ChzKmOrdersController.get)"` to the read list and `"POST /chz-km-orders (ChzKmOrdersController.create)"`, `"POST /chz-km-orders/:id/retry (ChzKmOrdersController.retry)"` to the write list in `subscription-route-inventory.test.ts`.

OpenAPI test `chz-km-orders-openapi.test.ts`: assert the four paths exist in the generated document with the DTO schemas (copy the shape of `label-templates-openapi.test.ts`).

- [ ] **Step 4: Run tests**

Run: `set -a; source .env; set +a; pnpm --filter @markiro/api exec vitest run test/chz-km-orders.e2e.test.ts test/chz-km-orders-openapi.test.ts test/subscription-route-inventory.test.ts test/openapi-coverage.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/chz-km-orders apps/api/src/app.module.ts apps/api/test/chz-km-orders.e2e.test.ts apps/api/test/chz-km-orders-openapi.test.ts apps/api/test/subscription-route-inventory.test.ts
git commit -m "feat(api): KM order create/list/get/retry with preflight and OpenAPI"
```

---

### Task 9: Order runner state machine

**Files:**

- Create: `apps/api/src/modules/chz-km-orders/chz-km-order-runner.service.ts`
- Modify: `apps/api/src/modules/chz-km-orders/chz-km-orders.module.ts` (provide + export the runner)
- Test: `apps/api/test/chz-km-order-runner.service.test.ts`

**Interfaces:**

- Consumes: `OmsClient`, `ChzOmsTokenService`, `ChzCryptoService`, `JournalService`, `parseKm`/`kmHash` from `@markiro/domain`.
- Produces: `ChzKmOrderRunnerService.run(tenantId, orderId, attempt: {retryCount, retryLimit}): Promise<{finished: boolean; retryAfterSeconds: number}>`, `abandonAfterJobRetriesExhausted(tenantId, orderId)`, constants `MAX_SIGN_ATTEMPTS = 5`, `CODES_BLOCK_SIZE = 10_000`, error codes `CHZ_KM_ORDER_SAFE_ERROR_CODES = ["CHZ_OMS_SETTINGS_MISSING","CHZ_OMS_TOKEN_UNAVAILABLE","CHZ_SIGNING_FAILED","CHZ_ORDER_REJECTED_BY_SUZ","CHZ_ORDER_TIMED_OUT","CHZ_CODES_UNPARSEABLE","CHZ_CODES_DUPLICATE","CHZ_JOB_RETRIES_EXHAUSTED"]`.

- [ ] **Step 1: Write the failing runner test**

DB-backed like `chz-export-runner.service.test.ts`: real `Db` from `createDb`, a tenant from `createOrganization`, a product, channel settings, an encrypted `chz_oms_tokens` row, a fake `OmsClient` recording calls, and a helper `completeSignerTask(taskId)` that flips the task row to `completed` with `resultSummary: { signatureBase64: "c2ln", certThumbprint: "AB12" }`. Cases:

1. `created → signing`: `run()` inserts one `sign_detached` task whose `payload.dataBase64` decodes to `order.requestBody`, sets `signerTaskId`, returns `finished: false`.
2. Signing slot busy (a pending `sign_detached` task for the tenant already exists for another order): state stays `created`, no second task, `retryAfterSeconds` 30.
3. `signing → submitted`: after `completeSignerTask`, `createOrder` is called with the exact body and `"c2ln"`, `omsOrderId` set.
4. `submitted → buffer_pending → buffer_active → fetching → completed`: fake buffer answers `PENDING` then `ACTIVE` with `totalCodes: 25`; `getCodes` hands 10 000-sized requests trimmed to the remainder (25 codes in two blocks of 10 and 15 when `CODES_BLOCK_SIZE` is overridden to 10 in the fake through the exported constant injection point); every `chz_km_codes` row decrypts with AAD `${tenantId}/${orderId}/${seq}` to the original code, `codeHash === kmHash(parseKm(code))`, `fetchedCount === 25`, state `completed`, journal line with counts only.
5. Reconciliation before the last block: `listBlocks` reports a block the database does not hold; `retryBlock` is called for it and its codes are persisted before the final `getCodes`.
6. `REJECTED` buffer → state `rejected` with `rejectionReason` verbatim; `retry` (service) refuses it.
7. Signer task `failed` → back to `created`, `attempts` 1; after `MAX_SIGN_ATTEMPTS` failures → `failed` with `CHZ_SIGNING_FAILED`.
8. `createOrder` answers `rejected` → `failed` with `CHZ_ORDER_REJECTED_BY_SUZ` and the СУЗ message.
9. Deadline passed (`deadlineAt` in the past) with the token missing → `failed` with `CHZ_ORDER_TIMED_OUT` **before** any token lookup (assert the token service was not called).
10. A code that fails `parseKm` → `failed` with `CHZ_CODES_UNPARSEABLE`, no partial rows for that block (block insert is one transaction).

- [ ] **Step 2: Run test to verify it fails**

Run: `set -a; source .env; set +a; pnpm --filter @markiro/api exec vitest run test/chz-km-order-runner.service.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the runner**

```ts
// apps/api/src/modules/chz-km-orders/chz-km-order-runner.service.ts
import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import { kmHash, parseKm } from "@markiro/domain";
import { DB } from "../../auth/auth.module";
import { JournalService } from "../integrations/journal.service";
import { CHZ_CHANNEL_TYPE } from "../signer-agents/chz-constants";
import { ChzCryptoService } from "../signer-agents/chz-crypto.service";
import { ChzOmsTokenService } from "./chz-oms-token.service";
import { OmsClient } from "./oms.client";
import type { OmsAuth, OmsCodesBlock } from "./oms.types";

type OrderRow = typeof schema.chzKmOrders.$inferSelect;

export const MAX_SIGN_ATTEMPTS = 5;
export const CODES_BLOCK_SIZE = 10_000;
const STALE_CLAIM_MS = 5 * 60_000;
const ERROR_MESSAGE_LIMIT = 500;
const SIGN_WAIT_SECONDS = 30;
const BUFFER_POLL_SECONDS = 30;
const BUFFER_POLL_SLOW_SECONDS = 300;
const TOKEN_WAIT_SECONDS = 300;
const SLOW_POLL_AFTER_PASSES = 10;

export const CHZ_KM_ORDER_SAFE_ERROR_CODES = [
  "CHZ_OMS_SETTINGS_MISSING", "CHZ_OMS_TOKEN_UNAVAILABLE", "CHZ_SIGNING_FAILED", "CHZ_ORDER_REJECTED_BY_SUZ",
  "CHZ_ORDER_TIMED_OUT", "CHZ_CODES_UNPARSEABLE", "CHZ_CODES_DUPLICATE", "CHZ_JOB_RETRIES_EXHAUSTED",
] as const;
export type ChzKmOrderSafeErrorCode = (typeof CHZ_KM_ORDER_SAFE_ERROR_CODES)[number];

export interface AttemptContext { retryCount: number; retryLimit: number }
export interface RunOutcome { finished: boolean; retryAfterSeconds: number }

const TERMINAL = new Set<OrderRow["state"]>(["completed", "rejected", "failed"]);

@Injectable()
export class ChzKmOrderRunnerService {
  private readonly logger = new Logger(ChzKmOrderRunnerService.name);
  /** Overridable in tests to exercise multi-block fetching with small orders. */
  blockSize = CODES_BLOCK_SIZE;

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly tokens: ChzOmsTokenService,
    private readonly client: OmsClient,
    private readonly crypto: ChzCryptoService,
    private readonly journal: JournalService,
  ) {}

  async run(tenantId: string, orderId: string, attempt: AttemptContext): Promise<RunOutcome> {
    let order = await this.load(tenantId, orderId);
    if (!order || TERMINAL.has(order.state)) return { finished: true, retryAfterSeconds: 0 };
    // Deadline first, before the token: an order for a tenant whose agent never returns must still end.
    if (order.deadlineAt.getTime() < Date.now()) {
      await this.fail(order, "CHZ_ORDER_TIMED_OUT", null);
      return { finished: true, retryAfterSeconds: 0 };
    }
    if (order.state === "created") return this.startSigning(order);
    if (order.state === "signing") return this.finishSigning(order);
    const token = await this.tokens.getActiveToken(tenantId);
    if (token.status !== "ok") {
      if (token.status === "unconfigured" || token.status === "undecryptable" || token.status === "settings_missing" || attempt.retryCount >= attempt.retryLimit) {
        await this.fail(order, token.status === "settings_missing" ? "CHZ_OMS_SETTINGS_MISSING" : "CHZ_OMS_TOKEN_UNAVAILABLE", null);
        return { finished: true, retryAfterSeconds: 0 };
      }
      return { finished: false, retryAfterSeconds: TOKEN_WAIT_SECONDS };
    }
    try {
      if (order.state === "submitted" || order.state === "buffer_pending") {
        order = await this.pollBuffer(order, token.auth, attempt);
        if (!order || order.state !== "buffer_active") return { finished: order ? TERMINAL.has(order.state) : true, retryAfterSeconds: attempt.retryCount >= SLOW_POLL_AFTER_PASSES ? BUFFER_POLL_SLOW_SECONDS : BUFFER_POLL_SECONDS };
      }
      if (order.state === "buffer_active" || order.state === "fetching") {
        order = await this.fetchCodes(order, token.auth);
      }
    } catch (error) {
      if (!(error instanceof OmsUnauthorizedError)) throw error;
      await this.tokens.invalidateAndRequestRefresh(tenantId, token.obtainedAt);
      return { finished: false, retryAfterSeconds: TOKEN_WAIT_SECONDS };
    }
    return { finished: order ? TERMINAL.has(order.state) : true, retryAfterSeconds: BUFFER_POLL_SECONDS };
  }
```

Then the private steps, each fenced by `ownedOrderInState(order, state)` (same `attempts`/`claimedAt` fence idea as the export runner):

```ts
  private async startSigning(order: OrderRow): Promise<RunOutcome> {
    if (order.attempts >= MAX_SIGN_ATTEMPTS) {
      await this.fail(order, "CHZ_SIGNING_FAILED", null);
      return { finished: true, retryAfterSeconds: 0 };
    }
    const dataBase64 = Buffer.from(order.requestBody, "utf8").toString("base64");
    const inserted = await this.db.transaction(async (tx) => {
      const [task] = await tx
        .insert(schema.chzSignerTasks)
        .values({ tenantId: order.tenantId, type: "sign_detached", payload: { purpose: "oms_order", orderId: order.id, dataBase64 } })
        .onConflictDoNothing()
        .returning({ id: schema.chzSignerTasks.id });
      if (!task) return null;
      const now = new Date();
      const [updated] = await tx
        .update(schema.chzKmOrders)
        .set({ state: "signing", signerTaskId: task.id, claimedAt: now, attempts: sql`${schema.chzKmOrders.attempts} + 1`, updatedAt: now })
        .where(this.ownedOrderInState(order, "created"))
        .returning({ id: schema.chzKmOrders.id });
      return updated ? task.id : null;
    });
    if (inserted === null) return { finished: false, retryAfterSeconds: SIGN_WAIT_SECONDS };
    await this.append(order, "ok", "Заказ КМ отправлен на подпись агенту", { signerTaskId: inserted });
    return { finished: false, retryAfterSeconds: SIGN_WAIT_SECONDS };
  }

  private async finishSigning(order: OrderRow): Promise<RunOutcome> {
    if (order.signerTaskId === null) return this.reset(order);
    const [task] = await this.db.select().from(schema.chzSignerTasks)
      .where(and(eq(schema.chzSignerTasks.tenantId, order.tenantId), eq(schema.chzSignerTasks.id, order.signerTaskId)));
    if (!task || task.status === "failed" || task.status === "expired") {
      await this.append(order, "warn", "Подпись заказа КМ не получена, повтор", { signerTaskId: order.signerTaskId, taskStatus: task?.status ?? "missing" });
      return this.reset(order);
    }
    if (task.status !== "completed") return { finished: false, retryAfterSeconds: SIGN_WAIT_SECONDS };
    const signature = (task.resultSummary as { signatureBase64?: unknown } | null)?.signatureBase64;
    if (typeof signature !== "string" || signature.length === 0) return this.reset(order);
    const token = await this.tokens.getActiveToken(order.tenantId);
    if (token.status !== "ok") return { finished: false, retryAfterSeconds: TOKEN_WAIT_SECONDS };
    const created = await this.client.createOrder(token.auth, order.requestBody, signature);
    switch (created.status) {
      case "ok": {
        const now = new Date();
        await this.db.update(schema.chzKmOrders)
          .set({ state: "submitted", omsOrderId: created.value.orderId, updatedAt: now })
          .where(this.ownedOrderInState(order, "signing"));
        await this.append(order, "ok", "Заказ КМ принят СУЗ", { omsOrderId: created.value.orderId });
        return { finished: false, retryAfterSeconds: Math.max(BUFFER_POLL_SECONDS, Math.ceil(created.value.expectedCompleteMs / 1000)) };
      }
      case "unauthorized":
        await this.tokens.invalidateAndRequestRefresh(order.tenantId, token.obtainedAt);
        return { finished: false, retryAfterSeconds: TOKEN_WAIT_SECONDS };
      case "rejected":
        await this.fail(order, "CHZ_ORDER_REJECTED_BY_SUZ", created.message);
        return { finished: true, retryAfterSeconds: 0 };
      case "unavailable":
        return { finished: false, retryAfterSeconds: SIGN_WAIT_SECONDS };
    }
  }

  /** `signing → created` keeping `attempts`; the next pass creates a fresh task. */
  private async reset(order: OrderRow): Promise<RunOutcome> {
    await this.db.update(schema.chzKmOrders)
      .set({ state: "created", signerTaskId: null, claimedAt: null, updatedAt: new Date() })
      .where(this.ownedOrderInState(order, "signing"));
    return { finished: false, retryAfterSeconds: SIGN_WAIT_SECONDS };
  }

  private async pollBuffer(order: OrderRow, auth: OmsAuth, attempt: AttemptContext): Promise<OrderRow | null> {
    if (order.omsOrderId === null) return order;
    const status = await this.client.getBufferStatus(auth, order.omsOrderId, order.gtin14);
    if (status.status === "unauthorized") throw new OmsUnauthorizedError();
    if (status.status !== "ok") {
      this.logger.warn(`СУЗ buffer status ${status.status} for order ${order.id}`);
      return order;
    }
    const info = status.value;
    const now = new Date();
    const common = { bufferStatus: info.bufferStatus, availableCodes: info.availableCodes >= 0 ? info.availableCodes : null, totalPassed: info.totalPassed >= 0 ? info.totalPassed : null, bufferExpiresAt: info.expiredDate === null ? null : new Date(info.expiredDate), updatedAt: now };
    if (info.bufferStatus === "REJECTED") {
      await this.db.update(schema.chzKmOrders)
        .set({ ...common, state: "rejected", rejectionReason: (info.rejectionReason ?? "REJECTED").slice(0, ERROR_MESSAGE_LIMIT) })
        .where(this.ownedOrderInState(order, order.state));
      await this.append(order, "error", "СУЗ отклонил заказ КМ", { omsOrderId: order.omsOrderId });
      return this.load(order.tenantId, order.id);
    }
    const state = info.bufferStatus === "ACTIVE" ? "buffer_active" : "buffer_pending";
    await this.db.update(schema.chzKmOrders).set({ ...common, state }).where(this.ownedOrderInState(order, order.state));
    void attempt;
    return this.load(order.tenantId, order.id);
  }

  private async fetchCodes(order: OrderRow, auth: OmsAuth): Promise<OrderRow | null> {
    if (order.omsOrderId === null) return order;
    let current: OrderRow | null = order;
    if (current.state === "buffer_active") {
      await this.db.update(schema.chzKmOrders).set({ state: "fetching", updatedAt: new Date() }).where(this.ownedOrderInState(current, "buffer_active"));
      current = await this.load(order.tenantId, order.id);
    }
    while (current && current.state === "fetching" && current.fetchedCount < current.quantity) {
      const remaining = current.quantity - current.fetchedCount;
      const isLast = remaining <= this.blockSize;
      if (isLast) {
        // Blocks can only be re-fetched while the sub-order is open, and the
        // last code closes it: reconcile what СУЗ says it handed out against
        // what the database holds BEFORE asking for the final block.
        const reconciled = await this.reconcileBlocks(current, auth);
        if (reconciled === null) return current;
        current = reconciled;
        if (current.fetchedCount >= current.quantity) break;
      }
      const quantity = Math.min(this.blockSize, current.quantity - current.fetchedCount);
      const block = await this.client.getCodes(auth, current.omsOrderId!, current.gtin14, quantity);
      if (block.status === "unauthorized") throw new OmsUnauthorizedError();
      if (block.status === "rejected") { await this.fail(current, "CHZ_ORDER_REJECTED_BY_SUZ", block.message); return this.load(order.tenantId, order.id); }
      if (block.status !== "ok") return current;
      const stored = await this.storeBlock(current, block.value);
      if (!stored) return this.load(order.tenantId, order.id);
      current = await this.load(order.tenantId, order.id);
    }
    if (current && current.state === "fetching" && current.fetchedCount >= current.quantity) {
      await this.db.update(schema.chzKmOrders).set({ state: "completed", updatedAt: new Date() }).where(this.ownedOrderInState(current, "fetching"));
      await this.append(current, "ok", "Коды КМ получены", { omsOrderId: current.omsOrderId, quantity: current.quantity });
      current = await this.load(order.tenantId, order.id);
    }
    return current;
  }

  /** Re-fetches every block СУЗ lists that the database does not hold. Returns null when СУЗ was unavailable. */
  private async reconcileBlocks(order: OrderRow, auth: OmsAuth): Promise<OrderRow | null> {
    const listed = await this.client.listBlocks(auth, order.omsOrderId!, order.gtin14);
    if (listed.status === "unauthorized") throw new OmsUnauthorizedError();
    if (listed.status !== "ok") return null;
    const held = new Set((await this.db.selectDistinct({ blockId: schema.chzKmCodes.blockId }).from(schema.chzKmCodes)
      .where(and(eq(schema.chzKmCodes.tenantId, order.tenantId), eq(schema.chzKmCodes.orderId, order.id)))).map((row) => row.blockId));
    let current: OrderRow | null = order;
    for (const block of listed.value) {
      if (held.has(block.blockId) || !current) continue;
      const again = await this.client.retryBlock(auth, block.blockId);
      if (again.status === "unauthorized") throw new OmsUnauthorizedError();
      if (again.status !== "ok") return null;
      if (!(await this.storeBlock(current, again.value))) return this.load(order.tenantId, order.id);
      current = await this.load(order.tenantId, order.id);
    }
    return current;
  }

  /**
   * One transaction per block: rows plus the counter, so a crash leaves either
   * the whole block or none of it. A block already stored (same blockId) is a
   * no-op, which makes the СУЗ retry path idempotent.
   */
  private async storeBlock(order: OrderRow, block: OmsCodesBlock): Promise<boolean> {
    const rows: (typeof schema.chzKmCodes.$inferInsert)[] = [];
    let seq = order.fetchedCount;
    for (const code of block.codes) {
      seq += 1;
      let hash: string;
      try { hash = kmHash(parseKm(code)); } catch { await this.fail(order, "CHZ_CODES_UNPARSEABLE", null); return false; }
      const sealed = this.crypto.encryptWithAad(`${order.tenantId}/${order.id}/${seq}`, code);
      rows.push({ tenantId: order.tenantId, orderId: order.id, seq, encryptedCode: sealed.encryptedToken, codeNonce: sealed.tokenNonce, codeTag: sealed.tokenTag, codeHash: hash, blockId: block.blockId });
    }
    try {
      await this.db.transaction(async (tx) => {
        const [known] = await tx.select({ seq: schema.chzKmCodes.seq }).from(schema.chzKmCodes)
          .where(and(eq(schema.chzKmCodes.tenantId, order.tenantId), eq(schema.chzKmCodes.orderId, order.id), eq(schema.chzKmCodes.blockId, block.blockId))).limit(1);
        if (known) return;
        for (let i = 0; i < rows.length; i += 1000) await tx.insert(schema.chzKmCodes).values(rows.slice(i, i + 1000));
        const now = new Date();
        const [updated] = await tx.update(schema.chzKmOrders)
          .set({ fetchedCount: seq, updatedAt: now })
          .where(and(this.ownedOrderInState(order, "fetching"), eq(schema.chzKmOrders.fetchedCount, order.fetchedCount)))
          .returning({ id: schema.chzKmOrders.id });
        if (!updated) throw new Error("fence lost");
      });
      return true;
    } catch (error) {
      if (isUniqueViolation(error, "chz_km_codes_tenant_hash_uq")) { await this.fail(order, "CHZ_CODES_DUPLICATE", null); return false; }
      if (error instanceof Error && error.message === "fence lost") return false;
      throw error;
    }
  }

  async abandonAfterJobRetriesExhausted(tenantId: string, orderId: string): Promise<void> {
    const order = await this.load(tenantId, orderId);
    if (order && !TERMINAL.has(order.state)) await this.fail(order, "CHZ_JOB_RETRIES_EXHAUSTED", null);
  }

  private async fail(order: OrderRow, errorCode: ChzKmOrderSafeErrorCode, errorMessage: string | null): Promise<void> {
    const now = new Date();
    const updated = await this.db.update(schema.chzKmOrders)
      .set({ state: "failed", errorCode, errorMessage: errorMessage === null || errorMessage.length === 0 ? null : errorMessage.slice(0, ERROR_MESSAGE_LIMIT), updatedAt: now })
      .where(and(eq(schema.chzKmOrders.tenantId, order.tenantId), eq(schema.chzKmOrders.id, order.id), sql`${schema.chzKmOrders.state} not in ('completed', 'rejected', 'failed')`))
      .returning({ id: schema.chzKmOrders.id });
    if (updated.length) await this.append(order, "error", `Заказ КМ не выполнен: ${errorCode}`, { omsOrderId: order.omsOrderId });
  }

  private ownedOrderInState(order: OrderRow, state: OrderRow["state"]) {
    return and(eq(schema.chzKmOrders.tenantId, order.tenantId), eq(schema.chzKmOrders.id, order.id), eq(schema.chzKmOrders.state, state), eq(schema.chzKmOrders.attempts, order.attempts));
  }

  private async load(tenantId: string, orderId: string): Promise<OrderRow | null> {
    const [row] = await this.db.select().from(schema.chzKmOrders).where(and(eq(schema.chzKmOrders.tenantId, tenantId), eq(schema.chzKmOrders.id, orderId)));
    return row ?? null;
  }

  /** Counts and ids only; never a code, never a token, never an exception message. */
  private async append(order: OrderRow, outcome: "ok" | "warn" | "error", message: string, details: Record<string, unknown>): Promise<void> {
    try {
      await this.journal.append({ tenantId: order.tenantId, channelType: CHZ_CHANNEL_TYPE, sessionId: null, direction: "out", outcome, grain: "item", message, details: { orderId: order.id, ...details } });
    } catch (error) {
      this.logger.error(`Failed to journal KM order event for tenant ${order.tenantId}`, error instanceof Error ? error.stack : undefined);
    }
  }
}

class OmsUnauthorizedError extends Error {}

function isUniqueViolation(error: unknown, constraint: string): boolean {
  const err = error as { code?: string; constraint?: string; cause?: { code?: string; constraint?: string } } | null;
  const code = err?.code ?? err?.cause?.code;
  const name = err?.constraint ?? err?.cause?.constraint;
  return code === "23505" && name === constraint;
}
```

`isNull`, `lt`, `or`, `STALE_CLAIM_MS` are unused in the listing above; drop them or use them for a stale-`signing` sweep (a `signing` order whose task row vanished): keep the file lint-clean. Provide and export the runner from `ChzKmOrdersModule`.

- [ ] **Step 4: Run tests**

Run: `set -a; source .env; set +a; pnpm --filter @markiro/api exec vitest run test/chz-km-order-runner.service.test.ts`
Expected: PASS (10 cases). Then `pnpm --filter @markiro/api typecheck && pnpm --filter @markiro/api lint`.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/chz-km-orders/chz-km-order-runner.service.ts apps/api/src/modules/chz-km-orders/chz-km-orders.module.ts apps/api/test/chz-km-order-runner.service.test.ts
git commit -m "feat(api): KM order runner: sign, submit, poll buffer, fetch and reconcile code blocks"
```

---

### Task 10: pg-boss queue `run-chz-km-order`

**Files:**

- Modify: `apps/api/src/jobs/jobs.module.ts`
- Test: `apps/api/test/chz-km-order-job.test.ts`, `apps/api/test/chz-export-queue-policy.integration.test.ts` (add the new queue's policy assertion)

**Interfaces:**

- Produces: `RUN_CHZ_KM_ORDER_QUEUE = "run-chz-km-order"`, `PgBossService.enqueueChzKmOrder(tenantId, orderId): Promise<string | null>` (singleton key `${tenantId}:${orderId}`, queue policy `stately`), `MAX_KM_ORDER_PASSES = 5760` (48 h at a 30-second floor), boot `reconcileUnfinishedChzKmOrders` (non-terminal orders, capped like exports).

- [ ] **Step 1: Write the failing job test**

Copy `apps/api/test/chz-export-job.test.ts` to `chz-km-order-job.test.ts` and adapt: a fake runner returning `{ finished: false, retryAfterSeconds: 7 }` then `{ finished: true, retryAfterSeconds: 0 }`; assert the worker re-sends with `startAfter: 7` and `pass + 1`, and that `enqueueChzKmOrder` twice for the same order yields one job. Add to the queue-policy integration test an assertion that `run-chz-km-order` is created with policy `stately`.

- [ ] **Step 2: Run test to verify it fails**

Run: `set -a; source .env; set +a; pnpm --filter @markiro/api exec vitest run test/chz-km-order-job.test.ts`
Expected: FAIL — `enqueueChzKmOrder` is not a function.

- [ ] **Step 3: Implement**

In `jobs.module.ts`, next to the export queue: constants, `chzKmOrderSingletonKey`, `assertChzKmOrderQueuePolicy` (same text as the export one with the queue name substituted), `createQueue(RUN_CHZ_KM_ORDER_QUEUE, { policy: "stately", retryLimit: 5, retryDelay: 30, retryBackoff: true, retryDelayMax: 900, expireInSeconds: 900 })`, a worker identical in shape to the export one but using `chzKmOrderRunner.run(tenantId, orderId, { retryCount: pass, retryLimit: MAX_KM_ORDER_PASSES })` and `startAfter: Math.max(30, retryAfterSeconds)`; `reconcileUnfinishedChzKmOrders(boss)` selecting `chz_km_orders` with `state not in ('completed','rejected','failed')` ordered by `created_at`, limit 100, `send` with the singleton key; inject `ChzKmOrderRunnerService` into `PgBossService` and add `OmsClient` (factory), `ChzOmsTokenService`, `ChzKmOrderRunnerService` to `JobsModule` providers the same way `ChzExportRunnerService` is provided there.

- [ ] **Step 4: Run tests**

Run: `set -a; source .env; set +a; pnpm --filter @markiro/api exec vitest run test/chz-km-order-job.test.ts test/chz-export-queue-policy.integration.test.ts test/chz-km-orders.e2e.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/jobs/jobs.module.ts apps/api/test/chz-km-order-job.test.ts apps/api/test/chz-export-queue-policy.integration.test.ts
git commit -m "feat(api): run-chz-km-order queue with stately dedup and boot reconciliation"
```

---

### Task 11: Issuing codes — export file and print codes

**Files:**

- Modify: `apps/api/src/modules/chz-km-orders/dto.ts`, `chz-km-orders.service.ts`, `chz-km-orders.controller.ts`
- Modify: `apps/api/test/subscription-route-inventory.test.ts`
- Test: `apps/api/test/chz-km-orders.e2e.test.ts` (new cases), `apps/api/test/chz-km-orders-openapi.test.ts`

**Interfaces:**

- Produces: `POST /chz-km-orders/:id/issues` body `{ kind: "export", format: "txt" | "csv", count } | { kind: "print", count }` → `201 ChzKmIssueDto`; `GET /chz-km-orders/:id/issues/:issueId/file` → the file (`Content-Disposition: attachment; filename="km-<gtin>-<from>-<to>.<ext>"`, `Content-Type: text/plain; charset=utf-8` or `text/csv; charset=utf-8`, `Cache-Control: no-store`); `GET /chz-km-orders/:id/issues/:issueId/codes` → `{ codes: [{ seq, code }] }` with `Cache-Control: no-store`; error `409 { code: "CHZ_KM_ISSUE_TOO_MANY", available }` when `count` exceeds the pool; `409 { code: "CHZ_KM_ORDER_NOT_COMPLETED" }` when the order is not `completed`.

- [ ] **Step 1: Write the failing tests**

Append to `chz-km-orders.e2e.test.ts` (helper `seedCompletedOrder(tenantId, productId, codes: string[])` inserts a `completed` order with `fetchedCount = codes.length` and one `chz_km_codes` row per code encrypted with `crypto.encryptWithAad(\`${tenantId}/${orderId}/${seq}\`, code)`and`codeHash = kmHash(parseKm(code))`):

```ts
it("issues the lowest available codes contiguously and serves them as TXT", async () => {
  const { agent, tenantId, productId } = await readyTenant();
  const codes = [
    "010460703469001421AAA0001\u001d93AAAA",
    "010460703469001421AAA0002\u001d93BBBB",
    "010460703469001421AAA0003\u001d93CCCC",
  ];
  const orderId = await seedCompletedOrder(tenantId, productId, codes);
  const issue = await agent
    .post(`/chz-km-orders/${orderId}/issues`)
    .send({ kind: "export", format: "txt", count: 2 })
    .expect(201);
  expect(issue.body).toMatchObject({
    kind: "export",
    format: "txt",
    fromSeq: 1,
    toSeq: 2,
    count: 2,
  });
  const file = await agent
    .get(`/chz-km-orders/${orderId}/issues/${issue.body.id}/file`)
    .expect(200);
  expect(file.headers["content-disposition"]).toBe(
    'attachment; filename="km-04607034690014-1-2.txt"',
  );
  expect(file.headers["cache-control"]).toBe("no-store");
  expect(file.text).toBe(`${codes[0]}\n${codes[1]}\n`);
  const second = await agent
    .post(`/chz-km-orders/${orderId}/issues`)
    .send({ kind: "print", count: 1 })
    .expect(201);
  expect(second.body).toMatchObject({ fromSeq: 3, toSeq: 3 });
  const list = await agent
    .get(`/chz-km-orders/${orderId}/issues/${second.body.id}/codes`)
    .expect(200);
  expect(list.body).toEqual({ codes: [{ seq: 3, code: codes[2] }] });
  const order = await agent.get(`/chz-km-orders/${orderId}`).expect(200);
  expect(order.body).toMatchObject({ issuedCount: 3, availableForIssue: 0 });
});

it("refuses more codes than are available and issues from an uncompleted order", async () => {
  const { agent, tenantId, productId } = await readyTenant();
  const orderId = await seedCompletedOrder(tenantId, productId, [
    "010460703469001421AAA0009\u001d93AAAA",
  ]);
  const res = await agent
    .post(`/chz-km-orders/${orderId}/issues`)
    .send({ kind: "print", count: 2 })
    .expect(409);
  expect(res.body).toMatchObject({ code: "CHZ_KM_ISSUE_TOO_MANY", available: 1 });
});

it("never hands two concurrent issues the same code", async () => {
  const { agent, tenantId, productId } = await readyTenant();
  const codes = Array.from({ length: 6 }, (_, i) => `010460703469001421AAA00${i}Z\u001d93AAAA`);
  const orderId = await seedCompletedOrder(tenantId, productId, codes);
  const results = await Promise.all(
    [1, 2, 3].map(() =>
      agent.post(`/chz-km-orders/${orderId}/issues`).send({ kind: "print", count: 2 }),
    ),
  );
  expect(results.map((r) => r.status)).toEqual([201, 201, 201]);
  const ranges = results.map((r) => [r.body.fromSeq, r.body.toSeq]).sort((a, b) => a[0] - b[0]);
  expect(ranges).toEqual([
    [1, 2],
    [3, 4],
    [5, 6],
  ]);
});

it("keeps another tenant out of the file and codes endpoints", async () => {
  const { agent, tenantId, productId } = await readyTenant();
  const orderId = await seedCompletedOrder(tenantId, productId, [
    "010460703469001421AAA0008\u001d93AAAA",
  ]);
  const issue = await agent
    .post(`/chz-km-orders/${orderId}/issues`)
    .send({ kind: "export", format: "csv", count: 1 })
    .expect(201);
  const other = request.agent(app!.getHttpServer());
  await signUpAndActivate(other);
  await other.get(`/chz-km-orders/${orderId}/issues/${issue.body.id}/file`).expect(404);
  await other.get(`/chz-km-orders/${orderId}/issues/${issue.body.id}/codes`).expect(404);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `set -a; source .env; set +a; pnpm --filter @markiro/api exec vitest run test/chz-km-orders.e2e.test.ts`
Expected: FAIL — 404 on `/issues`.

- [ ] **Step 3: Implement**

`dto.ts`:

```ts
export const issueChzKmCodesSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("export"),
      format: z.enum(["txt", "csv"]),
      count: z.number().int().min(1).max(150_000),
    })
    .strict(),
  z.object({ kind: z.literal("print"), count: z.number().int().min(1).max(5_000) }).strict(),
]);
export const CHZ_KM_ISSUE_TOO_MANY_CODE = "CHZ_KM_ISSUE_TOO_MANY" as const;
export const CHZ_KM_ORDER_NOT_COMPLETED_CODE = "CHZ_KM_ORDER_NOT_COMPLETED" as const;
```

(`print` is capped at 5 000 per page because a browser print job of tens of thousands of pages is not a workable office action; exports have no such limit.)

Service:

```ts
  async issue(tenantId: string, actorUserId: string, orderId: string, input: IssueChzKmCodesDto): Promise<ChzKmIssueDto> {
    return this.db.transaction(async (tx) => {
      const [order] = await tx.select().from(schema.chzKmOrders)
        .where(and(eq(schema.chzKmOrders.tenantId, tenantId), eq(schema.chzKmOrders.id, orderId))).for("update");
      if (!order) throw new NotFoundException();
      if (order.state !== "completed") throw new ConflictException({ code: CHZ_KM_ORDER_NOT_COMPLETED_CODE });
      const available = order.fetchedCount - order.issuedCount;
      if (input.count > available) throw new ConflictException({ code: CHZ_KM_ISSUE_TOO_MANY_CODE, available });
      const fromSeq = order.issuedCount + 1;
      const toSeq = order.issuedCount + input.count;
      const [issue] = await tx.insert(schema.chzKmIssues).values({
        tenantId, orderId, kind: input.kind, format: input.kind === "export" ? input.format : null,
        fromSeq, toSeq, count: input.count, createdByUserId: actorUserId,
      }).returning();
      const marked = await tx.update(schema.chzKmCodes)
        .set({ status: "issued", issueId: issue!.id })
        .where(and(eq(schema.chzKmCodes.tenantId, tenantId), eq(schema.chzKmCodes.orderId, orderId), eq(schema.chzKmCodes.status, "available"), gte(schema.chzKmCodes.seq, fromSeq), lte(schema.chzKmCodes.seq, toSeq)))
        .returning({ seq: schema.chzKmCodes.seq });
      if (marked.length !== input.count) throw new ConflictException({ code: CHZ_KM_ISSUE_TOO_MANY_CODE, available });
      await tx.update(schema.chzKmOrders).set({ issuedCount: toSeq, updatedAt: new Date() }).where(eq(schema.chzKmOrders.id, orderId));
      return toIssueDto(issue!);
    });
  }
```

The row lock on the order serialises concurrent issues; the `marked.length` check is the backstop. `issueCodes(tenantId, orderId, issueId): Promise<{ seq: number; code: string }[]>` selects the issue (404 across tenants), then the codes `where issue_id = issueId order by seq`, decrypting each with `decryptWithAad(\`${tenantId}/${orderId}/${seq}\`, …)`. `issueFile`=`issueCodes`+`serializeKmCodesTxt`/`Csv`+`kmOrderIssueFileName(order.gtin14, fromSeq, toSeq, format)`; refuse (`409 CHZ_KM_ISSUE_NOT_EXPORT`) when the issue's `kind`is`print`.

Controller: `POST :id/issues` (`OPERATIONS_WRITE`, `@RequireSubscriptionWrite()`, `@HttpCode(201)`), `GET :id/issues/:issueId/file` and `GET :id/issues/:issueId/codes` (`OPERATIONS_READ`; read access stays available under a restricted subscription because the codes are already paid for). The file handler uses `@Res({ passthrough: true })` to set `Content-Type`, `Content-Disposition`, `Cache-Control: no-store` and returns a `StreamableFile` of the bytes; the codes handler sets `Cache-Control: no-store` via `@Header`. After each successful issue and each file/codes read call `SecurityAuditService.credentialMutation` / `sensitiveRead` with `action: "chz_km_order.issue" | "chz_km_order.codes_read"`, `resourceId: issueId` (inject `SecurityAuditService` like `signer-agents.controller.ts` does).

Route inventory: add `"POST /chz-km-orders/:id/issues (ChzKmOrdersController.issue)"` to writes and the two GETs to reads; extend the OpenAPI test with the three paths and the `ChzKmIssueDto` schema.

- [ ] **Step 4: Run tests**

Run: `set -a; source .env; set +a; pnpm --filter @markiro/api exec vitest run test/chz-km-orders.e2e.test.ts test/chz-km-orders-openapi.test.ts test/subscription-route-inventory.test.ts test/openapi-coverage.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/chz-km-orders apps/api/test/chz-km-orders.e2e.test.ts apps/api/test/chz-km-orders-openapi.test.ts apps/api/test/subscription-route-inventory.test.ts
git commit -m "feat(api): issue KM codes as TXT/CSV files or print batches, audited and tenant-scoped"
```

---

### Task 12: Label templates API — `product_km` purpose and stock seeding

**Files:**

- Modify: `apps/api/src/modules/label-templates/dto.ts:60,196,231`, `label-templates.service.ts:287-296`
- Modify: `apps/api/src/modules/platform-tenants/tenant-provisioning.service.ts:148-156`
- Test: `apps/api/test/label-templates.e2e.test.ts`, `apps/api/test/label-templates-openapi.test.ts`, the tenant-provisioning test (find with `grep -rl "buildDuplicateLabelTemplates" apps/api/test`)

- [ ] **Step 1: Write the failing tests**

In `label-templates.e2e.test.ts` add: creating a template with `purpose: "product_km"` and the stock KM spec returns 201; the same spec without its Data Matrix returns 400 with `code: "KM_LABEL_TEMPLATE_INVALID"`; listing with `enabled=all` includes the seeded «Этикетка КМ 58×40» for a freshly provisioned tenant (provisioning test) with `purpose: "product_km"`. In the OpenAPI test assert the purpose enum lists four values.

- [ ] **Step 2: Run tests to verify they fail**

Run: `set -a; source .env; set +a; pnpm --filter @markiro/api exec vitest run test/label-templates.e2e.test.ts test/label-templates-openapi.test.ts`
Expected: FAIL — 400 on `product_km`.

- [ ] **Step 3: Implement**

`dto.ts`: `const purposeSchema = z.enum(["box", "product_duplicate", "pallet", "product_km"]);` and both OpenAPI `enum` arrays. `label-templates.service.ts`:

```ts
  private assertPurposeSpec(purpose: LabelTemplatePurpose, spec: LabelTemplateSpec): void {
    const assert = purpose === "product_duplicate" ? assertDuplicateTemplate : purpose === "product_km" ? assertKmTemplate : null;
    if (assert === null) return;
    try {
      assert(spec);
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      throw new BadRequestException({ code: error.code, message: error.message });
    }
  }
```

`tenant-provisioning.service.ts`: after the duplicate loop, `for (const { name, spec } of buildKmLabelTemplates()) await tx.insert(schema.labelTemplates).values({ id: createId(), tenantId: tenant.id, name, purpose: "product_km", spec });`. Also check `shifts.service.ts:335-460` compiles unchanged (its purpose filters are equality checks, so `product_km` templates never reach the Station bundle).

- [ ] **Step 4: Run tests**

Run: `set -a; source .env; set +a; pnpm --filter @markiro/api exec vitest run test/label-templates.e2e.test.ts test/label-templates-openapi.test.ts test/label-templates.service.test.ts && pnpm --filter @markiro/api typecheck && pnpm --filter @markiro/api lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/label-templates apps/api/src/modules/platform-tenants/tenant-provisioning.service.ts apps/api/test/label-templates.e2e.test.ts apps/api/test/label-templates-openapi.test.ts
git commit -m "feat(api): product_km label purpose with validation and stock seeding"
```

---

### Task 13: Admin — sidebar regrouping

**Files:**

- Modify: `apps/admin/src/layout/AppShell.tsx:17-120`
- Modify: `apps/admin/src/i18n/ru.json`, `en.json` (`nav.kmOrders`, `shell.sections.marking`)
- Test: `apps/admin/test/nav-items.test.ts` (create; check the admin test dir name with `ls apps/admin/test` and follow it)

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { NAV_ITEMS } from "../src/layout/AppShell.js";

describe("sidebar navigation", () => {
  it("groups routes as in mockup variant B", () => {
    const bySection = new Map<string, string[]>();
    for (const item of NAV_ITEMS)
      bySection.set(item.sectionKey, [...(bySection.get(item.sectionKey) ?? []), item.to]);
    expect([...bySection.entries()]).toEqual([
      ["shell.sections.production", ["/", "/shifts", "/lines", "/conflicts"]],
      [
        "shell.sections.marking",
        ["/km-orders", "/codes", "/inventory", "/pickup", "/disaggregation"],
      ],
      ["shell.sections.reference", ["/catalog", "/labels", "/counterparties", "/employees"]],
      ["shell.sections.equipment", ["/devices", "/integrations"]],
      ["shell.sections.organization", ["/team", "/billing", "/settings"]],
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @markiro/admin exec vitest run test/nav-items.test.ts`
Expected: FAIL — order differs, no `/km-orders`.

- [ ] **Step 3: Implement**

Reorder `NAV_ITEMS` to the sequence above (every entry keeps its `capability`; `/km-orders` uses `C.OPERATIONS_READ`, key `nav.kmOrders`, section `shell.sections.marking`). Keep the `/boxes`/`/pallets` comment on the `/codes` entry. i18n: `nav.kmOrders: "Заказы кодов"` / `"Code orders"`, `shell.sections.marking: "Маркировка"` / `"Marking"`.

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @markiro/admin exec vitest run test/nav-items.test.ts && pnpm --filter @markiro/admin test`
Expected: PASS (existing shell tests that snapshot the sidebar order must be updated to the new order, not weakened).

- [ ] **Step 5: Commit**

```bash
git add apps/admin/src/layout/AppShell.tsx apps/admin/src/i18n/ru.json apps/admin/src/i18n/en.json apps/admin/test/nav-items.test.ts
git commit -m "feat(admin): regroup the sidebar with a «Маркировка» section and «Заказы кодов»"
```

---

### Task 14: Admin — KM orders API client, list page and create dialog

**Files:**

- Create: `apps/admin/src/pages/km-orders/schemas.ts`, `api.ts`, `index.tsx`, `CreateKmOrderDialog.tsx`, `km-orders.css`
- Modify: `apps/admin/src/app.tsx` (routes), `apps/admin/src/i18n/ru.json`, `en.json` (`pages.kmOrders.*`)
- Test: `apps/admin/test/km-orders-api.test.ts`, `apps/admin/test/km-orders-page.test.tsx`

**Interfaces:**

- Produces: hooks `useKmOrders()`, `useKmOrder(id)`, `useCreateKmOrder()`, `useRetryKmOrder()`, `useIssueKmCodes()`, `kmIssueFileUrl(orderId, issueId)`, `useKmIssueCodes(orderId, issueId)`; Zod `kmOrderSchema` mirroring `ChzKmOrderDto`, `KM_ORDER_STATES`.

- [ ] **Step 1: Write the failing tests**

`km-orders-api.test.ts`: with `globalThis.fetch` stubbed, `useCreateKmOrder` posts `{productId, quantity, contactPerson}` to `/api/chz-km-orders` and `useIssueKmCodes` posts `{kind:"print", count}` to `/api/chz-km-orders/:id/issues` (follow `apps/admin/test/*api*.test.ts` for the QueryClient wrapper). `km-orders-page.test.tsx`: renders `KmOrdersPage` with a mocked list containing a `completed` and a `rejected` order; expects the product names, the state chips «Завершён» and «Отклонён СУЗ», the KPI values (available to issue = sum of `availableForIssue`), and that «Заказать коды» opens the dialog with the product select and quantity input.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @markiro/admin exec vitest run test/km-orders-api.test.ts test/km-orders-page.test.tsx`
Expected: FAIL — modules missing.

- [ ] **Step 3: Implement**

`schemas.ts` — Zod schemas for the DTOs; `api.ts` — `apiFetch` wrappers and TanStack hooks (`["km-orders"]`, `["km-orders", id]` keys; `useKmOrder` refetches every 5 s while the state is non-terminal). `index.tsx` — `AdminPage` + `PageHeader` («Заказы кодов», action «Заказать коды» when `useCan(OPERATIONS_WRITE)`), `MetricStrip` with four tiles (доступно к выдаче, истекают в 14 дней, активных заказов, выдано за 30 дней — computed client-side from the list), `Table` columns per mockup 01 (product, GTIN mono, quantity, fetched, issued, available, expiry, state `StatusChip`, created) with a `Link` to the card; empty state text explaining the СУЗ prerequisites linking to `/integrations/chestny_znak`. `CreateKmOrderDialog.tsx` — `Modal` with `Select` of products (from `useProducts({})`, filtered to `gtin14 && !archived`), `Input` quantity (1..150 000), `Input` contact person, summary text; on 422 `CHZ_KM_ORDER_PREFLIGHT_FAILED` render each `blockedBy` code through `pages.kmOrders.preflight.<code>`. State labels `pages.kmOrders.state.<state>` for all nine states, chip tones: `completed` ok, `rejected`/`failed` error, `created`/`signing`/`submitted`/`buffer_pending` info, `buffer_active`/`fetching` info. Routes in `app.tsx` under the shell: `km-orders` index → `KmOrdersPage` (`OPERATIONS_READ`), `km-orders/:orderId` → `KmOrderPage` (Task 15).

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @markiro/admin exec vitest run test/km-orders-api.test.ts test/km-orders-page.test.tsx && pnpm --filter @markiro/admin typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/admin/src/pages/km-orders apps/admin/src/app.tsx apps/admin/src/i18n apps/admin/test/km-orders-api.test.ts apps/admin/test/km-orders-page.test.tsx
git commit -m "feat(admin): «Заказы кодов» list with KPI strip and order dialog"
```

---

### Task 15: Admin — order card and issue dialogs

**Files:**

- Create: `apps/admin/src/pages/km-orders/KmOrderPage.tsx`, `IssueKmCodesDialog.tsx`
- Modify: `apps/admin/src/i18n/ru.json`, `en.json`
- Test: `apps/admin/test/km-order-page.test.tsx`

- [ ] **Step 1: Write the failing test**

Render `KmOrderPage` for a mocked `completed` order with `fetchedCount: 5000`, `issuedCount: 1200`, `bufferExpiresAt` 62 days ahead and two issues. Expect: the four counters, «Выдано 1 200 из 5 000», the expiry warning text mentioning the date, the issue rows with «Печать ещё раз» / «Скачать ещё раз», the «Печать» button opening the dialog whose range preview reads «№ 1 201 – 1 700» after typing 500, and the «Выгрузить» dialog offering TXT/CSV. For a `rejected` order expect the reason text and no issue buttons.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @markiro/admin exec vitest run test/km-order-page.test.tsx`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

`KmOrderPage.tsx` per mockup 02: breadcrumb, title (product name), meta line (state chip, GTIN, group, template id), actions «Выгрузить» / «Печать» (only when `state === "completed" && availableForIssue > 0 && canWrite`), counters (`MetricStrip` or `Card`s), progress bar, `Alert tone="warning"` with the expiry sentence, «Ход заказа» list from the state and timestamps, «Сведения о заказе» `DefinitionGrid` (СУЗ order id, group, template, serial by operator, release method, payment, contact, created by), issues table with repeat actions: «Скачать ещё раз» = `window.location.assign(kmIssueFileUrl(orderId, issueId))`; «Печать ещё раз» = `window.open(\`/km-orders/${orderId}/issues/${issueId}/print\`, "_blank")`. «Повторить» button on `failed`calling`useRetryKmOrder`. `IssueKmCodesDialog.tsx`: `mode: "export" | "print"`; count `Input`with quick picks (100, 500, 1 000, all), computed range preview`№ ${issued+1} – ${issued+count}`, TXT/CSV `RadioGroup`for export, template`Select`for print (from`useLabelTemplates({ enabled: "true" })`filtered to`purpose === "product_km"`and eligible for the product's group via`chzProductGroupCodes === null || includes(groupCode)`, stock name preselected), a printer note; on submit call `useIssueKmCodes`, then for export navigate to the file URL, for print `window.open(printUrl + "?template=" + templateId, "_blank")`; map `CHZ_KM_ISSUE_TOO_MANY`to an inline error with the`available` number.

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @markiro/admin exec vitest run test/km-order-page.test.tsx && pnpm --filter @markiro/admin typecheck && pnpm --filter @markiro/admin lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/admin/src/pages/km-orders apps/admin/src/i18n apps/admin/test/km-order-page.test.tsx
git commit -m "feat(admin): KM order card with issue history and export/print dialogs"
```

---

### Task 16: Admin — print page (one label per page)

**Files:**

- Create: `apps/admin/src/pages/km-orders/KmOrderPrintPage.tsx`, `apps/admin/src/pages/km-orders/print.css`
- Modify: `apps/admin/src/app.tsx` (top-level route `/km-orders/:orderId/issues/:issueId/print` outside the shell but inside the auth guard: reuse the `ShellPage` guard chain without `AppShell` — add a `PrintShell` element that renders only `<Outlet/>` after the access gate, see `pages/Shell.tsx`)
- Test: `apps/admin/test/km-order-print-page.test.tsx`

**Interfaces:**

- Consumes: `draw(spec, ctx, scale, data, options)` from `apps/admin/src/pages/labels/renderer.ts`, `rasterizeText` from `apps/admin/src/labels/rasterizer.ts` (Cyrillic compositing exactly as `PreviewPane.tsx` does), `useKmIssueCodes`, `useLabelTemplate(templateId)`, `useKmOrder(orderId)`.

- [ ] **Step 1: Write the failing test**

Mock the order (`gtin14`, product name), the issue codes (3 codes) and a `product_km` template 58×40; render the page; expect three `section.mk-km-print__page` elements, a `<style>` tag containing `@page { size: 58mm 40mm; margin: 0 }`, the on-screen header «Выдача … · 3 этикеток» with class `mk-km-print__screen-only`, and that `window.print` (stubbed) is called once after the canvases report ready (`data-ready="true"` on every page). Under jsdom `canvas.getContext("2d")` is `null`: the page must then render an `<img>` placeholder per label without throwing, and still call `print` (test asserts no throw and one `print` call).

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @markiro/admin exec vitest run test/km-order-print-page.test.tsx`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

```tsx
// KmOrderPrintPage.tsx (core)
const PRINT_DPI = 300; // canvas resolution; the browser scales the page to the printer
export function KmOrderPrintPage() {
  const { orderId = "", issueId = "" } = useParams();
  const [search] = useSearchParams();
  const order = useKmOrder(orderId);
  const codes = useKmIssueCodes(orderId, issueId);
  const templateId = search.get("template");
  const template = useLabelTemplate(templateId);
  const spec = template.data?.spec;
  const scale = PRINT_DPI / 25.4; // px per mm
  const [ready, setReady] = useState(0);
  useEffect(() => {
    if (spec && codes.data && ready === codes.data.codes.length && codes.data.codes.length > 0)
      window.print();
  }, [ready, spec, codes.data]);
  if (!spec || !codes.data || !order.data) return <Spinner />;
  return (
    <div className="mk-km-print">
      <style>{`@page { size: ${spec.widthMm}mm ${spec.heightMm}mm; margin: 0 }`}</style>
      <header className="mk-km-print__screen-only">
        …выдача, диапазон, count, «Не печатается»…
      </header>
      {codes.data.codes.map(({ seq, code }) => (
        <section
          key={seq}
          className="mk-km-print__page"
          style={{ width: `${spec.widthMm}mm`, height: `${spec.heightMm}mm` }}
        >
          <LabelCanvas
            spec={spec}
            scale={scale}
            data={labelData(order.data, code)}
            onReady={() => setReady((n) => n + 1)}
          />
        </section>
      ))}
    </div>
  );
}
```

`labelData(order, code)` builds a `Record<LabelField, string>` from `sampleLabelData()` with `product.printName` = product print name or name, `product.gtin` = `gtin14`, `km.code` = the raw code, `sscc`/`qty`/dates = `""`. `LabelCanvas` mirrors `PreviewPane`: draws with `draw(spec, ctx, scale, data, { kmDataMatrix: "raster" })`, then composites `rasterizeText` results for text elements that need it, and calls `onReady` once (also when `getContext` returns `null`, rendering a blank `<img alt="">`). `print.css`: `.mk-km-print__page { break-after: page; overflow: hidden; background: #fff }`, `@media print { .mk-km-print__screen-only { display: none } body { margin: 0 } }`, `@media screen { .mk-km-print__page { box-shadow: var(--shadow-2); margin: 16px auto } }`.

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @markiro/admin exec vitest run test/km-order-print-page.test.tsx && pnpm --filter @markiro/admin typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/admin/src/pages/km-orders/KmOrderPrintPage.tsx apps/admin/src/pages/km-orders/print.css apps/admin/src/app.tsx apps/admin/test/km-order-print-page.test.tsx
git commit -m "feat(admin): KM print page, one label per page sized from the template"
```

---

### Task 17: Admin — editor purpose, СУЗ settings form, token status

**Files:**

- Modify: `apps/admin/src/pages/labels/preview-data.ts`, `apps/admin/src/pages/labels/editor/index.tsx`, `apps/admin/src/pages/labels/index.tsx`, `apps/admin/src/pages/labels/api.ts` (purpose union)
- Modify: `apps/admin/src/pages/integrations/ChannelPage.tsx:70-380`, `SignerAgentsPanel.tsx`, `api.ts` (overview type gains `omsToken`)
- Modify: `apps/admin/src/i18n/ru.json`, `en.json`
- Test: existing label editor tests + `apps/admin/test/channel-page-chz.test.tsx`

- [ ] **Step 1: Write the failing test**

`channel-page-chz.test.tsx`: renders the `chestny_znak` channel page with `settings: { environment: "sandbox", omsId: "…", omsConnection: "…" }`; expects three inputs labelled «Идентификатор СУЗ (omsId)», «Подключение СУЗ (omsConnection)», «Контактное лицо для заказов»; saving posts a PATCH with the trimmed values; an invalid UUID shows the field error. In the signer panel test, an overview with `omsToken.status: "active"` renders «Токен СУЗ» with the expiry.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @markiro/admin exec vitest run test/channel-page-chz.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

`preview-data.ts`: add `product_km: { ...duplicateSample }` to `SAMPLE_DATA` and `product_km: rasterOptions` to `RENDER_OPTIONS` (TypeScript already demands it after Task 2). Editor purpose picker and library filter: add the `product_km` option with label `pages.labels.purpose.product_km` = «Этикетка КМ» / «KM label». `ChannelPage.tsx`: extend the `chestny_znak` form values with `omsId`, `omsConnection`, `omsContactPerson` (UUID regex validation for the first two, both-or-none), send them in `onSave`; hint text: «Подключение регистрируется в кабинете СУЗ: Настройки → Устройства. У Markiro должно быть своё подключение». `SignerAgentsPanel.tsx`: second token row «Токен СУЗ» using the same status chip mapping as the True API token; `api.ts` overview type gains `omsToken: SignerTokenStatusDto`.

- [ ] **Step 4: Run tests and the admin gates**

Run: `pnpm --filter @markiro/admin test && pnpm --filter @markiro/admin typecheck && pnpm --filter @markiro/admin lint && pnpm --filter @markiro/admin build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/admin/src/pages/labels apps/admin/src/pages/integrations apps/admin/src/i18n
git commit -m "feat(admin): product_km in the label editor, СУЗ settings and token status"
```

---

### Task 18: Docs, runbook and final gates

**Files:**

- Modify: `docs/runbooks/signer-agent-manual-e2e.md` (sandbox section for СУЗ: register an installation with the public sandbox key `4344d884-7f21-456c-981e-cd68e92391e8` at `https://suz-integrator.sandbox.crptech.ru`, enter `omsId`/`omsConnection`, wait for the СУЗ token, order 2 codes, watch the state timeline, export TXT, print one label; record the real shapes of `simpleSignIn/{omsConnection}`, `order`, `order/status`, `codes`)
- Modify: `docs/superpowers/specs/2026-09-18-chz-km-orders-design.md` (status line → «Implemented: part A», list the three deviations)
- Modify: `README.md` Chestny ZNAK row (add «KM orders, encrypted code pool, office export/print»)

- [ ] **Step 1: Write the docs**

Add the runbook section and the spec status. No code.

- [ ] **Step 2: Run the wide gates**

Run: `set -a; source .env; set +a; pnpm turbo lint typecheck test build --filter='@markiro/domain' --filter='@markiro/db' --filter='@markiro/platform-contracts' --filter='@markiro/api' --filter='@markiro/admin' --concurrency=1 --force && pnpm format:check && git diff --check`
Expected: all green; report every `skipIf` skip (DATABASE_URL, CHZ_TOKEN_ENCRYPTION_KEY) explicitly in the PR.

- [ ] **Step 3: Commit**

```bash
git add docs/runbooks/signer-agent-manual-e2e.md docs/superpowers/specs/2026-09-18-chz-km-orders-design.md README.md
git commit -m "docs: СУЗ sandbox runbook steps and KM orders spec status"
```

---

## Self-review

**Spec coverage.** Settings (Task 5), two signer task types cloud-side (Tasks 4–5; agent side in part B), OMS client (6), token service (7), preflight/create/list/retry (8), data model and constraints (3), runner incl. reconciliation before the last block and the 48-hour deadline (9), queue with stately dedup and boot reconciliation (10), issues with contiguous ranges, file formats, no-store, audit (11), `product_km` purpose, validation and stock template (2, 12), sidebar regrouping (13), list/card/dialogs (14–15), print page with `@page` and one label per page (16), editor/settings/token status (17), runbook and docs (18). Not covered on purpose (deviations above): `km.gtin`/`km.serial` fields and per-purpose default tables.

**Placeholder scan.** `<SPEC JSON>` in Task 3 is filled by the command given in the same step; every other code block is complete.

**Type consistency.** `ChzKmOrderQueue.enqueueChzKmOrder(tenantId, orderId)` (Task 8) is what `PgBossService` implements (Task 10); `RunOutcome.retryAfterSeconds` (Task 9) is what the worker passes to `startAfter` (Task 10); `encryptWithAad`/`decryptWithAad` (Task 5) are used by the runner (9) and the issue service (11) with the same AAD string; `chzSignerTaskCompleteBodySchema` (Task 4) is the controller body type (Task 5).
