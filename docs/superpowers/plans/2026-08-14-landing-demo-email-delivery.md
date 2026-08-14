# Landing Demo Email Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Accept a protected bilingual demo request on `markiro.app`, durably queue one internal and one visitor email, and deliver both through the existing Markiro mail pipeline configured for Yandex Cloud Postbox.

**Architecture:** Expose only same-origin `POST /api/demo-requests` through the landing Caddy authority. A focused Nest module validates the request, charges bounded rate limits, verifies SmartCaptcha, and atomically creates two public-request-scoped encrypted mail deliveries plus outbox rows; existing pg-boss jobs render React Email templates and send through Nodemailer/Postbox. The static landing remains disabled unless legal paths, consent version, and the public captcha key are supplied at build time.

**Tech Stack:** Node.js 24, TypeScript 6, NestJS 11, Zod 4, Drizzle/PostgreSQL 17, pg-boss 12, React Email 6, Nodemailer 9, Astro 7, Caddy 2.11, Vitest 4, Supertest, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-14-landing-demo-email-and-brand-design.md`

## Global Constraints

- Name and company are required; email is required; phone is optional.
- Russian phone input accepts `8…`/`+7…`; English input accepts canonical international `+` numbers with 8–15 digits.
- A successful request creates exactly two logical deliveries: `landing-demo-notification` to `hello@v-b.tech` and `landing-demo-confirmation` to the visitor.
- Both deliveries share one public request UUID, enter the outbox in one database transaction, and are idempotent under retries.
- Mail template inputs stay AES-GCM encrypted at rest; no form field, captcha token, SMTP detail, raw source address, or secret enters ordinary logs or analytics.
- The public endpoint has one fixed path, fixed templates, fixed internal recipient, bounded body/fields, honeypot, per-source/global limiter, and fail-closed SmartCaptcha verification.
- Invalid/expired captcha returns a stable 400 error; captcha infrastructure failure returns 503; rate limiting returns 429.
- Existing tenant/user/platform mail scopes and retry/retention behavior remain compatible.
- The form remains disabled until approved same-origin privacy and personal-data-consent documents, consent version, Postbox/DNS configuration, and captcha configuration exist.
- No marketing text, tracking pixel, remote image, remote font, attachment, arbitrary URL, arbitrary recipient, or free-form visitor message is added.
- Use exact dependency versions and existing packages; this feature requires no new npm dependency.
- Never edit an applied migration. If `origin/main` acquires migration number `0044` before execution, regenerate this migration at the next free number and reconcile all Drizzle metadata instead of overwriting the new main migration.

---

### Task 1: Add a public-request scope to durable email delivery

**Files:**

- Modify: `packages/db/src/schema/mail.ts`
- Modify: `packages/db/test/mail-media-schema.test.ts`
- Create: `packages/db/test/landing-demo-mail-migration.test.ts`
- Create: `packages/db/migrations/0044_landing_demo_email.sql`
- Modify: `packages/db/migrations/meta/_journal.json`
- Create: `packages/db/migrations/meta/0044_snapshot.json`
- Modify: `apps/api/src/modules/mail/mail.types.ts`
- Modify: `apps/api/src/modules/mail/mail-delivery.service.ts`
- Modify: `apps/api/test/mail-delivery.service.test.ts`

**Interfaces:**

- Consumes: existing `MailDeliveryService.enqueue(tx, input)` and three mail scopes.
- Produces: `MailScope | { publicRequestId: string }`, Drizzle column `schema.emailDeliveries.publicRequestId`, unique index `email_deliveries_public_request_kind_uq`, and the unchanged `enqueue()` method accepting the fourth scope.

- [ ] **Step 1: Write failing schema and delivery tests**

Extend the schema test with exact public-scope assertions:

```ts
expect(Object.keys(schema.emailDeliveries)).toContain("publicRequestId");
const deliveryConfig = getTableConfig(schema.emailDeliveries);
expect(deliveryConfig.checks.map((item) => item.name)).toContain("email_deliveries_scope_xor");
expect(deliveryConfig.indexes.map((item) => item.config.name)).toEqual(
  expect.arrayContaining([
    "email_deliveries_public_request_status_idx",
    "email_deliveries_public_request_kind_uq",
  ]),
);
```

Add a `MailDeliveryService` test that enqueues:

```ts
scope: { publicRequestId: "11111111-1111-4111-8111-111111111111" },
recipient: " Lead@Example.TEST ",
template: {
  kind: "email-verification",
  recipientName: "Ada",
  actionUrl: "https://cabinet.example/verify/secret",
  expiresInMinutes: 60,
},
```

and expects tenant/user/platform ids to be null and `publicRequestId` to be set.

- [ ] **Step 2: Run focused tests to verify RED**

Run:

```bash
corepack pnpm --filter @markiro/db exec vitest run test/mail-media-schema.test.ts test/landing-demo-mail-migration.test.ts
corepack pnpm --filter @markiro/api exec vitest run test/mail-delivery.service.test.ts
```

Expected: FAIL because the fourth scope, templates, column, and migration do not exist.

- [ ] **Step 3: Add the schema and mail-scope implementation**

Add this field and update the XOR:

```ts
publicRequestId: (uuid("public_request_id"),
  // ...
  sql`num_nonnulls(${table.tenantId}, ${table.userId}, ${table.platformUserId}, ${table.publicRequestId}) = 1`);
```

Add:

```ts
index("email_deliveries_public_request_status_idx").on(table.publicRequestId, table.status),
uniqueIndex("email_deliveries_public_request_kind_uq")
  .on(table.publicRequestId, table.kind)
  .where(sql`${table.publicRequestId} is not null`),
```

Import `uniqueIndex` from Drizzle. Extend `MailScope` with an exclusive
`{ publicRequestId: string }` member. In `enqueue`, resolve all four nullable
scope columns and include `publicRequestId` in the insert without changing the
existing encryption/outbox boundary.

- [ ] **Step 4: Generate and review the migration**

Load the development `DATABASE_URL`, then run:

```bash
corepack pnpm --filter @markiro/db db:generate --name landing_demo_email
```

Review the generated SQL and keep this exact logical shape:

```sql
ALTER TABLE "email_deliveries" ADD COLUMN "public_request_id" uuid;
ALTER TABLE "email_deliveries" DROP CONSTRAINT "email_deliveries_scope_xor";
ALTER TABLE "email_deliveries" ADD CONSTRAINT "email_deliveries_scope_xor"
  CHECK (num_nonnulls("tenant_id", "user_id", "platform_user_id", "public_request_id") = 1);
CREATE INDEX "email_deliveries_public_request_status_idx"
  ON "email_deliveries" ("public_request_id", "status");
CREATE UNIQUE INDEX "email_deliveries_public_request_kind_uq"
  ON "email_deliveries" ("public_request_id", "kind")
  WHERE "public_request_id" IS NOT NULL;
```

The migration test reads the SQL and asserts all four operations, including the
partial unique predicate. It must also assert the migration does not make the
new column non-null and does not change existing recipient/payload columns.

- [ ] **Step 5: Build DB output and verify GREEN**

Run:

```bash
corepack pnpm --filter @markiro/db build
corepack pnpm --filter @markiro/db exec vitest run test/mail-media-schema.test.ts test/landing-demo-mail-migration.test.ts
corepack pnpm --filter @markiro/api exec vitest run test/mail-delivery.service.test.ts
```

Expected: all PASS. If a database-backed test is skipped because
`DATABASE_URL` is absent, report the skip and apply the migration in the
configured development/test database before final completion.

- [ ] **Step 6: Commit the schema boundary**

```bash
git add packages/db/src/schema/mail.ts packages/db/test/mail-media-schema.test.ts packages/db/test/landing-demo-mail-migration.test.ts packages/db/migrations/0044_landing_demo_email.sql packages/db/migrations/meta/_journal.json packages/db/migrations/meta/0044_snapshot.json apps/api/src/modules/mail/mail.types.ts apps/api/src/modules/mail/mail-delivery.service.ts apps/api/test/mail-delivery.service.test.ts
git commit -m "feat(mail): add public request delivery scope"
```

---

### Task 2: Add bilingual lead templates and per-message Reply-To

**Files:**

- Create: `packages/email/src/landing-demo-notification.tsx`
- Create: `packages/email/src/landing-demo-confirmation.tsx`
- Create: `packages/email/emails/landing-demo-notification-preview.tsx`
- Create: `packages/email/emails/landing-demo-confirmation-preview.tsx`
- Modify: `packages/email/src/layout.tsx`
- Modify: `packages/email/src/index.ts`
- Modify: `packages/email/test/render.test.tsx`
- Modify: `apps/api/src/modules/mail/mail-transport.service.ts`
- Modify: `apps/api/test/mail-transport.test.ts`
- Modify: `apps/api/test/mail-jobs.service.test.ts`

**Interfaces:**

- Consumes: `EmailLayout`, `renderEmail`, and `MailTransport.send(rendered, recipient)`.
- Produces:

```ts
export type LandingLocale = "ru" | "en";
export interface LandingDemoNotificationEmailProps {
  locale: LandingLocale;
  requestId: string;
  receivedAt: Date;
  sourcePath: string;
  recipientName: string;
  company: string;
  email: string;
  phone?: string;
}
export interface LandingDemoConfirmationEmailProps {
  locale: LandingLocale;
  requestId: string;
  recipientName: string;
  company: string;
  email: string;
  phone?: string;
  contactEmail: string;
}
export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
}
```

- [ ] **Step 1: Write failing renderer tests for both messages**

Add tests that render RU notification and RU/EN confirmations. Pin subjects,
plain text, escaped values, localized brand, optional phone omission, and
Reply-To:

```ts
const internal = await renderEmail({
  kind: "landing-demo-notification",
  locale: "en",
  requestId: "11111111-1111-4111-8111-111111111111",
  receivedAt: new Date("2026-08-14T12:00:00Z"),
  sourcePath: "/en/",
  recipientName: "<Ada>",
  company: "Factory & Co",
  email: "ada@example.test",
  phone: "+12025550114",
});
expect(internal.subject).toBe("Новая заявка с markiro.app — Маркиро");
expect(internal.replyTo).toBe("ada@example.test");
expect(internal.html).toContain("&lt;Ada&gt;");
expect(internal.text).toContain("/en/");

const confirmation = await renderEmail({
  kind: "landing-demo-confirmation",
  locale: "en",
  requestId: "11111111-1111-4111-8111-111111111111",
  recipientName: "Ada",
  company: "Factory",
  email: "ada@example.test",
  contactEmail: "hello@v-b.tech",
});
expect(confirmation.subject).toBe("We received your request — Markiro");
expect(confirmation.replyTo).toBe("hello@v-b.tech");
expect(confirmation.html).toContain('lang="en"');
expect(confirmation.html).toContain("MARKIRO");
expect(confirmation.text).not.toContain("undefined");
```

Assert every result has no external `<img>`, tracking pixel, remote font, or
marketing/subscription copy.

- [ ] **Step 2: Write the failing SMTP-envelope test**

Extract a pure `buildMessageOptions(env, rendered, recipient)` helper and test
the precedence contract:

```ts
expect(
  buildMessageOptions(
    envWithGlobalReplyTo,
    { ...rendered, replyTo: "lead@example.test" },
    "hello@v-b.tech",
  ),
).toMatchObject({ to: "hello@v-b.tech", replyTo: "lead@example.test" });

expect(buildMessageOptions(envWithGlobalReplyTo, rendered, "user@example.test")).toMatchObject({
  replyTo: "support@example.test",
});
```

- [ ] **Step 3: Run focused tests to verify RED**

Run:

```bash
corepack pnpm --filter @markiro/email exec vitest run test/render.test.tsx
corepack pnpm --filter @markiro/api exec vitest run test/mail-transport.test.ts test/mail-jobs.service.test.ts
```

Expected: FAIL because the two template kinds, locale-aware layout, and
per-message Reply-To do not exist.

- [ ] **Step 4: Make `EmailLayout` locale-aware without changing old callers**

Add `locale?: "ru" | "en"` with default `ru`. Derive `Html lang`, brand label,
wordmark, fallback footer, and signature from locale. Keep existing templates
unchanged and therefore Russian by default. Use the same exact eight-module
table geometry for both locales; only live wordmark text changes.

- [ ] **Step 5: Implement the two focused templates**

Use semantic rows/sections and fixed labels. Internal mail always uses the
Russian operational subject and RU layout while showing the visitor locale.
Confirmation selects RU/EN subject and copy. Render submitted fields as text;
do not interpolate them into subject, HTML, attributes, or links. Omit the phone
row entirely when absent. Do not claim a response time.

Add both discriminants to `EmailTemplateInput`, resolve their elements, and set
`replyTo` to visitor email for notification and `contactEmail` for confirmation.
Export both prop types.

- [ ] **Step 6: Implement typed SMTP Reply-To precedence**

Make `buildMessageOptions` return Nodemailer's message object:

```ts
return {
  from: { name: env.SMTP_FROM_NAME, address: env.SMTP_FROM_EMAIL },
  to: recipient,
  ...((rendered.replyTo ?? env.SMTP_REPLY_TO)
    ? { replyTo: rendered.replyTo ?? env.SMTP_REPLY_TO }
    : {}),
  subject: rendered.subject,
  html: rendered.html,
  text: rendered.text,
};
```

`MailTransportService.send` calls this helper. Keep the `MailTransport`
interface itself stable so mail jobs and fakes continue to work.

- [ ] **Step 7: Run package checks and preview render**

Run:

```bash
corepack pnpm --filter @markiro/email test
corepack pnpm --filter @markiro/email typecheck
corepack pnpm --filter @markiro/email lint
corepack pnpm --filter @markiro/email build
corepack pnpm --filter @markiro/api exec vitest run test/mail-transport.test.ts test/mail-jobs.service.test.ts
```

Render both preview entries and inspect at approximately 600 px and 375 px.
Verify the RU/EN brand, summary hierarchy, optional-phone state, and plain-text
fallback. Record that this does not prove Gmail/Outlook/mobile inbox rendering.

- [ ] **Step 8: Commit the mail presentation contract**

```bash
git add packages/email/src/landing-demo-notification.tsx packages/email/src/landing-demo-confirmation.tsx packages/email/emails/landing-demo-notification-preview.tsx packages/email/emails/landing-demo-confirmation-preview.tsx packages/email/src/layout.tsx packages/email/src/index.ts packages/email/test/render.test.tsx apps/api/src/modules/mail/mail-transport.service.ts apps/api/test/mail-transport.test.ts apps/api/test/mail-jobs.service.test.ts
git commit -m "feat(email): add landing request messages"
```

---

### Task 3: Add server configuration, SmartCaptcha, and bounded rate limits

**Files:**

- Modify: `apps/api/src/env.ts`
- Modify: `apps/api/test/mail-env.test.ts`
- Create: `apps/api/src/modules/demo-requests/demo-request.errors.ts`
- Create: `apps/api/src/modules/demo-requests/demo-request-captcha.service.ts`
- Create: `apps/api/src/modules/demo-requests/demo-request-rate-limiter.ts`
- Test: `apps/api/test/demo-request-captcha.test.ts`
- Test: `apps/api/test/demo-request-rate-limiter.test.ts`
- Modify: `.env.example`
- Modify: `.env.production.example`

**Interfaces:**

- Produces these validated `Env` fields:

```ts
LANDING_DEMO_SUBMISSION_ENABLED: boolean;
LANDING_ORIGIN?: string;
LANDING_DEMO_RECIPIENT?: string;
LANDING_DEMO_REPLY_TO?: string;
LANDING_DEMO_CONSENT_VERSION?: string;
SMARTCAPTCHA_SERVER_KEY?: string;
LANDING_DEMO_RATE_WINDOW_SECONDS: number;
LANDING_DEMO_SOURCE_LIMIT: number;
LANDING_DEMO_GLOBAL_LIMIT: number;
```

- Produces `DemoRequestCaptchaService.assertHuman(token: string, source: string): Promise<void>` and `DemoRequestRateLimiter.assertAllowed(source: string, now?: number): void`.
- Uses stable public error codes `captcha_invalid`, `captcha_unavailable`, and `rate_limited` without forwarding upstream text.

- [ ] **Step 1: Write failing environment tests**

Test disabled defaults and enabled requirements:

```ts
expect(loadEnv(baseEnv).LANDING_DEMO_SUBMISSION_ENABLED).toBe(false);
expect(loadEnv(baseEnv)).toMatchObject({
  LANDING_DEMO_RATE_WINDOW_SECONDS: 900,
  LANDING_DEMO_SOURCE_LIMIT: 5,
  LANDING_DEMO_GLOBAL_LIMIT: 100,
});
expect(() =>
  loadEnv({
    ...productionEnv,
    LANDING_DEMO_SUBMISSION_ENABLED: "true",
  }),
).toThrow(/LANDING_ORIGIN/);

expect(
  loadEnv({
    ...productionEnv,
    LANDING_DEMO_SUBMISSION_ENABLED: "true",
    LANDING_ORIGIN: "https://markiro.app",
    LANDING_DEMO_RECIPIENT: "hello@v-b.tech",
    LANDING_DEMO_REPLY_TO: "hello@v-b.tech",
    LANDING_DEMO_CONSENT_VERSION: "2026-08-14",
    SMARTCAPTCHA_SERVER_KEY: "ysc2_test-secret",
  }),
).toMatchObject({ LANDING_DEMO_SUBMISSION_ENABLED: true });
```

Reject origins with paths, non-email recipients, blank versions, and a captcha
key that lacks the `ysc2_` prefix. Ensure thrown errors name variables but do
not print values. Validate the window in 60–3600 seconds, source limit in 1–100,
global limit in 1–10,000, and require the global limit to be at least the source
limit.

- [ ] **Step 2: Write failing captcha tests**

Inject a `fetch` dependency and assert the exact request:

```ts
expect(fetcher).toHaveBeenCalledWith(
  "https://smartcaptcha.cloud.yandex.ru/validate",
  expect.objectContaining({ method: "POST" }),
);
expect(new URLSearchParams(String(fetcher.mock.calls[0]![1]!.body))).toEqual(
  new URLSearchParams({ secret: "ysc2_secret", token: "token", ip: "203.0.113.7" }),
);
```

Cover `status: "ok"` with exact `host: "markiro.app"`, failed/expired token,
wrong host, non-200, malformed JSON, timeout, and network error. Invalid tokens
must throw 400 `captcha_invalid`; upstream failures must throw 503
`captcha_unavailable`. No thrown message contains response bodies, token, key,
or source.

- [ ] **Step 3: Write failing limiter tests**

Construct the limiter with a 15-minute window, source budget 5, global budget
100, and at most 10,000 tracked windows. Assert request 6 from one source and
request 101 across distinct sources throw 429 `{ code: "rate_limited" }`;
advancing exactly 900,000 ms opens a new window. Fill the map and prove extra
unique sources collapse into a bounded overflow key.

- [ ] **Step 4: Run focused tests to verify RED**

```bash
corepack pnpm --filter @markiro/api exec vitest run test/mail-env.test.ts test/demo-request-captcha.test.ts test/demo-request-rate-limiter.test.ts
```

Expected: FAIL because the config and services do not exist.

- [ ] **Step 5: Implement conditional environment validation**

Add `LANDING_DEMO_SUBMISSION_ENABLED` with default false. Keep the other fields
optional at schema level, then require all five in `superRefine` only when the
feature is true. Parse `LANDING_ORIGIN` with the existing canonical-origin
schema. Normalize blank optional values in `loadEnv`, but never invent
production recipient, reply address, consent version, or captcha secret.

Add bounded numeric limiter configuration with defaults 900 seconds, 5 per
source, and 100 global; pass the parsed values into the limiter provider rather
than reading `process.env` inside the service.

Document safe development examples in `.env.example` and empty production
inventory entries in `.env.production.example`. Do not put real keys in either.

- [ ] **Step 6: Implement captcha and limiter services**

Use `URLSearchParams` and `AbortSignal.timeout(1_500)` for captcha verification.
Compare the returned `host` with `new URL(LANDING_ORIGIN).host`. Treat the
server key as constructor-only state and never expose it from a getter or error.

Implement the fixed-window limiter following the bounded-map pattern in
`InvitationLookupRateLimiter`, but charge one `source:<normalized>` counter and
one `global` counter. Normalize the source to at most 128 characters and use
`unknown` only when `@Ip()` is empty. Its constructor accepts
`{ windowMs, sourceBudget, globalBudget, maxTrackedWindows }`, so tests and
module wiring use the same explicit contract.

- [ ] **Step 7: Verify GREEN and commit**

```bash
corepack pnpm --filter @markiro/api exec vitest run test/mail-env.test.ts test/demo-request-captcha.test.ts test/demo-request-rate-limiter.test.ts
corepack pnpm --filter @markiro/api typecheck
git add apps/api/src/env.ts apps/api/test/mail-env.test.ts apps/api/src/modules/demo-requests/demo-request.errors.ts apps/api/src/modules/demo-requests/demo-request-captcha.service.ts apps/api/src/modules/demo-requests/demo-request-rate-limiter.ts apps/api/test/demo-request-captcha.test.ts apps/api/test/demo-request-rate-limiter.test.ts .env.example .env.production.example
git commit -m "feat(api): protect landing demo requests"
```

Expected: focused tests, typecheck, and commit succeed without printing config
values.

---

### Task 4: Atomically accept and queue the two-email request

**Files:**

- Create: `apps/api/src/modules/demo-requests/demo-request.schema.ts`
- Create: `apps/api/src/modules/demo-requests/demo-request-routes.ts`
- Create: `apps/api/src/modules/demo-requests/demo-request.repository.ts`
- Create: `apps/api/src/modules/demo-requests/demo-request.service.ts`
- Create: `apps/api/src/modules/demo-requests/demo-requests.controller.ts`
- Create: `apps/api/src/modules/demo-requests/demo-requests.module.ts`
- Modify: `apps/api/src/app.module.ts`
- Test: `apps/api/test/demo-request-schema.test.ts`
- Test: `apps/api/test/demo-request.service.test.ts`
- Test: `apps/api/test/demo-request.e2e.test.ts`
- Test: `apps/api/test/demo-request-pipeline.e2e.test.ts`

**Interfaces:**

- Produces strict `DemoRequestDto`:

```ts
interface DemoRequestDto {
  requestId: string;
  locale: "ru" | "en";
  sourcePath: string;
  consentVersion: string;
  name: string;
  company: string;
  email: string;
  phone?: string;
  website: string;
  captchaToken: string;
}
```

- Produces `DemoRequestService.submit(input: DemoRequestDto, source: string): Promise<{ accepted: true; requestId: string }>`.
- Consumes the Task 1 public mail scope, Task 2 template kinds, and Task 3 protection services/config.

- [ ] **Step 1: Write strict schema/normalization tests**

Use the existing `ZodValidationPipe`. Test trimmed bounded name/company,
lowercased email, empty optional phone, RU `8` normalization, EN international
normalization, all 16 exact published source paths, UUID, locale, consent
version, captcha token, honeypot, and `.strict()` rejection of unknown fields.

Representative expected output:

```ts
expect(
  parse({
    requestId: "11111111-1111-4111-8111-111111111111",
    locale: "en",
    sourcePath: "/en/packing-workstation/",
    consentVersion: "2026-08-14",
    name: " Ada ",
    company: " Factory ",
    email: " ADA@EXAMPLE.TEST ",
    phone: "+1 (202) 555-0114",
    website: "",
    captchaToken: "token",
  }),
).toMatchObject({
  name: "Ada",
  company: "Factory",
  email: "ada@example.test",
  phone: "+12025550114",
});
```

- [ ] **Step 2: Write failing service and repository tests**

With injected fakes, assert call order: feature enabled -> limiter -> honeypot ->
consent version -> captcha -> repository. A filled honeypot, wrong consent
version, limiter failure, or captcha failure must not call the repository.

For repository tests with PostgreSQL, submit one request and assert exactly two
delivery rows, distinct kinds/recipients, shared `publicRequestId`, encrypted
payloads, and exactly two outbox rows. Submit the same UUID concurrently and
assert counts remain two/two. Force the second enqueue to fail and assert the
transaction leaves zero rows for that request.

- [ ] **Step 3: Run focused tests to verify RED**

```bash
corepack pnpm --filter @markiro/db build
corepack pnpm --filter @markiro/email build
corepack pnpm --filter @markiro/api exec vitest run test/demo-request-schema.test.ts test/demo-request.service.test.ts test/demo-request.e2e.test.ts test/demo-request-pipeline.e2e.test.ts
```

Expected: FAIL because the module and route do not exist. Database-backed cases
must run when `DATABASE_URL` is configured; report any explicit skip.

- [ ] **Step 4: Implement the strict route registry and schema**

Define `DEMO_SOURCE_PATHS` as a literal tuple containing the eight RU and eight
EN canonical paths already present in `apps/landing/src/content/pages.ts`. Use a
Zod enum derived from this tuple; do not accept query strings, arbitrary URLs,
or a prefix match. Keep normalization in pure schema/helper functions so it can
be shared by controller and tests.

- [ ] **Step 5: Implement atomic repository idempotency**

`DemoRequestRepository` injects `DB` and `MailDeliveryService`. Within one
`db.transaction`:

1. acquire `pg_advisory_xact_lock(hashtextextended(requestId, 0))`;
2. select existing delivery kinds for `public_request_id`;
3. return `existing` only for the complete expected pair;
4. throw an invariant error for a partial/foreign pair;
5. enqueue notification to configured internal recipient with visitor email as
   template Reply-To source;
6. enqueue confirmation to visitor email with configured contact address;
7. return `created` after both outbox inserts.

Use server `receivedAt`, not a client timestamp. Store `sourceId=requestId` for
operational compatibility while `publicRequestId` remains the enforced scope.

- [ ] **Step 6: Implement service, controller, and module wiring**

`DemoRequestService` returns 404 `{ code: "submission_disabled" }` before any
work when the server flag is false. It rejects a filled honeypot with bounded
400 `invalid_request`, validates the configured consent version, invokes the
limiter/captcha, and delegates to the repository.

The controller is exact:

```ts
@Controller("demo-requests")
export class DemoRequestsController {
  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  submit(
    @Body(new ZodValidationPipe(demoRequestSchema)) body: DemoRequestDto,
    @Ip() source: string,
  ) {
    return this.service.submit(body, source);
  }
}
```

Register `DemoRequestsModule.forRoot(env)` in `AppModule.forRoot`. Do not add an
auth guard, cookie, CORS wildcard, Swagger secret, or alternate public route.

- [ ] **Step 7: Verify API behavior and mail pipeline**

Run:

```bash
corepack pnpm --filter @markiro/api exec vitest run test/demo-request-schema.test.ts test/demo-request.service.test.ts test/demo-request.e2e.test.ts test/demo-request-pipeline.e2e.test.ts test/mail-pipeline.e2e.test.ts
corepack pnpm --filter @markiro/api typecheck
corepack pnpm --filter @markiro/api lint
```

Expected: all configured tests PASS. The e2e suite proves 202 contains only
`accepted` and request id; 400/429/503 bodies contain only stable codes; disabled
mode is 404; no test uses production SMTP or SmartCaptcha.

- [ ] **Step 8: Commit the durable public endpoint**

```bash
git add apps/api/src/modules/demo-requests apps/api/src/app.module.ts apps/api/test/demo-request-schema.test.ts apps/api/test/demo-request.service.test.ts apps/api/test/demo-request.e2e.test.ts apps/api/test/demo-request-pipeline.e2e.test.ts
git commit -m "feat(api): queue landing demo requests"
```

---

### Task 5: Extend the bilingual landing form and client runtime

**Files:**

- Modify: `apps/landing/src/lib/demo-form.ts`
- Modify: `apps/landing/src/lib/demo-form.test.ts`
- Modify: `apps/landing/src/scripts/demo-form.ts`
- Modify: `apps/landing/src/scripts/demo-form.test.ts`
- Modify: `apps/landing/src/lib/site-config.ts`
- Modify: `apps/landing/src/lib/site-config.test.ts`
- Modify: `apps/landing/src/components/DemoSection.astro`
- Modify: `apps/landing/src/components/HomePage.astro`
- Modify: `apps/landing/src/content/ui.ts`
- Modify: `apps/landing/src/env.d.ts`
- Modify: `apps/landing/src/styles/landing.css`
- Modify: `apps/landing/test/rendered-page.test.ts`
- Modify: `tools/production-browser/landing.playwright.config.ts`
- Modify: `tools/production-browser/tests/landing-seo.spec.ts`

**Interfaces:**

- Produces client `DemoLead` with normalized required `email` and optional
  `phone`.
- Produces `DemoRequestPayload` matching Task 4 exactly, including request id,
  locale, source path, consent version, honeypot, and captcha token.
- Extends `PublicSiteConfig` with `captchaClientKey: string | null` and
  `consentVersion: string | null`; both are non-null only when submission is
  enabled.

- [ ] **Step 1: Write failing pure validation/config tests**

Add cases for normalized email, optional phone, RU and EN phone rules, overlong
email, invalid email, and empty phone:

```ts
expect(
  validateDemoLead(
    {
      name: "Ada",
      company: "Factory",
      email: " ADA@EXAMPLE.TEST ",
      phone: "",
    },
    "en",
  ),
).toEqual({
  ok: true,
  value: { name: "Ada", company: "Factory", email: "ada@example.test" },
});
```

Update site config tests so enabled mode throws unless all four public values
exist: legal paths, captcha client key beginning `ysc1_`, and non-empty consent
version. Disabled mode must expose no endpoint/key/version even if stray public
values are present.

- [ ] **Step 2: Write failing runtime tests**

Extend the form fixture with email, optional phone, honeypot, consent checkbox,
and hidden `smart-token`. Inject `createRequestId`, `currentPath`, and
`resetCaptcha` into the runtime. Assert the exact JSON payload and
`credentials: "omit"`. Submit twice after a simulated 503 and verify the same
request id is reused; after success a new form initialization gets a new UUID.

Cover stable response codes:

- `captcha_invalid` resets captcha and focuses its error;
- 429 keeps values and shows localized wait guidance;
- 503/network keeps values and allows retry;
- 202 replaces the form with the localized confirmation;
- missing consent or captcha never calls fetch;
- form-field values never appear in analytics event properties.

- [ ] **Step 3: Run focused tests to verify RED**

```bash
corepack pnpm --filter @markiro/landing exec vitest run src/lib/demo-form.test.ts src/lib/site-config.test.ts src/scripts/demo-form.test.ts test/rendered-page.test.ts --no-file-parallelism
```

Expected: FAIL because email is absent, phone is required, and consent/captcha
payload/runtime contracts do not exist.

- [ ] **Step 4: Implement pure form and site configuration contracts**

Keep locale-specific copy in the existing dictionaries. `DemoLeadInput` always
contains strings from controls; `DemoLead.phone` is optional. Use a conservative
email syntax check and the same maximums as the API. Do not perform DNS/MX
requests in the browser.

Add public environment declarations:

```ts
readonly PUBLIC_SMARTCAPTCHA_CLIENT_KEY?: string;
readonly PUBLIC_DEMO_CONSENT_VERSION?: string;
```

When `PUBLIC_DEMO_SUBMISSION_ENABLED=true`, require both values and the two legal
paths. Return the fixed same-origin endpoint only after the full configuration
passes.

- [ ] **Step 5: Implement accessible form markup**

Render fields in order name, company, email, phone. Mark phone as optional in
localized visible copy and use `autocomplete="email"` / `autocomplete="tel"`.
Add:

```astro
<div class="demo-form__honeypot" aria-hidden="true">
  <label for="website">Website</label>
  <input id="website" name="website" type="text" tabindex="-1" autocomplete="off" />
</div>
```

Render an unchecked required consent checkbox with the existing two legal links
and a dedicated error message. Render SmartCaptcha and its external script only
when submission is enabled:

```astro
<div class="smart-captcha" data-sitekey={captchaClientKey}></div>
<script src="https://smartcaptcha.cloud.yandex.ru/captcha.js" defer></script>
```

Pass `sourcePath={page.path}`, captcha key, and consent version from `HomePage`.
Disabled mode retains the truthful unavailable note and does not load the
captcha script.

- [ ] **Step 6: Implement request-id/captcha runtime behavior**

Create one `requestId = crypto.randomUUID()` per initialized form. Read the
one-time captcha token from `input[name="smart-token"]`; never persist it. Build
the exact Task 4 payload, including `window.location.pathname`. Parse only
bounded `{ code?: string }` error JSON. On `captcha_invalid`, call the official
widget reset hook and require a new token; on other failures retain fields.

Keep `landing_form_start`, `landing_form_success`, and error-class analytics
free of form values/request id/source address.

- [ ] **Step 7: Verify focused and package GREEN**

```bash
corepack pnpm --filter @markiro/landing test
corepack pnpm --filter @markiro/landing lint
corepack pnpm --filter @markiro/landing typecheck
corepack pnpm --filter @markiro/landing build
corepack pnpm --filter @markiro/landing run audit
```

Expected: PASS. The normal build remains disabled unless test/public variables
explicitly enable the form.

- [ ] **Step 8: Add enabled-form browser coverage**

Configure the landing Playwright server with test-only public values and stub
`https://smartcaptcha.cloud.yandex.ru/captcha.js` in `test.beforeEach` so the
suite remains deterministic and offline. Route `/api/demo-requests` inside the
test, inject a hidden `smart-token`, submit RU and EN forms, and assert exact
request payload plus localized success. Keep the existing 16-route no-console-
error and layout-overflow checks on desktop and Pixel 7.

Run:

```bash
corepack pnpm test:landing:browser
```

Expected: all browser scenarios PASS without a real captcha or email.

- [ ] **Step 9: Commit the form experience**

```bash
git add apps/landing/src/lib/demo-form.ts apps/landing/src/lib/demo-form.test.ts apps/landing/src/scripts/demo-form.ts apps/landing/src/scripts/demo-form.test.ts apps/landing/src/lib/site-config.ts apps/landing/src/lib/site-config.test.ts apps/landing/src/components/DemoSection.astro apps/landing/src/components/HomePage.astro apps/landing/src/content/ui.ts apps/landing/src/env.d.ts apps/landing/src/styles/landing.css apps/landing/test/rendered-page.test.ts tools/production-browser/landing.playwright.config.ts tools/production-browser/tests/landing-seo.spec.ts
git commit -m "feat(landing): collect email demo requests"
```

---

### Task 6: Open only the exact production edge and build-time boundary

**Files:**

- Modify: `deploy/production/Caddyfile`
- Modify: `deploy/production/edge.Dockerfile`
- Modify: `deploy/production/test/edge-contract.test.mjs`
- Modify: `deploy/production/test/smoke-route-table.test.mjs`
- Modify: `deploy/production/test/workflow-contract.test.mjs`
- Modify: `.github/workflows/release-images.yml`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**

- Consumes: API route `/demo-requests`, static build variables from Task 5, and
  server environment from Task 3.
- Produces: exact landing `POST /api/demo-requests` reverse proxy with 4 KiB
  body cap, unchanged adjacent 404s, landing-only SmartCaptcha CSP, and immutable
  edge images built with explicit public form variables.

- [ ] **Step 1: Write failing adapted-Caddy tests**

Replace the old assertion of zero landing proxies with exact ordered behavior:

```js
assert.equal(landingProxies.length, 1);
assert.deepEqual(landingProxies[0].paths, ["/api/demo-requests"]);
assert.deepEqual(landingProxies[0].methods, ["POST"]);
assert.deepEqual(landingProxies[0].rewrites, [{ handler: "rewrite", strip_path_prefix: "/api" }]);
```

Assert GET/HEAD/PUT on that path and every adjacent `/api/*` path remain plain 404. Assert admin/kiosk CSP contains no SmartCaptcha host, while landing CSP
contains only `https://smartcaptcha.cloud.yandex.ru` in `script-src`,
`frame-src`, and `connect-src` additions.

- [ ] **Step 2: Write failing image/compose/workflow tests**

Assert `edge.Dockerfile` declares and forwards these build args only to the
landing build stage:

```text
PUBLIC_DEMO_SUBMISSION_ENABLED
PUBLIC_PRIVACY_POLICY_PATH
PUBLIC_PERSONAL_DATA_CONSENT_PATH
PUBLIC_SMARTCAPTCHA_CLIENT_KEY
PUBLIC_DEMO_CONSENT_VERSION
PUBLIC_PHONE
```

Assert CI builds with `PUBLIC_DEMO_SUBMISSION_ENABLED=false`, while the release
workflow forwards repository variables without printing the public key value.
Assert API env inventory contains the six Task 3 server variables through the
existing protected env file, not Compose command arguments.

- [ ] **Step 3: Run contract tests to verify RED**

```bash
node --test deploy/production/test/edge-contract.test.mjs deploy/production/test/smoke-route-table.test.mjs deploy/production/test/workflow-contract.test.mjs
```

Expected: FAIL because the landing edge remains static-only and the image has no
public form build contract.

- [ ] **Step 4: Split common headers from authority-specific CSP**

Keep HSTS, nosniff, frame options, referrer policy, encoding, release SHA, and
server-header removal in `(common_headers)`. Move the current CSP unchanged into
`(application_csp)` for admin/kiosk. Add `(landing_csp)` with the same baseline
plus only the SmartCaptcha script/frame/connect origin. Import the appropriate
CSP once per HTTPS authority so no response receives duplicate CSP headers.

- [ ] **Step 5: Add the exact landing proxy before the reserved matcher**

Add:

```caddyfile
@landingDemo {
  method POST
  path /api/demo-requests
}
handle @landingDemo {
  request_body {
    max_size 4KB
  }
  uri strip_prefix /api
  reverse_proxy api:3000 {
    import standard_api_transport
  }
}
```

Leave the existing reserved route immediately after it so no other method or
path reaches the API. Disabled API mode still returns a safe 404 through this
exact proxy.

- [ ] **Step 6: Wire immutable build and protected runtime configuration**

Declare Docker `ARG`/`ENV` pairs before the Turbo build. Pass false/blank safe
values in ordinary CI. In release-images, use approved repository variables for
public build values; never use the SmartCaptcha server key as a build argument.

The API service already reads its protected `env_file`; add server variables to
the CI-generated file with disabled mode and fake values suitable for contract
tests. Keep real Postbox and captcha secrets in the deployment secret store.

- [ ] **Step 7: Verify edge and production bundle contracts**

```bash
node --test deploy/production/test/edge-contract.test.mjs deploy/production/test/smoke-route-table.test.mjs deploy/production/test/workflow-contract.test.mjs
corepack pnpm test:production-bundle:contract
```

Expected: PASS. CI smoke still expects POST 404 because server submission is
disabled there; structural Caddy tests prove the exact proxy exists. No CI step
sends real mail or calls SmartCaptcha.

- [ ] **Step 8: Commit the production boundary**

```bash
git add deploy/production/Caddyfile deploy/production/edge.Dockerfile deploy/production/test/edge-contract.test.mjs deploy/production/test/smoke-route-table.test.mjs deploy/production/test/workflow-contract.test.mjs .github/workflows/release-images.yml .github/workflows/ci.yml
git commit -m "feat(deploy): expose protected landing requests"
```

---

### Task 7: Document release gates and run full verification

**Files:**

- Modify: `docs/runbooks/landing-publication.md`
- Modify: `deploy/production/test/runbook-contract.test.mjs`

**Interfaces:**

- Produces an operator checklist that keeps code deploy, legal enablement,
  Postbox/DNS, SmartCaptcha, controlled two-mail delivery, monitoring, and rollback
  as separate observable gates.

- [ ] **Step 1: Write the failing runbook contract test**

Require these literal concepts in the publication runbook:

```js
for (const required of [
  "postbox.sender",
  "yc.postbox.send",
  "postbox.cloud.yandex.net",
  "DKIM",
  "SPF",
  "DMARC",
  "hello@v-b.tech",
  "SmartCaptcha",
  "PUBLIC_DEMO_SUBMISSION_ENABLED",
  "LANDING_DEMO_SUBMISSION_ENABLED",
  "queued",
  "retrying",
  "failed",
])
  assert.match(runbook, new RegExp(required));
```

Also require explicit statements that legal approval, live DNS/TLS, Postbox
acceptance, inbox arrival, spam placement, and email-client rendering are not
proved by repository tests.

- [ ] **Step 2: Run the contract test to verify RED**

```bash
node --test deploy/production/test/runbook-contract.test.mjs
```

Expected: FAIL because the runbook currently requires the CRM boundary to stay
disabled and has no Postbox/captcha rollout.

- [ ] **Step 3: Update the publication and rollback procedure**

Document the exact order:

1. deploy migration/API/mail/edge with both feature flags false;
2. create Postbox sender role and scoped SMTP API key without recording it in
   the runbook;
3. verify `markiro.app`, Easy DKIM, a single SPF record including
   `spf.postbox.yandexcloud.net`, and DMARC;
4. configure SmartCaptcha/secret and approve privacy, consent, cookie/vendor
   disclosure, and consent version;
5. enable the server flag and submit one controlled RU and one EN request using
   controlled mailboxes;
6. verify two queued/sent rows per request, arrival at `hello@v-b.tech`, visitor
   confirmation, Reply-To direction, and spam folders;
7. build/deploy the edge with the public flag/key/legal paths;
8. monitor 202/400/429/503 rates, captcha failure classes, mail
   queued/retrying/failed state, and Postbox delivery events.

Rollback first rebuilds/disables the public form, then disables the server flag
and restores POST to 404. It does not reverse the additive migration or delete
queued mail. Credential revocation is separate and used if sender abuse is
suspected.

- [ ] **Step 4: Run focused package gates in dependency order**

```bash
corepack pnpm --filter @markiro/db build
corepack pnpm --filter @markiro/db test
corepack pnpm --filter @markiro/db typecheck
corepack pnpm --filter @markiro/db lint
corepack pnpm --filter @markiro/email test
corepack pnpm --filter @markiro/email typecheck
corepack pnpm --filter @markiro/email lint
corepack pnpm --filter @markiro/email build
corepack pnpm --filter @markiro/api test
corepack pnpm --filter @markiro/api typecheck
corepack pnpm --filter @markiro/api lint
corepack pnpm --filter @markiro/api build
corepack pnpm --filter @markiro/landing test
corepack pnpm --filter @markiro/landing typecheck
corepack pnpm --filter @markiro/landing lint
corepack pnpm --filter @markiro/landing build
corepack pnpm --filter @markiro/landing run audit
```

Expected: all configured gates PASS. Report DB skips separately and do not call
them database verification.

- [ ] **Step 5: Run cross-package release gates**

```bash
corepack pnpm test:production-bundle:contract
corepack pnpm test:landing:browser
corepack pnpm test:landing:lighthouse
corepack pnpm format:check
git diff --check
```

Expected: all PASS. If Podman/Docker, browser, DNS, or network infrastructure is
unavailable, record the exact unrun gate rather than substituting another test.

- [ ] **Step 6: Request independent review before publishing**

Ask the reviewer to inspect tenant-scope compatibility, migration SQL,
idempotency/concurrency, captcha fail-closed behavior, source/global limits,
PII logging, template escaping/Reply-To, Caddy route ordering/CSP isolation,
disabled defaults, and RU/EN accessibility. Address verified findings with a
new RED/GREEN cycle.

- [ ] **Step 7: Commit the runbook and any review-only corrections**

```bash
git add docs/runbooks/landing-publication.md deploy/production/test/runbook-contract.test.mjs
git commit -m "docs(landing): add demo email release gates"
```

Before handoff, ensure `git status --short` is clean and list live gates still
pending: approved legal documents, DNS/TLS, Postbox identity/DKIM/SPF/DMARC,
SmartCaptcha production keys, controlled two-recipient delivery, spam placement,
and representative inbox-client rendering.
