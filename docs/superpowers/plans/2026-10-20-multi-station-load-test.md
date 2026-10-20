# Multi-station shift: load and soak harness and milestone acceptance (milestone 2b, part 5 of 5)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the load and soak harness that decides spec §8's acceptance of «several stations in one shift on one line»: four stations and two handhelds scanning into one shift of a real host for minutes (CI smoke) or hours (soak), with every figure the spec names measured (p99 of the fact routes, WAL checkpoint behaviour, a backup under load, a restore, the write path) and every total reconciled against what the host acknowledged.

**Architecture:** A new workspace crate `apps/standalone/loadtest` (`markiro-loadtest`: a library and one binary) starts the real `markiro-host` binary as a child process on a throwaway data folder, makes the site through the host's own routes (wizard, one product, templates, small SSCC blocks, the line's limit, paired stations and handhelds, one shared shift), and runs one simulated device per station or handheld: a pure state machine (`engine.rs`: outbox, open box and pallet, SSCC blocks by the half rule) wrapped in four network tasks (scanner, syncer, link, stream). A ledger of the receipts is the oracle: at the end the host's totals (API) and its database (read-only, from outside) must equal it exactly. The run ends with the devices closing their parts in a chosen order, five drills on fresh shifts (three close orders, a forced close, a missing reason), a last backup, the host's stop and a restore of that backup into a folder of its own. A JSON report and a Markdown summary go to a folder outside the repository; a second command compares two reports.

**Tech Stack:** Rust 2021 (tokio, reqwest with a pinned-fingerprint rustls verifier as the devices have, sqlx read-only on the host's SQLite, serde, sha2), the host library (`markiro-host`) and the wire types (`markiro-proto`); GitHub Actions (`workflow_dispatch`) and `node --test` for the CI contract.

**Spec:** `docs/superpowers/specs/2026-10-20-standalone-multi-station-shift-design.md` (§8 SQLite decision and acceptance, §9 step 2, §11 risks). **Host contract:** the end of `docs/superpowers/plans/2026-10-20-multi-station-host.md` (its «Host-side hooks the load/soak plan needs» and «Host contract for the other plans»). This is part 5 of 5: the host plan is part 1 and **must be merged first** for every task that runs more than one device (Tasks 7 and 9 onward use `maxStations`, `participants`, `totals`, `byDevice`, `closeReasonMissing`, `PUT /v1/office/shifts/{id}/close-reason`, the `partClosed` and `reasonMissing` receipts and the capability `multi-station-v1`, all named by that contract). Tasks 1-6, 8 and 10-12's unit tests need nothing from it.

**Verification at planning time (so the executor knows what is proven and what is not).** Every module below was compiled, formatted with `rustfmt` and its 63 tests run in a scratch copy of the workspace at `3dc8df952` (the host at protocol 6, before plan 2b) with this crate added. A whole run (in-process and as a child process) was exercised against that host with one station: every check that does not need plan 2b held (the database reconciliation, conflicts, SSCC uniqueness, backup under load, restore row counts, descriptors and WAL backlog of a real child process, the log scan, a stop on SIGINT); every failure was one of the plan-2b fields or routes named above. With a scratch patch that merely let a second and third device enter, a six-device run (four stations, two handhelds, links dropping and returning, races, duplicates, resends) reconciled exactly (`code_conflicts` late and displaced rows, code owners, live items, per-device scans, receipts, boxes and pallets). What was NOT run: the plan-2b-dependent checks, a soak, Windows, a CI runner.

**Commands.** `$WT` is the absolute path of the executor's worktree (`/tmp/claude/wt/<NAME>`, `docs/standalone/ledger/exec-rules.md`). Never `cd`. Cargo runs as `cargo --offline --locked … --manifest-path "$WT/apps/standalone/Cargo.toml"`; pnpm as `pnpm --dir "$WT" --config.verifyDepsBeforeRun=false …`. Tests that bind a loopback socket (Tasks 6, 7, 13) need the sandbox disabled in an agent environment that blocks `listen`. A test run's output is shortened by some wrappers: run the ignored self-test's binary with `--nocapture` when its prints matter.

## Global Constraints

From the spec (§8, §9, §11), the host plan and the owner's decisions:

- SQLite stays: «Хост — единственный писатель мастер-базы; станции и ТСД ходят по HTTP и держат локальные зеркала.» `host/src/db.rs`: WAL, `synchronous=FULL`, `busy_timeout` 5 s, pool of 4, hot writes in `BEGIN IMMEDIATE`.
- Acceptance of the milestone (§8, verbatim): «нагрузочный и длительный тест (симулятор 4 станций и 2 ТСД по 5–10 сканов/с, часы), p99 задержки маршрутов фактов, поведение WAL-контрольных точек, резервная копия под нагрузкой, восстановление; ревью записи (короткие транзакции, одно писательское соединение для горячих путей, нет долгих читающих транзакций).»
- Revisit when (§8): more than ~20 simultaneous devices on a host, more than ~50 million rows in `scans`, or a need for a warm standby (then continuous copying and a standby host first, not a change of engine).
- Risks to cover (§11): a duplicate scan on two stations (the registry decides, the earliest scan wins; a test with two stations); the shift-wide total is the host's, from the registry; a hanging participant blocks the automatic close (the office force-closes); late data after a forced close stays late and never reopens the shift.
- Profiles fixed by the task: smoke = 4 stations + 2 handhelds × 5 scans/s for 3 minutes; soak = the same × 10 scans/s for 4 hours.
- Host contract used (plan 2b): `POST /v1/device/shifts/{id}/enter` with `{ "supports": ["multi-station-v1"] }` (handhelds add `handheld-host-v1`), `POST /v1/device/facts` (1-100 records, idempotent by `(device_id, record_id)` and digest), `GET /v1/device/shifts` (the totals poll), `POST /v1/office/shifts/{id}/close`, `GET /v1/office/shifts/{id}`, `PUT /v1/office/lines/{id}` with `maxStations`, `PUT /v1/office/shifts/{id}/close-reason`; the line's limit is `lines.max_stations` 1-16 and a slot is an active participant.
- Release order is host first; this plan changes no product code (only a new crate, a workflow, a CI contract and docs).

From `apps/standalone/AGENTS.md` and the root `AGENTS.md`:

- Single site, no tenants. A device key, an office session, a password or a pairing code is never printed, logged or put on a command line: the harness reads attach credentials from the environment, writes none of them into a report, and generates a throwaway administrator password per run.
- DDL lives only in `host/migrations` and is not touched here. The harness reads the database read-only and never writes to it.
- Wire changes break the build, not a night of soak: payloads are built from `markiro-proto` types.
- Tests assert exact numbers, not "at least one"; a threshold is never loosened to turn a run green (a number moves only with a recorded baseline, see D9).
- Rust gates: `cargo fmt --all -- --check`, `cargo test -p markiro-loadtest`, the whole workspace before completion. Host-only Cargo runs prove nothing about Windows: say so in the report.
- Report automated checks separately from what was not exercised (Windows, a real LAN, real handhelds, a soak).
- Commits are scoped, stage explicit paths, and end with exactly one trailer line `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.

---

## Decisions taken by this plan (with reasons)

- **D1. A new workspace crate, not an ignored test and not an `xtask`.** An ignored integration test under `host/tests/load/` would run inside the test harness: no command line (profile, duration, report folder, attach), a `cargo test` timeout for a four-hour run, the host in the harness's own process (so «memory and descriptors of the host» would include six simulated devices), and the `host/tests` support code would have to be copied. The repository has no `xtask` convention, and an `xtask` is a crate anyway. A crate `apps/standalone/loadtest` (library plus the binary `markiro-loadtest`) has a real command line and unit tests in the ordinary gate. It adds no third-party package: its dependencies are the ones the host already locks (`Cargo.lock` gains one block, Task 1).
- **D2. What is in the required gate and what is not.** In the gate, through the existing `standalone-rust` and Windows jobs' `cargo test --workspace`: the crate's 58 unit tests (seconds) and `tests/write_review.rs` (a source scan, Task 14). Out of the gate: every run. The self-test `tests/self_run.rs` is `#[ignore]`; the smoke and soak are the binary, started by hand or by the opt-in `standalone-load.yml` (`workflow_dispatch` only, Task 15): timing thresholds on a shared runner are noisy, a three-minute load per pull request would cost more than it protects, and a required check that flakes teaches people to retry.
- **D3. The numbers come from a real child process.** `Host::spawned` runs `markiro-host run --data-dir … --port …` (output to `host-stdout.log`), so its memory and descriptors are its own and its log says whether SQLite refused to wait. `Host::in_process` exists for the harness's own tests; `Host::attached` for a host somebody else runs (throwaway only; D11).
- **D4. The oracle is a ledger of receipts, and every check is exact.** A device queues records, sends them in batches, and on a 200 applies each receipt once to the ledger. Derived expectations: the shift's accepted units = distinct codes with at least one `accepted` receipt; `code_conflicts` rows of kind `late` = `conflict` receipts; of kind `displaced` = accepted receipts beyond the first of a code; scans rows = `accepted` + `conflict` scan receipts; closed boxes and pallets = accepted `box_closed` and `pallet_closed`. Two tiers: the API tier (every device's `GET /v1/device/shifts`, the office's `GET /v1/office/shifts/{id}`) works against any host; the database tier (read-only, from the data folder) needs the folder and is on for every host the harness starts.
- **D5. Injection is realistic and its outcome is determined.** Fresh codes are unique per (run, device, n). A _late duplicate_ is a code another device was told it owns, scanned without the host's check (the station's 300 ms ran out): the host answers `conflict`. A _checked duplicate_ does the check, sees `taken` and is sent as a `duplicate` verdict (a journal row). A _race_: an offline device offers one of its queued scans; an online device scans that code first; the offline device waits (at most 10 s) until the later scan is acknowledged, then replays: its earlier scan displaces the other (`displaced`). A _resend_ sends an acknowledged batch again and must get the same receipts. Because the ledger is built from receipts, a race that did not resolve in the planned order still reconciles; `conflicts_injected_vs_observed` requires 90-100 % of the injections to have happened.
- **D6. «SQLITE_BUSY is zero» is read from the host's log.** The API hides database errors (`ApiError::internal` logs the cause and answers 500 `internal`), so busy is counted from the lines of `host-stdout.log` that name it (`database is locked`, `SQLITE_BUSY`, `(code: 5)`, `(code: 6)`) and every 5xx and ERROR line is a failure too. In-process and attached hosts have no log: only the 5xx rule applies there (reported as a gap).
- **D7. WAL behaviour is read from the wal-index, not forced.** A checkpoint cannot be run from outside without writing. `host.db-shm` holds `mxFrame` and `nBackfill`; their difference is the log's backlog (frames no checkpoint has copied). It is sampled every `sampleS` seconds with the file sizes; a torn read is read again. The WAL file's size alone says little (SQLite reuses the file from its start and never shrinks it): the backlog and its p99 are the figures. Where `host.db-shm` cannot be read (Windows may refuse), the run warns and judges what it has.
- **D8. A backup under load is judged by bounds, a restore by equality.** A copy taken while devices write holds every scan acknowledged before it was asked for and none that was not yet sent when it finished: `acked_before <= scans_in_copy <= acked_after + devices × batchMax (+ the drills' scans for the last one)`; it must also pass `integrity_check`, the foreign-key check and the structural checks (no SSCC twice, no code live twice, blocks disjoint). At rest, the last copy is restored into a folder of its own and the nine fact tables must hold exactly the live database's counts; a host started on it must answer the shift's total to a device whose key the copy kept.
- **D9. Thresholds are code, with numbers and a policy.** `Thresholds::for_profile` holds them (Task 2, table in the runbook). They are the starting numbers; the first three smoke runs on the CI runner and on the owner's PC are calibration, and a threshold moves only with the three reports attached to the change (it may tighten freely, loosen only with the owner's yes). `tiny` is the harness's own self-test: the same rules, latency four times looser.
- **D10. Drills run after the main run, on fresh shifts, with scripted devices.** The line is free once the main shift is closed. Each drill plans a shift, has every device enter, make 2 × capacity + 1 scans (so a partial box exists), close its box and pallet, and then closes in an order: stations first, handhelds first, shuffled; or the office closes while one part is open (the part's three later scans must be accepted as late and the shift stay closed); or a plan that differs from the made quantity is closed with no reason (the last receipt says `reasonMissing`, the office gives the reason with `PUT …/close-reason`). A record id is derived from the shift and the device, or a second drill's close would meet the first's receipt as a `payload_mismatch`.
- **D11. Reports live outside the repository; a throwaway host only.** The report folder (`--out`, `$MARKIRO_LOAD_OUT`, default `~/markiro-load`) is refused when it is inside a git checkout. The data of a passing run is deleted (`--keep-data` keeps it); a failing run keeps `data/`, `restored/` and the host log. `markiro-host run` binds every interface (it has no flag for less), so a run belongs on a machine you trust, and attach mode creates devices and shifts on its target: never a production site.
- **D12. What the harness does not simulate** (listed so nobody reads a green run as more than it is): box and pallet label checks (`box_label`, `pallet_label`), box exceptions, validation shifts, disaggregation, warehouse pallets, the handheld's warehouse and pallet-event routes, real printers and scanners, a real LAN, the Windows service. A handheld here is a full participant that works the shift as a station does (plan 2b: «a handheld is a full participant, equal to a station»).
- **D13. The write review of §8 is a test.** `tests/write_review.rs` scans the host's source: no function opens a deferred transaction (`pool.begin()`) and writes after it, the hot write paths (`receive_facts`, `issue_block`, `enter_shift`) call `begin_write`, the code check reads on a plain connection, a facts batch is one transaction of at most 100 records, a backup is one `VACUUM INTO`. It is a heuristic: a flagged line is read by a person.

## File structure

| File                                                                                                                                            | Responsibility                                                        | Tasks |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ----- |
| `apps/standalone/Cargo.toml`, `Cargo.lock`                                                                                                      | the new member and its one lock block                                 | 1     |
| `apps/standalone/loadtest/Cargo.toml`                                                                                                           | the crate's manifest                                                  | 1     |
| `loadtest/src/rng.rs`, `histogram.rs`                                                                                                           | seeded numbers; latency histogram                                     | 1     |
| `loadtest/src/profile.rs`                                                                                                                       | `Profile`, presets, `Thresholds`                                      | 2     |
| `loadtest/src/gen.rs`                                                                                                                           | codes, SSCC, instants, fact builders                                  | 3     |
| `loadtest/src/checks.rs`, `metrics.rs`, `api.rs`                                                                                                | a check; per-route latency and error classes; the pinned HTTPS client | 4     |
| `loadtest/src/wal.rs`, `procstat.rs`, `sampler.rs`                                                                                              | WAL backlog; memory and descriptors; the series                       | 5     |
| `loadtest/src/host.rs`                                                                                                                          | the host under test (in-process, child, attached), log scan           | 6     |
| `loadtest/src/site.rs`                                                                                                                          | wizard, catalog, line limit, pairing, shift, entries                  | 7     |
| `loadtest/src/ledger.rs`, `engine.rs`                                                                                                           | the oracle; one device without a network                              | 8     |
| `loadtest/src/device.rs`                                                                                                                        | the simulated device's network tasks, `Shared`, injection plan        | 9     |
| `loadtest/src/dbcheck.rs`                                                                                                                       | structural and reconciling database checks                            | 10    |
| `loadtest/src/report.rs`                                                                                                                        | report, verdict, Markdown, comparison                                 | 11    |
| `loadtest/src/probes.rs`, `drills.rs`                                                                                                           | backup under load, restore round trip; the five drills                | 12    |
| `loadtest/src/run.rs`, `cli.rs`, `main.rs`, `loadtest/tests/self_run.rs`                                                                        | the run, the command line, the self-test                              | 13    |
| `loadtest/tests/write_review.rs`                                                                                                                | the write review as a test                                            | 14    |
| `tools/ci/affected.mjs`, `tools/ci/test/affected.test.mjs`, `.github/workflows/standalone-load.yml`, `tools/ci/test/workflow-triggers.test.mjs` | CI routing and the opt-in workflow                                    | 15    |
| `docs/runbooks/standalone-load-test.md`, `apps/standalone/AGENTS.md`                                                                            | the owner's runbook and the scoped guide                              | 16    |
| (no file)                                                                                                                                       | acceptance runs and final gates                                       | 17    |

---

### Task 1: The crate, its lock block, seeded numbers and the latency histogram

**Files:**

- Modify: `apps/standalone/Cargo.toml` (the `members` line)
- Create: `apps/standalone/loadtest/Cargo.toml`, `apps/standalone/loadtest/src/lib.rs`, `apps/standalone/loadtest/src/main.rs`, `apps/standalone/loadtest/src/rng.rs`, `apps/standalone/loadtest/src/histogram.rs`
- Modify: `apps/standalone/Cargo.lock` (written by cargo: one new block)

**Interfaces:**

- Consumes: nothing.
- Produces: `rng::Rng { new(seed: u64) -> Rng, next_u64(&mut self) -> u64, unit(&mut self) -> f64, chance(&mut self, p: f64) -> bool, range(&mut self, low: u64, high: u64) -> u64, exp(&mut self, mean: f64) -> f64, jitter(&mut self, base: f64, spread: f64) -> f64, uuid(&mut self) -> String }` (a lower-case hyphenated version 4 UUID, the form the host accepts); `histogram::Histogram { new, record(micros: u64), merge(&Histogram), count() -> u64, quantile(q: f64) -> u64, summary() -> LatencySummary }` and `histogram::LatencySummary { count, p50_ms, p95_ms, p99_ms, max_ms, mean_ms }` (serde, camelCase).

- [ ] **Step 1: Add the member.** In `apps/standalone/Cargo.toml` change the members line to:

```toml
members = ["proto", "host", "src-tauri", "loadtest"]
```

- [ ] **Step 2: Create `apps/standalone/loadtest/Cargo.toml`:**

```toml
[package]
name = "markiro-loadtest"
version = "0.0.0"
description = "Load and soak harness of the standalone host: several devices in one shift (spec 2026-10-20 section 8)"
edition = "2021"
license-file = "../../../LICENSE"
publish = false

[lib]
name = "markiro_loadtest"
path = "src/lib.rs"

[[bin]]
name = "markiro-loadtest"
path = "src/main.rs"

[dependencies]
markiro-host = { path = "../host" }
markiro-proto = { path = "../proto" }
reqwest = { version = "=0.13.4", default-features = false, features = ["json", "rustls"] }
rustls = { version = "=0.23.45", default-features = false, features = ["aws_lc_rs", "std", "tls12", "logging"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
sha2 = "0.10"
sqlx = { version = "=0.8.6", default-features = false, features = ["runtime-tokio", "sqlite"] }
tempfile = "3"
time = { version = "=0.3.55", features = ["formatting", "parsing"] }
tokio = { version = "=1.53.1", features = ["rt-multi-thread", "macros", "net", "signal", "sync", "time"] }
```

Every dependency is one the host or the protocol crate already locks, at the same exact version or range, with a subset of the same features.

- [ ] **Step 3: Write the failing tests.** `src/lib.rs` (replaced by every later task with the modules so far):

```rust
pub mod histogram;
pub mod rng;
```

`src/main.rs` (a stub until Task 13):

```rust
fn main() {}
```

`src/rng.rs` holds only its tests for now:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_same_seed_makes_the_same_numbers() {
        let mut a = Rng::new(7);
        let mut b = Rng::new(7);
        assert_eq!(
            (0..5).map(|_| a.next_u64()).collect::<Vec<_>>(),
            (0..5).map(|_| b.next_u64()).collect::<Vec<_>>()
        );
        assert_ne!(Rng::new(7).next_u64(), Rng::new(8).next_u64());
    }

    #[test]
    fn units_stay_in_range_and_chance_respects_its_bounds() {
        let mut rng = Rng::new(1);
        for _ in 0..10_000 {
            let unit = rng.unit();
            assert!((0.0..1.0).contains(&unit));
        }
        assert!((0..1000).all(|_| !rng.chance(0.0)));
        assert!((0..1000).all(|_| rng.chance(1.0)));
        let hits = (0..100_000).filter(|_| rng.chance(0.25)).count();
        assert!((24_000..26_000).contains(&hits), "{hits}");
    }

    #[test]
    fn a_uuid_is_canonical_and_never_repeats() {
        let mut rng = Rng::new(3);
        let mut seen = std::collections::HashSet::new();
        for _ in 0..1000 {
            let id = rng.uuid();
            assert_eq!(id.len(), 36);
            assert_eq!(&id[14..15], "4");
            assert!(matches!(&id[19..20], "8" | "9" | "a" | "b"), "{id}");
            assert_eq!(id, id.to_lowercase());
            assert!(seen.insert(id));
        }
    }

    #[test]
    fn range_and_exp_behave() {
        let mut rng = Rng::new(9);
        assert_eq!(rng.range(5, 5), 5);
        assert!((0..1000).all(|_| (10..20).contains(&rng.range(10, 20))));
        let mean = (0..50_000).map(|_| rng.exp(4.0)).sum::<f64>() / 50_000.0;
        assert!((3.8..4.2).contains(&mean), "{mean}");
    }
}
```

`src/histogram.rs` likewise:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_empty_histogram_answers_zero() {
        let histogram = Histogram::new();
        assert_eq!((histogram.count(), histogram.quantile(0.99)), (0, 0));
        assert_eq!(histogram.summary(), LatencySummary::default());
    }

    #[test]
    fn quantiles_of_a_uniform_run_are_within_four_percent() {
        let mut histogram = Histogram::new();
        for value in 1..=10_000u64 {
            histogram.record(value);
        }
        for (q, expected) in [(0.5, 5_000.0), (0.95, 9_500.0), (0.99, 9_900.0)] {
            let got = histogram.quantile(q) as f64;
            assert!((got - expected).abs() / expected < 0.04, "q{q}: {got}");
        }
        assert_eq!(histogram.quantile(1.0), 10_000);
        assert_eq!(histogram.summary().max_ms, 10.0);
    }

    #[test]
    fn small_values_are_exact_and_huge_ones_do_not_overflow() {
        let mut histogram = Histogram::new();
        histogram.record(7);
        histogram.record(31);
        histogram.record(u64::MAX / 2);
        assert_eq!(histogram.quantile(0.01), 7);
        assert_eq!(histogram.quantile(0.5), 31);
        assert_eq!(histogram.quantile(1.0), u64::MAX / 2);
    }

    #[test]
    fn merging_adds_counts_and_keeps_the_larger_maximum() {
        let (mut a, mut b) = (Histogram::new(), Histogram::new());
        for value in 1..=10 {
            a.record(value * 100_000);
        }
        b.record(900_000);
        a.merge(&b);
        assert_eq!(a.count(), 11);
        assert_eq!(a.summary().max_ms, 1000.0);
    }
}
```

- [ ] **Step 4: Run them to verify they fail.**

Run: `cargo --offline test --manifest-path "$WT/apps/standalone/Cargo.toml" -p markiro-loadtest --lib`
Expected: FAIL to compile (`cannot find type Rng` / `Histogram` in this scope). This first run also writes the lock. Check it: `git -C "$WT" diff --stat apps/standalone/Cargo.lock` shows 17 added lines, and `git -C "$WT" diff apps/standalone/Cargo.lock` is exactly one new block between `markiro-host` and `markiro-proto`:

```text
+[[package]]
+name = "markiro-loadtest"
+version = "0.0.0"
+dependencies = [
+ "markiro-host",
+ "markiro-proto",
+ "reqwest",
+ "rustls",
+ "serde",
+ "serde_json",
+ "sha2",
+ "sqlx",
+ "tempfile",
+ "time",
+ "tokio",
+]
+
```

Anything else changed in the lock means a dependency was added by mistake: stop and fix `Cargo.toml`. The crate keeps version `0.0.0`: it is not part of the build's version contract (`tools/standalone-release/test/versions.test.mjs` names three crates and this is not one).

- [ ] **Step 5: Write the implementation.** In `src/rng.rs` put this above the tests module of Step 3 (the tests stay as they are):

```rust
//! A small seeded generator (SplitMix64): a run with the same seed makes the
//! same payloads, and the crate needs no `rand`.

#[derive(Debug, Clone)]
pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Self {
        Self(seed)
    }

    pub fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    /// A number in `[0, 1)`.
    pub fn unit(&mut self) -> f64 {
        (self.next_u64() >> 11) as f64 / (1u64 << 53) as f64
    }

    /// `true` with probability `p` (never for 0, always for 1 and more).
    pub fn chance(&mut self, p: f64) -> bool {
        self.unit() < p
    }

    /// A number in `[low, high)`; `low` when the range is empty.
    pub fn range(&mut self, low: u64, high: u64) -> u64 {
        if high <= low {
            return low;
        }
        low + self.next_u64() % (high - low)
    }

    /// An exponentially distributed number with the given mean.
    pub fn exp(&mut self, mean: f64) -> f64 {
        -mean * (1.0 - self.unit()).ln()
    }

    /// `base` times a factor in `[1 - spread, 1 + spread)`.
    pub fn jitter(&mut self, base: f64, spread: f64) -> f64 {
        base * (1.0 - spread + 2.0 * spread * self.unit())
    }

    /// A lower-case hyphenated version 4 UUID, the form the host accepts.
    pub fn uuid(&mut self) -> String {
        let high = self.next_u64();
        let low = self.next_u64();
        let high = (high & 0xFFFF_FFFF_FFFF_0FFF) | 0x0000_0000_0000_4000;
        let low = (low & 0x3FFF_FFFF_FFFF_FFFF) | 0x8000_0000_0000_0000;
        format!(
            "{:08x}-{:04x}-{:04x}-{:04x}-{:012x}",
            high >> 32,
            (high >> 16) & 0xFFFF,
            high & 0xFFFF,
            low >> 48,
            low & 0xFFFF_FFFF_FFFF
        )
    }
}
```

In `src/histogram.rs`, above its tests module:

```rust
//! A latency histogram in microseconds: 32 sub-buckets per power of two, so a
//! quantile is within about 3 % of the true value and a histogram is a fixed
//! 1184 counters whatever it holds.

use serde::{Deserialize, Serialize};

const SUB: u64 = 32;
const BUCKETS: usize = (SUB as usize) * 37;

#[derive(Debug, Clone)]
pub struct Histogram {
    counts: Vec<u64>,
    total: u64,
    sum: u128,
    max: u64,
}

impl Default for Histogram {
    fn default() -> Self {
        Self::new()
    }
}

fn index(value: u64) -> usize {
    if value < SUB {
        return value as usize;
    }
    let msb = 63 - u64::from(value.leading_zeros());
    let shift = msb - 5;
    let sub = (value >> shift) - SUB;
    let at = SUB + shift * SUB + sub;
    (at as usize).min(BUCKETS - 1)
}

/// The largest value a bucket holds.
fn upper(at: usize) -> u64 {
    let at = at as u64;
    if at < SUB {
        return at;
    }
    let k = at - SUB;
    let shift = k / SUB;
    let sub = k % SUB;
    ((SUB + sub + 1) << shift) - 1
}

impl Histogram {
    pub fn new() -> Self {
        Self {
            counts: vec![0; BUCKETS],
            total: 0,
            sum: 0,
            max: 0,
        }
    }

    pub fn record(&mut self, micros: u64) {
        self.counts[index(micros)] += 1;
        self.total += 1;
        self.sum += u128::from(micros);
        self.max = self.max.max(micros);
    }

    pub fn merge(&mut self, other: &Histogram) {
        for (mine, theirs) in self.counts.iter_mut().zip(&other.counts) {
            *mine += theirs;
        }
        self.total += other.total;
        self.sum += other.sum;
        self.max = self.max.max(other.max);
    }

    pub fn count(&self) -> u64 {
        self.total
    }

    /// The value at quantile `q` (0..=1) in microseconds: the upper edge of
    /// its bucket, never more than the largest value recorded; 0 when empty.
    pub fn quantile(&self, q: f64) -> u64 {
        if self.total == 0 {
            return 0;
        }
        let rank = ((q * self.total as f64).ceil() as u64).clamp(1, self.total);
        let mut seen = 0;
        for (at, count) in self.counts.iter().enumerate() {
            seen += count;
            if seen >= rank {
                return if at == BUCKETS - 1 {
                    self.max
                } else {
                    upper(at).min(self.max)
                };
            }
        }
        self.max
    }

    pub fn summary(&self) -> LatencySummary {
        let ms = |micros: u64| micros as f64 / 1000.0;
        LatencySummary {
            count: self.total,
            p50_ms: ms(self.quantile(0.50)),
            p95_ms: ms(self.quantile(0.95)),
            p99_ms: ms(self.quantile(0.99)),
            max_ms: ms(self.max),
            mean_ms: if self.total == 0 {
                0.0
            } else {
                self.sum as f64 / self.total as f64 / 1000.0
            },
        }
    }
}

/// What a report keeps of a histogram.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LatencySummary {
    pub count: u64,
    pub p50_ms: f64,
    pub p95_ms: f64,
    pub p99_ms: f64,
    pub max_ms: f64,
    pub mean_ms: f64,
}
```

- [ ] **Step 6: Run the tests to verify they pass.**

Run: `cargo --offline --locked test --manifest-path "$WT/apps/standalone/Cargo.toml" -p markiro-loadtest --lib -- rng:: histogram::`
Expected: PASS, 8 tests (rng 4, histogram 4).

- [ ] **Step 7: Format and commit.**

Run: `cargo fmt --manifest-path "$WT/apps/standalone/Cargo.toml" --all -- --check` (clean).

```bash
git -C "$WT" add apps/standalone/Cargo.toml \
  apps/standalone/Cargo.lock \
  apps/standalone/loadtest/Cargo.toml \
  apps/standalone/loadtest/src/lib.rs \
  apps/standalone/loadtest/src/main.rs \
  apps/standalone/loadtest/src/rng.rs \
  apps/standalone/loadtest/src/histogram.rs
git -C "$WT" commit -m "feat(standalone): the load test crate with its seeded numbers and latency histogram

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Profiles and thresholds

**Files:**

- Create: `apps/standalone/loadtest/src/profile.rs`
- Modify: `apps/standalone/loadtest/src/lib.rs`

**Interfaces:**

- Consumes: nothing.
- Produces: `profile::CloseOrder { StationsFirst, HandheldsFirst, Shuffled }` (`FromStr`: `stations-first`, `handhelds-first`, `shuffled`); `profile::Profile` (serde camelCase; fields `name, stations, handhelds, scan_rate, duration_s, box_capacity, pallet_boxes, box_block_size, pallet_block_size, flush_ms, batch_max, mean_online_s, mean_offline_s, late_dup_rate, checked_dup_rate, race_rate, resend_rate, totals_poll_s, backup_at, sample_s, seed, close_order`) with `Profile::preset(name) -> Result<Profile, String>` (`tiny`, `smoke`, `soak`), `set(&mut self, key, value) -> Result<(), String>` (the camelCase field name), `validate()`, `devices() -> u32`, `ideal_scans() -> f64`; `profile::Thresholds` (the figures of D9) with `Thresholds::for_profile(name) -> Result<Thresholds, String>`.

The presets, as the task fixes them: **smoke** = 4 stations + 2 handhelds × 5 scans/s for 180 s, box capacity 12, pallets of 5 boxes, SSCC blocks of 40 boxes and 6 pallets (so the half rule fires about every 50 s per device), links online ~45 s and offline ~6 s on average, 0.5 % late duplicates, 1 % checked duplicates, offline scans offered for a race with probability 0.2, 2 % of batches sent again, one backup at 50 %. **soak** = the same × 10 scans/s for 14 400 s, blocks of 200 and 20, pallets of 10 boxes, links online ~600 s and offline ~20 s, race offers 0.05, backups at 25, 50 and 75 %, a sample every 15 s. **tiny** = 2 stations + 1 handheld, 20 s, box capacity 6, pallets of 2, blocks of 12 and 4, links online ~6 s and offline ~2 s, the harness's own self-test.

The thresholds (smoke; soak differs only where noted; tiny is smoke with latencies ×4 and the max ×2): facts p95 ≤ 100 ms, p99 ≤ 250 ms (soak 150 / 400), max ≤ 2000 ms (well under the host's 5 s busy timeout); facts p99 while a backup runs ≤ 500 ms (soak 800); code check p99 ≤ 150 ms and at most 0.1 % of checks over the station's 300 ms; p99 of the other measured routes ≤ 500 ms; 5xx answers and ERROR log lines 0; database-busy log lines 0; requests without an answer 0; requests the host refused (4xx) 0; WAL backlog ≤ 8000 frames (about 32 MiB at 4 KiB, eight times SQLite's own auto-checkpoint of 1000) and WAL file ≤ 256 MiB; host memory growth ≤ 20 MiB per hour (judged for runs of at least 30 minutes); descriptors ≤ 64 + 4 per device and at most 8 more at the end than after the warm-up; the devices made at least 90 % of the ideal scans (below it the harness itself lagged).

- [ ] **Step 1: Write the failing tests.** `src/lib.rs`:

```rust
pub mod histogram;
pub mod profile;
pub mod rng;
```

`src/profile.rs` (tests only):

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_smoke_and_soak_presets_are_the_documented_ones() {
        let smoke = Profile::preset("smoke").unwrap();
        assert_eq!(
            (
                smoke.stations,
                smoke.handhelds,
                smoke.scan_rate,
                smoke.duration_s
            ),
            (4, 2, 5.0, 180)
        );
        let soak = Profile::preset("soak").unwrap();
        assert_eq!(
            (
                soak.stations,
                soak.handhelds,
                soak.scan_rate,
                soak.duration_s
            ),
            (4, 2, 10.0, 14_400)
        );
        assert_eq!(soak.backup_at, vec![0.25, 0.5, 0.75]);
        assert_eq!(smoke.ideal_scans(), 6.0 * 5.0 * 180.0);
        for name in ["tiny", "smoke", "soak"] {
            Profile::preset(name).unwrap().validate().unwrap();
            Thresholds::for_profile(name).unwrap();
        }
        assert!(Profile::preset("huge").is_err());
    }

    #[test]
    fn set_changes_one_field_and_refuses_what_cannot_run() {
        let mut profile = Profile::preset("smoke").unwrap();
        profile.set("scanRate", "7.5").unwrap();
        profile.set("backupAt", "0.3,0.6").unwrap();
        profile.set("closeOrder", "handhelds-first").unwrap();
        assert_eq!(profile.scan_rate, 7.5);
        assert_eq!(profile.backup_at, vec![0.3, 0.6]);
        assert_eq!(profile.close_order, CloseOrder::HandheldsFirst);
        assert!(profile.set("scanRate", "fast").is_err());
        assert!(profile.set("nonsense", "1").is_err());
        assert!(profile.set("batchMax", "101").is_err());
        assert!(profile.set("stations", "17").is_err());
        assert!(profile.set("raceRate", "1.5").is_err());
        assert!(profile.set("backupAt", "1.0").is_err());
    }

    #[test]
    fn the_tiny_thresholds_are_looser_only_where_a_machine_decides() {
        let tiny = Thresholds::for_profile("tiny").unwrap();
        let smoke = Thresholds::for_profile("smoke").unwrap();
        assert_eq!((tiny.busy_errors, tiny.server_errors), (0, 0));
        assert_eq!(tiny.facts_p99_ms, smoke.facts_p99_ms * 4.0);
        assert_eq!(tiny.wal_backlog_max_frames, smoke.wal_backlog_max_frames);
    }
}
```

- [ ] **Step 2: Run them to verify they fail.**

Run: `cargo --offline --locked test --manifest-path "$WT/apps/standalone/Cargo.toml" -p markiro-loadtest --lib -- profile::`
Expected: FAIL to compile (`cannot find type Profile`).

- [ ] **Step 3: Write the implementation** above the tests module in `src/profile.rs`:

```rust
//! What a run does (the profile) and what it must show to pass (the
//! thresholds). Three presets: `tiny` (a self-test of the harness, seconds),
//! `smoke` (the CI job, minutes) and `soak` (the owner's long run, hours).

use serde::{Deserialize, Serialize};

/// The order in which the devices close their parts at the end of the run.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CloseOrder {
    StationsFirst,
    HandheldsFirst,
    Shuffled,
}

impl std::str::FromStr for CloseOrder {
    type Err = String;

    fn from_str(text: &str) -> Result<Self, String> {
        match text {
            "stations-first" => Ok(Self::StationsFirst),
            "handhelds-first" => Ok(Self::HandheldsFirst),
            "shuffled" => Ok(Self::Shuffled),
            other => Err(format!(
                "close order '{other}': stations-first, handhelds-first or shuffled"
            )),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub name: String,
    pub stations: u32,
    pub handhelds: u32,
    /// Scans a second, of each device.
    pub scan_rate: f64,
    pub duration_s: u64,
    pub box_capacity: u32,
    /// Boxes on a pallet; 0 runs a shift without pallets.
    pub pallet_boxes: u32,
    pub box_block_size: u32,
    pub pallet_block_size: u32,
    /// How often a device sends its outbox, and the most it sends at once.
    pub flush_ms: u64,
    pub batch_max: usize,
    /// Mean seconds a device stays online and offline; 0 offline: never drops.
    pub mean_online_s: f64,
    pub mean_offline_s: f64,
    /// A scan of a code another device holds, sent without the host's check
    /// (the 300 ms ran out): the host answers `conflict`.
    pub late_dup_rate: f64,
    /// A scan of a code another device holds, after the host's check said
    /// taken: the station sends it as a `duplicate`.
    pub checked_dup_rate: f64,
    /// An offline device's scan that an online device scans first: the host
    /// takes the earlier one when the offline device comes back.
    pub race_rate: f64,
    /// A batch sent again after its answer was kept, to prove idempotency.
    pub resend_rate: f64,
    pub totals_poll_s: f64,
    /// Fractions of the run at which a backup is asked for under load.
    pub backup_at: Vec<f64>,
    pub sample_s: u64,
    pub seed: u64,
    pub close_order: CloseOrder,
}

impl Profile {
    pub fn devices(&self) -> u32 {
        self.stations + self.handhelds
    }

    pub fn preset(name: &str) -> Result<Profile, String> {
        let smoke = Profile {
            name: "smoke".to_owned(),
            stations: 4,
            handhelds: 2,
            scan_rate: 5.0,
            duration_s: 180,
            box_capacity: 12,
            pallet_boxes: 5,
            box_block_size: 40,
            pallet_block_size: 6,
            flush_ms: 300,
            batch_max: 100,
            mean_online_s: 45.0,
            mean_offline_s: 6.0,
            late_dup_rate: 0.005,
            checked_dup_rate: 0.01,
            race_rate: 0.2,
            resend_rate: 0.02,
            totals_poll_s: 5.0,
            backup_at: vec![0.5],
            sample_s: 5,
            seed: 20_261_020,
            close_order: CloseOrder::Shuffled,
        };
        match name {
            "smoke" => Ok(smoke),
            "tiny" => Ok(Profile {
                name: "tiny".to_owned(),
                stations: 2,
                handhelds: 1,
                duration_s: 20,
                box_capacity: 6,
                pallet_boxes: 2,
                box_block_size: 12,
                pallet_block_size: 4,
                mean_online_s: 6.0,
                mean_offline_s: 2.0,
                late_dup_rate: 0.02,
                checked_dup_rate: 0.03,
                sample_s: 1,
                totals_poll_s: 2.0,
                ..smoke
            }),
            "soak" => Ok(Profile {
                name: "soak".to_owned(),
                scan_rate: 10.0,
                duration_s: 4 * 3600,
                box_block_size: 200,
                pallet_block_size: 20,
                pallet_boxes: 10,
                mean_online_s: 600.0,
                mean_offline_s: 20.0,
                race_rate: 0.05,
                backup_at: vec![0.25, 0.5, 0.75],
                sample_s: 15,
                ..smoke
            }),
            other => Err(format!("profile '{other}': tiny, smoke or soak")),
        }
    }

    /// `key=value`, one of the profile's own fields (the CLI's `--set`).
    pub fn set(&mut self, key: &str, value: &str) -> Result<(), String> {
        fn number<T: std::str::FromStr>(key: &str, value: &str) -> Result<T, String> {
            value
                .parse()
                .map_err(|_| format!("{key}: '{value}' is not a number of the right kind"))
        }
        match key {
            "stations" => self.stations = number(key, value)?,
            "handhelds" => self.handhelds = number(key, value)?,
            "scanRate" => self.scan_rate = number(key, value)?,
            "durationS" => self.duration_s = number(key, value)?,
            "boxCapacity" => self.box_capacity = number(key, value)?,
            "palletBoxes" => self.pallet_boxes = number(key, value)?,
            "boxBlockSize" => self.box_block_size = number(key, value)?,
            "palletBlockSize" => self.pallet_block_size = number(key, value)?,
            "flushMs" => self.flush_ms = number(key, value)?,
            "batchMax" => self.batch_max = number(key, value)?,
            "meanOnlineS" => self.mean_online_s = number(key, value)?,
            "meanOfflineS" => self.mean_offline_s = number(key, value)?,
            "lateDupRate" => self.late_dup_rate = number(key, value)?,
            "checkedDupRate" => self.checked_dup_rate = number(key, value)?,
            "raceRate" => self.race_rate = number(key, value)?,
            "resendRate" => self.resend_rate = number(key, value)?,
            "totalsPollS" => self.totals_poll_s = number(key, value)?,
            "sampleS" => self.sample_s = number(key, value)?,
            "seed" => self.seed = number(key, value)?,
            "backupAt" => {
                self.backup_at = value
                    .split(',')
                    .filter(|part| !part.is_empty())
                    .map(|part| number::<f64>(key, part))
                    .collect::<Result<_, _>>()?
            }
            "closeOrder" => self.close_order = value.parse()?,
            other => return Err(format!("unknown profile field '{other}'")),
        }
        self.validate()
    }

    pub fn validate(&self) -> Result<(), String> {
        if self.stations == 0 {
            return Err("stations: at least one (the office station takes part)".into());
        }
        if self.devices() > 16 {
            return Err("stations + handhelds: at most 16 (the line's limit)".into());
        }
        if !(self.scan_rate > 0.0 && self.scan_rate <= 100.0) {
            return Err("scanRate: above 0 and at most 100 a second".into());
        }
        if self.duration_s == 0 || self.box_capacity == 0 || self.batch_max == 0 {
            return Err("durationS, boxCapacity and batchMax must be above 0".into());
        }
        if self.batch_max > 100 {
            return Err("batchMax: the host takes at most 100 records".into());
        }
        if self.box_block_size < 2 || (self.pallet_boxes > 0 && self.pallet_block_size < 2) {
            return Err("block sizes: at least 2 (the half rule needs a half)".into());
        }
        for (name, rate) in [
            ("lateDupRate", self.late_dup_rate),
            ("checkedDupRate", self.checked_dup_rate),
            ("raceRate", self.race_rate),
            ("resendRate", self.resend_rate),
        ] {
            if !(0.0..=1.0).contains(&rate) {
                return Err(format!("{name}: between 0 and 1"));
            }
        }
        if self.backup_at.iter().any(|at| !(0.0..1.0).contains(at)) {
            return Err("backupAt: fractions of the run, 0 up to 1".into());
        }
        Ok(())
    }

    /// The scans the devices would make with no stall: what the harness's own
    /// speed is judged against.
    pub fn ideal_scans(&self) -> f64 {
        f64::from(self.devices()) * self.scan_rate * self.duration_s as f64
    }
}

/// What a run must show. Every number is the most the run may show, except
/// the ratio named `min`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Thresholds {
    pub facts_p95_ms: f64,
    pub facts_p99_ms: f64,
    pub facts_max_ms: f64,
    /// The facts route while a backup runs.
    pub facts_backup_p99_ms: f64,
    pub code_check_p99_ms: f64,
    /// Checks slower than the station's 300 ms, as a share of all.
    pub code_check_over_300ms_share: f64,
    pub other_p99_ms: f64,
    /// Requests the host answered with a 5xx and ERROR lines of its log.
    pub server_errors: u64,
    /// Lines of the host's log that say SQLite refused to wait for a lock.
    pub busy_errors: u64,
    /// Requests that got no answer (a timeout, a refused connection).
    pub net_errors: u64,
    /// Requests the host refused with a 4xx: the harness sends nothing it should refuse.
    pub client_errors: u64,
    pub wal_backlog_max_frames: u64,
    pub wal_file_max_mib: u64,
    pub rss_slope_mib_per_hour: f64,
    /// The slope is judged only for runs at least this long.
    pub slope_min_duration_s: u64,
    /// The host holds at most `fd_fixed + fd_per_device * devices` descriptors,
    /// and no more than `fd_growth_max` more at the end than after the warm-up.
    pub fd_fixed: u64,
    pub fd_per_device: u64,
    pub fd_growth_max: u64,
    /// Scans made, as a share of the ideal; below it the harness itself lagged.
    pub generated_share_min: f64,
}

impl Thresholds {
    pub fn for_profile(name: &str) -> Result<Thresholds, String> {
        let smoke = Thresholds {
            facts_p95_ms: 100.0,
            facts_p99_ms: 250.0,
            facts_max_ms: 2000.0,
            facts_backup_p99_ms: 500.0,
            code_check_p99_ms: 150.0,
            code_check_over_300ms_share: 0.001,
            other_p99_ms: 500.0,
            server_errors: 0,
            busy_errors: 0,
            net_errors: 0,
            client_errors: 0,
            wal_backlog_max_frames: 8000,
            wal_file_max_mib: 256,
            rss_slope_mib_per_hour: 20.0,
            slope_min_duration_s: 1800,
            fd_fixed: 64,
            fd_per_device: 4,
            fd_growth_max: 8,
            generated_share_min: 0.9,
        };
        match name {
            "smoke" => Ok(smoke),
            // The same rules four times as loose where a number is a latency,
            // since a self-test runs on whatever machine the developer has.
            "tiny" => Ok(Thresholds {
                facts_p95_ms: smoke.facts_p95_ms * 4.0,
                facts_p99_ms: smoke.facts_p99_ms * 4.0,
                facts_max_ms: smoke.facts_max_ms * 2.0,
                facts_backup_p99_ms: smoke.facts_backup_p99_ms * 4.0,
                code_check_p99_ms: smoke.code_check_p99_ms * 4.0,
                code_check_over_300ms_share: 0.02,
                other_p99_ms: smoke.other_p99_ms * 4.0,
                generated_share_min: 0.6,
                ..smoke
            }),
            // Six times the facts of a smoke run: the p99 may be a little higher.
            "soak" => Ok(Thresholds {
                facts_p95_ms: 150.0,
                facts_p99_ms: 400.0,
                facts_backup_p99_ms: 800.0,
                ..smoke
            }),
            other => Err(format!("thresholds of '{other}': tiny, smoke or soak")),
        }
    }
}
```

- [ ] **Step 4: Run the tests to verify they pass.**

Run: `cargo --offline --locked test --manifest-path "$WT/apps/standalone/Cargo.toml" -p markiro-loadtest --lib -- profile::`
Expected: PASS, 3 tests.

- [ ] **Step 5: Format and commit.**

Run: `cargo fmt --manifest-path "$WT/apps/standalone/Cargo.toml" --all -- --check` (clean).

```bash
git -C "$WT" add apps/standalone/loadtest/src/lib.rs \
  apps/standalone/loadtest/src/profile.rs
git -C "$WT" commit -m "feat(standalone): load test profiles (tiny, smoke, soak) and their thresholds

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The payloads

**Files:**

- Create: `apps/standalone/loadtest/src/gen.rs`
- Modify: `apps/standalone/loadtest/src/lib.rs`

**Interfaces:**

- Consumes: `markiro_proto::{BoxClosedFact, DuplicateSource, FactKind, FactRecord, PalletClosedFact, ScanFact, ScanRawKind, ScanVerdict, ScannedCode, ShiftClosedFact}` and `markiro_host::facts::rules::{box_membership_digest, device_text}` (both public today).
- Produces: `gen::GTIN14`; `gen::sscc(extension: u8, prefix: &str, serial: u64) -> String` (18 digits with the GS1 check digit); `gen::Code { hash, serial, canonical, key: u64 }` with `Code::new(run: u32, device: u32, n: u64) -> Code` and `scanned() -> ScannedCode` (a serial is `L<run:04x>D<device:02>N<n:010>`, 19 characters, unique to its triple; the hash is the SHA-256 of the canonical text; `key` is its first eight bytes); `gen::DeviceClock { new(), next_ms() -> i64, tick() -> String }` (never repeats or goes back), `gen::text_of(ms: i64) -> String`, `gen::now_ms() -> i64`; the fact data builders `record(id, kind, shift, data) -> Value`, `scan_ok(code, box_id, at)`, `scan_duplicate(code, at)`, `box_closed(box_id, sscc, block_id, serial, opened_at, closed_at, hashes, pallet_id)`, `pallet_closed(pallet_id, sscc, block_id, serial, opened_at, closed_at, boxes)`, `shift_closed(planned, actual, boxes, reason, closed_at)`.

- [ ] **Step 1: Write the failing tests.** `src/lib.rs`:

```rust
pub mod gen;
pub mod histogram;
pub mod profile;
pub mod rng;
```

`src/gen.rs` (tests only):

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_sscc_carries_its_gs1_check_digit() {
        // The host's own tests build the same two (tests/support/app.rs).
        assert_eq!(sscc(0, "460068200", 1500), "046006820000015000");
        assert_eq!(sscc(1, "460068200", 40), "146006820000000409");
    }

    #[test]
    fn codes_of_other_devices_and_numbers_never_share_a_serial_or_a_hash() {
        let mut serials = std::collections::HashSet::new();
        let mut hashes = std::collections::HashSet::new();
        for device in 0..6 {
            for n in 0..500 {
                let code = Code::new(1, device, n);
                assert!(serials.insert(code.serial.clone()));
                assert!(hashes.insert(code.hash.clone()));
                assert_eq!(code.hash.len(), 64);
                assert!(
                    code.serial.len() <= 20,
                    "a GS1 serial has 20 characters at most"
                );
            }
        }
        assert_ne!(Code::new(1, 0, 0).serial, Code::new(2, 0, 0).serial);
        assert_eq!(Code::new(1, 2, 3), Code::new(1, 2, 3));
    }

    #[test]
    fn a_code_keeps_the_group_separator_and_the_shape_the_host_checks() {
        let code = Code::new(1, 0, 7);
        assert!(code.canonical.starts_with("0104600682000013"));
        assert!(code.canonical.contains('\u{1d}'));
        let scanned = code.scanned();
        assert_eq!((scanned.gtin14.len(), scanned.code_hash.len()), (14, 64));
        assert!(rules::is_code_hash(&scanned.code_hash));
    }

    #[test]
    fn a_device_never_repeats_an_instant_and_writes_it_as_the_host_reads_it() {
        let mut clock = DeviceClock::new();
        let mut last = String::new();
        for _ in 0..2000 {
            let at = clock.tick();
            assert!(rules::device_instant(&at).is_some(), "{at}");
            assert!(at > last, "{at} after {last}");
            last = at;
        }
    }

    #[test]
    fn facts_have_the_shape_the_host_reads() {
        let code = Code::new(1, 0, 1);
        let record = record(
            "00000000-0000-4000-8000-000000000001",
            FactKind::Scan,
            "00000000-0000-4000-8000-0000000000aa",
            scan_ok(
                &code,
                "b0000000-0000-4000-8000-000000000001",
                "2026-10-20T10:00:00.000Z",
            ),
        );
        let parsed: FactRecord = serde_json::from_value(record).unwrap();
        assert_eq!(parsed.kind, FactKind::Scan);
        let closed = box_closed(
            "b0000000-0000-4000-8000-000000000001",
            &sscc(0, "460068200", 1),
            "00000000-0000-4000-8000-0000000000bb",
            1,
            "2026-10-20T10:00:00.000Z",
            "2026-10-20T10:01:00.000Z",
            &[code.hash.clone()],
            Some("a0000000-0000-4000-8000-000000000001"),
        );
        let parsed: BoxClosedFact = serde_json::from_value(closed).unwrap();
        assert_eq!(parsed.item_count, 1);
        assert_eq!(
            parsed.membership_digest,
            rules::box_membership_digest(&[code.hash])
        );
    }
}
```

- [ ] **Step 2: Run them to verify they fail.**

Run: `cargo --offline --locked test --manifest-path "$WT/apps/standalone/Cargo.toml" -p markiro-loadtest --lib -- gen::`
Expected: FAIL to compile (`cannot find function sscc`, `Code`, `DeviceClock`).

- [ ] **Step 3: Write the implementation** above the tests module in `src/gen.rs`:

```rust
//! The payloads a simulated device sends: codes with distinct serials, the
//! SSCC of a serial, a device's instants and the facts of a box, a pallet and
//! a close, built from the wire types of `markiro-proto` so a change of the
//! protocol breaks this crate's build, not a night of soak.

use markiro_host::facts::rules;
use markiro_proto::{
    BoxClosedFact, DuplicateSource, FactKind, FactRecord, PalletClosedFact, ScanFact, ScanRawKind,
    ScanVerdict, ScannedCode, ShiftClosedFact,
};
use serde_json::Value;
use sha2::{Digest, Sha256};
use time::OffsetDateTime;

/// The product's GTIN-14: the one `site.rs` creates, which every code carries.
pub const GTIN14: &str = "04600682000013";

/// The 18-digit SSCC of `extension`, `prefix` and `serial`, with its GS1
/// check digit: the serial fills what the prefix leaves of the 16 digits
/// after the extension (the domain's `buildSscc`).
pub fn sscc(extension: u8, prefix: &str, serial: u64) -> String {
    let width = 16usize.saturating_sub(prefix.len());
    let body = format!("{extension}{prefix}{serial:0width$}");
    let sum: u32 = body
        .bytes()
        .rev()
        .enumerate()
        .map(|(place, digit)| u32::from(digit - b'0') * if place % 2 == 0 { 3 } else { 1 })
        .sum();
    format!("{body}{}", (10 - sum % 10) % 10)
}

/// A code of the marking: its serial is unique to (run, device, n), its hash
/// is the SHA-256 of its canonical text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Code {
    pub hash: String,
    pub serial: String,
    pub canonical: String,
    /// The first eight bytes of the hash: what the ledger keys codes by.
    pub key: u64,
}

impl Code {
    pub fn new(run: u32, device: u32, n: u64) -> Code {
        let serial = format!("L{run:04x}D{device:02}N{n:010}");
        let canonical = format!("01{GTIN14}21{serial}\u{1d}93T{n:06x}");
        let digest = Sha256::digest(canonical.as_bytes());
        let hash: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
        let key = u64::from_be_bytes(digest[..8].try_into().expect("eight bytes"));
        Code {
            hash,
            serial,
            canonical,
            key,
        }
    }

    pub fn scanned(&self) -> ScannedCode {
        ScannedCode {
            code_hash: self.hash.clone(),
            gtin14: GTIN14.to_owned(),
            serial: self.serial.clone(),
            canonical: self.canonical.clone(),
        }
    }
}

/// A device's instants: wall time as `Date.toISOString` writes it, never
/// repeated and never going back, whatever the clock does.
#[derive(Debug, Clone, Default)]
pub struct DeviceClock {
    last_ms: i64,
}

pub fn text_of(ms: i64) -> String {
    let at = OffsetDateTime::from_unix_timestamp_nanos(i128::from(ms) * 1_000_000)
        .expect("a representable instant");
    rules::device_text(at)
}

pub fn now_ms() -> i64 {
    (OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000) as i64
}

impl DeviceClock {
    pub fn new() -> Self {
        Self::default()
    }

    /// The next instant, in milliseconds.
    pub fn next_ms(&mut self) -> i64 {
        self.last_ms = now_ms().max(self.last_ms + 1);
        self.last_ms
    }

    pub fn tick(&mut self) -> String {
        text_of(self.next_ms())
    }
}

/// A record of `kind` in `shift` as the host receives it, with no operator.
pub fn record(id: &str, kind: FactKind, shift: &str, data: Value) -> Value {
    serde_json::to_value(FactRecord {
        id: id.to_owned(),
        kind,
        shift_id: shift.to_owned(),
        operator_id: None,
        data,
    })
    .expect("a record is JSON")
}

fn data<T: serde::Serialize>(value: T) -> Value {
    serde_json::to_value(value).expect("a fact's data is JSON")
}

/// An accepted scan of `code` into `box_id`.
pub fn scan_ok(code: &Code, box_id: &str, at: &str) -> Value {
    data(ScanFact {
        scanned_at: at.to_owned(),
        verdict: ScanVerdict::Ok,
        duplicate_source: None,
        raw_kind: ScanRawKind::Km,
        raw_length: code.canonical.len() as u32,
        code: Some(code.scanned()),
        box_id: Some(box_id.to_owned()),
    })
}

/// A scan the host's check called taken: a journal row only.
pub fn scan_duplicate(code: &Code, at: &str) -> Value {
    data(ScanFact {
        scanned_at: at.to_owned(),
        verdict: ScanVerdict::Duplicate,
        duplicate_source: Some(DuplicateSource::Host),
        raw_kind: ScanRawKind::Km,
        raw_length: code.canonical.len() as u32,
        code: Some(code.scanned()),
        box_id: None,
    })
}

/// A box closed with serial `serial` of `block_id` over the codes `hashes`.
#[allow(clippy::too_many_arguments)]
pub fn box_closed(
    box_id: &str,
    sscc: &str,
    block_id: &str,
    serial: u64,
    opened_at: &str,
    closed_at: &str,
    hashes: &[String],
    pallet_id: Option<&str>,
) -> Value {
    data(BoxClosedFact {
        box_id: box_id.to_owned(),
        sscc: sscc.to_owned(),
        block_id: block_id.to_owned(),
        serial,
        opened_at: opened_at.to_owned(),
        closed_at: closed_at.to_owned(),
        item_count: hashes.len() as u32,
        membership_digest: rules::box_membership_digest(hashes),
        pallet_id: pallet_id.map(str::to_owned),
    })
}

/// A pallet closed with serial `serial` of the pallet block `block_id`.
pub fn pallet_closed(
    pallet_id: &str,
    sscc: &str,
    block_id: &str,
    serial: u64,
    opened_at: &str,
    closed_at: &str,
    boxes: u32,
) -> Value {
    data(PalletClosedFact {
        pallet_id: pallet_id.to_owned(),
        sscc: sscc.to_owned(),
        block_id: block_id.to_owned(),
        serial,
        opened_at: opened_at.to_owned(),
        closed_at: closed_at.to_owned(),
        box_count: boxes,
    })
}

/// A device's close of its part of the shift.
pub fn shift_closed(
    planned: Option<u32>,
    actual: u32,
    boxes: u32,
    reason: Option<&str>,
    closed_at: &str,
) -> Value {
    data(ShiftClosedFact {
        planned_qty_snapshot: planned,
        actual_qty: actual,
        closed_box_count: boxes,
        reason_code: reason.map(str::to_owned),
        closed_at: closed_at.to_owned(),
    })
}
```

- [ ] **Step 4: Run the tests to verify they pass.**

Run: `cargo --offline --locked test --manifest-path "$WT/apps/standalone/Cargo.toml" -p markiro-loadtest --lib -- gen::`
Expected: PASS, 5 tests (the two SSCCs are the ones the host's own test support builds: `046006820000015000` and `146006820000000409`).

- [ ] **Step 5: Format and commit.**

Run: `cargo fmt --manifest-path "$WT/apps/standalone/Cargo.toml" --all -- --check` (clean).

```bash
git -C "$WT" add apps/standalone/loadtest/src/lib.rs \
  apps/standalone/loadtest/src/gen.rs
git -C "$WT" commit -m "feat(standalone): load test payloads built from the wire types

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Checks, metrics and the pinned HTTPS client

**Files:**

- Create: `apps/standalone/loadtest/src/checks.rs`, `apps/standalone/loadtest/src/metrics.rs`, `apps/standalone/loadtest/src/api.rs`
- Modify: `apps/standalone/loadtest/src/lib.rs`

**Interfaces:**

- Consumes: `histogram::Histogram`.
- Produces: `checks::Check { name, ok, detail }` (serde) with `Check::new(name, ok, detail)`, `Check::same(name, expected, actual)`, `Check::at_most(name, limit, actual)`; `metrics::Route { Facts, CodeCheck, DeviceShifts, SsccBlock, Enter, Other }` with `label()`; `metrics::error_class(status, body, net) -> Option<String>` (`http_5xx`, `http_4xx:<code>`, `net_<kind>`); `metrics::Metrics { new(), set_backup_running(bool), record(Route, micros), error(Route, class), latency() -> BTreeMap<&'static str, Histogram>, errors() -> BTreeMap<String, u64> }` (a facts latency while a backup runs is also counted under `facts_during_backup`); `api::pinned_client(fingerprint, timeout)`, `api::NetError { Timeout, Connect, Other }`, `api::Reply { status, body, micros }` with `ok()`, `api::Auth { device_key, session }`, `api::Api { new(base, fingerprint, metrics), send(route, method, path, auth, body) -> Result<Reply, NetError>, facts(key, records) -> Result<Vec<Value>, String>, open_stream(path, auth) }`.

`api.rs` has no test of its own: the client is exercised by Task 6's hello test and Task 7's provisioning test, which fail if it is wrong. Its one non-obvious rule: a timeout is recorded as a latency of the whole limit, or a hung host would improve the p99.

- [ ] **Step 1: Write the failing tests.** `src/lib.rs`:

```rust
pub mod api;
pub mod checks;
pub mod gen;
pub mod histogram;
pub mod metrics;
pub mod profile;
pub mod rng;
```

`src/checks.rs` (tests only):

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_check_says_what_it_expected_and_what_it_got() {
        let ok = Check::same("scans", 10u64, 10);
        assert!(ok.ok);
        let bad = Check::same("scans", 10u64, 9);
        assert!(!bad.ok);
        assert_eq!(bad.detail, "expected 10, got 9");
        assert!(Check::at_most("busy", 0, 0).ok);
        assert!(!Check::at_most("busy", 0, 2).ok);
    }
}
```

`src/metrics.rs` (tests only):

```rust
#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn a_class_names_the_status_the_code_or_the_network() {
        let none = Value::Null;
        assert_eq!(error_class(Some(200), &none, None), None);
        assert_eq!(
            error_class(Some(500), &none, None).as_deref(),
            Some("http_5xx")
        );
        assert_eq!(
            error_class(Some(409), &json!({"error": {"code": "conflict"}}), None).as_deref(),
            Some("http_4xx:conflict")
        );
        assert_eq!(
            error_class(Some(400), &none, None).as_deref(),
            Some("http_4xx:unknown")
        );
        assert_eq!(
            error_class(None, &none, Some("timeout")).as_deref(),
            Some("net_timeout")
        );
    }

    #[test]
    fn facts_during_a_backup_are_counted_twice_and_others_once() {
        let metrics = Metrics::new();
        metrics.record(Route::Facts, 1000);
        metrics.set_backup_running(true);
        metrics.record(Route::Facts, 2000);
        metrics.record(Route::CodeCheck, 500);
        metrics.set_backup_running(false);
        let latency = metrics.latency();
        assert_eq!(latency["facts"].count(), 2);
        assert_eq!(latency["facts_during_backup"].count(), 1);
        assert_eq!(latency["code_check"].count(), 1);
        assert!(!latency.contains_key("sscc_block"));
    }

    #[test]
    fn errors_are_kept_by_route_and_class() {
        let metrics = Metrics::new();
        metrics.error(Route::Facts, "http_5xx");
        metrics.error(Route::Facts, "http_5xx");
        metrics.error(Route::Enter, "http_5xx");
        metrics.error(Route::Facts, "net_timeout");
        assert_eq!(metrics.errors()["facts:http_5xx"], 2);
    }
}
```

- [ ] **Step 2: Run them to verify they fail.**

Run: `cargo --offline --locked test --manifest-path "$WT/apps/standalone/Cargo.toml" -p markiro-loadtest --lib -- checks:: metrics::`
Expected: FAIL to compile (the modules `checks`, `metrics` and `api` do not exist yet in full).

- [ ] **Step 3: Write the implementation.** `src/checks.rs`, above its tests:

```rust
//! A check is a named yes or no with the numbers behind it: what a run's
//! report lists, and what a threshold turns into when it is crossed.

use std::fmt::Debug;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Check {
    pub name: String,
    pub ok: bool,
    pub detail: String,
}

impl Check {
    pub fn new(name: &str, ok: bool, detail: impl Into<String>) -> Check {
        Check {
            name: name.to_owned(),
            ok,
            detail: detail.into(),
        }
    }

    /// `actual` is what `expected` says it must be.
    pub fn same<T: PartialEq + Debug>(name: &str, expected: T, actual: T) -> Check {
        Check::new(
            name,
            expected == actual,
            format!("expected {expected:?}, got {actual:?}"),
        )
    }

    /// `actual` is no more than `limit`.
    pub fn at_most(name: &str, limit: u64, actual: u64) -> Check {
        Check::new(
            name,
            actual <= limit,
            format!("at most {limit}, got {actual}"),
        )
    }
}
```

`src/metrics.rs`, above its tests:

```rust
//! What the clients measure: a latency histogram per route and a count of
//! errors by class. A class is the route and what went wrong, so a run's
//! report says `facts:http_5xx` or `facts:net_timeout`, never just "errors".

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use serde_json::Value;

use crate::histogram::Histogram;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Route {
    Facts,
    CodeCheck,
    DeviceShifts,
    SsccBlock,
    Enter,
    Other,
}

impl Route {
    pub fn label(self) -> &'static str {
        match self {
            Route::Facts => "facts",
            Route::CodeCheck => "code_check",
            Route::DeviceShifts => "device_shifts",
            Route::SsccBlock => "sscc_block",
            Route::Enter => "enter",
            Route::Other => "other",
        }
    }
}

/// What went wrong with one request, or `None` when nothing did: a 5xx, a 4xx
/// with the code the host named, or a failure to get an answer at all.
pub fn error_class(status: Option<u16>, body: &Value, net: Option<&str>) -> Option<String> {
    if let Some(net) = net {
        return Some(format!("net_{net}"));
    }
    match status {
        Some(200..=299) | None => None,
        Some(500..=599) => Some("http_5xx".to_owned()),
        Some(_) => {
            let code = body
                .pointer("/error/code")
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            Some(format!("http_4xx:{code}"))
        }
    }
}

#[derive(Default)]
pub struct Metrics {
    latency: Mutex<BTreeMap<&'static str, Histogram>>,
    errors: Mutex<BTreeMap<String, u64>>,
    during_backup: AtomicBool,
}

impl Metrics {
    pub fn new() -> Self {
        Self::default()
    }

    /// While set, the facts route is also counted under `facts_during_backup`.
    pub fn set_backup_running(&self, on: bool) {
        self.during_backup.store(on, Ordering::SeqCst);
    }

    pub fn record(&self, route: Route, micros: u64) {
        let mut latency = self.latency.lock().expect("metrics lock");
        latency.entry(route.label()).or_default().record(micros);
        if route == Route::Facts && self.during_backup.load(Ordering::SeqCst) {
            latency
                .entry("facts_during_backup")
                .or_default()
                .record(micros);
        }
    }

    pub fn error(&self, route: Route, class: &str) {
        let mut errors = self.errors.lock().expect("metrics lock");
        *errors
            .entry(format!("{}:{class}", route.label()))
            .or_default() += 1;
    }

    pub fn latency(&self) -> BTreeMap<&'static str, Histogram> {
        self.latency.lock().expect("metrics lock").clone()
    }

    pub fn errors(&self) -> BTreeMap<String, u64> {
        self.errors.lock().expect("metrics lock").clone()
    }
}
```

`src/api.rs` (the whole file):

```rust
//! The HTTPS client of a simulated device or of the office: one TLS session
//! each, trusting exactly the host's certificate fingerprint as a paired
//! device does, a 10 s timeout as the station shell's client has, and every
//! answer counted in the run's metrics.

use std::sync::Arc;
use std::time::{Duration, Instant};

use reqwest::Method;
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{verify_tls12_signature, verify_tls13_signature, CryptoProvider};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{DigitallySignedStruct, SignatureScheme};
use serde_json::Value;

use crate::metrics::{error_class, Metrics, Route};

/// The station shell's own limit for a request to the host.
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug)]
struct PinnedVerifier {
    expected: String,
    provider: Arc<CryptoProvider>,
}

impl ServerCertVerifier for PinnedVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        if markiro_proto::certificate_fingerprint(end_entity.as_ref()) == self.expected {
            Ok(ServerCertVerified::assertion())
        } else {
            Err(rustls::Error::General(
                "host certificate fingerprint mismatch".into(),
            ))
        }
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls12_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls13_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider
            .signature_verification_algorithms
            .supported_schemes()
    }
}

pub fn pinned_client(fingerprint: &str, timeout: Duration) -> reqwest::Client {
    let provider = Arc::new(rustls::crypto::aws_lc_rs::default_provider());
    let config = rustls::ClientConfig::builder_with_provider(provider.clone())
        .with_safe_default_protocol_versions()
        .expect("the default protocol versions")
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(PinnedVerifier {
            expected: fingerprint.to_owned(),
            provider,
        }))
        .with_no_client_auth();
    reqwest::Client::builder()
        .use_preconfigured_tls(config)
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(timeout)
        .build()
        .expect("a client")
}

/// A request that got no answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NetError {
    Timeout,
    Connect,
    Other(String),
}

impl NetError {
    pub fn class(&self) -> &'static str {
        match self {
            NetError::Timeout => "timeout",
            NetError::Connect => "connect",
            NetError::Other(_) => "other",
        }
    }
}

#[derive(Debug, Clone)]
pub struct Reply {
    pub status: u16,
    pub body: Value,
    pub micros: u64,
}

impl Reply {
    pub fn ok(&self) -> bool {
        (200..300).contains(&self.status)
    }
}

/// The credentials of a request: a device key, and the office session when
/// the route is the office's.
#[derive(Debug, Clone, Copy, Default)]
pub struct Auth<'a> {
    pub device_key: Option<&'a str>,
    pub session: Option<&'a str>,
}

#[derive(Clone)]
pub struct Api {
    client: reqwest::Client,
    base: String,
    metrics: Arc<Metrics>,
}

impl Api {
    pub fn new(base: &str, fingerprint: &str, metrics: Arc<Metrics>) -> Api {
        Api {
            client: pinned_client(fingerprint, REQUEST_TIMEOUT),
            base: base.trim_end_matches('/').to_owned(),
            metrics,
        }
    }

    pub fn metrics(&self) -> &Arc<Metrics> {
        &self.metrics
    }

    /// `POST /v1/device/facts` with `records`: the receipts, in order. Any
    /// answer but a 200 with a receipt for each record is an error.
    pub async fn facts(&self, key: &str, records: &[Value]) -> Result<Vec<Value>, String> {
        let auth = Auth {
            device_key: Some(key),
            session: None,
        };
        let body = serde_json::json!({ "records": records });
        let reply = self
            .send(Route::Facts, "POST", "/v1/device/facts", auth, Some(&body))
            .await
            .map_err(|error| format!("facts: {error:?}"))?;
        let receipts = reply
            .body
            .get("receipts")
            .and_then(Value::as_array)
            .cloned();
        match receipts {
            Some(receipts) if reply.status == 200 && receipts.len() == records.len() => {
                Ok(receipts)
            }
            _ => Err(format!("facts: {} {}", reply.status, reply.body)),
        }
    }

    /// A long GET (the change stream): no 10 s limit, nothing counted.
    pub async fn open_stream(
        &self,
        path: &str,
        auth: Auth<'_>,
    ) -> Result<reqwest::Response, NetError> {
        let mut request = self
            .client
            .get(format!("{}{path}", self.base))
            .timeout(Duration::from_secs(24 * 3600))
            .header(
                markiro_proto::PROTOCOL_HEADER,
                markiro_proto::PROTOCOL_VERSION.to_string(),
            );
        if let Some(key) = auth.device_key {
            request = request.header("authorization", format!("Bearer {key}"));
        }
        request.send().await.map_err(|error| {
            if error.is_connect() {
                NetError::Connect
            } else {
                NetError::Other(error.without_url().to_string())
            }
        })
    }

    /// One request. A network failure is counted and returned; an answer of
    /// any status is counted by class and returned for the caller to judge.
    pub async fn send(
        &self,
        route: Route,
        method: &str,
        path: &str,
        auth: Auth<'_>,
        body: Option<&Value>,
    ) -> Result<Reply, NetError> {
        let method = Method::from_bytes(method.as_bytes()).expect("an HTTP method");
        let mut request = self
            .client
            .request(method, format!("{}{path}", self.base))
            .header(
                markiro_proto::PROTOCOL_HEADER,
                markiro_proto::PROTOCOL_VERSION.to_string(),
            );
        if let Some(key) = auth.device_key {
            request = request.header("authorization", format!("Bearer {key}"));
        }
        if let Some(session) = auth.session {
            request = request.header(markiro_proto::OFFICE_SESSION_HEADER, session);
        }
        if let Some(body) = body {
            request = request.json(body);
        }
        let started = Instant::now();
        let outcome = async {
            let response = request.send().await?;
            let status = response.status().as_u16();
            let bytes = response.bytes().await?;
            Ok::<_, reqwest::Error>((status, bytes))
        }
        .await;
        let micros = started.elapsed().as_micros() as u64;
        match outcome {
            Ok((status, bytes)) => {
                let body = if bytes.is_empty() {
                    Value::Null
                } else {
                    serde_json::from_slice(&bytes).unwrap_or(Value::Null)
                };
                self.metrics.record(route, micros);
                if let Some(class) = error_class(Some(status), &body, None) {
                    self.metrics.error(route, &class);
                }
                Ok(Reply {
                    status,
                    body,
                    micros,
                })
            }
            Err(error) => {
                let net = if error.is_timeout() {
                    NetError::Timeout
                } else if error.is_connect() {
                    NetError::Connect
                } else {
                    NetError::Other(error.without_url().to_string())
                };
                if net == NetError::Timeout {
                    // A timeout is a latency of the whole limit, or p99 would hide it.
                    self.metrics.record(route, micros);
                }
                self.metrics.error(route, net.class());
                Err(net)
            }
        }
    }
}
```

- [ ] **Step 4: Run the tests to verify they pass.**

Run: `cargo --offline --locked test --manifest-path "$WT/apps/standalone/Cargo.toml" -p markiro-loadtest --lib -- checks:: metrics::`
Expected: PASS, 4 tests (checks 1, metrics 3).

- [ ] **Step 5: Format and commit.**

Run: `cargo fmt --manifest-path "$WT/apps/standalone/Cargo.toml" --all -- --check` (clean).

```bash
git -C "$WT" add apps/standalone/loadtest/src/lib.rs \
  apps/standalone/loadtest/src/checks.rs \
  apps/standalone/loadtest/src/metrics.rs \
  apps/standalone/loadtest/src/api.rs
git -C "$WT" commit -m "feat(standalone): load test checks, per-route metrics and the pinned HTTPS client

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: The host's vital signs (WAL backlog, memory and descriptors, the series)

**Files:**

- Create: `apps/standalone/loadtest/src/wal.rs`, `apps/standalone/loadtest/src/procstat.rs`, `apps/standalone/loadtest/src/sampler.rs`
- Modify: `apps/standalone/loadtest/src/lib.rs`

**Interfaces:**

- Consumes: nothing from earlier tasks.
- Produces: `wal::backlog(shm: &[u8]) -> Option<u64>` (`mxFrame - nBackfill` of the wal-index header; `None` for a short, uninitialised or torn read); `procstat::ProcSample { rss_bytes, fds }`, `procstat::sample(pid: u32) -> Option<ProcSample>` (Linux `/proc`, macOS `ps` and `lsof`, Windows PowerShell), `procstat::slope_per_hour(points: &[(f64, f64)]) -> f64`, `rss_from_proc_status`, `rss_from_ps`; `sampler::Sample { t_s, rss_bytes, fds, db_bytes, wal_bytes, wal_backlog_frames }` (serde), `sampler::take(t_s, data_dir, pid) -> Sample`, `sampler::run(data_dir: Option<PathBuf>, pid: Option<u32>, every: Duration, stop: watch::Receiver<bool>) -> Vec<Sample>` (the first sample at once, the last after the stop).

The wal-index layout (SQLite `wal.c`, native byte order): `WalIndexHdr` is 48 bytes written twice back to back (`isInit` at 12, `mxFrame` at 16), and `WalCkptInfo` follows at 96 with `nBackfill` first. A test builds such a header by hand; Task 17 checks that a real host's backlog is readable (not null) in a child-process run.

- [ ] **Step 1: Write the failing tests.** `src/lib.rs`:

```rust
pub mod api;
pub mod checks;
pub mod gen;
pub mod histogram;
pub mod metrics;
pub mod procstat;
pub mod profile;
pub mod rng;
pub mod sampler;
pub mod wal;
```

`src/wal.rs` (tests only):

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn header(frames: u32, copied: u32) -> Vec<u8> {
        let mut bytes = vec![0u8; 136];
        bytes[12] = 1;
        bytes[16..20].copy_from_slice(&frames.to_ne_bytes());
        let copy: Vec<u8> = bytes[..48].to_vec();
        bytes[48..96].copy_from_slice(&copy);
        bytes[96..100].copy_from_slice(&copied.to_ne_bytes());
        bytes
    }

    #[test]
    fn the_backlog_is_the_frames_no_checkpoint_has_copied() {
        assert_eq!(backlog(&header(1200, 1000)), Some(200));
        assert_eq!(backlog(&header(0, 0)), Some(0));
        // A checkpoint that read the header after the log restarted.
        assert_eq!(backlog(&header(10, 50)), Some(0));
    }

    #[test]
    fn a_torn_a_short_or_an_unset_header_is_not_a_number() {
        let mut torn = header(1200, 1000);
        torn[16] ^= 0xFF;
        assert_eq!(backlog(&torn), None);
        assert_eq!(backlog(&[0u8; 50]), None);
        let mut fresh = header(5, 0);
        fresh[12] = 0;
        let copy: Vec<u8> = fresh[..48].to_vec();
        fresh[48..96].copy_from_slice(&copy);
        assert_eq!(backlog(&fresh), None);
    }
}
```

`src/procstat.rs` (tests only):

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn memory_is_read_from_the_text_of_the_platform() {
        let status = "Name:\tmarkiro-host\nVmPeak:\t  900 kB\nVmRSS:\t  20480 kB\nThreads:\t9\n";
        assert_eq!(rss_from_proc_status(status), Some(20_480 * 1024));
        assert_eq!(rss_from_proc_status("Name:\tx\n"), None);
        assert_eq!(rss_from_ps("  51200\n"), Some(51_200 * 1024));
        assert_eq!(rss_from_ps("nope"), None);
    }

    #[test]
    fn a_slope_is_per_hour_and_flat_for_a_flat_series() {
        // 10 MiB every ten minutes: 60 MiB an hour.
        let growing: Vec<(f64, f64)> = (0..7)
            .map(|i| (i as f64 * 600.0, i as f64 * 10.0))
            .collect();
        assert!((slope_per_hour(&growing) - 60.0).abs() < 1e-9);
        let flat: Vec<(f64, f64)> = (0..7).map(|i| (i as f64 * 600.0, 42.0)).collect();
        assert_eq!(slope_per_hour(&flat), 0.0);
        assert_eq!(slope_per_hour(&[(1.0, 5.0)]), 0.0);
        assert_eq!(slope_per_hour(&[(1.0, 5.0), (1.0, 9.0)]), 0.0);
    }

    #[test]
    fn this_process_can_be_sampled_where_the_platform_allows_it() {
        match sample(std::process::id()) {
            Some(sample) => {
                assert!(sample.rss_bytes > 1024 * 1024);
                assert!(sample.fds > 2);
            }
            // `ps` and `lsof` may be refused (a sandbox); `/proc` and
            // PowerShell are not.
            None if cfg!(any(target_os = "linux", windows)) => panic!("no sample of this process"),
            None => eprintln!("skipped: ps or lsof refused on this machine"),
        }
    }
}
```

`src/sampler.rs` (tests only):

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_sample_of_a_folder_reads_sizes_and_the_backlog() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("host.db"), vec![0u8; 4096]).unwrap();
        std::fs::write(dir.path().join("host.db-wal"), vec![0u8; 8192]).unwrap();
        let mut shm = vec![0u8; 136];
        shm[12] = 1;
        shm[16..20].copy_from_slice(&30u32.to_ne_bytes());
        let copy: Vec<u8> = shm[..48].to_vec();
        shm[48..96].copy_from_slice(&copy);
        shm[96..100].copy_from_slice(&10u32.to_ne_bytes());
        std::fs::write(dir.path().join("host.db-shm"), shm).unwrap();
        let sample = take(1.5, Some(dir.path()), None);
        assert_eq!(
            (sample.db_bytes, sample.wal_bytes, sample.wal_backlog_frames),
            (Some(4096), Some(8192), Some(20))
        );
        assert_eq!((sample.rss_bytes, sample.fds), (None, None));
    }

    #[tokio::test]
    async fn the_series_has_both_ends_and_stops_on_request() {
        let (stop, watching) = watch::channel(false);
        let task = tokio::spawn(run(None, None, Duration::from_millis(20), watching));
        tokio::time::sleep(Duration::from_millis(70)).await;
        stop.send_replace(true);
        let series = task.await.unwrap();
        assert!(series.len() >= 3, "{}", series.len());
        assert!(series.windows(2).all(|pair| pair[0].t_s <= pair[1].t_s));
    }
}
```

- [ ] **Step 2: Run them to verify they fail.**

Run: `cargo --offline --locked test --manifest-path "$WT/apps/standalone/Cargo.toml" -p markiro-loadtest --lib -- wal:: procstat:: sampler::`
Expected: FAIL to compile (`cannot find function backlog`, `sample`, `take`).

- [ ] **Step 3: Write the implementation.** `src/wal.rs`, above its tests:

```rust
//! The wal-index header of SQLite (`host.db-shm`): how many frames of the
//! write-ahead log no checkpoint has copied into the database yet. The file
//! is read from outside the host without a lock, so a torn read (the two
//! copies of the header differ) answers `None` and the caller reads again.
//!
//! Layout (sqlite `wal.c`, native byte order): `WalIndexHdr` is 48 bytes
//! written twice back to back (`iVersion`, unused, `iChange`, `isInit`,
//! `bigEndCksum`, `szPage`, `mxFrame` at 16, `nPage`, checksums and salts);
//! `WalCkptInfo` follows at 96 and starts with `nBackfill`.

pub const MIN_LEN: usize = 100;

fn word(bytes: &[u8], at: usize) -> u32 {
    u32::from_ne_bytes(bytes[at..at + 4].try_into().expect("four bytes"))
}

/// `mxFrame - nBackfill`, or `None` for a file too short, not initialised or
/// read in the middle of a write.
pub fn backlog(shm: &[u8]) -> Option<u64> {
    if shm.len() < MIN_LEN || shm[12] == 0 {
        return None;
    }
    if shm[..48] != shm[48..96] {
        return None;
    }
    let frames = word(shm, 16);
    let copied = word(shm, 96);
    Some(u64::from(frames.saturating_sub(copied)))
}
```

`src/procstat.rs`, above its tests:

```rust
//! The memory and the open descriptors of the host process, and the slope of
//! a series: how fast a number grows over a run (a leak shows as a slope, a
//! warm-up as a step).

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProcSample {
    pub rss_bytes: u64,
    pub fds: u64,
}

/// The resident memory in bytes from the text of `/proc/<pid>/status`.
pub fn rss_from_proc_status(text: &str) -> Option<u64> {
    let line = text.lines().find(|line| line.starts_with("VmRSS:"))?;
    let kib: u64 = line.split_whitespace().nth(1)?.parse().ok()?;
    Some(kib * 1024)
}

/// The resident memory in bytes from `ps -o rss=` (KiB).
pub fn rss_from_ps(text: &str) -> Option<u64> {
    text.trim().parse::<u64>().ok().map(|kib| kib * 1024)
}

#[cfg(target_os = "linux")]
pub fn sample(pid: u32) -> Option<ProcSample> {
    let status = std::fs::read_to_string(format!("/proc/{pid}/status")).ok()?;
    let fds = std::fs::read_dir(format!("/proc/{pid}/fd")).ok()?.count() as u64;
    Some(ProcSample {
        rss_bytes: rss_from_proc_status(&status)?,
        fds,
    })
}

#[cfg(target_os = "macos")]
pub fn sample(pid: u32) -> Option<ProcSample> {
    let run = |program: &str, args: &[&str]| {
        let output = std::process::Command::new(program)
            .args(args)
            .output()
            .ok()?;
        output
            .status
            .success()
            .then(|| String::from_utf8_lossy(&output.stdout).into_owned())
    };
    let pid_text = pid.to_string();
    let rss = rss_from_ps(&run("ps", &["-o", "rss=", "-p", &pid_text])?)?;
    let listing = run("lsof", &["-p", &pid_text])?;
    // The first line names the columns.
    let fds = listing.lines().count().saturating_sub(1) as u64;
    Some(ProcSample {
        rss_bytes: rss,
        fds,
    })
}

#[cfg(windows)]
pub fn sample(pid: u32) -> Option<ProcSample> {
    let script = format!("$p = Get-Process -Id {pid}; \"$($p.WorkingSet64) $($p.HandleCount)\"");
    let output = std::process::Command::new("powershell")
        .args(["-NoProfile", "-Command", &script])
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&output.stdout).into_owned();
    let mut parts = text.split_whitespace();
    Some(ProcSample {
        rss_bytes: parts.next()?.parse().ok()?,
        fds: parts.next()?.parse().ok()?,
    })
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
pub fn sample(_pid: u32) -> Option<ProcSample> {
    None
}

/// The least-squares slope of `points` (seconds, value) in value units per
/// hour; 0 for fewer than two points or no spread in time.
pub fn slope_per_hour(points: &[(f64, f64)]) -> f64 {
    if points.len() < 2 {
        return 0.0;
    }
    let n = points.len() as f64;
    let mean_t = points.iter().map(|(t, _)| t).sum::<f64>() / n;
    let mean_v = points.iter().map(|(_, v)| v).sum::<f64>() / n;
    let spread: f64 = points.iter().map(|(t, _)| (t - mean_t).powi(2)).sum();
    if spread == 0.0 {
        return 0.0;
    }
    let covariance: f64 = points
        .iter()
        .map(|(t, v)| (t - mean_t) * (v - mean_v))
        .sum();
    covariance / spread * 3600.0
}
```

`src/sampler.rs`, above its tests:

```rust
//! The host's vital signs over the run, one sample every few seconds: its
//! memory and descriptors (a host the harness started, or one whose pid it
//! was given), the size of the database and of its write-ahead log, and the
//! log's backlog of frames no checkpoint has copied yet.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tokio::sync::watch;

use crate::procstat;
use crate::wal;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Sample {
    pub t_s: f64,
    pub rss_bytes: Option<u64>,
    pub fds: Option<u64>,
    pub db_bytes: Option<u64>,
    pub wal_bytes: Option<u64>,
    pub wal_backlog_frames: Option<u64>,
}

fn size(path: &Path) -> Option<u64> {
    std::fs::metadata(path).ok().map(|meta| meta.len())
}

/// A sample now. The backlog is read twice at most: a torn read is read again.
pub fn take(t_s: f64, data_dir: Option<&Path>, pid: Option<u32>) -> Sample {
    let process = pid.and_then(procstat::sample);
    let (db_bytes, wal_bytes, backlog) = match data_dir {
        Some(dir) => {
            let db = dir.join("host.db");
            let shm = dir.join("host.db-shm");
            let read = || {
                std::fs::read(&shm)
                    .ok()
                    .and_then(|bytes| wal::backlog(&bytes))
            };
            (
                size(&db),
                size(&dir.join("host.db-wal")),
                read().or_else(read),
            )
        }
        None => (None, None, None),
    };
    Sample {
        t_s,
        rss_bytes: process.map(|sample| sample.rss_bytes),
        fds: process.map(|sample| sample.fds),
        db_bytes,
        wal_bytes,
        wal_backlog_frames: backlog,
    }
}

/// Sample every `every` until `stop` turns true; the first sample is taken at
/// once and the last after the stop, so a series always has both ends.
pub async fn run(
    data_dir: Option<PathBuf>,
    pid: Option<u32>,
    every: Duration,
    mut stop: watch::Receiver<bool>,
) -> Vec<Sample> {
    let started = Instant::now();
    let mut series = Vec::new();
    loop {
        let (dir, at) = (data_dir.clone(), started.elapsed().as_secs_f64());
        // `ps`, `lsof` and a file read block a little: not on the async threads.
        if let Ok(sample) = tokio::task::spawn_blocking(move || take(at, dir.as_deref(), pid)).await
        {
            series.push(sample);
        }
        tokio::select! {
            _ = tokio::time::sleep(every) => {}
            _ = stop.changed() => break,
        }
        if *stop.borrow() {
            break;
        }
    }
    let (dir, at) = (data_dir, started.elapsed().as_secs_f64());
    if let Ok(sample) = tokio::task::spawn_blocking(move || take(at, dir.as_deref(), pid)).await {
        series.push(sample);
    }
    series
}
```

- [ ] **Step 4: Run the tests to verify they pass.**

Run: `cargo --offline --locked test --manifest-path "$WT/apps/standalone/Cargo.toml" -p markiro-loadtest --lib -- wal:: procstat:: sampler::`
Expected: PASS, 7 tests (wal 2, procstat 3, sampler 2). On macOS inside a sandbox that refuses `ps`, `this_process_can_be_sampled_where_the_platform_allows_it` prints `skipped: ps or lsof refused on this machine` and passes; on Linux and Windows it must find a sample.

- [ ] **Step 5: Format and commit.**

Run: `cargo fmt --manifest-path "$WT/apps/standalone/Cargo.toml" --all -- --check` (clean).

```bash
git -C "$WT" add apps/standalone/loadtest/src/lib.rs \
  apps/standalone/loadtest/src/wal.rs \
  apps/standalone/loadtest/src/procstat.rs \
  apps/standalone/loadtest/src/sampler.rs
git -C "$WT" commit -m "feat(standalone): load test host samples (WAL backlog, memory, descriptors)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: The host under test

**Files:**

- Create: `apps/standalone/loadtest/src/host.rs`
- Modify: `apps/standalone/loadtest/src/lib.rs`

**Interfaces:**

- Consumes: `api::pinned_client`; `markiro_host::{start, RunningHost, StartOptions}`, `markiro_host::config::HostPaths`, `markiro_host::tls::TlsIdentity`.
- Produces: `host::Error` (a boxed error); `host::Host { base, fingerprint, data_dir: Option<PathBuf>, pid: Option<u32>, local: bool }` with `Host::in_process(data_dir: &Path) -> Result<Host, Error>` (loopback, a port of its own), `Host::spawned(bin: &Path, data_dir: &Path, log: &Path) -> Result<Host, Error>` (`bin run --data-dir … --port <free port>`, output in `log`, ready when `/v1/hello` answers), `Host::attached(base, fingerprint, data_dir, pid) -> Host`, `log_scan(&self) -> LogScan`, `stop(&mut self) -> Result<bool, Error>` (`true` when the host ended on its own after SIGINT; on Windows there is no SIGINT: the process is killed and the answer is `false`); `host::LogScan { available, error_lines, busy_lines, first_errors }`, `host::scan_log(text) -> LogScan`, `host::is_busy_line(line) -> bool`.

- [ ] **Step 1: Write the failing tests.** `src/lib.rs`:

```rust
pub mod api;
pub mod checks;
pub mod gen;
pub mod histogram;
pub mod host;
pub mod metrics;
pub mod procstat;
pub mod profile;
pub mod rng;
pub mod sampler;
pub mod wal;
```

`src/host.rs` (tests only):

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_log_scan_counts_errors_and_the_lines_that_name_a_busy_database() {
        let log = "\
2026-10-20T10:00:00Z  INFO markiro_host: markiro-host listening\n\
2026-10-20T10:00:01Z ERROR markiro_host::error: request failed error=error returned from database: (code: 5) database is locked\n\
2026-10-20T10:00:02Z ERROR markiro_host::routes::facts: a fact batch failed device=d position=3\n\
2026-10-20T10:00:03Z  WARN markiro_host::facts: a fact was rejected\n";
        let scan = scan_log(log);
        assert_eq!(
            (scan.available, scan.error_lines, scan.busy_lines),
            (true, 2, 1)
        );
        assert_eq!(scan.first_errors.len(), 2);
        assert!(!is_busy_line("an ordinary line"));
        assert!(is_busy_line("SQLITE_BUSY: the database file is locked"));
    }

    #[tokio::test]
    async fn a_host_in_this_process_answers_hello_and_stops() {
        let dir = tempfile::tempdir().unwrap();
        let mut host = Host::in_process(dir.path()).await.unwrap();
        let client = pinned_client(&host.fingerprint, Duration::from_secs(5));
        let response = client
            .get(format!("{}/v1/hello", host.base))
            .send()
            .await
            .unwrap();
        assert!(response.status().is_success());
        assert!(host.stop().await.unwrap());
    }
}
```

- [ ] **Step 2: Run them to verify they fail.**

Run: `cargo --offline --locked test --manifest-path "$WT/apps/standalone/Cargo.toml" -p markiro-loadtest --lib -- host::`
Expected: FAIL to compile (`cannot find function scan_log`, `Host`).

- [ ] **Step 3: Write the implementation** above the tests module in `src/host.rs`:

```rust
//! The host under test, in one of three ways: in this process (the harness's
//! own tests: no memory figure, no log), as a child process of the real
//! `markiro-host` binary (the runs that count: its memory and descriptors are
//! its own, and `run` writes the log the busy-line scan reads), or a host
//! somebody else started (attach: the harness only talks to it).

use std::net::{Ipv4Addr, SocketAddr, TcpListener};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use markiro_host::config::HostPaths;
use markiro_host::{RunningHost, StartOptions};
use serde::{Deserialize, Serialize};

use crate::api::pinned_client;

pub type Error = Box<dyn std::error::Error + Send + Sync>;

enum Process {
    InProcess(RunningHost),
    Spawned { child: Child, log: PathBuf },
    Attached,
}

pub struct Host {
    pub base: String,
    pub fingerprint: String,
    pub data_dir: Option<PathBuf>,
    pub pid: Option<u32>,
    /// A host on this machine: the first station pairs locally.
    pub local: bool,
    process: Process,
}

/// What the host's own log says of the run.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogScan {
    pub available: bool,
    pub error_lines: u64,
    pub busy_lines: u64,
    pub first_errors: Vec<String>,
}

/// Whether a log line tells that SQLite refused to wait for a lock.
pub fn is_busy_line(line: &str) -> bool {
    let lower = line.to_lowercase();
    lower.contains("database is locked")
        || lower.contains("database table is locked")
        || lower.contains("sqlite_busy")
        || lower.contains("(code: 5)")
        || lower.contains("(code: 6)")
}

pub fn scan_log(text: &str) -> LogScan {
    let mut scan = LogScan {
        available: true,
        ..LogScan::default()
    };
    for line in text.lines() {
        if line.contains(" ERROR ") {
            scan.error_lines += 1;
            if scan.first_errors.len() < 5 {
                scan.first_errors.push(line.chars().take(300).collect());
            }
        }
        if is_busy_line(line) {
            scan.busy_lines += 1;
        }
    }
    scan
}

async fn wait_ready(base: &str, fingerprint: &str, limit: Duration) -> Result<(), Error> {
    let client = pinned_client(fingerprint, Duration::from_secs(2));
    let started = Instant::now();
    loop {
        if let Ok(response) = client.get(format!("{base}/v1/hello")).send().await {
            if response.status().is_success() {
                return Ok(());
            }
        }
        if started.elapsed() > limit {
            return Err("the host did not answer /v1/hello in time".into());
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

impl Host {
    /// The host in this process on a loopback port of its own.
    pub async fn in_process(data_dir: &Path) -> Result<Host, Error> {
        let running = markiro_host::start(
            &HostPaths::new(data_dir),
            StartOptions {
                port_override: None,
                bind: Some(SocketAddr::from((Ipv4Addr::LOCALHOST, 0))),
            },
        )
        .await?;
        Ok(Host {
            base: format!("https://127.0.0.1:{}", running.addr.port()),
            fingerprint: running.fingerprint.clone(),
            data_dir: Some(data_dir.to_path_buf()),
            pid: None,
            local: true,
            process: Process::InProcess(running),
        })
    }

    /// `bin run --data-dir <data_dir> --port <free port>` with its output in
    /// `log`. The command line binds every interface (it has no flag for
    /// less), for as long as the run lasts: run it on a machine you trust.
    pub async fn spawned(bin: &Path, data_dir: &Path, log: &Path) -> Result<Host, Error> {
        let port = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?
            .local_addr()?
            .port();
        let out = std::fs::File::create(log)?;
        let child = Command::new(bin)
            .args(["run", "--data-dir"])
            .arg(data_dir)
            .args(["--port", &port.to_string()])
            .stdin(Stdio::null())
            .stdout(out.try_clone()?)
            .stderr(out)
            .spawn()?;
        let pid = child.id();
        let mut host = Host {
            base: format!("https://127.0.0.1:{port}"),
            fingerprint: String::new(),
            data_dir: Some(data_dir.to_path_buf()),
            pid: Some(pid),
            local: true,
            process: Process::Spawned {
                child,
                log: log.to_path_buf(),
            },
        };
        // The identity appears when the host has started; read it from disk.
        let paths = HostPaths::new(data_dir);
        let started = Instant::now();
        let fingerprint = loop {
            if let Ok(identity) = markiro_host::tls::TlsIdentity::load(&paths.tls_dir()) {
                break identity.fingerprint;
            }
            if started.elapsed() > Duration::from_secs(60) {
                host.stop().await.ok();
                return Err("the host wrote no TLS identity in 60 s".into());
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        };
        host.fingerprint = fingerprint;
        wait_ready(&host.base, &host.fingerprint, Duration::from_secs(60)).await?;
        Ok(host)
    }

    /// A host that runs already: `base` is `https://host:port`.
    pub fn attached(
        base: &str,
        fingerprint: &str,
        data_dir: Option<PathBuf>,
        pid: Option<u32>,
    ) -> Host {
        Host {
            base: base.trim_end_matches('/').to_owned(),
            fingerprint: fingerprint.to_owned(),
            data_dir,
            pid,
            local: false,
            process: Process::Attached,
        }
    }

    /// The host's log so far (a spawned host only).
    pub fn log_scan(&self) -> LogScan {
        match &self.process {
            Process::Spawned { log, .. } => std::fs::read_to_string(log)
                .map(|text| scan_log(&text))
                .unwrap_or_default(),
            _ => LogScan::default(),
        }
    }

    /// Stop what this harness started; `true` when it ended by itself on a
    /// request to stop (SIGINT on Unix; Windows has none: the process is
    /// killed and the database recovers its log on the next start).
    pub async fn stop(&mut self) -> Result<bool, Error> {
        match std::mem::replace(&mut self.process, Process::Attached) {
            Process::InProcess(running) => {
                running.stop().await?;
                Ok(true)
            }
            Process::Spawned { mut child, log } => {
                let asked = ask_to_stop(&child);
                let started = Instant::now();
                let graceful = loop {
                    if let Some(status) = child.try_wait()? {
                        break asked && status.success();
                    }
                    if started.elapsed() > Duration::from_secs(30) {
                        child.kill().ok();
                        child.wait().ok();
                        break false;
                    }
                    tokio::time::sleep(Duration::from_millis(100)).await;
                };
                self.process = Process::Spawned { child, log };
                Ok(graceful)
            }
            Process::Attached => Ok(false),
        }
    }
}

#[cfg(unix)]
fn ask_to_stop(child: &Child) -> bool {
    Command::new("kill")
        .args(["-INT", &child.id().to_string()])
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn ask_to_stop(_child: &Child) -> bool {
    false
}
```

- [ ] **Step 4: Run the tests to verify they pass** (the second test starts a host on a loopback socket: sandbox disabled if the sandbox refuses `listen`).

Run: `cargo --offline --locked test --manifest-path "$WT/apps/standalone/Cargo.toml" -p markiro-loadtest --lib -- host::`
Expected: PASS, 2 tests.

- [ ] **Step 5: Format and commit.**

Run: `cargo fmt --manifest-path "$WT/apps/standalone/Cargo.toml" --all -- --check` (clean).

```bash
git -C "$WT" add apps/standalone/loadtest/src/lib.rs \
  apps/standalone/loadtest/src/host.rs
git -C "$WT" commit -m "feat(standalone): load test host launcher (in process, child, attached) and log scan

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Making the site

**Files:**

- Create: `apps/standalone/loadtest/src/site.rs`
- Modify: `apps/standalone/loadtest/src/lib.rs`

**Interfaces:**

- Consumes: `api::{Api, Auth, Reply}`, `host::Host`, `metrics::{Metrics, Route}`, `profile::Profile`, `rng::Rng`, `gen::GTIN14`, `markiro_proto::DeviceKind`.
- Produces: `site::Res<T> = Result<T, String>`; `site::DeviceSpec { index, kind, id, key, name }` with `is_handheld()` and `supports()` (`["multi-station-v1"]`, handhelds `["handheld-host-v1", "multi-station-v1"]`); `site::Office { api, key, token }` with `call(method, path, body) -> Res<Reply>` and `ok(method, path, body) -> Res<Value>` (the body of a 2xx, else an error naming the answer); `site::AttachCredentials { office_device_key, login, password }`; `site::Site { office, devices, line_id, product_id, box_template_id, pallet_template_id }` (`Clone`); `site::ShiftInfo { id, number, issuer_prefix }`; `site::provision(host: &Host, metrics, profile, attach: Option<AttachCredentials>) -> Res<(Site, ShiftInfo)>`; `site::plan_and_enter(site, profile, planned_qty: Option<u32>) -> Res<ShiftInfo>` (plans a shift on the site's line and has every device enter: the first entry opens it).

What `provision` does, in order: the first station pairs locally (`POST /v1/local-pair`, loopback; a host the harness did not start is attached and uses the office station's key from the environment instead and that station does not work the shift), the wizard runs with a random throwaway administrator password, the SSCC block sizes are set to the profile's (small blocks make the half rule fire; the default 2000 would never be asked for twice), a box template, a pallet template (when the profile has pallets) and the product are created, the line's `maxStations` is set to the number of devices (only when there is more than one), the other stations pair (locally, or by code against an attached host), the handhelds pair by code (`POST /v1/office/pairing-codes`, `POST /v1/pairing/claim`: a claim is limited to 10 a minute from one address, so the tenth claim waits 61 s) and the office puts them on the line (`PUT /v1/office/devices/{id}`), stations choose it themselves (`PUT /v1/device/line`), and `plan_and_enter` plans the shift and enters every device.

- [ ] **Step 1: Write the failing tests.** `src/lib.rs`:

```rust
pub mod api;
pub mod checks;
pub mod gen;
pub mod histogram;
pub mod host;
pub mod metrics;
pub mod procstat;
pub mod profile;
pub mod rng;
pub mod sampler;
pub mod site;
pub mod wal;
```

`src/site.rs` (tests only):

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_station_site_is_made_through_the_hosts_own_routes() {
        let dir = tempfile::tempdir().unwrap();
        let mut host = Host::in_process(dir.path()).await.unwrap();
        let mut profile = Profile::preset("tiny").unwrap();
        profile.stations = 1;
        profile.handhelds = 0;
        let (site, shift) = provision(&host, Arc::new(Metrics::new()), &profile, None)
            .await
            .unwrap();
        assert_eq!(site.devices.len(), 1);
        assert_eq!(shift.issuer_prefix, "460068200");
        assert_eq!(shift.number, "OCT26-001");
        let listed = site
            .office
            .ok("GET", "/v1/office/shifts", None)
            .await
            .unwrap();
        assert_eq!(listed.as_array().map(Vec::len), Some(1));
        host.stop().await.unwrap();
    }

    #[test]
    fn a_device_names_what_it_supports() {
        let spec = |kind| DeviceSpec {
            index: 0,
            kind,
            id: String::new(),
            key: String::new(),
            name: String::new(),
        };
        assert_eq!(
            spec(DeviceKind::Station).supports(),
            vec!["multi-station-v1"]
        );
        assert_eq!(
            spec(DeviceKind::Handheld).supports(),
            vec!["handheld-host-v1", "multi-station-v1"]
        );
    }
}
```

- [ ] **Step 2: Run them to verify they fail.**

Run: `cargo --offline --locked test --manifest-path "$WT/apps/standalone/Cargo.toml" -p markiro-loadtest --lib -- site::`
Expected: FAIL to compile (`cannot find function provision`, `DeviceSpec`).

- [ ] **Step 3: Write the implementation** above the tests module in `src/site.rs`:

```rust
//! Making the site the run works on: the wizard, one product with its
//! templates, small SSCC blocks (so the half rule fires within minutes),
//! the line's limit, the devices (stations and handhelds) paired and put on
//! the line, and a shift every device enters. Everything goes through the
//! host's own routes, as the owner's setup does.

use std::sync::Arc;
use std::time::Duration;

use markiro_proto::DeviceKind;
use serde_json::{json, Value};

use crate::api::{Api, Auth, Reply};
use crate::host::Host;
use crate::metrics::{Metrics, Route};
use crate::profile::Profile;
use crate::rng::Rng;

pub type Res<T> = Result<T, String>;

const STATION_VERSION: &str = "1.1.0";
const HANDHELD_VERSION: &str = "1.2.0";
/// A pairing claim is limited to 10 a minute from one address.
const CLAIMS_PER_MINUTE: u32 = 9;

#[derive(Debug, Clone)]
pub struct DeviceSpec {
    pub index: u32,
    pub kind: DeviceKind,
    pub id: String,
    pub key: String,
    pub name: String,
}

impl DeviceSpec {
    pub fn is_handheld(&self) -> bool {
        self.kind == DeviceKind::Handheld
    }

    /// What the device names in its entry of a shift.
    pub fn supports(&self) -> Vec<&'static str> {
        if self.is_handheld() {
            vec!["handheld-host-v1", "multi-station-v1"]
        } else {
            vec!["multi-station-v1"]
        }
    }
}

/// An administrator's session on the host, through one station's key.
#[derive(Clone)]
pub struct Office {
    pub api: Api,
    pub key: String,
    pub token: String,
}

impl Office {
    pub async fn call(&self, method: &str, path: &str, body: Option<Value>) -> Res<Reply> {
        let auth = Auth {
            device_key: Some(&self.key),
            session: Some(&self.token),
        };
        self.api
            .send(Route::Other, method, path, auth, body.as_ref())
            .await
            .map_err(|error| format!("{method} {path}: {error:?}"))
    }

    /// The body of a 2xx answer; any other answer is an error naming it.
    pub async fn ok(&self, method: &str, path: &str, body: Option<Value>) -> Res<Value> {
        let reply = self.call(method, path, body).await?;
        if reply.ok() {
            Ok(reply.body)
        } else {
            Err(format!("{method} {path}: {} {}", reply.status, reply.body))
        }
    }
}

/// How an attached host is reached: an office station's key and an
/// administrator's login, read from the environment (never the command line).
#[derive(Debug, Clone)]
pub struct AttachCredentials {
    pub office_device_key: String,
    pub login: String,
    pub password: String,
}

#[derive(Clone)]
pub struct Site {
    pub office: Office,
    pub devices: Vec<DeviceSpec>,
    pub line_id: String,
    pub product_id: String,
    pub box_template_id: String,
    pub pallet_template_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShiftInfo {
    pub id: String,
    pub number: String,
    pub issuer_prefix: String,
}

fn str_of<'a>(value: &'a Value, pointer: &str) -> Res<&'a str> {
    value
        .pointer(pointer)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("no {pointer} in {value}"))
}

async fn device_call(
    api: &Api,
    route: Route,
    key: &str,
    method: &str,
    path: &str,
    body: Option<Value>,
) -> Res<Value> {
    let auth = Auth {
        device_key: Some(key),
        session: None,
    };
    let reply = api
        .send(route, method, path, auth, body.as_ref())
        .await
        .map_err(|error| format!("{method} {path}: {error:?}"))?;
    if reply.ok() {
        Ok(reply.body)
    } else {
        Err(format!("{method} {path}: {} {}", reply.status, reply.body))
    }
}

/// A password only this run knows: the site is a throwaway, but the command
/// the host runs under listens on the network for the run's length.
fn throwaway_password(rng: &mut Rng) -> String {
    format!("Load-{:016x}-{:016x}", rng.next_u64(), rng.next_u64())
}

/// A site ready for `profile`: see the module's text.
pub async fn provision(
    host: &Host,
    metrics: Arc<Metrics>,
    profile: &Profile,
    attach: Option<AttachCredentials>,
) -> Res<(Site, ShiftInfo)> {
    let api = Api::new(&host.base, &host.fingerprint, metrics.clone());
    let mut rng = Rng::new(profile.seed ^ 0x51_7E);
    let mut devices = Vec::new();
    // The office station: the first station, which also works the shift when
    // the host is the harness's own.
    let (office_key, token) = match attach {
        Some(credentials) => {
            let session = device_call(
                &api,
                Route::Other,
                &credentials.office_device_key,
                "POST",
                "/v1/office/login",
                Some(json!({ "login": credentials.login, "password": credentials.password })),
            )
            .await?;
            (
                credentials.office_device_key,
                str_of(&session, "/token")?.to_owned(),
            )
        }
        None => {
            let paired = pair_local(&api, "Нагрузка станция 1").await?;
            let password = throwaway_password(&mut rng);
            let body = json!({
                "admin": { "login": "admin", "name": "Нагрузка", "password": password },
                "org": {
                    "name": "ООО «Нагрузка»", "inn": "7707083893", "gln": "4600682000010",
                    "gs1Prefixes": ["4600682"], "timeZone": "Europe/Moscow"
                },
                "sscc": { "boxNextSerial": 1500, "palletNextSerial": 40 },
                "lines": ["Линия 1", "Линия 2"]
            });
            let done = device_call(
                &api,
                Route::Other,
                &paired.key,
                "POST",
                "/v1/bootstrap",
                Some(body),
            )
            .await?;
            let token = str_of(&done, "/session/token")?.to_owned();
            devices.push(paired);
            (devices[0].key.clone(), token)
        }
    };
    let office = Office {
        api: api.clone(),
        key: office_key,
        token,
    };
    // Small blocks: with the default 2000 a device would never ask twice.
    let sscc = office.ok("GET", "/v1/office/sscc", None).await?;
    let rev = sscc
        .get("blockSizesRev")
        .and_then(Value::as_i64)
        .ok_or("no blockSizesRev")?;
    office
        .ok(
            "PUT",
            "/v1/office/sscc/block-sizes",
            Some(json!({
                "boxBlockSize": profile.box_block_size,
                "palletBlockSize": profile.pallet_block_size.max(1),
                "expectedRev": rev
            })),
        )
        .await?;
    let box_template = office
        .ok(
            "POST",
            "/v1/office/templates",
            Some(json!({
                "name": "Короб 58×40", "purpose": "box", "enabled": true,
                "spec": { "widthMm": 58, "heightMm": 40, "dpi": 203, "language": "zpl", "elements": [] }
            })),
        )
        .await?;
    let pallet_template_id = if profile.pallet_boxes > 0 {
        let pallet = office
            .ok(
                "POST",
                "/v1/office/templates",
                Some(json!({
                    "name": "Паллета 100×150", "purpose": "pallet", "enabled": true,
                    "chzProductGroupCodes": null,
                    "spec": { "widthMm": 100, "heightMm": 150, "dpi": 203, "language": "zpl", "elements": [] }
                })),
            )
            .await?;
        Some(str_of(&pallet, "/id")?.to_owned())
    } else {
        None
    };
    let product = office
        .ok(
            "POST",
            "/v1/office/products",
            Some(json!({
                "gtin14": crate::gen::GTIN14, "name": "Молоко 3,2% 0,9 л", "printName": "Молоко 3,2%",
                "chzProductGroupCode": 8, "boxCapacity": profile.box_capacity,
                "palletBoxCapacity": profile.pallet_boxes.max(1), "shelfLifeDays": 10
            })),
        )
        .await?;
    let lines = office.ok("GET", "/v1/office/lines", None).await?;
    let line = lines
        .as_array()
        .and_then(|lines| lines.iter().find(|line| line["name"] == "Линия 1"))
        .ok_or("the wizard made no «Линия 1»")?;
    let line_id = str_of(line, "/id")?.to_owned();
    if profile.devices() > 1 {
        let rev = line
            .get("rev")
            .and_then(Value::as_i64)
            .ok_or("no line rev")?;
        office
            .ok(
                "PUT",
                &format!("/v1/office/lines/{line_id}"),
                Some(json!({ "maxStations": profile.devices(), "expectedRev": rev })),
            )
            .await?;
    }
    // The rest of the devices.
    let mut claims = 0u32;
    while (devices.iter().filter(|d| !d.is_handheld()).count() as u32) < profile.stations {
        let at = devices.len() as u32 + 1;
        let name = format!("Нагрузка станция {at}");
        let spec = if host.local {
            pair_local(&api, &name).await?
        } else {
            claim(&office, DeviceKind::Station, &name, &mut claims).await?
        };
        devices.push(spec);
    }
    for at in 1..=profile.handhelds {
        let name = format!("Нагрузка ТСД {at}");
        devices.push(claim(&office, DeviceKind::Handheld, &name, &mut claims).await?);
    }
    for (index, device) in devices.iter_mut().enumerate() {
        device.index = index as u32;
        if device.is_handheld() {
            office
                .ok(
                    "PUT",
                    &format!("/v1/office/devices/{}", device.id),
                    Some(json!({ "name": device.name, "lineId": line_id })),
                )
                .await?;
        } else {
            device_call(
                &api,
                Route::Other,
                &device.key,
                "PUT",
                "/v1/device/line",
                Some(json!({ "lineId": line_id })),
            )
            .await?;
        }
    }
    let site = Site {
        office,
        devices,
        line_id,
        product_id: str_of(&product, "/id")?.to_owned(),
        box_template_id: str_of(&box_template, "/id")?.to_owned(),
        pallet_template_id,
    };
    let shift = plan_and_enter(&site, profile, None).await?;
    Ok((site, shift))
}

async fn pair_local(api: &Api, name: &str) -> Res<DeviceSpec> {
    let paired = api
        .send(
            Route::Other,
            "POST",
            "/v1/local-pair",
            Auth::default(),
            Some(&json!({ "kind": "station", "name": name, "appVersion": STATION_VERSION })),
        )
        .await
        .map_err(|error| format!("local-pair: {error:?}"))?;
    if !paired.ok() {
        return Err(format!("local-pair: {} {}", paired.status, paired.body));
    }
    Ok(DeviceSpec {
        index: 0,
        kind: DeviceKind::Station,
        id: str_of(&paired.body, "/deviceId")?.to_owned(),
        key: str_of(&paired.body, "/deviceKey")?.to_owned(),
        name: name.to_owned(),
    })
}

/// A device paired with a code from the office, as a handheld always is.
async fn claim(office: &Office, kind: DeviceKind, name: &str, claims: &mut u32) -> Res<DeviceSpec> {
    if *claims > 0 && *claims % CLAIMS_PER_MINUTE == 0 {
        tokio::time::sleep(Duration::from_secs(61)).await;
    }
    *claims += 1;
    let code = office.ok("POST", "/v1/office/pairing-codes", None).await?;
    let (version, capabilities) = match kind {
        DeviceKind::Handheld => (HANDHELD_VERSION, json!(["handheld-host-v1"])),
        _ => (STATION_VERSION, json!([])),
    };
    let paired = office
        .api
        .send(
            Route::Other,
            "POST",
            "/v1/pairing/claim",
            Auth::default(),
            Some(&json!({
                "code": str_of(&code, "/code")?, "kind": kind.as_str(), "name": name,
                "appVersion": version, "capabilities": capabilities
            })),
        )
        .await
        .map_err(|error| format!("claim: {error:?}"))?;
    if !paired.ok() {
        return Err(format!("claim: {} {}", paired.status, paired.body));
    }
    Ok(DeviceSpec {
        index: 0,
        kind,
        id: str_of(&paired.body, "/deviceId")?.to_owned(),
        key: str_of(&paired.body, "/deviceKey")?.to_owned(),
        name: name.to_owned(),
    })
}

/// Plan a shift on the site's line and have every device enter it: the first
/// entry opens it. Used for the run's shift and for each drill's.
pub async fn plan_and_enter(
    site: &Site,
    profile: &Profile,
    planned_qty: Option<u32>,
) -> Res<ShiftInfo> {
    let mut body = json!({
        "productId": site.product_id, "lineId": site.line_id,
        "productionDate": "2026-10-08", "boxTemplateId": site.box_template_id,
        "boxCapacity": profile.box_capacity
    });
    if let Some(template) = &site.pallet_template_id {
        body["palletsEnabled"] = json!(true);
        body["palletTemplateId"] = json!(template);
        body["palletBoxCapacity"] = json!(profile.pallet_boxes);
    }
    if let Some(planned) = planned_qty {
        body["plannedQty"] = json!(planned);
    }
    let shift = site
        .office
        .ok("POST", "/v1/office/shifts", Some(body))
        .await?;
    let id = str_of(&shift, "/id")?.to_owned();
    let number = str_of(&shift, "/number")?.to_owned();
    let mut issuer_prefix = None;
    for device in &site.devices {
        let entered = device_call(
            &site.office.api,
            Route::Enter,
            &device.key,
            "POST",
            &format!("/v1/device/shifts/{id}/enter"),
            Some(json!({ "supports": device.supports() })),
        )
        .await?;
        if let Some(prefix) = entered
            .pointer("/snapshot/issuerPrefix")
            .and_then(Value::as_str)
        {
            issuer_prefix.get_or_insert_with(|| prefix.to_owned());
        }
    }
    let issuer_prefix = issuer_prefix.ok_or("no entry answered a snapshot")?;
    Ok(ShiftInfo {
        id,
        number,
        issuer_prefix,
    })
}
```

- [ ] **Step 4: Run the tests to verify they pass** (the first starts a host on a loopback socket).

Run: `cargo --offline --locked test --manifest-path "$WT/apps/standalone/Cargo.toml" -p markiro-loadtest --lib -- site::`
Expected: PASS, 2 tests. The first test makes a one-station site (it needs nothing of plan 2b) and asserts the shift number `OCT26-001` and the snapshot's issuer prefix `460068200`; the multi-device site is exercised by Task 13's self-test.

- [ ] **Step 5: Format and commit.**

Run: `cargo fmt --manifest-path "$WT/apps/standalone/Cargo.toml" --all -- --check` (clean).

```bash
git -C "$WT" add apps/standalone/loadtest/src/lib.rs \
  apps/standalone/loadtest/src/site.rs
git -C "$WT" commit -m "feat(standalone): load test site provisioning through the host routes

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 8: The ledger and the device engine (no network)

**Files:**

- Create: `apps/standalone/loadtest/src/ledger.rs`, `apps/standalone/loadtest/src/engine.rs`
- Modify: `apps/standalone/loadtest/src/lib.rs`

**Interfaces:**

- Consumes: `gen::{Code, DeviceClock, record, scan_ok, scan_duplicate, box_closed, pallet_closed, sscc}`, `rng::Rng`, `markiro_proto::FactKind`.
- Produces: `ledger::FactMeta { kind, claims: Option<u64> }`; `ledger::Ledger` (`apply(&mut self, device: u32, meta: &FactMeta, receipt: &Value)`, `displacements()`, `expected() -> Expected`, `snapshot() -> Snapshot`); `ledger::Expected { records, scan_rows, distinct_accepted_codes, conflict_receipts, displacements, boxes_closed, pallets_closed, rejected }` (serde); `ledger::Snapshot` (the maps the end-of-run checks read, copied out of the lock); `engine::{Offer, Queued { id, record, meta, code, offer }, Block { id, from, to, next }, EngineCfg, Engine}` with `Engine::{new(cfg, seed), next_code(), fresh_id(), tick(), can_scan(), queue_len(), scan_ok(&Code, Option<Arc<Offer>>), scan_duplicate(&Code), progress(), add_block(extension, Block), topup_request(extension) -> Option<String>, remaining(extension), close_open() -> bool, batch(max), ack(n)}` and the counters `boxes_closed, pallets_closed, scans, pushed, items_in_open_box`.

The rules the engine keeps, as a station's work screen does: a box closes when it holds `box_capacity` items and a serial is at hand; a box on a shift with pallets joins the open pallet, which closes when it holds `pallet_boxes` boxes; a full box or pallet with no serial holds the scanner (`can_scan() == false`) until `add_block` brings one; a block is asked for when less than half of what was issued is left, and the request id stays the same until it is answered (so a repeated request returns the same block); `close_open` closes the partial box and pallet as a station does before closing its part.

- [ ] **Step 1: Write the failing tests.** `src/lib.rs`:

```rust
pub mod api;
pub mod checks;
pub mod engine;
pub mod gen;
pub mod histogram;
pub mod host;
pub mod ledger;
pub mod metrics;
pub mod procstat;
pub mod profile;
pub mod rng;
pub mod sampler;
pub mod site;
pub mod wal;
```

`src/ledger.rs` (tests only):

```rust
#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn scan(claims: Option<u64>) -> FactMeta {
        FactMeta {
            kind: FactKind::Scan,
            claims,
        }
    }

    #[test]
    fn receipts_are_read_by_kind_and_outcome() {
        let mut ledger = Ledger::default();
        ledger.apply(0, &scan(Some(1)), &json!({"outcome": "accepted"}));
        ledger.apply(1, &scan(Some(2)), &json!({"outcome": "accepted"}));
        ledger.apply(1, &scan(Some(1)), &json!({"outcome": "conflict"}));
        ledger.apply(1, &scan(None), &json!({"outcome": "accepted"}));
        ledger.apply(
            0,
            &FactMeta {
                kind: FactKind::BoxClosed,
                claims: None,
            },
            &json!({"outcome": "accepted"}),
        );
        ledger.apply(
            0,
            &scan(Some(3)),
            &json!({"outcome": "rejected", "code": "gtin_mismatch"}),
        );
        let expected = ledger.expected();
        assert_eq!(
            expected,
            Expected {
                records: 6,
                scan_rows: 4,
                distinct_accepted_codes: 2,
                conflict_receipts: 1,
                displacements: 0,
                boxes_closed: 1,
                pallets_closed: 0,
                rejected: 1,
            }
        );
        assert_eq!(ledger.rejected["gtin_mismatch"], 1);
        assert_eq!(ledger.accepted_scans[&1], 1);
    }

    #[test]
    fn a_code_accepted_twice_counts_one_displacement_and_one_code() {
        let mut ledger = Ledger::default();
        ledger.apply(0, &scan(Some(9)), &json!({"outcome": "accepted"}));
        ledger.apply(1, &scan(Some(9)), &json!({"outcome": "accepted"}));
        assert_eq!(ledger.displacements(), 1);
        assert_eq!(ledger.expected().distinct_accepted_codes, 1);
        assert_eq!(ledger.expected().scan_rows, 2);
    }
}
```

`src/engine.rs` (tests only):

```rust
#[cfg(test)]
mod tests {
    use markiro_proto::{BoxClosedFact, PalletClosedFact};

    use super::*;

    fn cfg(box_capacity: u32, pallet_boxes: u32) -> EngineCfg {
        EngineCfg {
            device: 2,
            run: 1,
            shift_id: "00000000-0000-4000-8000-0000000000aa".to_owned(),
            issuer_prefix: "460068200".to_owned(),
            box_capacity,
            pallet_boxes,
            box_block_size: 4,
            pallet_block_size: 2,
        }
    }

    fn kinds(engine: &Engine) -> Vec<FactKind> {
        engine
            .batch(1000)
            .iter()
            .map(|queued| queued.meta.kind)
            .collect()
    }

    #[test]
    fn a_full_box_closes_with_the_first_serial_of_its_block() {
        let mut engine = Engine::new(cfg(3, 0), 1);
        engine.add_block(0, Block::new("b1", 100, 103));
        for _ in 0..3 {
            let code = engine.next_code();
            engine.scan_ok(&code, None);
        }
        assert_eq!(
            kinds(&engine),
            vec![
                FactKind::Scan,
                FactKind::Scan,
                FactKind::Scan,
                FactKind::BoxClosed
            ]
        );
        let queued = engine.batch(10);
        let closed: BoxClosedFact =
            serde_json::from_value(queued[3].record["data"].clone()).unwrap();
        assert_eq!((closed.serial, closed.item_count), (100, 3));
        assert_eq!(closed.sscc, gen::sscc(0, "460068200", 100));
        assert_eq!(closed.pallet_id, None);
        assert_eq!(engine.boxes_closed, 1);
        assert_eq!(engine.items_in_open_box, 0);
    }

    #[test]
    fn a_full_box_without_a_serial_holds_the_scanner_until_a_block_comes() {
        let mut engine = Engine::new(cfg(2, 0), 1);
        for _ in 0..2 {
            let code = engine.next_code();
            engine.scan_ok(&code, None);
        }
        assert!(!engine.can_scan());
        assert_eq!(kinds(&engine), vec![FactKind::Scan, FactKind::Scan]);
        engine.add_block(0, Block::new("b1", 7, 10));
        assert!(engine.can_scan());
        assert_eq!(kinds(&engine).last(), Some(&FactKind::BoxClosed));
    }

    #[test]
    fn boxes_join_the_pallet_and_a_full_pallet_closes_after_its_last_box() {
        let mut engine = Engine::new(cfg(1, 2), 1);
        engine.add_block(0, Block::new("b1", 1, 4));
        engine.add_block(1, Block::new("p1", 40, 41));
        for _ in 0..2 {
            let code = engine.next_code();
            engine.scan_ok(&code, None);
        }
        assert_eq!(
            kinds(&engine),
            vec![
                FactKind::Scan,
                FactKind::BoxClosed,
                FactKind::Scan,
                FactKind::BoxClosed,
                FactKind::PalletClosed
            ]
        );
        let queued = engine.batch(10);
        let first: BoxClosedFact =
            serde_json::from_value(queued[1].record["data"].clone()).unwrap();
        let second: BoxClosedFact =
            serde_json::from_value(queued[3].record["data"].clone()).unwrap();
        let pallet: PalletClosedFact =
            serde_json::from_value(queued[4].record["data"].clone()).unwrap();
        assert_eq!(first.pallet_id, second.pallet_id);
        assert_eq!(Some(pallet.pallet_id.clone()), first.pallet_id);
        assert_eq!((pallet.box_count, pallet.serial), (2, 40));
        assert_eq!(pallet.sscc, gen::sscc(1, "460068200", 40));
    }

    #[test]
    fn a_block_is_asked_for_when_less_than_half_is_left_and_the_request_repeats() {
        let mut engine = Engine::new(cfg(1, 0), 1);
        let first = engine.topup_request(0).expect("no block yet");
        assert_eq!(engine.topup_request(0), Some(first.clone()));
        engine.add_block(0, Block::new("b1", 0, 3));
        assert_eq!(engine.topup_request(0), None, "4 left of 4");
        for _ in 0..2 {
            let code = engine.next_code();
            engine.scan_ok(&code, None);
        }
        assert_eq!(engine.remaining(0), 2);
        assert_eq!(engine.topup_request(0), None, "2 of 4 is half, not less");
        let code = engine.next_code();
        engine.scan_ok(&code, None);
        let second = engine.topup_request(0).expect("1 of 4 is less than half");
        assert_ne!(second, first);
        assert_eq!(engine.topup_request(0), Some(second));
        assert_eq!(
            engine.topup_request(1),
            None,
            "a shift without pallets asks for none"
        );
    }

    #[test]
    fn closing_the_open_box_and_pallet_sends_what_a_station_sends_before_its_close() {
        let mut engine = Engine::new(cfg(5, 3), 1);
        engine.add_block(0, Block::new("b1", 1, 4));
        engine.add_block(1, Block::new("p1", 9, 10));
        for _ in 0..2 {
            let code = engine.next_code();
            engine.scan_ok(&code, None);
        }
        assert!(engine.close_open());
        assert_eq!(
            kinds(&engine),
            vec![
                FactKind::Scan,
                FactKind::Scan,
                FactKind::BoxClosed,
                FactKind::PalletClosed
            ]
        );
        let queued = engine.batch(10);
        let closed: BoxClosedFact =
            serde_json::from_value(queued[2].record["data"].clone()).unwrap();
        assert_eq!(closed.item_count, 2);
        let pallet: PalletClosedFact =
            serde_json::from_value(queued[3].record["data"].clone()).unwrap();
        assert_eq!(pallet.box_count, 1);
        assert!(engine.close_open(), "nothing is left to close");
    }

    #[test]
    fn the_outbox_keeps_a_batch_until_its_receipts_come() {
        let mut engine = Engine::new(cfg(9, 0), 1);
        for _ in 0..5 {
            let code = engine.next_code();
            engine.scan_ok(&code, None);
        }
        assert_eq!(engine.batch(3).len(), 3);
        assert_eq!(engine.queue_len(), 5);
        let popped = engine.ack(3);
        assert_eq!(popped.len(), 3);
        assert_eq!(engine.queue_len(), 2);
        assert_eq!(engine.ack(10).len(), 2);
        let ids: std::collections::HashSet<_> =
            popped.iter().map(|queued| queued.id.clone()).collect();
        assert_eq!(ids.len(), 3);
    }

    #[test]
    fn a_duplicate_scan_is_a_journal_row_and_claims_nothing() {
        let mut engine = Engine::new(cfg(9, 0), 1);
        let code = Code::new(1, 0, 1);
        engine.scan_duplicate(&code);
        let queued = engine.batch(1);
        assert_eq!(queued[0].meta.claims, None);
        assert_eq!(queued[0].record["data"]["verdict"], "duplicate");
        assert_eq!(engine.items_in_open_box, 0);
    }
}
```

- [ ] **Step 2: Run them to verify they fail.**

Run: `cargo --offline --locked test --manifest-path "$WT/apps/standalone/Cargo.toml" -p markiro-loadtest --lib -- ledger:: engine::`
Expected: FAIL to compile (`cannot find type Ledger`, `Engine`).

- [ ] **Step 3: Write the implementation.** `src/ledger.rs`, above its tests:

```rust
//! What the host acknowledged, kept as the run goes: the oracle the end of
//! the run reconciles the host's totals against. Only the first receipt of a
//! record counts (a resend gets the same one); a code is kept by the first
//! eight bytes of its hash, which keeps a four-hour run small.

use std::collections::{BTreeMap, HashMap};

use markiro_proto::FactKind;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// What the harness knows of a fact it queued, to read its receipt by.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FactMeta {
    pub kind: FactKind,
    /// The key of the code of an accepted-verdict scan.
    pub claims: Option<u64>,
}

#[derive(Debug, Default)]
pub struct Ledger {
    pub records: BTreeMap<u32, u64>,
    pub scan_rows: BTreeMap<u32, u64>,
    pub accepted_scans: BTreeMap<u32, u64>,
    pub conflict_receipts: u64,
    pub accepted_codes: HashMap<u64, u32>,
    pub boxes_closed: BTreeMap<u32, u64>,
    pub pallets_closed: BTreeMap<u32, u64>,
    pub rejected: BTreeMap<String, u64>,
}

/// The oracle's figures, as a report keeps them.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Expected {
    pub records: u64,
    pub scan_rows: u64,
    pub distinct_accepted_codes: u64,
    pub conflict_receipts: u64,
    pub displacements: u64,
    pub boxes_closed: u64,
    pub pallets_closed: u64,
    pub rejected: u64,
}

/// What the end-of-run checks read of the ledger, copied out of its lock.
#[derive(Debug, Clone, Default)]
pub struct Snapshot {
    pub expected: Expected,
    pub records: BTreeMap<u32, u64>,
    pub scan_rows: BTreeMap<u32, u64>,
    pub boxes_closed: BTreeMap<u32, u64>,
    pub pallets_closed: BTreeMap<u32, u64>,
}

fn bump<K: Ord>(map: &mut BTreeMap<K, u64>, key: K) {
    *map.entry(key).or_default() += 1;
}

impl Ledger {
    /// The receipt of one of `device`'s records, the first time it is seen.
    pub fn apply(&mut self, device: u32, meta: &FactMeta, receipt: &Value) {
        bump(&mut self.records, device);
        let outcome = receipt.get("outcome").and_then(Value::as_str).unwrap_or("");
        if outcome == "rejected" {
            let code = receipt
                .get("code")
                .and_then(Value::as_str)
                .unwrap_or("none");
            bump(&mut self.rejected, code.to_owned());
            return;
        }
        match (meta.kind, outcome) {
            (FactKind::Scan, "accepted") => {
                bump(&mut self.scan_rows, device);
                if let Some(key) = meta.claims {
                    bump(&mut self.accepted_scans, device);
                    *self.accepted_codes.entry(key).or_default() += 1;
                }
            }
            (FactKind::Scan, "conflict") => {
                bump(&mut self.scan_rows, device);
                self.conflict_receipts += 1;
            }
            (FactKind::BoxClosed, "accepted") => bump(&mut self.boxes_closed, device),
            (FactKind::PalletClosed, "accepted") => bump(&mut self.pallets_closed, device),
            _ => {}
        }
    }

    /// Two accepted scans of one code mean the earlier displaced the later
    /// owner: one `displaced` row for each scan beyond the first.
    pub fn displacements(&self) -> u64 {
        self.accepted_codes
            .values()
            .map(|count| u64::from(count.saturating_sub(1)))
            .sum()
    }

    pub fn snapshot(&self) -> Snapshot {
        Snapshot {
            expected: self.expected(),
            records: self.records.clone(),
            scan_rows: self.scan_rows.clone(),
            boxes_closed: self.boxes_closed.clone(),
            pallets_closed: self.pallets_closed.clone(),
        }
    }

    pub fn expected(&self) -> Expected {
        Expected {
            records: self.records.values().sum(),
            scan_rows: self.scan_rows.values().sum(),
            distinct_accepted_codes: self.accepted_codes.len() as u64,
            conflict_receipts: self.conflict_receipts,
            displacements: self.displacements(),
            boxes_closed: self.boxes_closed.values().sum(),
            pallets_closed: self.pallets_closed.values().sum(),
            rejected: self.rejected.values().sum(),
        }
    }
}
```

`src/engine.rs`, above its tests:

```rust
//! One simulated device with no network: its outbox, its open box and pallet
//! and the SSCC blocks it works from. A station's rules, as the work screen
//! keeps them: a box closes when it is full and a serial is at hand, a pallet
//! when it holds its boxes; a full box that has no serial stops the scanning
//! until a block comes; a block is asked for when less than half of the
//! newest is left. Everything that can be decided without a request is
//! decided here, so it is tested without a host.

use std::collections::VecDeque;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use markiro_proto::FactKind;
use serde_json::Value;

use crate::gen::{self, Code, DeviceClock};
use crate::ledger::FactMeta;
use crate::rng::Rng;

/// A scan of an offline device that an online one may scan first.
#[derive(Debug)]
pub struct Offer {
    pub code: Code,
    pub from: u32,
    /// Set when the online device took it, and when its fact was acknowledged.
    pub taken: AtomicBool,
    pub acked: AtomicBool,
}

#[derive(Debug, Clone)]
pub struct Queued {
    pub id: String,
    pub record: Value,
    pub meta: FactMeta,
    /// The code of an accepted-verdict scan.
    pub code: Option<Code>,
    pub offer: Option<Arc<Offer>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Block {
    pub id: String,
    pub from: u64,
    pub to: u64,
    pub next: u64,
}

impl Block {
    pub fn new(id: &str, from: u64, to: u64) -> Block {
        Block {
            id: id.to_owned(),
            from,
            to,
            next: from,
        }
    }
}

#[derive(Debug)]
struct Supply {
    size: u32,
    blocks: VecDeque<Block>,
    pending: Option<String>,
}

impl Supply {
    fn new(size: u32) -> Self {
        Self {
            size,
            blocks: VecDeque::new(),
            pending: None,
        }
    }

    fn remaining(&self) -> u64 {
        self.blocks
            .iter()
            .map(|block| block.to + 1 - block.next)
            .sum()
    }

    fn take(&mut self) -> Option<(String, u64)> {
        while let Some(block) = self.blocks.front_mut() {
            if block.next <= block.to {
                let serial = block.next;
                block.next += 1;
                return Some((block.id.clone(), serial));
            }
            self.blocks.pop_front();
        }
        None
    }
}

#[derive(Debug, Clone)]
pub struct EngineCfg {
    pub device: u32,
    pub run: u32,
    pub shift_id: String,
    pub issuer_prefix: String,
    pub box_capacity: u32,
    /// 0: a shift without pallets.
    pub pallet_boxes: u32,
    pub box_block_size: u32,
    pub pallet_block_size: u32,
}

#[derive(Debug)]
struct OpenBox {
    id: String,
    opened_at: String,
    hashes: Vec<String>,
}

#[derive(Debug)]
struct OpenPallet {
    id: String,
    opened_at: String,
    boxes: u32,
}

pub struct Engine {
    cfg: EngineCfg,
    rng: Rng,
    clock: DeviceClock,
    queue: VecDeque<Queued>,
    next_n: u64,
    open_box: Option<OpenBox>,
    full_box_waits: bool,
    open_pallet: Option<OpenPallet>,
    full_pallet_waits: bool,
    boxes: Supply,
    pallets: Supply,
    pub boxes_closed: u64,
    pub pallets_closed: u64,
    pub scans: u64,
    /// Records made so far, whatever became of them.
    pub pushed: u64,
    pub items_in_open_box: u64,
}

impl Engine {
    pub fn new(cfg: EngineCfg, seed: u64) -> Engine {
        let boxes = Supply::new(cfg.box_block_size);
        let pallets = Supply::new(cfg.pallet_block_size);
        Engine {
            cfg,
            rng: Rng::new(seed),
            clock: DeviceClock::new(),
            queue: VecDeque::new(),
            next_n: 0,
            open_box: None,
            full_box_waits: false,
            open_pallet: None,
            full_pallet_waits: false,
            boxes,
            pallets,
            boxes_closed: 0,
            pallets_closed: 0,
            scans: 0,
            pushed: 0,
            items_in_open_box: 0,
        }
    }

    /// A code this device has not scanned before; its serial is its own.
    pub fn next_code(&mut self) -> Code {
        self.next_n += 1;
        Code::new(self.cfg.run, self.cfg.device, self.next_n)
    }

    /// An id for a record built outside the engine.
    pub fn fresh_id(&mut self) -> String {
        self.rng.uuid()
    }

    /// The device's own clock, for a fact built outside the engine.
    pub fn tick(&mut self) -> String {
        self.clock.tick()
    }

    /// A full box or pallet that has no serial holds the scanner.
    pub fn can_scan(&self) -> bool {
        !self.full_box_waits && !self.full_pallet_waits
    }

    pub fn queue_len(&self) -> usize {
        self.queue.len()
    }

    fn push(
        &mut self,
        kind: FactKind,
        data: Value,
        code: Option<&Code>,
        offer: Option<Arc<Offer>>,
    ) {
        let id = self.rng.uuid();
        self.pushed += 1;
        let record = gen::record(&id, kind, &self.cfg.shift_id, data);
        self.queue.push_back(Queued {
            id,
            record,
            meta: FactMeta {
                kind,
                claims: code.map(|code| code.key),
            },
            code: code.cloned(),
            offer,
        });
    }

    /// An accepted-verdict scan of `code` into the open box.
    pub fn scan_ok(&mut self, code: &Code, offer: Option<Arc<Offer>>) {
        self.scans += 1;
        let at = self.clock.tick();
        if self.open_box.is_none() {
            self.open_box = Some(OpenBox {
                id: self.rng.uuid(),
                opened_at: at.clone(),
                hashes: Vec::new(),
            });
        }
        let open = self.open_box.as_mut().expect("a box is open");
        open.hashes.push(code.hash.clone());
        self.items_in_open_box = open.hashes.len() as u64;
        let data = gen::scan_ok(code, &open.id, &at);
        self.push(FactKind::Scan, data, Some(code), offer);
        self.progress();
    }

    /// A scan the host's check called taken: a journal row, no box.
    pub fn scan_duplicate(&mut self, code: &Code) {
        self.scans += 1;
        let at = self.clock.tick();
        self.push(FactKind::Scan, gen::scan_duplicate(code, &at), None, None);
    }

    /// Close what is full and has a serial; what has none waits.
    pub fn progress(&mut self) {
        loop {
            let full_box = self
                .open_box
                .as_ref()
                .is_some_and(|open| open.hashes.len() as u32 >= self.cfg.box_capacity);
            if full_box {
                if !self.close_box() {
                    self.full_box_waits = true;
                    break;
                }
                self.full_box_waits = false;
                continue;
            }
            let full_pallet = self.cfg.pallet_boxes > 0
                && self
                    .open_pallet
                    .as_ref()
                    .is_some_and(|open| open.boxes >= self.cfg.pallet_boxes);
            if full_pallet {
                if !self.close_pallet() {
                    self.full_pallet_waits = true;
                    break;
                }
                self.full_pallet_waits = false;
                continue;
            }
            self.full_box_waits = false;
            self.full_pallet_waits = false;
            break;
        }
    }

    fn close_box(&mut self) -> bool {
        let Some((block, serial)) = self.boxes.take() else {
            return false;
        };
        let open = self.open_box.take().expect("a box to close");
        let closed_at = self.clock.tick();
        let pallet_id = (self.cfg.pallet_boxes > 0).then(|| {
            let id = self.open_pallet.as_ref().map(|pallet| pallet.id.clone());
            id.unwrap_or_else(|| self.rng.uuid())
        });
        if let Some(id) = &pallet_id {
            let pallet = self.open_pallet.get_or_insert_with(|| OpenPallet {
                id: id.clone(),
                opened_at: closed_at.clone(),
                boxes: 0,
            });
            pallet.boxes += 1;
        }
        let sscc = gen::sscc(0, &self.cfg.issuer_prefix, serial);
        let data = gen::box_closed(
            &open.id,
            &sscc,
            &block,
            serial,
            &open.opened_at,
            &closed_at,
            &open.hashes,
            pallet_id.as_deref(),
        );
        self.push(FactKind::BoxClosed, data, None, None);
        self.boxes_closed += 1;
        self.items_in_open_box = 0;
        true
    }

    fn close_pallet(&mut self) -> bool {
        let Some((block, serial)) = self.pallets.take() else {
            return false;
        };
        let open = self.open_pallet.take().expect("a pallet to close");
        let closed_at = self.clock.tick();
        let sscc = gen::sscc(1, &self.cfg.issuer_prefix, serial);
        let data = gen::pallet_closed(
            &open.id,
            &sscc,
            &block,
            serial,
            &open.opened_at,
            &closed_at,
            open.boxes,
        );
        self.push(FactKind::PalletClosed, data, None, None);
        self.pallets_closed += 1;
        true
    }

    /// A block the host issued; closes what was waiting for one.
    pub fn add_block(&mut self, extension: u8, block: Block) {
        let supply = if extension == 0 {
            &mut self.boxes
        } else {
            &mut self.pallets
        };
        supply.pending = None;
        supply.blocks.push_back(block);
        self.progress();
    }

    /// The request to make now for `extension`, if the half rule says so: its
    /// id stays the same until [`Engine::add_block`] answers it.
    pub fn topup_request(&mut self, extension: u8) -> Option<String> {
        if extension == 1 && self.cfg.pallet_boxes == 0 {
            return None;
        }
        let new_id = self.rng.uuid();
        let supply = if extension == 0 {
            &mut self.boxes
        } else {
            &mut self.pallets
        };
        if supply.pending.is_none() && supply.remaining() * 2 < u64::from(supply.size) {
            supply.pending = Some(new_id);
        }
        supply.pending.clone()
    }

    pub fn remaining(&self, extension: u8) -> u64 {
        if extension == 0 {
            self.boxes.remaining()
        } else {
            self.pallets.remaining()
        }
    }

    /// The end of the run: the partial box and pallet are closed as a
    /// station closes them before it closes its part of the shift. `false`
    /// while a serial is missing for one of them.
    pub fn close_open(&mut self) -> bool {
        if self.open_box.is_some() && !self.close_box() {
            return false;
        }
        if self.cfg.pallet_boxes > 0
            && self
                .open_pallet
                .as_ref()
                .is_some_and(|pallet| pallet.boxes > 0)
            && !self.close_pallet()
        {
            return false;
        }
        self.full_box_waits = false;
        self.full_pallet_waits = false;
        true
    }

    /// Up to `max` records from the front of the outbox, left in place until
    /// their receipts come.
    pub fn batch(&self, max: usize) -> Vec<Queued> {
        self.queue.iter().take(max).cloned().collect()
    }

    /// The first `n` records of the outbox, their receipts kept.
    pub fn ack(&mut self, n: usize) -> Vec<Queued> {
        self.queue.drain(..n.min(self.queue.len())).collect()
    }
}
```

- [ ] **Step 4: Run the tests to verify they pass.**

Run: `cargo --offline --locked test --manifest-path "$WT/apps/standalone/Cargo.toml" -p markiro-loadtest --lib -- ledger:: engine::`
Expected: PASS, 9 tests (ledger 2, engine 7).

- [ ] **Step 5: Format and commit.**

Run: `cargo fmt --manifest-path "$WT/apps/standalone/Cargo.toml" --all -- --check` (clean).

```bash
git -C "$WT" add apps/standalone/loadtest/src/lib.rs \
  apps/standalone/loadtest/src/ledger.rs \
  apps/standalone/loadtest/src/engine.rs
git -C "$WT" commit -m "feat(standalone): load test ledger and device engine (outbox, boxes, pallets, SSCC blocks)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 9: The simulated device on the network

**Files:**

- Create: `apps/standalone/loadtest/src/device.rs`
- Modify: `apps/standalone/loadtest/src/lib.rs`

**Interfaces:**

- Consumes: `api::{Api, Auth}`, `engine::{Engine, EngineCfg, Block, Offer, Queued}`, `gen`, `ledger::Ledger`, `metrics::{Metrics, Route}`, `profile::Profile`, `rng::Rng`, `site::DeviceSpec`.
- Produces: `device::Shared { profile, run, shift_id, issuer_prefix, metrics, ledger: Mutex<Ledger>, stop: AtomicBool, pools: Mutex<Pools>, ranges, overlaps: AtomicU64, generated: AtomicU64 }` with `Shared::new(profile, run, shift_id, issuer_prefix, metrics)`; `device::Pools { dup, offers }`; `device::Plan { Fresh { offer }, Race(Arc<Offer>), LateDup(Code), CheckedDup(Code) }` and `device::decide(rng, profile, me, online, pools) -> Plan`; `device::DeviceStats` (serde: `index, handheld, scans, late_dups, checked_dups, races_offered, races_taken, stalls, checks, check_timeouts, check_surprises, flushes, flush_errors, resends, resend_mismatches, offline_periods, offline_s, queue_max, polls, poll_sum_mismatches, totals_regressions, stream_opens, stream_events, boxes_closed, pallets_closed, fatal`); `device::SimDevice` (`new(spec, api, shared) -> Arc<SimDevice>`, tasks `scanner(self: Arc<Self>)`, `syncer(self: Arc<Self>) -> Result<(), String>`, `link(self: Arc<Self>)`, `stream(self: Arc<Self>)`, and `stats()`, `view() -> Option<Value>` (the shift in `GET /v1/device/shifts`), `close_part(planned, reason) -> Result<Value, String>` (the receipt), `records_made()`, `quiesce()`, `is_online()`); `device::CHECK_BUDGET` (300 ms).

How the four tasks of one device behave. **Scanner:** every `1 / scanRate` seconds (±30 % jitter; a scanner that fell behind does not catch up in a burst) it asks `decide` what to scan; online, a fresh code or a race code first gets the host's code check within 300 ms (a check that runs out is counted and the scan is accepted on the device's own copy); a late duplicate skips the check. **Syncer:** every `flushMs` (or when `batchMax` records wait) it sends the outbox, applies the receipts to the ledger and pops them only after; asks for SSCC blocks by the half rule (and registers each block's range: an overlap with another device's is counted); reads `GET /v1/device/shifts` every `totalsPollS` (the shift-wide total must never go down); sends an acknowledged batch again with probability `resendRate` and the receipts must be identical. A 5xx or a lost answer is retried with backoff and the same records; a 4xx on a batch stops the device and fails the run. **Link:** drops the device offline for an exponential time and brings it back; scans go on while it is down, and on return the device first waits (at most 10 s) until the later scans of the races it offered were acknowledged. **Stream:** holds `GET /v1/changes/stream` open while online and counts its events. **Finish** (after `quiesce()`): the link is up, the open box and pallet close (asking for a block if one is missing, for at most 60 s), the outbox drains (at most 120 s), the totals are read once more.

- [ ] **Step 1: Write the failing tests.** `src/lib.rs`:

```rust
pub mod api;
pub mod checks;
pub mod device;
pub mod engine;
pub mod gen;
pub mod histogram;
pub mod host;
pub mod ledger;
pub mod metrics;
pub mod procstat;
pub mod profile;
pub mod rng;
pub mod sampler;
pub mod site;
pub mod wal;
```

`src/device.rs` (tests only):

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn offer(from: u32, n: u64) -> Arc<Offer> {
        Arc::new(Offer {
            code: Code::new(1, from, n),
            from,
            taken: AtomicBool::new(false),
            acked: AtomicBool::new(false),
        })
    }

    fn profile() -> Profile {
        let mut profile = Profile::preset("smoke").unwrap();
        profile.late_dup_rate = 0.0;
        profile.checked_dup_rate = 0.0;
        profile.race_rate = 0.0;
        profile
    }

    #[test]
    fn an_offline_device_scans_fresh_codes_and_offers_them_at_the_race_rate() {
        let mut pools = Pools::default();
        let mut rng = Rng::new(1);
        let mut offering = profile();
        offering.race_rate = 1.0;
        assert!(matches!(
            decide(&mut rng, &offering, 0, false, &mut pools),
            Plan::Fresh { offer: true }
        ));
        assert!(matches!(
            decide(&mut rng, &profile(), 0, false, &mut pools),
            Plan::Fresh { offer: false }
        ));
        offering.mean_offline_s = 0.0;
        assert!(
            matches!(
                decide(&mut rng, &offering, 0, false, &mut pools),
                Plan::Fresh { offer: false }
            ),
            "a device that never drops offers nothing"
        );
    }

    #[test]
    fn an_online_device_takes_an_offer_of_another_device_and_never_its_own() {
        let mut rng = Rng::new(2);
        let mut pools = Pools::default();
        pools.offers.push(offer(0, 1));
        for _ in 0..200 {
            assert!(matches!(
                decide(&mut rng, &profile(), 0, true, &mut pools),
                Plan::Fresh { offer: false }
            ));
        }
        assert_eq!(pools.offers.len(), 1);
        let mut taken = None;
        for _ in 0..200 {
            if let Plan::Race(offer) = decide(&mut rng, &profile(), 1, true, &mut pools) {
                taken = Some(offer);
                break;
            }
        }
        let taken = taken.expect("device 1 takes the offer within a few scans");
        assert_eq!(taken.from, 0);
        assert!(taken.taken.load(Ordering::SeqCst));
        assert!(pools.offers.is_empty(), "an offer is taken once");
    }

    #[test]
    fn a_duplicate_is_of_a_code_another_device_holds_and_is_used_once() {
        let mut rng = Rng::new(3);
        let mut late = profile();
        late.late_dup_rate = 1.0;
        let mut pools = Pools::default();
        pools.dup.push_back((0, Code::new(1, 0, 1)));
        pools.dup.push_back((1, Code::new(1, 1, 1)));
        match decide(&mut rng, &late, 0, true, &mut pools) {
            Plan::LateDup(code) => assert_eq!(code, Code::new(1, 1, 1)),
            _ => panic!("a late duplicate of the other device's code"),
        }
        assert!(
            matches!(
                decide(&mut rng, &late, 0, true, &mut pools),
                Plan::Fresh { .. }
            ),
            "only its own code is left: nothing to duplicate"
        );
        let mut checked = profile();
        checked.checked_dup_rate = 1.0;
        let mut pools = Pools::default();
        pools.dup.push_back((2, Code::new(1, 2, 9)));
        assert!(matches!(
            decide(&mut rng, &checked, 0, true, &mut pools),
            Plan::CheckedDup(_)
        ));
        assert!(pools.dup.is_empty());
    }
}
```

- [ ] **Step 2: Run them to verify they fail.**

Run: `cargo --offline --locked test --manifest-path "$WT/apps/standalone/Cargo.toml" -p markiro-loadtest --lib -- device::`
Expected: FAIL to compile (`cannot find function decide`, `Pools`, `Plan`).

- [ ] **Step 3: Write the implementation** above the tests module in `src/device.rs`:

```rust
//! A simulated device on the network: the engine's outbox flushed to the host
//! in batches, a code check before each scan online, blocks asked for by the
//! half rule, the shift's totals read now and then, a change stream held
//! open, and a link that drops and returns while scans go on. Four tasks
//! share one device: the scanner, the syncer, the link and the stream.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::api::{Api, Auth};
use crate::engine::{Block, Engine, EngineCfg, Offer, Queued};
use crate::gen::Code;
use crate::ledger::Ledger;
use crate::metrics::{Metrics, Route};
use crate::profile::Profile;
use crate::rng::Rng;
use crate::site::DeviceSpec;

/// The station's own budget for the host's code check.
pub const CHECK_BUDGET: Duration = Duration::from_millis(300);
const DUP_POOL_CAP: usize = 4096;
const OFFER_WAIT: Duration = Duration::from_secs(10);

/// What the devices share: the shift, the ledger, the pools duplicates and
/// races are drawn from and the stop flag of the run.
pub struct Shared {
    pub profile: Profile,
    pub run: u32,
    pub shift_id: String,
    pub issuer_prefix: String,
    pub metrics: Arc<Metrics>,
    pub ledger: Mutex<Ledger>,
    pub stop: AtomicBool,
    pub pools: Mutex<Pools>,
    pub ranges: Mutex<Vec<(u8, u64, u64)>>,
    pub overlaps: AtomicU64,
    pub generated: AtomicU64,
}

#[derive(Default)]
pub struct Pools {
    /// Codes another device was told it owns, each to be scanned again once.
    pub dup: VecDeque<(u32, Code)>,
    /// Scans an offline device made that an online one may scan first.
    pub offers: Vec<Arc<Offer>>,
}

impl Shared {
    pub fn new(
        profile: Profile,
        run: u32,
        shift_id: &str,
        issuer_prefix: &str,
        metrics: Arc<Metrics>,
    ) -> Shared {
        Shared {
            profile,
            run,
            shift_id: shift_id.to_owned(),
            issuer_prefix: issuer_prefix.to_owned(),
            metrics,
            ledger: Mutex::new(Ledger::default()),
            stop: AtomicBool::new(false),
            pools: Mutex::new(Pools::default()),
            ranges: Mutex::new(Vec::new()),
            overlaps: AtomicU64::new(0),
            generated: AtomicU64::new(0),
        }
    }
}

/// What one scan will be.
pub enum Plan {
    Fresh { offer: bool },
    Race(Arc<Offer>),
    LateDup(Code),
    CheckedDup(Code),
}

/// Decide the next scan of device `me`. Online: an offered scan of another
/// device half the time one is there, else sometimes a code another device
/// holds (sent without or after the check), else a fresh code. Offline: a
/// fresh code, offered to the others with the profile's race rate.
pub fn decide(rng: &mut Rng, profile: &Profile, me: u32, online: bool, pools: &mut Pools) -> Plan {
    if !online {
        let offer = profile.mean_offline_s > 0.0 && rng.chance(profile.race_rate);
        return Plan::Fresh { offer };
    }
    let takeable = pools
        .offers
        .iter()
        .position(|offer| offer.from != me && !offer.taken.load(Ordering::SeqCst));
    if let Some(at) = takeable {
        if rng.chance(0.5) {
            let offer = pools.offers.remove(at);
            offer.taken.store(true, Ordering::SeqCst);
            return Plan::Race(offer);
        }
    }
    let other = |pools: &mut Pools| {
        let at = pools.dup.iter().rposition(|(device, _)| *device != me)?;
        pools.dup.remove(at).map(|(_, code)| code)
    };
    if rng.chance(profile.late_dup_rate) {
        if let Some(code) = other(pools) {
            return Plan::LateDup(code);
        }
    }
    if rng.chance(profile.checked_dup_rate) {
        if let Some(code) = other(pools) {
            return Plan::CheckedDup(code);
        }
    }
    Plan::Fresh { offer: false }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceStats {
    pub index: u32,
    pub handheld: bool,
    pub scans: u64,
    pub late_dups: u64,
    pub checked_dups: u64,
    pub races_offered: u64,
    pub races_taken: u64,
    pub stalls: u64,
    pub checks: u64,
    pub check_timeouts: u64,
    /// A fresh code the host called taken, or a duplicate it called free.
    pub check_surprises: u64,
    pub flushes: u64,
    pub flush_errors: u64,
    pub resends: u64,
    pub resend_mismatches: u64,
    pub offline_periods: u64,
    pub offline_s: f64,
    pub queue_max: u64,
    pub polls: u64,
    pub poll_sum_mismatches: u64,
    pub totals_regressions: u64,
    pub stream_opens: u64,
    pub stream_events: u64,
    pub boxes_closed: u64,
    pub pallets_closed: u64,
    pub fatal: Option<String>,
}

enum Check {
    Free,
    Taken { same_device: bool },
    TimedOut,
    Failed,
}

pub struct SimDevice {
    pub spec: DeviceSpec,
    api: Api,
    shared: Arc<Shared>,
    engine: Mutex<Engine>,
    online: AtomicBool,
    quiesce: AtomicBool,
    own_offers: Mutex<Vec<Arc<Offer>>>,
    last_total: AtomicU64,
    stats: Mutex<DeviceStats>,
}

impl SimDevice {
    pub fn new(spec: DeviceSpec, api: Api, shared: Arc<Shared>) -> Arc<SimDevice> {
        let profile = &shared.profile;
        let cfg = EngineCfg {
            device: spec.index,
            run: shared.run,
            shift_id: shared.shift_id.clone(),
            issuer_prefix: shared.issuer_prefix.clone(),
            box_capacity: profile.box_capacity,
            pallet_boxes: profile.pallet_boxes,
            box_block_size: profile.box_block_size,
            pallet_block_size: profile.pallet_block_size,
        };
        let seed = profile.seed ^ (u64::from(spec.index) + 1).wrapping_mul(0x9E37_79B9);
        let stats = DeviceStats {
            index: spec.index,
            handheld: spec.is_handheld(),
            ..DeviceStats::default()
        };
        Arc::new(SimDevice {
            spec,
            api,
            engine: Mutex::new(Engine::new(cfg, seed)),
            shared,
            online: AtomicBool::new(true),
            quiesce: AtomicBool::new(false),
            own_offers: Mutex::new(Vec::new()),
            last_total: AtomicU64::new(0),
            stats: Mutex::new(stats),
        })
    }

    pub fn stats(&self) -> DeviceStats {
        let mut stats = self.stats.lock().expect("stats").clone();
        let engine = self.engine.lock().expect("engine");
        stats.boxes_closed = engine.boxes_closed;
        stats.pallets_closed = engine.pallets_closed;
        stats
    }

    fn with_stats(&self, change: impl FnOnce(&mut DeviceStats)) {
        change(&mut self.stats.lock().expect("stats"));
    }

    fn auth(&self) -> Auth<'_> {
        Auth {
            device_key: Some(&self.spec.key),
            session: None,
        }
    }

    /// The shift as this device reads it in `GET /v1/device/shifts`.
    pub async fn view(&self) -> Option<Value> {
        let reply = self
            .api
            .send(
                Route::DeviceShifts,
                "GET",
                "/v1/device/shifts",
                self.auth(),
                None,
            )
            .await
            .ok()?;
        reply
            .body
            .get("shifts")?
            .as_array()?
            .iter()
            .find(|shift| shift["id"] == json!(self.shared.shift_id))
            .cloned()
    }

    /// The device's close of its part of the shift: what it accepted, the
    /// boxes it closed, the plan's number and a reason when there is one.
    /// The answer is the receipt.
    pub async fn close_part(
        &self,
        planned: Option<u32>,
        reason: Option<&str>,
    ) -> Result<Value, String> {
        let actual = {
            let ledger = self.shared.ledger.lock().expect("ledger");
            ledger
                .accepted_scans
                .get(&self.spec.index)
                .copied()
                .unwrap_or(0)
        };
        let (id, at, boxes) = {
            let mut engine = self.engine.lock().expect("engine");
            (engine.fresh_id(), engine.tick(), engine.boxes_closed)
        };
        let data = crate::gen::shift_closed(planned, actual as u32, boxes as u32, reason, &at);
        let record = crate::gen::record(
            &id,
            markiro_proto::FactKind::ShiftClosed,
            &self.shared.shift_id,
            data,
        );
        let mut receipts = self.api.facts(&self.spec.key, &[record]).await?;
        Ok(receipts.remove(0))
    }

    /// Records made so far, sent or not.
    pub fn records_made(&self) -> u64 {
        self.engine.lock().expect("engine").pushed
    }

    pub fn quiesce(&self) {
        self.quiesce.store(true, Ordering::SeqCst);
    }

    pub fn is_online(&self) -> bool {
        self.online.load(Ordering::SeqCst)
    }

    fn stopped(&self) -> bool {
        self.shared.stop.load(Ordering::SeqCst)
    }

    // ---- the scanner ----

    pub async fn scanner(self: Arc<Self>) {
        let profile = self.shared.profile.clone();
        let mut rng = Rng::new(profile.seed ^ 0xC0DE ^ u64::from(self.spec.index));
        let interval = Duration::from_secs_f64(1.0 / profile.scan_rate);
        let mut next = Instant::now();
        while !self.stopped() {
            let now = Instant::now();
            if now < next {
                tokio::time::sleep((next - now).min(Duration::from_millis(50))).await;
                continue;
            }
            // A scanner that fell behind (a stall, a slow host) does not catch up in a burst.
            let spacing = Duration::from_secs_f64(rng.jitter(interval.as_secs_f64(), 0.3));
            next = if now - next > Duration::from_secs(1) {
                now + spacing
            } else {
                next + spacing
            };
            if !self.engine.lock().expect("engine").can_scan() {
                self.with_stats(|stats| stats.stalls += 1);
                continue;
            }
            self.scan_once(&mut rng).await;
        }
    }

    async fn scan_once(&self, rng: &mut Rng) {
        let online = self.is_online();
        let plan = {
            let mut pools = self.shared.pools.lock().expect("pools");
            decide(
                rng,
                &self.shared.profile,
                self.spec.index,
                online,
                &mut pools,
            )
        };
        match plan {
            Plan::Fresh { offer } => {
                let code = self.engine.lock().expect("engine").next_code();
                if online {
                    self.check_fresh(&code).await;
                }
                self.engine.lock().expect("engine").scan_ok(&code, None);
                if offer {
                    let offered = Arc::new(Offer {
                        code,
                        from: self.spec.index,
                        taken: AtomicBool::new(false),
                        acked: AtomicBool::new(false),
                    });
                    self.own_offers
                        .lock()
                        .expect("offers")
                        .push(offered.clone());
                    self.shared
                        .pools
                        .lock()
                        .expect("pools")
                        .offers
                        .push(offered);
                    self.with_stats(|stats| stats.races_offered += 1);
                }
            }
            Plan::Race(offer) => {
                self.check_fresh(&offer.code).await;
                self.engine
                    .lock()
                    .expect("engine")
                    .scan_ok(&offer.code, Some(offer.clone()));
                self.with_stats(|stats| stats.races_taken += 1);
            }
            Plan::LateDup(code) => {
                // The 300 ms ran out: the scan is accepted on the device's own copy.
                self.engine.lock().expect("engine").scan_ok(&code, None);
                self.with_stats(|stats| stats.late_dups += 1);
            }
            Plan::CheckedDup(code) => {
                match self.check(&code).await {
                    Check::Taken { same_device: false } => {
                        self.engine.lock().expect("engine").scan_duplicate(&code);
                    }
                    Check::Taken { same_device: true } | Check::Free => {
                        // The host did not know a code another device was told it owns.
                        self.with_stats(|stats| stats.check_surprises += 1);
                        self.engine.lock().expect("engine").scan_ok(&code, None);
                    }
                    Check::TimedOut | Check::Failed => {
                        self.engine.lock().expect("engine").scan_ok(&code, None);
                    }
                }
                self.with_stats(|stats| stats.checked_dups += 1);
            }
        }
        self.shared.generated.fetch_add(1, Ordering::SeqCst);
        self.with_stats(|stats| {
            stats.scans += 1;
            stats.queue_max = stats.queue_max.max(
                self.engine
                    .lock()
                    .map(|engine| engine.queue_len() as u64)
                    .unwrap_or(0),
            );
        });
    }

    async fn check_fresh(&self, code: &Code) {
        if let Check::Taken { .. } = self.check(code).await {
            self.with_stats(|stats| stats.check_surprises += 1);
        }
    }

    async fn check(&self, code: &Code) -> Check {
        self.with_stats(|stats| stats.checks += 1);
        let path = format!("/v1/device/codes/{}", code.hash);
        let sent = self
            .api
            .send(Route::CodeCheck, "GET", &path, self.auth(), None);
        match tokio::time::timeout(CHECK_BUDGET, sent).await {
            Err(_) => {
                self.shared
                    .metrics
                    .record(Route::CodeCheck, CHECK_BUDGET.as_micros() as u64);
                self.with_stats(|stats| stats.check_timeouts += 1);
                Check::TimedOut
            }
            Ok(Ok(reply)) if reply.ok() => match reply.body.get("status").and_then(Value::as_str) {
                Some("free") => Check::Free,
                Some("taken") => Check::Taken {
                    same_device: reply.body.pointer("/owner/sameDevice")
                        == Some(&Value::Bool(true)),
                },
                _ => Check::Failed,
            },
            Ok(_) => Check::Failed,
        }
    }

    // ---- the syncer ----

    /// Flush, top up and poll until the run ends; then the finish.
    pub async fn syncer(self: Arc<Self>) -> Result<(), String> {
        let profile = self.shared.profile.clone();
        let flush_every = Duration::from_millis(profile.flush_ms);
        let poll_every = Duration::from_secs_f64(profile.totals_poll_s);
        let mut last_flush = Instant::now();
        let mut last_poll = Instant::now();
        let mut backoff = Duration::from_millis(250);
        loop {
            if self.quiesce.load(Ordering::SeqCst) {
                return self.finish().await;
            }
            if self.is_online() {
                self.topup(0).await;
                self.topup(1).await;
                let queued = self.engine.lock().expect("engine").queue_len();
                if queued > 0
                    && (last_flush.elapsed() >= flush_every || queued >= profile.batch_max)
                {
                    match self.flush_once().await {
                        Flush::Failed => {
                            tokio::time::sleep(backoff).await;
                            backoff = (backoff * 2).min(Duration::from_secs(2));
                        }
                        Flush::Fatal(message) => return Err(message),
                        _ => backoff = Duration::from_millis(250),
                    }
                    last_flush = Instant::now();
                }
                if last_poll.elapsed() >= poll_every {
                    self.poll_totals().await;
                    last_poll = Instant::now();
                }
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    async fn topup(&self, extension: u8) {
        let Some(request_id) = self.engine.lock().expect("engine").topup_request(extension) else {
            return;
        };
        let body = json!({
            "requestId": request_id,
            "issuerPrefix": self.shared.issuer_prefix,
            "extension": extension
        });
        let Ok(reply) = self
            .api
            .send(
                Route::SsccBlock,
                "POST",
                "/v1/device/sscc/blocks",
                self.auth(),
                Some(&body),
            )
            .await
        else {
            return;
        };
        if !reply.ok() {
            return;
        }
        let (Some(id), Some(from), Some(to)) = (
            reply.body.get("id").and_then(Value::as_str),
            reply.body.get("fromSerial").and_then(Value::as_u64),
            reply.body.get("toSerial").and_then(Value::as_u64),
        ) else {
            return;
        };
        {
            let mut ranges = self.shared.ranges.lock().expect("ranges");
            if ranges
                .iter()
                .any(|(ext, low, high)| *ext == extension && *low <= to && from <= *high)
            {
                self.shared.overlaps.fetch_add(1, Ordering::SeqCst);
            }
            ranges.push((extension, from, to));
        }
        self.engine
            .lock()
            .expect("engine")
            .add_block(extension, Block::new(id, from, to));
    }

    async fn flush_once(&self) -> Flush {
        let batch: Vec<Queued> = self
            .engine
            .lock()
            .expect("engine")
            .batch(self.shared.profile.batch_max);
        if batch.is_empty() {
            return Flush::Empty;
        }
        let records: Vec<Value> = batch.iter().map(|queued| queued.record.clone()).collect();
        let body = json!({ "records": records });
        let reply = match self
            .api
            .send(
                Route::Facts,
                "POST",
                "/v1/device/facts",
                self.auth(),
                Some(&body),
            )
            .await
        {
            Ok(reply) => reply,
            Err(_) => {
                self.with_stats(|stats| stats.flush_errors += 1);
                return Flush::Failed;
            }
        };
        if reply.status >= 500 {
            self.with_stats(|stats| stats.flush_errors += 1);
            return Flush::Failed;
        }
        if reply.status != 200 {
            let message = format!("facts: {} {}", reply.status, reply.body);
            self.with_stats(|stats| stats.fatal = Some(message.clone()));
            return Flush::Fatal(message);
        }
        let receipts = reply
            .body
            .get("receipts")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let ids_match = receipts.len() == batch.len()
            && receipts.iter().zip(&batch).all(|(receipt, queued)| {
                receipt.get("id").and_then(Value::as_str) == Some(queued.id.as_str())
            });
        if !ids_match {
            let message = format!(
                "facts: {} receipts for {} records, or ids out of order",
                receipts.len(),
                batch.len()
            );
            self.with_stats(|stats| stats.fatal = Some(message.clone()));
            return Flush::Fatal(message);
        }
        {
            let mut ledger = self.shared.ledger.lock().expect("ledger");
            let mut pools = self.shared.pools.lock().expect("pools");
            for (queued, receipt) in batch.iter().zip(&receipts) {
                ledger.apply(self.spec.index, &queued.meta, receipt);
                if let Some(offer) = &queued.offer {
                    offer.acked.store(true, Ordering::SeqCst);
                }
                let accepted = receipt.get("outcome").and_then(Value::as_str) == Some("accepted");
                if let (Some(code), true) = (&queued.code, accepted) {
                    let accepted_scans = ledger
                        .accepted_scans
                        .get(&self.spec.index)
                        .copied()
                        .unwrap_or(0);
                    if accepted_scans % 8 == 0 {
                        pools.dup.push_back((self.spec.index, code.clone()));
                        if pools.dup.len() > DUP_POOL_CAP {
                            pools.dup.pop_front();
                        }
                    }
                }
            }
        }
        self.engine.lock().expect("engine").ack(batch.len());
        self.with_stats(|stats| stats.flushes += 1);
        if self.should_resend() {
            self.resend(&body, &receipts).await;
        }
        Flush::Sent
    }

    /// Whether to send the batch just acknowledged once more: a function of
    /// the device's own count of flushes, so a run with a seed repeats.
    fn should_resend(&self) -> bool {
        let flushes = self.stats.lock().expect("stats").flushes;
        let mut rng = Rng::new(
            self.shared.profile.seed ^ flushes.wrapping_mul(0xA5A5) ^ u64::from(self.spec.index),
        );
        rng.chance(self.shared.profile.resend_rate)
    }

    async fn resend(&self, body: &Value, first: &[Value]) {
        self.with_stats(|stats| stats.resends += 1);
        let again = self
            .api
            .send(
                Route::Facts,
                "POST",
                "/v1/device/facts",
                self.auth(),
                Some(body),
            )
            .await;
        let same = matches!(&again, Ok(reply) if reply.status == 200
            && reply.body.get("receipts").and_then(Value::as_array).map(Vec::as_slice) == Some(first));
        if !same {
            self.with_stats(|stats| stats.resend_mismatches += 1);
        }
    }

    async fn poll_totals(&self) {
        let Ok(reply) = self
            .api
            .send(
                Route::DeviceShifts,
                "GET",
                "/v1/device/shifts",
                self.auth(),
                None,
            )
            .await
        else {
            return;
        };
        let shift = reply
            .body
            .get("shifts")
            .and_then(Value::as_array)
            .and_then(|shifts| {
                shifts
                    .iter()
                    .find(|shift| shift["id"] == json!(self.shared.shift_id))
            });
        let Some(totals) = shift.and_then(|shift| shift.get("totals")) else {
            return;
        };
        let accepted = totals.get("accepted").and_then(Value::as_u64).unwrap_or(0);
        let sum: u64 = shift
            .and_then(|shift| shift.get("byDevice"))
            .and_then(Value::as_array)
            .map(|parts| {
                parts
                    .iter()
                    .filter_map(|part| part.get("accepted").and_then(Value::as_u64))
                    .sum()
            })
            .unwrap_or(0);
        self.with_stats(|stats| {
            stats.polls += 1;
            if sum != accepted {
                stats.poll_sum_mismatches += 1;
            }
        });
        let previous = self.last_total.swap(accepted, Ordering::SeqCst);
        if accepted < previous {
            self.with_stats(|stats| stats.totals_regressions += 1);
        }
    }

    // ---- the link ----

    /// Drop the link and bring it back at random: while it is down the
    /// scanner goes on and the outbox grows; when it returns the outbox is
    /// replayed, after the races this device offered were taken.
    pub async fn link(self: Arc<Self>) {
        let profile = self.shared.profile.clone();
        if profile.mean_offline_s <= 0.0 {
            return;
        }
        let mut rng = Rng::new(profile.seed ^ 0x11C ^ u64::from(self.spec.index));
        while !self.stopped() {
            let online_for = rng.exp(profile.mean_online_s).max(1.0);
            if self.sleep_unless_stopped(online_for).await {
                break;
            }
            self.online.store(false, Ordering::SeqCst);
            let offline_for = rng.exp(profile.mean_offline_s).max(1.0);
            let began = Instant::now();
            let stopped = self.sleep_unless_stopped(offline_for).await;
            self.wait_offers_resolved(OFFER_WAIT).await;
            self.online.store(true, Ordering::SeqCst);
            self.with_stats(|stats| {
                stats.offline_periods += 1;
                stats.offline_s += began.elapsed().as_secs_f64();
            });
            if stopped {
                break;
            }
        }
        self.online.store(true, Ordering::SeqCst);
    }

    /// Sleep `seconds`; `true` if the run stopped first.
    async fn sleep_unless_stopped(&self, seconds: f64) -> bool {
        let until = Instant::now() + Duration::from_secs_f64(seconds);
        while Instant::now() < until {
            if self.stopped() {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        self.stopped()
    }

    /// Wait until every race this device offered was either not taken or its
    /// taker's fact was acknowledged (the host must see the later scan first).
    async fn wait_offers_resolved(&self, limit: Duration) {
        let began = Instant::now();
        loop {
            let pending = self.own_offers.lock().expect("offers").iter().any(|offer| {
                offer.taken.load(Ordering::SeqCst) && !offer.acked.load(Ordering::SeqCst)
            });
            if !pending || began.elapsed() >= limit {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        // What nobody took before the link came back is a scan like any other.
        let mut pools = self.shared.pools.lock().expect("pools");
        pools.offers.retain(|offer| offer.from != self.spec.index);
        self.own_offers.lock().expect("offers").clear();
    }

    // ---- the stream ----

    pub async fn stream(self: Arc<Self>) {
        while !self.stopped() {
            if !self.is_online() {
                tokio::time::sleep(Duration::from_millis(200)).await;
                continue;
            }
            let Ok(mut response) = self
                .api
                .open_stream("/v1/changes/stream", self.auth())
                .await
            else {
                tokio::time::sleep(Duration::from_secs(1)).await;
                continue;
            };
            self.with_stats(|stats| stats.stream_opens += 1);
            while !self.stopped() && self.is_online() {
                match tokio::time::timeout(Duration::from_secs(1), response.chunk()).await {
                    Ok(Ok(Some(chunk))) => {
                        let events = chunk
                            .split(|byte| *byte == b'\n')
                            .filter(|line| line.starts_with(b"data:"))
                            .count();
                        self.with_stats(|stats| stats.stream_events += events as u64);
                    }
                    Ok(Ok(None)) | Ok(Err(_)) => break,
                    Err(_) => {}
                }
            }
        }
    }

    // ---- the end ----

    /// Close what a station closes before its part: the open box and pallet;
    /// send everything; read the totals once more.
    async fn finish(&self) -> Result<(), String> {
        self.online.store(true, Ordering::SeqCst);
        self.wait_offers_resolved(Duration::from_secs(15)).await;
        let deadline = Instant::now() + Duration::from_secs(60);
        loop {
            if self.engine.lock().expect("engine").close_open() {
                break;
            }
            if Instant::now() > deadline {
                return Err("no SSCC serial to close the last box or pallet".to_owned());
            }
            self.topup(0).await;
            self.topup(1).await;
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        let deadline = Instant::now() + Duration::from_secs(120);
        loop {
            match self.flush_once().await {
                Flush::Empty => break,
                Flush::Sent => {}
                Flush::Failed => tokio::time::sleep(Duration::from_millis(500)).await,
                Flush::Fatal(message) => return Err(message),
            }
            if Instant::now() > deadline {
                return Err("the outbox did not drain in 120 s".to_owned());
            }
        }
        self.poll_totals().await;
        Ok(())
    }
}

enum Flush {
    Empty,
    Sent,
    Failed,
    Fatal(String),
}
```

- [ ] **Step 4: Run the tests to verify they pass.**

Run: `cargo --offline --locked test --manifest-path "$WT/apps/standalone/Cargo.toml" -p markiro-loadtest --lib -- device::`
Expected: PASS, 3 tests. The network tasks are exercised end to end by Task 13's self-test, which fails if a device stalls, double-counts or mis-orders anything.

- [ ] **Step 5: Format and commit.**

Run: `cargo fmt --manifest-path "$WT/apps/standalone/Cargo.toml" --all -- --check` (clean).

```bash
git -C "$WT" add apps/standalone/loadtest/src/lib.rs \
  apps/standalone/loadtest/src/device.rs
git -C "$WT" commit -m "feat(standalone): load test simulated device (scanner, syncer, link, stream)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 10: The database checks

**Files:**

- Create: `apps/standalone/loadtest/src/dbcheck.rs`
- Modify: `apps/standalone/loadtest/src/lib.rs`

**Interfaces:**

- Consumes: `checks::Check`, `ledger::Snapshot`, `sqlx` read-only.
- Produces: `dbcheck::Res<T>`; `open_read_only(path: &Path, immutable: bool) -> Res<SqlitePool>` (a copy is opened `immutable`: nothing writes to it and it has no log); `structural(&SqlitePool) -> Res<Vec<Check>>` (six checks that hold for any copy at any moment: `db_integrity`, `db_foreign_keys`, `sscc_unique` (no 17-digit SSCC body twice across boxes and pallets), `sscc_blocks_disjoint`, `sscc_serials_from_own_blocks` (a closed box's serial lies in a block issued to its own device), `code_never_live_twice`); `reconcile(&SqlitePool, shift: &str, devices: &[(u32, String)], ledger: &Snapshot) -> Res<Vec<Check>>` (for the live database of a quiet shift: scans, receipts, closed boxes and pallets per device, code owners, live items, `late` and `displaced` conflict rows against the ledger, no rejected receipt); `table_counts(&SqlitePool) -> Res<BTreeMap<String, i64>>` over `RESTORED_TABLES` (`scans, boxes, box_items, code_owners, code_conflicts, pallets, fact_receipts, shift_participants, sscc_blocks`); `scan_count(&SqlitePool) -> Res<i64>`.

- [ ] **Step 1: Write the failing tests.** `src/lib.rs`:

```rust
pub mod api;
pub mod checks;
pub mod dbcheck;
pub mod device;
pub mod engine;
pub mod gen;
pub mod histogram;
pub mod host;
pub mod ledger;
pub mod metrics;
pub mod procstat;
pub mod profile;
pub mod rng;
pub mod sampler;
pub mod site;
pub mod wal;
```

`src/dbcheck.rs` (tests only):

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_new_database_passes_every_structural_check_and_every_table_counts_zero() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("host.db");
        markiro_host::db::open(&path).await.unwrap().close().await;
        let pool = open_read_only(&path, false).await.unwrap();
        let checks = structural(&pool).await.unwrap();
        assert_eq!(checks.len(), 6);
        assert!(checks.iter().all(|check| check.ok), "{checks:?}");
        let counts = table_counts(&pool).await.unwrap();
        assert_eq!(counts.len(), RESTORED_TABLES.len());
        assert!(counts.values().all(|count| *count == 0));
        let checks = reconcile(&pool, "none", &[(0, "d0".to_owned())], &Snapshot::default())
            .await
            .unwrap();
        assert!(checks.iter().all(|check| check.ok), "{checks:?}");
    }
}
```

- [ ] **Step 2: Run them to verify they fail.**

Run: `cargo --offline --locked test --manifest-path "$WT/apps/standalone/Cargo.toml" -p markiro-loadtest --lib -- dbcheck::`
Expected: FAIL to compile (`cannot find function open_read_only`, `structural`).

- [ ] **Step 3: Write the implementation** above the tests module in `src/dbcheck.rs`:

```rust
//! The host's database read from outside, read-only. Two sets of checks:
//! the structural ones hold for any copy of the database at any moment (a
//! serial is never in two SSCCs, a code is never live twice, the file passes
//! SQLite's own check) and the reconciling ones hold for the live database
//! once the devices have stopped, against what the host acknowledged.

use std::collections::BTreeMap;
use std::path::Path;

use sqlx::sqlite::{SqliteConnectOptions, SqlitePool, SqlitePoolOptions};

use crate::checks::Check;
use crate::ledger::Snapshot;

pub type Res<T> = Result<T, String>;

/// A read-only pool on `path`. A copy is opened `immutable`: nothing writes
/// to it and it has no log to read.
pub async fn open_read_only(path: &Path, immutable: bool) -> Res<SqlitePool> {
    let options = SqliteConnectOptions::new()
        .filename(path)
        .read_only(true)
        .immutable(immutable);
    SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .map_err(|error| format!("open {}: {error}", path.display()))
}

async fn count(pool: &SqlitePool, sql: &str) -> Res<i64> {
    sqlx::query_scalar(sql)
        .fetch_one(pool)
        .await
        .map_err(|error| format!("{sql}: {error}"))
}

async fn count_bind(pool: &SqlitePool, sql: &str, bind: &str) -> Res<i64> {
    sqlx::query_scalar(sql)
        .bind(bind)
        .fetch_one(pool)
        .await
        .map_err(|error| format!("{sql}: {error}"))
}

/// Holds for any copy of the database, a backup mid-run included.
pub async fn structural(pool: &SqlitePool) -> Res<Vec<Check>> {
    let integrity: String = sqlx::query_scalar("PRAGMA integrity_check")
        .fetch_one(pool)
        .await
        .map_err(|error| format!("integrity_check: {error}"))?;
    let foreign: i64 = count(pool, "SELECT COUNT(*) FROM pragma_foreign_key_check").await?;
    let zero = |name: &str, found: i64| {
        Check::new(name, found == 0, format!("{found} found, none allowed"))
    };
    Ok(vec![
        Check::new(
            "db_integrity",
            integrity == "ok",
            format!("integrity_check said {integrity}"),
        ),
        zero("db_foreign_keys", foreign),
        zero(
            "sscc_unique",
            count(
                pool,
                "SELECT COUNT(*) FROM (SELECT substr(sscc, 1, 17) AS k FROM \
                 (SELECT sscc FROM boxes WHERE sscc IS NOT NULL \
                  UNION ALL SELECT sscc FROM pallets WHERE sscc IS NOT NULL) \
                 GROUP BY k HAVING COUNT(*) > 1)",
            )
            .await?,
        ),
        zero(
            "sscc_blocks_disjoint",
            count(
                pool,
                "SELECT COUNT(*) FROM sscc_blocks a JOIN sscc_blocks b ON a.id < b.id \
                 AND a.issuer_prefix = b.issuer_prefix AND a.extension = b.extension \
                 AND a.from_serial <= b.to_serial AND b.from_serial <= a.to_serial",
            )
            .await?,
        ),
        zero(
            "sscc_serials_from_own_blocks",
            count(
                pool,
                "SELECT COUNT(*) FROM boxes b JOIN sscc_blocks k ON k.id = b.block_id \
                 WHERE b.serial NOT BETWEEN k.from_serial AND k.to_serial \
                 OR b.device_id <> k.device_id",
            )
            .await?,
        ),
        zero(
            "code_never_live_twice",
            count(
                pool,
                "SELECT COUNT(*) FROM (SELECT code_hash FROM box_items \
                 WHERE removed_at IS NULL AND displaced_at IS NULL \
                 GROUP BY code_hash HAVING COUNT(*) > 1)",
            )
            .await?,
        ),
    ])
}

async fn per_device(pool: &SqlitePool, sql: &str, shift: &str) -> Res<BTreeMap<String, i64>> {
    let rows: Vec<(String, i64)> = sqlx::query_as(sql)
        .bind(shift)
        .fetch_all(pool)
        .await
        .map_err(|error| format!("{sql}: {error}"))?;
    Ok(rows.into_iter().collect())
}

/// Holds for the live database of a quiet shift: every figure is the
/// ledger's. `devices` maps the harness's device index to the host's id.
pub async fn reconcile(
    pool: &SqlitePool,
    shift: &str,
    devices: &[(u32, String)],
    ledger: &Snapshot,
) -> Res<Vec<Check>> {
    let expected = &ledger.expected;
    let mut checks = Vec::new();
    let scans = per_device(
        pool,
        "SELECT device_id, COUNT(*) FROM scans WHERE shift_id = ? GROUP BY device_id",
        shift,
    )
    .await?;
    let receipts = per_device(
        pool,
        "SELECT device_id, COUNT(*) FROM fact_receipts WHERE shift_id = ? GROUP BY device_id",
        shift,
    )
    .await?;
    let boxes = per_device(
        pool,
        "SELECT device_id, COUNT(*) FROM boxes WHERE shift_id = ? AND sscc IS NOT NULL GROUP BY device_id",
        shift,
    )
    .await?;
    let pallets = per_device(
        pool,
        "SELECT device_id, COUNT(*) FROM pallets WHERE shift_id = ? AND sscc IS NOT NULL GROUP BY device_id",
        shift,
    )
    .await?;
    for (index, id) in devices {
        let of = |map: &BTreeMap<String, i64>| map.get(id).copied().unwrap_or(0) as u64;
        let ledger_of = |map: &BTreeMap<u32, u64>| map.get(index).copied().unwrap_or(0);
        checks.push(Check::same(
            &format!("db_scans_device_{index}"),
            ledger_of(&ledger.scan_rows),
            of(&scans),
        ));
        checks.push(Check::same(
            &format!("db_receipts_device_{index}"),
            ledger_of(&ledger.records),
            of(&receipts),
        ));
        checks.push(Check::same(
            &format!("db_boxes_device_{index}"),
            ledger_of(&ledger.boxes_closed),
            of(&boxes),
        ));
        checks.push(Check::same(
            &format!("db_pallets_device_{index}"),
            ledger_of(&ledger.pallets_closed),
            of(&pallets),
        ));
    }
    checks.push(Check::same(
        "db_code_owners",
        expected.distinct_accepted_codes as i64,
        count_bind(
            pool,
            "SELECT COUNT(*) FROM code_owners WHERE shift_id = ?",
            shift,
        )
        .await?,
    ));
    checks.push(Check::same(
        "db_live_items",
        expected.distinct_accepted_codes as i64,
        count_bind(
            pool,
            "SELECT COUNT(*) FROM box_items i JOIN boxes b ON b.id = i.box_id \
             WHERE b.shift_id = ? AND i.removed_at IS NULL AND i.displaced_at IS NULL",
            shift,
        )
        .await?,
    ));
    let conflicts = |kind: &'static str| async move {
        sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM code_conflicts c JOIN scans s ON s.id = c.loser_scan_id \
             WHERE c.kind = ? AND s.shift_id = ?",
        )
        .bind(kind)
        .bind(shift)
        .fetch_one(pool)
        .await
        .map_err(|error| format!("code_conflicts {kind}: {error}"))
    };
    checks.push(Check::same(
        "db_conflicts_late",
        expected.conflict_receipts as i64,
        conflicts("late").await?,
    ));
    checks.push(Check::same(
        "db_conflicts_displaced",
        expected.displacements as i64,
        conflicts("displaced").await?,
    ));
    checks.push(Check::same(
        "db_rejected_receipts",
        0,
        count_bind(
            pool,
            "SELECT COUNT(*) FROM fact_receipts WHERE shift_id = ? AND outcome = 'rejected'",
            shift,
        )
        .await?,
    ));
    Ok(checks)
}

/// The row counts of the tables a restore must bring back whole.
pub const RESTORED_TABLES: [&str; 9] = [
    "scans",
    "boxes",
    "box_items",
    "code_owners",
    "code_conflicts",
    "pallets",
    "fact_receipts",
    "shift_participants",
    "sscc_blocks",
];

pub async fn table_counts(pool: &SqlitePool) -> Res<BTreeMap<String, i64>> {
    let mut counts = BTreeMap::new();
    for table in RESTORED_TABLES {
        counts.insert(
            table.to_owned(),
            count(pool, &format!("SELECT COUNT(*) FROM {table}")).await?,
        );
    }
    Ok(counts)
}

pub async fn scan_count(pool: &SqlitePool) -> Res<i64> {
    count(pool, "SELECT COUNT(*) FROM scans").await
}
```

- [ ] **Step 4: Run the tests to verify they pass.**

Run: `cargo --offline --locked test --manifest-path "$WT/apps/standalone/Cargo.toml" -p markiro-loadtest --lib -- dbcheck::`
Expected: PASS, 1 test (a migrated empty database passes the six structural checks, every restored table counts 0, and reconciling it against an empty ledger holds). The queries run against a populated database in Task 13.

- [ ] **Step 5: Format and commit.**

Run: `cargo fmt --manifest-path "$WT/apps/standalone/Cargo.toml" --all -- --check` (clean).

```bash
git -C "$WT" add apps/standalone/loadtest/src/lib.rs \
  apps/standalone/loadtest/src/dbcheck.rs
git -C "$WT" commit -m "feat(standalone): load test database checks (structural and reconciling)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 11: The report, the verdict, the summary and the comparison

**Files:**

- Create: `apps/standalone/loadtest/src/report.rs`
- Modify: `apps/standalone/loadtest/src/lib.rs`

**Interfaces:**

- Consumes: `checks::Check`, `device::DeviceStats`, `histogram::LatencySummary`, `host::LogScan`, `ledger::Expected`, `procstat::slope_per_hour`, `profile::{Profile, Thresholds}`, `sampler::Sample`.
- Produces: `report::SCHEMA` (1); `report::{Throughput, Resources, DrillResult { name, checks }, BackupResult { at_fraction, duration_ms, file, size_bytes, scans_in_copy, acked_before, acked_after_with_slack, checks }, RestoreResult { copy, counts, checks }, Verdict { pass, failures, warnings }, Report}` (all serde camelCase; `Report` also carries `started_at, host_kind, host_version, host_protocol, os, profile, thresholds, latency, errors, throughput, devices, expected, resources, checks, drills, backups, restore, log, graceful_stop, verdict, series`); `report::summarize(series, warmup_s) -> Resources`; `report::evaluate(&Report) -> Verdict` (every threshold of Task 2 and every failed check, as a sentence that names it); `report::render_markdown(&Report) -> String`; `report::compare(old, new) -> Vec<Regression>` and `Regression(pub String)`; under `cfg(test)`, `report::sample_passing() -> Report`.

How two runs are compared (the runbook's rules): a regression is reported when the profiles differ, the verdict went from pass to fail, the p95 or p99 of `facts` rose above 1.5 × the old plus 20 ms (`code_check` and `device_shifts` likewise with 10 and 20 ms), scans per second fell below 90 % of the old, the host's memory maximum rose above 1.25 × the old plus 16 MiB, the WAL backlog maximum above 1.5 × the old plus 1000 frames, or a class of error appeared that the old run did not have.

- [ ] **Step 1: Write the failing tests.** `src/lib.rs`:

```rust
pub mod api;
pub mod checks;
pub mod dbcheck;
pub mod device;
pub mod engine;
pub mod gen;
pub mod histogram;
pub mod host;
pub mod ledger;
pub mod metrics;
pub mod procstat;
pub mod profile;
pub mod report;
pub mod rng;
pub mod sampler;
pub mod site;
pub mod wal;
```

`src/report.rs` (the test helper and the tests only):

```rust
#[cfg(test)]
pub fn sample_passing() -> Report {
    let profile = Profile::preset("smoke").unwrap();
    let summary = |p50: f64, p99: f64| LatencySummary {
        count: 1000,
        p50_ms: p50,
        p95_ms: p99 / 2.0,
        p99_ms: p99,
        max_ms: p99 * 2.0,
        mean_ms: p50,
    };
    let mut latency = BTreeMap::new();
    latency.insert("facts".to_owned(), summary(5.0, 40.0));
    latency.insert("code_check".to_owned(), summary(1.0, 8.0));
    latency.insert("device_shifts".to_owned(), summary(3.0, 30.0));
    let devices = (0..profile.devices())
        .map(|index| DeviceStats {
            index,
            checks: 100,
            ..DeviceStats::default()
        })
        .collect();
    Report {
        schema: SCHEMA,
        started_at: "2026-10-20T10:00:00Z".to_owned(),
        host_kind: "spawn".to_owned(),
        host_version: "1.1.0".to_owned(),
        host_protocol: 7,
        os: "linux".to_owned(),
        thresholds: Thresholds::for_profile("smoke").unwrap(),
        latency,
        errors: BTreeMap::new(),
        throughput: Throughput {
            scans_generated: 5400,
            scans_per_s: 30.0,
            ideal_scans: profile.ideal_scans(),
            generated_share: 1.0,
            records_acked: 5800,
            duration_s: 180.0,
        },
        devices,
        expected: Expected::default(),
        resources: Resources {
            samples: 36,
            rss_max_mib: Some(60.0),
            fds_after_warmup: Some(30),
            fds_max: Some(34),
            fds_end: Some(31),
            wal_file_max_mib: Some(8.0),
            wal_backlog_max_frames: Some(900),
            ..Resources::default()
        },
        checks: vec![Check::new("reconcile", true, "ok")],
        drills: vec![],
        backups: vec![],
        restore: None,
        log: LogScan {
            available: true,
            ..LogScan::default()
        },
        graceful_stop: Some(true),
        verdict: Verdict::default(),
        series: vec![],
        profile,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_clean_run_passes() {
        let verdict = evaluate(&sample_passing());
        assert!(verdict.pass, "{verdict:?}");
        assert!(verdict.failures.is_empty());
    }

    #[test]
    fn every_threshold_turns_into_a_failure_that_names_it() {
        let cases: Vec<(&str, Box<dyn Fn(&mut Report)>)> = vec![
            (
                "facts p99",
                Box::new(|r| r.latency.get_mut("facts").unwrap().p99_ms = 251.0),
            ),
            (
                "facts p95",
                Box::new(|r| r.latency.get_mut("facts").unwrap().p95_ms = 101.0),
            ),
            (
                "facts max",
                Box::new(|r| r.latency.get_mut("facts").unwrap().max_ms = 2001.0),
            ),
            (
                "code check p99",
                Box::new(|r| r.latency.get_mut("code_check").unwrap().p99_ms = 151.0),
            ),
            (
                "device_shifts p99",
                Box::new(|r| r.latency.get_mut("device_shifts").unwrap().p99_ms = 501.0),
            ),
            (
                "server errors",
                Box::new(|r| {
                    r.errors.insert("facts:http_5xx".to_owned(), 1);
                }),
            ),
            ("server errors", Box::new(|r| r.log.error_lines = 1)),
            ("busy database", Box::new(|r| r.log.busy_lines = 1)),
            (
                "requests without an answer",
                Box::new(|r| {
                    r.errors.insert("facts:net_timeout".to_owned(), 1);
                }),
            ),
            (
                "requests the host refused",
                Box::new(|r| {
                    r.errors.insert("enter:http_4xx:conflict".to_owned(), 1);
                }),
            ),
            (
                "WAL backlog",
                Box::new(|r| r.resources.wal_backlog_max_frames = Some(8001)),
            ),
            (
                "WAL file",
                Box::new(|r| r.resources.wal_file_max_mib = Some(257.0)),
            ),
            ("descriptors", Box::new(|r| r.resources.fds_max = Some(89))),
            (
                "descriptors grew",
                Box::new(|r| r.resources.fds_end = Some(39)),
            ),
            (
                "ideal scans",
                Box::new(|r| r.throughput.generated_share = 0.89),
            ),
            (
                "device 2 stopped",
                Box::new(|r| r.devices[2].fatal = Some("x".to_owned())),
            ),
            (
                "resent batches",
                Box::new(|r| r.devices[0].resend_mismatches = 1),
            ),
            (
                "host did not stop",
                Box::new(|r| r.graceful_stop = Some(false)),
            ),
            (
                "check reconcile",
                Box::new(|r| {
                    r.checks
                        .push(Check::new("reconcile", false, "expected 1, got 2"))
                }),
            ),
        ];
        for (needle, mutate) in cases {
            let mut report = sample_passing();
            mutate(&mut report);
            let verdict = evaluate(&report);
            assert!(!verdict.pass, "{needle}");
            assert!(
                verdict
                    .failures
                    .iter()
                    .any(|failure| failure.contains(needle)),
                "{needle}: {:?}",
                verdict.failures
            );
        }
    }

    #[test]
    fn memory_growth_is_judged_only_for_a_long_run() {
        let mut report = sample_passing();
        report.resources.rss_slope_mib_per_hour = Some(50.0);
        assert!(
            evaluate(&report).pass,
            "a three minute run has no slope to judge"
        );
        report.profile.duration_s = 4 * 3600;
        let verdict = evaluate(&report);
        assert!(
            verdict.failures.iter().any(|f| f.contains("memory growth")),
            "{verdict:?}"
        );
        report.resources.rss_slope_mib_per_hour = Some(19.0);
        assert!(evaluate(&report).pass);
    }

    #[test]
    fn a_summary_reads_memory_descriptors_and_the_wal_from_the_series() {
        let sample = |t_s: f64, rss_mib: u64, fds: u64, backlog: u64| Sample {
            t_s,
            rss_bytes: Some(rss_mib * 1024 * 1024),
            fds: Some(fds),
            db_bytes: Some(10 * 1024 * 1024),
            wal_bytes: Some(2 * 1024 * 1024),
            wal_backlog_frames: Some(backlog),
        };
        let series = vec![
            sample(0.0, 30, 20, 10),
            sample(600.0, 40, 30, 500),
            sample(1200.0, 50, 30, 700),
            sample(1800.0, 60, 31, 100),
        ];
        let resources = summarize(&series, 600.0);
        assert_eq!(resources.rss_start_mib, Some(30.0));
        assert_eq!(resources.rss_max_mib, Some(60.0));
        assert_eq!(resources.fds_after_warmup, Some(30));
        assert_eq!((resources.fds_max, resources.fds_end), (Some(31), Some(31)));
        assert_eq!(
            (
                resources.wal_backlog_max_frames,
                resources.wal_backlog_end_frames
            ),
            (Some(700), Some(100))
        );
        assert_eq!(resources.wal_backlog_p99_frames, Some(700));
        // 10 MiB in each ten minutes after the warm-up.
        assert!((resources.rss_slope_mib_per_hour.unwrap() - 60.0).abs() < 1e-6);
        assert_eq!(summarize(&[], 0.0).samples, 0);
    }

    #[test]
    fn two_runs_are_compared_by_the_rules_of_the_runbook() {
        let mut old = sample_passing();
        old.verdict.pass = true;
        assert!(compare(&old, &old).is_empty());
        let mut new = sample_passing();
        new.latency.get_mut("facts").unwrap().p99_ms = 40.0 * 1.5 + 21.0;
        new.throughput.scans_per_s = 26.0;
        new.resources.rss_max_mib = Some(60.0 * 1.25 + 17.0);
        new.errors.insert("facts:net_timeout".to_owned(), 1);
        new.verdict.pass = false;
        let found: Vec<String> = compare(&old, &new)
            .into_iter()
            .map(|Regression(text)| text)
            .collect();
        for needle in [
            "facts p99",
            "scans per second",
            "host memory",
            "new class of error",
            "pass to fail",
        ] {
            assert!(
                found.iter().any(|text| text.contains(needle)),
                "{needle}: {found:?}"
            );
        }
        let mut other = sample_passing();
        other.profile.name = "soak".to_owned();
        assert!(compare(&old, &other)
            .iter()
            .any(|r| r.0.contains("profiles differ")));
    }

    #[test]
    fn the_markdown_says_the_verdict_and_lists_the_failures() {
        let mut report = sample_passing();
        report.latency.get_mut("facts").unwrap().p99_ms = 900.0;
        report.verdict = evaluate(&report);
        let text = render_markdown(&report);
        assert!(text.starts_with("# Load run `smoke`: FAIL"));
        assert!(text.contains("## Failures"));
        assert!(text.contains("facts p99"));
        assert!(text.contains("| facts | 1000 |"));
    }

    #[test]
    fn a_report_survives_its_own_json() {
        let mut report = sample_passing();
        report.verdict = evaluate(&report);
        let text = serde_json::to_string_pretty(&report).unwrap();
        let back: Report = serde_json::from_str(&text).unwrap();
        assert_eq!(back, report);
    }
}
```

- [ ] **Step 2: Run them to verify they fail.**

Run: `cargo --offline --locked test --manifest-path "$WT/apps/standalone/Cargo.toml" -p markiro-loadtest --lib -- report::`
Expected: FAIL to compile (`cannot find type Report`, `evaluate`).

- [ ] **Step 3: Write the implementation** above the test helper in `src/report.rs`:

```rust
//! What a run leaves behind: a JSON report (everything, for comparing runs
//! and for tools) and a short Markdown summary (for a person), both written
//! to a folder outside the repository, and the verdict that turns the numbers
//! into pass or fail by the profile's thresholds.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::checks::Check;
use crate::device::DeviceStats;
use crate::histogram::LatencySummary;
use crate::host::LogScan;
use crate::ledger::Expected;
use crate::procstat::slope_per_hour;
use crate::profile::{Profile, Thresholds};
use crate::sampler::Sample;

pub const SCHEMA: u32 = 1;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Throughput {
    pub scans_generated: u64,
    pub scans_per_s: f64,
    pub ideal_scans: f64,
    pub generated_share: f64,
    pub records_acked: u64,
    pub duration_s: f64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Resources {
    pub samples: usize,
    pub rss_start_mib: Option<f64>,
    pub rss_max_mib: Option<f64>,
    pub rss_end_mib: Option<f64>,
    pub rss_slope_mib_per_hour: Option<f64>,
    pub fds_after_warmup: Option<u64>,
    pub fds_max: Option<u64>,
    pub fds_end: Option<u64>,
    pub wal_file_max_mib: Option<f64>,
    pub wal_backlog_max_frames: Option<u64>,
    pub wal_backlog_p99_frames: Option<u64>,
    pub wal_backlog_end_frames: Option<u64>,
    pub db_end_mib: Option<f64>,
}

const MIB: f64 = 1024.0 * 1024.0;

/// The figures of a series. `warmup_s` is the time before which a sample is
/// the host settling down: the slope and the descriptor baseline start after it.
pub fn summarize(series: &[Sample], warmup_s: f64) -> Resources {
    let mib = |bytes: u64| bytes as f64 / MIB;
    let rss: Vec<(f64, u64)> = series
        .iter()
        .filter_map(|s| s.rss_bytes.map(|b| (s.t_s, b)))
        .collect();
    let steady: Vec<(f64, f64)> = rss
        .iter()
        .filter(|(t, _)| *t >= warmup_s)
        .map(|(t, b)| (*t, mib(*b)))
        .collect();
    let fds: Vec<(f64, u64)> = series
        .iter()
        .filter_map(|s| s.fds.map(|f| (s.t_s, f)))
        .collect();
    let mut backlog: Vec<u64> = series.iter().filter_map(|s| s.wal_backlog_frames).collect();
    backlog.sort_unstable();
    let p99 = (!backlog.is_empty()).then(|| {
        backlog[((backlog.len() as f64 * 0.99).ceil() as usize).clamp(1, backlog.len()) - 1]
    });
    Resources {
        samples: series.len(),
        rss_start_mib: rss.first().map(|(_, b)| mib(*b)),
        rss_max_mib: rss
            .iter()
            .map(|(_, b)| mib(*b))
            .fold(None, |m: Option<f64>, v| Some(m.map_or(v, |m| m.max(v)))),
        rss_end_mib: rss.last().map(|(_, b)| mib(*b)),
        rss_slope_mib_per_hour: (steady.len() >= 3).then(|| slope_per_hour(&steady)),
        fds_after_warmup: fds
            .iter()
            .find(|(t, _)| *t >= warmup_s)
            .or(fds.first())
            .map(|(_, f)| *f),
        fds_max: fds.iter().map(|(_, f)| *f).max(),
        fds_end: fds.last().map(|(_, f)| *f),
        wal_file_max_mib: series.iter().filter_map(|s| s.wal_bytes).max().map(mib),
        wal_backlog_max_frames: backlog.last().copied(),
        wal_backlog_p99_frames: p99,
        wal_backlog_end_frames: series.iter().rev().find_map(|s| s.wal_backlog_frames),
        db_end_mib: series.iter().rev().find_map(|s| s.db_bytes).map(mib),
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DrillResult {
    pub name: String,
    pub checks: Vec<Check>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupResult {
    pub at_fraction: f64,
    pub duration_ms: u64,
    pub file: String,
    pub size_bytes: u64,
    pub scans_in_copy: i64,
    pub acked_before: u64,
    pub acked_after_with_slack: u64,
    pub checks: Vec<Check>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreResult {
    pub copy: String,
    pub counts: BTreeMap<String, i64>,
    pub checks: Vec<Check>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Verdict {
    pub pass: bool,
    pub failures: Vec<String>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub schema: u32,
    pub started_at: String,
    pub host_kind: String,
    pub host_version: String,
    pub host_protocol: u64,
    pub os: String,
    pub profile: Profile,
    pub thresholds: Thresholds,
    pub latency: BTreeMap<String, LatencySummary>,
    pub errors: BTreeMap<String, u64>,
    pub throughput: Throughput,
    pub devices: Vec<DeviceStats>,
    pub expected: Expected,
    pub resources: Resources,
    pub checks: Vec<Check>,
    pub drills: Vec<DrillResult>,
    pub backups: Vec<BackupResult>,
    pub restore: Option<RestoreResult>,
    pub log: LogScan,
    /// `None` where a stop on request is not possible (Windows, in-process).
    pub graceful_stop: Option<bool>,
    pub verdict: Verdict,
    pub series: Vec<Sample>,
}

fn latency_of<'a>(report: &'a Report, route: &str) -> Option<&'a LatencySummary> {
    report
        .latency
        .get(route)
        .filter(|summary| summary.count > 0)
}

fn over(name: &str, limit: f64, actual: f64, unit: &str) -> Option<String> {
    (actual > limit).then(|| format!("{name}: {actual:.1} {unit} is above {limit:.1} {unit}"))
}

/// Every threshold and every check, turned into the list of what failed.
pub fn evaluate(report: &Report) -> Verdict {
    let t = &report.thresholds;
    let mut failures = Vec::new();
    let mut warnings = Vec::new();
    if let Some(facts) = latency_of(report, "facts") {
        failures.extend(over("facts p95", t.facts_p95_ms, facts.p95_ms, "ms"));
        failures.extend(over("facts p99", t.facts_p99_ms, facts.p99_ms, "ms"));
        failures.extend(over("facts max", t.facts_max_ms, facts.max_ms, "ms"));
    } else {
        failures.push("facts: no request was measured".to_owned());
    }
    if let Some(backup) = latency_of(report, "facts_during_backup") {
        failures.extend(over(
            "facts p99 during a backup",
            t.facts_backup_p99_ms,
            backup.p99_ms,
            "ms",
        ));
    }
    if let Some(check) = latency_of(report, "code_check") {
        failures.extend(over(
            "code check p99",
            t.code_check_p99_ms,
            check.p99_ms,
            "ms",
        ));
    }
    let checks: u64 = report.devices.iter().map(|device| device.checks).sum();
    let timeouts: u64 = report
        .devices
        .iter()
        .map(|device| device.check_timeouts)
        .sum();
    if checks > 0 {
        failures.extend(over(
            "code checks over 300 ms",
            t.code_check_over_300ms_share * 100.0,
            timeouts as f64 / checks as f64 * 100.0,
            "% of checks",
        ));
    }
    for route in ["device_shifts", "sscc_block", "enter"] {
        if let Some(summary) = latency_of(report, route) {
            failures.extend(over(
                &format!("{route} p99"),
                t.other_p99_ms,
                summary.p99_ms,
                "ms",
            ));
        }
    }
    let by_class = |tail: &str| -> u64 {
        report
            .errors
            .iter()
            .filter(|(key, _)| key.contains(&format!(":{tail}")))
            .map(|(_, count)| count)
            .sum()
    };
    let server = by_class("http_5xx") + report.log.error_lines;
    if server > t.server_errors {
        failures.push(format!(
            "server errors: {server} (5xx answers and ERROR lines of the log), at most {}",
            t.server_errors
        ));
    }
    if report.log.busy_lines > t.busy_errors {
        failures.push(format!(
            "busy database: {} log lines, at most {}",
            report.log.busy_lines, t.busy_errors
        ));
    }
    let net = by_class("net_");
    if net > t.net_errors {
        failures.push(format!(
            "requests without an answer: {net}, at most {}",
            t.net_errors
        ));
    }
    let client = by_class("http_4xx");
    if client > t.client_errors {
        failures.push(format!(
            "requests the host refused: {client}, at most {}",
            t.client_errors
        ));
    }
    let r = &report.resources;
    if let Some(max) = r.wal_backlog_max_frames {
        if max > t.wal_backlog_max_frames {
            failures.push(format!(
                "WAL backlog: {max} frames, at most {}",
                t.wal_backlog_max_frames
            ));
        }
    } else if report.host_kind != "attach" {
        warnings.push("the WAL backlog could not be read".to_owned());
    }
    if let Some(mib) = r.wal_file_max_mib {
        failures.extend(over("WAL file", t.wal_file_max_mib as f64, mib, "MiB"));
    }
    if report.profile.duration_s >= t.slope_min_duration_s {
        match r.rss_slope_mib_per_hour {
            Some(slope) => failures.extend(over(
                "host memory growth",
                t.rss_slope_mib_per_hour,
                slope,
                "MiB/h",
            )),
            None => warnings.push("no memory figure: the growth was not judged".to_owned()),
        }
    }
    if let (Some(max), Some(base), Some(end)) = (r.fds_max, r.fds_after_warmup, r.fds_end) {
        let allowed = t.fd_fixed + t.fd_per_device * u64::from(report.profile.devices());
        if max > allowed {
            failures.push(format!(
                "descriptors: {max} at most open, {allowed} allowed"
            ));
        }
        if end > base + t.fd_growth_max {
            failures.push(format!(
                "descriptors grew from {base} to {end}, by at most {}",
                t.fd_growth_max
            ));
        }
    }
    if report.throughput.generated_share < t.generated_share_min {
        failures.push(format!(
            "the devices made {:.0} % of the ideal scans, at least {:.0} % expected",
            report.throughput.generated_share * 100.0,
            t.generated_share_min * 100.0
        ));
    }
    for device in &report.devices {
        if let Some(fatal) = &device.fatal {
            failures.push(format!("device {} stopped: {fatal}", device.index));
        }
        if device.resend_mismatches > 0 {
            failures.push(format!(
                "device {}: {} resent batches were not answered alike",
                device.index, device.resend_mismatches
            ));
        }
        if device.check_surprises > 0 {
            failures.push(format!(
                "device {}: {} code checks answered against the registry",
                device.index, device.check_surprises
            ));
        }
        if device.totals_regressions > 0 {
            failures.push(format!(
                "device {}: the shift's total went down {} times",
                device.index, device.totals_regressions
            ));
        }
        if device.poll_sum_mismatches > 0 {
            warnings.push(format!(
                "device {}: {} totals polls where byDevice did not add up (the host reads them in separate queries?)",
                device.index, device.poll_sum_mismatches
            ));
        }
    }
    if report.devices.iter().any(|device| device.stalls > 0) {
        warnings
            .push("a scanner waited for an SSCC serial: the half rule did not keep up".to_owned());
    }
    if report.graceful_stop == Some(false) {
        failures.push("the host did not stop on request".to_owned());
    }
    let mut failed = |scope: &str, checks: &[Check]| {
        for check in checks.iter().filter(|check| !check.ok) {
            failures.push(format!("{scope} {}: {}", check.name, check.detail));
        }
    };
    failed("check", &report.checks);
    for drill in &report.drills {
        failed(&format!("drill {}", drill.name), &drill.checks);
    }
    for backup in &report.backups {
        failed(
            &format!("backup at {:.0} %", backup.at_fraction * 100.0),
            &backup.checks,
        );
    }
    if let Some(restore) = &report.restore {
        failed("restore", &restore.checks);
    }
    Verdict {
        pass: failures.is_empty(),
        failures,
        warnings,
    }
}

pub fn render_markdown(report: &Report) -> String {
    use std::fmt::Write;
    let mut out = String::new();
    let verdict = if report.verdict.pass { "PASS" } else { "FAIL" };
    let profile = &report.profile;
    let _ = writeln!(out, "# Load run `{}`: {verdict}\n", profile.name);
    let _ = writeln!(
        out,
        "{} stations + {} handhelds, {} scans/s each, {} s. Host {} (protocol {}), {}, {}.\n",
        profile.stations,
        profile.handhelds,
        profile.scan_rate,
        profile.duration_s,
        report.host_version,
        report.host_protocol,
        report.host_kind,
        report.os
    );
    if !report.verdict.failures.is_empty() {
        let _ = writeln!(out, "## Failures\n");
        for failure in &report.verdict.failures {
            let _ = writeln!(out, "- {failure}");
        }
        out.push('\n');
    }
    if !report.verdict.warnings.is_empty() {
        let _ = writeln!(out, "## Warnings\n");
        for warning in &report.verdict.warnings {
            let _ = writeln!(out, "- {warning}");
        }
        out.push('\n');
    }
    let _ = writeln!(out, "## Latency (ms)\n\n| route | count | p50 | p95 | p99 | max |\n|---|---:|---:|---:|---:|---:|");
    for (route, s) in &report.latency {
        let _ = writeln!(
            out,
            "| {route} | {} | {:.1} | {:.1} | {:.1} | {:.1} |",
            s.count, s.p50_ms, s.p95_ms, s.p99_ms, s.max_ms
        );
    }
    let t = &report.throughput;
    let _ = writeln!(
        out,
        "\n## Throughput\n\n{} scans made ({:.1}/s, {:.0} % of the ideal), {} records acknowledged.\n",
        t.scans_generated, t.scans_per_s, t.generated_share * 100.0, t.records_acked
    );
    let e = &report.expected;
    let _ = writeln!(
        out,
        "## Reconciliation\n\n{} distinct codes accepted, {} conflicts, {} displacements, {} boxes and {} pallets closed; {} of {} checks held.\n",
        e.distinct_accepted_codes, e.conflict_receipts, e.displacements, e.boxes_closed, e.pallets_closed,
        report.checks.iter().filter(|check| check.ok).count(), report.checks.len()
    );
    let r = &report.resources;
    let fmt = |value: Option<f64>| value.map_or("n/a".to_owned(), |v| format!("{v:.1}"));
    let fmt_u = |value: Option<u64>| value.map_or("n/a".to_owned(), |v| v.to_string());
    let _ = writeln!(
        out,
        "## Host\n\nMemory {} / {} / {} MiB (start / max / end), slope {} MiB/h; descriptors max {}, end {}; \
         WAL file max {} MiB, backlog max {} frames (p99 {}, end {}); database {} MiB.\n",
        fmt(r.rss_start_mib), fmt(r.rss_max_mib), fmt(r.rss_end_mib), fmt(r.rss_slope_mib_per_hour),
        fmt_u(r.fds_max), fmt_u(r.fds_end), fmt(r.wal_file_max_mib),
        fmt_u(r.wal_backlog_max_frames), fmt_u(r.wal_backlog_p99_frames), fmt_u(r.wal_backlog_end_frames), fmt(r.db_end_mib)
    );
    let _ = writeln!(out, "## Under load and at the end\n");
    for backup in &report.backups {
        let _ = writeln!(
            out,
            "- backup at {:.0} %: {} ms, {} bytes, {} scans in the copy (acknowledged before: {}), {}",
            backup.at_fraction * 100.0, backup.duration_ms, backup.size_bytes, backup.scans_in_copy, backup.acked_before,
            if backup.checks.iter().all(|check| check.ok) { "held" } else { "FAILED" }
        );
    }
    if let Some(restore) = &report.restore {
        let _ = writeln!(
            out,
            "- restore round-trip: {}",
            if restore.checks.iter().all(|check| check.ok) {
                "counts equal"
            } else {
                "FAILED"
            }
        );
    }
    for drill in &report.drills {
        let _ = writeln!(
            out,
            "- drill {}: {}",
            drill.name,
            if drill.checks.iter().all(|check| check.ok) {
                "held"
            } else {
                "FAILED"
            }
        );
    }
    out
}

/// A change from the older report to the newer that a person must look at.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Regression(pub String);

/// The rules of «better or worse» between two runs of one profile.
pub fn compare(old: &Report, new: &Report) -> Vec<Regression> {
    let mut found = Vec::new();
    if old.profile.name != new.profile.name {
        found.push(Regression(format!(
            "the profiles differ: {} and {}",
            old.profile.name, new.profile.name
        )));
    }
    if old.verdict.pass && !new.verdict.pass {
        found.push(Regression("the verdict went from pass to fail".to_owned()));
    }
    for (route, factor, slack) in [
        ("facts", 1.5, 20.0),
        ("code_check", 1.5, 10.0),
        ("device_shifts", 1.5, 20.0),
    ] {
        if let (Some(a), Some(b)) = (latency_of(old, route), latency_of(new, route)) {
            for (name, before, after) in [("p95", a.p95_ms, b.p95_ms), ("p99", a.p99_ms, b.p99_ms)]
            {
                if after > before * factor + slack {
                    found.push(Regression(format!(
                        "{route} {name}: {before:.1} ms to {after:.1} ms"
                    )));
                }
            }
        }
    }
    if new.throughput.scans_per_s < old.throughput.scans_per_s * 0.9 {
        found.push(Regression(format!(
            "scans per second: {:.1} to {:.1}",
            old.throughput.scans_per_s, new.throughput.scans_per_s
        )));
    }
    if let (Some(a), Some(b)) = (old.resources.rss_max_mib, new.resources.rss_max_mib) {
        if b > a * 1.25 + 16.0 {
            found.push(Regression(format!(
                "host memory at most: {a:.0} MiB to {b:.0} MiB"
            )));
        }
    }
    if let (Some(a), Some(b)) = (
        old.resources.wal_backlog_max_frames,
        new.resources.wal_backlog_max_frames,
    ) {
        if b as f64 > a as f64 * 1.5 + 1000.0 {
            found.push(Regression(format!(
                "WAL backlog at most: {a} to {b} frames"
            )));
        }
    }
    for class in new.errors.keys() {
        if !old.errors.contains_key(class) {
            found.push(Regression(format!("a new class of error: {class}")));
        }
    }
    found
}
```

- [ ] **Step 4: Run the tests to verify they pass.**

Run: `cargo --offline --locked test --manifest-path "$WT/apps/standalone/Cargo.toml" -p markiro-loadtest --lib -- report::`
Expected: PASS, 7 tests: a clean run passes; each of 19 mutations (a latency, an error class, a log line, the WAL, descriptors, the share of scans, a stopped device, a failed check, …) fails the verdict with a sentence that names it; memory growth is judged only for a run of at least 30 minutes; the summary reads memory, descriptors and the WAL from a series; two runs compare by the rules above; the Markdown says the verdict and lists the failures; a report survives its own JSON.

- [ ] **Step 5: Format and commit.**

Run: `cargo fmt --manifest-path "$WT/apps/standalone/Cargo.toml" --all -- --check` (clean).

```bash
git -C "$WT" add apps/standalone/loadtest/src/lib.rs \
  apps/standalone/loadtest/src/report.rs
git -C "$WT" commit -m "feat(standalone): load test report, verdict, summary and run comparison

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 12: The backup and restore probes and the five drills

**Files:**

- Create: `apps/standalone/loadtest/src/probes.rs`, `apps/standalone/loadtest/src/drills.rs`
- Modify: `apps/standalone/loadtest/src/lib.rs`

**Interfaces:**

- Consumes: `api::{Api, Auth}`, `checks::Check`, `dbcheck`, `device::Shared`, `engine::{Engine, EngineCfg, Block}`, `gen`, `host::Host`, `metrics::{Metrics, Route}`, `profile::{CloseOrder, Profile}`, `report::{BackupResult, DrillResult, RestoreResult}`, `rng::Rng`, `site::{Office, Res, Site, ShiftInfo, DeviceSpec, plan_and_enter}`, `markiro_host::restore::{restore_now, IdentityChoice, RestoreOptions}`.
- Produces: `probes::backup(office: &Office, data_dir: &Path, shared: &Shared, at_fraction: f64, outside_the_ledger: u64) -> Res<(BackupResult, PathBuf)>` (asks `POST /v1/office/backups`, expects 202, polls `GET /v1/office/backups` until nothing runs and a new copy is listed, opens it `immutable`, judges it by D8; while it waits the facts route is also counted as `facts_during_backup`); `probes::restore_roundtrip(live_dir, copy, work, device_key, shift_id, expected_total, metrics) -> Res<RestoreResult>` (restores into `<work>/restored`, compares the nine tables' counts with the live database, starts a host in this process on the restored folder and reads the shift's total through a device key the copy kept); `drills::scans_made(profile, devices) -> u64`; `drills::closing_order(devices, order, rng) -> Vec<usize>`; `drills::run_all(site, profile, run) -> Vec<DrillResult>` (`close-stations-first`, `close-handhelds-first`, `close-shuffled`, `force-close`, `missing-reason`).

`probes.rs` has no unit test: a backup needs a running host and is exercised by Task 13's self-test (a backup under load and a last one) and Task 17's runs. The drill tests below cover the pure part (the order of closing and the count of scans a drill makes); the rest of `drills.rs` runs in the same self-test.

- [ ] **Step 1: Write the failing tests.** `src/lib.rs`:

```rust
pub mod api;
pub mod checks;
pub mod dbcheck;
pub mod device;
pub mod drills;
pub mod engine;
pub mod gen;
pub mod histogram;
pub mod host;
pub mod ledger;
pub mod metrics;
pub mod probes;
pub mod procstat;
pub mod profile;
pub mod report;
pub mod rng;
pub mod sampler;
pub mod site;
pub mod wal;
```

`src/drills.rs` (tests only):

```rust
#[cfg(test)]
mod tests {
    use markiro_proto::DeviceKind;

    use super::*;

    fn devices() -> Vec<DeviceSpec> {
        [
            DeviceKind::Station,
            DeviceKind::Handheld,
            DeviceKind::Station,
            DeviceKind::Handheld,
        ]
        .into_iter()
        .enumerate()
        .map(|(index, kind)| DeviceSpec {
            index: index as u32,
            kind,
            id: format!("d{index}"),
            key: String::new(),
            name: String::new(),
        })
        .collect()
    }

    #[test]
    fn the_close_orders_put_stations_and_handhelds_where_they_say() {
        let devices = devices();
        let mut rng = Rng::new(1);
        assert_eq!(
            closing_order(&devices, CloseOrder::StationsFirst, &mut rng),
            vec![0, 2, 1, 3]
        );
        assert_eq!(
            closing_order(&devices, CloseOrder::HandheldsFirst, &mut rng),
            vec![1, 3, 0, 2]
        );
        let mut shuffled = closing_order(&devices, CloseOrder::Shuffled, &mut rng);
        shuffled.sort_unstable();
        assert_eq!(shuffled, vec![0, 1, 2, 3]);
        assert_eq!(
            closing_order(&devices, CloseOrder::Shuffled, &mut Rng::new(5)),
            closing_order(&devices, CloseOrder::Shuffled, &mut Rng::new(5))
        );
    }

    #[test]
    fn the_drills_scans_are_counted_for_the_last_backup() {
        let smoke = Profile::preset("smoke").unwrap();
        // 25 scans a device, six devices, five drills, and the three late ones.
        assert_eq!(scans_made(&smoke, 6), 5 * 6 * 25 + 3);
    }
}
```

- [ ] **Step 2: Run them to verify they fail.**

Run: `cargo --offline --locked test --manifest-path "$WT/apps/standalone/Cargo.toml" -p markiro-loadtest --lib -- drills::`
Expected: FAIL to compile (`cannot find function closing_order`, `scans_made`).

- [ ] **Step 3: Write the implementation.** `src/drills.rs`, above its tests:

```rust
//! The ways a shared shift ends, each on a shift of its own with a few
//! scans: the devices close their parts in each order, the office closes
//! the whole shift while one part is open (and the part's later scans are
//! late, not lost), and the last closer who gives no reason leaves the
//! office to give it.

use std::sync::Arc;

use serde_json::{json, Value};

use crate::checks::Check;
use crate::engine::{Block, Engine, EngineCfg};
use crate::gen::{self, DeviceClock};
use crate::profile::{CloseOrder, Profile};
use crate::report::DrillResult;
use crate::rng::Rng;
use crate::site::{plan_and_enter, DeviceSpec, Res, ShiftInfo, Site};

/// Scans each device makes in a drill: two full boxes and one more.
fn scans_per_device(profile: &Profile) -> u32 {
    2 * profile.box_capacity + 1
}

/// The scans every drill makes together: five drills of every device, and
/// the three late scans of the forced close.
pub fn scans_made(profile: &Profile, devices: usize) -> u64 {
    5 * devices as u64 * u64::from(scans_per_device(profile)) + 3
}

/// The indices of `devices` in the order they close in.
pub fn closing_order(devices: &[DeviceSpec], order: CloseOrder, rng: &mut Rng) -> Vec<usize> {
    let mut indices: Vec<usize> = (0..devices.len()).collect();
    match order {
        CloseOrder::StationsFirst => indices.sort_by_key(|at| (devices[*at].is_handheld(), *at)),
        CloseOrder::HandheldsFirst => indices.sort_by_key(|at| (!devices[*at].is_handheld(), *at)),
        CloseOrder::Shuffled => {
            for at in (1..indices.len()).rev() {
                indices.swap(at, rng.range(0, at as u64 + 1) as usize);
            }
        }
    }
    indices
}

/// What a device did in a drill.
struct Work {
    boxes: u32,
}

/// `scans` scans of fresh codes into boxes, the boxes and pallets closed,
/// everything sent in order. Every receipt must be `accepted`.
async fn work(
    site: &Site,
    device: &DeviceSpec,
    shift: &ShiftInfo,
    profile: &Profile,
    run: u32,
    scans: u32,
) -> Res<Work> {
    let cfg = EngineCfg {
        device: device.index,
        run,
        shift_id: shift.id.clone(),
        issuer_prefix: shift.issuer_prefix.clone(),
        box_capacity: profile.box_capacity,
        pallet_boxes: profile.pallet_boxes,
        box_block_size: profile.box_block_size,
        pallet_block_size: profile.pallet_block_size,
    };
    let mut engine = Engine::new(
        cfg,
        profile.seed ^ u64::from(run) ^ (u64::from(device.index) << 32),
    );
    let api = &site.office.api;
    for extension in [0u8, 1] {
        if extension == 1 && profile.pallet_boxes == 0 {
            continue;
        }
        let request_id = engine.fresh_id();
        let reply = api
            .send(
                crate::metrics::Route::SsccBlock,
                "POST",
                "/v1/device/sscc/blocks",
                crate::api::Auth { device_key: Some(&device.key), session: None },
                Some(&json!({ "requestId": request_id, "issuerPrefix": shift.issuer_prefix, "extension": extension })),
            )
            .await
            .map_err(|error| format!("sscc block: {error:?}"))?;
        let field = |name: &str| reply.body.get(name).and_then(Value::as_u64);
        let (Some(from), Some(to), Some(id)) = (
            field("fromSerial"),
            field("toSerial"),
            reply.body.get("id").and_then(Value::as_str),
        ) else {
            return Err(format!("sscc block: {} {}", reply.status, reply.body));
        };
        engine.add_block(extension, Block::new(id, from, to));
    }
    for _ in 0..scans {
        let code = engine.next_code();
        engine.scan_ok(&code, None);
    }
    if !engine.close_open() {
        return Err(
            "a drill's block ran out of serials: raise boxBlockSize or palletBlockSize".to_owned(),
        );
    }
    loop {
        let batch = engine.batch(100);
        if batch.is_empty() {
            break;
        }
        let records: Vec<Value> = batch.iter().map(|queued| queued.record.clone()).collect();
        let receipts = api.facts(&device.key, &records).await?;
        if let Some(bad) = receipts
            .iter()
            .find(|receipt| receipt["outcome"] != "accepted")
        {
            return Err(format!("a drill's fact was not accepted: {bad}"));
        }
        engine.ack(batch.len());
    }
    Ok(Work {
        boxes: engine.boxes_closed as u32,
    })
}

/// A device's close of its part, straight to the host.
async fn close(
    site: &Site,
    device: &DeviceSpec,
    shift: &str,
    planned: Option<u32>,
    actual: u32,
    boxes: u32,
    reason: Option<&str>,
) -> Res<Value> {
    // The record's id is the device's and the shift's own: a drill on another
    // shift must not meet this one's receipt (the same id with another payload
    // is a `payload_mismatch`).
    let seed = shift.bytes().fold(0xC105E_u64, |seed, byte| {
        seed.wrapping_mul(131).wrapping_add(u64::from(byte))
    });
    let mut rng = Rng::new(seed ^ u64::from(device.index));
    let mut clock = DeviceClock::new();
    let data = gen::shift_closed(planned, actual, boxes, reason, &clock.tick());
    let record = gen::record(
        &rng.uuid(),
        markiro_proto::FactKind::ShiftClosed,
        shift,
        data,
    );
    let mut receipts = site.office.api.facts(&device.key, &[record]).await?;
    Ok(receipts.remove(0))
}

async fn office_shift(site: &Site, shift: &str) -> Res<Value> {
    site.office
        .ok("GET", &format!("/v1/office/shifts/{shift}"), None)
        .await
}

fn states(office: &Value) -> Vec<String> {
    office
        .get("participants")
        .and_then(Value::as_array)
        .map(|parts| {
            parts
                .iter()
                .filter_map(|part| part["state"].as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

struct Drill<'a> {
    site: &'a Site,
    profile: &'a Profile,
    run: u32,
}

impl Drill<'_> {
    /// A fresh shift with every device's work done, and the shift's total checked.
    async fn start(&self, planned: Option<u32>) -> Res<(ShiftInfo, Vec<Work>, Vec<Check>)> {
        let shift = plan_and_enter(self.site, self.profile, planned).await?;
        let scans = scans_per_device(self.profile);
        let site = Arc::new(self.site.clone());
        let mut tasks = Vec::new();
        for device in &self.site.devices {
            let (site, device) = (site.clone(), device.clone());
            let (shift, profile, run) = (shift.clone(), self.profile.clone(), self.run);
            tasks.push(tokio::spawn(async move {
                work(&site, &device, &shift, &profile, run, scans).await
            }));
        }
        let mut works = Vec::new();
        for task in tasks {
            works.push(task.await.map_err(|error| error.to_string())??);
        }
        let expected = u64::from(scans) * works.len() as u64;
        let office = office_shift(self.site, &shift.id).await?;
        let checks = vec![
            Check::same(
                "units_of_the_shift",
                expected,
                office
                    .pointer("/totals/acceptedUnits")
                    .and_then(Value::as_u64)
                    .unwrap_or(0),
            ),
            Check::same(
                "participants_active",
                vec!["active".to_owned(); works.len()],
                states(&office),
            ),
        ];
        Ok((shift, works, checks))
    }
}

/// Every device closes its part, in `order`; the last closer closes the shift.
async fn order_drill(
    site: &Site,
    profile: &Profile,
    run: u32,
    name: &str,
    order: CloseOrder,
) -> DrillResult {
    let drill = Drill { site, profile, run };
    let outcome: Res<Vec<Check>> = async {
        let (shift, works, mut checks) = drill.start(None).await?;
        let scans = scans_per_device(profile);
        let mut rng = Rng::new(profile.seed ^ u64::from(run));
        let sequence = closing_order(&site.devices, order, &mut rng);
        for (position, at) in sequence.iter().enumerate() {
            let receipt = close(
                site,
                &site.devices[*at],
                &shift.id,
                None,
                scans,
                works[*at].boxes,
                None,
            )
            .await?;
            let last = position + 1 == sequence.len();
            let part_closed = receipt.pointer("/details/partClosed") == Some(&Value::Bool(true));
            checks.push(Check::same(
                &format!("close_{position}_outcome"),
                "accepted",
                receipt["outcome"].as_str().unwrap_or(""),
            ));
            checks.push(Check::same(
                &format!("close_{position}_closes_only_the_part"),
                !last,
                part_closed,
            ));
            let office = office_shift(site, &shift.id).await?;
            checks.push(Check::same(
                &format!("status_after_close_{position}"),
                if last { "closed" } else { "active" },
                office["status"].as_str().unwrap_or(""),
            ));
        }
        let office = office_shift(site, &shift.id).await?;
        checks.push(Check::same(
            "participants_closed",
            vec!["closed".to_owned(); works.len()],
            states(&office),
        ));
        Ok(checks)
    }
    .await;
    result(name, outcome)
}

/// The office closes the shift while the last device has not: its later scans are accepted as late.
async fn force_drill(site: &Site, profile: &Profile, run: u32) -> DrillResult {
    let drill = Drill { site, profile, run };
    let outcome: Res<Vec<Check>> = async {
        let (shift, works, mut checks) = drill.start(None).await?;
        let scans = scans_per_device(profile);
        let held = site.devices.len() - 1;
        for at in 0..held {
            close(site, &site.devices[at], &shift.id, None, scans, works[at].boxes, None).await?;
        }
        let office = office_shift(site, &shift.id).await?;
        checks.push(Check::same("status_before_the_forced_close", "active", office["status"].as_str().unwrap_or("")));
        let closed = site
            .office
            .ok(
                "POST",
                &format!("/v1/office/shifts/{}/close", shift.id),
                Some(json!({ "reason": "Нагрузочная проверка принудительного закрытия", "expectedRev": office["rev"] })),
            )
            .await?;
        checks.push(Check::same("status_after_the_forced_close", "closed", closed["status"].as_str().unwrap_or("")));
        checks.push(Check::same("participants_closed", vec!["closed".to_owned(); site.devices.len()], states(&closed)));
        // The part that was still open sends its codes: late, accepted, nothing reopens.
        let mut engine = Engine::new(
            EngineCfg {
                device: site.devices[held].index,
                run: run + 500,
                shift_id: shift.id.clone(),
                issuer_prefix: shift.issuer_prefix.clone(),
                box_capacity: profile.box_capacity,
                pallet_boxes: 0,
                box_block_size: profile.box_block_size,
                pallet_block_size: profile.pallet_block_size,
            },
            profile.seed ^ 0x1A7E,
        );
        for _ in 0..3 {
            let code = engine.next_code();
            engine.scan_ok(&code, None);
        }
        let records: Vec<Value> = engine.batch(10).iter().map(|queued| queued.record.clone()).collect();
        let receipts = site.office.api.facts(&site.devices[held].key, &records).await?;
        checks.push(Check::same("late_scans_accepted", 3usize, receipts.iter().filter(|r| r["outcome"] == "accepted").count()));
        let office = office_shift(site, &shift.id).await?;
        checks.push(Check::same("status_after_late_scans", "closed", office["status"].as_str().unwrap_or("")));
        Ok(checks)
    }
    .await;
    result("force-close", outcome)
}

/// The plan differs from what was made and the last closer gives no reason:
/// the shift closes, says so, and the office gives the reason afterwards.
async fn missing_reason_drill(site: &Site, profile: &Profile, run: u32) -> DrillResult {
    let drill = Drill { site, profile, run };
    let outcome: Res<Vec<Check>> = async {
        let scans = scans_per_device(profile);
        let total = scans * site.devices.len() as u32;
        let planned = total + 7;
        let (shift, works, mut checks) = drill.start(Some(planned)).await?;
        let last = site.devices.len() - 1;
        let mut receipts = Vec::new();
        for at in 0..site.devices.len() {
            receipts.push(close(site, &site.devices[at], &shift.id, Some(planned), scans, works[at].boxes, None).await?);
        }
        checks.push(Check::same(
            "last_receipt_says_the_reason_is_missing",
            true,
            receipts[last].pointer("/details/reasonMissing") == Some(&Value::Bool(true)),
        ));
        let office = office_shift(site, &shift.id).await?;
        checks.push(Check::same("status_closed", "closed", office["status"].as_str().unwrap_or("")));
        checks.push(Check::same("close_reason_missing_flag", true, office["closeReasonMissing"] == Value::Bool(true)));
        let given = site
            .office
            .ok(
                "PUT",
                &format!("/v1/office/shifts/{}/close-reason", shift.id),
                Some(json!({ "reasonCode": "production_order_changed", "expectedRev": office["rev"] })),
            )
            .await?;
        checks.push(Check::same("the_office_gave_the_reason", false, given["closeReasonMissing"] == Value::Bool(true)));
        Ok(checks)
    }
    .await;
    result("missing-reason", outcome)
}

fn result(name: &str, outcome: Res<Vec<Check>>) -> DrillResult {
    DrillResult {
        name: name.to_owned(),
        checks: outcome.unwrap_or_else(|error| vec![Check::new("drill_ran", false, error)]),
    }
}

/// Every drill, one after the other, each on a shift of its own. The run's
/// shift is closed by now, so the line is free.
pub async fn run_all(site: &Site, profile: &Profile, run: u32) -> Vec<DrillResult> {
    let mut results = Vec::new();
    results.push(
        order_drill(
            site,
            profile,
            run + 1,
            "close-stations-first",
            CloseOrder::StationsFirst,
        )
        .await,
    );
    results.push(
        order_drill(
            site,
            profile,
            run + 2,
            "close-handhelds-first",
            CloseOrder::HandheldsFirst,
        )
        .await,
    );
    results.push(
        order_drill(
            site,
            profile,
            run + 3,
            "close-shuffled",
            CloseOrder::Shuffled,
        )
        .await,
    );
    results.push(force_drill(site, profile, run + 4).await);
    results.push(missing_reason_drill(site, profile, run + 5).await);
    results
}
```

`src/probes.rs` (the whole file):

```rust
//! The two probes of the host's own safety nets: a copy made while the
//! devices work, and a restore that brings the whole database back.

use std::path::Path;
use std::time::{Duration, Instant};

use markiro_host::config::HostPaths;
use markiro_host::restore::{restore_now, IdentityChoice, RestoreOptions};
use serde_json::Value;

use crate::api::{Api, Auth};
use crate::checks::Check;
use crate::dbcheck;
use crate::device::Shared;
use crate::host::Host;
use crate::metrics::Route;
use crate::report::{BackupResult, RestoreResult};
use crate::site::{Office, Res};

const BACKUP_WAIT: Duration = Duration::from_secs(180);

fn copies_of(state: &Value) -> Vec<(String, String, u64)> {
    state
        .pointer("/local/copies")
        .and_then(Value::as_array)
        .map(|copies| {
            copies
                .iter()
                .filter_map(|copy| {
                    Some((
                        copy.get("file")?.as_str()?.to_owned(),
                        copy.get("createdAt")?.as_str()?.to_owned(),
                        copy.get("sizeBytes")?.as_u64()?,
                    ))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Ask for a copy now, wait for it, open it and judge it. While it runs the
/// facts route is also counted apart (`facts_during_backup`). Returns the
/// result and the copy's path. `outside_the_ledger` is the scans the harness
/// made that the ledger does not hold (the drills'): the copy may hold them.
pub async fn backup(
    office: &Office,
    data_dir: &Path,
    shared: &Shared,
    at_fraction: f64,
    outside_the_ledger: u64,
) -> Res<(BackupResult, std::path::PathBuf)> {
    let known: Vec<String> = copies_of(&office.ok("GET", "/v1/office/backups", None).await?)
        .into_iter()
        .map(|(file, _, _)| file)
        .collect();
    let scans = |shared: &Shared| {
        shared
            .ledger
            .lock()
            .expect("ledger")
            .scan_rows
            .values()
            .sum::<u64>()
    };
    let acked_before = scans(shared);
    shared.metrics.set_backup_running(true);
    let began = Instant::now();
    let asked = office.call("POST", "/v1/office/backups", None).await;
    let mut checks = Vec::new();
    let mut found = None;
    match &asked {
        Ok(reply) if reply.status == 202 => {
            checks.push(Check::same("backup_accepted", 202u16, reply.status));
            while began.elapsed() < BACKUP_WAIT {
                tokio::time::sleep(Duration::from_millis(250)).await;
                let Ok(state) = office.ok("GET", "/v1/office/backups", None).await else {
                    continue;
                };
                let fresh = copies_of(&state)
                    .into_iter()
                    .find(|(file, _, _)| !known.contains(file));
                if state.get("running").map_or(true, Value::is_null) && fresh.is_some() {
                    found = fresh;
                    break;
                }
            }
        }
        Ok(reply) => checks.push(Check::new(
            "backup_accepted",
            false,
            format!("{} {}", reply.status, reply.body),
        )),
        Err(error) => checks.push(Check::new("backup_accepted", false, error.clone())),
    }
    shared.metrics.set_backup_running(false);
    let duration_ms = began.elapsed().as_millis() as u64;
    let slack = u64::from(shared.profile.devices()) * shared.profile.batch_max as u64;
    let acked_after = scans(shared) + slack + outside_the_ledger;
    let Some((file, _, size_bytes)) = found else {
        checks.push(Check::new(
            "backup_completed",
            false,
            format!("no copy in {} s", BACKUP_WAIT.as_secs()),
        ));
        return Ok((
            BackupResult {
                at_fraction,
                duration_ms,
                file: String::new(),
                size_bytes: 0,
                scans_in_copy: -1,
                acked_before,
                acked_after_with_slack: acked_after,
                checks,
            },
            std::path::PathBuf::new(),
        ));
    };
    checks.push(Check::new(
        "backup_completed",
        true,
        format!("{duration_ms} ms"),
    ));
    let path = HostPaths::new(data_dir).backups_dir().join(&file);
    let pool = dbcheck::open_read_only(&path, true).await?;
    checks.extend(dbcheck::structural(&pool).await?);
    let in_copy = dbcheck::scan_count(&pool).await?;
    pool.close().await;
    // Everything acknowledged before the copy was asked for is in it, and
    // nothing the devices had not sent by the time it was done.
    checks.push(Check::new(
        "backup_scans_between_the_acknowledged_and_the_sent",
        (acked_before as i64..=acked_after as i64).contains(&in_copy),
        format!("{in_copy} scans in the copy, between {acked_before} and {acked_after}"),
    ));
    Ok((
        BackupResult {
            at_fraction,
            duration_ms,
            file,
            size_bytes,
            scans_in_copy: in_copy,
            acked_before,
            acked_after_with_slack: acked_after,
            checks,
        },
        path,
    ))
}

/// Put `copy` into a folder of its own, compare it with the live database
/// (the host is stopped: nothing writes to either) and start a host on it
/// that answers the shift's total to a device whose key the copy kept.
pub async fn restore_roundtrip(
    live_dir: &Path,
    copy: &Path,
    work: &Path,
    device_key: &str,
    shift_id: &str,
    expected_total: u64,
    metrics: std::sync::Arc<crate::metrics::Metrics>,
) -> Res<RestoreResult> {
    let live = dbcheck::open_read_only(&HostPaths::new(live_dir).database_file(), false).await?;
    let live_counts = dbcheck::table_counts(&live).await?;
    live.close().await;
    let restored_dir = work.join("restored");
    let report = restore_now(
        &HostPaths::new(&restored_dir),
        copy,
        RestoreOptions {
            without_manifest: false,
            identity: IdentityChoice::Auto,
        },
    )
    .await;
    let mut checks = vec![Check::new(
        "restore_done",
        report.is_ok(),
        format!("{:?}", report.as_ref().err().map(ToString::to_string)),
    )];
    if report.is_err() {
        return Ok(RestoreResult {
            copy: copy.display().to_string(),
            counts: live_counts,
            checks,
        });
    }
    let restored =
        dbcheck::open_read_only(&HostPaths::new(&restored_dir).database_file(), true).await?;
    let restored_counts = dbcheck::table_counts(&restored).await?;
    restored.close().await;
    for (table, count) in &live_counts {
        checks.push(Check::same(
            &format!("restore_rows_{table}"),
            *count,
            restored_counts[table],
        ));
    }
    let mut host = Host::in_process(&restored_dir)
        .await
        .map_err(|error| error.to_string())?;
    let api = Api::new(&host.base, &host.fingerprint, metrics);
    let reply = api
        .send(
            Route::DeviceShifts,
            "GET",
            "/v1/device/shifts",
            Auth {
                device_key: Some(device_key),
                session: None,
            },
            None,
        )
        .await;
    let total = reply.ok().and_then(|reply| {
        reply
            .body
            .get("shifts")?
            .as_array()?
            .iter()
            .find(|shift| shift["id"] == serde_json::json!(shift_id))?
            .pointer("/totals/accepted")?
            .as_u64()
    });
    checks.push(Check::new(
        "restore_host_answers_the_shift_total",
        total == Some(expected_total),
        format!("expected {expected_total}, got {total:?}"),
    ));
    host.stop().await.map_err(|error| error.to_string())?;
    Ok(RestoreResult {
        copy: copy.display().to_string(),
        counts: live_counts,
        checks,
    })
}
```

- [ ] **Step 4: Run the tests to verify they pass.**

Run: `cargo --offline --locked test --manifest-path "$WT/apps/standalone/Cargo.toml" -p markiro-loadtest --lib -- drills::`
Expected: PASS, 2 tests.

- [ ] **Step 5: Format and commit.**

Run: `cargo fmt --manifest-path "$WT/apps/standalone/Cargo.toml" --all -- --check` (clean).

```bash
git -C "$WT" add apps/standalone/loadtest/src/lib.rs \
  apps/standalone/loadtest/src/drills.rs \
  apps/standalone/loadtest/src/probes.rs
git -C "$WT" commit -m "feat(standalone): load test drills (close orders, forced close, missing reason) and backup and restore probes

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 13: The run, the command line and the self-test

**Files:**

- Create: `apps/standalone/loadtest/src/run.rs`, `apps/standalone/loadtest/src/cli.rs`, `apps/standalone/loadtest/tests/self_run.rs`
- Modify: `apps/standalone/loadtest/src/main.rs`, `apps/standalone/loadtest/src/lib.rs`

**Interfaces:**

- Consumes: every module above.
- Produces: `run::HostChoice { InProcess, Spawn { bin }, Attach { base, fingerprint, data_dir, pid, credentials } }`, `run::RunOptions { profile, thresholds, host, work_dir }`, `run::execute(RunOptions) -> Res<Report>`; `cli::{Command, RunArgs, HostArg, USAGE, parse, run, inside_checkout, compare_files, summary_of}`; the binary `markiro-loadtest` with `run`, `compare` and `summary`; exit codes 0 (pass), 1 (a failed verdict or a regression), 2 (a run that could not be made, or a bad line).

`execute` in order: start the host, `hello`, provision the site and the shift, spawn four tasks for every device and the sampler, schedule the profile's backups, wait the duration (a progress line every 30 s on stderr), stop the scanners, bring every link up, drain every outbox, reconcile (API tier through every device's and the office's view, database tier from outside, read-only), the devices close their parts in the profile's order (every close but the last must answer `partClosed`, and the last must close the shift), the five drills, the last backup, the host's stop, the restore round trip, the log scan, the report. The new check `conflicts_injected_vs_observed` requires that of the late duplicates and taken races injected, 90-100 % show as conflicts or displacements.

The command line: `markiro-loadtest run --profile tiny|smoke|soak [--set field=value]… [--out DIR] [--keep-data] [--host spawn|in-process|attach] [--host-bin PATH] [--attach-url URL --fingerprint HEX [--data-dir DIR] [--pid N]]`, `markiro-loadtest compare OLD.json NEW.json`, `markiro-loadtest summary REPORT.json`. The default host is `spawn`, the `markiro-host` binary next to this one (both are built into one `target/` directory). A report folder inside a git checkout is refused. Attach reads `MARKIRO_LOAD_OFFICE_DEVICE_KEY`, `MARKIRO_LOAD_ADMIN_LOGIN` and `MARKIRO_LOAD_ADMIN_PASSWORD` from the environment.

- [ ] **Step 1: Write the failing tests.** `src/lib.rs` (now the final list):

```rust
pub mod api;
pub mod checks;
pub mod cli;
pub mod dbcheck;
pub mod device;
pub mod drills;
pub mod engine;
pub mod gen;
pub mod histogram;
pub mod host;
pub mod ledger;
pub mod metrics;
pub mod probes;
pub mod procstat;
pub mod profile;
pub mod report;
pub mod rng;
pub mod run;
pub mod sampler;
pub mod site;
pub mod wal;
```

`src/cli.rs` (tests only):

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn args(text: &str) -> Vec<String> {
        text.split_whitespace().map(str::to_owned).collect()
    }

    #[test]
    fn a_run_takes_a_profile_overrides_and_a_host() {
        let parsed = parse(&args(
            "run --profile smoke --set scanRate=7 --set durationS=60 --out /tmp/x --keep-data",
        ))
        .unwrap();
        let Command::Run(run) = parsed else {
            panic!("a run")
        };
        assert_eq!((run.profile.scan_rate, run.profile.duration_s), (7.0, 60));
        assert_eq!(run.out, Some(PathBuf::from("/tmp/x")));
        assert!(run.keep_data);
        assert_eq!(run.host, HostArg::Spawn { bin: None });
        let Command::Run(run) = parse(&args("run --profile tiny --host in-process")).unwrap()
        else {
            panic!()
        };
        assert_eq!(run.host, HostArg::InProcess);
    }

    #[test]
    fn attach_needs_its_address_and_fingerprint() {
        assert!(parse(&args("run --profile tiny --host attach")).is_err());
        let ok = parse(&args("run --profile tiny --host attach --attach-url https://10.0.0.5:45710 --fingerprint ab --pid 7")).unwrap();
        let Command::Run(run) = ok else { panic!() };
        assert_eq!(
            run.host,
            HostArg::Attach {
                url: "https://10.0.0.5:45710".into(),
                fingerprint: "ab".into(),
                data_dir: None,
                pid: Some(7)
            }
        );
    }

    #[test]
    fn bad_lines_are_refused_with_the_usage() {
        for line in [
            "",
            "run",
            "run --profile huge",
            "run --profile smoke --set nonsense=1",
            "run --profile smoke --set noequals",
            "compare a",
            "frob",
        ] {
            assert!(parse(&args(line)).is_err(), "{line}");
        }
        assert!(matches!(
            parse(&args("compare a.json b.json")),
            Ok(Command::Compare { .. })
        ));
        assert!(matches!(
            parse(&args("summary r.json")),
            Ok(Command::Summary { .. })
        ));
    }

    #[test]
    fn a_folder_inside_a_checkout_is_refused_and_one_outside_is_not() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!inside_checkout(dir.path()));
        std::fs::create_dir(dir.path().join(".git")).unwrap();
        assert!(inside_checkout(&dir.path().join("reports")));
    }

    #[test]
    fn two_report_files_are_compared_and_a_summary_is_read() {
        let dir = tempfile::tempdir().unwrap();
        let mut old = crate::report::sample_passing();
        old.verdict.pass = true;
        let mut new = old.clone();
        new.throughput.scans_per_s = 1.0;
        let (old_path, new_path) = (dir.path().join("old.json"), dir.path().join("new.json"));
        std::fs::write(&old_path, serde_json::to_string(&old).unwrap()).unwrap();
        std::fs::write(&new_path, serde_json::to_string(&new).unwrap()).unwrap();
        assert!(compare_files(&old_path, &old_path).unwrap().is_empty());
        let found = compare_files(&old_path, &new_path).unwrap();
        assert!(
            found.iter().any(|line| line.contains("scans per second")),
            "{found:?}"
        );
        assert!(summary_of(&new_path)
            .unwrap()
            .starts_with("# Load run `smoke`"));
        assert!(compare_files(&old_path, &dir.path().join("none.json")).is_err());
    }
}
```

`tests/self_run.rs` (the whole file; it is `#[ignore]` because it starts a host and runs twenty seconds of load, and it needs the host of plan 2b):

```rust
//! The harness run against a host in this process: two stations and a
//! handheld in one shift for twenty seconds, and every check of the report
//! must hold. It needs the host of plan 2b (shared shifts), a loopback
//! socket and about a minute, so it is `ignored` in the ordinary gate:
//! `cargo test -p markiro-loadtest --test self_run -- --ignored`.

use markiro_loadtest::profile::{Profile, Thresholds};
use markiro_loadtest::run::{execute, HostChoice, RunOptions};

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "runs a host and twenty seconds of load; run it with --ignored"]
async fn the_tiny_profile_passes_every_check_against_a_host_in_this_process() {
    let profile = Profile::preset("tiny").unwrap();
    let dir = tempfile::tempdir().unwrap();
    let report = execute(RunOptions {
        thresholds: Thresholds::for_profile("tiny").unwrap(),
        profile,
        host: HostChoice::InProcess,
        work_dir: dir.path().to_path_buf(),
    })
    .await
    .unwrap();
    assert!(report.verdict.pass, "{:#?}", report.verdict);
    assert_eq!(report.devices.len(), 3);
    assert!(report.devices.iter().any(|device| device.handheld));
    // The load did what it says: every kind of injection happened, and the
    // host's own numbers say so.
    assert!(
        report.expected.distinct_accepted_codes > 100,
        "{:?}",
        report.expected
    );
    assert!(
        report.expected.conflict_receipts + report.expected.displacements > 0,
        "{:?}",
        report.expected
    );
    assert!(
        report.expected.boxes_closed > 10 && report.expected.pallets_closed > 3,
        "{:?}",
        report.expected
    );
    assert!(
        report
            .devices
            .iter()
            .map(|device| device.resends)
            .sum::<u64>()
            > 0
    );
    assert!(
        report
            .devices
            .iter()
            .map(|device| device.offline_periods)
            .sum::<u64>()
            > 0
    );
    assert_eq!(report.drills.len(), 5);
    assert!(report.backups.len() >= 2, "one under load, one at the end");
    assert!(report.restore.is_some());
    let first = &report.latency["facts"];
    assert!(first.count > 100);
}
```

- [ ] **Step 2: Run them to verify they fail.**

Run: `cargo --offline --locked test --manifest-path "$WT/apps/standalone/Cargo.toml" -p markiro-loadtest --lib -- cli::` and `cargo --offline --locked test --manifest-path "$WT/apps/standalone/Cargo.toml" -p markiro-loadtest --test self_run --no-run`
Expected: FAIL to compile (`cannot find function parse`, unresolved import `markiro_loadtest::run`).

- [ ] **Step 3: Write the implementation.** `src/run.rs` (the whole file):

```rust
//! A whole run: the host, the site, the devices, the load for the profile's
//! duration with a backup under it, the stop, the reconciliation against
//! what the host acknowledged, the closes, the drills, the last backup and
//! the restore, and the report with its verdict.

use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::Value;
use time::format_description::well_known::Rfc3339;
use tokio::sync::watch;

use crate::api::{pinned_client, Api};
use crate::checks::Check;
use crate::dbcheck;
use crate::device::{Shared, SimDevice};
use crate::drills;
use crate::host::Host;
use crate::metrics::Metrics;
use crate::probes;
use crate::profile::{Profile, Thresholds};
use crate::report::{evaluate, summarize, BackupResult, Report, Throughput, Verdict, SCHEMA};
use crate::rng::Rng;
use crate::sampler;
use crate::site::{provision, AttachCredentials, Office, Res};

pub enum HostChoice {
    InProcess,
    Spawn {
        bin: PathBuf,
    },
    Attach {
        base: String,
        fingerprint: String,
        data_dir: Option<PathBuf>,
        pid: Option<u32>,
        credentials: AttachCredentials,
    },
}

pub struct RunOptions {
    pub profile: Profile,
    pub thresholds: Thresholds,
    pub host: HostChoice,
    /// The folder the run keeps its data, host log and restore in.
    pub work_dir: PathBuf,
}

fn count_of(value: &Value, pointer: &str) -> Option<u64> {
    value.pointer(pointer).and_then(Value::as_u64)
}

async fn api_checks(
    devices: &[Arc<SimDevice>],
    office: &Office,
    shared: &Shared,
    shift: &str,
) -> Vec<Check> {
    let (expected, boxes_by_device, pallets_by_device, rejected, records) = {
        let ledger = shared.ledger.lock().expect("ledger");
        (
            ledger.expected(),
            ledger.boxes_closed.clone(),
            ledger.pallets_closed.clone(),
            ledger.rejected.clone(),
            ledger.records.values().sum::<u64>(),
        )
    };
    let mut checks = Vec::new();
    for device in devices {
        let index = device.spec.index;
        let Some(view) = device.view().await else {
            checks.push(Check::new(
                &format!("view_device_{index}"),
                false,
                "the shift is not in the device's list",
            ));
            continue;
        };
        checks.push(Check::same(
            &format!("totals_accepted_device_{index}"),
            Some(expected.distinct_accepted_codes),
            count_of(&view, "/totals/accepted"),
        ));
        checks.push(Check::same(
            &format!("totals_boxes_device_{index}"),
            Some(expected.boxes_closed),
            count_of(&view, "/totals/boxesClosed"),
        ));
        checks.push(Check::same(
            &format!("totals_pallets_device_{index}"),
            Some(expected.pallets_closed),
            count_of(&view, "/totals/pallets"),
        ));
        let parts = view
            .get("byDevice")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let sum: u64 = parts
            .iter()
            .filter_map(|part| count_of(part, "/accepted"))
            .sum();
        checks.push(Check::same(
            &format!("by_device_adds_up_device_{index}"),
            Some(sum),
            count_of(&view, "/totals/accepted"),
        ));
        for peer in devices {
            let part = parts
                .iter()
                .find(|part| part["deviceId"] == Value::String(peer.spec.id.clone()));
            let at = peer.spec.index;
            checks.push(Check::same(
                &format!("boxes_of_{at}_seen_by_{index}"),
                Some(boxes_by_device.get(&at).copied().unwrap_or(0)),
                part.and_then(|part| count_of(part, "/boxesClosed")),
            ));
            checks.push(Check::same(
                &format!("pallets_of_{at}_seen_by_{index}"),
                Some(pallets_by_device.get(&at).copied().unwrap_or(0)),
                part.and_then(|part| count_of(part, "/pallets")),
            ));
        }
        if index == 0 {
            let active = view
                .get("participants")
                .and_then(Value::as_array)
                .map(|parts| {
                    parts
                        .iter()
                        .filter(|part| part["state"] == "active")
                        .count()
                })
                .unwrap_or(0);
            checks.push(Check::same("participants_active", devices.len(), active));
        }
    }
    match office
        .ok("GET", &format!("/v1/office/shifts/{shift}"), None)
        .await
    {
        Ok(view) => {
            checks.push(Check::same(
                "office_units",
                Some(expected.distinct_accepted_codes),
                count_of(&view, "/totals/acceptedUnits"),
            ));
            checks.push(Check::same(
                "office_closed_boxes",
                Some(expected.boxes_closed),
                count_of(&view, "/totals/closedBoxes"),
            ));
            checks.push(Check::same(
                "office_closed_pallets",
                Some(expected.pallets_closed),
                count_of(&view, "/totals/closedPallets"),
            ));
        }
        Err(error) => checks.push(Check::new("office_view", false, error)),
    }
    let made: u64 = devices.iter().map(|device| device.records_made()).sum();
    checks.push(Check::same("every_record_acknowledged", made, records));
    // Every injected conflict must have happened: a duplicate sent without the
    // check is a `conflict`, an offered scan the other device took first is
    // a displacement (or, when the offering device came back too early, a conflict).
    let injected: u64 = devices
        .iter()
        .map(|device| {
            let stats = device.stats();
            stats.late_dups + stats.races_taken
        })
        .sum();
    let observed = expected.conflict_receipts + expected.displacements;
    checks.push(Check::new(
        "conflicts_injected_vs_observed",
        observed as f64 >= injected as f64 * 0.9 && observed <= injected,
        format!(
            "{injected} injected, {observed} observed ({} conflicts, {} displacements)",
            expected.conflict_receipts, expected.displacements
        ),
    ));
    checks.push(Check::same(
        "sscc_blocks_never_overlap",
        0,
        shared.overlaps.load(Ordering::SeqCst),
    ));
    checks.push(Check::new(
        "no_record_rejected",
        rejected.is_empty(),
        format!("{rejected:?}"),
    ));
    checks
}

fn progress(started: Instant, shared: &Shared, devices: &[Arc<SimDevice>]) {
    let online = devices.iter().filter(|device| device.is_online()).count();
    let records: u64 = shared.ledger.lock().expect("ledger").records.values().sum();
    let facts = shared
        .metrics
        .latency()
        .get("facts")
        .map(|histogram| histogram.summary());
    eprintln!(
        "[{:>6.0} s] scans {} acknowledged {} online {}/{} facts p99 {:.0} ms",
        started.elapsed().as_secs_f64(),
        shared.generated.load(Ordering::SeqCst),
        records,
        online,
        devices.len(),
        facts.map_or(0.0, |summary| summary.p99_ms)
    );
}

pub async fn execute(options: RunOptions) -> Res<Report> {
    let RunOptions {
        profile,
        thresholds,
        host: choice,
        work_dir,
    } = options;
    profile.validate()?;
    std::fs::create_dir_all(&work_dir)
        .map_err(|error| format!("{}: {error}", work_dir.display()))?;
    let started_at = time::OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_default();
    let metrics = Arc::new(Metrics::new());
    let data_dir = work_dir.join("data");
    let (mut host, kind, attach) = match choice {
        HostChoice::InProcess => (
            Host::in_process(&data_dir)
                .await
                .map_err(|e| e.to_string())?,
            "in-process",
            None,
        ),
        HostChoice::Spawn { bin } => (
            Host::spawned(&bin, &data_dir, &work_dir.join("host-stdout.log"))
                .await
                .map_err(|e| e.to_string())?,
            "spawn",
            None,
        ),
        HostChoice::Attach {
            base,
            fingerprint,
            data_dir,
            pid,
            credentials,
        } => (
            Host::attached(&base, &fingerprint, data_dir, pid),
            "attach",
            Some(credentials),
        ),
    };
    let hello = pinned_client(&host.fingerprint, Duration::from_secs(5))
        .get(format!("{}/v1/hello", host.base))
        .send()
        .await
        .map_err(|error| format!("hello: {error}"))?
        .json::<Value>()
        .await
        .map_err(|error| format!("hello: {error}"))?;
    let (site, shift) = provision(&host, metrics.clone(), &profile, attach).await?;
    let run_id = (profile.seed % 0xF000) as u32 + 1;
    let shared = Arc::new(Shared::new(
        profile.clone(),
        run_id,
        &shift.id,
        &shift.issuer_prefix,
        metrics.clone(),
    ));
    let devices: Vec<Arc<SimDevice>> = site
        .devices
        .iter()
        .map(|spec| {
            SimDevice::new(
                spec.clone(),
                Api::new(&host.base, &host.fingerprint, metrics.clone()),
                shared.clone(),
            )
        })
        .collect();
    let started = Instant::now();
    let (sampler_stop, sampler_watch) = watch::channel(false);
    let sampler = tokio::spawn(sampler::run(
        host.data_dir.clone(),
        host.pid,
        Duration::from_secs(profile.sample_s),
        sampler_watch,
    ));
    let (mut scanners, mut links, mut streams, mut syncers) =
        (Vec::new(), Vec::new(), Vec::new(), Vec::new());
    for device in &devices {
        scanners.push(tokio::spawn(device.clone().scanner()));
        links.push(tokio::spawn(device.clone().link()));
        streams.push(tokio::spawn(device.clone().stream()));
        syncers.push(tokio::spawn(device.clone().syncer()));
    }
    let backups = {
        let (office, shared, dir) = (site.office.clone(), shared.clone(), host.data_dir.clone());
        let fractions = profile.backup_at.clone();
        let duration = profile.duration_s as f64;
        tokio::spawn(async move {
            let mut done: Vec<BackupResult> = Vec::new();
            let Some(dir) = dir else { return done };
            for fraction in fractions {
                tokio::time::sleep_until(tokio::time::Instant::from_std(
                    started + Duration::from_secs_f64(duration * fraction),
                ))
                .await;
                match probes::backup(&office, &dir, &shared, fraction, 0).await {
                    Ok((result, _)) => done.push(result),
                    Err(error) => done.push(BackupResult {
                        at_fraction: fraction,
                        duration_ms: 0,
                        file: String::new(),
                        size_bytes: 0,
                        scans_in_copy: -1,
                        acked_before: 0,
                        acked_after_with_slack: 0,
                        checks: vec![Check::new("backup_ran", false, error)],
                    }),
                }
            }
            done
        })
    };
    let end = started + Duration::from_secs(profile.duration_s);
    while Instant::now() < end {
        tokio::time::sleep((end - Instant::now()).min(Duration::from_secs(30))).await;
        progress(started, &shared, &devices);
    }
    // The end of the load: the scanners stop, the links come back, the outboxes drain.
    shared.stop.store(true, Ordering::SeqCst);
    for task in scanners.into_iter().chain(links).chain(streams) {
        let _ = task.await;
    }
    for device in &devices {
        device.quiesce();
    }
    let mut checks = Vec::new();
    for (index, task) in syncers.into_iter().enumerate() {
        let outcome = task
            .await
            .map_err(|error| error.to_string())
            .and_then(|result| result);
        checks.push(Check::new(
            &format!("device_{index}_drained"),
            outcome.is_ok(),
            format!("{outcome:?}"),
        ));
    }
    let backups = backups.await.unwrap_or_default();
    let load_ended = started.elapsed().as_secs_f64();
    // Reconcile while the shift is still open and the devices are quiet.
    checks.extend(api_checks(&devices, &site.office, &shared, &shift.id).await);
    if let Some(dir) = &host.data_dir {
        let live = dbcheck::open_read_only(
            &markiro_host::config::HostPaths::new(dir).database_file(),
            false,
        )
        .await?;
        checks.extend(dbcheck::structural(&live).await?);
        let ids: Vec<(u32, String)> = devices
            .iter()
            .map(|device| (device.spec.index, device.spec.id.clone()))
            .collect();
        let ledger = shared.ledger.lock().expect("ledger").snapshot();
        checks.extend(dbcheck::reconcile(&live, &shift.id, &ids, &ledger).await?);
        live.close().await;
    }
    // The closes, in the profile's order.
    let mut rng = Rng::new(profile.seed ^ 0xC10);
    let order = drills::closing_order(&site.devices, profile.close_order, &mut rng);
    for (position, at) in order.iter().enumerate() {
        let last = position + 1 == order.len();
        match devices[*at].close_part(None, None).await {
            Ok(receipt) => {
                let part_only = receipt.pointer("/details/partClosed") == Some(&Value::Bool(true));
                checks.push(Check::same(
                    &format!("close_{position}_closes_only_the_part"),
                    !last,
                    part_only,
                ));
            }
            Err(error) => checks.push(Check::new(&format!("close_{position}"), false, error)),
        }
    }
    match site
        .office
        .ok("GET", &format!("/v1/office/shifts/{}", shift.id), None)
        .await
    {
        Ok(view) => checks.push(Check::same(
            "shift_closed_by_its_last_part",
            "closed",
            view["status"].as_str().unwrap_or(""),
        )),
        Err(error) => checks.push(Check::new("shift_closed_by_its_last_part", false, error)),
    }
    let drills = drills::run_all(&site, &profile, run_id).await;
    // The last copy, then the host stops and the copy is put back.
    let mut backups = backups;
    let mut last_copy = None;
    if let Some(dir) = host.data_dir.clone() {
        match probes::backup(
            &site.office,
            &dir,
            &shared,
            1.0,
            drills::scans_made(&profile, site.devices.len()),
        )
        .await
        {
            Ok((result, path)) => {
                last_copy = (!result.file.is_empty()).then_some(path);
                backups.push(result);
            }
            Err(error) => checks.push(Check::new("last_backup", false, error)),
        }
    }
    sampler_stop.send_replace(true);
    let series = sampler.await.unwrap_or_default();
    let graceful = match host.stop().await {
        Ok(graceful) => (kind == "spawn" && cfg!(unix)).then_some(graceful),
        Err(error) => {
            checks.push(Check::new("host_stop", false, error.to_string()));
            None
        }
    };
    let restore = match (&host.data_dir, last_copy) {
        (Some(dir), Some(copy)) if kind != "attach" => {
            let expected = shared
                .ledger
                .lock()
                .expect("ledger")
                .expected()
                .distinct_accepted_codes;
            Some(
                probes::restore_roundtrip(
                    dir,
                    &copy,
                    &work_dir,
                    &site.devices[0].key,
                    &shift.id,
                    expected,
                    metrics.clone(),
                )
                .await
                .unwrap_or_else(|error| crate::report::RestoreResult {
                    copy: copy.display().to_string(),
                    counts: Default::default(),
                    checks: vec![Check::new("restore_ran", false, error)],
                }),
            )
        }
        _ => None,
    };
    let latency = metrics
        .latency()
        .into_iter()
        .map(|(route, histogram)| (route.to_owned(), histogram.summary()))
        .collect();
    let (expected, records_acked) = {
        let ledger = shared.ledger.lock().expect("ledger");
        (ledger.expected(), ledger.records.values().sum::<u64>())
    };
    let generated = shared.generated.load(Ordering::SeqCst);
    let mut report = Report {
        schema: SCHEMA,
        started_at,
        host_kind: kind.to_owned(),
        host_version: hello["version"].as_str().unwrap_or("?").to_owned(),
        host_protocol: hello["protocol"].as_u64().unwrap_or(0),
        os: std::env::consts::OS.to_owned(),
        thresholds,
        latency,
        errors: metrics.errors(),
        throughput: Throughput {
            scans_generated: generated,
            scans_per_s: generated as f64 / profile.duration_s as f64,
            ideal_scans: profile.ideal_scans(),
            generated_share: generated as f64 / profile.ideal_scans(),
            records_acked,
            duration_s: load_ended,
        },
        devices: devices.iter().map(|device| device.stats()).collect(),
        expected,
        resources: summarize(
            &series,
            (profile.duration_s as f64 * 0.1).max(30.0).min(load_ended),
        ),
        checks,
        drills,
        backups,
        restore,
        log: host.log_scan(),
        graceful_stop: graceful,
        verdict: Verdict::default(),
        series,
        profile,
    };
    report.verdict = evaluate(&report);
    Ok(report)
}
```

`src/cli.rs`, above its tests:

```rust
//! The command line: `run` (one run, a report folder), `compare` (two
//! reports, exit 1 on a regression) and `summary` (a report as Markdown).

use std::path::{Path, PathBuf};

use crate::profile::{Profile, Thresholds};
use crate::report::{compare, render_markdown, Report};
use crate::run::{execute, HostChoice, RunOptions};
use crate::site::AttachCredentials;

pub const USAGE: &str = "usage:
  markiro-loadtest run --profile tiny|smoke|soak [--set field=value]... [--out DIR] [--keep-data]
        [--host spawn|in-process|attach] [--host-bin PATH]
        [--attach-url URL --fingerprint HEX [--data-dir DIR] [--pid N]]
  markiro-loadtest compare OLD.json NEW.json
  markiro-loadtest summary REPORT.json

Attach reads MARKIRO_LOAD_OFFICE_DEVICE_KEY, MARKIRO_LOAD_ADMIN_LOGIN and
MARKIRO_LOAD_ADMIN_PASSWORD from the environment, never from the command line.
The default host is `spawn`: the markiro-host binary next to this one, or --host-bin.";

#[derive(Debug, PartialEq)]
pub enum Command {
    Run(RunArgs),
    Compare { old: PathBuf, new: PathBuf },
    Summary { report: PathBuf },
}

#[derive(Debug, PartialEq)]
pub struct RunArgs {
    pub profile: Profile,
    pub out: Option<PathBuf>,
    pub keep_data: bool,
    pub host: HostArg,
}

#[derive(Debug, PartialEq)]
pub enum HostArg {
    Spawn {
        bin: Option<PathBuf>,
    },
    InProcess,
    Attach {
        url: String,
        fingerprint: String,
        data_dir: Option<PathBuf>,
        pid: Option<u32>,
    },
}

pub fn parse(args: &[String]) -> Result<Command, String> {
    let (command, rest) = args.split_first().ok_or_else(|| USAGE.to_owned())?;
    match command.as_str() {
        "compare" => match rest {
            [old, new] => Ok(Command::Compare {
                old: old.into(),
                new: new.into(),
            }),
            _ => Err(USAGE.to_owned()),
        },
        "summary" => match rest {
            [report] => Ok(Command::Summary {
                report: report.into(),
            }),
            _ => Err(USAGE.to_owned()),
        },
        "run" => parse_run(rest).map(Command::Run),
        _ => Err(USAGE.to_owned()),
    }
}

fn parse_run(args: &[String]) -> Result<RunArgs, String> {
    let (mut name, mut sets, mut out, mut keep_data) = (None, Vec::new(), None, false);
    let (mut host, mut host_bin, mut url, mut fingerprint, mut data_dir, mut pid) =
        (None, None, None, None, None, None);
    let mut index = 0;
    while index < args.len() {
        let flag = args[index].as_str();
        if flag == "--keep-data" {
            keep_data = true;
            index += 1;
            continue;
        }
        let value = args
            .get(index + 1)
            .ok_or_else(|| format!("{flag} needs a value\n{USAGE}"))?;
        match flag {
            "--profile" => name = Some(value.clone()),
            "--set" => sets.push(value.clone()),
            "--out" => out = Some(PathBuf::from(value)),
            "--host" => host = Some(value.clone()),
            "--host-bin" => host_bin = Some(PathBuf::from(value)),
            "--attach-url" => url = Some(value.clone()),
            "--fingerprint" => fingerprint = Some(value.clone()),
            "--data-dir" => data_dir = Some(PathBuf::from(value)),
            "--pid" => {
                pid = Some(
                    value
                        .parse::<u32>()
                        .map_err(|_| "--pid is a process id".to_owned())?,
                )
            }
            other => return Err(format!("unknown argument {other}\n{USAGE}")),
        }
        index += 2;
    }
    let mut profile =
        Profile::preset(&name.ok_or_else(|| format!("--profile is required\n{USAGE}"))?)?;
    for set in sets {
        let (key, value) = set
            .split_once('=')
            .ok_or_else(|| format!("--set {set}: field=value"))?;
        profile.set(key, value)?;
    }
    let host = match host.as_deref().unwrap_or("spawn") {
        "spawn" => HostArg::Spawn { bin: host_bin },
        "in-process" => HostArg::InProcess,
        "attach" => HostArg::Attach {
            url: url.ok_or("--attach-url is required to attach")?,
            fingerprint: fingerprint.ok_or("--fingerprint is required to attach")?,
            data_dir,
            pid,
        },
        other => return Err(format!("--host {other}: spawn, in-process or attach")),
    };
    Ok(RunArgs {
        profile,
        out,
        keep_data,
        host,
    })
}

/// Whether `path` is inside a git checkout: reports belong outside the repository.
pub fn inside_checkout(path: &Path) -> bool {
    path.ancestors().any(|dir| dir.join(".git").exists())
}

fn default_out() -> PathBuf {
    if let Some(out) = std::env::var_os("MARKIRO_LOAD_OUT") {
        return PathBuf::from(out);
    }
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .unwrap_or_else(|| ".".into());
    PathBuf::from(home).join("markiro-load")
}

fn host_binary(given: Option<PathBuf>) -> Result<PathBuf, String> {
    if let Some(bin) = given {
        return Ok(bin);
    }
    let me = std::env::current_exe().map_err(|error| error.to_string())?;
    let name = if cfg!(windows) {
        "markiro-host.exe"
    } else {
        "markiro-host"
    };
    let sibling = me.with_file_name(name);
    sibling.exists().then_some(sibling).ok_or_else(|| {
        "no markiro-host next to this binary: build both (cargo build --release -p markiro-host -p markiro-loadtest) or give --host-bin".to_owned()
    })
}

fn env(name: &str) -> Result<String, String> {
    std::env::var(name).map_err(|_| format!("{name} is not set"))
}

fn folder_name(profile: &str) -> String {
    let now = time::OffsetDateTime::now_utc();
    format!(
        "{profile}-{:04}{:02}{:02}-{:02}{:02}{:02}",
        now.year(),
        u8::from(now.month()),
        now.day(),
        now.hour(),
        now.minute(),
        now.second()
    )
}

/// Run, write the report and say how it went: `true` for a pass.
pub async fn run(args: RunArgs) -> Result<bool, String> {
    let out = args.out.unwrap_or_else(default_out);
    if inside_checkout(&out) {
        return Err(format!(
            "{}: a report folder inside a git checkout; give --out outside it",
            out.display()
        ));
    }
    let work_dir = out.join(folder_name(&args.profile.name));
    let host = match args.host {
        HostArg::Spawn { bin } => HostChoice::Spawn {
            bin: host_binary(bin)?,
        },
        HostArg::InProcess => HostChoice::InProcess,
        HostArg::Attach {
            url,
            fingerprint,
            data_dir,
            pid,
        } => HostChoice::Attach {
            base: url,
            fingerprint,
            data_dir,
            pid,
            credentials: AttachCredentials {
                office_device_key: env("MARKIRO_LOAD_OFFICE_DEVICE_KEY")?,
                login: env("MARKIRO_LOAD_ADMIN_LOGIN")?,
                password: env("MARKIRO_LOAD_ADMIN_PASSWORD")?,
            },
        },
    };
    let thresholds = Thresholds::for_profile(&args.profile.name)?;
    let report = execute(RunOptions {
        profile: args.profile,
        thresholds,
        host,
        work_dir: work_dir.clone(),
    })
    .await?;
    let json = serde_json::to_string_pretty(&report).map_err(|error| error.to_string())?;
    std::fs::write(work_dir.join("report.json"), json).map_err(|error| error.to_string())?;
    let summary = render_markdown(&report);
    std::fs::write(work_dir.join("report.md"), &summary).map_err(|error| error.to_string())?;
    println!(
        "{summary}\nreport: {}",
        work_dir.join("report.json").display()
    );
    if report.verdict.pass && !args.keep_data {
        // The data of a passing run is a copy of a throwaway site: of no use and large.
        let _ = std::fs::remove_dir_all(work_dir.join("data"));
        let _ = std::fs::remove_dir_all(work_dir.join("restored"));
    }
    Ok(report.verdict.pass)
}

fn read_report(path: &Path) -> Result<Report, String> {
    let text =
        std::fs::read_to_string(path).map_err(|error| format!("{}: {error}", path.display()))?;
    serde_json::from_str(&text).map_err(|error| format!("{}: {error}", path.display()))
}

/// The regressions of `new` against `old`, one to a line; empty text: none.
pub fn compare_files(old: &Path, new: &Path) -> Result<Vec<String>, String> {
    Ok(compare(&read_report(old)?, &read_report(new)?)
        .into_iter()
        .map(|regression| regression.0)
        .collect())
}

pub fn summary_of(path: &Path) -> Result<String, String> {
    Ok(render_markdown(&read_report(path)?))
}
```

`src/main.rs` (replaces the stub):

```rust
//! `markiro-loadtest`: see `markiro_loadtest::cli::USAGE`.

use std::process::ExitCode;

use markiro_loadtest::cli::{self, Command};

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let command = match cli::parse(&args) {
        Ok(command) => command,
        Err(message) => {
            eprintln!("{message}");
            return ExitCode::from(2);
        }
    };
    let outcome: Result<bool, String> = match command {
        Command::Run(run) => {
            let runtime = tokio::runtime::Runtime::new().expect("a runtime");
            runtime.block_on(cli::run(run))
        }
        Command::Compare { old, new } => cli::compare_files(&old, &new).map(|found| {
            for line in &found {
                println!("regression: {line}");
            }
            if found.is_empty() {
                println!("no regression");
            }
            found.is_empty()
        }),
        Command::Summary { report } => cli::summary_of(&report).map(|text| {
            println!("{text}");
            true
        }),
    };
    match outcome {
        Ok(true) => ExitCode::SUCCESS,
        Ok(false) => ExitCode::from(1),
        Err(message) => {
            eprintln!("{message}");
            ExitCode::from(2)
        }
    }
}
```

- [ ] **Step 4: Run the unit tests and build the binary.**

Run: `cargo --offline --locked test --manifest-path "$WT/apps/standalone/Cargo.toml" -p markiro-loadtest --lib -- cli::` then `cargo --offline --locked build --manifest-path "$WT/apps/standalone/Cargo.toml" -p markiro-host -p markiro-loadtest`
Expected: PASS, 5 tests; the build finishes (the host binary is `markiro-host`, the harness `markiro-loadtest`, both in `$WT/apps/standalone/target/debug/`).

- [ ] **Step 5: Run the self-test** (a host on a loopback socket and about a minute: sandbox disabled if the sandbox refuses `listen`; the host of plan 2b must be merged):

Run: `cargo --offline --locked test --manifest-path "$WT/apps/standalone/Cargo.toml" -p markiro-loadtest --test self_run -- --ignored --nocapture`
Expected: PASS, 1 test. It asserts the verdict passes, three devices of which one handheld, more than 100 accepted codes, at least one conflict or displacement, more than 10 boxes and 3 pallets closed, at least one resend and one offline period, five drills, at least two backups (one under load, one at the end) and a restore. If it fails, the failing check's name and numbers are in the printed `Verdict`: a failure in a check named `totals_*`, `by_device_*`, `participants_*`, `close_*`, `office_*` or a drill's is a defect of the host plan's task that makes it (fix it there with a focused failing test), never a reason to loosen this test.

- [ ] **Step 6: Run the binary once from the command line** (the same load through the real command line, the host as a child process):

Run: `"$WT/apps/standalone/target/debug/markiro-loadtest" run --profile tiny --out "$TMPDIR/markiro-load"`
Expected: exit code 0; the summary is printed and `report.json`, `report.md` and `host-stdout.log` are in `$TMPDIR/markiro-load/tiny-<date>/` (`data/` and `restored/` are removed after a pass). Then: `"$WT/apps/standalone/target/debug/markiro-loadtest" compare <that report.json> <that report.json>` prints `no regression` and exits 0.

- [ ] **Step 7: Format and commit.**

Run: `cargo fmt --manifest-path "$WT/apps/standalone/Cargo.toml" --all -- --check` (clean).

```bash
git -C "$WT" add apps/standalone/loadtest/src/lib.rs \
  apps/standalone/loadtest/src/main.rs \
  apps/standalone/loadtest/src/run.rs \
  apps/standalone/loadtest/src/cli.rs \
  apps/standalone/loadtest/tests/self_run.rs
git -C "$WT" commit -m "feat(standalone): load test run, command line and self-test

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 14: The write review as a test

**Files:**

- Create: `apps/standalone/loadtest/tests/write_review.rs`

**Interfaces:**

- Consumes: the host's source tree (`../host/src`), read as text.
- Produces: five tests in the ordinary gate (they read files only): the heuristic's own test on a bad and a good sample; no function in the host opens `pool.begin()` and then writes (INSERT, UPDATE or DELETE up to the next function); `receive_facts`, `issue_block` and `enter_shift` call `begin_write(` and never `pool.begin()`; the code check (`routes/codes.rs`) reads on `pool.acquire()` and opens no transaction, and a backup copy is the single statement `VACUUM INTO ?`; a facts batch is one `begin_write` of at most `MAX_RECORDS: usize = 100` records with no waiting in it.

This is spec §8's «ревью записи (короткие транзакции, одно писательское соединение для горячих путей, нет долгих читающих транзакций)» as a regression test. At planning time the heuristic finds none of the host's 42 `pool.begin()` sites writing after it begins (no INSERT, UPDATE or DELETE between the call and the end of its function); the device shift list (one read transaction, by its own comment) and the backup state (reads, then `rollback`) were read by hand; the host plan's new routes (`leave`, the forced close, the line limit) take `begin_write` because they write, and this test fails the day one does not.

- [ ] **Step 1: Write the test file** (it passes at once against the current host; its heuristic is proven by its first test, which fails for a bad sample):

```rust
//! The write review of spec §8, kept as a test: the host has one writer at a
//! time (SQLite's own lock), and every hot write path must take it up front.
//! A transaction that reads on a snapshot and then writes (a deferred
//! `BEGIN`, then an `INSERT`) fails with SQLITE_BUSY the moment another
//! writer commits in between, whatever `busy_timeout` says: `db::begin_write`
//! (`BEGIN IMMEDIATE`) is the rule for a transaction that writes. This test
//! reads the host's source; it is a heuristic, and a line it flags is read
//! by a person, not silenced.

use std::path::{Path, PathBuf};

fn host_src() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../host/src")
}

fn rust_files(dir: &Path, found: &mut Vec<PathBuf>) {
    for entry in std::fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            rust_files(&path, found);
        } else if path.extension().is_some_and(|ext| ext == "rs") {
            found.push(path);
        }
    }
}

fn starts_a_function(line: &str) -> bool {
    let line = line
        .trim_start_matches("pub(crate) ")
        .trim_start_matches("pub ");
    line.starts_with("fn ") || line.starts_with("async fn ")
}

/// The 1-based lines of `pool.begin()` (a deferred transaction) after which
/// the same function writes: from the call to the next function there is an
/// INSERT, UPDATE or DELETE.
fn deferred_then_write(text: &str) -> Vec<usize> {
    let lines: Vec<&str> = text.lines().collect();
    let mut flagged = Vec::new();
    for (at, line) in lines.iter().enumerate() {
        if !line.contains("pool.begin()") {
            continue;
        }
        let end = (at + 1..lines.len())
            .find(|next| starts_a_function(lines[*next]))
            .unwrap_or(lines.len());
        let writes = lines[at..end].iter().any(|line| {
            let trimmed = line.trim_start();
            !trimmed.starts_with("//")
                && ["INSERT ", "UPDATE ", "DELETE "]
                    .iter()
                    .any(|word| line.contains(word))
        });
        if writes {
            flagged.push(at + 1);
        }
    }
    flagged
}

/// The text of the function called `name`, up to the next function.
fn function_text<'a>(text: &'a str, name: &str) -> Option<String> {
    let lines: Vec<&'a str> = text.lines().collect();
    let start = lines
        .iter()
        .position(|line| starts_a_function(line) && line.contains(&format!("fn {name}(")))?;
    let end = (start + 1..lines.len())
        .find(|next| starts_a_function(lines[*next]))
        .unwrap_or(lines.len());
    Some(lines[start..end].join("\n"))
}

#[test]
fn the_heuristic_flags_a_read_then_write_on_a_deferred_transaction() {
    let bad = "async fn a() {\n    let mut tx = state.pool.begin().await?;\n    sqlx::query(\"SELECT 1\");\n    sqlx::query(\"UPDATE t SET x = 1\");\n}\n";
    let good = "async fn a() {\n    let mut tx = state.pool.begin().await?;\n    sqlx::query(\"SELECT 1\");\n}\nasync fn b() {\n    sqlx::query(\"UPDATE t SET x = 1\");\n}\n";
    assert_eq!(deferred_then_write(bad), vec![2]);
    assert!(deferred_then_write(good).is_empty());
    assert!(function_text(good, "b").unwrap().contains("UPDATE"));
    assert!(!function_text(good, "b").unwrap().contains("SELECT"));
}

#[test]
fn no_route_reads_on_a_deferred_transaction_and_then_writes() {
    let mut files = Vec::new();
    rust_files(&host_src(), &mut files);
    assert!(files.len() > 50, "the host's source was not found");
    let mut flagged = Vec::new();
    for file in files {
        let text = std::fs::read_to_string(&file).unwrap();
        for line in deferred_then_write(&text) {
            flagged.push(format!("{}:{line}", file.display()));
        }
    }
    assert!(
        flagged.is_empty(),
        "read-then-write on a deferred transaction: {flagged:?}"
    );
}

#[test]
fn the_hot_write_paths_take_the_write_lock_up_front() {
    let src = host_src();
    for (file, name) in [
        ("routes/facts.rs", "receive_facts"),
        ("routes/sscc_blocks.rs", "issue_block"),
        ("routes/device_shifts.rs", "enter_shift"),
    ] {
        let text = std::fs::read_to_string(src.join(file)).unwrap();
        let function =
            function_text(&text, name).unwrap_or_else(|| panic!("{file} has no fn {name}"));
        assert!(
            function.contains("begin_write("),
            "{file} {name} must start with db::begin_write"
        );
        assert!(
            !function.contains("pool.begin()"),
            "{file} {name} must not begin a deferred transaction"
        );
    }
}

#[test]
fn the_code_check_reads_without_a_transaction_and_a_copy_is_one_statement() {
    let src = host_src();
    let check = std::fs::read_to_string(src.join("routes/codes.rs")).unwrap();
    assert!(check.contains("pool.acquire()"));
    assert!(
        !check.contains("begin"),
        "the code check must not open a transaction"
    );
    let copy = std::fs::read_to_string(src.join("backup/copy.rs")).unwrap();
    assert!(
        copy.contains("VACUUM INTO ?"),
        "a backup copies with one statement, holding no long read transaction"
    );
}

#[test]
fn a_facts_batch_is_one_short_transaction_of_at_most_a_hundred_records() {
    let src = host_src();
    let route = std::fs::read_to_string(src.join("routes/facts.rs")).unwrap();
    assert!(route.contains("pub const MAX_RECORDS: usize = 100;"));
    let function = function_text(&route, "receive_facts").unwrap();
    assert_eq!(
        function.matches("begin_write(").count(),
        1,
        "one transaction a batch"
    );
    assert!(
        !function.contains("reqwest") && !function.contains("sleep"),
        "no waiting inside the transaction"
    );
}
```

- [ ] **Step 2: Run it.**

Run: `cargo --offline --locked test --manifest-path "$WT/apps/standalone/Cargo.toml" -p markiro-loadtest --test write_review`
Expected: PASS, 5 tests. Prove that it can fail: add `sqlx::query("UPDATE devices SET name = name").execute(&mut *tx).await.map_err(ApiError::internal)?;` after the `pool.begin()` of `list_device_shifts` in `apps/standalone/host/src/routes/device_shifts.rs`, re-run (expected: `no_route_reads_on_a_deferred_transaction_and_then_writes` FAILS naming `device_shifts.rs`), then delete the line you added (by hand, not with a checkout) and confirm `git -C "$WT" status --short` shows no change to `apps/standalone/host/src/routes/device_shifts.rs`.

- [ ] **Step 3: Commit.**

```bash
git -C "$WT" add apps/standalone/loadtest/tests/write_review.rs
git -C "$WT" commit -m "test(standalone): the write review of spec 8 as a source-scan test

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 15: CI routing and the opt-in workflow

**Files:**

- Modify: `tools/ci/affected.mjs` (`:205-212`), `tools/ci/test/affected.test.mjs` (`:102-106`), `tools/ci/test/workflow-triggers.test.mjs` (`:24` and a new test)
- Create: `.github/workflows/standalone-load.yml`

**Interfaces:**

- Consumes: the harness binary (Task 13).
- Produces: a change under `apps/standalone/loadtest/` selects exactly the two standalone Rust jobs (`standalone_rust`, `standalone_windows_build`), whose `cargo test --workspace` runs the crate's 63 tests; `standalone-load.yml`, a `workflow_dispatch`-only workflow with a `profile` choice (`smoke` default, `tiny`, `soak`), read-only permissions and a job that builds the host and the harness in release, runs the profile, shows the Markdown in the job summary and uploads `report.json`, `report.md` and the host log for 30 days (never `data/`). A failed verdict fails the job (exit 1) and the summary and artifact steps still run.

Why a separate, opt-in workflow (D2): it is never a required check and no ruleset names it; `ci.yml` is untouched, so no pull request pays for it. It runs on any branch, so a change to a hot write path can be tried before merge. A soak is possible there (`timeout-minutes: 330` under GitHub's 360), but the owner's four hours belong on a PC with the factory's disks (Task 16).

- [ ] **Step 1: Write the failing tests.** In `tools/ci/test/affected.test.mjs` add the loadtest path to the first list of `Standalone native and web changes select their jobs…`:

```js
  for (const path of [
    "apps/standalone/host/src/server.rs",
    "apps/standalone/loadtest/src/run.rs",
    "apps/standalone/src-tauri/src/lib.rs",
    "apps/standalone/Cargo.lock",
  ]) {
```

In `tools/ci/test/workflow-triggers.test.mjs` add the file to `expectedEvents`, between `signer-stable-release.yml` and `station-beta-release.yml`:

```js
    "standalone-load.yml": ["workflow_dispatch"],
```

and append this test at the end of the file:

```js
test("the standalone load test is opt-in, read-only and fits the job limit", () => {
  const value = workflow("standalone-load.yml");

  assert.deepEqual(value.permissions, { contents: "read" });
  assert.deepEqual(value.on.workflow_dispatch.inputs.profile.options, ["smoke", "tiny", "soak"]);
  assert.equal(value.on.workflow_dispatch.inputs.profile.default, "smoke");
  assert.ok(value.jobs.load["timeout-minutes"] <= 360);
  assert.equal(value.jobs.load.env.PROFILE, "${{ inputs.profile }}");
  for (const step of value.jobs.load.steps) {
    assert.ok(
      !/\$\{\{\s*inputs\./u.test(step.run ?? ""),
      "an input reaches a shell through env, never inline",
    );
  }
});
```

- [ ] **Step 2: Run them to verify they fail** (install first if `node_modules` is missing: `pnpm --dir "$WT" install --frozen-lockfile`):

Run: `pnpm --dir "$WT" --config.verifyDepsBeforeRun=false test:ci-policy`
Expected: FAIL: the loadtest path selects `verify_static` and the app tests besides the two Rust jobs; the workflow list lacks `standalone-load.yml` while `expectedEvents` names it; the new test cannot read the file.

- [ ] **Step 3: Route the crate.** In `tools/ci/affected.mjs` the host branch becomes:

```js
if (
  path.startsWith("apps/standalone/host/") ||
  path.startsWith("apps/standalone/loadtest/") ||
  path.startsWith("apps/standalone/src-tauri/") ||
  /^apps\/standalone\/Cargo\.(?:toml|lock)$/u.test(path)
) {
  return standaloneJobs;
}
```

Create `.github/workflows/standalone-load.yml` (the pinned action SHAs are the ones `ci.yml` uses):

```yaml
name: Standalone load test

# Opt-in: nothing here runs on a push or a pull request, and no ruleset
# requires it. The ordinary gate (`standalone-rust` in ci.yml) runs this
# crate's unit tests with the rest of the workspace; this workflow is the load
# itself (apps/standalone/loadtest, docs/standalone/load-test-runbook.md): a
# real host process, six simulated devices and minutes of scans, which a
# shared runner's noise would turn into a flaky required check.
on:
  workflow_dispatch:
    inputs:
      profile:
        description: "tiny (a 20 s self-test), smoke (3 minutes) or soak (4 hours)"
        type: choice
        options:
          - smoke
          - tiny
          - soak
        default: smoke

permissions:
  contents: read

concurrency:
  group: standalone-load-${{ github.ref }}
  cancel-in-progress: false

jobs:
  load:
    runs-on: ubuntu-latest
    # A soak is four hours of load, the build before it and the restore after;
    # GitHub stops a job at 360 minutes.
    timeout-minutes: 330
    env:
      PROFILE: ${{ inputs.profile }}
      MARKIRO_LOAD_OUT: ${{ runner.temp }}/markiro-load
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
        with:
          persist-credentials: false
      - uses: dtolnay/rust-toolchain@4cda84d5c5c54efe2404f9d843567869ab1699d4 # stable
      # Only the host and the harness: the Tauri shell (and its WebKit
      # packages) is not part of this build.
      - name: Build the host and the harness (release)
        run: cargo build --release --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host -p markiro-loadtest
      # Exit 1 is a failed verdict, 2 a run that could not be made.
      - name: Run the load profile
        run: apps/standalone/target/release/markiro-loadtest run --profile "$PROFILE"
      - name: Show the summary
        if: always()
        run: |
          mkdir -p "$MARKIRO_LOAD_OUT"
          find "$MARKIRO_LOAD_OUT" -name report.md -exec cat {} + >> "$GITHUB_STEP_SUMMARY"
      - name: Keep the report and the host log
        if: always()
        uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1
        with:
          name: standalone-load-${{ inputs.profile }}-${{ github.run_id }}-${{ github.run_attempt }}
          path: |
            ${{ runner.temp }}/markiro-load/**/report.json
            ${{ runner.temp }}/markiro-load/**/report.md
            ${{ runner.temp }}/markiro-load/**/host-stdout.log
          if-no-files-found: warn
          retention-days: 30
```

- [ ] **Step 4: Run the tests to verify they pass.**

Run: `pnpm --dir "$WT" --config.verifyDepsBeforeRun=false test:ci-policy`
Expected: PASS (all of `tools/ci/test`).

- [ ] **Step 5: Commit.**

```bash
git -C "$WT" add tools/ci/affected.mjs \
  tools/ci/test/affected.test.mjs \
  tools/ci/test/workflow-triggers.test.mjs \
  .github/workflows/standalone-load.yml
git -C "$WT" commit -m "ci(standalone): route the load test crate and add its opt-in workflow

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 16: The owner's runbook and the scoped guide

**Files:**

- Create: `docs/runbooks/standalone-load-test.md`
- Modify: `apps/standalone/AGENTS.md` (append a section at the end of the file)

**Interfaces:**

- Consumes: the command line and the thresholds of Tasks 2 and 13, the workflow of Task 15.
- Produces: the runbook the owner follows (Russian, like the other `docs/runbooks/standalone-*.md`): when to run, what is needed, smoke and soak commands for macOS, Linux and Windows, what success is (the thresholds as a table), what each failure means and where to look, how runs are compared and the baseline kept, attach mode, what is not proven, and the milestone's acceptance checklist; and the short English section of the scoped guide.

- [ ] **Step 1: Create `docs/runbooks/standalone-load-test.md`:**

````markdown
# Нагрузочный и длительный тест хоста «Автоном»: инструкция владельцу

Тест отвечает на один вопрос приёмки вехи «несколько станций в одной смене на одной линии» (спека
`docs/superpowers/specs/2026-10-20-standalone-multi-station-shift-design.md`, §8): остаётся ли хост на SQLite ровным и
точным, когда 4 станции и 2 ТСД одновременно сканируют в одну смену. Он запускает настоящий `markiro-host` на одноразовой
папке данных, создаёт шесть устройств, гоняет сканы (обрывы связи, дубликаты между устройствами, гонки, повторные отправки,
блоки SSCC по правилу половины), меряет и в конце сверяет итоги хоста с тем, что хост подтвердил. Он ничего не пишет в
продуктовые данные и не нужен на заводском ПК.

## 1. Когда запускать

- перед выпуском хоста, который меняет `host/src/db.rs`, `facts/`, `routes/device_shifts.rs`, `sscc_blocks.rs`, `backup/`,
  `restore.rs` или миграции;
- перед пилотом на новой площадке и раз в квартал;
- после любого изменения порогов (см. п. 9).

## 2. Что нужно

Компьютер, не продуктовый ПК площадки (хост на время прогона слушает все интерфейсы: команда `markiro-host run` не умеет
меньше). Rust (stable). Для длинного прогона: до 3 ГБ свободного места и отключённый сон. Данные прогона удаляются при
успехе; при провале остаются (`data/`, `restored/`, журнал хоста).

## 3. Сборка

```
cargo build --release -p markiro-host -p markiro-loadtest --manifest-path apps/standalone/Cargo.toml
```

Оба файла лежат в `apps/standalone/target/release/`; тест берёт `markiro-host` рядом с собой.

## 4. Быстрый прогон (smoke, около 5 минут)

```
apps/standalone/target/release/markiro-loadtest run --profile smoke
```

4 станции и 2 ТСД по 5 сканов/с, 3 минуты, затем закрытия, пять сценариев (закрытие в трёх порядках, принудительное
закрытие из офиса, закрытие без причины), последняя копия и восстановление. Код выхода: 0 — успех, 1 — не прошёл порог или
сверка, 2 — прогон не удалось выполнить. Отчёты: `~/markiro-load/smoke-<дата>/` (`report.json`, `report.md`,
`host-stdout.log`); папка внутри git-репозитория отвергается. Другая папка: `--out` или `MARKIRO_LOAD_OUT`.

Без CI: workflow «Standalone load test» (Actions, «Run workflow», профиль `smoke`). Он не входит в обязательные проверки.

## 5. Длинный прогон (soak, 4 часа)

```
caffeinate -i apps/standalone/target/release/markiro-loadtest run --profile soak --out ~/markiro-load
```

На Windows (PowerShell, сон отключён в параметрах питания):

```
apps\standalone\target\release\markiro-loadtest.exe run --profile soak --out D:\markiro-load
```

То же, но по 10 сканов/с, четыре часа, три копии под нагрузкой (на 25, 50 и 75 %). Каждые 30 секунд прогон пишет строку
хода в stderr. Параметры меняются без пересборки: `--set scanRate=7 --set durationS=600` (поля профиля: `stations`,
`handhelds`, `scanRate`, `durationS`, `boxCapacity`, `palletBoxes`, `boxBlockSize`, `palletBlockSize`, `flushMs`, `batchMax`,
`meanOnlineS`, `meanOfflineS`, `lateDupRate`, `checkedDupRate`, `raceRate`, `resendRate`, `totalsPollS`, `backupAt`,
`sampleS`, `seed`, `closeOrder`).

## 6. Что считается успехом

Все проверки отчёта выполнены и ни один порог не превышен (`verdict.pass`). Пороги (smoke; soak: p95 150, p99 400, p99 под
копией 800 мс):

| Что                                                                   | Порог                                                                                                                         |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| маршрут фактов                                                        | p95 ≤ 100 мс, p99 ≤ 250 мс, максимум ≤ 2000 мс (таймаут занятости базы 5 с)                                                   |
| факты во время копии                                                  | p99 ≤ 500 мс                                                                                                                  |
| проверка кода (станция ждёт 300 мс)                                   | p99 ≤ 150 мс, дольше 300 мс — не более 0,1 %                                                                                  |
| прочие маршруты (список смен, блоки, вход)                            | p99 ≤ 500 мс                                                                                                                  |
| ответы 5xx и строки ERROR журнала хоста                               | 0                                                                                                                             |
| строки журнала про занятую базу (`database is locked`, `SQLITE_BUSY`) | 0                                                                                                                             |
| запросы без ответа; запросы, отвергнутые хостом (4xx)                 | 0                                                                                                                             |
| очередь журнала WAL (кадры, которые не перенесла контрольная точка)   | ≤ 8000; файл WAL ≤ 256 МиБ                                                                                                    |
| память хоста (прогон от 30 минут)                                     | рост ≤ 20 МиБ/ч                                                                                                               |
| дескрипторы хоста                                                     | ≤ 64 + 4 на устройство; к концу не более чем на 8 больше, чем после разогрева                                                 |
| сделано сканов                                                        | не менее 90 % идеала (иначе отстаёт сам тест)                                                                                 |
| сверка                                                                | точная: сканы, квитанции, короба, паллеты, владельцы кодов, конфликты `late` и `displaced`, живые позиции                     |
| SSCC                                                                  | ни один номер не встречается дважды; блоки устройств не пересекаются                                                          |
| копия под нагрузкой                                                   | открывается, проходит `integrity_check`; сканов в ней не меньше подтверждённых до просьбы и не больше отправленных к её концу |
| восстановление                                                        | в девяти таблицах фактов ровно столько же строк, сколько в живой базе; хост на восстановленной папке отвечает итогом смены    |
| выключение                                                            | хост завершается по Ctrl+C (SIGINT) сам (кроме Windows)                                                                       |

## 7. Если прогон не прошёл

| Сообщение отчёта                                                      | Что это значит и куда смотреть                                                                                                                                                          |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `facts p99` / `p95` / `max`                                           | хост медленный: смотрите очередь WAL, диск (fsync), `facts_during_backup` (копия мешает записи), загрузку процессора; маршрут `device_shifts` — запросы итогов                          |
| `busy database`                                                       | запись держит блокировку дольше 5 секунд: настоящий дефект пути записи. Запустите `cargo test -p markiro-loadtest --test write_review`, найдите транзакцию по строкам `host-stdout.log` |
| `server errors`                                                       | первые строки ERROR в `log.firstErrors` отчёта и в `host-stdout.log`                                                                                                                    |
| `check db_*`, `totals_*`, `by_device_*`, `office_*`                   | итоги хоста расходятся с подтверждёнными: факт потерян или посчитан дважды. Сравните `expected` отчёта с базой; серьёзно                                                                |
| `sscc_unique`, `sscc_blocks_disjoint`, `sscc_serials_from_own_blocks` | два короба или паллеты с одним SSCC: серьёзно, выпуск блокируется                                                                                                                       |
| `conflicts_injected_vs_observed`                                      | внесённые дубликаты и гонки не стали конфликтами: тест не внёс их (смотрите `lateDups`, `racesTaken` устройств) либо реестр кодов пропустил конфликт                                    |
| `backup … between`                                                    | копия под нагрузкой потеряла подтверждённое или содержит неотправленное: копия не была снимком                                                                                          |
| `restore_rows_*`                                                      | восстановление потеряло строки                                                                                                                                                          |
| сценарии `close-*`, `force-close`, `missing-reason`                   | логика закрытия смены на хосте (план 2b)                                                                                                                                                |
| `WAL backlog`                                                         | контрольные точки не успевают (долгие читающие транзакции): смотрите ряд `series` и копии                                                                                               |
| `host memory growth` / `descriptors`                                  | утечка: ряд `series` покажет ступеньку или наклон                                                                                                                                       |
| `the devices made … % of the ideal scans`                             | тест на слабом ПК или сканер ждал серию SSCC (`stalls`)                                                                                                                                 |
| `device N stopped`                                                    | хост отверг пакет (4xx): версии теста и хоста не совпадают по протоколу                                                                                                                 |
| `the host did not stop on request`                                    | зависание остановки хоста                                                                                                                                                               |

## 8. Сравнение с прошлым прогоном

Первый успешный отчёт профиля сохраните как базовую линию (вне репозитория):

```
mkdir -p ~/markiro-load/baseline && cp ~/markiro-load/smoke-<дата>/report.json ~/markiro-load/baseline/smoke.json
```

Следующий прогон сравнивается командой (код выхода 1 при регрессии):

```
markiro-loadtest compare ~/markiro-load/baseline/smoke.json ~/markiro-load/smoke-<новая дата>/report.json
```

Регрессия: другой профиль; вердикт стал хуже; p95 или p99 маршрута фактов выросли больше, чем в 1,5 раза плюс 20 мс (проверка
кода и список смен: плюс 10 и 20 мс); сканов в секунду меньше 90 % прежнего; максимум памяти хоста вырос больше, чем в 1,25
раза плюс 16 МиБ; очередь WAL — больше, чем в 1,5 раза плюс 1000 кадров; появился класс ошибки, которого не было.
`markiro-loadtest summary <report.json>` печатает краткий отчёт ещё раз. Базовую линию обновляйте только после осознанного
изменения хоста, с записью причины.

## 9. Пороги и их изменение

Пороги — код (`apps/standalone/loadtest/src/profile.rs`, `Thresholds::for_profile`). Это стартовые числа: первые три прогона
smoke на раннере CI и на вашем ПК — калибровка. Порог можно ужесточать свободно; ослаблять — только с тремя отчётами в
описании изменения и вашим «да». Пересмотр самой СУБД (спека §8) — не тут: больше ~20 одновременных устройств на хост, больше
~50 млн строк в `scans` или нужда в тёплом резерве.

## 10. Прогон на уже запущенном хосте (attach)

Только на одноразовом хосте: тест создаёт устройства, товар и смены. Ключ офисной станции и данные администратора — из
окружения, не из командной строки:

```
export MARKIRO_LOAD_OFFICE_DEVICE_KEY=… MARKIRO_LOAD_ADMIN_LOGIN=… MARKIRO_LOAD_ADMIN_PASSWORD=…
markiro-loadtest run --profile smoke --host attach --attach-url https://10.0.0.5:45710 --fingerprint <64 hex> [--data-dir <папка данных>] [--pid <pid хоста>]
```

Без `--data-dir` нет сверки по базе, копий и восстановления (остаётся сверка через API); без `--pid` нет памяти и
дескрипторов; журнала хоста в этом режиме нет (занятая база видна только по ответам 5xx).

## 11. Чего тест не доказывает

Настоящие принтеры и сканеры, Wi-Fi и сеть завода, Windows-службу как службу, диски завода (проверьте длинный прогон на ПК с
такими же дисками), 1С, проверки этикеток (`box_label`, `pallet_label`), исключения коробов, режим проверки, расформирование,
складские паллеты и склад ТСД. На Windows хост завершается принудительно (там нет SIGINT), очередь WAL может не читаться
(в отчёте предупреждение).

## 12. Чек-лист приёмки вехи

- [ ] smoke зелёный в CI на ветке выпуска (workflow «Standalone load test»), отчёт приложен
- [ ] soak (4 часа) зелёный на ПК с дисками, как на заводе; отчёт сохранён как базовая линия
- [ ] три копии под нагрузкой открылись, восстановление дало те же числа строк
- [ ] `markiro-loadtest compare` с базовой линией — без регрессий
- [ ] предупреждения отчёта прочитаны и записаны
````

- [ ] **Step 2: Append to `apps/standalone/AGENTS.md`** (at the end of the file, after its last section, with one blank line before the heading):

```markdown
## Load and soak harness

`apps/standalone/loadtest` (crate `markiro-loadtest`, a workspace member that is not part of the build's version contract: its
version stays `0.0.0`) is the acceptance harness of spec 2026-10-20 §8: it starts the real `markiro-host` as a child process
on a throwaway folder, makes the site through the host's own routes (wizard, product, templates, small SSCC blocks,
`maxStations`, stations by local pairing and handhelds by code, one shared shift), and runs one simulated device per station or
handheld (`engine.rs`, a pure state machine: outbox, open box and pallet, blocks by the half rule; `device.rs`, its network
tasks). A ledger of receipts is the oracle: at the end the host's totals and its database (read-only, from outside) must equal
it exactly. Drills (`drills.rs`) then close fresh shifts in three orders, force-close one and close one with no reason; a
backup is taken under load and at the end, and the last one is restored into a folder of its own (`probes.rs`).

- Commands (the owner's runbook is `docs/runbooks/standalone-load-test.md`): `markiro-loadtest run --profile tiny|smoke|soak
[--set field=value]… [--out DIR] [--host spawn|in-process|attach]`, `compare OLD.json NEW.json`, `summary REPORT.json`; exit
  0 pass, 1 failed verdict or regression, 2 could not run. Profiles and thresholds are `profile.rs`; smoke is 4 stations + 2
  handhelds × 5 scans/s for 3 minutes, soak the same × 10 scans/s for 4 hours.
- Reports go outside the repository (`--out`, `$MARKIRO_LOAD_OUT`, default `~/markiro-load`; a folder inside a git checkout is
  refused). A report holds no key, session, pairing code or password; attach credentials come from the environment
  (`MARKIRO_LOAD_OFFICE_DEVICE_KEY`, `MARKIRO_LOAD_ADMIN_LOGIN`, `MARKIRO_LOAD_ADMIN_PASSWORD`), never from the command line.
- Gate: the crate's unit tests and `tests/write_review.rs` run in `standalone-rust` and the Windows job with the workspace;
  `tests/self_run.rs` is `#[ignore]`; runs are by hand or by the opt-in workflow `.github/workflows/standalone-load.yml`
  (`workflow_dispatch` only; never required). Run a smoke after a change to a hot write path (facts, SSCC blocks, entry,
  leave, close, backup, restore) or to `db.rs`.
- The harness builds every payload from `markiro-proto`: a renamed wire field breaks its build. It also names the plan-2b
  fields of the host (`maxStations`, `participants`, `totals`, `byDevice`, `closeReasonMissing`, `partClosed`,
  `reasonMissing`, `multi-station-v1`) as strings: a change of those names changes `engine.rs`, `device.rs`, `drills.rs`,
  `run.rs` and `site.rs` together with the fixtures.
- `tests/write_review.rs` is spec §8's write review: no function reads on a deferred `pool.begin()` and then writes, the hot
  write paths (`receive_facts`, `issue_block`, `enter_shift`) call `begin_write`, the code check holds no transaction, a facts
  batch is one transaction of at most 100 records, a backup is one `VACUUM INTO`. A new write route takes `begin_write`.
- Not simulated: label checks, box exceptions, validation shifts, disaggregation, warehouse pallets, the handheld's warehouse and
  pallet-event routes, printers, scanners, a real LAN and the Windows service. A green run proves none of them.
```

- [ ] **Step 3: Check and commit.**

Run: `pnpm --dir "$WT" --config.verifyDepsBeforeRun=false exec prettier --check apps/standalone/AGENTS.md docs/runbooks/standalone-load-test.md` and `git -C "$WT" diff --check`. Expected: clean (both texts above are already in Prettier's format: its table alignment and its continuation indent).

```bash
git -C "$WT" add docs/runbooks/standalone-load-test.md \
  apps/standalone/AGENTS.md
git -C "$WT" commit -m "docs(standalone): the load test runbook and the scoped guide section

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 17: Acceptance runs and the final gates

**Files:**

- None (runs and records). The reports stay outside the repository.

**Interfaces:**

- Consumes: everything above and the merged host plan 2b.
- Produces: the executor's report with the numbers below; the owner's remaining steps.

- [ ] **Step 1: Build in release** (the numbers of a debug build mean nothing):

Run: `cargo --offline --locked build --release --manifest-path "$WT/apps/standalone/Cargo.toml" -p markiro-host -p markiro-loadtest`
Expected: both binaries in `$WT/apps/standalone/target/release/`.

- [ ] **Step 2: A child-process self-test run** (sandbox disabled if it refuses `listen`):

Run: `"$WT/apps/standalone/target/release/markiro-loadtest" run --profile tiny --keep-data --out "$TMPDIR/markiro-load"`
Expected: exit 0. Then read the figures that only a child-process run has:
Run: `node -e 'const r = require(process.argv[1]); console.log(JSON.stringify({ backlog: r.resources.walBacklogMaxFrames, rss: r.resources.rssMaxMib, fds: r.resources.fdsMax, graceful: r.gracefulStop, busy: r.log.busyLines, errors: r.log.errorLines }))' "<the tiny report.json>"`
Expected on Linux and macOS: `backlog` a number (a null means `host.db-shm` was not readable: investigate, do not ignore), `rss` and `fds` numbers (on macOS `ps` and `lsof` must be allowed), `graceful` true, `busy` 0, `errors` 0.

- [ ] **Step 3: The smoke profile** (about five minutes):

Run: `"$WT/apps/standalone/target/release/markiro-loadtest" run --profile smoke --out "$TMPDIR/markiro-load"`
Expected: exit 0 and `PASS`. Record in the report: the facts p50/p95/p99/max, the code check p99, the WAL backlog maximum and p99, the host's memory and descriptors, scans per second, and how many conflicts and displacements were reconciled. If a latency threshold fails on the executor's machine, do not change the number: record the report and say so (D9); a failed check (anything named `db_*`, `totals_*`, `sscc_*`, `restore_*`, a drill) is a defect to fix at its source.

- [ ] **Step 4: The comparison.** Run the smoke profile a second time, then:

Run: `"$WT/apps/standalone/target/release/markiro-loadtest" compare "<first report.json>" "<second report.json>"`
Expected: `no regression`, exit 0 (a regression between two runs of one build on one machine is noise of the machine: record both reports and the rule that fired).

- [ ] **Step 5: The final gates.**

Run: `cargo fmt --manifest-path "$WT/apps/standalone/Cargo.toml" --all -- --check`; `cargo --offline --locked test --manifest-path "$WT/apps/standalone/Cargo.toml" --workspace --no-fail-fast` (the shell's tests need `apps/standalone/dist`: build it first with `pnpm --dir "$WT" --config.verifyDepsBeforeRun=false turbo build --filter '@markiro/standalone...'`); `pnpm --dir "$WT" --config.verifyDepsBeforeRun=false test:ci-policy`; `pnpm --dir "$WT" --config.verifyDepsBeforeRun=false test:standalone-release:contract`; `git -C "$WT" diff --check`; `graphify update .` if `graphify-out/graph.json` exists in the worktree.
Expected: all pass; the workspace run includes the crate's 63 tests and one ignored (`self_run`).

- [ ] **Step 6: Report.** List: the behaviour added (a harness, a workflow, a CI contract, docs; no product change); the files; each gate and its result; the smoke numbers of Step 3; and what was not exercised: the soak (four hours, the owner's step, the runbook's §5), Windows (the crate compiles and tests on the Windows CI job; a Windows load run, the SIGINT-less stop and the shm read are untried), a CI runner (dispatch `standalone-load.yml` with `smoke` after merge), real handhelds and a real LAN.

**The owner's steps after the merge** (the runbook, `docs/runbooks/standalone-load-test.md`): dispatch the workflow with `smoke` and keep its report as the baseline; run the soak for four hours on a PC with the factory's disks (Windows too); read the warnings; tick the checklist of §12.

---

## Self-Review

**1. Spec coverage**

| Spec item                                                                                                        | Where                                                                                                                                                  |
| ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| §8 SQLite stays; the host is the single writer; settings WAL, `synchronous=FULL`, 5 s, pool 4, `BEGIN IMMEDIATE` | D13, Task 14 (`write_review.rs` pins the hot paths and the deferred-begin rule), Task 9-13 (the load runs those settings unchanged)                    |
| §8 acceptance: simulator of 4 stations and 2 handhelds at 5-10 scans/s for hours                                 | Task 2 (smoke 4+2 × 5/s × 3 min, soak 4+2 × 10/s × 4 h), Tasks 7-9 and 13 (the run), Task 15 (workflow), Task 16 (runbook §5)                          |
| §8 p99 of the fact routes                                                                                        | Task 4 (per-route histograms), Task 2 (thresholds), Task 11 (`evaluate`), Task 13 (the run)                                                            |
| §8 WAL checkpoint behaviour                                                                                      | D7, Task 5 (`wal.rs`, `sampler.rs`), Task 11 (backlog p99, file size)                                                                                  |
| §8 a backup under load                                                                                           | D8, Task 12 (`probes::backup`), Task 13 (scheduled at the profile's fractions, and a last one)                                                         |
| §8 a restore                                                                                                     | Task 12 (`probes::restore_roundtrip`: equal row counts, a host started on the restored folder)                                                         |
| §8 write review: short transactions, one writer for hot paths, no long read transactions                         | Task 14                                                                                                                                                |
| §8 revisit thresholds (20 devices, 50 M rows, warm standby)                                                      | Global Constraints, runbook §9                                                                                                                         |
| §9 step 2: the load test as an acceptance criterion                                                              | the whole plan; Task 17 and the runbook's checklist                                                                                                    |
| §11 a duplicate scan on two stations (the registry decides, earliest wins)                                       | D5 (late duplicates, races), Task 8-9 (injection), Task 10 (`db_conflicts_late`, `db_conflicts_displaced`), Task 13 (`conflicts_injected_vs_observed`) |
| §11 the shift-wide total is the host's, from the registry                                                        | Task 13 (`api_checks`: `totals_accepted_*`, `by_device_adds_up_*`, `office_units`), Task 10 (`db_live_items`)                                          |
| §11 a hanging participant: the office force-closes; late data stays late                                         | Task 12 (`force-close` drill: the part's later scans are accepted and the shift stays closed)                                                          |
| task: close in different orders including force close                                                            | Task 12 (three orders, a forced close, a missing reason), Task 13 (the run's own close in `closeOrder`)                                                |
| task: SQLITE_BUSY zero, errors by class                                                                          | D6, Tasks 4 and 6 (error classes, log scan), Task 11 (`busy database`, `server errors`)                                                                |
| task: accepted vs expected totals, SSCC uniqueness, conflicts vs injected                                        | D4, Tasks 8, 10, 13                                                                                                                                    |
| task: memory and descriptors of the host process                                                                 | Task 5 (`procstat`), Task 6 (a child process), Task 11 (slope, bounds)                                                                                 |
| task: smoke and soak profiles, thresholds with numbers                                                           | Task 2                                                                                                                                                 |
| task: JSON and Markdown report outside the repo, run-to-run comparison                                           | Tasks 11 and 13 (`report.json`, `report.md`, the `--out` guard, `compare`), Task 16 (baseline rules)                                                   |
| task: CI smoke job, never in the default gate, justified                                                         | D2, Task 15                                                                                                                                            |
| task: a final runbook for the owner                                                                              | Task 16                                                                                                                                                |

**2. Placeholder scan.** Searched the plan for "TBD", "TODO", "implement later", "fill in", "similar to Task", "add appropriate", "handle edge cases": none. Every code step holds the file's real text as it compiled and passed in the planning-time scratch workspace (63 tests, `rustfmt` clean); the Cargo lock block, the workflow and the CI test edits are given whole. The only values left to the executor are paths named by `$WT`, the report folders and the dates in them.

**3. Type consistency.** `Profile`, `CloseOrder` and `Thresholds` (Task 2) are the types `report.rs` (11), `drills.rs` (12), `run.rs` and `cli.rs` (13) use, field for field (`scan_rate`, `duration_s`, `backup_at`, `close_order`, `batch_max`, `box_block_size`, `pallet_boxes`); `gen::{Code, DeviceClock, record, scan_ok, scan_duplicate, box_closed, pallet_closed, shift_closed, sscc}` (3) match `engine.rs` (8), `device.rs` (9) and `drills.rs` (12); `Route` and `Metrics` (4) match `api.rs`, `device.rs`, `site.rs`, `probes.rs`; `Api::{send, facts, open_stream}` (4) are called with the same signatures in `site.rs` (7), `device.rs` (9), `probes.rs` and `drills.rs` (12); `Host::{in_process, spawned, attached, log_scan, stop}` (6) match `run.rs`, `probes.rs`; `DeviceSpec`, `Office`, `Site`, `ShiftInfo`, `provision`, `plan_and_enter` (7) match `device.rs`, `drills.rs`, `run.rs`; `Ledger::{apply, expected, snapshot}`, `Expected`, `Snapshot`, `FactMeta` (8) match `device.rs`, `dbcheck.rs` (10), `run.rs`; `Engine`'s methods (8) match `device.rs` and `drills.rs`; `DeviceStats` (9) matches `report.rs` (11) and `run.rs`; `Sample` (5) and `Resources` (11) match `run.rs`; `Check`, `DrillResult`, `BackupResult`, `RestoreResult`, `Verdict`, `Report` (4, 11) match `probes.rs`, `drills.rs`, `run.rs`, `cli.rs`. The host contract's JSON names (`maxStations`, `participants`, `state`, `totals.{accepted, boxesClosed, pallets}`, `byDevice[].{deviceId, accepted, boxesClosed, pallets}`, `closeReasonMissing`, `details.{partClosed, reasonMissing}`, `reasonCode`, `expectedRev`) are written the same way in `site.rs`, `device.rs`, `drills.rs`, `run.rs` and the contract at the end of the host plan. The lock block of Task 1 lists exactly the dependencies of the manifest.

**Gaps found (for the owner)**

1. **No server-side latency.** The host has no timing metrics, so every latency here is client-side (TLS session, queueing in the pool of 4 and the network included). That is what a station experiences, but a slow figure cannot be split between the host and the machine's own noise.
2. **SQLITE_BUSY is invisible to a client.** The API answers 500 `internal` and logs the cause; the harness counts it from the host's log (child-process runs only) and from every 5xx. An in-process or attached host has no log: a busy error there is only a 5xx. A host counter of refused locks would make it exact; it is not part of this plan.
3. **WAL checkpoints cannot be forced or asked from outside.** The harness reads `mxFrame - nBackfill` from `host.db-shm` (D7). If `host.db-shm` is unreadable (Windows may refuse a second reader) the run only warns. The host never runs an explicit checkpoint after a batch: with a reader always open the backlog could grow; the threshold and the p99 are what would show it, and an explicit `PRAGMA wal_checkpoint(PASSIVE)` after a batch is the first remedy to try (a host change, not here).
4. **The plan depends on names, not on code.** The multi-device fields and routes (`maxStations`, `participants`, `totals`, `byDevice`, `closeReasonMissing`, `PUT …/close-reason`, `partClosed`, `reasonMissing`, `multi-station-v1`) were read from the host plan's contract; the code does not exist yet. Everything else was run against today's host (see «Verification at planning time»). If the host plan renames one, `site.rs`, `device.rs`, `drills.rs` and `run.rs` change with it.
5. **A handheld is a station here.** It uses the facts routes and the same shift entry (plan 2b makes it a full participant). The handheld's own routes (warehouse lookups and reprints, pallet events, box registry) and the Kotlin client are not exercised; a load of those is a separate plan if the owner wants it.
6. **Leave and re-entry under load are not driven.** Link drops are network drops (the device keeps its slot), as an offline station does; `POST …/leave` and a device returning into a freed slot are covered by the host plan's tests, not by the load. The line-full refusal is covered there too.
7. **Soak on a CI runner is possible but not the point.** The workflow allows it (330 minutes); the factory's disks and Windows are what the owner's four hours are for.
8. **Attach mode writes to its target.** It creates devices, a product, templates and shifts, and changes the line's limit and the SSCC block sizes of that site: throwaway hosts only.
9. **The first thresholds are unmeasured on CI.** They were chosen from the host's design (a commit is one fsync; a debug-build host answered a single device's facts at p99 21 ms in the planning-time run on a laptop), the 300 ms rule of the station and the 5 s busy timeout. The policy of D9 makes the first three runs calibration.
10. **Command-line portability.** The child-process mode uses `kill -INT` (Unix) and `ps`/`lsof` (macOS) or PowerShell (Windows) for what Rust's standard library does not give; `markiro-host run` binds all interfaces, so a run opens the port to the LAN for its length.
