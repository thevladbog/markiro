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
      `exchange-import.e2e.test.ts` already exercise this against: a
      synthetic multi-price-type fixture can only prove the code's own logic
      is internally consistent, never that a real 1С configuration's actual
      export shapes ambiguity the same way.

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

## Order export & status reconciliation (plan И-2)

- [ ] Configure the requisite name this client's 1С configuration uses for
      order status (`СтатусЗаказа`-shaped or otherwise) as `orderStatusField`
      on the CommerceML channel's settings, and its full dictionary of values
      as `statusMapping` — this cannot be guessed from any synthetic fixture;
      it must come from the client's own 1С specialist or a live document
      dump.
- [ ] Run a full `checkauth → init → query → success` cycle against a real
      1С instance with a genuine pending pickup order queued; confirm 1С's
      importer accepts the outbound `<Документ>` shape this exchange builds
      (`order-export.ts`) — a synthetic assertion can only prove the XML is
      well-formed and internally consistent, never that a real 1С
      configuration's importer parses these exact tag names/shape the way
      this exchange assumes.
- [ ] Confirm a real 1С configuration's own outgoing "changed order" export
      (`type=sale&mode=file`) actually carries the order status inside
      `<ЗначенияРеквизитов>`/`<ЗначениеРеквизита>`, in the shape
      `order-status.ts` expects, rather than some other document structure
      this exchange has not been built against.
- [ ] Confirm `splitWriteoffDocument` + `writeoffDocumentType` actually route
      to a distinct document type this client's own 1С configuration
      recognizes, if the client wants writeoffs split — this is a
      per-configuration dictionary (спека §2), so there is no default this
      exchange can assume is right.

## Already covered — do not re-spend the live session on these

- ~~That an order held back because of an unlinked product does not silently
  vanish~~ — covered by `commerceml-order-export.test.ts`'s `planExport`
  tests and `pickup-orders.e2e.test.ts`'s `findExportCandidates` test: the
  order simply doesn't appear in `plan.eligible` until every item's product
  carries an `external_ref`.
- ~~That `mode=success` only confirms what THIS session's own `mode=query`
  actually offered~~ — covered by `exchange-protocol.e2e.test.ts`'s outbound
  cycle test, which asserts the SAME order is not re-offered on a second
  `mode=query` round after `mode=success`.
- ~~That an unmapped external status never silently moves an order~~ —
  covered by `exchange-protocol.e2e.test.ts`'s inbound reconciliation test
  (unmapped-value case) and `commerceml-order-status.test.ts`'s
  `resolveMappedStatus` tests.
