# Landing Demo Email Delivery and Localized Brand — Design Spec

**Date:** 2026-08-14
**Status:** Approved in design discussion; document review pending.
**Scope:** Public landing demo form, two durable transactional emails, Yandex
Cloud Postbox delivery, abuse protection, and localized landing/email brand.
**Related:**
`docs/superpowers/specs/2026-08-14-landing-seo-ai-discoverability-design.md`,
`docs/superpowers/specs/2026-08-11-email-redesign-design.md`,
`docs/runbooks/landing-publication.md`,
`packages/email`, `apps/api/src/modules/mail`, and `deploy/production/Caddyfile`.

## Problem

The landing already renders and validates a demo form, but production submission
is deliberately disabled. The landing edge returns a real 404 for
`/api/demo-requests`, and the site refuses to enable the form until approved
privacy and personal-data consent links exist. A visitor therefore cannot yet
send a lead.

The temporary lead channel must work before the CRM integration is ready. A
valid request must reach `hello@v-b.tech`, and the visitor must receive a
branded transactional confirmation so the submission does not feel lost. The
flow handles personal data and exposes an unauthenticated email-producing
endpoint, so it must not become an open relay, a spam amplifier, or a source of
PII in logs.

The landing also uses an approximate green square next to the Latin `MARKIRO`
word rather than the accepted Markiro symbol. The Russian landing must display
the Russian `маркиро` wordmark, while the English landing must retain `MARKIRO`.

## Goals

1. Add required email and optional phone fields to the Russian and English demo
   forms while keeping name and company required.
2. Accept a demo request through one exact same-origin public route.
3. Atomically queue an internal notification and a visitor confirmation through
   the existing encrypted email outbox.
4. Deliver both messages through Yandex Cloud Postbox using the existing SMTP
   transport and retry worker.
5. Render both messages with the established React Email visual system.
6. Protect sender reputation and the internal inbox with bounded validation,
   rate limits, a honeypot, and server-verified Yandex SmartCaptcha.
7. Reuse the exact repository logo geometry and localize the live wordmark:
   `маркиро` for Russian and `MARKIRO` for English.
8. Preserve the landing's current privacy, crawler, cache, route-isolation, and
   truthful-error guarantees.

## Non-goals

- Building the CRM, sales pipeline, lead assignment, lead history, or reporting.
- Persisting a separate plaintext landing-leads table.
- Adding marketing consent, newsletters, drip campaigns, pixels, or email-open
  tracking.
- Attaching UTM/referrer attribution to the lead before the privacy policy and
  attribution contract are approved.
- Adding free-form message text, attachments, or any user-selected recipient.
- Replacing the existing SMTP/outbox/job architecture with Cloud Functions or
  API Gateway.
- Claiming DNS, Postbox delivery, inbox placement, or email-client compatibility
  from automated tests.
- Publishing unapproved privacy-policy or personal-data-consent copy.

## Chosen architecture

Use the existing Nest API, PostgreSQL email outbox, pg-boss delivery worker, and
Nodemailer SMTP transport. Production config points that transport at Yandex
Cloud Postbox. This avoids a second runtime and secret boundary while retaining
the retry and retention behavior already used by account emails.

The public path is intentionally narrow:

```text
browser on markiro.app
  -> POST /api/demo-requests
  -> exact Caddy handler (all other landing /api paths remain 404)
  -> Nest demo-request controller
  -> validation + abuse checks + one DB transaction
  -> two encrypted email deliveries + two outbox rows
  -> pg-boss mail jobs
  -> Yandex Cloud Postbox SMTP
       -> hello@v-b.tech
       -> visitor email
```

The form reports success after both logical deliveries have been committed to
the durable outbox, not after an SMTP round trip. This prevents a partial
request where one email was accepted and the other was lost, and it keeps
Postbox latency out of the public HTTP request.

## Form contract and interaction

The visible field order is:

1. name — required, trimmed, 1–80 Unicode characters;
2. company — required, trimmed, 1–120 Unicode characters;
3. email — required, trimmed, normalized to lowercase for delivery, at most 254
   characters, and validated syntactically without an MX lookup;
4. phone — optional, trimmed, at most 30 input characters.

Russian `8XXXXXXXXXX` and `+7XXXXXXXXXX` phone input normalizes to canonical
`+7XXXXXXXXXX`. An English-page visitor may enter an international number that
starts with `+` and contains 8–15 digits after punctuation is removed. Empty
phone input remains absent rather than becoming an empty string.

The client performs the same usability validation it does today and adds
localized email, optional-phone, consent, captcha, and server-error states. The
server independently validates every field and never trusts the client result.
The browser retains entered values after validation, network, 429, or 503
responses. Duplicate clicks remain disabled while a request is active.

Each rendered form receives a new UUID request id for the current submission
attempt and reuses it across safe retries until success or a page reload. The
request contains only:

- `requestId`;
- `locale` (`ru` or `en`);
- name, company, email, optional phone;
- a canonical source path selected from the published landing route registry;
- the honeypot value;
- the one-time SmartCaptcha token;
- the approved consent-document version.

The browser does not submit arbitrary URLs, query strings, UTM fields, cookies,
visitor ids, or analytics ids.

## Public API contract

`POST /api/demo-requests` is the only landing API route enabled. Caddy strips
the public `/api` prefix and proxies the request to the corresponding Nest
controller. The route accepts only `application/json`, uses a small explicit
body limit, and has no authentication cookie or credential mode.

Responses are deliberately small and do not echo personal data:

| Status | Meaning                                                 |
| ------ | ------------------------------------------------------- |
| `202`  | Both logical emails already exist in the durable outbox |
| `400`  | Malformed fields, invalid captcha, or missing consent   |
| `429`  | Per-source or global request budget exceeded            |
| `503`  | Captcha service or durable queue unavailable            |

A repeated accepted `requestId` is idempotent and returns `202` without adding
another pair of emails. Error bodies use bounded stable codes for the existing
localized form mapping; they never include SMTP, database, captcha, recipient,
or secret details.

`GET`, `HEAD`, and every other method on `/api/demo-requests` remain plain 404.
Every other `/api`, auth, station, kiosk, health, docs, and exchange path on the
landing authority preserves the existing deny-by-default behavior.

## Abuse protection

Protection is layered because the endpoint can send email to a visitor-supplied
address:

1. Caddy exposes only the exact method and path.
2. The API rejects oversized bodies, wrong content type, unknown properties,
   invalid UUIDs, unsupported source paths/locales, and overlong values.
3. A visually hidden, keyboard-safe honeypot must remain empty. A filled trap is
   handled as a generic rejected submission without creating email.
4. A bounded per-source fixed-window limiter and a separate global backstop run
   before external captcha validation. Source resolution uses the repository's
   numeric `TRUST_PROXY_HOPS` policy; arbitrary forwarded headers are not
   trusted.
5. The API validates a one-time SmartCaptcha token server-side and verifies that
   its returned host is the configured landing authority. The public client key
   is build-time configuration; the server key is a production secret and is
   never exposed to the landing bundle or logs.
6. An invalid or expired captcha token returns a stable 400 code that makes the
   browser request a new challenge. A captcha infrastructure error fails closed
   with 503 rather than allowing the email-producing action without its primary
   distributed-abuse control.
7. Subjects, recipients, sender, and template structure are fixed by the server.
   User values appear only as escaped text and can never create headers, HTML,
   URLs, or alternate recipients.

Rate-limit logs contain only stable categories and counts. They do not contain
the raw source address or form fields. Limits are configuration with bounded
production defaults and focused tests; they are not public environment values
embedded in the static site.

SmartCaptcha is a publication dependency and must be reflected in the approved
privacy/cookie documentation. Its required script, frame, and connection hosts
are added narrowly to the landing CSP; the rest of the site does not gain a
general third-party script allowance.

## Durable email data model

Extend `email_deliveries` with nullable `public_request_id uuid`. The existing
scope XOR becomes exactly one non-null value among tenant, account user,
platform user, and public request. Public email deliveries therefore do not
pretend to belong to a tenant or authenticated account.

Both rows for one request share `public_request_id` but have distinct template
kinds:

- `landing-demo-notification`;
- `landing-demo-confirmation`.

A unique constraint over `(public_request_id, kind)` provides pair-level
idempotency. The service locks or inserts by request id inside one transaction,
checks that the complete pair exists, and inserts the two email deliveries and
two outbox rows atomically. No already-applied migration is rewritten.

The template inputs are encrypted by the existing AES-GCM mail boundary before
storage. Recipient addresses continue to use the established delivery schema
and are retained only for delivery-state operation. Existing retention applies:
terminal encrypted payload is erased after 24 hours; successful/canceled rows
are deleted after 30 days and failed rows after 90 days.

No separate lead record is created. The internal mailbox is the temporary
business record until CRM delivery replaces this route. Removing the temporary
channel later requires an explicit migration/retention decision for remaining
queued or failed emails; disabling the form must not delete in-flight outbox
work.

## Email templates and envelopes

Add two typed template inputs to `@markiro/email`. They reuse `EmailLayout`,
palette, conservative HTML/table logo, spacing, plain-text generation, and
email-safe fallbacks from the transactional email system. They add no remote
image, font, script, attachment, pixel, or click tracker.

### Internal notification

- Recipient: configured fixed address, initially `hello@v-b.tech`.
- Subject RU: `Новая заявка с markiro.app — Маркиро`.
- Subject EN remains an internal Russian operational subject so mailbox filters
  do not split by visitor locale; the message labels the visitor locale.
- Reply-To: validated visitor email.
- Content: request id, received time, source page, locale, name, company, email,
  and optional phone. It contains no IP, captcha token, consent secret, cookies,
  or unapproved attribution.
- The layout wordmark is `маркиро` because this is an internal Russian
  operational message.

### Visitor confirmation

- Recipient: validated visitor email.
- Subject RU: `Мы получили вашу заявку — Маркиро`.
- Subject EN: `We received your request — Markiro`.
- Reply-To: configured public contact address, initially `hello@v-b.tech`.
- Content: localized greeting, a direct statement that the request was
  received, a compact summary of submitted company/email/optional phone, and a
  promise to contact the visitor without inventing an unapproved response-time
  SLA.
- The Russian message uses `маркиро`; the English message uses `MARKIRO` and an
  English document language/footer.
- It is strictly transactional and contains no subscription, promotion,
  tracking, or marketing consent implication.

Per-message Reply-To is encrypted with the template/envelope input and produced
by the typed rendering/delivery boundary. The existing global SMTP Reply-To
remains the fallback for older templates; it must not overwrite an explicit
per-message value.

## Postbox and deployment configuration

Production uses Yandex Cloud Postbox SMTP through the existing Nodemailer
transport:

- host `postbox.cloud.yandex.net`;
- port 587 with STARTTLS or port 465 with SMTPS;
- a service account with the narrow `postbox.sender` role;
- an API key scoped to `yc.postbox.send` for SMTP authentication;
- TLS certificate verification enabled;
- a verified `markiro.app` sending identity, with a sender such as
  `Маркиро <hello@markiro.app>`;
- `LANDING_DEMO_RECIPIENT=hello@v-b.tech` and a separately named public reply
  address variable.

Secrets stay in the established production secret path and are never placed in
Terraform state output, repository files, image layers, CLI arguments, or logs.
Domain verification and Easy DKIM records are required before the form is
enabled. SPF must include `spf.postbox.yandexcloud.net` without creating a
second SPF record; DMARC is also configured and verified. DNS/TLS/Postbox
verification is a live release gate, not an automated repository claim.

Official references:

- <https://yandex.cloud/ru/docs/postbox/quickstart>
- <https://yandex.cloud/ru/docs/postbox/concepts/dns-records>
- <https://yandex.cloud/ru/docs/smartcaptcha/concepts/validation>
- <https://yandex.cloud/ru/docs/smartcaptcha/concepts/keys>

## Localized brand mark

Replace the approximate green-square landing mark with the exact modular symbol
used by the repository identity assets. Do not embed the existing wide Russian
SVG on every locale because its wordmark cannot be localized accessibly.

`BrandMark` owns one shared symbol geometry and renders the word as live text:

| Surface                       | Wordmark  | Language |
| ----------------------------- | --------- | -------- |
| Russian landing header/footer | `маркиро` | `ru`     |
| English landing header/footer | `MARKIRO` | `en`     |
| Russian/internal email        | `маркиро` | `ru`     |
| English confirmation email    | `MARKIRO` | `en`     |

The compact header uses the symbol plus wordmark without increasing the current
header height or crowding navigation. The footer repeats the localized brand.
The favicon and web manifests use the same symbol geometry so the browser icon,
landing, admin, station, and email do not present different marks.

The symbol is decorative when adjacent live text already names the brand.
Accessible labels use `Маркиро` on Russian surfaces and `Markiro` on English
surfaces. No remote logo asset or font dependency is introduced.

## Privacy and consent

The form remains disabled unless same-origin privacy-policy and personal-data
consent documents exist and their final copy/version has been approved. The
form presents an unchecked required consent control with direct links to both
documents; merely visiting the page does not grant form-processing consent.

The API accepts only the configured current consent version and places that
version and server receive time in the encrypted internal notification. This is
an operational trace, not a claim of legal sufficiency. Final wording, lawful
basis, controller details, retention disclosure, cross-service processing, and
SmartCaptcha disclosure require owner/legal approval before production enable.

The transactional confirmation does not require or imply marketing consent.
Optional analytics remains independently gated by the cookie-consent system,
and form values never enter analytics events.

## Failure and recovery behavior

- Validation and captcha errors do not create a request or email row.
- If either email or outbox insert fails, the whole transaction rolls back and
  the API returns 503.
- Once the transaction commits, both deliveries retry independently under the
  existing lease, backoff, reconciliation, and terminal-failure policy.
- A terminal failure of one email does not cancel the other. Mail operations can
  inspect the two delivery rows by public request id without exposing payloads
  through a new public endpoint.
- The visitor success screen says the request was accepted, not that both inbox
  providers have delivered it.
- Mail health degradation remains visible through the established operational
  health/logging channel without returning internal detail to the visitor.
- Turning off `PUBLIC_DEMO_SUBMISSION_ENABLED` immediately removes the browser
  submission endpoint from the rendered form but does not delete queued work.

## Verification

### Landing

- client validation covers required email, optional phone, Russian and
  international normalization, consent, honeypot, captcha token, locale, source
  path, request-id reuse, duplicate submit suppression, 202, 400, 429, 503, and
  network recovery;
- rendered-page tests cover localized field labels, optional-phone copy,
  consent control, localized header/footer logo, and disabled truthfulness;
- accessibility checks cover labels, error associations, focus after error and
  success, keyboard operation, and a captcha fallback;
- browser tests cover Russian and English happy/error flows at desktop and
  mobile widths without sending real email.

### API, database, and mail

- DTO/service tests reject unknown fields, oversized input, header injection,
  unsupported paths/locales, missing consent, filled honeypot, invalid captcha,
  and rate-limit overflow;
- e2e tests assert the exact landing path is unauthenticated while all adjacent
  routes stay denied;
- migration/schema tests cover the four-way scope XOR, new index/unique
  constraint, and existing scopes;
- concurrency/idempotency tests prove repeated request ids create exactly two
  logical deliveries and two outbox rows;
- rollback tests prove neither email survives a failure while inserting its
  pair;
- renderer tests cover RU/EN subject, HTML, plain text, escaped values, optional
  phone, localized brand, exact Reply-To, and absence of remote/tracking assets;
- mail-job tests prove independent retries and per-message Reply-To does not
  weaken existing templates.

### Production boundary

- Caddy contract tests prove only `POST /api/demo-requests` proxies on the
  landing authority and all adjacent methods/routes remain plain 404;
- CSP tests allow only the exact SmartCaptcha dependencies required by the form;
- production smoke submits only to a safe fake/test backend and never sends a
  real public email from CI;
- package tests, typecheck, lint, build, format, migration review, production
  bundle contracts, landing browser tests, and built-site audit run before
  merge.

Manual/external gates remain: approved legal text, live DNS/TLS, Postbox domain
verification, DKIM/SPF/DMARC inspection, SmartCaptcha host/key configuration, a
real paired delivery to `hello@v-b.tech` and a controlled visitor mailbox,
spam-folder inspection, and representative Gmail/Outlook/mobile rendering.

## Rollout and rollback

1. Merge and deploy the schema/API/email/edge capability with form submission
   still disabled.
2. Configure Postbox, DNS authentication, recipient/reply addresses, captcha,
   and production secrets.
3. Publish approved privacy and consent documents and verify their canonical
   URLs.
4. Run a controlled two-recipient delivery and production smoke.
5. Enable `PUBLIC_DEMO_SUBMISSION_ENABLED` and rebuild/deploy the static landing.
6. Monitor rate limits, captcha failures, queued/retrying/failed mail, Postbox
   events, internal arrival, and confirmation arrival.

Rollback disables the landing form and restores the landing endpoint to plain 404. It does not roll back the additive database migration and does not remove
already queued deliveries. Postbox credentials can be revoked independently if
the sender is abused.

## Acceptance

- RU and EN forms require name, company, email, and consent; phone is optional.
- A valid request produces exactly one internal and one visitor delivery with a
  shared public request id.
- Both deliveries use the established Markiro email design and useful plain
  text, with correct per-message Reply-To behavior.
- The API acknowledges only a durable pair and is idempotent under retries.
- The endpoint is same-origin, exact-path, bounded, captcha-protected, and never
  logs form values or secrets.
- Postbox credentials and DNS authentication are deploy-time gates.
- Russian surfaces display `маркиро`; English surfaces display `MARKIRO`; both
  use the exact shared symbol geometry.
- The form cannot be enabled without approved privacy/consent paths and version.
- Automated results are reported separately from live Postbox, DNS, inbox,
  captcha, legal, and email-client verification.
