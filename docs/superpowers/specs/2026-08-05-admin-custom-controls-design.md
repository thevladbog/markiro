# Admin custom controls design

## Status

Approved design; implementation starts only after review of this document.

## Goal

The customer admin application must never expose browser-native interactive
control UI. Every interactive control in `apps/admin` must be rendered through
the public API of `@markiro/ui` and styled with the Markiro design tokens.

This is a visual and behavioural requirement, not a ban on semantic HTML inside
the component implementation. `@markiro/ui` may use the native elements needed
for accessible semantics, but it must replace the browser's native select,
checkbox, radio, and date-picker interfaces with the project UI.

## Scope

The first implementation wave provides these `@markiro/ui` controls:

| Component    | Foundation                                             | Public behaviour                                                                                |
| ------------ | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `Select`     | Radix Select                                           | Custom trigger and option list, disabled options, keyboard selection, Escape and outside-close. |
| `Checkbox`   | Radix Checkbox                                         | Custom checked, unchecked, disabled, error, and label states.                                   |
| `RadioGroup` | Radix Radio Group                                      | Custom mutually-exclusive options with arrow-key navigation.                                    |
| `IconButton` | Existing `Button` extended or a dedicated wrapper      | Tokenised icon action with required accessible name.                                            |
| `DatePicker` | Radix Popover plus an internal tokenised calendar grid | Date entry and calendar selection without a browser date picker.                                |
| `Combobox`   | Radix Popover when required by large searchable lists  | Custom searchable selection; not introduced until a current admin use case needs it.            |

Radix supplies accessible interaction primitives. It does not supply the
calendar grid itself, so `DatePicker` composes a Radix popover with a
project-owned calendar view rather than exposing a native `input[type=date]`.

The migration covers every direct interactive control in `apps/admin/src`,
including the existing direct checkbox/radio uses and header icon buttons. It
also replaces the current `@markiro/ui/Select`, whose implementation is a
styled native `<select>`.

`packages/ui` is the only allowed location for low-level DOM implementation of
these primitives. The policy does not prohibit static semantic markup or the
internal input element needed by an existing custom `Input` component.

## Component contracts

Controls are controlled from application code:

- `Select` and `RadioGroup`: `value` and `onValueChange(value)`.
- `Checkbox`: `checked` and `onCheckedChange(checked)`.
- `DatePicker`: ISO `value` and `onValueChange(value)`, where a populated value
  is always `YYYY-MM-DD`.
- `IconButton`: uses the button action contract and requires `aria-label` when
  it has no visible text.

Components accept the existing label, hint, error, disabled, id, and className
patterns where relevant. They generate and connect accessible labels and error
descriptions consistently with the current `Input` and `Field` components.

`react-hook-form` integrations use `Controller` when a field currently relies
on a native `register()` change event. Zod validation, DTOs, API payloads, and
server date formats remain unchanged. A date picker only changes presentation:
the API still receives `YYYY-MM-DD`.

## Interaction and accessibility

- All controls have an accessible name, visible focus indicator, disabled and
  error states, and token-based visual states.
- Select and date-picker overlays open through an accessible trigger, close on
  Escape and outside interaction, preserve their value, and restore focus to
  the trigger.
- Select supports keyboard navigation and activation; disabled options cannot
  be selected.
- Radio groups support arrow-key movement in the group.
- Checkboxes expose their checked state to assistive technology.
- The date picker is localised for Russian presentation; its external value is
  ISO. It must not invoke the browser's calendar UI.

## Migration order

1. Add exact, reviewed Radix React primitive dependencies and make them direct
   dependencies of `@markiro/ui`.
2. Replace the internal implementation of `Select` and add its interaction
   tests before migrating consumers.
3. Add `Checkbox`, `RadioGroup`, and `IconButton`, each with focused tests.
4. Add the Radix-backed `DatePicker` and its Russian calendar and ISO-contract
   tests.
5. Convert every relevant `apps/admin/src` form, filter, table selection, and
   header action. Use `Controller` where React Hook Form needs an adapter.
6. Replace tests that assert native-element casts or `<option>` markup with
   user-visible interaction and form-payload assertions.
7. Add a source-level lint rule for `apps/admin/src` that prevents direct use
   of native `select`, `input[type=date|checkbox|radio]`, and `button`.
   Document tightly-scoped technical exceptions if any are proven necessary.

## Verification

`@markiro/ui` component tests must cover mouse and keyboard interaction,
focus restoration, disabled behaviour, errors, and accessible state for each
new primitive. Admin tests must cover form validation and unchanged request
payloads after migration.

The final gate includes:

- a repository audit of `apps/admin/src` for prohibited control markup;
- `@markiro/ui` test, typecheck, lint, and build;
- the focused and package-level admin checks affected by the migration;
- a rebuild of `@markiro/ui` before running its consumer tests;
- `git diff --check` and proportionate formatting checks.

Automated DOM tests prove interaction contracts but do not replace a manual
browser review of visual consistency, overlay positioning, and focus appearance.
