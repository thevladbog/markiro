# Admin login redesign

## Status

The visual direction was approved during the 2026-08-08 review. This written specification is
ready for final user review before implementation planning.

## Context

The current tenant-admin login is a generic 380 px centered `Card` with inline layout styles. It
uses the correct shared inputs, button, validation, authentication client, translations, and theme
tokens, but it does not communicate the accepted Markiro "instrument" identity. The page has no
brand context, weak hierarchy, and no responsive composition beyond the natural width of the card.

The accepted redesign is the refined "instrument split" direction. It preserves the existing
React/Vite, React Hook Form, Zod, Better Auth, i18n, and `@markiro/ui` stack.

## Goals

1. Give `/login` a recognisable Markiro identity without turning it into a marketing page.
2. Keep the credential form visually dominant, fast to scan, and fully keyboard accessible.
3. Use the accepted IBM Plex typography, monochrome surfaces, project logo, and restrained green
   logo module.
4. Support light, dark, RU, EN, desktop, tablet, and narrow mobile layouts.
5. Preserve the current authentication request, validation, error, and redirect behavior.
6. Show a spinner without visible button text while authentication is pending.

## Scope

This change redesigns only the `/login` page. Registration guidance, owner activation, password
setup, organization creation, and organization selection keep the existing shared `AuthLayout`.
The login page receives its own semantic shell so the redesign cannot accidentally change those
flows.

## Chosen composition

### Desktop and tablet

Use a full-viewport two-column grid:

- the brand area occupies approximately 43 percent of the width;
- the login area occupies approximately 57 percent;
- the shell uses `min-height: 100dvh` and never introduces horizontal scrolling;
- the form is vertically and horizontally balanced inside the login area and is capped near
  360 px for readable field length;
- the page uses no card around the form because the split surfaces already establish hierarchy.

The two halves use inverse theme surfaces. In light theme, the brand area is dark and the form area
is light. In dark theme, the brand area is light and the form area is dark. This preserves the
approved black-and-paper contrast without introducing a purple or blue gradient.

### Narrow layout

Below 768 px, remove the decorative brand area from layout and render the appropriate project logo
in the compact login header. The form remains capped but uses the available width with 20 px side
padding. The page may scroll vertically on unusually short browser viewports, but it must not
create nested scrolling or horizontal overflow.

## Brand area

Use the existing approved Markiro logo vectors, not a reconstructed symbol. Promote exact copies
of the accepted light and dark variants from the design handoff into production-owned admin assets
so runtime code does not depend on the documentation directory.

The remaining background treatment is deliberately sparse:

- a low-contrast 24 px engineering grid;
- one clipped, low-opacity representative marking-code string near the bottom;
- a dynamic local date in the lower metadata row;
- the metadata label `MARKIRO / TENANT ADMIN`;
- no large DataMatrix, tilted square, crosshair, scan line, photo, color or background gradient, or
  looping decorative animation. The two `background-image: linear-gradient(...)` declarations that
  draw the 24 px engineering grid are structural and permitted. Beyond those grid-drawing gradients,
  the diagonal grid-opacity mask is the sole decorative gradient exception:
  `mask-image: linear-gradient(135deg, transparent 3%, black 34%, black 100%)`; it must not add
  color or background shading.

The representative code is decorative and must be hidden from assistive technology. It must not
contain a real customer code, secret, identifier, or data loaded from the server. The date is
formatted with `Intl.DateTimeFormat` using the active UI language and rendered as a semantic
`time` value.

Approved brand copy:

- heading: `Производство видно целиком.`;
- supporting text: `Смены, коды и агрегация — в одном рабочем кабинете.`;
- equivalent direct English copy is added to the EN dictionary.

The heading uses a large, tightly tracked IBM Plex Sans display treatment. Codes, date, eyebrow,
and footer metadata use IBM Plex Mono with tabular figures.

## Login area

The login area contains:

1. A compact header with language and theme controls using the existing i18n and theme systems.
2. A semantic `main` containing one login form.
3. The eyebrow `Кабинет организации`.
4. The heading `Войти` and concise instruction to use the work email and password.
5. Email and password fields using the existing `Input` component.
6. A password visibility control with translated `Показать` and `Скрыть` labels.
7. One full-width primary submit button.
8. Existing invitation-only guidance and the real `/register` information link.
9. Quiet footer metadata: `Защищённый кабинет · Markiro`.

The language and theme controls must be real controls, not static labels. They reuse existing
providers and do not add a third preference store. Controls have visible focus states and
descriptive accessible names.

## Form behavior and states

The current data flow remains unchanged:

1. React Hook Form validates the email and non-empty password with the existing Zod schema.
2. A valid submission calls `authClient.signIn.email(values)` exactly once.
3. A successful response replaces navigation with `/`.
4. A failed response keeps both field values and renders the established inline error above the
   fields.

While submission is pending:

- the button is disabled by its existing `loading` behavior;
- visible `Войти` text is removed and only the rotating spinner remains;
- a visually hidden translated `Выполняется вход` label keeps the accessible button name;
- duplicate submissions are blocked;
- field values remain visible and unchanged.

The page does not invent a forgot-password link because no request-reset route currently exists.
It also does not expose server details beyond the current safe authentication error handling.

## Motion and interaction

- Inputs, links, preference controls, password visibility, and submit have visible hover, pressed,
  and `:focus-visible` feedback.
- Transitions affect only color, opacity, and transform and remain within 120–220 ms.
- The submit spinner remains the only continuous motion because it communicates active progress;
  no decorative animation is added.
- The decorative grid and code string are static.
- No mount animation delays access to the form.

## Accessibility

- Use `header`, `main`, `form`, `footer`, `label`, and `time` semantics rather than layout-only
  `div` elements where practical.
- Keep the page title as the only `h1`.
- Preserve native email and password autocomplete values.
- The password visibility control is a real `button type="button"` and reports its state through
  its translated accessible name.
- Inline field errors remain connected through the existing `Input` `aria-describedby` behavior.
- The authentication alert is announced and is not communicated by color alone.
- Decorative pattern elements are excluded from the accessibility tree.
- Light and dark text, borders, links, and focus rings must retain WCAG AA contrast.
- Keyboard order follows the visible form order; no custom tab indices are added.

## Implementation boundary

Expected implementation areas:

- `apps/admin/src/pages/auth/Login.tsx` for semantic structure and retained authentication logic;
- a focused auth/login CSS module or stylesheet for the split layout and responsive treatment;
- production-owned admin logo assets copied exactly from the approved handoff vectors;
- `apps/admin/src/i18n/ru.json` and `apps/admin/src/i18n/en.json` for new copy and accessible labels;
- `apps/admin/test/auth-pages.test.tsx` for behavior and semantic assertions.

Do not change `AuthLayout` unless a small compatibility-only adjustment is unavoidable. Do not
change shared button loading behavior globally for this screen: the login page can provide a
visually hidden pending label as its button child while the existing `Button` renders its spinner.

## Non-goals

- No authentication API, Better Auth, session, tenant, or redirect changes.
- No redesign of the other authentication and organization pages.
- No new font, icon library, animation library, remote image, CDN, or runtime network dependency.
- No forgot-password request flow.
- No social login, SSO, passkey, or remember-me option.
- No fake operational status, customer name, factory metric, or environment badge.
- No global design-token rewrite.

## Verification

### Automated

- Extend focused login tests to cover approved RU copy and the project logo.
- Preserve the credential submission and successful redirect assertion.
- Preserve server-error and client-validation coverage, including retained field values.
- Cover password show/hide behavior and accessible labels.
- Cover the pending state: one auth call, disabled button, spinner present, visible submit text
  absent, and an accessible pending name.
- Run the focused auth test, then the complete `@markiro/admin` test, typecheck, lint, and build
  gates.
- Run `git diff --check` and the relevant formatting check.

### Browser

Confirm separately in a real browser at minimum:

- 1440×900 in light and dark themes;
- 768×1024 in light and dark themes;
- 390×844 in light and dark themes;
- no horizontal overflow, overlap, clipped focus ring, or nested page scrolling;
- keyboard-only form completion and preference controls;
- visible error, pending spinner-only button, and password visibility states;
- RU and EN strings without overflow.

Automated DOM tests do not count as visual browser acceptance. No Windows, Tauri, station,
scanner, printer, or physical-hardware verification is required because this is the web admin
login surface.
