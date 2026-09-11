# Offers browser proof

This isolated suite runs the built SaaS application with synthetic platform responses.
It does not contact production, a database, mail or object storage. Unexpected API
requests and external origins fail the fixture.

From the repository root, with Node 24+ and the declared pnpm version:

```bash
pnpm install --frozen-lockfile
pnpm --dir tools/production-browser --ignore-workspace install --frozen-lockfile
pnpm --dir tools/production-browser --ignore-workspace exec playwright install chromium
pnpm turbo run build --filter='@markiro/saas-admin' --filter='@markiro/api'
pnpm --dir tools/production-browser --ignore-workspace test:offers
pnpm --dir tools/production-browser --ignore-workspace test:reports
pnpm --dir tools/production-browser --ignore-workspace typecheck
```

The API build is required: a separate Node process imports its compiled HTML renderer
and included-VAT calculation. This avoids Playwright's transform hook crossing the
compiled API CommonJS/domain ESM boundary. Signature and seal images remain private
server assets; they are included only in synthetic rendered document responses.
No API process, database or credentials are needed.

`offers.playwright.config.ts` starts Vite preview on `127.0.0.1:43185` and refuses to
reuse another server. Every navigation receives the current `application_csp` policy
read from `deploy/production/Caddyfile`; the preview keeps an empty iframe sandbox.
The signed HTML response gate waits until Chromium's real transient user activation
expires before releasing the URL. The suite checks the navigated response bytes and
the absence of additional tabs. Do not replace this gate with fake timers or a popup.

The matrix covers 390/1440 widths, Russian/English and light/dark themes. It captures
registry, detail, A4 preview, issued detail and signed HTML images. A separate desktop
gallery includes mixed statuses and missing buyer details. Screenshots use synthetic
data and are review evidence, not pixel baselines or proof of production delivery.
A4 preview preserves print geometry and scrolls inside its sandbox on narrow screens.
The standalone signed document retains its A4 width as a print artifact.

Artifacts are under `tools/production-browser/test-results/offers/`. Failed runs keep
their screenshot and trace; the CI production-bundle job uploads offers artifacts
separately from report artifacts for fourteen days. Inspect trace files with:

```bash
pnpm --dir tools/production-browser --ignore-workspace exec playwright show-trace path/to/trace.zip
```

Browser mocks verify UI requests and rendering. They do not prove transaction
isolation, notification delivery, durable storage, printer output, or PDF recovery
on a live server. Those require their separate server and external acceptance gates.
