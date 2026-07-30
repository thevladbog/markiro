# 1C Exchange Acceptance Checklist (plan И-1)

Executed once, against a real 1С:Предприятие instance with "Обмен с сайтом"
(CommerceML) configured, when a tenant's exchange channel goes live. Every
item here was deliberately deferred because CI cannot prove it — this repo's
tests run the protocol and the parser against synthetic fixtures
(`apps/api/test/exchange-*.e2e.test.ts`, `commerceml-parse.test.ts`), not a
real 1C client. Record the outcome beside each item.

## Transport & price intake (plan И-1)

- [ ] Configure "Обмен с сайтом" in a real 1С:Предприятие instance against the
      issued `/1c_exchange` address and the login/secret from
      `POST /integrations/commerceml/credentials`; run a full exchange;
      confirm the catalog's prices actually land on `products.unit_price`.
- [ ] Confirm a catalog exported with the client's typical windows-1251
      encoding setting parses correctly — the fixtures this repo's parser
      tests run against are UTF-8; a real client's default charset and its
      effect on `iconv`-decoded Cyrillic is unverified.
- [ ] Confirm a catalog carrying more than one price type (`<ТипЦен>`)
      genuinely requires picking one in the channel's settings (`priceType`)
      before prices apply — that the channel refuses to guess when more than
      one type is present in a real export, rather than silently picking one.
- [ ] Confirm whether the price type on a real `offers.xml` arrives as a
      reference into a separate `<ТипыЦен>` catalog document, rather than
      inline via `<Представление>` on each `<Цена>` — the only shape this
      repo's fixtures exercise (`resolvePriceType` in the parser). If it
      arrives by reference, confirm that resolution path actually works
      against the real document.

## Input for plan И-2 (order status)

- [ ] Record the exact requisite (реквизит) name the client's 1С
      configuration uses for order status on an outgoing document, and its
      full dictionary of values — plan И-2's two-way status mapping needs
      this before it can be designed; §9 of
      `docs/superpowers/specs/2026-07-29-commerceml-design.md` names it as
      an open input, not yet an assumption baked into any code.
