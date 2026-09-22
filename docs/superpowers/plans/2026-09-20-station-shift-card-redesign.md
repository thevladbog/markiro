# Station shift card and compact header — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** rebuild the station's shift card per the accepted mock (photo on a product gradient, print name headline, office-size tags, labelled facts) and fold the station header into one 72 px row.

**Architecture:** presentational changes inside `apps/station` only: `ui/ShiftCard.tsx` + `pages/ShiftSelection.tsx` wiring for the card, `ui/StatusBar.tsx` + the two header controls for the rail, `station.css` for both, the screen gallery as the visual fixture, vitest for structure. No API or DB change.

**Tech Stack:** React 19 + TypeScript strict, `@markiro/ui` (`Badge`, `StatusChip`, `Button`), plain CSS in `apps/station/src/station.css`, vitest + Testing Library, the dev-only screen gallery (`?gallery=1&state=…`).

**Spec:** `docs/superpowers/specs/2026-09-20-station-shift-card-redesign.md` — read it first; exact values live there.

## Global Constraints

- Card gradient: `linear-gradient(305deg, hsl(var(--product-hue) 40% 20%), hsl(var(--product-hue) 36% 11%) 55%, hsl(var(--product-hue) 32% 6%))` when `data-accent="true"`, else `linear-gradient(305deg, #2c2b31, #1d1c21 55%, #141317)`.
- Hue source: `useProductAccentHue({ exec, productId, image, gtin, refreshKey })` from `apps/station/src/lib/product-accent.ts`; the card sets `style={{ "--product-hue": hue }}` and `data-accent` on the photo panel exactly as `ScanResultInstrument` does.
- Tags on the card: `Badge size="office" mono` for the number; `StatusChip size="office"` with the existing `SHIFT_CARD_STATUS_TO_PHASE`; mode `Badge size="office"` with tone `validation → "violet"`, `aggregation → "teal"`; pallets `Badge size="office"` tone `neutral`. No inline tag styles.
- Headline = `productName` prop (the page passes `productPrintName ?? productName`); `productFullName` is rendered beneath only when it is non-null and differs from the headline.
- Photo: `object-fit: contain`, no border, no background; no photo → monogram from `productMonogram()` (`apps/station/src/ui/work/ScanResultInstrument.tsx`) on the same gradient.
- Header: single row at every width; `.station-status-bar { grid-template-columns: minmax(0, 1fr) auto auto }`; `.station-status-actions` does not wrap and its children are `min-height: 52px`; icon buttons are 52 × 52. No `@media (max-width: 1599px)` two-row fallback remains.
- Accessible names of the three header controls do not change (`«↻ Обновления»`/`«! …»`, `«Сменить оператора»`, the window-mode label) — App tests find them by name.
- RU and EN strings together; new keys only if a new visible string appears (the card and rail reuse existing labels).
- Commit trailer: `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`; git as `/usr/bin/git`, one plain command per call.

---

### Task 1: Shift card — photo panel on the product gradient, print name, office tags, facts

**Files:**

- Modify: `apps/station/src/ui/ShiftCard.tsx`
- Modify: `apps/station/src/pages/ShiftSelection.tsx` (`ShiftListItem` gains `gtin14?: string | null`; pass `productName={shift.productPrintName ?? shift.productName}`, `productFullName={shift.productPrintName ? shift.productName : null}`, `gtin={shift.gtin14 ?? null}`)
- Modify: `apps/station/src/station.css` (the `.shift-card*` block ~2158–2380 and the `@media (max-width: 1100px)` overrides ~5005–5030)
- Modify: `apps/station/src/dev/StationScreenGallery.tsx` (shift fixtures: add `printName`, `fullName`, `gtin`, and `palletsEnabled` on the active one)
- Test: `apps/station/test/shift-card.test.tsx`, `apps/station/test/shift-selection.test.tsx`, `apps/station/test/screen-gallery.test.tsx` (only if a shift assertion breaks), `apps/station/test/fixed-viewport-source.test.tsx` (the `.shift-card__body` regex only)

**Interfaces:**

- Produces on `ShiftCardProps`: `productFullName?: string | null`, `gtin?: string | null`. Everything else keeps its name.
- DOM hooks (tests and CSS rely on them): `.shift-card__photo` (the gradient panel, carries `data-accent` and `--product-hue`), `.shift-card__photo-monogram`, `.shift-card__heading`, `.shift-card__number`, `.shift-card__status`, `.shift-card__product` (headline), `.shift-card__product-full`, `.shift-card__date-part` (one per date, `Смена: …` / `Производство: …`), `.shift-card__mode` (row), `.shift-card__mode-badge`, `.shift-card__pallets`, `.shift-card__plan`, `.shift-card__counterparty`, `.shift-card__action`.

- [ ] **Step 1: Failing tests** — in `test/shift-card.test.tsx` replace the plan/date/mode assertions with the new anatomy. Reuse the existing fixtures; add:

```tsx
it("leads with the print name, keeps the full name beneath it and tints the photo panel by product hue", () => {
  const { container } = render(
    <ShiftCard
      number="SEP26-008/S"
      productName="Сидр Дикий Крест 0,45"
      productFullName="Сидр полусухой газированный «ДИКИЙ КРЕСТ» 0,45 л"
      gtin="04600682000017"
      plannedDate="2026-09-19"
      plannedDateLabel="Смена"
      productionDate="2026-09-20"
      productionDateLabel="Производство"
      locale="ru"
      mode="aggregation"
      palletsEnabled
      status="active"
      modeLabel="Агрегация"
      palletsLabel="Паллеты"
      statusLabel="Активна"
      plannedLabel="план"
      noPlanLabel="без плана"
      counterpartyName={null}
      counterpartyLabel="для:"
      actionLabel="Присоединиться"
      active
      disabled={false}
      onSelect={vi.fn()}
      productId="product-1"
      image={null}
    />,
  );
  expect(container.querySelector(".shift-card__product")?.textContent).toBe(
    "Сидр Дикий Крест 0,45",
  );
  expect(container.querySelector(".shift-card__product-full")?.textContent).toBe(
    "Сидр полусухой газированный «ДИКИЙ КРЕСТ» 0,45 л",
  );
  const photo = container.querySelector<HTMLElement>(".shift-card__photo");
  expect(photo?.getAttribute("data-accent")).toBe("true");
  expect(photo?.style.getPropertyValue("--product-hue")).not.toBe("");
  // No photo: the monogram stands in on the same gradient, never a light box.
  expect(container.querySelector(".shift-card__photo-monogram")?.textContent).toBe("С");
  expect(container.querySelector(".shift-card__number")?.classList.contains("mk-tag--office")).toBe(
    true,
  );
  expect(container.querySelector(".shift-card__status")?.classList.contains("mk-tag--office")).toBe(
    true,
  );
  expect(container.querySelector(".shift-card__status")?.textContent).toBe("▸Активна");
  expect(
    [...container.querySelectorAll(".shift-card__date-part")].map((n) => n.textContent),
  ).toEqual(["Смена: 19.09.2026", "Производство: 20.09.2026"]);
  expect(container.querySelector(".shift-card__mode-badge")?.textContent).toBe("Агрегация");
  expect(
    container.querySelector(".shift-card__mode-badge")?.classList.contains("mk-tag--teal"),
  ).toBe(true);
  expect(container.querySelector(".shift-card__pallets")?.textContent).toBe("Паллеты");
  expect(container.querySelector(".shift-card__plan")?.textContent).toBe("без плана");
});

it("hides the full name when it equals the headline and paints the neutral gradient without a hue", () => {
  const { container } = render(
    <ShiftCard
      productName="Пиво"
      productFullName="Пиво"
      mode="validation"
      modeLabel="Проверка"
      counterpartyName={null}
      counterpartyLabel="для:"
      actionLabel="Открыть"
      active={false}
      disabled={false}
      onSelect={vi.fn()}
      productId="p"
      image={null}
    />,
  );
  expect(container.querySelector(".shift-card__product-full")).toBeNull();
  expect(container.querySelector(".shift-card__photo")?.getAttribute("data-accent")).toBeNull();
  expect(
    container.querySelector(".shift-card__mode-badge")?.classList.contains("mk-tag--violet"),
  ).toBe(true);
  expect(container.querySelector(".shift-card__pallets")).toBeNull();
});
```

Keep the existing «keeps the full product name and action together beside the product photo» test but point it at the new hooks (the headline is still `.shift-card__product`; the image/placeholder is inside `.shift-card__photo`). Update `test/shift-selection.test.tsx`: the fixture item gets `productPrintName: "Сидр Дикий Крест 0,45"` and `gtin14: "04600682000017"`; assert the headline is the print name, `.shift-card__product-full` is the full name, and `.shift-card__plan` reads `plan 10` (EN locale in tests). Run: `pnpm --filter @markiro/station exec vitest run test/shift-card.test.tsx test/shift-selection.test.tsx` — expected FAIL.

- [ ] **Step 2: Component** — rewrite the JSX of `ShiftCard` to the anatomy in the spec: `Card` → `.shift-card__body` (grid `minmax(150px, 38%) minmax(0, 1fr)`) → `.shift-card__photo` panel (`data-accent`, `--product-hue`, contains `ProductImage` or `<span className="shift-card__photo-monogram">`) + `.shift-card__details` (grid rows `auto minmax(0,1fr) auto auto auto auto 72px`). Compute `hue` with `useProductAccentHue({ exec, productId, image, gtin, refreshKey: imageRefreshKey })`; `productMonogram(productName ?? "")` for the placeholder. Tags per Global Constraints; `MODE_TONE: Record<"validation" | "aggregation", BadgeTone> = { validation: "violet", aggregation: "teal" }` (import `BadgeTone` type from `@markiro/ui`; if it is not exported, export it there — one line). Dates as two `.shift-card__date-part` spans in `.shift-card__dates`; mode row `.shift-card__mode` = mode badge, optional pallets badge, `.shift-card__plan` text.

- [ ] **Step 3: CSS** — in `station.css` replace the `.shift-card*` rules: photo panel gradient (both variants), `border-radius: var(--r-2)`, padding `var(--sp-3)`, `display:grid; place-items:center`; `.shift-card .product-image { background: none; border: 0; object-fit: contain }`; monogram `font: 700 clamp(40px, 5vw, 72px)/1 var(--font-ui); color: rgb(250 250 248 / 70%)`; headline `font: var(--floor-lg)` clamp 3 lines (2 at `max-height: 820px`); `.shift-card__product-full { color: var(--fg-3); font: 400 13px/17px var(--font-ui); -webkit-line-clamp: 2 }`; dates/plan mono `var(--font-mono)` 14/18 `var(--fg-2)`; `.shift-card__mode { display:flex; flex-wrap:wrap; gap: var(--sp-2); align-items:center }`; keep the 1100 px override for the body columns (`minmax(150px, 38%) minmax(0, 1fr)`) and update the regex in `fixed-viewport-source.test.tsx` accordingly. Remove `.shift-card__plan-part`, `.shift-card__heading .mk-tag` ellipsis hacks and the `.shift-card__image-placeholder::before` drawing.

- [ ] **Step 4: Page + gallery** — `ShiftSelection.tsx` wiring per Files; `StationScreenGallery.tsx` shift fixtures: `{ number, printName, fullName, gtin, active, mode, palletsEnabled?, plannedQty }` and pass `productName={printName}`, `productFullName={fullName}`, `gtin`, `palletsEnabled`, labels (`ru ? "Паллеты" : "Pallets"`; the page uses `t("shifts.withPallets")` — change that key's value to `Паллеты`/`Pallets` since it is now a badge caption, and update any test that asserted the lowercase word).

- [ ] **Step 5: Run** — `pnpm --filter @markiro/station exec vitest run test/shift-card.test.tsx test/shift-selection.test.tsx test/screen-gallery.test.tsx test/fixed-viewport-source.test.tsx test/i18n.test.tsx`, then `typecheck`, `lint`. Visual check: `pnpm --filter @markiro/station dev --port 5273` and open `http://localhost:5273/?gallery=1&state=shift-page-1` at 1024×768 and 1280×800 (screenshot both into the report); stop the server afterwards.

- [ ] **Step 6: Commit** — `feat(station): shift card — photo on the product gradient, print name first, office tags`.

---

### Task 2: Compact header — one 72 px row with 52 px controls

**Files:**

- Modify: `apps/station/src/ui/StatusBar.tsx` (update button → icon button with `aria-label` = `${glyph} ${label}` as today, visible content = glyph only, plus `<span className="station-update-indicator__dot" />` when `update.available`; action rail gets `station-status-actions--compact`? No — the rail itself becomes compact, no modifier)
- Modify: `apps/station/src/ui/WindowModeControl.tsx` (new prop `compact?: boolean`: icon-only button, `aria-label` unchanged, visible text omitted) and `apps/station/src/ui/OperatorSwitchControl.tsx` (new prop `compact?: boolean`: 52 px height via class `station-rail-button`, text kept)
- Modify: `apps/station/src/App.tsx` (pass `compact` to both controls where they are created for the shell) and `apps/station/src/dev/StationScreenGallery.tsx` (`floor-header-actions` fixture passes `compact`)
- Modify: `apps/station/src/station.css` (status bar grid, `.station-status-actions`, `.station-update-indicator`, identity fonts 16/13, remove the `@media (max-width: 1599px)` two-row block, add `.station-rail-button { min-height: 52px; height: 52px; padding-inline: var(--sp-3) }` and `.station-rail-button--icon { width: 52px; padding: 0 }`)
- Test: `apps/station/test/status-bar.test.tsx`, `apps/station/test/screen-gallery.test.tsx` (`floor-header-actions`: drop `operator.style.height === "var(--control-floor)"`, assert `classList.contains("station-rail-button")` instead), `apps/station/test/window-mode-control.test.tsx` («touch-sized» → 52 px rail size when `compact`), `apps/station/test/fixed-viewport-source.test.tsx` (header assertions rewritten per spec), `apps/station/test/App.test.tsx` only if a name changed (it must not)

**Interfaces:** `WindowModeControlProps.compact?: boolean`, `OperatorSwitchControlProps.compact?: boolean`. `Button` from `@markiro/ui` keeps `size="floor"` but the rail class overrides the height to 52 px — `Button` sets `style.height` inline (`var(--control-floor)`), so the rail sets `--control-floor: 52px` on `.station-status-actions` instead of fighting the inline style: `.station-status-actions { --control-floor: 52px; }`.

- [ ] **Step 1: Failing tests** — `status-bar.test.tsx` «owns update, operator, and window controls inside one labelled action rail»: additionally assert the update button's visible text is the glyph only (`textContent === "!"`/`"↻"`) while its accessible name is unchanged, and that the rail has no wrapping class. `fixed-viewport-source.test.tsx`: replace the 64 px / two-row expectations with: `.station-status-actions { --control-floor: 52px; … flex-wrap: nowrap; }`, `.station-status-actions > * { min-width: 0; min-height: 52px }`, no `@media (max-width: 1599px)` block that touches `.station-status-bar`, `.station-rail-button--icon { width: 52px }`. `window-mode-control.test.tsx` «touch-sized»: render with `compact` and assert the button's accessible name is still the full label and its visible text is empty. Run the three files — expected FAIL.

- [ ] **Step 2: Implement** — per Files. In `StatusBar`, the update `Button` renders `icon` = glyph and no children when compact… the whole rail is compact now, so: `children` omitted, `className="station-update-indicator station-rail-button station-rail-button--icon"`, `aria-label` as today, `data-update-severity` as today, plus the availability dot. Operator control: class `station-rail-button`. Window control: `station-rail-button station-rail-button--icon`, icon = existing glyph span, no children. Identity fonts: primary `700 16px/20px`, secondary `400 13px/18px`. Delete the 1599 px block; keep the 1679 px caption rule and the 1100 px shrink rules.

- [ ] **Step 3: Run** — `pnpm --filter @markiro/station exec vitest run test/status-bar.test.tsx test/window-mode-control.test.tsx test/operator-switch-control.test.tsx test/screen-gallery.test.tsx test/fixed-viewport-source.test.tsx test/App.test.tsx`, `typecheck`, `lint`. Visual: gallery states `floor-header-actions` and `shift-page-1` at 1024×768 (screenshot into the report); the rail must fit one row with all five pills.

- [ ] **Step 4: Commit** — `feat(station): compact one-row header with 52 px rail controls`.

---

### Task 3: Gates, docs, spec check

- [ ] Full station package: `pnpm --filter @markiro/station test`, `typecheck`, `lint`, `build`; `pnpm format:check`; `/usr/bin/git diff --check`.
- [ ] `apps/station/README.md`: find the shift-selection / header paragraphs (grep «Смены», «шапк», «status bar») and update the description (print name headline, product-tinted photo panel, office tags on the card, single-row header). Commit `docs(station): shift card and header after the redesign`.
- [ ] Compare the result with the spec; note deviations in the PR body.
