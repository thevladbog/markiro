# Transactional Email Redesign — Design Spec

**Date:** 2026-08-11
**Status:** Approved in design discussion; document review pending.
**Scope:** `packages/email` transactional templates and their render tests.
**Related:** `packages/ui/src/tokens.css`,
`apps/admin/src/assets/markiro-logo-on-dark.svg`,
`docs/superpowers/specs/2026-08-03-tenant-team-email-profile-design.md`.

## Problem

Markiro currently sends four functional React Email templates: organization
invitation, first-owner activation, email verification, and password reset.
They share a small layout, but the visual system does not match the accepted
product brand. The header uses a text-only uppercase wordmark, the palette uses
unrelated cool grays, Arial is the only typeface, and the content blocks are
packed too tightly to create a clear reading rhythm.

The redesign must strengthen the brand without weakening delivery reliability.
Transactional email clients routinely block remote images and support only a
conservative subset of HTML and CSS. The result therefore cannot depend on a
public image host, CID attachments, web fonts, scripts, animation, complex
selectors, or layout features with inconsistent email-client support.

## Goals

1. Redesign all four existing transactional templates as one coherent system.
2. Match the Markiro `ink`, `paper`, neutral, and green-accent palette.
3. Render the exact Markiro symbol and wordmark without a remote image request.
4. Increase whitespace and make the message, action, expiry, fallback link, and
   footer visually distinct.
5. Preserve subjects, preview text intent, input contracts, escaped values,
   action URLs, expiry semantics, and useful plain-text output.
6. Keep the implementation conservative enough for common desktop and mobile
   email clients.

## Non-goals

- Changing SMTP, Nodemailer, pg-boss, outbox, retry, or delivery-state logic.
- Adding marketing, digest, billing, or operational-notification templates.
- Adding externally hosted images, attachments, tracking pixels, analytics, or
  runtime font downloads.
- Changing activation, invitation, verification, or password-reset token
  semantics.
- Reworking cabinet pages reached from the email actions.
- Claiming inbox-client compatibility without a separate manual client check.

## Approved visual direction

The approved direction combines the strengths of the explored A and C
concepts:

- the calm page surface, precise service hierarchy, and compact footer of A;
- the stronger dark opening section and full-width primary action of C;
- larger content padding and explicit vertical space between semantic blocks;
- a shorter dark hero so the email remains a message rather than a promotional
  card;
- a separate low-emphasis expiry notice rather than expiry copy placed directly
  under the button.

The email canvas remains a maximum of 600 px wide. On desktop it sits on the
warm `paper`/panel surface; on narrow viewports it fills the available width.
The desktop content area uses 46 px horizontal padding. At widths up to 480 px,
mobile-safe rules reduce it to 24 px. Semantic blocks use the approved 18–30 px
spacing range according to hierarchy while keeping the action easy to tap.

The palette follows `packages/ui/src/tokens.css`:

| Role          | Value     | Use                                                |
| ------------- | --------- | -------------------------------------------------- |
| Ink           | `#17161a` | Hero, headings, primary text                       |
| Paper         | `#fafaf8` | Page and quiet panels                              |
| White         | `#ffffff` | Main message surface                               |
| Panel         | `#f0efea` | Outer background or expiry surface                 |
| Line          | `#e0ded7` | Dividers and structural borders                    |
| Muted text    | `#6b6862` | Supporting and footer copy                         |
| Primary green | `#0faf56` | Main CTA only                                      |
| Mark module   | `#3ddc7a` | The green module in the logo and small status mark |

## Email-safe Markiro logo

The logo must reproduce the repository source rather than use a generated or
approximate icon. Its reference geometry is
`apps/admin/src/assets/markiro-logo-on-dark.svg`.

The email implementation renders the symbol with conservative nested table
cells or equivalent React Email table primitives. It preserves the exact
square-module arrangement, the off-white/dark inversion, and the single green
module. The `маркиро` wordmark remains live text in a monospace fallback stack.
This hybrid remains visible when a client blocks images and does not require a
new render input, asset base URL, or Nodemailer attachment contract.

The layout must provide a useful textual brand name even if a client simplifies
table styling. No external `<img>` is introduced.

## Component structure

`EmailLayout` remains the public composition boundary and owns the email-safe
document shell. Its implementation defines these focused private components,
colocated with the layout unless a component becomes large enough to warrant a
separate module:

- `EmailBrand` — exact HTML-safe symbol and wordmark;
- `EmailHero` — brand row, optional context/eyebrow, and heading;
- `EmailAction` — full-width primary action with the shared CTA style;
- `EmailExpiryNotice` — separate expiry/status surface;
- `EmailFallbackLink` — explanation plus raw, selectable action URL;
- `EmailFooter` — template-specific safety copy and shared automatic-message
  signature.

The shared pieces must live in `packages/email`; templates must not duplicate
the logo geometry, CTA styles, spacing, or footer construction. They continue
to use React Email and inline style objects. No new dependency is required.

The existing `EmailTemplateInput` union and exported template prop types remain
unchanged. Consumers in `apps/api` therefore do not need behavioral or payload
changes.

## Template content

| Template                | Hero/context             | Heading                | Primary action        | Supporting information                                          |
| ----------------------- | ------------------------ | ---------------------- | --------------------- | --------------------------------------------------------------- |
| Organization invitation | Organization name        | Invitation to the team | `Принять приглашение` | Inviter name and exact expiry date/time                         |
| Tenant-owner activation | Organization name        | Welcome to Markiro     | `Активировать доступ` | Existing-account password remains unchanged; one-time duration  |
| Email verification      | Account/email context    | Confirm email          | `Подтвердить email`   | Why confirmation is required; one-time duration                 |
| Password reset          | Account/security context | Restore access         | `Сбросить пароль`     | Request explanation; one-time duration and safe ignore guidance |

Copy stays direct and operational. It does not use promotional language or
exclamation marks. The current subjects remain stable:

- `Приглашение в <organization> — Маркиро`;
- `Доступ к <organization> — Маркиро`;
- `Подтвердите email — Маркиро`;
- `Восстановление пароля — Маркиро`.

Preview text keeps the same scenario-specific intent. User-provided names and
organization values continue to be escaped by React rendering. Raw action URLs
remain available below the button and in the generated plain-text version.

## Rendering and data flow

`renderEmail` continues to resolve a typed input into a subject and React
element, render HTML with React Email, and derive plain text from that HTML.
The redesign adds no asynchronous data lookup, environment access, asset fetch,
or side effect inside the template package.

The template props remain the only data source. Missing or invalid business
data continues to be rejected or prevented at the existing typed/application
boundary; the visual components do not invent substitute organization names,
recipients, URLs, or expiry values.

## Compatibility and accessibility

- Use semantic headings, paragraphs, links, and table-based structural layout
  supported by React Email.
- Keep all important information as text; color and the green module are not the
  only indication of purpose or expiry.
- Give the CTA sufficient contrast and a generous tap area.
- Keep the raw fallback URL selectable and allow it to wrap without overflowing.
- Use email-safe fallback font stacks with IBM Plex first, followed by system
  sans-serif or monospace families. The result must remain legible without IBM
  Plex and must not fetch a font at runtime.
- Avoid hover-dependent meaning, animation, gradients, background images,
  absolute positioning, and fragile CSS layout.
- Preserve the hidden preview text and `lang="ru"` document language.

## Verification

Focused automated tests in `packages/email/test/render.test.tsx` will cover all
four template kinds and assert:

- stable subjects and useful preview text;
- escaped recipient and organization values;
- scenario-specific heading and CTA copy;
- raw fallback URLs in HTML/plain text;
- duration and invitation-expiry output;
- first-owner copy does not claim that a password reset was requested;
- the exact Markiro brand name and structural marker are rendered;
- no remote image, tracking pixel, or externally hosted asset is introduced;
- plain text remains useful and free from layout markup.

Implementation verification must run the package test, typecheck, lint, and
build commands. A rendered narrow-width preview is required as a manual visual
check. Browser preview does not prove rendering in Gmail, Outlook, Apple Mail,
or mobile inbox applications; representative inbox-client checks remain an
explicit external gate and must be reported separately.

## Expected change area

The implementation is limited to:

- `packages/email/src/layout.tsx` and small shared presentation modules if the
  layout is split;
- the four existing template files under `packages/email/src/`;
- `packages/email/test/render.test.tsx`;
- one React Email preview entry for each of the four templates under
  `packages/email/emails/`.

No API, database, migration, SMTP, job, or deployment change is expected.
