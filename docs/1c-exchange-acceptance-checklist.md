# 1C Exchange Acceptance Checklist (plan И-1)

Executed once, against a real 1С:Предприятие instance with "Обмен с сайтом"
(CommerceML) configured, when a tenant's exchange channel goes live. This
list holds only what synthetic fixtures genuinely cannot answer — a live
session with a real 1С is one-shot and expensive; it must not be spent
re-confirming what `apps/api/test/exchange-*.e2e.test.ts`,
`commerceml-parse.test.ts` and `commerceml-apply.test.ts` already prove
against synthetic (but shape-accurate) fixtures. Record the outcome beside
each item.

## Transport & price intake (plan И-1)

- [ ] Configure "Обмен с сайтом" in a real 1С:Предприятие instance against the
      issued `/1c_exchange` address and the login/secret from
      `POST /integrations/commerceml/credentials`; run a full exchange;
      confirm the catalog's prices actually land on `products.unit_price`.
      Nothing short of a real client driving the real `checkauth`/`init`/
      `file`/`import` handshake can prove this end to end.
- [ ] Confirm a catalog carrying more than one price type (`<ТипЦен>`)
      genuinely requires picking one in the channel's settings (`priceType`)
      before prices apply — that the channel refuses to guess when more than
      one type is present in a REAL export from a real 1С configuration, not
      just the hand-written fixtures `commerceml-apply.test.ts` and
      `exchange-import.e2e.test.ts` already exercise this against.

## Already covered — do not re-spend the live session on these

Kept here, not deleted, so the next person doesn't wonder whether they were
simply forgotten or genuinely unverified:

- ~~Windows-1251 decoding~~ — covered by `commerceml-parse.test.ts` against a
  real cp1251-encoded fixture
  (`apps/api/test/fixtures/commerceml/import-cp1251.xml`, not a UTF-8
  stand-in): `parse.ts`'s `decode()` uses the platform `TextDecoder`, not
  `iconv` (no such dependency exists in this workspace), and the test asserts
  the decoded Cyrillic name round-trips correctly.
- ~~A price type arriving by `<ИдТипЦены>` reference into the document-level
  `<ТипыЦен>` catalog, rather than inline via `<Представление>` on each
  `<Цена>`~~ — covered by the same file against `offers-price-ref.xml`, both
  the resolved case and the unresolved-reference case (`type: ""`, `typeRef`
  set, distinguishable from "no type at all"). There is no function named
  `resolvePriceType` in this codebase — the resolution happens inline in
  `offersFrom` (parse.ts).

## Input for plan И-2 (order status)

- [ ] Record the exact requisite (реквизит) name the client's 1С
      configuration uses for order status on an outgoing document, and its
      full dictionary of values — plan И-2's two-way status mapping needs
      this before it can be designed; §9 of
      `docs/superpowers/specs/2026-07-29-commerceml-design.md` names it as
      an open input, not yet an assumption baked into any code.
