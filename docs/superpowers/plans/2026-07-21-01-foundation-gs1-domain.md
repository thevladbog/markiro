# Plan 01: Foundation & GS1 Domain Core — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bootstrap the Markiro monorepo (pnpm + Turborepo + CI) and deliver `@markiro/domain` — the tested GS1 core (check digits, GTIN, Chestny ZNAK DataMatrix parsing, SSCC, scan classification, shift-scan validation) that the station, API and admin will all consume.

**Architecture:** pnpm workspace with Turborepo task graph; one pure-TypeScript domain package with zero runtime dependencies (runs identically in Node 24 and the Tauri webview). All validation logic is pure functions; I/O (dedup lookups) is injected.

**Tech Stack:** Node 24 LTS, pnpm 11.10, turbo 2.10, TypeScript 6.0, vitest 4.1.

## Global Constraints

- Root `.npmrc` already exists (npmjs registry, `save-exact=true`, `engine-strict=true`, `minimum-release-age=10080`) — do not modify.
- Exact versions: `turbo@2.10.4`, `typescript@6.0.3`, `vitest@4.1.10`, `@types/node@26.1.1`; `packageManager: pnpm@11.10.0`; `engines.node: ">=24"`.
- `packages/domain` must have **zero `dependencies`** — devDependencies only.
- All code TypeScript `strict`; ES modules (`"type": "module"`).
- Every commit message in English, conventional-commits style (`feat:`, `chore:`, `test:`).

---

### Task 1: Monorepo scaffold

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `tsconfig.base.json`
- Modify: `.gitignore`
- Create: `packages/domain/package.json`, `packages/domain/tsconfig.json`, `packages/domain/vitest.config.ts`, `packages/domain/src/index.ts`
- Test: `packages/domain/test/smoke.test.ts`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: workspace commands `pnpm turbo test` / `typecheck` / `build`; package name `@markiro/domain` with entry `src/index.ts` — every later task adds modules under `packages/domain/src/` and re-exports them from `src/index.ts`.

- [ ] **Step 1: Root files**

`package.json`:
```json
{
  "name": "markiro",
  "private": true,
  "packageManager": "pnpm@11.10.0",
  "engines": { "node": ">=24" },
  "scripts": {
    "build": "turbo run build",
    "test": "turbo run test",
    "typecheck": "turbo run typecheck"
  },
  "devDependencies": {
    "turbo": "2.10.4"
  }
}
```

`pnpm-workspace.yaml`:
```yaml
packages:
  - "apps/*"
  - "packages/*"
```

`turbo.json`:
```json
{
  "$schema": "https://turborepo.com/schema.json",
  "tasks": {
    "build": { "dependsOn": ["^build"], "outputs": ["dist/**"] },
    "typecheck": { "dependsOn": ["^build"] },
    "test": { "dependsOn": ["^build"] }
  }
}
```

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "declaration": true,
    "sourceMap": true
  }
}
```

Append to `.gitignore`:
```
node_modules/
dist/
.turbo/
coverage/
```

- [ ] **Step 2: Domain package skeleton**

`packages/domain/package.json`:
```json
{
  "name": "@markiro/domain",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run"
  },
  "devDependencies": {
    "@types/node": "26.1.1",
    "typescript": "6.0.3",
    "vitest": "4.1.10"
  }
}
```

`packages/domain/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src"]
}
```

`packages/domain/vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["test/**/*.test.ts"] },
});
```

`packages/domain/src/index.ts`:
```ts
export const DOMAIN_PACKAGE = "@markiro/domain";
```

`packages/domain/test/smoke.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { DOMAIN_PACKAGE } from "../src/index.js";

describe("package wiring", () => {
  it("exports the package marker", () => {
    expect(DOMAIN_PACKAGE).toBe("@markiro/domain");
  });
});
```

- [ ] **Step 3: Install and verify**

Run: `pnpm install`
Expected: lockfile created, no engine errors.

Run: `pnpm turbo test typecheck`
Expected: `@markiro/domain#test` PASS (1 test), `typecheck` PASS. Turbo summary: `Tasks: 2 successful`.

- [ ] **Step 4: Commit**

```bash
git add package.json pnpm-workspace.yaml pnpm-lock.yaml turbo.json tsconfig.base.json .gitignore packages/domain
git commit -m "chore: scaffold pnpm+turborepo monorepo with @markiro/domain package"
```

---

### Task 2: GS1 check digit

**Files:**
- Create: `packages/domain/src/gs1/check-digit.ts`
- Modify: `packages/domain/src/index.ts`
- Test: `packages/domain/test/check-digit.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `gs1CheckDigit(body: string): number` — check digit for a GS1 numeric body (GTIN-13 body = 12 digits, SSCC body = 17 digits); `hasValidCheckDigit(code: string): boolean` — validates a full code (last char is the check digit). Both throw `RangeError` on non-digit input or empty body.

- [ ] **Step 1: Write the failing test**

`packages/domain/test/check-digit.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { gs1CheckDigit, hasValidCheckDigit } from "../src/gs1/check-digit.js";

describe("gs1CheckDigit", () => {
  // GS1 General Specifications mod-10: weight 3 on the rightmost body digit,
  // alternating 3/1 leftwards.
  it("computes the GTIN-13 example check digit", () => {
    expect(gs1CheckDigit("629104150021")).toBe(3);
  });
  it("computes the EAN-13 retail example", () => {
    expect(gs1CheckDigit("400638133393")).toBe(1);
  });
  it("computes an SSCC-18 check digit (17-digit body)", () => {
    expect(gs1CheckDigit("34600682000000001")).toBe(4);
  });
  it("rejects non-digits", () => {
    expect(() => gs1CheckDigit("62910415002X")).toThrow(RangeError);
  });
  it("rejects empty input", () => {
    expect(() => gs1CheckDigit("")).toThrow(RangeError);
  });
});

describe("hasValidCheckDigit", () => {
  it("accepts valid full codes", () => {
    expect(hasValidCheckDigit("6291041500213")).toBe(true);
    expect(hasValidCheckDigit("4006381333931")).toBe(true);
  });
  it("rejects a tampered digit", () => {
    expect(hasValidCheckDigit("6291041500214")).toBe(false);
  });
  it("rejects non-numeric codes", () => {
    expect(hasValidCheckDigit("ABC")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @markiro/domain test`
Expected: FAIL — `Cannot find module '../src/gs1/check-digit.js'`.

- [ ] **Step 3: Implement**

`packages/domain/src/gs1/check-digit.ts`:
```ts
/** GS1 mod-10 check digit for a numeric body (GTIN/SSCC/GLN families). */
export function gs1CheckDigit(body: string): number {
  if (body.length === 0 || !/^\d+$/.test(body)) {
    throw new RangeError(`GS1 check digit input must be 1+ digits, got "${body}"`);
  }
  let sum = 0;
  // Rightmost body digit carries weight 3, alternating leftwards.
  for (let i = 0; i < body.length; i++) {
    const digit = body.charCodeAt(body.length - 1 - i) - 48;
    sum += i % 2 === 0 ? digit * 3 : digit;
  }
  return (10 - (sum % 10)) % 10;
}

/** Validates a complete GS1 code whose last digit is the check digit. */
export function hasValidCheckDigit(code: string): boolean {
  if (code.length < 2 || !/^\d+$/.test(code)) return false;
  return gs1CheckDigit(code.slice(0, -1)) === Number(code.at(-1));
}
```

Replace `packages/domain/src/index.ts` content:
```ts
export { gs1CheckDigit, hasValidCheckDigit } from "./gs1/check-digit.js";
```

(Delete the `DOMAIN_PACKAGE` marker export and `test/smoke.test.ts` — the real modules supersede the smoke test.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @markiro/domain test`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/domain
git commit -m "feat(domain): GS1 mod-10 check digit"
```

---

### Task 3: GTIN normalization and prefix matching

**Files:**
- Create: `packages/domain/src/gs1/gtin.ts`
- Modify: `packages/domain/src/index.ts`
- Test: `packages/domain/test/gtin.test.ts`

**Interfaces:**
- Consumes: `gs1CheckDigit`, `hasValidCheckDigit` from Task 2.
- Produces:
  - `normalizeToGtin14(input: string): string` — accepts GTIN-8/12/13/14, returns zero-padded GTIN-14; throws `DomainError("GTIN_INVALID", …)`.
  - `isValidGtin(input: string): boolean`
  - `gtinMatchesPrefix(gtin14: string, gs1Prefix: string): boolean` — true when the code's body (indicator digit stripped) starts with the org's GS1 company prefix. Used for tolling owner auto-detection.
  - `class DomainError extends Error { code: string }` (in `src/errors.ts`, created here).

- [ ] **Step 1: Write the failing test**

`packages/domain/test/gtin.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { DomainError } from "../src/errors.js";
import { gtinMatchesPrefix, isValidGtin, normalizeToGtin14 } from "../src/gs1/gtin.js";

describe("normalizeToGtin14", () => {
  it("pads EAN-13 to GTIN-14", () => {
    expect(normalizeToGtin14("4006381333931")).toBe("04006381333931");
  });
  it("keeps a valid GTIN-14 as is", () => {
    expect(normalizeToGtin14("04600682000013")).toBe("04600682000013");
  });
  it("pads GTIN-8", () => {
    // body "4600682" → GS1 mod-10 check digit 0
    expect(normalizeToGtin14("46006820")).toBe("00000046006820");
  });
  it("rejects wrong length", () => {
    expect(() => normalizeToGtin14("12345")).toThrow(DomainError);
  });
  it("rejects bad check digit with code GTIN_INVALID", () => {
    try {
      normalizeToGtin14("4006381333930");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(DomainError);
      expect((e as DomainError).code).toBe("GTIN_INVALID");
    }
  });
});

describe("isValidGtin", () => {
  it("true for valid EAN-13", () => {
    expect(isValidGtin("4006381333931")).toBe(true);
  });
  it("false for garbage", () => {
    expect(isValidGtin("hello")).toBe(false);
  });
});

describe("gtinMatchesPrefix", () => {
  it("matches when body starts with the company prefix", () => {
    expect(gtinMatchesPrefix("04600682000013", "4600682")).toBe(true);
  });
  it("does not match a foreign prefix", () => {
    expect(gtinMatchesPrefix("04006381333931", "4600682")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @markiro/domain test`
Expected: FAIL — missing modules `../src/errors.js`, `../src/gs1/gtin.js`.

- [ ] **Step 3: Implement**

`packages/domain/src/errors.ts`:
```ts
/** Domain failure with a stable machine-readable code. */
export class DomainError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DomainError";
  }
}
```

`packages/domain/src/gs1/gtin.ts`:
```ts
import { DomainError } from "../errors.js";
import { hasValidCheckDigit } from "./check-digit.js";

const GTIN_LENGTHS = new Set([8, 12, 13, 14]);

/** Zero-pads GTIN-8/12/13/14 to GTIN-14 and verifies the check digit. */
export function normalizeToGtin14(input: string): string {
  if (!/^\d+$/.test(input) || !GTIN_LENGTHS.has(input.length)) {
    throw new DomainError("GTIN_INVALID", `not a GTIN: "${input}"`);
  }
  if (!hasValidCheckDigit(input)) {
    throw new DomainError("GTIN_INVALID", `check digit mismatch: "${input}"`);
  }
  return input.padStart(14, "0");
}

export function isValidGtin(input: string): boolean {
  try {
    normalizeToGtin14(input);
    return true;
  } catch {
    return false;
  }
}

/**
 * Owner detection for tolling: strip the GTIN-14 indicator digit and test
 * whether the remaining body starts with the GS1 company prefix.
 */
export function gtinMatchesPrefix(gtin14: string, gs1Prefix: string): boolean {
  if (gtin14.length !== 14 || !/^\d+$/.test(gs1Prefix) || gs1Prefix.length === 0) {
    return false;
  }
  return gtin14.slice(1).startsWith(gs1Prefix);
}
```

Add to `packages/domain/src/index.ts`:
```ts
export { DomainError } from "./errors.js";
export { gtinMatchesPrefix, isValidGtin, normalizeToGtin14 } from "./gs1/gtin.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @markiro/domain test`
Expected: PASS (all tests, including Task 2's).

- [ ] **Step 5: Commit**

```bash
git add packages/domain
git commit -m "feat(domain): GTIN normalization, validation and GS1 prefix owner matching"
```

---

### Task 4: Chestny ZNAK DataMatrix (KM) parsing

**Files:**
- Create: `packages/domain/src/gs1/km.ts`
- Modify: `packages/domain/src/index.ts`
- Test: `packages/domain/test/km.test.ts`

**Interfaces:**
- Consumes: `normalizeToGtin14`, `DomainError` from Task 3.
- Produces:
  - `interface ParsedKm { gtin14: string; serial: string; raw: string; ais: Record<string, string> }`
  - `parseKm(raw: string): ParsedKm` — throws `DomainError` with codes `KM_EMPTY`, `KM_NO_GTIN`, `KM_NO_SERIAL`, `GTIN_INVALID`.
  - `kmKey(km: ParsedKm): string` — canonical dedup key `"01<gtin14>21<serial>"`. Later plans hash this key for storage; the key itself is the cross-terminal duplicate identity.

- [ ] **Step 1: Write the failing test**

`packages/domain/test/km.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { DomainError } from "../src/errors.js";
import { kmKey, parseKm } from "../src/gs1/km.js";

const GS = "\u001d";
// Synthetic but structurally exact Chestny ZNAK beverage code:
// AI 01 (GTIN-14, fixed 14) + AI 21 (serial, GS-terminated) + AI 93 (crypto tail).
const RAW = `010460068200001321abcDEF1234567${GS}93AbCd`;

describe("parseKm", () => {
  it("parses GTIN, serial and trailing AIs", () => {
    const km = parseKm(RAW);
    expect(km.gtin14).toBe("04600682000013");
    expect(km.serial).toBe("abcDEF1234567");
    expect(km.ais["93"]).toBe("AbCd");
    expect(km.raw).toBe(RAW);
  });
  it("strips the ]d2 symbology identifier", () => {
    expect(parseKm(`]d2${RAW}`).gtin14).toBe("04600682000013");
  });
  it("parses a serial terminated by end-of-string (no crypto tail)", () => {
    const km = parseKm("0104600682000013" + "21XyZ9");
    expect(km.serial).toBe("XyZ9");
  });
  it("rejects empty input with KM_EMPTY", () => {
    expect(() => parseKm("")).toThrowError(
      expect.objectContaining({ code: "KM_EMPTY" }),
    );
  });
  it("rejects codes not starting with AI 01 with KM_NO_GTIN", () => {
    expect(() => parseKm("21abc")).toThrowError(
      expect.objectContaining({ code: "KM_NO_GTIN" }),
    );
  });
  it("rejects a missing serial with KM_NO_SERIAL", () => {
    expect(() => parseKm("0104600682000013")).toThrowError(
      expect.objectContaining({ code: "KM_NO_SERIAL" }),
    );
  });
  it("propagates GTIN check-digit failures as DomainError", () => {
    expect(() => parseKm("010460068200001421abc")).toThrow(DomainError);
  });
});

describe("kmKey", () => {
  it("builds the canonical dedup key", () => {
    expect(kmKey(parseKm(RAW))).toBe("010460068200001321abcDEF1234567");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @markiro/domain test`
Expected: FAIL — `Cannot find module '../src/gs1/km.js'`.

- [ ] **Step 3: Implement**

`packages/domain/src/gs1/km.ts`:
```ts
import { DomainError } from "../errors.js";
import { normalizeToGtin14 } from "./gtin.js";

const GS = "\u001d";

export interface ParsedKm {
  gtin14: string;
  serial: string;
  raw: string;
  /** Trailing AIs (91/92/93…): AI → value, GS-separated in the raw code. */
  ais: Record<string, string>;
}

/**
 * Parses a Chestny ZNAK GS1 DataMatrix: `01<gtin14>21<serial><GS>…`.
 * Serial ends at the first GS or end of string. Remaining `<ai(2)><value>`
 * groups are collected verbatim into `ais`.
 */
export function parseKm(raw: string): ParsedKm {
  if (raw.length === 0) throw new DomainError("KM_EMPTY", "empty scan");
  let s = raw.startsWith("]d2") ? raw.slice(3) : raw;
  if (!s.startsWith("01")) {
    throw new DomainError("KM_NO_GTIN", "KM must start with AI 01");
  }
  const gtinDigits = s.slice(2, 16);
  const gtin14 = normalizeToGtin14(gtinDigits); // throws GTIN_INVALID
  s = s.slice(16);
  if (!s.startsWith("21") || s.length === 2) {
    throw new DomainError("KM_NO_SERIAL", "KM must carry AI 21 serial");
  }
  const gsAt = s.indexOf(GS);
  const serial = gsAt === -1 ? s.slice(2) : s.slice(2, gsAt);
  const ais: Record<string, string> = {};
  let rest = gsAt === -1 ? "" : s.slice(gsAt + 1);
  while (rest.length > 2) {
    const ai = rest.slice(0, 2);
    const end = rest.indexOf(GS);
    ais[ai] = end === -1 ? rest.slice(2) : rest.slice(2, end);
    rest = end === -1 ? "" : rest.slice(end + 1);
  }
  return { gtin14, serial, raw, ais };
}

/** Canonical duplicate-detection identity of a KM. */
export function kmKey(km: ParsedKm): string {
  return `01${km.gtin14}21${km.serial}`;
}
```

Add to `packages/domain/src/index.ts`:
```ts
export { kmKey, parseKm } from "./gs1/km.js";
export type { ParsedKm } from "./gs1/km.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @markiro/domain test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/domain
git commit -m "feat(domain): Chestny ZNAK DataMatrix parsing and dedup key"
```

---

### Task 5: SSCC generation

**Files:**
- Create: `packages/domain/src/gs1/sscc.ts`
- Modify: `packages/domain/src/index.ts`
- Test: `packages/domain/test/sscc.test.ts`

**Interfaces:**
- Consumes: `gs1CheckDigit`, `hasValidCheckDigit` (Task 2), `DomainError` (Task 3).
- Produces:
  - `buildSscc(extensionDigit: number, gs1Prefix: string, serial: number): string` — 18-digit SSCC; serial is zero-padded into the `16 - prefix.length` positions; throws `DomainError("SSCC_RANGE", …)` when the serial exceeds capacity, `DomainError("SSCC_PREFIX", …)` on a bad prefix or extension digit.
  - `isValidSscc(code: string): boolean`
  - `ssccSerialCapacity(gs1Prefix: string): number` — how many serials one prefix+extension supports (`10^(16 - prefix.length)`). Plan 06 allocates per-terminal ranges from this capacity.

- [ ] **Step 1: Write the failing test**

`packages/domain/test/sscc.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { buildSscc, isValidSscc, ssccSerialCapacity } from "../src/gs1/sscc.js";

describe("buildSscc", () => {
  it("builds ext+prefix+padded serial+check", () => {
    // body 3 4600682 000000001 → check 4 (see check-digit tests)
    expect(buildSscc(3, "4600682", 1)).toBe("346006820000000014");
  });
  it("throws SSCC_RANGE when serial exceeds capacity", () => {
    expect(() => buildSscc(3, "4600682", 10 ** 9)).toThrowError(
      expect.objectContaining({ code: "SSCC_RANGE" }),
    );
  });
  it("throws SSCC_PREFIX on non-digit prefix", () => {
    expect(() => buildSscc(3, "46A0682", 1)).toThrowError(
      expect.objectContaining({ code: "SSCC_PREFIX" }),
    );
  });
  it("throws SSCC_PREFIX on a bad extension digit", () => {
    expect(() => buildSscc(10, "4600682", 1)).toThrowError(
      expect.objectContaining({ code: "SSCC_PREFIX" }),
    );
  });
});

describe("isValidSscc", () => {
  it("accepts a built SSCC", () => {
    expect(isValidSscc(buildSscc(3, "4600682", 42))).toBe(true);
  });
  it("rejects wrong length and bad check digit", () => {
    expect(isValidSscc("12345")).toBe(false);
    expect(isValidSscc("346006820000000015")).toBe(false);
  });
});

describe("ssccSerialCapacity", () => {
  it("is 10^(16 - prefix length)", () => {
    expect(ssccSerialCapacity("4600682")).toBe(10 ** 9);
    expect(ssccSerialCapacity("460068201")).toBe(10 ** 7);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @markiro/domain test`
Expected: FAIL — `Cannot find module '../src/gs1/sscc.js'`.

- [ ] **Step 3: Implement**

`packages/domain/src/gs1/sscc.ts`:
```ts
import { DomainError } from "../errors.js";
import { gs1CheckDigit, hasValidCheckDigit } from "./check-digit.js";

/** Serials available per prefix+extension: the serial field is 16 - |prefix| digits. */
export function ssccSerialCapacity(gs1Prefix: string): number {
  return 10 ** (16 - gs1Prefix.length);
}

export function buildSscc(
  extensionDigit: number,
  gs1Prefix: string,
  serial: number,
): string {
  if (
    !Number.isInteger(extensionDigit) || extensionDigit < 0 || extensionDigit > 9 ||
    !/^\d{4,12}$/.test(gs1Prefix)
  ) {
    throw new DomainError("SSCC_PREFIX", `bad extension/prefix: ${extensionDigit}/"${gs1Prefix}"`);
  }
  const capacity = ssccSerialCapacity(gs1Prefix);
  if (!Number.isInteger(serial) || serial < 0 || serial >= capacity) {
    throw new DomainError("SSCC_RANGE", `serial ${serial} outside 0..${capacity - 1}`);
  }
  const body =
    String(extensionDigit) + gs1Prefix + String(serial).padStart(16 - gs1Prefix.length, "0");
  return body + String(gs1CheckDigit(body));
}

export function isValidSscc(code: string): boolean {
  return /^\d{18}$/.test(code) && hasValidCheckDigit(code);
}
```

Add to `packages/domain/src/index.ts`:
```ts
export { buildSscc, isValidSscc, ssccSerialCapacity } from "./gs1/sscc.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @markiro/domain test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/domain
git commit -m "feat(domain): SSCC-18 generation, validation and capacity"
```

---

### Task 6: Scan classification

**Files:**
- Create: `packages/domain/src/scan/classify.ts`
- Modify: `packages/domain/src/index.ts`
- Test: `packages/domain/test/classify.test.ts`

**Interfaces:**
- Consumes: `parseKm`, `ParsedKm` (Task 4), `isValidSscc` (Task 5), `isValidGtin`, `normalizeToGtin14` (Task 3).
- Produces:
  - `type ScanInput = { kind: "km"; km: ParsedKm } | { kind: "gtin"; gtin14: string } | { kind: "sscc"; sscc: string } | { kind: "unknown"; raw: string }`
  - `classifyScan(raw: string): ScanInput` — the single entry point every scanner event goes through (station work screens, ad-hoc shift creation, exception flows).

- [ ] **Step 1: Write the failing test**

`packages/domain/test/classify.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { classifyScan } from "../src/scan/classify.js";

describe("classifyScan", () => {
  it("classifies a KM DataMatrix", () => {
    const r = classifyScan("010460068200001321abcDEF1234567");
    expect(r.kind).toBe("km");
    if (r.kind === "km") expect(r.km.gtin14).toBe("04600682000013");
  });
  it("classifies a bare EAN-13 (shift creation scan)", () => {
    expect(classifyScan("4006381333931")).toEqual({
      kind: "gtin",
      gtin14: "04006381333931",
    });
  });
  it("classifies an SSCC label scan, with and without AI 00", () => {
    expect(classifyScan("346006820000000014")).toEqual({
      kind: "sscc",
      sscc: "346006820000000014",
    });
    expect(classifyScan("00346006820000000014")).toEqual({
      kind: "sscc",
      sscc: "346006820000000014",
    });
  });
  it("falls back to unknown", () => {
    expect(classifyScan("hello world")).toEqual({
      kind: "unknown",
      raw: "hello world",
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @markiro/domain test`
Expected: FAIL — `Cannot find module '../src/scan/classify.js'`.

- [ ] **Step 3: Implement**

`packages/domain/src/scan/classify.ts`:
```ts
import { isValidGtin, normalizeToGtin14 } from "../gs1/gtin.js";
import { parseKm, type ParsedKm } from "../gs1/km.js";
import { isValidSscc } from "../gs1/sscc.js";

export type ScanInput =
  | { kind: "km"; km: ParsedKm }
  | { kind: "gtin"; gtin14: string }
  | { kind: "sscc"; sscc: string }
  | { kind: "unknown"; raw: string };

/** Single classification point for every scanner event. */
export function classifyScan(raw: string): ScanInput {
  const trimmed = raw.trim();
  if (isValidSscc(trimmed)) return { kind: "sscc", sscc: trimmed };
  if (trimmed.startsWith("00") && isValidSscc(trimmed.slice(2))) {
    return { kind: "sscc", sscc: trimmed.slice(2) };
  }
  if (isValidGtin(trimmed)) {
    return { kind: "gtin", gtin14: normalizeToGtin14(trimmed) };
  }
  try {
    return { kind: "km", km: parseKm(trimmed) };
  } catch {
    return { kind: "unknown", raw };
  }
}
```

Add to `packages/domain/src/index.ts`:
```ts
export { classifyScan } from "./scan/classify.js";
export type { ScanInput } from "./scan/classify.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @markiro/domain test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/domain
git commit -m "feat(domain): scanner event classification (km/gtin/sscc)"
```

---

### Task 7: Shift-scan validation

**Files:**
- Create: `packages/domain/src/scan/validate.ts`
- Modify: `packages/domain/src/index.ts`
- Test: `packages/domain/test/validate.test.ts`

**Interfaces:**
- Consumes: `classifyScan` (Task 6), `kmKey` (Task 4).
- Produces:
  - `type ScanVerdict = { status: "ok"; key: string } | { status: "duplicate"; key: string } | { status: "wrong_gtin"; expectedGtin14: string; actualGtin14: string } | { status: "invalid"; raw: string }`
  - `validateShiftScan(raw: string, ctx: { expectedGtin14: string; isDuplicate(key: string): boolean }): ScanVerdict` — pure; the dedup lookup is injected. The station backs `isDuplicate` with SQLite, the server with Postgres; verdict statuses map 1:1 to the design's signal overlays (ok / ДУБЛЬ / ЧУЖОЙ ГТИН / НЕВЕРНЫЙ КОД).

- [ ] **Step 1: Write the failing test**

`packages/domain/test/validate.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { validateShiftScan } from "../src/scan/validate.js";

const KM = "010460068200001321abcDEF1234567";
const KEY = "010460068200001321abcDEF1234567";
const ctx = (dupes: string[] = []) => ({
  expectedGtin14: "04600682000013",
  isDuplicate: (key: string) => dupes.includes(key),
});

describe("validateShiftScan", () => {
  it("accepts a fresh KM of the shift's product", () => {
    expect(validateShiftScan(KM, ctx())).toEqual({ status: "ok", key: KEY });
  });
  it("flags a duplicate via the injected lookup", () => {
    expect(validateShiftScan(KM, ctx([KEY]))).toEqual({
      status: "duplicate",
      key: KEY,
    });
  });
  it("flags a foreign GTIN", () => {
    const foreign = "010400638133393121Zz1";
    expect(validateShiftScan(foreign, ctx())).toEqual({
      status: "wrong_gtin",
      expectedGtin14: "04600682000013",
      actualGtin14: "04006381333931",
    });
  });
  it("flags structurally invalid scans", () => {
    expect(validateShiftScan("garbage", ctx())).toEqual({
      status: "invalid",
      raw: "garbage",
    });
  });
  it("treats an SSCC scan on the work screen as invalid input here", () => {
    expect(validateShiftScan("346006820000000014", ctx()).status).toBe("invalid");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @markiro/domain test`
Expected: FAIL — `Cannot find module '../src/scan/validate.js'`.

- [ ] **Step 3: Implement**

`packages/domain/src/scan/validate.ts`:
```ts
import { kmKey } from "../gs1/km.js";
import { classifyScan } from "./classify.js";

export type ScanVerdict =
  | { status: "ok"; key: string }
  | { status: "duplicate"; key: string }
  | { status: "wrong_gtin"; expectedGtin14: string; actualGtin14: string }
  | { status: "invalid"; raw: string };

export interface ShiftScanContext {
  expectedGtin14: string;
  /** Injected dedup lookup: SQLite on the station, Postgres on the server. */
  isDuplicate(key: string): boolean;
}

export function validateShiftScan(raw: string, ctx: ShiftScanContext): ScanVerdict {
  const scan = classifyScan(raw);
  if (scan.kind !== "km") return { status: "invalid", raw };
  if (scan.km.gtin14 !== ctx.expectedGtin14) {
    return {
      status: "wrong_gtin",
      expectedGtin14: ctx.expectedGtin14,
      actualGtin14: scan.km.gtin14,
    };
  }
  const key = kmKey(scan.km);
  return ctx.isDuplicate(key)
    ? { status: "duplicate", key }
    : { status: "ok", key };
}
```

Add to `packages/domain/src/index.ts`:
```ts
export { validateShiftScan } from "./scan/validate.js";
export type { ScanVerdict, ShiftScanContext } from "./scan/validate.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @markiro/domain test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/domain
git commit -m "feat(domain): shift scan validation with injected dedup"
```

---

### Task 8: CI workflow and green build

**Files:**
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: workspace scripts from Task 1.
- Produces: CI gate every later plan builds on (typecheck + tests on push/PR).

- [ ] **Step 1: Workflow file**

`.github/workflows/ci.yml`:
```yaml
name: CI
on:
  push:
    branches: [main]
  pull_request:

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm turbo typecheck test build
```

- [ ] **Step 2: Full local verification (same commands as CI)**

Run: `pnpm install --frozen-lockfile && pnpm turbo typecheck test build`
Expected: all three tasks PASS for `@markiro/domain`; `dist/` produced.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "chore: CI workflow (typecheck, test, build)"
```

---

## Self-review notes

- Spec coverage: this plan covers roadmap item 01 only (scaffold + GS1 core).
  ZPL/TSPL, rasterization, DB, sync deliberately live in plans 02–07.
- Check-digit vectors verified by hand (GS1 mod-10): 629104150021→3,
  400638133393→1, 34600682000000001→4, GTIN-8 4600682→4.
- Type names consistent across tasks: `ParsedKm`, `ScanInput`, `ScanVerdict`,
  `DomainError` — defined once, imported everywhere else.
