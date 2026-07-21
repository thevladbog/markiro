# Design Brief 00 — Project Overview

> Read this first. Briefs 01–05 build on the context here and are meant to be
> executed in order: brand → design system → admin panel → line station → landing.

## What we are building

A cloud (SaaS) platform for mandatory product marking under **Chestny ZNAK**
(«Честный знак») — the Russian national track-and-trace system. The product
covers the shop-floor loop of marking:

1. Marking codes (DataMatrix) are printed on products elsewhere; our system
   learns about a code the moment an operator **scans** it on the line.
2. The system **validates** every scan (code structure, GTIN matches the
   product being produced, duplicate detection) with instant feedback.
3. Optionally the line runs **aggregation**: units are packed into boxes,
   boxes onto pallets. When a box/pallet is complete, the station prints a
   group label (SSCC) on a connected label printer.
4. The back office **exports files** for external systems (1C, GIS MT) and
   exposes a public API for integrations. Direct Chestny ZNAK API integration
   comes later.

**Working name:** Bottle [CODE] — will be replaced, see brief 01 (naming is
part of the job).

## Who it is for

**Buyer:** owners/directors of small production plants (1–2 lines, no IT
department): craft breweries, water bottlers, small beverage plants. The
platform is universal across Chestny ZNAK product groups; beer and packaged
water are the launch focus.

**Users:**

| Persona | Where | Context |
|---|---|---|
| Admin | Web admin panel | Owner or manager; sets up catalog, users, shifts, downloads export files. Email + password sign-in. |
| Manager | Web admin panel | Same surface as admin, reduced permissions. |
| Operator | Line station app | Works at the line on a **touchscreen** terminal (tablet 10–12″ or desktop), often in gloves, in noise, glancing at the screen from 1–2 m away. Signs in with login + numeric PIN or by scanning a badge barcode. |

## The two products being designed

1. **Admin panel** — web app, classic SaaS density. Catalog, shifts
   (production tasks), users, history/audit, label template editor, exports,
   settings.
2. **Line station** — touch-first app running at the production line,
   connected to a USB/COM barcode scanner and a label printer through a local
   **hardware agent**. Works **fully offline for a whole shift**, syncing when
   connectivity returns.

One design language, **two modes**:

- **Office mode** (admin panel, landing): modern SaaS minimalism — clean,
  airy, precise typography (reference: Linear, Stripe, Vercel).
- **Floor mode** (line station): industrial clarity — oversized touch
  targets, high contrast, states readable in peripheral vision and from
  distance. Function over decoration, but still unmistakably the same brand.

## Hard requirements (apply to everything)

- **Themes:** light **and** dark from day one. Dark is the expected default
  on the shop floor (less glare).
- **Languages:** Russian (primary) and English. All layouts must survive
  RU string lengths; key screens should be checked in both.
- **Semantic status colors** shared across both apps: green = OK,
  red = error, yellow/amber = duplicate / needs attention, blue = syncing.
  These must work in both themes and be distinguishable color-blind-safe
  (pair color with icon/shape/text, never color alone).
- **Every screen needs states:** empty, loading, error, offline. The line
  station additionally has signal states (see brief 04).
- **Multi-terminal shifts:** 2–3 stations can work in the same shift
  simultaneously; both apps surface "who is in the shift" and per-terminal
  vs. total counters.

## Deliverables and order

| # | Brief | Deliverable |
|---|---|---|
| 01 | Brand & naming | Name candidates, logo, palette, typography, mini guideline, tone of voice |
| 02 | Design system | Figma library: tokens (light/dark), office + floor modes, components, states |
| 03 | Admin panel UI | Mockups for all admin screens, RU + EN for key screens |
| 04 | Line station UI | Mockups for all station screens incl. signal states |
| 05 | Landing page | Marketing page design |

Later phases (not in this engagement, keep in mind): direct Chestny ZNAK
integration screens, billing/tariffs UI, on-premise edition.

## Glossary

- **Chestny ZNAK (ЧЗ)** — Russian national mandatory marking / track-and-trace
  system.
- **GIS MT** — the government IT system behind Chestny ZNAK where reports are
  submitted.
- **KM / marking code** — the unique GS1 DataMatrix code applied to each unit.
- **GTIN** — global trade item number, identifies the product (also encoded in
  EAN-13).
- **SSCC** — serial shipping container code: identity of a box/pallet, printed
  on the group label.
- **Aggregation** — recording which units are in which box, which boxes on
  which pallet (3 levels: unit → box → pallet), incl. re-packing and
  disassembly.
- **Shift (production task)** — a planned unit of work: product, planned
  quantity, line, date, mode (validation only / validation + aggregation),
  label template. Created in the admin panel **or ad-hoc at the line station**.
- **Hardware agent** — a small local service on the station machine that talks
  to printers (ZPL/TSPL) and USB/COM scanners; the app communicates with it
  over localhost HTTP.
