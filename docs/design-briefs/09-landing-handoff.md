# Markiro landing: engineering handoff and motion scenario

Status: implemented; production integration gates remain

Design source: local Pencil canvas `docs/design-briefs/landing.pen`

The Pencil container is intentionally local-only because the editor stores a
cloud-scoped file token in it. The versioned handoff below records the stable
artboard node IDs, dimensions, behavior, and implementation contract without
publishing that token.

Target: `markiro.app`, consultation sale through a demo request and phone

Last updated: 2026-08-14

## 1. Purpose and accepted direction

The landing explains Markiro as an industrial marking platform for small and
medium-sized manufacturers. The primary story is a continuous production flow:
release codes, print labels, scan units, aggregate into boxes and pallets, and
retain traceability when the connection is unstable.

The approved visual direction combines:

- the dark photographic hero and line-console motif from concept B;
- the large industrial typography and product-cycle explanation from concept C;
- custom-drawn product scenes instead of literal admin screenshots;
- one dark page theme, with green reserved for calls to action and semantic
  success/active states;
- a consultation conversion model. There is no pricing table in this version.

This document supersedes conflicting visual and structural guidance in
`05-landing.md` for the approved v1 artboards. In particular, v1 uses a dark
theme and omits the pricing table. The approved artboards also omit a video,
FAQ, and a separate product-groups section; restore any of those only through a
content/design decision before implementation.

## 2. Source artboards

| Viewport | Artboard             | Node ID  | Canvas size |
| -------- | -------------------- | -------- | ----------- |
| Desktop  | Landing - B+C Hybrid | `BBcHk`  | 1440 x 7400 |
| Tablet   | Landing Tablet 834   | `ESUfk`  | 834 x 6290  |
| Mobile   | Landing Mobile 390   | `S1sumZ` | 390 x 7580  |

The concept artboards A, B, and C remain exploration history. They are not an
implementation source. The final desktop, tablet, and mobile artboards above
are the source of truth for layout and visual hierarchy.

### 2.1 Section map

| Section              | Desktop y / height | Tablet y / height | Mobile y / height |
| -------------------- | -----------------: | ----------------: | ----------------: |
| Hero                 |            0 / 900 |           0 / 950 |           0 / 900 |
| Continuity statement |          900 / 720 |         950 / 700 |         900 / 820 |
| Production cycle     |        1620 / 1050 |        1650 / 850 |        1720 / 900 |
| Product modes        |        2670 / 1400 |        2500 / 950 |       2620 / 1450 |
| Traceability         |         4070 / 900 |        3450 / 750 |        4070 / 900 |
| Platform expansion   |         4970 / 850 |        4200 / 700 |        4970 / 850 |
| Implementation       |         5820 / 700 |        4900 / 620 |        5820 / 760 |
| Demo CTA and footer  |         6520 / 880 |        5520 / 770 |       6580 / 1000 |

Section heights describe the approved canvases, not fixed CSS heights. The
implementation must use content-driven `min-height`, padding, and grid layout so
Russian text zoom, validation errors, and browser font metrics cannot clip
content.

## 3. Implementation boundary

The landing is implemented as the standalone Astro 7 application
`apps/landing`. It owns the public route, semantic page components, progressive
enhancement scripts, and production build. Deployment ownership and the real
form backend remain separate production-launch requirements; do not move the
landing into `apps/admin` to supply either of them.

The landing should import shared styles from `@markiro/ui/styles.css`. Reuse the
existing tokens and fonts. Because the target is Astro, prefer semantic Astro
components, HTML, CSS, and small framework-free scripts. Do not add React only
to reuse a simple button or input implementation.

JavaScript is progressive enhancement. The page, navigation, product story,
form labels, and contact path must remain readable if scripts fail. The form may
require JavaScript to submit asynchronously, but it must expose a useful error
and a direct phone contact when submission is unavailable.

## 4. Layout and responsive behavior

### 4.1 Breakpoints

| Mode    | Range             | Primary behavior                                         |
| ------- | ----------------- | -------------------------------------------------------- |
| Mobile  | 0-767 px          | Single column; compact header; product scenes below copy |
| Tablet  | 768-1199 px       | Two-column sections where legible; reduced type scale    |
| Desktop | 1200 px and wider | 12-column composition; max content width 1200 px         |

Use content breakpoints, not device detection. The three approved artboards are
reference checkpoints, not the only supported widths. Verify at 320, 390, 768,
834, 1024, 1280, 1440, and 1920 px.

### 4.2 Containers and spacing

| Mode    |    Page gutter | Content width | Column gap |
| ------- | -------------: | ------------: | ---------: |
| Desktop | at least 40 px |   1200 px max |      24 px |
| Tablet  |          48 px |         fluid |      24 px |
| Mobile  |          16 px |         fluid |      16 px |

At 1440 px the desktop container produces 120 px side margins. At viewports
wider than 1440 px, keep content centered and allow full-bleed backgrounds or
the hero image to extend beyond the container. Do not scale the entire page up.

Section vertical spacing should use the shared spacing scale. Typical desktop
section padding is 96-128 px, tablet 72-96 px, and mobile 64-80 px. When the
exact artboard spacing falls between shared values, combine tokens with a
landing-local custom property instead of adding arbitrary margins to individual
children.

### 4.3 Responsive transformations

- Header: full nav on desktop and tablet. On mobile, show logo, primary demo
  action, and a menu trigger. The opened menu is a modal sheet below the header.
- Hero: desktop uses copy and line-console composition over the factory image.
  Tablet preserves the two-part hierarchy with more overlap. Mobile stacks
  headline, CTA, and console; text must never sit over a visually noisy image.
- Production cycle: desktop presents the process as one horizontal system;
  tablet may retain two columns; mobile becomes a vertical ordered sequence.
- Product modes: desktop alternates copy and interface scenes. Tablet uses two
  balanced columns when each scene remains at least 320 px wide. Mobile stacks
  copy before its corresponding scene.
- Traceability: event log remains a semantic list/table. On narrow screens,
  secondary metadata wraps below the event title; no horizontal page scroll.
- Platform modules: desktop grid becomes two columns on tablet and one column on
  mobile. Reading order must match DOM order.
- Implementation steps: desktop horizontal sequence becomes a vertical ordered
  list on mobile.
- Demo section: desktop copy and form are side by side. Tablet and mobile stack
  copy before form. The phone contact stays visible before and after submission.

## 5. Design tokens

Apply `.theme-dark` at the landing page root. The following mappings already
exist in `packages/ui/src/tokens.css` and should be used directly.

| Role            | Token             | Dark value | Usage                                  |
| --------------- | ----------------- | ---------- | -------------------------------------- |
| Page background | `--surface-page`  | `#131216`  | Main page and dark full-bleed sections |
| Card background | `--surface-card`  | `#1c1b21`  | Product scenes, form, cards            |
| Raised panel    | `--surface-panel` | `#232228`  | Nested console regions, hover surfaces |
| Primary text    | `--fg-1`          | `#fafaf8`  | Headings, strong values                |
| Secondary text  | `--fg-2`          | `#b6b3ab`  | Body copy, labels                      |
| Muted text      | `--fg-3`          | `#8e8b83`  | Metadata, timestamps                   |
| Divider         | `--line`          | `#2e2d33`  | Section and row rules                  |
| Strong divider  | `--line-strong`   | `#45444b`  | Controls and emphasized boundaries     |
| Accent          | `--accent`        | `#3ddc7a`  | Primary CTA, active and success state  |
| Accent hover    | `--accent-strong` | `#6be599`  | CTA hover and selected emphasis        |
| Focus           | `--focus-ring`    | `#6db2ff`  | Keyboard focus only                    |

Do not use green as decoration behind entire sections or large paragraphs. A
green element must either be actionable or convey a real positive/active state.
Use the existing semantic warning/error tokens for problems; do not recolor an
error as brand green.

### 5.1 Typography

Use IBM Plex Sans for editorial and UI copy and IBM Plex Mono for codes,
timestamps, counters, and compact operational metadata. The local Fontsource
files in `@markiro/ui` avoid a runtime CDN dependency.

The landing requires a display scale larger than the product UI scale. Keep it
local to the landing until another public surface needs it:

```css
:root {
  --landing-display-xl: 700 clamp(48px, 5.3vw, 76px) / 0.98 var(--font-ui);
  --landing-display-lg: 700 clamp(41px, 4.3vw, 62px) / 1.02 var(--font-ui);
  --landing-display-md: 700 clamp(34px, 3.35vw, 48px) / 1.05 var(--font-ui);
  --landing-lead: 400 clamp(18px, 1.5vw, 22px) / 1.45 var(--font-ui);
  --landing-kicker: 600 12px / 16px var(--font-mono);
}
```

Do not use bitmap text, CSS text stretching, or a substitute display font. Keep
line lengths around 10-14 words for large headings and 55-75 characters for body
copy.

### 5.2 Borders, radii, and shadows

- Use `--r-1` to `--r-3` (4, 8, and 12 px). Avoid pill cards. Pills are allowed
  only for compact status chips when they improve scanning.
- Prefer 1 px borders using `--line` or `--line-strong` over large shadows.
- Product scenes may use one restrained shadow or dark backdrop separation, but
  must still read when shadows are disabled.
- CTA and form controls use the existing 40 px minimum control height. Important
  touch actions should be at least 44 x 44 CSS px on the public site.

## 6. Component inventory

The names below describe responsibilities, not mandatory filenames.

### `LandingHeader`

- Props/content: logo link, section links, phone, primary CTA label.
- States: default, scrolled, mobile menu closed/open.
- The scrolled header may gain an opaque dark background and bottom border. Do
  not blur the whole viewport continuously.
- The logo links to the page start. Anchor links update the URL hash without
  stealing keyboard focus.

### `HeroSection`

- Content: eyebrow, H1, supporting copy, primary demo CTA, direct phone contact,
  factory image, and `LineConsoleScene`.
- H1 is the only level-one heading.
- The factory photo is atmosphere, not evidence of a specific customer. Do not
  add a customer name or claim without permission.

### `LineConsoleScene`

- Custom HTML/CSS/SVG product illustration inspired by the line-station UI.
- Show current task, connection state, scanned/accepted counters, and the next
  operational action.
- It is illustrative and must not imply live data. Use deterministic values.
- Mark the scene `aria-hidden="true"` when all its meaning is repeated in adjacent
  copy. Otherwise provide one concise accessible summary, not every decorative
  row.

### `ContinuityStatement`

- Large editorial statement with a vertical accent rule and supporting copy.
- The accent rule is decorative and hidden from assistive technology.

### `ProductionCycle`

- Semantic ordered list of stages: codes, print, scan, aggregation, reporting.
- The visual console is a second representation of the same sequence, not the
  only place where stage names appear.
- Current/complete markers must include text or accessible labels, not color
  alone.

### `ProductModeSection`

- Reusable shell for section title, description, operational bullets, and a
  custom product scene.
- Variants cover code handling and print/aggregation. Prefer content slots over
  a large set of booleans.
- On mobile, heading and explanation precede the scene in DOM order.

### `TraceLog`

- Use a list or table depending on final content density. If column headers are
  visible and rows share fields, use a real table.
- Problem rows include a text status and recovery action. Never rely only on a
  red dot.
- Timestamps use `<time datetime="...">`.

### `PlatformModules`

- Grid of short capability cards. Each card contains title, one sentence, and
  optional semantic status.
- Cards are not links unless a real destination exists. Avoid empty hover
  affordances.

### `ImplementationSteps`

- Ordered list with explicit sequence and expected owner/outcome.
- Keep the promise consultative; do not invent fixed deployment timelines.

### `DemoForm`

- Fields: name, company, and phone. If an email or consent checkbox becomes a
  backend requirement, update the design before shipping rather than inserting
  it silently.
- Always-visible labels. Placeholders may show format examples but cannot replace
  labels.
- Primary submit action uses the shared accent treatment. The phone remains a
  separate link.

## 7. Demo form contract and states

The final endpoint and CRM integration are not yet defined. Agree on the API
contract before implementation. Do not send the form directly to a third-party
browser endpoint if that would expose credentials or weaken rate limiting.

| State                   | Required behavior                                                                                                             |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Idle                    | Empty fields, labels visible, submit enabled only according to agreed validation strategy                                     |
| Focus                   | `--focus-ring` at 2 px with 2 px offset; no layout shift                                                                      |
| Invalid                 | Inline field error, `aria-invalid=true`, error linked with `aria-describedby`                                                 |
| Submitting              | Submit disabled, label changes to a progress phrase, duplicate submissions blocked                                            |
| Success                 | Form replaced in place by a confirmation, phone remains available, focus moves to confirmation heading                        |
| Recoverable error       | Values retained, inline form-level error shown, retry possible                                                                |
| Rate limited            | Plain retry guidance without exposing backend details                                                                         |
| Offline/network failure | Explain that the request was not sent and offer phone contact; never claim queued delivery unless a real durable queue exists |

Client validation improves feedback but does not replace server validation.
Normalize phone input at the server boundary and store only the data required by
the lead workflow. Define retention, consent text, and privacy-policy linkage
with the final legal copy.

Use an `aria-live="polite"` region for submission status. Unexpected server
errors should have an observable request ID in server logs, but no stack trace or
internal identifier in the public UI.

## 8. Content constraints

- H1: target 55-90 characters in Russian; two lines on desktop/tablet and no
  more than three lines at 390 px. At 320 px, allow natural wrapping without
  reducing below 42 px solely to preserve a line count.
- Section H2: target 25-65 characters; no truncation.
- Body paragraphs: target 140-320 characters; no clamping on core sales copy.
- Navigation labels remain one line on desktop/tablet. If content grows, reduce
  the number of links rather than shrinking text below the shared body size.
- Status labels and recovery messages never truncate. Codes may wrap at safe
  separators or use an internal horizontal scroller, but the page itself must
  not scroll horizontally.
- Phone number uses a real `tel:` link and a human-readable Russian format.
- Avoid unsupported claims such as exact implementation time, guaranteed
  uptime, customer counts, or regulatory certification.

The page should naturally contain the search phrases "маркировка Честный знак",
"агрегация" and "сериализация" in meaningful headings or body copy. Do not hide
essential SEO text inside a canvas, image, or JavaScript-only scene.

## 9. Motion scenario

Motion intensity: 5/10. The experience should feel precise and operational, not
cinematic. Motion confirms hierarchy and state; it never delays access to copy.

### 9.1 Global rules

- Animate only `opacity` and `transform` for entrance effects.
- Use CSS transitions/keyframes and `IntersectionObserver`. Do not add GSAP or a
  React motion library for this scenario.
- Reveals run once when about 18% of a section enters the viewport.
- Default reveal: opacity 0 to 1 and translateY 12 px to 0 in 280-320 ms.
- Direct siblings may stagger by 40 ms, with a maximum total cascade of 160 ms.
- No infinite scanner beam, blinking error, fake progress, count-up, cursor
  follower, scroll hijacking, or parallax.
- Content starts visible in HTML. A short enhancement script adds the pre-reveal
  state only after it is ready, preventing invisible content when scripts fail.

### 9.2 Sequence

| Moment              | Element                         | Motion                                                  | Duration / delay                            |
| ------------------- | ------------------------------- | ------------------------------------------------------- | ------------------------------------------- |
| Initial load        | Header                          | Fade from 0 to 1                                        | 180 ms / 0                                  |
| Initial load        | Hero eyebrow, H1, lead, actions | Fade and translateY 16 to 0 as one compact sequence     | 360 ms / 40 ms sibling stagger              |
| Initial load        | Factory photo                   | Scale 1.025 to 1 with opacity settling                  | 850 ms / 0                                  |
| Initial load        | Line console                    | Fade and translateY 24 to 0                             | 460 ms / 140 ms                             |
| Continuity enters   | Accent rule                     | ScaleY 0 to 1 from top                                  | 220 ms / 40 ms                              |
| Cycle enters        | Stage rows                      | Reveal in process order                                 | 280 ms / 100 ms per stage, max 400 ms total |
| Product mode enters | Scene and copy                  | Copy first, scene second                                | 320 ms / 80 ms separation                   |
| Trace enters        | Event rows                      | Reveal in chronological order; problem row settles last | 260 ms / 70 ms per row, max 350 ms total    |
| Platform enters     | Module cards                    | Short row-wise reveal                                   | 280 ms / 40 ms stagger                      |
| CTA enters          | Copy and form                   | Simultaneous soft reveal                                | 320 ms / 0                                  |

Operational numbers and statuses are static. Do not animate them from zero or
simulate a machine changing state. The landing demonstrates the product model,
not a live production run.

### 9.3 Interaction motion

- Primary CTA hover: background changes to `--accent-strong` in 120 ms.
- Primary CTA active: translateY 1 px and scale 0.99 for 60 ms.
- Secondary controls: border and surface change in 120 ms; no floating card
  effect.
- Header anchor navigation uses native smooth scrolling only when reduced motion
  is not requested. Account for the sticky header with `scroll-margin-top`.
- Mobile menu opens with opacity plus translateY -8 px to 0 in 180 ms. On close,
  restore focus to the trigger.
- Form spinner, if used, is the only continuous animation and stops immediately
  when submission resolves.

### 9.4 Reduced motion

```css
@media (prefers-reduced-motion: reduce) {
  html {
    scroll-behavior: auto;
  }

  [data-reveal],
  [data-motion] {
    animation: none !important;
    transition-duration: 0.01ms !important;
    transform: none !important;
    opacity: 1 !important;
  }
}
```

Reduced-motion mode removes stagger, image scale, smooth scrolling, and menu
translation. It must not remove state feedback, focus indication, or loading
text.

## 10. Accessibility requirements

- Use one `<main>`, one H1, and sequential heading levels. Each major section is
  labelled by its H2.
- Include a visible-on-focus skip link before the header.
- Maintain at least WCAG 2.2 AA contrast. Verify text over the factory image at
  the actual responsive crops; apply a stable dark overlay where needed.
- All pointer targets are at least 44 x 44 CSS px when isolated.
- Keyboard focus follows DOM reading order and is never moved merely because a
  section revealed.
- Mobile menu uses an actual button with `aria-expanded`; Escape closes it;
  focus is contained while the sheet is modal and restored on close.
- Decorative SVG and UI scenes use `aria-hidden="true"` and cannot contain
  focusable elements. Meaningful diagrams have concise accessible summaries.
- The factory image uses empty alt text if decorative. If copy depends on it,
  provide a factual alt without marketing claims.
- Form errors are announced and linked to fields. Success and failure are not
  conveyed by color alone.
- At 200% browser zoom and 320 CSS px width, content and controls remain usable
  without two-dimensional scrolling.

## 11. SEO, metadata, and semantics

- Define a unique Russian `<title>` and meta description after copy approval.
- Add canonical URL for `https://markiro.app/` when the deployment host is final.
- Provide Open Graph and social preview assets derived from the approved visual
  direction, not a screenshot of an internal admin screen.
- Add `Organization` structured data only with verified legal/contact fields.
- Use real section anchors and crawlable text. Product scenes supplement, not
  replace, semantic content.
- Do not index a staging host. Production `robots.txt` and sitemap require a
  deployment check.

## 12. Performance requirements

- Convert the hero factory asset to responsive AVIF/WebP with a fallback. Keep
  explicit intrinsic dimensions and an art-directed mobile crop.
- Preload only the chosen hero source and the minimum font files needed above
  the fold. Lazy-load non-critical images.
- Build custom product visuals as HTML/CSS/SVG. Do not export them as large
  screenshots.
- Self-host all fonts/assets. No runtime dependency on a third-party CDN.
- Use one `IntersectionObserver`, not scroll listeners per component. Disconnect
  observed nodes after their one-shot reveal.
- Avoid client hydration for static sections. Keep the mobile menu, motion
  observer, and form enhancement as small isolated scripts.
- Production targets: LCP below 2.5 s, CLS below 0.1, INP below 200 ms at the
  75th percentile. Validate on the deployed origin as a separate gate.

## 13. Analytics proposal

Event names are proposed and require agreement with the analytics owner before
implementation:

| Event                  | Trigger                            | Safe properties                   |
| ---------------------- | ---------------------------------- | --------------------------------- |
| `landing_demo_click`   | Primary CTA activation             | placement: hero/header/footer     |
| `landing_phone_click`  | Phone link activation              | placement                         |
| `landing_nav_click`    | Section navigation                 | section ID                        |
| `landing_form_start`   | First meaningful field interaction | none                              |
| `landing_form_submit`  | Valid submit attempt               | none                              |
| `landing_form_success` | Backend accepted lead              | none or non-sensitive lead source |
| `landing_form_error`   | Submit failed                      | coarse error class only           |

Never send a name, company, phone, field value, free-form error, or request body
to analytics. Consent and analytics loading strategy must match the final legal
decision.

## 14. Edge cases

- JavaScript disabled or enhancement script fails.
- Hero image fails to load: copy and console retain sufficient contrast.
- Very long company name or autofilled phone value.
- Server returns validation errors, 429, 5xx, timeout, or malformed response.
- User submits twice, navigates back after success, or reloads during submission.
- Mobile virtual keyboard reduces viewport height.
- Browser translation or Russian copy expansion changes line count.
- `prefers-reduced-motion`, forced colors, high contrast, and 200% zoom.
- Slow 3G and Save-Data mode.
- Anchor navigation with a sticky header.
- 320 px viewport and ultrawide desktop.

## 15. Acceptance checklist

### Design fidelity

- Desktop, tablet, and mobile compositions match the three source artboards.
- Green appears only on actions and real semantic states.
- Product scenes are drawn interfaces, not admin screenshots.
- No section uses a fixed height that clips translated or validated content.
- Final page contains no placeholder phone, policy link, analytics ID, or lead
  endpoint.

### Functional

- Header anchors, mobile menu, phone link, and every demo CTA work by keyboard
  and pointer.
- Form covers idle, invalid, submitting, success, recoverable error, rate-limit,
  and offline states.
- Duplicate submissions are blocked and input survives recoverable errors.
- Page remains useful without JavaScript.

### Automated checks

- Astro build and type checks pass.
- Focused form validation/submission tests cover success and failure paths.
- Component tests cover mobile menu focus restoration and Escape behavior.
- Accessibility automation reports no serious violations on all three target
  viewports.
- Link, metadata, sitemap, and production bundle checks pass.
- `git diff --check` and repository formatting checks pass.

### Manual and external checks

- Compare 390, 834, and 1440 px renders with the locally maintained Pencil
  canvas.
- Test keyboard-only navigation, screen-reader form feedback, 200% zoom, and
  reduced motion.
- Check real responsive image crops and text contrast in browser.
- Verify the final phone, privacy-policy URL and legal copy.
- Verify the real lead endpoint/CRM delivery without exposing customer data in
  logs or analytics.
- Verify production DNS, TLS, caching, robots, sitemap, analytics, and Web Vitals
  on the deployed origin. Local build success does not establish these gates.

## 16. Decisions required before production launch

1. Final public phone number and its hours/owner.
2. Final privacy-policy URL, consent wording, and analytics consent behavior.
3. Lead API endpoint, ownership, rate limits, abuse protection, retention, and
   CRM/mail delivery path.
4. Final copy approval, including any customer evidence or product claims.
5. Analytics provider and final event contract.
6. Whether video, FAQ, and product-group content stay out of v1 or return through
   an additional design pass.
7. Deployment route, release process, monitoring, and production ownership for
   `apps/landing`.
