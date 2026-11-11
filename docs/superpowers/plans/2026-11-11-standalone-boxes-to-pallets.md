# Station Boxes to Pallets Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development to implement and review each task. Steps use checkbox syntax.

**Goal:** Assemble warehouse pallets from closed boxes on a paired Autonom station, with offline label printing and eventual reconciliation.

**Architecture:** The station uses the host's existing warehouse-pallet events and box registry, with a durable local composition and a separate warehouse event stream. The screen owns scans while active and uses the existing floor shell, printer runtime and authorization context.

**Tech stack:** TypeScript, React, Zod, SQLite, Rust, Axum, Vitest and Cargo.

**Spec:** [Station boxes to pallets](../specs/2026-11-11-standalone-boxes-to-pallets-design.md).

## Global constraints

- Box closure is independent of shift closure. Pallets accept eligible boxes of one product across shifts.
- Only paired floor devices may access the warehouse device routes. Require a known signed-in operator before new local work. Preserve existing TSD behavior.
- Offline writes, SSCC allocation and their outbox records are atomic. Keep event payloads stable across retries. Hardware calls follow committed state.
- One scan owner, one initial print per pallet, and separate print, physical confirmation and host acknowledgement states.
- A rejected close blocks delivery of later pallets. A retry with corrected data takes a new record ID after physical reconciliation.

## Tasks

1. Host and wire contract. Add a station test using two closed boxes of one product with one shift still active, and assert that the office's pallet and original shift membership are correct. Assert office-device denial and compatibility with the existing TSD fixtures. Run `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test device_kind_routes` and the pallet/registry scenarios. Allow `Station` alongside `Handheld`, include source shift where available and preserve identity and receipt semantics.
2. Durable station model. Add failing local-SQL tests for the same-product rule, SSCC uniqueness, restart, send ordering and rejected predecessor. Add a local business migration, classify its tables for dataset replacement, and implement `createPalletAssemblyStore(context)` in `floor/pallet-assembly/store.ts`. The store reads the local mirror, records ordered pallet events, freezes the closed composition and persists print state. Verify with focused Vitest and local Rust migration tests.
3. Floor presentation and printing. Add failing interaction tests for the two-step hub entry, scanner ownership and deferred/uncertain printing. Implement `PalletAssemblyScreen` in `floor/pallet-assembly/PalletAssemblyScreen.tsx`. Use the existing station controls, workstation printer assignment, label renderer and print runtime. Show composition, source, receipt and print status, and recovery actions. Verify desktop layout at 1024×768.
4. Integration. Wire `HostApi` and the app link to refresh the registry and send pallet events, including after the mode is closed. Keep initial sync, pairing and restore fences and request the station's pallet SSCC block before it runs out. Wire navigation, Russian/English copy and office reconciliation. Run the package suites, `git diff --check`, and proportionate browser/Cargo checks, then inspect the complete PR diff against freshly fetched `origin/main`.

## Review focus

- A freshly closed box from an active shift becomes eligible after its closure fact is admitted.
- An offline retry, double scan or concurrent close cannot double-count a box or spend a second serial.
- A late rejection persists after restart and prevents later events from being submitted out of order.
- A lost printer response survives restart as an uncertain print and never triggers automatic retransmission.
- A device re-pair or dataset replacement cannot read or replay another owner's cached records.
