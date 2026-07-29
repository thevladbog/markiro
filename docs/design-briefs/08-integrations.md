# Design Brief 08 — Integrations

> Addition to the 00–07 series and the accepted Markiro handoff. This brief
> covers the cabinet's **Integrations** section: the one place where a tenant
> sees and configures everything that talks to a system outside Markiro — the
> customer's 1C, the government's GIS MT, the public API, and later the direct
> Chestny ZNAK connection.
>
> This is a **delta** to brief 03 (admin panel): it adds a top-level section
> and moves API keys out of Settings. Draw the NEW screens/states below; do not
> redesign unrelated areas. RU primary + EN, light + dark, office mode,
> existing design system.
>
> The section is deliberately designed **before** its first tenant is built, so
> the integrations that follow plug in rather than each arriving with its own
> screen. The rules under "How this grows" are the point of the brief.

## Purpose

Today a tenant's outside connections have no home. API keys are described in
brief 03 under Settings; file exports live in roadmap plan 07; the CommerceML
exchange and the direct Chestny ZNAK connection have nowhere at all. Four
things that answer the same operator question — _"is our data getting out, and
if not, why"_ — would otherwise end up in four unrelated places.

This section answers that question in one view, and gives every future
integration a shape to arrive in.

## The core idea: a channel

Everything in this section is a **channel** — one route along which data leaves
or enters Markiro. A channel is not necessarily a live connection: a file
export is a channel whose transport happens to be "a human downloads a file",
and it has the same anatomy as an exchange that runs by itself.

Resisting the obvious split ("connections" vs "exports") is deliberate. Those
two categories look different but are read the same way, and splitting them
tears a single integration in half: an exchange's settings would sit in one
place and its history in another, which is exactly the pair an operator needs
side by side when something breaks.

Every channel has four parts and nothing else:

**Identity** — what it is and what it talks to.

**State** — one of: _not configured_, _working_, _error_, _silent_,
_unavailable_. Plus "last event N ago", because the first question about a
broken integration is always when it last drew breath.

**Settings** — different for every channel. A channel may also expose its own
**actions** (test the connection, export now, revoke a key).

**Journal** — the same shape for every channel: time, session, direction,
outcome, one human-readable line, and details for a specialist.

### On the "silent" state

An integration usually fails by **going quiet**, not by erroring. If the
customer's 1C stops calling, nothing errors — there is simply no request. So
silence is a first-class state, not an absence of one, and the threshold is a
per-channel setting: one tenant exchanges hourly, another daily, and a single
shared constant would lie to both.

## Screens

### 1. Section — list of channels

A card per channel: name, what it connects to, state chip, "last event N ago",
and its primary action. Cards are drawn identically regardless of kind — that
uniformity is what lets the section grow.

An _unavailable_ channel (a connection we have not built yet) is drawn like the
rest, with its state chip reading unavailable and no actions. It is a real
entry, not a teaser: when its adapter ships, nothing in the layout changes.

States to draw: empty (nothing configured yet), all-healthy, one-in-error,
one-silent.

### 2. Channel page

One page per channel, three regions:

- **Header** — identity, state, last event, actions.
- **Settings** — the channel's own form. For an exchange this includes its
  credentials; a secret is shown once on creation and never again, matching the
  device-pairing pattern in brief 07.
- **Journal** — reverse-chronological sessions. A session expands into its
  events. The most recent failed session is surfaced at the top of the journal
  rather than buried in order.

**Who the error text is for.** The person debugging a broken exchange is
usually the customer's own 1C specialist, not our administrator. So a failed
session shows what we actually answered into the protocol, verbatim — not a
friendly paraphrase. Draw it as a monospace detail block, collapsed by default.

### 3. Unmatched items queue

A channel that imports data owns a queue of things it could not match to the
Markiro catalogue. Each entry shows what the external system sent, and offers
three actions: **link to an existing product**, **create a card from it**, or
**hide**.

Two things this screen must survive:

- **The first exchange puts the entire catalogue in this queue** — existing
  Markiro products carry no external id yet. So the queue needs suggested
  matches by name and article, bulk confirmation of suggestions, and a
  workable empty-ish state after they are accepted. A queue that only offers
  "create" would have the operator duplicate their whole catalogue on day one.
- **Hiding is not unlinking.** A hidden entry stays hidden across exchanges
  (otherwise the same noise returns forever) but remains visible under a filter
  and can be restored.

A **linked product shows its link on its own card** in the Catalogue section,
with the external name and an **unlink** action. A link that cannot be broken
turns one wrong match into a permanent one. Unlinking leaves the product's
current values alone; the external item simply returns to the queue at the next
exchange, which is the path back to a correct match.

The Catalogue section shows an unobtrusive plaque when the queue is non-empty
("new items arrived in the exchange") linking here. The queue itself lives with
the channel, next to the journal that explains where the items came from.

### 4. Public API as a channel

API keys are a channel with no schedule: its settings are the list of keys and
their scopes, its journal is issuance and revocation. This is where brief 03's
"API keys for external integrations" is built — Settings keeps organisation
profile, lines, language and theme.

## Cross-cutting notes

- **One journal for all channels.** A single shared shape, not a history table
  per integration. Otherwise the third integration brings a third kind of
  history and the section stops being one thing.
- **The channel registry lives in code, the configuration in data.** Adding an
  integration means adding a descriptor, a settings schema and an adapter — not
  a screen, not a journal, not a migration per integration.
- **No branch finishes silently.** Every path either succeeds or writes a
  journal event. This is the same rule the pickup kiosk arrived at the hard
  way: silence reads as working.
- **Retention differs by grain.** Session-level history is kept long enough to
  settle an accounting dispute; per-item detail inside a session grows far
  faster and is bounded separately. One shared retention either wastes space or
  discards the wrong thing.
- Standard list requirements from brief 03 apply: empty, loading, error and
  stale variants for every list.

## How this grows

Channels planned, in the order they are expected:

| Channel                  | Kind                            | Status                                          |
| ------------------------ | ------------------------------- | ----------------------------------------------- |
| CommerceML (1C exchange) | Runs by itself, both directions | First to be built                               |
| Public API               | Keys, no schedule               | Built alongside                                 |
| Chestny ZNAK (direct)    | Runs by itself                  | Placeholder, _unavailable_                      |
| GIS MT / 1C file exports | Human-triggered, has history    | Adapters in roadmap plan 07; their home is here |
| Fiscal register (KKT)    | Undecided                       | Not designed                                    |

A new channel must be expressible as _identity, state, settings, journal_
without changing this brief. If one cannot be, that is a signal the anatomy is
wrong — fix the anatomy, do not add a second kind of screen.

## Out of scope for this brief

Per-counterparty exchange connections, more than one 1C connection per tenant,
and the platform-admin view of tenant integrations (brief 06). Direct Chestny
ZNAK screens are named here only so the section reserves a shape for them.
