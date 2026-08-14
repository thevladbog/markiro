# Markiro Landing SEO and AI Discoverability Design

**Date:** 2026-08-14
**Status:** Approved for implementation
**Domain:** `https://markiro.app`

## Goal

Turn the existing one-page Astro landing into a truthful, crawlable Russian
product site that can rank for distinct manufacturing-marking intents, serve as
a reliable source for search-grounded AI answers, send demo requests to the CRM
through a production-safe boundary, and ship through the existing direct-Caddy
deployment without changing the admin or kiosk authorities.

Success means the repository is ready for publication and repeatable audits.
It does not mean a new domain is indexed or cited on release day. DNS, ACME,
webmaster ownership, live indexing, field Core Web Vitals, and AI citations are
external gates measured after publication.

## Non-goals

- Do not manufacture customer names, testimonials, ratings, prices, partner
  relationships, certifications, or unsupported product capabilities.
- Do not create keyword-swapped near-duplicate pages or automatically generated
  articles.
- Do not enable analytics, advertising pixels, or model-training crawlers by
  default.
- Do not implement or guess the CRM's private contract. The public form boundary
  remains disabled until the CRM team supplies and accepts the exact endpoint.
- Do not rename or repurpose the existing admin and kiosk production domains.
- Do not publish DNS or trigger a production deployment as part of the code
  change.

## Audience and language

The initial site is Russian-only and targets Russian manufacturers, production
managers, marking-project owners, line engineers, and IT/1C integrators. Every
page must make sense to a first-time visitor without requiring knowledge of the
Markiro UI.

`<html lang="ru">` is authoritative. Do not add `hreflang` until a real second
locale exists.

## Information architecture

The first release contains these canonical routes:

| Route                       | Primary intent                          | Required substance                                                                                            |
| --------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `/`                         | Markiro product overview                | Product promise, continuity, production cycle, modules, implementation, links into the cluster, demo CTA      |
| `/markirovka-chestny-znak/` | Production marking workflow             | Code receipt/validation, printing, application, traceability, limitations and integration boundary            |
| `/sscc-i-agregatsiya/`      | SSCC and aggregation                    | Units, boxes and pallets, parent-child hierarchy, scan verification, disaggregation/recovery where supported  |
| `/rabochee-mesto-upakovki/` | Packing station                         | Operator flow, scanner/printer/local operation, status visibility and recovery                                |
| `/kiosk-samovydachi/`       | Self-service pickup kiosk               | Pairing, customer pickup flow, offline constraints, operator/admin boundary                                   |
| `/integratsiya-1c/`         | 1C integration                          | Supported exchange boundary, ownership of data, safe failure/retry model; no unsupported configuration claims |
| `/oflayn-rabota/`           | Factory continuity without connectivity | Local journal/outbox, reconnect, conflicts, recovery and what still requires the server                       |
| `/faq/`                     | Direct factual answers                  | Visible questions and concise answers derived from verified product behavior                                  |

The routes form a topic cluster rather than isolated campaign pages. The header,
footer, breadcrumbs, related-content links, and contextual inline links connect
them using descriptive Russian anchor text.

## Content evidence and editorial rules

Product copy must be derived from current code, tests, `docs/architecture.md`,
and accepted product/design documents. When sources disagree, current code and
tests win. A claim that cannot be verified is omitted or explicitly scoped as a
planned integration.

Each route contains:

1. one H1 and a direct answer/definition near the beginning;
2. a clearly ordered explanation of the workflow;
3. supported constraints and recovery behavior, not only benefits;
4. short answer-shaped paragraphs and lists that remain useful when extracted;
5. relevant internal links and one demo CTA;
6. a visible updated date only when the content entry records a real review date.

Use ordinary Russian terminology first and abbreviations second. Explain SSCC,
aggregation, traceability, offline journal, and other specialist terms in the
page that owns the concept. Avoid keyword stuffing and hidden SEO text.

## Content architecture

Route metadata and long-form copy live in typed, reviewable source modules rather
than being duplicated between templates and JSON-LD. A shared content layout
renders breadcrumbs, article headings, related routes, and the CTA. Page-specific
Astro files select the typed entry so Astro still emits one static HTML document
per canonical route.

The site content type includes:

```ts
interface SeoPageDefinition {
  path: `/${string}`;
  title: string;
  description: string;
  heading: string;
  socialImage: string;
  socialImageAlt: string;
  reviewedAt: `${number}-${number}-${number}`;
  relatedPaths: readonly `/${string}`[];
}
```

The content registry rejects duplicate paths and missing related routes in unit
tests. The sitemap is generated from the same registry. A route's `lastmod` is
its real `reviewedAt` value, not the deployment time.

## Metadata and structured data

Every route emits:

- a unique title and meta description;
- an absolute canonical URL on `https://markiro.app`;
- `robots=index,follow,max-image-preview:large,max-snippet:-1,max-video-preview:-1`;
- complete Open Graph data including site name, locale, URL, image dimensions,
  and image alt;
- explicit Twitter card title, description, image and image alt;
- theme color, icon and web manifest;
- no unsupported keywords meta tag.

JSON-LD is serialized with a safe JSON serializer and must match visible page
content. The graph contains:

- `WebSite` and a minimal `Organization` on every route;
- `SoftwareApplication` only with verified visible product facts and without
  offers, aggregate ratings, or operating-system promises that are not true;
- `BreadcrumbList` on non-root routes;
- `FAQPage` only on `/faq/`, using the same visible question and answer strings.

The organization graph includes only Markiro name, canonical URL, and repository
brand assets until legal name, public contacts, and public profiles are supplied.

## Robots and AI crawler policy

Search and user-directed retrieval are allowed; model-training crawlers are
blocked. `robots.txt` must express the approved split explicitly:

- allow generic crawlers, Googlebot, YandexBot, Bingbot and other conventional
  search crawlers;
- allow `OAI-SearchBot`;
- allow `Claude-SearchBot` and `Claude-User`;
- allow `PerplexityBot`;
- disallow all paths for `GPTBot` and `ClaudeBot`;
- advertise `https://markiro.app/sitemap.xml`.

`/llms.txt` is a small experimental content map with the product definition and
canonical links. It must not claim ranking or indexing benefit and is not a
replacement for visible HTML, internal links, robots, or sitemap.

Crawler-specific tests request the built site with representative User-Agent
strings and assert the public HTML does not vary. Robots policy controls crawling;
the application must not implement bot cloaking.

## Sitemap, URL, and error behavior

The sitemap contains only canonical, indexable, 200-response routes from the
content registry. URLs use HTTPS, the apex host, lowercase ASCII slugs, and a
trailing slash. UTM and other query parameters never change the canonical.

The edge serves actual files and directory indexes. An unknown route returns a
real 404 and never falls back to `/index.html`. `/robots.txt`, `/sitemap.xml`,
and `/llms.txt` return HTTP 200 with suitable text/XML content types.

If `www.markiro.app` is provisioned, it redirects permanently to the same path
and query on `https://markiro.app`. The apex remains canonical.

## Privacy, consent, and attribution

The static site, navigation, and demo form UI work without cookies. No analytics,
advertising, session-replay, or marketing script loads before a corresponding
consent signal.

The consent model has at least two optional categories: analytics and marketing.
Reject is as accessible as accept, the choice can be changed, and the banner does
not cover or mutate indexable content. The smallest necessary preference value
stores the decision; no visitor identifier is created by the consent component.

Analytics providers remain disabled until separately selected and configured.
The integration exposes typed hooks rather than a placeholder tracker. Referral
and UTM attribution may be attached to a lead only under the approved privacy
policy. Never include form field values in analytics events.

The following are publication blockers and require legal/product approval outside
this implementation:

- privacy policy;
- cookie policy;
- form personal-data consent text and required links;
- final lawful basis and retention policy for attribution data;
- enabled analytics/marketing vendors and consent categories.

## CRM boundary

The browser posts demo leads to same-origin `/api/demo-requests`. The production
edge proxies only that exact path to a configured HTTPS CRM origin. The public
bundle does not contain CRM credentials or a cross-origin endpoint.

The existing client validation remains usability-only. The CRM must own server
validation, normalization, idempotency/deduplication, abuse protection, rate
limits, persistence, and audit/retention behavior. A 2xx response means accepted;
429 receives specific retry guidance; other failures retain entered values.

Until the CRM team supplies the exact path and response/error contract, the
production route and form submission remain disabled. The site must render a
truthful alternative-contact state rather than a fake success path.

## Production architecture

The existing edge image remains the single static edge artifact. Its build stage
adds `@markiro/landing`, builds the Astro output, and copies it to `/srv/landing`.
The runtime remains unprivileged Caddy.

Introduce `MARKIRO_LANDING_DOMAIN` instead of changing `MARKIRO_DOMAIN`, which
continues to mean the admin authority. The three authorities are distinct:

- `MARKIRO_DOMAIN` -> admin static application and existing API routes;
- `MARKIRO_KIOSK_DOMAIN` -> kiosk static application and kiosk API boundary;
- `MARKIRO_LANDING_DOMAIN` -> landing static files and the future exact CRM
  proxy route only.

Landing route isolation explicitly rejects admin, kiosk, station, documentation,
health, and generic `/api/*` paths. Hash-named assets receive one-year immutable
caching. HTML receives `no-cache`. Static policy files receive bounded caching so
updates propagate promptly.

Caddy obtains the landing certificate after DNS resolves. Repository support
extends Compose, preflight, deployment, smoke, DNS verification, Terraform DNS,
workflow contracts, runbooks, and release contracts to the third authority.
Publishing DNS or invoking deployment requires a separate explicit approval.

## Security headers

The landing reuses the established common headers and keeps a same-origin default
Content Security Policy. The final CRM proxy and chosen analytics providers may
extend `connect-src` only with exact origins after their contracts are approved.
Do not add wildcard script, connection, image, frame, or form sources.

HSTS remains owned by the shared edge policy. The apex is added only when the
server and DNS are ready to obtain and renew its certificate.

## Automated verification

### Landing package

- unit tests for content registry, route uniqueness, related-route integrity,
  metadata and safe JSON-LD serialization;
- rendered-build tests for every route, one H1, canonical, robots meta, Open
  Graph/Twitter fields, visible breadcrumbs, structured-data consistency, and
  no invented public facts;
- generated sitemap, robots and llms policy tests;
- internal-link and image-reference checks;
- typecheck, lint, test and production build;
- responsive browser checks at 390x844, 834x1112 and 1440x1000;
- keyboard, reduced-motion, no-JavaScript and 200% zoom checks;
- Lighthouse mobile and desktop runs targeting SEO 100, accessibility 100,
  best practices >=95 and performance >=90.

Lighthouse lab results do not establish field Core Web Vitals.

### Production bundle

- edge image contract includes `/srv/landing` and excludes landing source/build
  dependencies from the runtime;
- three-domain validation rejects invalid or duplicate authorities;
- Caddy contract proves host isolation, real 404 behavior, cache policy, policy
  file content types, and the exact future CRM route boundary;
- Compose, preflight, deploy, DNS, smoke, workflow, Terraform and runbook tests
  cover `MARKIRO_LANDING_DOMAIN` without weakening admin/kiosk assertions;
- production bundle and production browser contract suites pass.

## Live publication and AI audit

After separately approved DNS/deployment:

1. verify DNS, ACME/TLS, HTTP-to-HTTPS, apex/www canonicalization, headers,
   cache rules, robots, sitemap, llms file, all canonical routes and 404s from an
   external network;
2. validate structured data with Google and Yandex tools;
3. register/verify Google Search Console, Yandex Webmaster and Bing Webmaster;
4. submit the sitemap and use IndexNow for new or materially changed routes;
5. record index coverage and real Core Web Vitals when data exists;
6. run a versioned branded/non-branded query pack in ChatGPT Search, Claude
   Search, Perplexity, Bing/Copilot, and available Google/Yandex AI search modes;
7. record whether Markiro is mentioned/cited, the cited URL, factual accuracy,
   competing sources, and the content gap suggested by the answer;
8. repeat after indexing and at approximately 7 and 30 days.

Day-zero AI results prove only reachability. Absence from an answer before
indexing is not a release failure. Any content response to the audit must remain
truthful and useful; do not generate doorway pages solely to chase prompts.

## Acceptance

- All eight canonical routes render useful static Russian HTML and form one
  internally linked topic cluster.
- Metadata, structured data, sitemap, robots and llms outputs are deterministic,
  truthful and tested.
- Search/retrieval crawlers are allowed while `GPTBot` and `ClaudeBot` are
  explicitly blocked.
- The site and form UI work without cookies; no optional tracker runs before
  consent.
- The production edge can serve `markiro.app` independently without changing
  admin or kiosk behavior, and unknown landing paths return 404.
- CRM submission remains disabled until its exact contract and privacy text are
  accepted; no fake lead success is shipped.
- Package, bundle, browser and Lighthouse gates are reported separately from
  live DNS/TLS, webmaster, indexing, field performance, CRM, consent/legal and
  AI-citation gates.
