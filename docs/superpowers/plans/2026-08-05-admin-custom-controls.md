# Admin Custom Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace each browser-native control exposed by `apps/admin` with an accessible, tokenised `@markiro/ui` component.

**Architecture:** `@markiro/ui` owns public controls and composes Radix primitives. Admin forms remain controlled by React Hook Form and preserve their DTO values; ESLint blocks direct interactive JSX in `apps/admin/src`.

**Tech Stack:** React 19, TypeScript, Radix React primitives, React Hook Form, Vitest, Testing Library, ESLint flat config.

## Global Constraints

- Add Radix dependencies with exact versions through pnpm and commit manifest plus lockfile together.
- Admin source must not expose native `input`, `select`, `textarea`, `button`, `option`, or `datalist` elements.
- Keep server-facing dates as `YYYY-MM-DD`; use Russian only for display.
- Preserve existing Zod, DTO, i18n, and form-validation contracts.
- Every control needs accessible naming, keyboard interaction, visible focus, disabled and error states.
- Build `@markiro/ui` before consumer tests because apps use its compiled `dist` output.

## File map

- `packages/ui/package.json`, `pnpm-lock.yaml`: exact Radix dependencies.
- `packages/ui/src/components/{Select,Checkbox,RadioGroup,IconButton,DatePicker}.tsx`: public custom control layer.
- `packages/ui/src/components/index.ts`: exports.
- `packages/ui/test/components.test.tsx`, `packages/ui/test/date-picker.test.tsx`: interaction contracts.
- `apps/admin/src/pages/**`, `apps/admin/src/layout/Header.tsx`: consumer migration.
- `apps/admin/test/**`: behavioural and payload assertions.
- `eslint.config.mjs`: source-level native-control ban.

## Public contracts

```ts
type SelectOption = string | { value: string; label: string; disabled?: boolean };
interface SelectProps {
  options: SelectOption[];
  value?: string;
  onValueChange?: (value: string) => void;
  label?: string;
  error?: string;
  disabled?: boolean;
  name?: string;
}
interface CheckboxProps {
  label: ReactNode;
  checked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  error?: string;
  disabled?: boolean;
  name?: string;
}
interface RadioGroupProps {
  options: { value: string; label: ReactNode; disabled?: boolean }[];
  value?: string;
  onValueChange?: (value: string) => void;
  label?: string;
  error?: string;
  name?: string;
}
interface DatePickerProps {
  value?: string;
  onValueChange?: (value: string | undefined) => void;
  label?: string;
  error?: string;
  disabled?: boolean;
  name?: string;
}
interface IconButtonProps extends Omit<ButtonProps, "children"> {
  "aria-label": string;
  icon: ReactNode;
}
```

### Task 1: Establish Radix UI primitives and custom Select

**Files:** Modify `packages/ui/package.json`, `pnpm-lock.yaml`, `packages/ui/src/components/Select.tsx`, `packages/ui/src/components/index.ts`, `packages/ui/test/components.test.tsx`.

- [ ] Write failing tests: clicking `getByRole("combobox", { name: "Группа" })` reveals options; click and ArrowDown/Enter call `onValueChange`; Escape closes and restores trigger focus; disabled option cannot select.
- [ ] Run `pnpm --filter @markiro/ui exec vitest run test/components.test.tsx`; expect custom-overlay assertions to fail.
- [ ] Run `pnpm --filter @markiro/ui add --save-exact @radix-ui/react-select @radix-ui/react-checkbox @radix-ui/react-radio-group @radix-ui/react-popover`; review only the intended manifest/lockfile changes.
- [ ] Implement `Select` with `RadixSelect.Root`, `Trigger`, `Value`, `Portal`, `Content`, `Viewport`, `Item`, and `ItemIndicator`; map strings to value/label pairs, pass `value`, `onValueChange`, `name`, error ARIA, and tokenised styles.
- [ ] Run `pnpm --filter @markiro/ui exec vitest run test/components.test.tsx`; expect PASS.
- [ ] Commit: `git add packages/ui/package.json pnpm-lock.yaml packages/ui/src/components/Select.tsx packages/ui/src/components/index.ts packages/ui/test/components.test.tsx && git commit -m "feat(ui): add custom radix select"`.

### Task 2: Add Checkbox, RadioGroup, and IconButton

**Files:** Create `packages/ui/src/components/{Checkbox,RadioGroup,IconButton}.tsx`; modify `packages/ui/src/components/index.ts` and `packages/ui/test/components.test.tsx`.

- [ ] Write failing tests for `getByRole("checkbox")` calling `onCheckedChange(true)`, ArrowDown moving a radio-group choice, disabled behaviour, and icon-only button accessible name.
- [ ] Run the focused UI test; expect missing-export failures.
- [ ] Compose Radix Checkbox and Radio Group with label/hint/error wrappers and `data-state` styles. Implement `IconButton` using the existing `Button` and required `aria-label`; no visual native fallback.
- [ ] Run `pnpm --filter @markiro/ui test && pnpm --filter @markiro/ui typecheck && pnpm --filter @markiro/ui lint && pnpm --filter @markiro/ui build`; expect exit 0.
- [ ] Commit the three files, index exports, and test: `git commit -m "feat(ui): add custom choice controls"`.

### Task 3: Add a custom DatePicker

**Files:** Create `packages/ui/src/components/DatePicker.tsx`, `packages/ui/test/date-picker.test.tsx`; modify `packages/ui/src/components/index.ts`.

- [ ] Write a failing test that opens `getByRole("button", { name: /плановая дата/i })`, selects `6 августа 2026`, receives `onValueChange("2026-08-06")`, and covers Russian heading, next/previous month, Escape focus restoration, disabled state, and invalid ISO input.
- [ ] Run `pnpm --filter @markiro/ui exec vitest run test/date-picker.test.tsx`; expect missing-module failure.
- [ ] Implement a Radix Popover trigger and project calendar grid. Keep pure helpers `parseIsoDate`, `formatIsoDate`, `getCalendarDays`, and `formatRussianDate` in the module. Construct dates locally, never through UTC; each day is a labelled button and selection closes the popover.
- [ ] Run date test then full UI `test`, `typecheck`, `lint`, `build`; expect PASS.
- [ ] Commit: `git add packages/ui/src/components/DatePicker.tsx packages/ui/src/components/index.ts packages/ui/test/date-picker.test.tsx && git commit -m "feat(ui): add custom date picker"`.

### Task 4: Migrate every admin consumer

**Files:** Modify select users in `apps/admin/src/pages/{boxes,catalog,conflicts,integrations,labels,pickup,shifts,team}/**`; direct controls in `apps/admin/src/pages/shifts/ShiftForm.tsx`, `pages/integrations/{CandidatesQueue,ChannelPage}.tsx`, `pages/pickup/index.tsx`, `pages/kiosks/KioskForm.tsx`, `pages/labels/editor/{Palette,PropertiesPanel}.tsx`, and `layout/Header.tsx`; update their matching `apps/admin/test/*.test.tsx` files.

- [ ] First replace test casts `HTMLSelectElement`, `HTMLOptionElement`, and `user.selectOptions` with open/select/submit behaviour, asserting existing mutation payloads.
- [ ] Run `pnpm --filter @markiro/admin exec vitest run test/shifts.test.tsx test/catalog.test.tsx test/team.test.tsx test/integrations-channel.test.tsx`; expect old API assertions to fail.
- [ ] Convert local selects to `onValueChange`; use `Controller` for registered select, checkbox, radio, and date fields. Preserve option values and submit transforms exactly:

```tsx
<Controller
  control={control}
  name="palletsEnabled"
  render={({ field }) => (
    <Checkbox
      label={t("pages.shifts.form.palletsEnabledLabel")}
      checked={field.value}
      onCheckedChange={field.onChange}
    />
  )}
/>
```

- [ ] Use `RadioGroup` for shift mode, `Checkbox` for all current booleans/table selection, `IconButton` for Header/Palette, and `DatePicker` for `plannedDate`; preserve row `aria-label`s.
- [ ] Run `pnpm --filter @markiro/ui build && pnpm --filter @markiro/admin test && pnpm --filter @markiro/admin typecheck`; expect exit 0.
- [ ] Review explicit paths only and commit `refactor(admin): use custom controls`.

### Task 5: Enforce the policy and complete verification

**Files:** Modify `eslint.config.mjs`; update only tests that the audit proves still assert removed native select behaviour.

- [ ] Add an `apps/admin/src/**/*.{ts,tsx}` ESLint block using `no-restricted-syntax` selectors for `JSXOpeningElement[name.name='input']`, `select`, `textarea`, `button`, `option`, and `datalist`, each with a message naming the required `@markiro/ui` control.
- [ ] Run `pnpm --filter @markiro/admin lint`; resolve every reported production-source control.
- [ ] Audit with `rg -n --glob '*.{ts,tsx}' '<(input|select|textarea|button|option|datalist)\\b' apps/admin/src`; expect no output. Then run `rg -n 'HTMLSelectElement|HTMLOptionElement|selectOptions\\(' apps/admin/test`; expect no select-specific test assumption.
- [ ] Run final gates: `pnpm --filter @markiro/ui test`, `typecheck`, `lint`, `build`; then `pnpm --filter @markiro/admin test`, `typecheck`, `lint`, `build`; `pnpm format:check`; and `git diff --check`. Expect all exit 0.
- [ ] Manually inspect overlays in a browser: select/date positioning in modals, Russian labels, focus rings, disabled/error states, Escape and keyboard navigation. Report this separately from automated results.
- [ ] Commit enforcement: `git add eslint.config.mjs apps/admin/test && git commit -m "chore(admin): forbid native controls"`.

## Plan self-review

- Tasks 1–3 deliver each approved component; Task 4 migrates every known direct or shared consumer; Task 5 prevents regression and executes every required gate.
- All component names and handler types match the public contracts above.
- The plan has no deferred implementation decisions: every change has a target file, test behaviour, command, and expected result.
