# US-12: optional landing and supplementary demo materials

Date: 2026-09-04. Status: revised design, not implemented. Priority: P1.

Read the [shared MVP contract](../../us/mvp-contract.md) first. US-11 owns the P0 English walkthrough and screenshots. This slice is optional and cannot block the processor MVP.

## Purpose and scope

Reuse the existing landing components and brand for a static U.S. product explanation. Do not reuse the existing hosting, analytics, demo-request or mail delivery path. The page describes only capabilities backed by the tagged build and its verification report.

A published U.S. page, its assets, visitor logs and telemetry belong to the approved non-RF deployment inventory. Provider, region, domain, operating cost and publication require separate owner approval. Neither the current RU website nor the RU release bucket is an approved U.S. default.

## Page and API boundary

Proposed path: `/en/us-food-traceability/` on the chosen U.S. origin. Canonical, Open Graph, sitemap and any hreflang alternate use that origin. English is primary; the Spanish alternate uses `es-US` in the same instance. Russian is not a U.S. locale; no language switch crosses data planes.

No database, demo-request API or consent-form changes are included. No `DEMO_SOURCE_PATHS` addition, no shared `LANDING_DEMO_RECIPIENT`, no form, mailto fallback or analytics collection. P0/P1 static CTAs are **Watch the demo**, **Read the documentation**, **View the synthetic dataset** and **Read the limitations**. Never publish a fictional phone number as a contact.

If contact collection is later requested, first approve the data flow, privacy notice, consent basis where needed, processors, mail storage, retention and abuse controls. A translated RU consent is not sufficient design approval.

## Page content

1. Hero: Markiro U.S. Traceability; a bounded processor MVP and its three-event workflow.
2. Receiving, Transformation, Shipping: real screenshots from the same tagged synthetic build.
3. Lots and genealogy: two inputs, one output, 100 cases as a quantity. Case/Station identity is optional P1, not implied by the quantity.
4. Trace request: reviewed scope, validation, plan and XLSX package prepared in the U.S. instance; no direct FDA submission.
5. Verification: measured results with dataset/build/environment labels. Do not publish an unmeasured speed promise.
6. Limitations: the approved statement from [limitations](../../us/limitations.md), with a drift check.
7. Read/watch links, with accessible captions and artifact versions.

The existing Markiro foundation may be described separately from the U.S. MVP. Do not present inherited RU Station/scanner behavior as verified U.S. case-only operation.

## Claims and design

Use shared `packages/ui` tokens and existing landing components. Keep one brand, text-based statuses, keyboard access, reduced-motion support and factual image descriptions. Layout references are not evidence of an implemented screen.

The claims checker scans affirmative regulatory claims in U.S. rendered content, metadata and scripts. It must allow the exact approved negated disclaimer and test corpus, not reject ordinary actions such as **Approve version** or every occurrence of the word “approved”. A specialist memo does not automatically authorize a stronger claim; wording needs its own scoped review.

## Video handoff to US-11

US-11 delivers the P0 5–8 minute English walkthrough with captions/transcript and 12–18 screenshots. Record the nine steps in [demo scenario](../../us/demo-scenario.md). Show the permanent synthetic label, build/seed/baseline and the actual measured package result. Do not change the operating-system clock. Fixed fixture dates and any demo-clock override are labelled.

Store large media outside git in approved U.S. object storage with immutable keys, byte size, content type and SHA-256. A static poster links to the video; no third-party iframe or tracking script is needed. Do not reuse the RU Station release origin or uploader credentials. A local synthetic recording can be prepared before hosting is selected; do not claim a public URL exists until it is verified.

## Optional supplementary materials

US-12 may provide an English one-pager, deck outline, discovery questions and neutral product-feedback/review templates. Use U.S. Letter for print by default. Templates contain no real recipient data, fabricated feedback or purchase commitments. Public documents cite only obtained, consented evidence; private records remain outside git and outside RF persistence.

No external contact, media upload or publication is authorized by these specifications. Those actions need the user's request.

## Verification and release evidence

- Landing typecheck, lint, tests and build; U.S. routing/metadata/claims fixtures.
- Browser checks at desktop and mobile widths, keyboard/reduced-motion, poster fallback and caption availability.
- Network inspection: no RU API, analytics, mail, storage or release origin; static mode makes no lead POST.
- Current hosting/log/backup inventory verified before publication; synthetic-only screenshots and media hashes checked.
- Link the exact tag, screenshot manifest and limitations. Report unperformed external checks explicitly.

## Not included

Commercial billing, pricing, sign-up, lead capture, privacy-policy implementation, paid ads, new analytics, full deck production or automatic publication. No RU production workflow changes are needed for this static slice.

## Open questions

| ID         | Question                                                                                                                                                  | Options                                         | Recommendation                                                                                                                                                                                              | Blocking? |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| OQ-US12-1  | How should the Spanish alternate be presented on the U.S. origin?                                                                                         | English default / Spanish alternate             | EN/ES language decision accepted; P1 landing uses reciprocal same-origin hreflang when both versions are published.                                                                                         | no        |
| OQ-US12-2  | Hosting/contact collection boundary                                                                                                                       | Separate later approval                         | Resolved: static landing; approved non-RF origin only; no lead form or email fallback. See [MVP contract](../../us/mvp-contract.md).                                                                        | no        |
| OQ-US12-3  | Hosting/contact collection boundary                                                                                                                       | Separate later approval                         | Resolved: static landing; approved non-RF origin only; no lead form or email fallback. See [MVP contract](../../us/mvp-contract.md).                                                                        | no        |
| OQ-US12-4  | Load the limitations paragraph from `docs/us/limitations.md` at build time or duplicate it with a checksum test?                                          | import / duplicate + test                       | Duplicate in `us-traceability.ts` with a drift test comparing to the markdown; avoids a docs→landing build dependency (recommended, pending confirmation; applied consistently in Domain rules and Testing) | no        |
| OQ-US12-5  | Hosting/contact collection boundary                                                                                                                       | Separate later approval                         | Resolved: static landing; approved non-RF origin only; no lead form or email fallback. See [MVP contract](../../us/mvp-contract.md).                                                                        | no        |
| OQ-US12-6  | `apps/landing` does not depend on `@markiro/domain` for content today; import `claims.ts` from the domain package or copy the patterns with a drift test? | import domain / copy + drift test               | Import (`@markiro/domain` is already a landing dependency in `apps/landing/package.json`); one list                                                                                                         | no        |
| OQ-US12-7  | Stronger public regulatory wording                                                                                                                        | Keep MVP language / separately reviewed wording | Keep bounded MVP language. A memo alone never unlocks a stronger claim.                                                                                                                                     | no        |
| OQ-US12-8  | Should the deck be produced with the `frontend-slides` HTML approach and committed, or kept outside the repo?                                             | commit HTML deck / outline only                 | Outline only; a committed deck would need the same wording gate and screenshots that go stale                                                                                                               | no        |
| OQ-US12-9  | May external feedback name participants publicly, or should public records contain only consented ids and hashes?                                         | ids+hashes / redacted copies in git             | Ids and hashes in git; originals remain private and sealed, and names require explicit publication consent                                                                                                  | no        |
| OQ-US12-10 | README: does US-12 add the positioning paragraph, or is the whole README section owned by US-11?                                                          | US-11 / US-12 / both                            | US-11 adds the section (seed command, docs link); US-12 adds only the video and page links to it                                                                                                            | no        |
