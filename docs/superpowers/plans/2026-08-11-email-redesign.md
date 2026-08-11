# Transactional Email Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild all four Markiro transactional emails around the approved A×C visual system with an exact image-free brand mark, more whitespace, stable rendering contracts, and complete previews.

**Architecture:** Keep `renderEmail` and every exported template input unchanged. Replace the current monolithic presentation layer with a shared React Email shell plus small email-safe primitives for the brand, action, expiry notice, fallback link, and footer; each scenario continues to own only its copy and data. Rendering stays deterministic and side-effect free, with inline styles and conservative table structure.

**Tech Stack:** TypeScript 6, React 19, React Email 6.9.1, Vitest 4, pnpm workspace scripts.

## Global Constraints

- Scope is limited to `packages/email`; do not change API, database, migrations, SMTP, pg-boss, outbox, jobs, or deployment code.
- Preserve the `EmailTemplateInput` union, exported template prop types, subjects, preview-text intent, action URLs, expiry semantics, escaping, and useful plain text.
- Do not add dependencies, external images, attachments, tracking pixels, analytics, scripts, animation, background images, gradients, or runtime font downloads.
- Use the exact logo geometry from `apps/admin/src/assets/markiro-logo-on-dark.svg`; do not use a generated or approximate mark.
- Use `#17161a`, `#fafaf8`, `#ffffff`, `#f0efea`, `#e0ded7`, `#6b6862`, `#0faf56`, and `#3ddc7a` for the roles defined in the approved spec.
- Keep the email canvas at `maxWidth: "600px"`, desktop content padding at `46px`, and mobile content padding at `24px` at widths up to `480px`.
- Keep important information textual and do not rely on color, hover, or imagery for meaning.
- Preserve `lang="ru"`, hidden preview text, a selectable/wrapping raw URL, and email-safe system fallbacks after IBM Plex.
- Follow TDD for behavior changes and stage only explicit `packages/email` or plan paths; do not add `.pnpm-store/`.

---

## File Structure

- Modify `packages/email/src/layout.tsx`: own the document shell, exact HTML-safe brand, hero, shared action, expiry notice, fallback link, footer, and all shared inline styles.
- Modify `packages/email/src/invitation.tsx`: provide invitation-specific context, copy, CTA, and absolute expiry.
- Modify `packages/email/src/tenant-owner-activation.tsx`: provide organization activation copy, CTA, duration, and specialized footer.
- Modify `packages/email/src/email-verification.tsx`: provide account verification copy, CTA, and duration.
- Modify `packages/email/src/password-reset.tsx`: provide security copy, CTA, duration, and safe-ignore guidance.
- Modify `packages/email/test/render.test.tsx`: assert shared brand/shell contracts and every scenario's preserved behavior.
- Modify `packages/email/emails/invitation-preview.tsx`: refresh the invitation preview date and content.
- Create `packages/email/emails/tenant-owner-activation-preview.tsx`: first-owner activation preview.
- Create `packages/email/emails/email-verification-preview.tsx`: email verification preview.
- Create `packages/email/emails/password-reset-preview.tsx`: password reset preview.

---

### Task 1: Build the shared image-free Markiro email shell

**Files:**
- Modify: `packages/email/src/layout.tsx`
- Test: `packages/email/test/render.test.tsx`

**Interfaces:**
- Consumes: React `ReactNode`; React Email `Body`, `Button`, `Container`, `Head`, `Heading`, `Html`, `Link`, `Preview`, `Section`, `Text`.
- Produces: `EmailLayout(props: { preview: string; eyebrow: string; heading: string; footer?: string; children: ReactNode }): JSX.Element`.
- Produces: `EmailAction(props: { href: string; children: ReactNode }): JSX.Element`.
- Produces: `EmailExpiryNotice(props: { label: string; children: ReactNode }): JSX.Element`.
- Produces: `EmailFallbackLink(props: { actionUrl: string }): JSX.Element`.
- Produces: `emailStyles` with `paragraph` and `greeting` style entries used by Task 2.

- [ ] **Step 1: Write the failing shared-shell test**

Add this test inside the existing `describe("renderEmail", ...)` block. It deliberately renders all four scenarios so the assertion proves the shell is shared rather than invitation-specific.

```tsx
it("renders the exact image-free Markiro shell for every template", async () => {
  const outputs = await Promise.all([
    renderEmail({
      kind: "tenant-owner-activation",
      recipientName: "Владелец",
      organizationName: "Первый завод",
      actionUrl: "https://cabinet.example/activate-owner#token=setup-token",
      expiresInMinutes: 60,
    }),
    renderEmail({
      kind: "password-reset",
      recipientName: "Алексей",
      actionUrl: "https://cabinet.example/reset/token-1",
      expiresInMinutes: 30,
    }),
    renderEmail({
      kind: "organization-invitation",
      recipientName: "Администратор",
      organizationName: "Завод",
      inviterName: "Ирина",
      actionUrl: "https://cabinet.example/invitations/inv_1",
      expiresAt: new Date("2026-08-14T15:30:00Z"),
    }),
    renderEmail({
      kind: "email-verification",
      recipientName: "Мария",
      actionUrl: "https://cabinet.example/verify/token-2",
      expiresInMinutes: 60,
    }),
  ]);

  for (const output of outputs) {
    expect(output.html).toContain('aria-label="Маркиро"');
    expect(output.html.match(/data-markiro-module="true"/g)).toHaveLength(8);
    expect(output.html).toContain("маркиро");
    expect(output.html).toContain("#17161a");
    expect(output.html).toContain("#0faf56");
    expect(output.html).toContain("#3ddc7a");
    expect(output.html).toContain("@media (max-width: 480px)");
    expect(output.html).toContain("mk-email-content");
    expect(output.html).not.toMatch(/<img\b/i);
  }
});
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run:

```bash
pnpm --filter @markiro/email exec vitest run test/render.test.tsx -t "image-free Markiro shell"
```

Expected: FAIL because the current shell has neither `aria-label="Маркиро"` nor eight `data-markiro-module` cells and still uses the old palette.

- [ ] **Step 3: Replace `layout.tsx` with focused shared primitives**

Keep all components in `layout.tsx`; the file remains small enough to own one responsibility: transactional-email presentation. Define the palette and fallback stacks once:

```tsx
const palette = {
  ink: "#17161a",
  paper: "#fafaf8",
  white: "#ffffff",
  panel: "#f0efea",
  line: "#e0ded7",
  muted: "#6b6862",
  accent: "#0faf56",
  accentModule: "#3ddc7a",
} as const;

const fontSans = '"IBM Plex Sans", Arial, Helvetica, sans-serif';
const fontMono = '"IBM Plex Mono", "Courier New", monospace';

const logoRows = [
  ["ink", null, "ink"],
  [null, "ink", null],
  ["ink", null, "ink"],
  ["ink", null, "ink"],
  [null, "accent", null],
] as const;
```

Implement `EmailBrand` with a presentation table. Every non-empty module gets `data-markiro-module="true"`; the eight modules must follow `logoRows`, dark modules use `palette.ink`, and the final center module uses `palette.accentModule`. The surrounding 40 px square uses `palette.paper`. Put the live-text wordmark next to it and label the group:

```tsx
function EmailBrand() {
  return (
    <table aria-label="Маркиро" role="img" cellPadding="0" cellSpacing="0">
      <tbody>
        <tr>
          <td style={styles.markCell}>
            <table role="presentation" cellPadding="0" cellSpacing="2">
              <tbody>
                {logoRows.map((row, rowIndex) => (
                  <tr key={rowIndex}>
                    {row.map((module, columnIndex) => (
                      <td
                        key={columnIndex}
                        {...(module ? { "data-markiro-module": "true" } : {})}
                        style={{
                          backgroundColor:
                            module === "accent"
                              ? palette.accentModule
                              : module === "ink"
                                ? palette.ink
                                : "transparent",
                          fontSize: "0",
                          height: "5px",
                          lineHeight: "5px",
                          width: "5px",
                        }}
                      >
                        &nbsp;
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </td>
          <td style={styles.wordmark}>маркиро</td>
        </tr>
      </tbody>
    </table>
  );
}
```

Implement the remaining exported primitives with these exact responsibilities:

```tsx
export function EmailAction({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Section style={styles.actionSection}>
      <Button href={href} style={styles.button}>
        {children}
      </Button>
    </Section>
  );
}

export function EmailExpiryNotice({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <Section aria-label="Срок действия ссылки" style={styles.expiryNotice}>
      <Text style={styles.expiryLabel}>{label}</Text>
      <Text style={styles.expiryText}>{children}</Text>
    </Section>
  );
}

export function EmailFallbackLink({ actionUrl }: { actionUrl: string }) {
  return (
    <Section style={styles.fallbackSection}>
      <Text style={styles.fallbackLabel}>Если кнопка не работает, скопируйте ссылку:</Text>
      <Link href={actionUrl} style={styles.fallbackLink}>
        {actionUrl}
      </Link>
    </Section>
  );
}
```

Expose only the two text styles templates need. Spacing for actions, expiry,
fallback, and footer stays inside their owning shared components:

```tsx
export const emailStyles = {
  greeting: {
    color: palette.ink,
    fontSize: "16px",
    fontWeight: "600",
    lineHeight: "24px",
    margin: 0,
  },
  paragraph: {
    color: "#45433e",
    fontSize: "16px",
    lineHeight: "26px",
    margin: "18px 0 0",
  },
} as const;
```

Update `EmailLayout` to accept `eyebrow`, render `EmailBrand` in a compact dark hero, render `eyebrow` and `heading` below the brand row, place children in a white content section, and place the footer in a separate paper section. Use these fixed layout values:

```tsx
const styles = {
  body: {
    backgroundColor: palette.panel,
    fontFamily: fontSans,
    margin: 0,
    padding: "32px 12px",
  },
  container: {
    backgroundColor: palette.white,
    border: `1px solid ${palette.line}`,
    borderRadius: "8px",
    margin: "0 auto",
    maxWidth: "600px",
    overflow: "hidden",
  },
  hero: { backgroundColor: palette.ink, padding: "28px 46px 38px" },
  markCell: {
    backgroundColor: palette.paper,
    height: "40px",
    padding: "5px",
    width: "40px",
  },
  wordmark: {
    color: palette.paper,
    fontFamily: fontMono,
    fontSize: "22px",
    fontWeight: "600",
    letterSpacing: "-0.4px",
    paddingLeft: "14px",
    verticalAlign: "middle",
  },
  eyebrow: {
    color: "#b6b3ab",
    fontSize: "14px",
    fontWeight: "500",
    lineHeight: "20px",
    margin: "32px 0 8px",
  },
  heading: {
    color: palette.paper,
    fontSize: "34px",
    fontWeight: "700",
    letterSpacing: "-0.8px",
    lineHeight: "38px",
    margin: 0,
  },
  content: { padding: "42px 46px" },
  footer: {
    backgroundColor: palette.paper,
    borderTop: `1px solid ${palette.line}`,
    padding: "24px 46px 28px",
  },
  footerText: {
    color: palette.muted,
    fontSize: "12px",
    lineHeight: "18px",
    margin: 0,
  },
  footerSignature: {
    color: "#a5a29a",
    fontFamily: fontMono,
    fontSize: "10px",
    letterSpacing: "0.6px",
    lineHeight: "16px",
    margin: "9px 0 0",
  },
  actionSection: { margin: "30px 0 0" },
  button: {
    backgroundColor: palette.accent,
    borderRadius: "4px",
    boxSizing: "border-box" as const,
    color: palette.white,
    display: "block",
    fontSize: "15px",
    fontWeight: "600",
    lineHeight: "20px",
    padding: "15px 18px",
    textAlign: "center" as const,
    textDecoration: "none",
    width: "100%",
  },
  expiryNotice: {
    backgroundColor: palette.paper,
    border: `1px solid ${palette.line}`,
    borderRadius: "4px",
    margin: "24px 0 0",
    padding: "14px 16px",
  },
  expiryLabel: {
    color: palette.ink,
    fontSize: "12px",
    fontWeight: "600",
    lineHeight: "18px",
    margin: 0,
  },
  expiryText: {
    color: palette.muted,
    fontSize: "12px",
    lineHeight: "18px",
    margin: "3px 0 0",
  },
  fallbackSection: { margin: "26px 0 0" },
  fallbackLabel: {
    color: palette.muted,
    fontSize: "12px",
    lineHeight: "18px",
    margin: "0 0 9px",
  },
  fallbackLink: {
    color: "#1a4f9c",
    fontFamily: fontMono,
    fontSize: "11px",
    lineHeight: "20px",
    textDecoration: "underline",
    wordBreak: "break-all" as const,
  },
} as const;
```

Define the single responsive exception as a constant consumed by `Head`, targeting stable class names placed on hero, content, and footer sections:

```tsx
const responsiveStyles = `
  @media (max-width: 480px) {
    .mk-email-hero { padding-left: 24px !important; padding-right: 24px !important; }
    .mk-email-content { padding-left: 24px !important; padding-right: 24px !important; }
    .mk-email-footer { padding-left: 24px !important; padding-right: 24px !important; }
  }
`;
```

Render those classes and components with this exact shell structure:

```tsx
interface EmailLayoutProps {
  preview: string;
  eyebrow: string;
  heading: string;
  footer?: string;
  children: ReactNode;
}

export function EmailLayout({
  preview,
  eyebrow,
  heading,
  footer,
  children,
}: EmailLayoutProps) {
  return (
    <Html lang="ru">
      <Head>
        <style>{responsiveStyles}</style>
      </Head>
      <Preview>{preview}</Preview>
      <Body style={styles.body}>
        <Container style={styles.container}>
          <Section className="mk-email-hero" style={styles.hero}>
            <EmailBrand />
            <Text style={styles.eyebrow}>{eyebrow}</Text>
            <Heading style={styles.heading}>{heading}</Heading>
          </Section>
          <Section className="mk-email-content" style={styles.content}>
            {children}
          </Section>
          <Section className="mk-email-footer" style={styles.footer}>
            <Text style={styles.footerText}>
              {footer ??
                "Это автоматическое письмо от Маркиро. Если вы не запрашивали это действие, письмо можно удалить."}
            </Text>
            <Text style={styles.footerSignature}>МАРКИРО · ПРОИЗВОДСТВО И МАРКИРОВКА</Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}
```

- [ ] **Step 4: Run the focused test and confirm GREEN**

Run:

```bash
pnpm --filter @markiro/email exec vitest run test/render.test.tsx -t "image-free Markiro shell"
```

Expected: PASS with eight logo modules, a visible live-text wordmark, the approved palette, and no `<img>`.

- [ ] **Step 5: Run Task 1 type and lint checks**

Run:

```bash
pnpm --filter @markiro/email typecheck
pnpm --filter @markiro/email lint
```

Expected: both commands exit 0. If React Email does not forward one of the proposed semantic attributes, adjust the element to raw email-safe HTML while preserving the tested HTML contract; do not weaken or remove the test.

- [ ] **Step 6: Commit the shared shell**

```bash
git add packages/email/src/layout.tsx packages/email/test/render.test.tsx
git diff --cached --check
git commit -m "feat(email): add branded transactional shell"
```

---

### Task 2: Move all four scenarios onto the spacious shared composition

**Files:**
- Modify: `packages/email/src/invitation.tsx`
- Modify: `packages/email/src/tenant-owner-activation.tsx`
- Modify: `packages/email/src/email-verification.tsx`
- Modify: `packages/email/src/password-reset.tsx`
- Test: `packages/email/test/render.test.tsx`

**Interfaces:**
- Consumes: `EmailLayout`, `EmailAction`, `EmailExpiryNotice`, `EmailFallbackLink`, and `emailStyles` from Task 1.
- Consumes: existing `formatRussianMinutes(minutes: number): string` and invitation `dateFormatter` behavior.
- Produces: the existing four template functions and prop interfaces without signature changes.

- [ ] **Step 1: Strengthen the existing scenario assertions before changing templates**

Extend the existing tests with these exact assertions, using the `output`
variable already defined in each named test.

In `renders an escaped organization invitation with a raw fallback URL`, add:

```tsx
expect(output.html).toContain("Приглашение в команду");
expect(output.html).toContain("Завод");
expect(output.html).toContain('aria-label="Срок действия ссылки"');
expect(output.html).toContain("Принять приглашение");
```

In `renders first-owner activation copy instead of claiming a reset was requested`, add:

```tsx
expect(output.html).toContain("Добро пожаловать в Маркиро");
expect(output.html).toContain("Первый завод");
expect(output.html).toContain('aria-label="Срок действия ссылки"');
```

In `renders email verification with useful preview and plain text`, add:

```tsx
expect(output.html).toContain("Подтвердите email");
expect(output.text).toContain(
  "Подтвердите адрес электронной почты, чтобы завершить настройку учётной записи.",
);
```

In `renders a password reset without leaking markup into the subject`, add:

```tsx
expect(output.html).toContain("Восстановление пароля");
expect(output.text).toContain(
  "Если вы не запрашивали смену пароля, ничего делать не нужно.",
);
```

- [ ] **Step 2: Run the full render test and confirm RED**

Run:

```bash
pnpm --filter @markiro/email exec vitest run test/render.test.tsx
```

Expected: FAIL because templates still render their legacy button/expiry/fallback composition and password reset lacks the approved safe-ignore sentence.

- [ ] **Step 3: Rewrite the invitation template using shared primitives**

Keep `OrganizationInvitationEmailProps` and `dateFormatter` unchanged. Replace direct `Button`, `Link`, and `Section` composition with:

```tsx
<EmailLayout
  preview={`Вас пригласили в ${organizationName}`}
  eyebrow={organizationName}
  heading="Приглашение в команду"
>
  <Text style={emailStyles.greeting}>Здравствуйте, {recipientName}.</Text>
  <Text style={emailStyles.paragraph}>
    {inviterName} приглашает вас присоединиться к {organizationName} в Маркиро.
  </Text>
  <EmailAction href={actionUrl}>Принять приглашение</EmailAction>
  <EmailExpiryNotice label="Приглашение действительно до">
    {dateFormatter.format(expiresAt)}
  </EmailExpiryNotice>
  <EmailFallbackLink actionUrl={actionUrl} />
</EmailLayout>
```

- [ ] **Step 4: Rewrite tenant-owner activation using shared primitives**

Keep `TenantOwnerActivationEmailProps` unchanged and preserve the existing-account password sentence:

```tsx
<EmailLayout
  preview={`Доступ к ${organizationName} в Маркиро`}
  eyebrow={organizationName}
  heading="Добро пожаловать в Маркиро"
  footer="Это автоматическое письмо о создании кабинета организации. Если адрес указан ошибочно, просто удалите письмо."
>
  <Text style={emailStyles.greeting}>Здравствуйте, {recipientName}.</Text>
  <Text style={emailStyles.paragraph}>
    Для вас создан кабинет организации {organizationName}. Активируйте доступ по ссылке. Если у
    вас уже есть аккаунт Маркиро, его пароль останется без изменений.
  </Text>
  <EmailAction href={actionUrl}>Активировать доступ</EmailAction>
  <EmailExpiryNotice label="Одноразовая ссылка">
    Действует {formatRussianMinutes(expiresInMinutes)}.
  </EmailExpiryNotice>
  <EmailFallbackLink actionUrl={actionUrl} />
</EmailLayout>
```

- [ ] **Step 5: Rewrite email verification using shared primitives**

Keep `EmailVerificationEmailProps` unchanged:

```tsx
<EmailLayout
  preview="Подтвердите адрес электронной почты в Маркиро"
  eyebrow="Учётная запись"
  heading="Подтвердите email"
>
  <Text style={emailStyles.greeting}>Здравствуйте, {recipientName}.</Text>
  <Text style={emailStyles.paragraph}>
    Подтвердите адрес электронной почты, чтобы завершить настройку учётной записи.
  </Text>
  <EmailAction href={actionUrl}>Подтвердить email</EmailAction>
  <EmailExpiryNotice label="Одноразовая ссылка">
    Действует {formatRussianMinutes(expiresInMinutes)}.
  </EmailExpiryNotice>
  <EmailFallbackLink actionUrl={actionUrl} />
</EmailLayout>
```

- [ ] **Step 6: Rewrite password reset using shared primitives**

Keep `PasswordResetEmailProps` unchanged and add the approved safe-ignore sentence:

```tsx
<EmailLayout
  preview="Ссылка для восстановления доступа к Маркиро"
  eyebrow="Безопасность аккаунта"
  heading="Восстановление пароля"
>
  <Text style={emailStyles.greeting}>Здравствуйте, {recipientName}.</Text>
  <Text style={emailStyles.paragraph}>
    Мы получили запрос на смену пароля вашей учётной записи Маркиро.
  </Text>
  <Text style={emailStyles.paragraph}>
    Если вы не запрашивали смену пароля, ничего делать не нужно.
  </Text>
  <EmailAction href={actionUrl}>Сбросить пароль</EmailAction>
  <EmailExpiryNotice label="Одноразовая ссылка">
    Действует {formatRussianMinutes(expiresInMinutes)}.
  </EmailExpiryNotice>
  <EmailFallbackLink actionUrl={actionUrl} />
</EmailLayout>
```

- [ ] **Step 7: Run the focused render suite and confirm GREEN**

Run:

```bash
pnpm --filter @markiro/email exec vitest run test/render.test.tsx
```

Expected: all invitation, activation, verification, password-reset, duration, escaping, subject, URL, and shared-shell assertions pass.

- [ ] **Step 8: Commit the four scenario migrations**

```bash
git add packages/email/src/invitation.tsx packages/email/src/tenant-owner-activation.tsx packages/email/src/email-verification.tsx packages/email/src/password-reset.tsx packages/email/test/render.test.tsx
git diff --cached --check
git commit -m "feat(email): redesign transactional templates"
```

---

### Task 3: Add a complete React Email preview set

**Files:**
- Modify: `packages/email/emails/invitation-preview.tsx`
- Create: `packages/email/emails/tenant-owner-activation-preview.tsx`
- Create: `packages/email/emails/email-verification-preview.tsx`
- Create: `packages/email/emails/password-reset-preview.tsx`

**Interfaces:**
- Consumes: the four unchanged template component prop interfaces from Task 2.
- Produces: four default-exported zero-argument React preview components discovered by `react-email dev` and checked by `tsconfig.test.json`.

- [ ] **Step 1: Update the invitation preview with a future fixed expiry**

Use a stable future timestamp so the preview remains deterministic:

```tsx
import { OrganizationInvitationEmail } from "../src/invitation.js";

export default function InvitationPreview() {
  return (
    <OrganizationInvitationEmail
      recipientName="Алексей Петров"
      organizationName="Молочный завод № 1"
      inviterName="Ирина Соколова"
      actionUrl="http://localhost:5173/invitations/demo"
      expiresAt={new Date("2026-08-14T15:30:00Z")}
    />
  );
}
```

- [ ] **Step 2: Create the tenant-owner activation preview**

```tsx
import { TenantOwnerActivationEmail } from "../src/tenant-owner-activation.js";

export default function TenantOwnerActivationPreview() {
  return (
    <TenantOwnerActivationEmail
      recipientName="Елена Морозова"
      organizationName="Первый завод"
      actionUrl="http://localhost:5173/activate-owner#token=preview"
      expiresInMinutes={60}
    />
  );
}
```

- [ ] **Step 3: Create the email-verification preview**

```tsx
import { EmailVerificationEmail } from "../src/email-verification.js";

export default function EmailVerificationPreview() {
  return (
    <EmailVerificationEmail
      recipientName="Мария Волкова"
      actionUrl="http://localhost:5173/verify-email?token=preview"
      expiresInMinutes={60}
    />
  );
}
```

- [ ] **Step 4: Create the password-reset preview**

```tsx
import { PasswordResetEmail } from "../src/password-reset.js";

export default function PasswordResetPreview() {
  return (
    <PasswordResetEmail
      recipientName="Алексей Петров"
      actionUrl="http://localhost:5173/reset-password?token=preview"
      expiresInMinutes={30}
    />
  );
}
```

- [ ] **Step 5: Typecheck preview discovery and props**

Run:

```bash
pnpm --filter @markiro/email typecheck
```

Expected: exit 0; this command includes `tsconfig.test.json`, whose `include` list covers `emails`.

- [ ] **Step 6: Commit the preview set**

```bash
git add packages/email/emails/invitation-preview.tsx packages/email/emails/tenant-owner-activation-preview.tsx packages/email/emails/email-verification-preview.tsx packages/email/emails/password-reset-preview.tsx
git diff --cached --check
git commit -m "chore(email): add transactional previews"
```

---

### Task 4: Run final automated and visual acceptance

**Files:**
- Verify only; no expected source changes.

**Interfaces:**
- Consumes: the complete package output from Tasks 1–3.
- Produces: evidence for automated package health and a bounded manual responsive-preview result; it does not claim Gmail, Outlook, Apple Mail, or physical-device acceptance.

- [ ] **Step 1: Run the complete package gates**

Run in this order:

```bash
pnpm --filter @markiro/email test
pnpm --filter @markiro/email typecheck
pnpm --filter @markiro/email lint
pnpm --filter @markiro/email build
```

Expected: every command exits 0 with no skipped tests.

- [ ] **Step 2: Start React Email preview and inspect all four templates**

Run:

```bash
pnpm --filter @markiro/email dev
```

Open the local URL printed by React Email. Inspect invitation, tenant-owner activation, email verification, and password reset at a desktop width of at least 700 px. Confirm the exact Markiro mark arrangement and wordmark, compact dark hero, 46 px content padding, full-width green CTA, separate expiry surface, wrapping fallback URL, and quiet footer.

- [ ] **Step 3: Inspect narrow-width behavior**

Resize the same preview to `390 × 844`. Confirm the hero, content, and footer reduce horizontal padding to 24 px; headings, CTA, expiry surface, and raw URL stay within the viewport; no text or logo is clipped; and the CTA remains easy to tap.

Expected: all four previews remain readable with no horizontal overflow. Record this as browser preview only, not inbox-client verification.

- [ ] **Step 4: Review the final diff and repository state**

Run:

```bash
git diff --check
git status --short
git log --oneline -4
```

Expected: no email redesign changes remain uncommitted, `.pnpm-store/` remains untracked and untouched, and the branch contains the design, shared-shell, scenario, and preview commits.

- [ ] **Step 5: Report external gates honestly**

In the final handoff, list automated package commands separately from the React Email browser preview. State explicitly that Gmail, Outlook, Apple Mail, dark-mode inbox transformations, and real delivery were not verified unless they were actually exercised.
