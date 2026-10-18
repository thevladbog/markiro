# Task 6 report: Мастер первого запуска

## What was implemented

Built the first-run wizard for `apps/standalone` exactly per
`.superpowers/sdd/1b2-task-6-brief.md`, Step 4, with one lint-driven deviation
(noted below):

- `apps/standalone/src/lib/form-error.ts` — `errorProp(message?: string)`,
  the same `exactOptionalPropertyTypes`-safe prop-bag helper as
  `apps/admin/src/lib/form-error.ts`.
- `apps/standalone/src/wizard/wizard-form.ts` — the framework-independent
  wizard model: `WIZARD_STEPS`, `WizardStep`, `MAX_LINES` (20),
  `DEFAULT_TIME_ZONE` (`Europe/Moscow`), `WizardValues`, `WizardField`,
  `FieldIssue`, `defaultWizardValues`, `issuerPrefix`, `parsePrefixList`,
  `validateStep` (per-step Zod + hand-rolled checks for SSCC capacity and
  line duplicates), `toBootstrapRequest` (trims/normalizes into the
  `BootstrapRequest` wire shape), `fieldFromHost` and `stepOf` (map a host
  `validation_failed` field path back to a wizard field/step).
- `apps/standalone/src/wizard/BootstrapWizard.tsx` — the five-step
  `BootstrapWizard({ onSubmit })` component (administrator, organization,
  SSCC starts, lines, review) built from `@markiro/ui` (`Card`, `Input`,
  `Button`, `IconButton`, `Combobox`, `Alert`) plus `react-hook-form`
  (`useForm`, `useFieldArray`, `Controller`). Enter/submit on a
  non-review step re-validates and advances; the review step submits,
  returns the user to the field a `HostError` (`validation_failed`)
  rejected, or shows any other failure (e.g. a `DeviceError`) in an
  `Alert` above the form.
- `apps/standalone/test/support/wizard.ts` — `completeWizard()` and
  `EXPECTED_REQUEST`, shared by this task's component test and reserved for
  Task 8.
- `apps/standalone/test/wizard-form.test.ts` (7 tests) and
  `apps/standalone/test/wizard.test.tsx` (5 tests) — the brief's tests,
  copied verbatim.
- `apps/standalone/src/i18n/ru.json` — added the top-level `wizard` key
  (title, steps, per-step copy, and `wizard.errors.*`) between the existing
  `shell` and `errors` keys, verbatim from the brief.
- `apps/standalone/src/app/shell.css` — appended the wizard/form layout
  rules (`.standalone-form`, `.standalone-form__actions`,
  `.standalone-wizard__step`/`__note`/`__line`/`__review`), verbatim from
  the brief.

## TDD evidence

**RED** — before creating the `src/wizard`/`src/lib` modules, the two new
test files were run and failed to resolve their imports:

```
$ pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/wizard-form.test.ts test/wizard.test.tsx
...
FAIL  test/wizard-form.test.ts [ test/wizard-form.test.ts ]
Error: Failed to resolve import "../src/wizard/wizard-form.js" from "test/wizard-form.test.ts". Does the file exist?
FAIL  test/wizard.test.tsx [ test/wizard.test.tsx ]
Error: Failed to resolve import "../src/wizard/BootstrapWizard.js" from "test/wizard.test.tsx". Does the file exist?

 Test Files  2 failed (2)
      Tests  no tests
[ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL] Command failed with exit code 1
EXIT_CODE=1
```

**GREEN** — after implementing the three source modules (and the one lint
fix below):

```
$ pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/wizard-form.test.ts test/wizard.test.tsx
 Test Files  2 passed (2)
      Tests  12 passed (12)
EXIT_CODE=0
```

(7 tests in `wizard-form.test.ts`, 5 in `wizard.test.tsx`, matching the
brief's expected counts exactly.)

Full package suite after implementation:

```
$ pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test
 Test Files  10 passed (10)
      Tests  99 passed (99)
TEST_EXIT=0

$ pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck
$ tsc -p tsconfig.json --noEmit
TYPECHECK_EXIT=0

$ pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone lint
$ eslint . --ignore-pattern 'target/**' --ignore-pattern 'src-tauri/gen/**' --ignore-pattern '.markiro-host/**'
LINT_EXIT=0
```

`node_modules/.bin/prettier --check` on all eight changed files: "All
matched files use Prettier code style!" `git diff --check`: clean (exit 0).

## Files changed

- `apps/standalone/src/lib/form-error.ts` (new)
- `apps/standalone/src/wizard/wizard-form.ts` (new)
- `apps/standalone/src/wizard/BootstrapWizard.tsx` (new)
- `apps/standalone/test/support/wizard.ts` (new)
- `apps/standalone/test/wizard-form.test.ts` (new)
- `apps/standalone/test/wizard.test.tsx` (new)
- `apps/standalone/src/i18n/ru.json` (modified — added `wizard` key)
- `apps/standalone/src/app/shell.css` (modified — appended wizard/form rules)

Commit: `9467c321e` — `feat(standalone): мастер первого запуска в приложении`
(trailer verified with `git log -1 --format=%B`: exactly
`Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`).

## Deviations from the brief's code

One, forced by `lint`, not by `test` or `typecheck`:

- **`BootstrapWizardProps.onSubmit`**: the brief writes it as a TS
  method-shorthand signature, `onSubmit(request: BootstrapRequest):
Promise<void>;`. ESLint's `@typescript-eslint/unbound-method` flagged the
  destructuring `{ onSubmit }: BootstrapWizardProps` in the component
  signature (`error A method that is not declared with 'this: void' may
cause unintentional scoping of 'this'...`). Changed the interface member
  to a function-typed property instead:
  `onSubmit: (request: BootstrapRequest) => Promise<void>;`. This is a
  type-declaration-only change — the call site (`await
onSubmit(toBootstrapRequest(values))`) and every test's runtime behavior
  are unaffected — and it matches the existing convention in this
  repository for callback props (e.g.
  `apps/admin/src/pages/kiosks/KioskProfileForm.tsx:32`,
  `onSubmit: (input: CreateKioskInput) => Promise<boolean>;`), which is in
  fact the _only_ other `onSubmit` prop type in the repo and already uses
  this style.

No other changes were needed: the rest of the brief's code (Zod schemas,
`validateStep`, `toBootstrapRequest`, `fieldFromHost`/`stepOf`, the
`register(\`lines.${index}.name\`)` field-array path, the exhaustive
`switch` in `validateStep`, `Controller`/`Combobox` wiring, etc.) compiled
and passed as given under `noUncheckedIndexedAccess` and
`exactOptionalPropertyTypes` without modification, contrary to my initial
suspicion (based on an `as const` precedent elsewhere in the repo for a
structurally similar `register(\`...${index}...\` as const)`call) that the
field-array registration might need an`as const` cast — it did not.

## Concerns

- **Browser/manual verification not performed and not applicable here.**
  `BootstrapWizard` takes `onSubmit` as a plain prop and performs no Tauri
  IPC or host I/O itself, so there is nothing in this task's scope for a
  live host/Windows/browser check to exercise; Task 8 (wiring the wizard
  into `App.tsx`/the real `onSubmit`) is where that end-to-end,
  possibly-manual verification belongs.
- **`build` was not run** for `@markiro/standalone` — the task instructions
  and the brief's Step 5 both scope the final gate to `test`, `typecheck`,
  and `lint` only. `test`/`typecheck` already exercise the same TypeScript
  sources a `build` would bundle, so I judged this sufficient for this
  task; flagging in case Task 8's integration wants a `build` re-check.
- **i18n key placement**: the brief's JSON snippet for the `wizard` key
  isn't anchored to a specific position in `ru.json`; I inserted it between
  the existing `shell` and `errors` top-level keys (alphabetically/
  logically between them) since the brief only said "add a top-level key",
  not where. This has no behavioral effect (object key order is
  irrelevant to `i18next`/JSON), noted only for completeness.
- Did not touch `apps/standalone/src/app/App.tsx` or any Task 8 file —
  out of this task's scope per the brief and the file-ownership table in
  `1b2-constraints.md`.
