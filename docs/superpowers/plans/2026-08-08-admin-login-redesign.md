# Admin Login Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the generic tenant-admin login card with the approved responsive Markiro instrument-split screen while preserving the existing authentication contract.

**Architecture:** Keep authentication and validation in `Login.tsx`, and add a focused `LoginShell` presentation component for the brand area, date, language control, theme control, and responsive shell. Use a page-local stylesheet and exact copies of the approved logo vectors; leave the shared `AuthLayout` and shared `Button` behavior unchanged.

**Tech Stack:** React 19, TypeScript 6 strict mode, React Router 8, React Hook Form, Zod, i18next, `@markiro/ui`, Vitest, Testing Library, Vite CSS.

## Global Constraints

- Redesign only `/login`; do not change the other authentication or organization screens.
- Preserve `authClient.signIn.email(values)` and successful `navigate("/", { replace: true })` behavior.
- Use only local IBM Plex fonts, existing Markiro tokens, and exact approved logo vectors.
- Add no dependency, CDN, remote image, forgot-password flow, social login, SSO, passkey, remember-me option, fake customer data, or operational metric.
- Desktop split is approximately 43/57; below 768 px, omit the decorative brand panel and keep the form full-width within 20 px side padding.
- Brand background contains only the 24 px grid, representative code string, local date, and lower metadata; no DataMatrix, large square, crosshair, scan line, color or background gradient, photo, or decorative animation. The sole gradient exception is the grid-opacity mask: `mask-image: linear-gradient(135deg, transparent 3%, black 34%, black 100%)`.
- Pending submission shows the existing rotating spinner with no visible button text and a translated visually hidden accessible label.
- Preserve RU/EN, `light`/`dark`/`system`, keyboard operation, native autocomplete, visible focus, and WCAG AA contrast.
- Report automated DOM checks separately from browser layout acceptance.

## File Structure

- Create `apps/admin/src/pages/auth/LoginShell.tsx`: presentation-only login shell, preference controls, logo selection, decorative brand metadata, and localized date.
- Create `apps/admin/src/pages/auth/login.css`: page-local split layout, responsive behavior, grid pattern, form polish, preference controls, and password-toggle styling.
- Create `apps/admin/src/assets/markiro-logo-on-light.svg`: exact approved `logo.svg` vector for light surfaces.
- Create `apps/admin/src/assets/markiro-logo-on-dark.svg`: exact approved `logo-dark.svg` vector for dark surfaces.
- Modify `apps/admin/src/pages/auth/Login.tsx`: retain auth flow; render the new shell, password visibility, and spinner-only pending label.
- Modify `apps/admin/src/i18n/ru.json`: approved Russian brand copy, controls, and accessible labels.
- Modify `apps/admin/src/i18n/en.json`: direct English equivalents.
- Modify `apps/admin/test/auth-pages.test.tsx`: focused shell, preference, password, pending, retained-value, and submission tests.

---

### Task 1: Branded responsive login shell

**Files:**

- Create: `apps/admin/src/pages/auth/LoginShell.tsx`
- Create: `apps/admin/src/pages/auth/login.css`
- Create: `apps/admin/src/assets/markiro-logo-on-light.svg`
- Create: `apps/admin/src/assets/markiro-logo-on-dark.svg`
- Modify: `apps/admin/src/i18n/ru.json:19-28`
- Modify: `apps/admin/src/i18n/en.json:19-28`
- Modify: `apps/admin/src/pages/auth/Login.tsx:1-74`
- Test: `apps/admin/test/auth-pages.test.tsx:1-48,160-212`

**Interfaces:**

- Consumes: `useTheme(): { theme: "light" | "dark" | "system"; setTheme(theme): void }`, `useTranslation()`, existing `Input`, `Button`, and `Alert` primitives.
- Produces: `LoginShell({ children }: { children: ReactNode }): JSX.Element`; CSS hooks prefixed `mk-login-page__`; i18n keys under `auth.login` used by Task 2.

- [ ] **Step 1: Write failing shell and preference tests**

Import `ThemeProvider` and `i18n`. Make the shared auth-page render helper provide the theme context without changing its routing behavior:

```tsx
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ThemeProvider } from "@markiro/ui";
import i18n from "../src/i18n/index.js";

afterEach(async () => {
  cleanup();
  localStorage.clear();
  vi.useRealTimers();
  await i18n.changeLanguage("ru");
  vi.unstubAllGlobals();
});

// Inside renderRouted, immediately below QueryClientProvider:
<ThemeProvider>
  <MemoryRouter initialEntries={[initialPath]}>
    <AuthClientProvider client={client}>
      <Routes>
        <Route path={routePath} element={element} />
        <Route path="/" element={<div>SHELL_PLACEHOLDER</div>} />
        <Route path="/login" element={<div>LOGIN_PAGE</div>} />
      </Routes>
    </AuthClientProvider>
  </MemoryRouter>
</ThemeProvider>;
```

Add these tests to `describe("LoginPage")`:

```tsx
it("renders the approved Markiro login shell and local date", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-08T09:00:00+03:00"));

  renderRouted(createFakeAuthClient(), "/login", <LoginPage />);

  expect(screen.getByRole("img", { name: "Маркиро" })).toBeDefined();
  expect(screen.getByRole("heading", { level: 1, name: "Войти" })).toBeDefined();
  expect(screen.getByText("Производство видно целиком.")).toBeDefined();
  expect(screen.getByText("Смены, коды и агрегация — в одном рабочем кабинете.")).toBeDefined();
  const date = screen.getByText("08.08.2026").closest("time");
  expect(date).not.toBeNull();
  expect(date?.getAttribute("datetime")).toBe("2026-08-08");
  expect(date?.textContent).toBe("08.08.2026");
  expect(screen.getByRole("main")).toBeDefined();
});

it("changes language from the public login header", async () => {
  renderRouted(createFakeAuthClient(), "/login", <LoginPage />);

  fireEvent.click(screen.getByRole("button", { name: "Переключить язык" }));

  expect(await screen.findByRole("heading", { level: 1, name: "Sign in" })).toBeDefined();
  expect(screen.getByText("See production as a whole.")).toBeDefined();
  expect(screen.getByRole("button", { name: "Switch language" })).toBeDefined();
});

it("cycles the persisted theme preference", async () => {
  renderRouted(createFakeAuthClient(), "/login", <LoginPage />);
  const themeButton = screen.getByRole("button", { name: /Переключить тему/ });

  expect(themeButton.textContent).toBe("Системная тема");
  fireEvent.click(themeButton);

  await waitFor(() => expect(themeButton.textContent).toBe("Светлая тема"));
  expect(localStorage.getItem("markiro.theme")).toBe("light");
  expect(document.documentElement.dataset.theme).toBe("light");
});
```

In the existing `renders labels from the RU dictionary` test, replace the obsolete
`screen.getByText("Вход")` assertion with
`screen.getByRole("heading", { level: 1, name: "Войти" })`.

- [ ] **Step 2: Run the focused tests and confirm the expected failure**

Run:

```bash
pnpm --filter @markiro/admin exec vitest run test/auth-pages.test.tsx
```

Expected: the new tests fail because the brand copy, logo, `time`, preference controls, and `ThemeProvider`-consuming shell do not exist yet. Existing login submission tests must still pass up to those new assertions.

- [ ] **Step 3: Add exact production-owned logo assets**

Copy the approved vectors byte-for-byte rather than redrawing them:

```text
docs/design-briefs/design_handoff_markiro/design-system/assets/logo.svg
  -> apps/admin/src/assets/markiro-logo-on-light.svg

docs/design-briefs/design_handoff_markiro/design-system/assets/logo-dark.svg
  -> apps/admin/src/assets/markiro-logo-on-dark.svg
```

Verify both new files retain `viewBox="0 0 280 64"`, the IBM Plex Mono wordmark, and the single `#3DDC7A` module. Do not change the source files under `docs/design-briefs`.

- [ ] **Step 4: Add exact RU and EN copy**

Extend `auth.login` in both dictionaries. Keep every existing key and add these exact keys:

```json
// ru.json
{
  "brandHeading": "Производство видно целиком.",
  "brandBody": "Смены, коды и агрегация — в одном рабочем кабинете.",
  "eyebrow": "Кабинет организации",
  "instruction": "Используйте рабочую электронную почту и пароль.",
  "protectedCabinet": "Защищённый кабинет · Markiro",
  "toggleLanguage": "Переключить язык",
  "toggleTheme": "Переключить тему. Сейчас: {{theme}}",
  "themeSystem": "Системная тема",
  "themeLight": "Светлая тема",
  "themeDark": "Тёмная тема",
  "logoAlt": "Маркиро"
}
```

```json
// en.json
{
  "brandHeading": "See production as a whole.",
  "brandBody": "Shifts, codes, and aggregation in one working cabinet.",
  "eyebrow": "Organization cabinet",
  "instruction": "Use your work email and password.",
  "protectedCabinet": "Secure cabinet · Markiro",
  "toggleLanguage": "Switch language",
  "toggleTheme": "Switch theme. Current: {{theme}}",
  "themeSystem": "System theme",
  "themeLight": "Light theme",
  "themeDark": "Dark theme",
  "logoAlt": "Markiro"
}
```

Change the existing `auth.login.title` values to `Войти` and `Sign in` so the page heading matches the approved design.

- [ ] **Step 5: Implement `LoginShell`**

Create `LoginShell.tsx` with this interface and behavior:

```tsx
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { type Theme, useTheme } from "@markiro/ui";

import logoOnDark from "../../assets/markiro-logo-on-dark.svg";
import logoOnLight from "../../assets/markiro-logo-on-light.svg";
import "./login.css";

const NEXT_THEME: Record<Theme, Theme> = {
  system: "light",
  light: "dark",
  dark: "system",
};

const THEME_KEY: Record<Theme, string> = {
  system: "auth.login.themeSystem",
  light: "auth.login.themeLight",
  dark: "auth.login.themeDark",
};

const DECORATIVE_CODE = "01 04607012345678 21 KQ4D8N7X2 91 EE06 92 F8C3B7A1D9";

export function LoginShell({ children }: { children: ReactNode }) {
  const { t, i18n } = useTranslation();
  const { theme, setTheme } = useTheme();
  const language = i18n.resolvedLanguage === "en" ? "en" : "ru";
  const nextLanguage = language === "ru" ? "en" : "ru";
  const now = new Date();
  const dateTime = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("-");
  const formattedDate = new Intl.DateTimeFormat(language === "ru" ? "ru-RU" : "en-GB", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(now);
  const themeLabel = t(THEME_KEY[theme]);

  return (
    <div className="mk-login-page">
      <section className="mk-login-page__brand" aria-labelledby="login-brand-heading">
        <div className="mk-login-page__grid" aria-hidden="true" />
        <div className="mk-login-page__code" aria-hidden="true">
          {DECORATIVE_CODE}
        </div>
        <picture
          className="mk-login-page__brand-logo"
          role="img"
          aria-label={t("auth.login.logoAlt")}
        >
          <img
            className="mk-login-page__logo-on-light"
            src={logoOnLight}
            alt=""
            aria-hidden="true"
          />
          <img className="mk-login-page__logo-on-dark" src={logoOnDark} alt="" aria-hidden="true" />
        </picture>
        <div className="mk-login-page__brand-copy">
          <h2 id="login-brand-heading">{t("auth.login.brandHeading")}</h2>
          <p>{t("auth.login.brandBody")}</p>
        </div>
        <div className="mk-login-page__brand-meta">
          <span>MARKIRO / TENANT ADMIN</span>
          <time dateTime={dateTime}>{formattedDate}</time>
        </div>
      </section>

      <section className="mk-login-page__login">
        <header className="mk-login-page__header">
          <picture className="mk-login-page__mobile-logo" aria-hidden="true">
            <img className="mk-login-page__logo-on-light" src={logoOnLight} alt="" />
            <img className="mk-login-page__logo-on-dark" src={logoOnDark} alt="" />
          </picture>
          <button
            type="button"
            onClick={() => void i18n.changeLanguage(nextLanguage)}
            aria-label={t("auth.login.toggleLanguage")}
          >
            {language.toUpperCase()}
          </button>
          <button
            type="button"
            onClick={() => setTheme(NEXT_THEME[theme])}
            aria-label={t("auth.login.toggleTheme", { theme: themeLabel })}
          >
            {themeLabel}
          </button>
        </header>
        <main className="mk-login-page__main">{children}</main>
        <footer className="mk-login-page__footer">{t("auth.login.protectedCabinet")}</footer>
      </section>
    </div>
  );
}
```

The `picture` owns the single accessible image role; both CSS-selected source images remain decorative. The accessible tree must therefore expose exactly one `Маркиро`/`Markiro` image in every theme.

- [ ] **Step 6: Implement the approved page-local CSS**

Create `login.css` with the exact structural values below, then add token-based hover/focus rules for the two header buttons and password button. The sole permitted gradient declaration is the diagonal `mask-image: linear-gradient(135deg, transparent 3%, black 34%, black 100%)` grid-opacity fade; do not add color or background gradients.

```css
.mk-login-page {
  min-height: 100dvh;
  display: grid;
  grid-template-columns: minmax(280px, 43%) minmax(0, 57%);
  overflow-x: hidden;
  background: var(--surface-page);
}

.mk-login-page__brand {
  position: relative;
  isolation: isolate;
  min-width: 0;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  padding: clamp(24px, 3vw, 48px);
  overflow: hidden;
  background: var(--surface-inverse);
  color: var(--fg-on-inverse);
}

.mk-login-page__grid {
  position: absolute;
  z-index: -2;
  inset: 0;
  opacity: 0.12;
  color: currentColor;
  background-image:
    linear-gradient(currentColor 1px, transparent 1px),
    linear-gradient(90deg, currentColor 1px, transparent 1px);
  background-size: 24px 24px;
  mask-image: linear-gradient(135deg, transparent 3%, black 34%, black 100%);
}

.mk-login-page__code {
  position: absolute;
  z-index: -1;
  left: -18px;
  bottom: 76px;
  width: 160%;
  overflow: hidden;
  opacity: 0.14;
  font: var(--text-code);
  letter-spacing: 0.06em;
  white-space: nowrap;
  transform: rotate(-4deg);
}

.mk-login-page__brand-copy h2 {
  max-width: 10ch;
  margin: 0;
  font: 700 clamp(40px, 5vw, 68px) / 0.95 var(--font-ui);
  letter-spacing: -0.065em;
  text-wrap: balance;
}

.mk-login-page__brand-copy p {
  max-width: 34ch;
  margin: 24px 0 0;
  color: color-mix(in srgb, currentColor 68%, transparent);
  font: var(--text-body);
}

.mk-login-page__brand-meta,
.mk-login-page__footer {
  font: var(--text-meta);
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.06em;
}

.mk-login-page__brand-meta {
  display: flex;
  justify-content: space-between;
  gap: var(--sp-4);
  color: color-mix(in srgb, currentColor 52%, transparent);
}

.mk-login-page__login {
  min-width: 0;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
}

.mk-login-page__header {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: var(--sp-4);
  padding: var(--sp-6) var(--sp-7);
}

.mk-login-page__header button,
.mk-login-page__password-toggle {
  min-height: var(--control-sm);
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--fg-3);
  font: var(--text-meta);
  cursor: pointer;
}

.mk-login-page__header button:hover,
.mk-login-page__password-toggle:hover {
  color: var(--fg-1);
}

.mk-login-page__header button:focus-visible,
.mk-login-page__password-toggle:focus-visible,
.mk-login-page a:focus-visible {
  outline: var(--focus-ring-w) solid var(--focus-ring);
  outline-offset: var(--focus-ring-offset);
}

.mk-login-page__main {
  display: grid;
  place-items: center;
  padding: var(--sp-7);
}

.mk-login-page__form {
  width: min(100%, 360px);
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
}

.mk-login-page__form h1 {
  margin: 0;
  font: 700 38px/1 var(--font-ui);
  letter-spacing: -0.055em;
}

.mk-login-page__eyebrow {
  margin-bottom: -4px;
  color: var(--fg-3);
  font: var(--text-meta);
  letter-spacing: 0.09em;
  text-transform: uppercase;
}

.mk-login-page__instruction,
.mk-login-page__help {
  margin: 0;
  color: var(--fg-3);
  font: var(--text-body-sm);
}

.mk-login-page__instruction {
  margin-bottom: var(--sp-2);
}

.mk-login-page__help a {
  color: var(--fg-1);
  text-underline-offset: 3px;
}

.mk-login-page__footer {
  padding: var(--sp-5) var(--sp-7);
  color: var(--fg-3);
}

.mk-login-page__mobile-logo {
  display: none;
}

[data-theme="light"] .mk-login-page__brand .mk-login-page__logo-on-light,
[data-theme="dark"] .mk-login-page__brand .mk-login-page__logo-on-dark,
[data-theme="light"] .mk-login-page__mobile-logo .mk-login-page__logo-on-dark,
[data-theme="dark"] .mk-login-page__mobile-logo .mk-login-page__logo-on-light {
  display: none;
}

@media (max-width: 767px) {
  .mk-login-page {
    grid-template-columns: minmax(0, 1fr);
  }

  .mk-login-page__brand {
    display: none;
  }

  .mk-login-page__header {
    justify-content: flex-end;
    padding: var(--sp-5);
  }

  .mk-login-page__mobile-logo {
    display: block;
    width: 104px;
    margin-right: auto;
  }

  .mk-login-page__main {
    place-items: start center;
    padding: var(--sp-8) var(--sp-5) var(--sp-6);
  }

  .mk-login-page__footer {
    padding: var(--sp-5);
  }
}
```

Give both logo images `display: block; width: 140px; height: auto`, and give form paragraphs/links margins explicitly so no browser-default spacing leaks into the final layout.

- [ ] **Step 7: Wrap the existing login form without changing authentication**

In `Login.tsx`, replace `AuthLayout` only for this page:

```tsx
return (
  <LoginShell>
    <form className="mk-login-page__form" onSubmit={(event) => void onSubmit(event)} noValidate>
      <span className="mk-login-page__eyebrow">{t("auth.login.eyebrow")}</span>
      <h1>{t("auth.login.title")}</h1>
      <p className="mk-login-page__instruction">{t("auth.login.instruction")}</p>
      {submitError && <Alert tone="error">{submitError}</Alert>}
      <Input
        type="email"
        autoComplete="email"
        label={t("auth.login.emailLabel")}
        {...errorProp(errors.email?.message)}
        {...register("email")}
      />
      <Input
        type="password"
        autoComplete="current-password"
        label={t("auth.login.passwordLabel")}
        {...errorProp(errors.password?.message)}
        {...register("password")}
      />
      <Button type="submit" loading={isSubmitting} fullWidth>
        {t("auth.login.submit")}
      </Button>
      <p className="mk-login-page__help">
        {t("auth.login.noAccount")} <Link to="/register">{t("auth.login.registerLink")}</Link>
      </p>
    </form>
  </LoginShell>
);
```

Move existing inline styles into `login.css`. Do not change `loginSchema`, `handleSubmit`, the auth call, or navigation.

- [ ] **Step 8: Run the focused test and static checks**

Run:

```bash
pnpm --filter @markiro/admin exec vitest run test/auth-pages.test.tsx
pnpm --filter @markiro/admin typecheck
node_modules/.bin/prettier --check apps/admin/src/pages/auth/Login.tsx apps/admin/src/pages/auth/LoginShell.tsx apps/admin/src/pages/auth/login.css apps/admin/src/i18n/ru.json apps/admin/src/i18n/en.json apps/admin/test/auth-pages.test.tsx
```

Expected: focused auth tests pass, TypeScript resolves both SVG imports through `vite/client`, and formatting passes.

- [ ] **Step 9: Commit the shell**

Stage only Task 1 paths, inspect the staged diff, then commit:

```bash
git add apps/admin/src/assets/markiro-logo-on-light.svg apps/admin/src/assets/markiro-logo-on-dark.svg apps/admin/src/pages/auth/LoginShell.tsx apps/admin/src/pages/auth/login.css apps/admin/src/pages/auth/Login.tsx apps/admin/src/i18n/ru.json apps/admin/src/i18n/en.json apps/admin/test/auth-pages.test.tsx
git diff --cached --check
git commit -m "feat(admin): add branded login shell"
```

### Task 2: Password visibility and spinner-only pending state

**Files:**

- Modify: `apps/admin/src/pages/auth/Login.tsx`
- Modify: `apps/admin/src/pages/auth/login.css`
- Modify: `apps/admin/src/i18n/ru.json`
- Modify: `apps/admin/src/i18n/en.json`
- Test: `apps/admin/test/auth-pages.test.tsx`

**Interfaces:**

- Consumes: `LoginShell`, `mk-login-page__password-toggle`, existing `Input.suffix`, `Button.loading`, and `mk-visually-hidden` from `@markiro/ui`.
- Produces: local `passwordVisible: boolean`; translated `showPassword`, `hidePassword`, and `submitting` labels; spinner-only visible pending state.

- [ ] **Step 1: Write failing password-toggle and pending tests**

Add exact keys before rendering these tests so test-mode i18n still fails on accidental omissions:

Also add `within` to the existing Testing Library import; Task 2 uses it to inspect only the submit button's visible children.

```json
// ru.json
"showPassword": "Показать",
"hidePassword": "Скрыть",
"showPasswordLabel": "Показать пароль",
"hidePasswordLabel": "Скрыть пароль",
"submitting": "Выполняется вход"

// en.json
"showPassword": "Show",
"hidePassword": "Hide",
"showPasswordLabel": "Show password",
"hidePasswordLabel": "Hide password",
"submitting": "Signing in"
```

Add to `describe("LoginPage")`:

```tsx
it("toggles password visibility without changing its value", () => {
  renderRouted(createFakeAuthClient(), "/login", <LoginPage />);
  const password = screen.getByLabelText("Пароль") as HTMLInputElement;
  fireEvent.change(password, { target: { value: "hunter2!" } });

  expect(password.type).toBe("password");
  fireEvent.click(screen.getByRole("button", { name: "Показать пароль" }));
  expect(password.type).toBe("text");
  expect(password.value).toBe("hunter2!");
  fireEvent.click(screen.getByRole("button", { name: "Скрыть пароль" }));
  expect(password.type).toBe("password");
});

it("shows only the spinner while one sign-in request is pending", async () => {
  let resolveSignIn!: (value: { data: {}; error: null }) => void;
  const pending = new Promise<{ data: {}; error: null }>((resolve) => {
    resolveSignIn = resolve;
  });
  const signIn = vi.fn(() => pending);
  const client = createFakeAuthClient({ signIn: { email: signIn } });
  const { container } = renderRouted(client, "/login", <LoginPage />);

  fireEvent.change(screen.getByLabelText("Электронная почта"), {
    target: { value: "user@example.com" },
  });
  fireEvent.change(screen.getByLabelText("Пароль"), { target: { value: "hunter2!" } });
  fireEvent.click(screen.getByRole("button", { name: "Войти" }));

  const pendingButton = await screen.findByRole("button", { name: "Выполняется вход" });
  expect(pendingButton.hasAttribute("disabled")).toBe(true);
  expect(within(pendingButton).queryByText("Войти")).toBeNull();
  expect(pendingButton.querySelector(".mk-spin")).not.toBeNull();
  fireEvent.click(pendingButton);
  expect(signIn).toHaveBeenCalledTimes(1);

  resolveSignIn({ data: {}, error: null });
  await screen.findByText("SHELL_PLACEHOLDER");
  expect(container.querySelector(".mk-spin")).toBeNull();
});

it("keeps credentials after a failed sign-in", async () => {
  const client = createFakeAuthClient({
    signIn: {
      email: vi.fn(async () => ({ data: null, error: { message: "Invalid credentials" } })),
    },
  });
  renderRouted(client, "/login", <LoginPage />);
  const email = screen.getByLabelText("Электронная почта") as HTMLInputElement;
  const password = screen.getByLabelText("Пароль") as HTMLInputElement;
  fireEvent.change(email, { target: { value: "user@example.com" } });
  fireEvent.change(password, { target: { value: "hunter2!" } });
  fireEvent.click(screen.getByRole("button", { name: "Войти" }));

  expect((await screen.findByRole("alert")).textContent).toContain("Invalid credentials");
  expect(email.value).toBe("user@example.com");
  expect(password.value).toBe("hunter2!");
});
```

- [ ] **Step 2: Run the focused tests and verify the new failures**

Run:

```bash
pnpm --filter @markiro/admin exec vitest run test/auth-pages.test.tsx
```

Expected: password button and pending accessible-name assertions fail; existing credential submission and server-error tests remain green.

- [ ] **Step 3: Implement password visibility and spinner-only children**

In `LoginPage`, add local state and render the existing `Input` and `Button` like this:

```tsx
const [passwordVisible, setPasswordVisible] = useState(false);

<Input
  type={passwordVisible ? "text" : "password"}
  autoComplete="current-password"
  label={t("auth.login.passwordLabel")}
  suffix={
    <button
      className="mk-login-page__password-toggle"
      type="button"
      aria-label={t(
        passwordVisible ? "auth.login.hidePasswordLabel" : "auth.login.showPasswordLabel",
      )}
      onClick={() => setPasswordVisible((visible) => !visible)}
    >
      {t(passwordVisible ? "auth.login.hidePassword" : "auth.login.showPassword")}
    </button>
  }
  {...errorProp(errors.password?.message)}
  {...register("password")}
/>

<Button type="submit" loading={isSubmitting} fullWidth>
  {isSubmitting ? (
    <span className="mk-visually-hidden">{t("auth.login.submitting")}</span>
  ) : (
    t("auth.login.submit")
  )}
</Button>
```

In `login.css`, keep the full accessible label but shorten only its visible rendering:

```css
.mk-login-page__password-toggle {
  flex-shrink: 0;
  color: var(--fg-3);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
```

The concise JSX text is visible and the separate full `aria-label` provides the accessible name. Do not add generated `::after` content: the implementation must produce one visible string and one accessible name, never two visual texts.

- [ ] **Step 4: Run focused tests, then the complete admin package gates**

Run in this order:

```bash
pnpm --filter @markiro/admin exec vitest run test/auth-pages.test.tsx
pnpm --filter @markiro/admin test
pnpm --filter @markiro/admin typecheck
pnpm --filter @markiro/admin lint
pnpm --filter @markiro/admin build
node_modules/.bin/prettier --check apps/admin/src/pages/auth/Login.tsx apps/admin/src/pages/auth/LoginShell.tsx apps/admin/src/pages/auth/login.css apps/admin/src/i18n/ru.json apps/admin/src/i18n/en.json apps/admin/test/auth-pages.test.tsx
git diff --check
```

Expected: all focused and package gates pass. Report any pre-existing lint warnings separately; do not weaken tests or modify unrelated files to silence them.

- [ ] **Step 5: Commit the interaction states**

Stage only Task 2 paths, inspect the staged diff, then commit:

```bash
git add apps/admin/src/pages/auth/Login.tsx apps/admin/src/pages/auth/login.css apps/admin/src/i18n/ru.json apps/admin/src/i18n/en.json apps/admin/test/auth-pages.test.tsx
git diff --cached --check
git commit -m "feat(admin): polish login interaction states"
```

### Task 3: Browser acceptance and final review

**Files:**

- Verify: `apps/admin/src/pages/auth/Login.tsx`
- Verify: `apps/admin/src/pages/auth/LoginShell.tsx`
- Verify: `apps/admin/src/pages/auth/login.css`
- Verify: `apps/admin/src/assets/markiro-logo-on-light.svg`
- Verify: `apps/admin/src/assets/markiro-logo-on-dark.svg`
- Verify: `apps/admin/src/i18n/ru.json`
- Verify: `apps/admin/src/i18n/en.json`
- Verify: `apps/admin/test/auth-pages.test.tsx`

**Interfaces:**

- Consumes: completed Task 1 shell and Task 2 interaction states.
- Produces: browser acceptance record separated from automated package evidence; no new production API.

- [ ] **Step 1: Start an isolated admin preview**

Use an unused port rather than stopping an unrelated local service:

```bash
pnpm --filter @markiro/admin dev --host 127.0.0.1 --port 4174 --strictPort
```

Open `http://127.0.0.1:4174/login`. If 4174 is occupied, inspect ownership and choose another explicit port.

- [ ] **Step 2: Verify the required viewport and theme matrix**

Check all six combinations and record overflow dimensions from the rendered page:

```text
1440×900  light
1440×900  dark
768×1024  light
768×1024  dark
390×844   light
390×844   dark
```

For each combination, verify:

```text
document.documentElement.scrollWidth === document.documentElement.clientWidth
one visible project logo
no clipped heading, form, date, focus ring, preference control, or footer
brand panel present at 768 px and above
brand panel absent and mobile logo present at 390 px
no nested scroll container
```

- [ ] **Step 3: Verify interactive and translated states in the browser**

Using keyboard only, verify this sequence:

```text
Tab to language -> switch RU to EN -> all approved copy fits
Tab to theme -> cycle system/light/dark -> logo variant and contrast stay correct
Tab to email and password -> native autocomplete attributes remain present
Tab to password visibility -> show, hide, and accessible label change
Submit valid-shaped credentials -> button shows only spinner while pending
Exercise a rejected login -> alert remains inline and both values remain present
```

Do not claim production authentication, DNS, mail, hardware, station, Tauri, or Windows acceptance from this local browser check.

- [ ] **Step 4: Review the final diff and repository state**

Run:

```bash
git status --short
git diff main...HEAD --stat
git diff main...HEAD --check
git log --oneline main..HEAD
```

Expected: the branch contains the already-approved spec commit plus the two scoped implementation commits; `.pnpm-store/` remains untracked and excluded from every commit; no `.superpowers/` visual-companion files appear because that directory is ignored.

- [ ] **Step 5: Prepare the completion report**

Report separately:

```text
Behavior changed
Files/areas changed
Focused and full automated checks with exact results
Browser viewport/theme checks with exact results
Checks not run and why
Remaining untracked user-owned files preserved
```

Do not create a pull request, push, merge, or update `main` unless the user explicitly asks.
