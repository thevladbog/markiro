# Task 4 Report: Common field rules for wizard and office

## What was changed

Refactored form validation rules from the wizard to shared libraries so they can be reused by future office pages:

### Created files:

- `apps/standalone/src/lib/rules.ts` — Extracted form field validation rules: `loginRule`, `personNameRule`, `passwordRule`, `orgFieldsSchema`, plus helper functions (`characters`, `issuerPrefix`, `parsePrefixList`, `toOrgInput`, `ORG_HOST_FIELDS`)
- `apps/standalone/src/lib/time-zones.ts` — Time zone picker data: `DEFAULT_TIME_ZONE`, `TIME_ZONE_OPTIONS`
- `apps/standalone/test/rules.test.ts` — Test suite for the new libraries with 12 tests covering organization validation, user rules, and time zones

### Modified files:

- `apps/standalone/src/wizard/wizard-form.ts` — Replaced with new code importing rules from lib, removed inline rule definitions
- `apps/standalone/src/wizard/BootstrapWizard.tsx` — Updated imports, removed TIME_ZONES constant and useMemo, replaced with TIME_ZONE_OPTIONS import
- `apps/standalone/src/i18n/ru.json` — Created new top-level objects `rules` and `org` with migrated i18n keys, removed moved keys from `wizard.errors` and `wizard.org`
- `apps/standalone/test/wizard-form.test.ts` — Updated expected error message keys to use new `rules.*` namespace

## TDD Evidence

### Red run (step 2):

```
$ pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/rules.test.ts
FAIL  test/rules.test.ts
Error: Failed to resolve import "../src/lib/rules.js" from "test/rules.test.ts". Does the file exist?
```

### Green run (after creating rules.ts and time-zones.ts):

```
Test Files  1 passed (1)
     Tests  12 passed (12)
   Duration  1.02s
```

## Verification commands with results

### Package test (Step 7):

```bash
$ pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test
Test Files  15 passed (15)
     Tests  191 passed (191)
   Duration  3.83s
```

### Specific test runs:

```bash
$ pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/rules.test.ts
✓ 12 tests passed

$ pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/wizard-form.test.ts
✓ 7 tests passed

$ pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/wizard.test.tsx test/app.test.tsx
✓ 28 tests passed
```

### Typecheck (Step 7):

```bash
$ pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck
(no output = no errors, TypeScript compilation successful)
```

### Lint (Step 7):

```bash
$ pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone lint
(no output = no linting errors)
```

### Grep verification (Step 5):

```bash
$ grep -rn "wizard\.errors\.\(login\|name\|password\|passwordConfirm\|orgName\|inn\|gln\|glnCheckDigit\|gs1Prefixes\|timeZone\|rejected\)\b\|wizard\.org\.[a-zA-Z]" apps/standalone/src
/Users/thevladbog/.../src/wizard/BootstrapWizard.tsx:157:{t("wizard.org.intro")}
```

✓ Only `wizard.org.intro` remains as expected

### JSON validation:

```bash
$ node -e 'JSON.parse(require("fs").readFileSync(".../ru.json","utf8"))'
JSON is valid ✓
```

### Prettier check:

```bash
$ node_modules/.bin/prettier --write [7 files]
All matched files use Prettier code style! ✓
```

### git diff --check:

```bash
$ git diff --check
(no output = no trailing whitespace or mixed line endings)
```

## Commit

```
commit b8dd0994
Author: ...
Date:   ...

    refactor(standalone): общие правила полей мастера и офиса

    Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

Verified trailer is exactly `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` ✓

## Deviations from brief

None. All requirements followed exactly as specified:

- Test file created with exact content from brief
- Library files created with exact content from brief
- i18n keys migrated exactly as listed
- Wizard form replaced with exact code from brief
- BootstrapWizard imports and key names updated as specified
- Test expectations updated with correct new keys
- Grep verification passed
- Prettier passed
- Commit message with correct trailer

## Concerns

None. All verification steps completed successfully:

- 191 package tests passing
- All focused test suites passing (rules, wizard-form, wizard, app)
- Typecheck and lint clean
- All i18n keys properly migrated
- No `useMemo` import removed unnecessarily (none other than zones)
- All wizard display tests still pass with same Russian text (only keys changed)
