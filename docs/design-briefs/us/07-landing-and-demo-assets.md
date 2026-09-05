# U.S. design brief 07: optional landing and demo assets

Date: 2026-09-04. Status: design reference, not implemented. Priority: P1, except the screenshots/video owned by US-11.

Read the [shared MVP contract](../../us/mvp-contract.md) and [US-12 spec](../../superpowers/specs/2026-09-03-us-12-landing-video-demo-assets-design.md) first. Reuse the Markiro brand, typography and components; `packages/ui` is the source for production tokens. Do not redesign the RU landing.

## Purpose

Explain the bounded food-processor MVP through actual synthetic screens and artifacts. Show what exists, its limits and how it was verified. Do not imply production readiness, certification, automatic coverage decisions or a measured speed before results exist.

## Hosting and actions

The optional page uses a separately approved U.S. origin, not the current RU website or release bucket. Visitor logs and asset storage follow the same non-RF boundary. Domain and canonical URLs are unresolved until the owner chooses hosting; do not put `markiro.app` into the handoff as a default.

The first version is static. Draw no lead form, contact email fallback, fictitious phone contact, consent checkbox, tracking widget or sign-up. Reuse layout components, not the existing submission pipeline.

Allowed actions: **Watch the demo**, **Read the documentation**, **View the synthetic dataset**, **Read the limitations**. Contact collection is a separate later scope with an approved privacy/mail/storage flow.

## Page structure

| Section       | Content                                                                               |
| ------------- | ------------------------------------------------------------------------------------- |
| Hero          | Markiro U.S. Traceability: a bounded processor MVP. Read/watch CTAs.                  |
| Three events  | Receiving → Transformation → Shipping; real tagged screenshots.                       |
| Lots          | Two input lots, one output lot, 100 case as a quantity; no implied SSCC/Station work. |
| Trace request | Scope, missing-field validation, current plan, XLSX and hash-verified package.        |
| Verification  | Dataset/build/environment and measured results; synthetic label visible.              |
| Foundation    | Shared Markiro capabilities, clearly separated from U.S. acceptance.                  |
| Limitations   | Approved statement as live text, with a link to the current document.                 |
| Read/watch    | Documentation, dataset and captioned English walkthrough.                             |

No pricing, contact capture, compliance badges, unsupported CTE stubs or unverified case-scanning claims. Generic-profile material, if later added, says “General lot traceability only; FTR applicability is not assessed in this profile.”

## Visual assets and states

Use the existing landing theme. Design 1440, 834 and 390 px widths with content-driven heights. Screenshot captions repeat build, seed and baseline provenance; never crop away the synthetic label. The P0 set is 12–18 screenshots of implemented office flows. Station frames are optional P1, not replacements for missing office evidence.

Video is the US-11 5–8 minute English walkthrough. Use a static poster and link naming the actual duration/size, with captions/transcript. No third-party iframe. Keep large originals in approved U.S. media storage with hashes, not git or the RU release origin.

Draw default page, narrow layout, long captions, poster unavailable, unavailable video link, keyboard focus and reduced motion. A link without a published target is omitted or shown as unavailable, not as a working CTA. No form-state designs are needed.

## Optional print kit

One-pager, deck outline, discovery questions and review/feedback templates are P1. English, U.S. Letter by default, existing Markiro letterhead, same limitations and build references. Do not fabricate reviewer identity, feedback or contact details. Actual feedback is recorded only when obtained with the appropriate permission and remains outside git if private.

## Accessibility and metadata

One H1/main region, sequential headings, skip link, keyboard-visible focus, 44 px interactive targets, AA contrast and reduced-motion support. Limitations are text, not an image. Media has factual alt text, caption and transcript links.

Canonical, sitemap, Open Graph and any hreflang use the chosen U.S. origin. English is primary; a Spanish alternate uses `es-US` and the same deployment. Russian is not a U.S. locale. There is no forced cross-country redirect. Do not imply a live page or public media URL before deployment verification.

## Questions for the designer

1. Which existing hero pattern best presents the three-event workflow without implying a full production launch?
2. Which Spanish copy and media captions are needed for the P1 localized landing, alongside the English default?
3. Which tagged screenshot best introduces the workflow at desktop and mobile widths?
4. How should the video-unavailable state keep documentation accessible without a dead CTA?
5. Does the existing Letter adaptation preserve readable limitations and provenance on the one-pager?
6. Can the existing demo-chain diagram be reused without redrawing its data or adding an SSCC dependency?
