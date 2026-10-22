# Multi-station load test: the scenarios the merged harness does not exercise (Task 18 of the load-test plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn every multi-station behaviour the merged harness (`apps/standalone/loadtest`, PR #775) does not exercise into a deterministic scenario against the real host over the pinned HTTPS client, with checks that can fail, wired into the run, the report, the verdict, the profiles and the runbook: the line's limit (`shift_line_full`) and revoked devices, a build without `multi-station-v1`, leave and re-entry under load, a closed part that keeps sending, two and N closes at the same instant, the office's close racing a device's, several lines and shifts at once, a backup taken in the middle of the closes, and, on a spawned host only, a `kill -9` with WAL crash recovery and a stop with device back-off. Plus a precise measurement of the WAL backlog observed near SQLite's 1000-frame automatic checkpoint, recorded in the runbook, with no host change.

**Architecture:** A new module tree `loadtest/src/scenarios/` runs after the main run (after the restore), one scenario at a time, each on a **fresh host and a fresh site of its own** (folder `<work>/scenarios/<name>/`), in the host mode of the run (in-process or spawned; attach judges none). A scenario owns its `Metrics`, so its deliberate refusals (409, 401, connection refused) never touch the main run's zero-error thresholds; its latencies are recorded, not judged. A scenario is a `Ctx` (host, site, metrics, checks, observations), a few scripted requests and, where the scenario says «under load», a `Load` of simulated devices (the existing `SimDevice`, quiet profile) whose ledger stays the oracle. Each scenario returns a `ScenarioResult` (`report.rs`); the verdict fails on any failed check of a judged scenario and warns on a scenario that was not judged. A separate file-only observer (`wal_watch.rs`) samples the WAL header and the wal-index every 100 ms during the main run and adds a `walWatch` summary to the report.

**Tech Stack:** Rust 2021 (tokio, reqwest with the pinned verifier, sqlx read-only, serde), the host library (`markiro-host`) and the wire types (`markiro-proto`). No new dependency: `tokio::sync::Barrier` is in tokio's `sync` feature, already enabled.

**Base:** `origin/main` at `a165586c5` (PR #775 merged: host plan 2b, office, station, handheld, load harness). Worktree `/tmp/claude/wt/lt18`, branch `claude/loadtest-multi-station`. The load-test plan is `docs/superpowers/plans/2026-10-20-multi-station-load-test.md` (its decisions D1–D13 still hold; this plan adds E1–E12). Spec: `docs/superpowers/specs/2026-10-20-standalone-multi-station-shift-design.md` (§4.2, §8, §11, §12.5, §12.9).

**Verification at planning time (so the executor knows what is proven and what is not).** Every host behaviour this plan asserts was read in the host source at `a165586c5`; the functions are named in E7 and beside each check. Nothing below was compiled or run while the plan was written (the planning environment refused a scratch copy of the workspace): expect the usual compile fixes (a borrow, a missing `use`), and fix them without changing what a check asserts. Where the host's code leaves an outcome to timing (which of two racing requests lands first, whether a `kill -9` lands inside a commit), the plan records the outcome as an observation and asserts only the rule each outcome must obey. A scenario that reveals a host defect is **reported, not tuned**: never loosen a check, never change host code in this plan (Global Constraints).

**Commands.** `$WT` is `/tmp/claude/wt/lt18`. Never `cd`. Cargo runs as `cargo --offline --locked … --manifest-path "$WT/apps/standalone/Cargo.toml"`. Tests that bind a loopback socket (every test that starts a host: `Ctx`, `Host::in_process`, `Host::spawned`) need the sandbox disabled in an agent environment that blocks `listen`; pure tests (`report::`, `profile::`, `wal_watch::` header tests, the `dbcheck::` fixture tests) do not. Run a focused test with `--nocapture` when its `OBSERVED` lines matter. A test filter is one string: run `report::tests` and `profile::tests` as two commands.

## Global Constraints

Inherited from the load-test plan (unchanged) and the scoped guides:

- SQLite stays; the host is the only writer of the master database. **The harness reads the database read-only and never writes to it**; it never runs a checkpoint (a checkpoint writes the database file).
- **No host code changes in this plan.** A host change (an explicit checkpoint, a 5xx injection point, anything a scenario reveals) is a separate decision of the owner.
- New dependencies: none. If one turns out to be needed, it is exact-pinned (`=x.y.z`) and the lock diff is reviewed; prefer not to.
- No secret in a report: every scenario site's secrets (administrator password, device keys, pairing codes, session token) join the run's secrets, and `report::redact` is applied to the whole report, scenarios included, before it is written (`cli::write_reports`, `run::execute`).
- A device key, an office session, a password or a pairing code is never printed, logged or put on a command line.
- Only processes this harness spawned are killed or signalled: the `Child` handle `Host::spawned` keeps. Never `pkill`, never a pid found by name, never a signal to a pid whose child already ended (a pid can be reused).
- Tests leave no process, port or temp folder behind: hosts stop or are dropped (`Drop for Host` kills a spawned child), work folders are `tempfile::tempdir()`.
- Tests assert exact numbers. A failing **latency** threshold is recorded with its report; a failing **correctness** check (`db_*`, `totals_*`, `sscc_*`, `participant_*`, `restore_*`, drills, scenario checks) is a defect to report with its evidence (the check's name and detail, the report path, the kept `scenarios/<name>/` folder).
- Rust gates: `cargo fmt --all -- --check`, `cargo test -p markiro-loadtest`, `cargo test --workspace --no-fail-fast` before completion, `git diff --check`. `cargo clippy` is **not** a gate (the existing `proto` and `host` crates fail `-D warnings`). Host-only Cargo runs prove nothing about Windows.
- Report automated checks separately from what was not exercised (Windows, a real LAN, real stations and handhelds, a soak, a power cut).
- Commits are scoped, stage explicit paths, and end with exactly one trailer line `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. No push.

---

## Decisions taken by this plan (with reasons)

- **E1. A scenario runs on a fresh host and a fresh site, after the main run.** Inside the main run a scenario would move the backup bounds (`probes::backup` counts the ledger's scans plus the drills'), break the restore's row equality (the restore compares nine tables with the live database), and pour deliberate 409s, 401s and refused connections into the zero-error thresholds (`client_errors`, `net_errors`). On a host of its own each scenario starts from a known state, and its folder is kept when it fails. Cost: a site per scenario (one wizard, a few pairings, about a second).
- **E2. A scenario has its own `Metrics`; its latencies are recorded, never judged.** The thresholds of `profile.rs` stay the only latency rules (D9). A scenario's own `5xx` count must be zero, and a scenario that injects no fault must also have no request without an answer: both are correctness checks of the scenario.
- **E3. Every scenario check is a correctness check.** Its name is local to the scenario (the verdict prefixes `scenario <name>`); a failure is a defect to report. Each scenario task ends with a mutation step that proves at least one of its checks can fail.
- **E4. «Not judged» is explicit.** `kill-restart` and `outage` need a host this harness spawned (a kill, a stop and a restart on the same port and data folder): with `--host in-process` (the CI workflow) they return `judged: false` with the reason, which the verdict turns into a warning. With `--host attach` no scenario is judged (the harness cannot make a fresh host beside an attached one).
- **E5. The profile names the scenarios.** `Profile.scenarios` (`--set scenarios=all|none|a,b`), `tiny` and `smoke` run all of them, `soak` none (a soak is about hours, not about the scenarios; run them with `--set scenarios=all` if wanted). `profile::SCENARIOS` is the list, grown by each scenario task; `validate` refuses an unknown name.
- **E6. A scenario's load is quiet.** No link drops, no injected duplicates, no races (`quiet()`), resends kept: what a scenario studies is its own behaviour, and its ledger reconciles exactly with `dbcheck::reconcile`. A scripted close of a load device goes through `SimDevice::close_part_ledgered`, which applies its receipt to the same ledger, so the per-device receipt counts stay exact.
- **E7. Host behaviours, as read at `a165586c5` (the oracle of the checks):**
  - Entry into an open shift (`shift_participants::decide_entry`, called by `routes/device_shifts.rs::enter_shift` inside `begin_write`): an active participant re-enters; a closed one reads back (but a build that does not name `multi-station-v1` is answered `409 conflict` with `details.constraint = "shift_status"`, `details.status = "closed"`, **even while the shift is active**); a device that never entered and names nothing is `shift_busy` **whatever the free slots, even with no active participant at all**; a device that left, or a new one naming the capability, takes a slot while `active_others < maxStations`, else `shift_line_full` with `details.maxStations` and `details.active` = the other live devices holding a slot. A participant that left rejoins without naming the capability (it only guards a first entry). A first entry of a planned shift opens it whatever is named (aggregation shifts need nothing; a handheld always needs `handheld-host-v1`, else `station_update`).
  - `active_others` and `line_slots_in_use` exclude revoked devices; `open_others` (the close rule) does not: a revoked device's open part keeps the shift open until the office closes it. A revoked key is `401` on every device route (`auth.rs`).
  - `PUT /v1/office/lines/{id}` refuses a limit below the busiest active shift's live slots with `conflict` on `line_stations_in_use`, `details.active`.
  - `protocol_unsupported` (`400`) is about the `x-markiro-protocol` header only (`server.rs::protocol_guard`, accepted range 1–7): no capability is involved. The load-test plan's Task 12 report («device without `multi-station-v1` → `protocol_unsupported`») was wrong; the scenario `capability` records what the host does.
  - Reads are not gated by the capability: `GET /v1/device/shifts` gives an active shift of the device's line with its participants and totals to any device of the line, entered or not (`with_participation`; `myState` absent for a non-participant).
  - Facts (`routes/facts.rs`, one `begin_write` per batch): a participant in any state may send them (`facts::entered_shift` needs a participant row, nothing more). A **left** part's facts are accepted and never marked late. A **closed** part's facts are accepted, count in the shift's totals while the shift is active (`shift_totals` counts live box items), and the part's `late_data_at` is set once (`mark_part_late`); nothing reopens it. A second close of a closed part answers `accepted` with `partClosed: true` and writes an `already_closed` close event.
  - Close (`facts/shift_closed.rs::apply`, `facts::close_part`): closes are serialised by `BEGIN IMMEDIATE`, so of two closes at the same instant the first sees the other part open (`partClosed: true`) and the second closes the shift (no `partClosed`). The shift's `closed_at` is the **latest** device-closed part's moment (whole seconds), whoever lands last; `closed_by` is the last closer. A shared shift (more than one participant ever) closed by a device without a reason, while the host's plan differs from the shift's accepted units, closes with `close_reason_missing = 1` and the receipt `reasonMissing: true`; with a reason, `close_reason_code` is the closer's.
  - The office's close (`routes/office_shifts.rs::close_shift`) takes `expectedRev`; every part close stamps the shift's `rev`. So the office racing a device has exactly two outcomes: office first (200; the device's close is `accepted` with `alreadyClosed: true`, its part closed by `office_user`), or device first (the office gets `409 stale_revision`; the part is closed by the device; the office closes on a fresh read).
  - The registry of codes is the site's, not a shift's (`facts/registry.rs::claim`): a later scan of a code another line's shift owns is a `conflict` naming that shift (`details.winner.shiftId`); an earlier one takes the code (the owner's item is displaced and `code_owners.shift_id` moves). The totals are each shift's.
  - The database's CHECKs already tie a participant's `closed_at`, `left_at` and `closed_by_kind` to its state (migration `0052`); `dbcheck::participant_invariants` (Task 2) checks what no CHECK covers: a closed shift has no open part, an active one has one, a device-closed shift closes at its latest part, the shift's close is audited once, accepted close events equal device-closed parts.
- **E8. Process faults kill only the harness's own child.** `Host::kill_hard` sends `SIGKILL` through `Child::kill` (TerminateProcess on Windows) to the child `Host::spawned` keeps and reaps it; `Host::restart` starts the binary again on the same data folder and port, appending to the same log, and checks the identity (fingerprint) is the same. `Host::stop` never signals a child that already ended. A `kill -9` is a process crash, not a power cut: with `synchronous=FULL` what was committed is on disk either way, and a power cut is not simulated (stated in the runbook).
- **E9. A real 5xx is not induced.** The host answers `500` only on an internal error; inducing one would take a host change or a second writer holding the database lock, and the harness never writes the database. The device back-off is exercised by refused connections (the host stopped) instead, and the gap is recorded. The back-off exercised is the **harness's device model** (`device.rs`: 250 ms doubling to 2 s); the station's and the handheld's own back-off are not exercised here.
- **E10. The WAL is measured from files only, finely, and never checkpointed.** `wal_watch.rs` reads the WAL header (`host.db-wal`: page size, checkpoint sequence, which goes up each time the log starts again from its beginning) and the wal-index (`host.db-shm`: `mxFrame`, `nBackfill`, `nBackfillAttempted`) every 100 ms. A read-only connection cannot checkpoint (SQLite answers `SQLITE_READONLY`; a test pins it), and a checkpoint would be a write anyway, so the harness never runs one. The summary (restarts, backlog quantiles, file size in frames) is reported with plain findings and warnings, not thresholds; the existing `wal_backlog_max_frames` threshold (8000) stays the only WAL rule. Whether the host should checkpoint explicitly is the owner's decision after reading the measurement (Task 12 records it).
- **E11. The report grows without breaking old ones.** `SCHEMA` becomes 2; `scenarios` and `walWatch` are `#[serde(default)]`, `Profile.scenarios` too, so `compare` and `summary` still read schema-1 reports.
- **E12. Gate and timing.** In-process scenario tests are ordinary `#[tokio::test]`s (like `device.rs`'s end-to-end tests): they run in the workspace gate, ten to twenty seconds each. Spawn-only tests (a kill, a restart) are `#[ignore]` and run by hand (Task 13), because restarting on the same port on Windows is unverified. `backup-mid-close`'s test is ignored on Windows (`os error 32` on a copy still held is a known unverified Windows path, runbook §14).

## File structure

| File                                                                         | Responsibility                                                                          | Tasks       |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ----------- |
| `loadtest/src/profile.rs`                                                    | `SCENARIOS`, `Profile.scenarios`, `--set scenarios=`                                    | 1, 4–11     |
| `loadtest/src/report.rs`                                                     | `ScenarioResult`, `Report.scenarios`, `Report.wal_watch`, verdict, Markdown, `SCHEMA` 2 | 1, 12       |
| `loadtest/src/cli.rs`                                                        | usage text, `scenarios/` cleanup on a pass                                              | 1, 3        |
| `loadtest/src/site.rs`                                                       | `provision_site` (no shift), `plan_shift`, three wizard lines, `Site.line_ids`          | 2           |
| `loadtest/src/device.rs`                                                     | pause, resume, seal, online switch, ledgered close, receipt apply                       | 2           |
| `loadtest/src/dbcheck.rs`                                                    | `participant_states`, `participants_in`, `participant_invariants`                       | 2           |
| `loadtest/src/scenarios/mod.rs`                                              | `Ctx`, `Load`, helpers, `run_all`, the dispatcher                                       | 3, 4–11     |
| `loadtest/src/scenarios/line_full.rs`                                        | `line-full`                                                                             | 4           |
| `loadtest/src/scenarios/capability.rs`                                       | `capability`                                                                            | 5           |
| `loadtest/src/scenarios/leave_reenter.rs`                                    | `leave-reenter`                                                                         | 6           |
| `loadtest/src/scenarios/closed_part.rs`                                      | `closed-part`                                                                           | 7           |
| `loadtest/src/scenarios/close_races.rs`                                      | `close-races`                                                                           | 8           |
| `loadtest/src/scenarios/lines.rs`                                            | `lines`                                                                                 | 9           |
| `loadtest/src/scenarios/backup_mid_close.rs`                                 | `backup-mid-close`                                                                      | 10          |
| `loadtest/src/host.rs`                                                       | `stop` guard; `spawned_on`, `port`, `kill_hard`, `restart`                              | 3, 11       |
| `loadtest/src/scenarios/kill_restart.rs`, `loadtest/src/scenarios/outage.rs` | `kill-restart`, `outage`                                                                | 11          |
| `loadtest/src/wal_watch.rs`                                                  | the WAL observer and its summary                                                        | 12          |
| `loadtest/src/run.rs`, `loadtest/src/lib.rs`, `loadtest/tests/self_run.rs`   | wiring, module list, self-test assertions                                               | 1, 3, 4, 12 |
| `docs/runbooks/standalone-load-test.md`, `apps/standalone/AGENTS.md`         | the owner's runbook and the scoped guide                                                | 12, 13      |

All paths under `loadtest/` are `apps/standalone/loadtest/`.

---

### Task 1: The scenario result in the report and the scenario list in the profile

**Files:**

- Modify: `apps/standalone/loadtest/src/profile.rs`, `apps/standalone/loadtest/src/report.rs`, `apps/standalone/loadtest/src/run.rs`, `apps/standalone/loadtest/src/cli.rs`

**Interfaces:**

- Produces: `profile::SCENARIOS: &[&str]` (empty in this task; each scenario task adds its name), `Profile.scenarios: Vec<String>` (`#[serde(default)]`), `--set scenarios=all|none|a,b`; `report::ScenarioResult { name, judged, note, duration_ms, checks, observed, latency, errors }`, `Report.scenarios: Vec<ScenarioResult>` (`#[serde(default)]`), `report::SCHEMA == 2`; the verdict fails on a failed check of a judged scenario and on a judged scenario with no check, warns on a scenario not judged; `render_markdown` adds a «Scenarios» section.

- [ ] **Step 1: Write the failing tests.** Append to the `tests` module of `src/report.rs`:

```rust
    fn scenario(name: &str, judged: bool, checks: Vec<Check>) -> ScenarioResult {
        ScenarioResult {
            name: name.to_owned(),
            judged,
            note: if judged {
                String::new()
            } else {
                "needs a spawned host".to_owned()
            },
            duration_ms: 1,
            checks,
            observed: BTreeMap::new(),
            latency: BTreeMap::new(),
            errors: BTreeMap::new(),
        }
    }

    #[test]
    fn a_failed_scenario_check_fails_the_verdict_and_an_unjudged_scenario_warns() {
        let mut report = sample_passing();
        report.scenarios.push(scenario(
            "line-full",
            true,
            vec![Check::new("entries_admitted", true, "ok")],
        ));
        report.scenarios.push(scenario("kill-restart", false, vec![]));
        let verdict = evaluate(&report);
        assert!(verdict.pass, "{verdict:?}");
        assert!(
            verdict
                .warnings
                .iter()
                .any(|w| w.contains("scenario kill-restart not judged") && w.contains("spawned")),
            "{:?}",
            verdict.warnings
        );
        report.scenarios[0].checks.push(Check::new(
            "refusal_names_the_limit",
            false,
            "expected Some(3), got Some(4)",
        ));
        let verdict = evaluate(&report);
        assert!(!verdict.pass);
        assert!(
            verdict.failures.iter().any(|f| f
                == "scenario line-full refusal_names_the_limit: expected Some(3), got Some(4)"),
            "{:?}",
            verdict.failures
        );
    }

    #[test]
    fn a_judged_scenario_without_a_check_fails() {
        let mut report = sample_passing();
        report.scenarios.push(scenario("lines", true, vec![]));
        let verdict = evaluate(&report);
        assert!(!verdict.pass);
        assert!(
            verdict
                .failures
                .iter()
                .any(|f| f.contains("scenario lines: no check ran")),
            "{:?}",
            verdict.failures
        );
    }

    #[test]
    fn a_report_of_schema_1_without_scenarios_still_reads() {
        assert_eq!(SCHEMA, 2);
        let mut value = serde_json::to_value(sample_passing()).unwrap();
        value.as_object_mut().unwrap().remove("scenarios");
        value["profile"].as_object_mut().unwrap().remove("scenarios");
        value["schema"] = serde_json::json!(1);
        let back: Report = serde_json::from_value(value).unwrap();
        assert!(back.scenarios.is_empty());
        assert!(back.profile.scenarios.is_empty());
    }

    #[test]
    fn the_markdown_lists_each_scenario_and_redaction_reaches_its_checks() {
        let mut report = sample_passing();
        report.scenarios.push(scenario(
            "line-full",
            true,
            vec![Check::new("x", false, "key SECRET-KEY-1")],
        ));
        report.scenarios.push(scenario("outage", false, vec![]));
        report.verdict = evaluate(&report);
        let text = render_markdown(&report);
        assert!(text.contains("## Scenarios"), "{text}");
        assert!(
            text.contains("- scenario line-full: FAILED (1 checks, 1 failed)"),
            "{text}"
        );
        assert!(
            text.contains("- scenario outage: not judged (needs a spawned host)"),
            "{text}"
        );
        let clean = redact(&report, &["SECRET-KEY-1".to_owned()]);
        let all = serde_json::to_string(&clean).unwrap() + &render_markdown(&clean);
        assert!(!all.contains("SECRET-KEY-1"), "a scenario's check leaked a secret");
    }
```

Append to the `tests` module of `src/profile.rs`:

```rust
    #[test]
    fn the_scenarios_are_all_by_default_none_for_soak_and_named_ones_only() {
        let all: Vec<String> = SCENARIOS.iter().map(|name| (*name).to_owned()).collect();
        assert_eq!(Profile::preset("smoke").unwrap().scenarios, all);
        assert_eq!(Profile::preset("tiny").unwrap().scenarios, all);
        assert!(Profile::preset("soak").unwrap().scenarios.is_empty());
        let mut profile = Profile::preset("smoke").unwrap();
        profile.set("scenarios", "none").unwrap();
        assert!(profile.scenarios.is_empty());
        profile.set("scenarios", "all").unwrap();
        assert_eq!(profile.scenarios, all);
        let refused = profile.set("scenarios", "no-such-scenario").unwrap_err();
        assert!(refused.contains("no-such-scenario"), "{refused}");
        profile.scenarios.clear();
        let mut value = serde_json::to_value(&profile).unwrap();
        value.as_object_mut().unwrap().remove("scenarios");
        let back: Profile = serde_json::from_value(value).unwrap();
        assert!(
            back.scenarios.is_empty(),
            "a profile of an older report reads with no scenario"
        );
    }
```

- [ ] **Step 2: Run them to verify they fail.**

Run: `cargo --offline --locked test --manifest-path "$WT/apps/standalone/Cargo.toml" -p markiro-loadtest --lib report::tests`
Expected: FAIL to compile: `cannot find struct, variant or union type ScenarioResult in this scope` and `no field scenarios on type Report` (and in `profile.rs`: `cannot find value SCENARIOS`).

- [ ] **Step 3: The profile's list.** In `src/profile.rs`, below the `CloseOrder` impl and above `pub struct Profile`, add:

```rust
/// The multi-station scenarios a run can take after its main run (plan
/// `2026-10-22-multi-station-load-test-scenarios.md`), in the order it takes them. Each scenario
/// task of that plan adds its name here.
pub const SCENARIOS: &[&str] = &[];
```

In `pub struct Profile`, after `pub close_order: CloseOrder,` add:

```rust
    /// The scenarios run after the main run, each on a fresh host (`scenarios::run_all`); an
    /// older report has none.
    #[serde(default)]
    pub scenarios: Vec<String>,
```

In `Profile::preset`, in the `smoke` literal after `close_order: CloseOrder::Shuffled,` add:

```rust
            scenarios: SCENARIOS.iter().map(|name| (*name).to_owned()).collect(),
```

and in the `soak` literal, after `sample_s: 15,` add:

```rust
                scenarios: Vec::new(),
```

(`tiny` takes `..smoke` and so runs every scenario.) In `Profile::set`, before the `other =>` arm, add:

```rust
            "scenarios" => {
                self.scenarios = match value {
                    "all" => SCENARIOS.iter().map(|name| (*name).to_owned()).collect(),
                    "none" | "" => Vec::new(),
                    list => list
                        .split(',')
                        .filter(|name| !name.is_empty())
                        .map(str::to_owned)
                        .collect(),
                }
            }
```

In `Profile::validate`, before the final `Ok(())`, add:

```rust
        for name in &self.scenarios {
            if !SCENARIOS.contains(&name.as_str()) {
                return Err(format!(
                    "scenarios: '{name}' is none of: all, none, {}",
                    SCENARIOS.join(", ")
                ));
            }
        }
```

- [ ] **Step 4: The report.** In `src/report.rs` change `pub const SCHEMA: u32 = 1;` to `pub const SCHEMA: u32 = 2;`. Below `pub struct RestoreResult { … }` add:

```rust
/// A multi-station scenario (plan `2026-10-22-multi-station-load-test-scenarios.md`): its checks,
/// what it observed, and whether it was judged at all with this run's host.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScenarioResult {
    pub name: String,
    /// `false`: the scenario needs what this host mode lacks (a spawned host); `note` says why.
    pub judged: bool,
    /// Why it was not judged, or which path a judged run did not exercise this time.
    pub note: String,
    pub duration_ms: u64,
    pub checks: Vec<Check>,
    /// What the scenario saw that is recorded, not judged (which order a race took, …).
    pub observed: BTreeMap<String, serde_json::Value>,
    /// Latency of the scenario's own requests by route: recorded, never judged.
    pub latency: BTreeMap<String, LatencySummary>,
    /// The scenario's own error classes: its refusals are deliberate.
    pub errors: BTreeMap<String, u64>,
}
```

In `pub struct Report`, after `pub restore: Option<RestoreResult>,` add:

```rust
    /// The multi-station scenarios, each on a fresh host after the main run; a schema-1 report
    /// has none.
    #[serde(default)]
    pub scenarios: Vec<ScenarioResult>,
```

In `evaluate`, replace

```rust
    if let Some(restore) = &report.restore {
        failed("restore", &restore.checks);
    }
    Verdict {
```

with

```rust
    if let Some(restore) = &report.restore {
        failed("restore", &restore.checks);
    }
    for scenario in report.scenarios.iter().filter(|scenario| scenario.judged) {
        failed(&format!("scenario {}", scenario.name), &scenario.checks);
    }
    for scenario in &report.scenarios {
        if !scenario.judged {
            warnings.push(format!(
                "scenario {} not judged: {}",
                scenario.name, scenario.note
            ));
        } else if scenario.checks.is_empty() {
            failures.push(format!("scenario {}: no check ran", scenario.name));
        }
    }
    Verdict {
```

In `render_markdown`, replace the last statement `out` of the function (after the drills loop) with:

```rust
    if !report.scenarios.is_empty() {
        let _ = writeln!(out, "\n## Scenarios\n");
        for scenario in &report.scenarios {
            let failed = scenario.checks.iter().filter(|check| !check.ok).count();
            let state = if !scenario.judged {
                format!("not judged ({})", scenario.note)
            } else if failed == 0 && !scenario.checks.is_empty() {
                format!("held ({} checks)", scenario.checks.len())
            } else {
                format!("FAILED ({} checks, {failed} failed)", scenario.checks.len())
            };
            let _ = writeln!(out, "- scenario {}: {state}", scenario.name);
        }
    }
    out
```

In `sample_passing`, after `restore: None,` add `scenarios: vec![],`.

- [ ] **Step 5: The run and the usage.** In `src/run.rs`, in the `Report { … }` literal of `execute_raw`, after `restore,` add `scenarios: Vec::new(),` (Task 3 fills it). In `src/cli.rs`, in `USAGE`, replace the line

```text
Attach reads MARKIRO_LOAD_OFFICE_DEVICE_KEY, MARKIRO_LOAD_ADMIN_LOGIN and
```

with

```text
--set scenarios=all|none|NAME,NAME picks the multi-station scenarios run after the main run,
each on a fresh host (default: all for tiny and smoke, none for soak).
Attach reads MARKIRO_LOAD_OFFICE_DEVICE_KEY, MARKIRO_LOAD_ADMIN_LOGIN and
```

- [ ] **Step 6: Run the tests to verify they pass.**

Run: `cargo --offline --locked test --manifest-path "$WT/apps/standalone/Cargo.toml" -p markiro-loadtest --lib report::tests`
Expected: `test result: ok.`, including `a_failed_scenario_check_fails_the_verdict_and_an_unjudged_scenario_warns`, `a_judged_scenario_without_a_check_fails`, `a_report_of_schema_1_without_scenarios_still_reads`, `the_markdown_lists_each_scenario_and_redaction_reaches_its_checks`, and every older `report::tests` test.

Run: `cargo --offline --locked test --manifest-path "$WT/apps/standalone/Cargo.toml" -p markiro-loadtest --lib profile::tests`
Expected: `test result: ok.`, including `the_scenarios_are_all_by_default_none_for_soak_and_named_ones_only`.

- [ ] **Step 7: Mutation check.** In `evaluate`, change `.filter(|scenario| scenario.judged)` to `.filter(|scenario| !scenario.judged)`; run `report::tests` again: `a_failed_scenario_check_fails_the_verdict_and_an_unjudged_scenario_warns` must FAIL. Restore the line and run again: ok.

- [ ] **Step 8: The whole crate still builds and its pure tests pass.**

Run: `cargo --offline --locked test --manifest-path "$WT/apps/standalone/Cargo.toml" -p markiro-loadtest --lib --no-run`
Expected: `Finished` with no error.

- [ ] **Step 9: Commit.**

```bash
git -C "$WT" add apps/standalone/loadtest/src/profile.rs apps/standalone/loadtest/src/report.rs apps/standalone/loadtest/src/run.rs apps/standalone/loadtest/src/cli.rs
git -C "$WT" commit -m "feat(loadtest): scenario results in the report and the scenario list in the profile

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: A site without a shift, device controls, and the participant invariants

**Files:**

- Modify: `apps/standalone/loadtest/src/site.rs`, `apps/standalone/loadtest/src/device.rs`, `apps/standalone/loadtest/src/dbcheck.rs`

**Interfaces:**

- Consumes: nothing new.
- Produces: `site::provision_site(host, metrics, profile, attach) -> Res<Site>` (the site, no shift; `provision` is now `provision_site` + `plan_and_enter`), `site::plan_shift(site, profile, line_id, planned_qty) -> Res<(String, String)>` (id, number), `Site.line_ids: Vec<String>` (the wizard's «Линия 1», «Линия 2», «Линия 3» that exist, in that order; `line_id == line_ids[0]`); `SimDevice::{pause (async), resume, set_online, queue_len, wait_drained (async), seal (async), close_part_ledgered (async), apply_receipt}`; `dbcheck::{participant_states, participants_in, participant_invariants}`.

- [ ] **Step 1: Write the failing tests.**

In `src/site.rs`, in `a_station_site_is_made_through_the_hosts_own_routes`, after `assert_eq!(site.devices.len(), 1);` add:

```rust
        assert_eq!(site.line_ids.len(), 3, "the wizard makes three lines");
        assert_eq!(site.line_ids[0], site.line_id);
```

and append to the `tests` module of `src/site.rs`:

```rust
    #[tokio::test]
    async fn a_site_without_a_shift_is_made_by_provision_site() {
        let dir = tempfile::tempdir().unwrap();
        let mut host = Host::in_process(dir.path()).await.unwrap();
        let mut profile = Profile::preset("tiny").unwrap();
        profile.stations = 2;
        profile.handhelds = 1;
        let site = provision_site(&host, Arc::new(Metrics::new()), &profile, None)
            .await
            .unwrap();
        assert_eq!(site.devices.len(), 3);
        let listed = site
            .office
            .ok("GET", "/v1/office/shifts", None)
            .await
            .unwrap();
        assert_eq!(listed.as_array().map(Vec::len), Some(0), "no shift yet");
        let (id, number) = plan_shift(&site, &profile, &site.line_ids[1], Some(40))
            .await
            .unwrap();
        let planned = site
            .office
            .ok("GET", &format!("/v1/office/shifts/{id}"), None)
            .await
            .unwrap();
        assert_eq!(
            (planned["status"].as_str(), planned["lineId"].as_str(), planned["number"].as_str()),
            (Some("planned"), Some(site.line_ids[1].as_str()), Some(number.as_str()))
        );
        host.stop().await.unwrap();
    }
```

Append to the `tests` module of `src/device.rs`:

```rust
    #[tokio::test]
    async fn a_paused_device_scans_nothing_and_a_sealed_one_has_sent_everything() {
        let profile = quiet(Profile::preset("tiny").unwrap());
        let (_dir, mut host, device, shared) = one_device_site(&profile).await;
        let scanner = tokio::spawn(device.clone().scanner());
        let syncer = tokio::spawn(device.clone().syncer());
        tokio::time::sleep(Duration::from_secs(1)).await;
        device.seal(Duration::from_secs(30)).await.unwrap();
        let made = device.records_made();
        assert!(made > 0, "the device scanned before the seal");
        assert_eq!(device.queue_len(), 0, "sealed: everything was sent");
        tokio::time::sleep(Duration::from_millis(600)).await;
        assert_eq!(device.records_made(), made, "a paused device makes nothing");
        device.resume();
        tokio::time::sleep(Duration::from_millis(800)).await;
        assert!(device.records_made() > made, "a resumed device scans again");
        shared.stop.store(true, Ordering::SeqCst);
        scanner.await.unwrap();
        device.quiesce();
        syncer.await.unwrap().unwrap();
        assert_eq!(
            shared.ledger.lock().unwrap().expected().records,
            device.records_made()
        );
        host.stop().await.unwrap();
    }

    #[tokio::test]
    async fn a_ledgered_close_counts_its_receipt_once() {
        let profile = quiet(Profile::preset("tiny").unwrap());
        let (dir, mut host, device, shared) = one_device_site(&profile).await;
        device.topup(0).await;
        device.topup(1).await;
        {
            let mut engine = device.engine.lock().unwrap();
            for _ in 0..3 {
                let code = engine.next_code();
                engine.scan_ok(&code, None);
            }
            assert!(engine.close_open());
        }
        assert!(matches!(device.flush_once().await, Flush::Sent));
        let made = device.records_made();
        let at = crate::gen::text_of(crate::gen::now_ms() + 5_000);
        let receipt = device
            .close_part_ledgered(None, None, Some(at))
            .await
            .unwrap();
        assert_eq!(receipt["outcome"], "accepted", "{receipt}");
        assert_eq!(shared.ledger.lock().unwrap().expected().records, made + 1);
        assert_eq!(host_counts(dir.path()).await.receipts as u64, made + 1);
        host.stop().await.unwrap();
    }
```

Append to the `tests` module of `src/dbcheck.rs`:

```rust
    /// The participant invariants of the seeded shift, judged after `sql`.
    async fn invariants_after(sql: &str) -> BTreeSet<String> {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("copy.db");
        markiro_host::db::open(&path).await.unwrap().close().await;
        seed(&path).await;
        let mut db = SqliteConnection::connect(&format!("sqlite://{}", path.display()))
            .await
            .unwrap();
        sqlx::raw_sql(sql).execute(&mut db).await.unwrap();
        db.close().await.unwrap();
        let pool = open_read_only(&path, true).await.unwrap();
        let checks = participant_invariants(&pool, "s1").await.unwrap();
        pool.close().await;
        assert_eq!(checks.len(), 5);
        checks
            .into_iter()
            .filter(|check| !check.ok)
            .map(|check| check.name)
            .collect()
    }

    /// Both parts closed by their devices (d1 the later), with their close events.
    const PARTS_CLOSED_BY_DEVICES: &str = "UPDATE shift_participants SET state = 'closed', \
         closed_by_kind = 'device', closed_at = CASE device_id WHEN 'd0' \
         THEN '2026-10-22T10:00:00Z' ELSE '2026-10-22T10:00:05Z' END;
         INSERT INTO shift_close_events (id, record_id, shift_id, device_id, actual_qty, \
         closed_box_count, closed_at, outcome, received_at) VALUES \
         ('e0', 'r-e0', 's1', 'd0', 3, 1, 't', 'accepted', 't'), \
         ('e1', 'r-e1', 's1', 'd1', 3, 1, 't', 'accepted', 't');";

    /// The shift closed by its last device at `at`, audited once.
    fn shift_closed_by_d1(at: &str) -> String {
        format!(
            "UPDATE shifts SET status = 'closed', closed_at = '{at}', closed_by_kind = 'device', \
             closed_by = 'd1' WHERE id = 's1';
             INSERT INTO audit_log (at, actor_kind, actor_id, action, target_type, target_id, \
             result, details) VALUES ('t', 'device', 'd1', 'shift.close', 'shift', 's1', 'ok', '{{}}');"
        )
    }

    #[tokio::test]
    async fn the_participant_invariants_hold_for_an_open_and_a_cleanly_closed_shift() {
        assert_eq!(invariants_after("SELECT 1").await, names(&[]));
        let closed = format!(
            "{PARTS_CLOSED_BY_DEVICES}{}",
            shift_closed_by_d1("2026-10-22T10:00:05Z")
        );
        assert_eq!(invariants_after(&closed).await, names(&[]));
    }

    #[tokio::test]
    async fn each_broken_participant_invariant_is_named() {
        // The shift closed while its parts are open, and its close was never audited.
        let open_parts = "UPDATE shifts SET status = 'closed', closed_at = '2026-10-22T10:00:00Z', \
             closed_by_kind = 'office_user', closed_by = 'u' WHERE id = 's1';";
        assert_eq!(
            invariants_after(open_parts).await,
            names(&["closed_shift_has_no_open_part", "shift_closed_once"])
        );
        // Every part closed, the shift still active, and no close event behind the parts.
        let no_close = "UPDATE shift_participants SET state = 'closed', \
             closed_by_kind = 'device', closed_at = '2026-10-22T10:00:00Z';";
        assert_eq!(
            invariants_after(no_close).await,
            names(&[
                "active_shift_has_an_open_part",
                "close_events_match_device_closed_parts"
            ])
        );
        // Closed at the earlier part's moment, not the later one.
        let early = format!(
            "{PARTS_CLOSED_BY_DEVICES}{}",
            shift_closed_by_d1("2026-10-22T10:00:00Z")
        );
        assert_eq!(
            invariants_after(&early).await,
            names(&["device_closed_shift_closes_at_its_latest_part"])
        );
        // The close audited twice.
        let twice = format!(
            "{PARTS_CLOSED_BY_DEVICES}{}INSERT INTO audit_log (at, actor_kind, actor_id, action, \
             target_type, target_id, result, details) VALUES ('t', 'device', 'd1', 'shift.close', \
             'shift', 's1', 'ok', '{{}}');",
            shift_closed_by_d1("2026-10-22T10:00:05Z")
        );
        assert_eq!(invariants_after(&twice).await, names(&["shift_closed_once"]));
    }

    #[tokio::test]
    async fn participants_in_names_each_device_its_own_state() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("copy.db");
        markiro_host::db::open(&path).await.unwrap().close().await;
        seed(&path).await;
        let mut db = SqliteConnection::connect(&format!("sqlite://{}", path.display()))
            .await
            .unwrap();
        sqlx::raw_sql(
            "UPDATE shift_participants SET state = 'left', left_at = 't' WHERE device_id = 'd1'",
        )
        .execute(&mut db)
        .await
        .unwrap();
        db.close().await.unwrap();
        let pool = open_read_only(&path, true).await.unwrap();
        let states = participant_states(&pool, "s1").await.unwrap();
        assert_eq!(states.get("d1").map(String::as_str), Some("left"));
        let good = participants_in(
            &pool,
            "s1",
            &[(0, "d0".to_owned(), "active"), (1, "d1".to_owned(), "left")],
        )
        .await
        .unwrap();
        assert!(good.iter().all(|check| check.ok), "{good:?}");
        let bad = participants_in(&pool, "s1", &[(0, "d0".to_owned(), "left")])
            .await
            .unwrap();
        let failed: BTreeSet<String> = bad
            .into_iter()
            .filter(|check| !check.ok)
            .map(|check| check.name)
            .collect();
        assert_eq!(
            failed,
            names(&["participant_state_device_0", "participants_only_the_devices"])
        );
        pool.close().await;
    }
```

- [ ] **Step 2: Run them to verify they fail.**

Run (sandbox off: the site and device tests start a host): `cargo --offline --locked test --manifest-path "$WT/apps/standalone/Cargo.toml" -p markiro-loadtest --lib --no-run`
Expected: FAIL to compile: `no field line_ids on type Site`, `cannot find function provision_site`, `cannot find function plan_shift`, `no method named seal / resume / queue_len / close_part_ledgered`, `cannot find function participant_invariants / participants_in / participant_states`.

- [ ] **Step 3: The site.** In `src/site.rs`:

Add below `const CLAIMS_PER_MINUTE: u32 = 9;`:

```rust
/// The lines the wizard makes, in the order `Site.line_ids` keeps them.
const LINE_NAMES: [&str; 3] = ["Линия 1", "Линия 2", "Линия 3"];
```

In `pub struct Site`, after `pub line_id: String,` add:

```rust
    /// Every line of `LINE_NAMES` the host has, in that order; `line_ids[0] == line_id`. A fresh
    /// site has all three (an attached host may have only the first).
    pub line_ids: Vec<String>,
```

In the wizard body of `provision`, replace `"lines": ["Линия 1", "Линия 2"]` with `"lines": LINE_NAMES`.

Rename `pub async fn provision(` to `pub async fn provision_site(`, change its return type from `Res<(Site, ShiftInfo)>` to `Res<Site>`, and replace its end

```rust
    let site = Site {
        office,
        devices,
        line_id,
        product_id: str_of(&product, "/id")?.to_owned(),
        box_template_id: str_of(&box_template, "/id")?.to_owned(),
        pallet_template_id,
        secrets,
    };
    let shift = plan_and_enter(&site, profile, None).await?;
    Ok((site, shift))
}
```

with

```rust
    let line_ids: Vec<String> = LINE_NAMES
        .iter()
        .filter_map(|name| {
            lines.as_array().and_then(|all| {
                all.iter()
                    .find(|line| line["name"] == *name)
                    .and_then(|line| line["id"].as_str())
                    .map(str::to_owned)
            })
        })
        .collect();
    Ok(Site {
        office,
        devices,
        line_id,
        line_ids,
        product_id: str_of(&product, "/id")?.to_owned(),
        box_template_id: str_of(&box_template, "/id")?.to_owned(),
        pallet_template_id,
        secrets,
    })
}

/// A site ready for `profile` and a shift every device entered: see the module's text.
pub async fn provision(
    host: &Host,
    metrics: Arc<Metrics>,
    profile: &Profile,
    attach: Option<AttachCredentials>,
) -> Res<(Site, ShiftInfo)> {
    let site = provision_site(host, metrics, profile, attach).await?;
    let shift = plan_and_enter(&site, profile, None).await?;
    Ok((site, shift))
}
```

(The variable `lines` is the `GET /v1/office/lines` answer the function already reads to find «Линия 1»; `line_ids` is computed after the line limit is set, so it is still in scope.) Replace the head of `plan_and_enter`, from `let mut body = json!({` down to and including `let number = str_of(&shift, "/number")?.to_owned();`, with:

```rust
    let (id, number) = plan_shift(site, profile, &site.line_id, planned_qty).await?;
```

and add above `plan_and_enter`:

```rust
/// A planned shift on `line_id` of the site's product and templates, pallets when the site has a
/// pallet template, and a plan when `planned_qty` is given: its id and number. Nobody enters it.
pub async fn plan_shift(
    site: &Site,
    profile: &Profile,
    line_id: &str,
    planned_qty: Option<u32>,
) -> Res<(String, String)> {
    let mut body = json!({
        "productId": site.product_id, "lineId": line_id,
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
    Ok((
        str_of(&shift, "/id")?.to_owned(),
        str_of(&shift, "/number")?.to_owned(),
    ))
}
```

- [ ] **Step 4: The device controls.** In `src/device.rs`:

Change `use crate::ledger::Ledger;` to `use crate::ledger::{FactMeta, Ledger};`. In `pub struct SimDevice`, after `quiesce: AtomicBool,` add:

```rust
    /// Set by `pause`: the scanner makes nothing until `resume`.
    paused: AtomicBool,
    /// Set while the scanner is inside one scan, so `pause` can wait for it.
    scanning: AtomicBool,
```

and in `SimDevice::new`, after `quiesce: AtomicBool::new(false),` add `paused: AtomicBool::new(false), scanning: AtomicBool::new(false),`.

In `scanner`, replace

```rust
        while !self.stopped() {
            let now = Instant::now();
```

with

```rust
        while !self.stopped() {
            if self.paused.load(Ordering::SeqCst) {
                tokio::time::sleep(Duration::from_millis(20)).await;
                next = Instant::now();
                continue;
            }
            let now = Instant::now();
```

and replace

```rust
            self.scan_once(&mut rng).await;
        }
    }
```

with

```rust
            // A pause that came after the check above waits for this scan, or stops it here.
            self.scanning.store(true, Ordering::SeqCst);
            if self.paused.load(Ordering::SeqCst) {
                self.scanning.store(false, Ordering::SeqCst);
                continue;
            }
            self.scan_once(&mut rng).await;
            self.scanning.store(false, Ordering::SeqCst);
        }
    }
```

Add these methods to `impl SimDevice` after `pub fn is_online`:

```rust
    /// Stop scanning, and wait until a scan in progress is queued. The syncer goes on.
    pub async fn pause(&self) {
        self.paused.store(true, Ordering::SeqCst);
        while self.scanning.load(Ordering::SeqCst) {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }

    pub fn resume(&self) {
        self.paused.store(false, Ordering::SeqCst);
    }

    /// The link, set by a scenario (a profile that never drops leaves it to the scenario):
    /// offline, the scanner goes on and the syncer sends nothing.
    pub fn set_online(&self, online: bool) {
        self.online.store(online, Ordering::SeqCst);
    }

    pub fn queue_len(&self) -> usize {
        self.engine.lock().expect("engine").queue_len()
    }

    /// Wait until the syncer has every queued record acknowledged.
    pub async fn wait_drained(&self, limit: Duration) -> Result<(), String> {
        let deadline = Instant::now() + limit;
        while self.queue_len() > 0 {
            if Instant::now() > deadline {
                return Err(format!(
                    "device {}: {} records still queued after {} s",
                    self.spec.index,
                    self.queue_len(),
                    limit.as_secs()
                ));
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        Ok(())
    }

    /// What a station does before it closes its part: pause, close the open box and pallet, and
    /// wait until the syncer has sent everything. The device must be online.
    pub async fn seal(&self, limit: Duration) -> Result<(), String> {
        self.pause().await;
        let deadline = Instant::now() + limit;
        loop {
            let sealed = self.engine.lock().expect("engine").close_open();
            if sealed {
                break;
            }
            if Instant::now() > deadline {
                return Err(format!(
                    "device {}: no SSCC serial to close the open box or pallet",
                    self.spec.index
                ));
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        self.wait_drained(deadline.saturating_duration_since(Instant::now()))
            .await
    }

    /// A receipt of a record this device sent outside its outbox, applied once to the ledger.
    pub fn apply_receipt(&self, kind: markiro_proto::FactKind, receipt: &Value) {
        self.shared.ledger.lock().expect("ledger").apply(
            self.spec.index,
            &FactMeta { kind, claims: None },
            receipt,
        );
    }

    /// `close_part`, with the moment given (else the device's clock), and its receipt applied
    /// to the ledger, so the per-device receipt counts stay exact. Call it after `seal`, never
    /// while a flush of this device may run (the syncer only flushes a non-empty outbox).
    pub async fn close_part_ledgered(
        &self,
        planned: Option<u32>,
        reason: Option<&str>,
        closed_at: Option<String>,
    ) -> Result<Value, String> {
        let actual = {
            let ledger = self.shared.ledger.lock().expect("ledger");
            ledger
                .accepted_scans
                .get(&self.spec.index)
                .copied()
                .unwrap_or(0)
        };
        let (id, tick, boxes) = {
            let mut engine = self.engine.lock().expect("engine");
            (engine.fresh_id(), engine.tick(), engine.boxes_closed)
        };
        let at = closed_at.unwrap_or(tick);
        let data = crate::gen::shift_closed(planned, actual as u32, boxes as u32, reason, &at);
        let record = crate::gen::record(
            &id,
            markiro_proto::FactKind::ShiftClosed,
            &self.shared.shift_id,
            data,
        );
        let mut receipts = self.api.facts(&self.spec.key, &[record]).await?;
        let receipt = receipts.remove(0);
        self.apply_receipt(markiro_proto::FactKind::ShiftClosed, &receipt);
        Ok(receipt)
    }
```

- [ ] **Step 5: The participant checks.** In `src/dbcheck.rs`, after `pub async fn participants(…) { … }` add:

```rust
/// The state of every participant of `shift`, by the host's device id.
pub async fn participant_states(pool: &SqlitePool, shift: &str) -> Res<BTreeMap<String, String>> {
    let rows: Vec<(String, String)> =
        sqlx::query_as("SELECT device_id, state FROM shift_participants WHERE shift_id = ?")
            .bind(shift)
            .fetch_all(pool)
            .await
            .map_err(|error| format!("shift_participants: {error}"))?;
    Ok(rows.into_iter().collect())
}

/// Each named device (`(index, host id, state)`) is in the state given, and no other device took
/// part in the shift.
pub async fn participants_in(
    pool: &SqlitePool,
    shift: &str,
    expected: &[(u32, String, &str)],
) -> Res<Vec<Check>> {
    let states = participant_states(pool, shift).await?;
    let mut checks: Vec<Check> = expected
        .iter()
        .map(|(index, id, state)| {
            Check::same(
                &format!("participant_state_device_{index}"),
                Some((*state).to_owned()),
                states.get(id).cloned(),
            )
        })
        .collect();
    let foreign = states
        .keys()
        .filter(|id| !expected.iter().any(|(_, mine, _)| mine == *id))
        .count();
    checks.push(Check::same("participants_only_the_devices", 0, foreign));
    Ok(checks)
}

/// What holds for a shift in any copy of the database, in the middle of its closes too, beyond
/// the CHECKs of migration `0052`: a closed shift has no open part and an active one has one; a
/// shift its devices closed closes at the latest of their parts' moments (`facts::close_part`);
/// its close is audited once (`shift.close` or `shift.force_closed`); every accepted close event
/// is a part its device closed.
pub async fn participant_invariants(pool: &SqlitePool, shift: &str) -> Res<Vec<Check>> {
    let zero = |name: &str, found: i64| {
        Check::new(name, found == 0, format!("{found} found, none allowed"))
    };
    let closed_with_open_parts = count_bind(
        pool,
        "SELECT COUNT(*) FROM shifts s JOIN shift_participants p ON p.shift_id = s.id \
         WHERE s.id = ? AND s.status = 'closed' AND p.state IN ('active', 'left')",
        shift,
    )
    .await?;
    let active_without_open_part = count_bind(
        pool,
        "SELECT COUNT(*) FROM shifts s WHERE s.id = ? AND s.status = 'active' \
         AND NOT EXISTS (SELECT 1 FROM shift_participants p \
                         WHERE p.shift_id = s.id AND p.state IN ('active', 'left'))",
        shift,
    )
    .await?;
    let wrong_moment = count_bind(
        pool,
        "SELECT COUNT(*) FROM shifts s WHERE s.id = ? AND s.status = 'closed' \
         AND s.closed_by_kind = 'device' AND s.closed_at IS NOT \
         (SELECT MAX(p.closed_at) FROM shift_participants p \
          WHERE p.shift_id = s.id AND p.closed_by_kind = 'device')",
        shift,
    )
    .await?;
    let status: Option<String> = sqlx::query_scalar("SELECT status FROM shifts WHERE id = ?")
        .bind(shift)
        .fetch_optional(pool)
        .await
        .map_err(|error| format!("shifts: {error}"))?;
    let closes = count_bind(
        pool,
        "SELECT COUNT(*) FROM audit_log WHERE target_type = 'shift' AND target_id = ? \
         AND action IN ('shift.close', 'shift.force_closed')",
        shift,
    )
    .await?;
    let accepted_events = count_bind(
        pool,
        "SELECT COUNT(*) FROM shift_close_events WHERE shift_id = ? AND outcome = 'accepted'",
        shift,
    )
    .await?;
    let device_closed_parts = count_bind(
        pool,
        "SELECT COUNT(*) FROM shift_participants WHERE shift_id = ? AND closed_by_kind = 'device'",
        shift,
    )
    .await?;
    Ok(vec![
        zero("closed_shift_has_no_open_part", closed_with_open_parts),
        zero("active_shift_has_an_open_part", active_without_open_part),
        zero("device_closed_shift_closes_at_its_latest_part", wrong_moment),
        Check::same(
            "shift_closed_once",
            i64::from(status.as_deref() == Some("closed")),
            closes,
        ),
        Check::same(
            "close_events_match_device_closed_parts",
            device_closed_parts,
            accepted_events,
        ),
    ])
}
```

- [ ] **Step 6: Run the tests to verify they pass.**

Run (pure): `cargo --offline --locked test --manifest-path "$WT/apps/standalone/Cargo.toml" -p markiro-loadtest --lib dbcheck::tests`
Expected: `test result: ok.`, including `the_participant_invariants_hold_for_an_open_and_a_cleanly_closed_shift`, `each_broken_participant_invariant_is_named`, `participants_in_names_each_device_its_own_state` and every older `dbcheck` test.

Run (sandbox off): `cargo --offline --locked test --manifest-path "$WT/apps/standalone/Cargo.toml" -p markiro-loadtest --lib site::tests`
Expected: `test result: ok. 3 passed`.

Run (sandbox off): `cargo --offline --locked test --manifest-path "$WT/apps/standalone/Cargo.toml" -p markiro-loadtest --lib device::tests`
Expected: `test result: ok.`, including `a_paused_device_scans_nothing_and_a_sealed_one_has_sent_everything` and `a_ledgered_close_counts_its_receipt_once`, and the older end-to-end tests (`two_stations_and_a_handheld_reconcile_with_the_host_over_the_network` still passes: `provision` keeps its old behaviour).

If an invariant check fails on the clean fixture, read the SQL against migration `0052` (column names) before touching the test: the fixture is the reference.

- [ ] **Step 7: Mutation checks.** (a) In `participant_invariants`, change `AND p.state IN ('active', 'left')",` of the first query to `AND p.state IN ('left')",`; `each_broken_participant_invariant_is_named` must FAIL (the closed-shift case loses `closed_shift_has_no_open_part`). Restore. (b) In `scanner`, delete the `if self.paused.load(Ordering::SeqCst) { … continue; }` block at the loop's top; `a_paused_device_scans_nothing_and_a_sealed_one_has_sent_everything` must FAIL (`a paused device makes nothing`). Restore and rerun both: ok.

- [ ] **Step 8: Commit.**

```bash
git -C "$WT" add apps/standalone/loadtest/src/site.rs apps/standalone/loadtest/src/device.rs apps/standalone/loadtest/src/dbcheck.rs
git -C "$WT" commit -m "feat(loadtest): a site without a shift, device pause and seal, participant invariants

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The scenario context, the quiet load and the run's wiring

**Files:**

- Create: `apps/standalone/loadtest/src/scenarios/mod.rs`
- Modify: `apps/standalone/loadtest/src/lib.rs`, `apps/standalone/loadtest/src/host.rs`, `apps/standalone/loadtest/src/run.rs`, `apps/standalone/loadtest/src/cli.rs`, `apps/standalone/loadtest/tests/self_run.rs`

**Interfaces:**

- Consumes: Task 1 (`ScenarioResult`, `Profile.scenarios`), Task 2 (`provision_site`, `plan_shift`, `Site.line_ids`, the device controls, the participant checks).
- Produces: `scenarios::{HostKind, Ctx, Load, run_all, SPAWN_ONLY, LOAD_S, quiet, not_judged, broken, send_raw, send_with_protocol, enter_all, scripted_work, scripted_scan, close_record, close_fact, audit_count, shift_row, ShiftRow, reconcile, prefixed}` and the answer readers `constraint`, `error_code`, `my_state`, `joined_rev`, `states`, `part`, `issuer_prefix`, `part_closed`, `already_closed`, `reason_missing`; `Report.scenarios` filled by `run::execute_raw` (with every scenario site's secrets joined to the run's); `Host::stop` never signals a child that already ended; `cli::run` deletes `scenarios/` of a passing run (unless `--keep-data`).

- [ ] **Step 1: Write the failing tests.** Create `src/scenarios/mod.rs` holding only its tests for now:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn tiny() -> Profile {
        Profile::preset("tiny").unwrap()
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_context_makes_a_site_of_three_lines_and_no_shift_and_finishes_clean() {
        let work = tempfile::tempdir().unwrap();
        let ctx = Ctx::new("probe", &HostKind::InProcess, work.path(), &tiny(), 2, 1)
            .await
            .unwrap();
        assert_eq!(ctx.site.line_ids.len(), 3);
        assert_eq!(ctx.site.devices.len(), 3);
        let shifts = ctx
            .site
            .office
            .ok("GET", "/v1/office/shifts", None)
            .await
            .unwrap();
        assert_eq!(shifts.as_array().map(Vec::len), Some(0));
        assert!(work.path().join("scenarios/probe/data/host.db").exists());
        let (result, secrets) = ctx.finish(Ok(())).await;
        assert!(result.judged);
        assert!(result.checks.iter().all(|check| check.ok), "{:?}", result.checks);
        assert!(result.checks.iter().any(|check| check.name == "no_5xx_answer"));
        assert!(
            secrets.iter().any(|secret| secret.starts_with("Load-")),
            "the scenario site's password is among its secrets"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_quiet_load_on_a_scenario_shift_reconciles_exactly() {
        let work = tempfile::tempdir().unwrap();
        let mut ctx = Ctx::new("load", &HostKind::InProcess, work.path(), &tiny(), 2, 1)
            .await
            .unwrap();
        let line = ctx.site.line_ids[0].clone();
        let shift = ctx.plan(&line, None).await.unwrap();
        let prefix = enter_all(&ctx, &shift, &[0, 1, 2]).await.unwrap();
        let load = ctx.load(1, &shift, &prefix, &[0, 1, 2]);
        tokio::time::sleep(Duration::from_secs(3)).await;
        let (shared, devices, drained) = load.stop("").await;
        assert!(drained.iter().all(|check| check.ok), "{drained:?}");
        let expected = shared.ledger.lock().unwrap().expected();
        assert!(expected.distinct_accepted_codes > 20, "{expected:?}");
        let found = reconcile(&ctx, "", &shift, &shared, &devices).await;
        assert!(found.iter().all(|check| check.ok), "{found:?}");
        for name in ["db_code_owners", "db_integrity", "shift_closed_once"] {
            assert!(found.iter().any(|check| check.name == name), "{name}");
        }
        ctx.check(Check::new("probe", true, ""));
        let (result, _) = ctx.finish(Ok(())).await;
        assert!(result.checks.iter().all(|check| check.ok), "{:?}", result.checks);
        assert!(result.latency.contains_key("facts"));
    }

    #[tokio::test]
    async fn an_attached_host_judges_no_scenario_and_an_unknown_name_fails() {
        let work = tempfile::tempdir().unwrap();
        let mut profile = tiny();
        profile.scenarios = vec!["anything".to_owned()];
        let (results, secrets) = run_all(&HostKind::Attach, work.path(), &profile).await;
        assert_eq!(results.len(), 1);
        assert!(!results[0].judged && results[0].note.contains("attach"));
        assert!(secrets.is_empty());
        let (results, _) = run_all(&HostKind::InProcess, work.path(), &profile).await;
        assert!(results[0].judged);
        assert!(results[0]
            .checks
            .iter()
            .any(|check| !check.ok && check.detail.contains("anything")));
    }

    #[test]
    fn the_answer_readers_find_what_the_host_names() {
        let full = Reply {
            status: 409,
            body: json!({ "error": { "code": "conflict", "message": "",
                "details": { "constraint": "shift_line_full", "maxStations": 3, "active": 3 } } }),
            micros: 0,
        };
        assert_eq!(constraint(&full), Some("shift_line_full"));
        assert_eq!(error_code(&full), Some("conflict"));
        let shift = json!({
            "myState": "active",
            "snapshot": { "issuerPrefix": "460068200" },
            "participants": [
                { "deviceId": "a", "state": "active", "joinedRev": 7 },
                { "deviceId": "b", "state": "left" }
            ]
        });
        assert_eq!(my_state(&shift), "active");
        assert_eq!(joined_rev(&shift, "a"), Some(7));
        assert_eq!(joined_rev(&shift, "b"), None);
        assert_eq!(issuer_prefix(&shift).as_deref(), Some("460068200"));
        assert_eq!(states(&shift).get("b").map(String::as_str), Some("left"));
        assert!(part(&shift, "c").is_none());
        assert!(part_closed(&json!({ "outcome": "accepted", "details": { "partClosed": true } })));
        assert!(!part_closed(&json!({ "outcome": "accepted" })));
        assert!(already_closed(&json!({ "details": { "alreadyClosed": true } })));
        assert!(reason_missing(&json!({ "details": { "reasonMissing": true } })));
        let renamed = prefixed("race_0_", vec![Check::new("x", true, "")]);
        assert_eq!(renamed[0].name, "race_0_x");
    }
}
```

In `src/lib.rs` add `pub mod scenarios;` after `pub mod sampler;`.

Append to the `tests` module of `src/host.rs`:

```rust
    #[tokio::test]
    async fn a_stopped_spawned_host_is_not_signalled_again() {
        let dir = tempfile::tempdir().unwrap();
        let log = dir.path().join("host.log");
        let mut host = Host::spawned(&host_binary(), &dir.path().join("data"), &log)
            .await
            .unwrap();
        let first = host.stop().await.unwrap();
        assert_eq!(first, cfg!(unix));
        // The child ended: a second stop asks nothing of a pid that may be another process's now.
        let started = Instant::now();
        assert!(!host.stop().await.unwrap());
        assert!(started.elapsed() < Duration::from_secs(1));
    }
```

- [ ] **Step 2: Run them to verify they fail.**

Run: `cargo --offline --locked test --manifest-path "$WT/apps/standalone/Cargo.toml" -p markiro-loadtest --lib --no-run`
Expected: FAIL to compile: `cannot find type Ctx`, `cannot find function run_all`, … in `scenarios::tests`.

- [ ] **Step 3: The host's stop guard.** In `src/host.rs`, in `stop`, replace

```rust
            Process::Spawned { mut child, log } => {
                let asked = ask_to_stop(&child);
```

with

```rust
            Process::Spawned { mut child, log } => {
                if child.try_wait()?.is_some() {
                    // Ended already (stopped before, or killed): nothing to ask, and its pid may
                    // belong to another process by now.
                    self.process = Process::Spawned { child, log };
                    return Ok(false);
                }
                let asked = ask_to_stop(&child);
```

- [ ] **Step 4: Write the module.** Put this above the tests module of `src/scenarios/mod.rs`:

```rust
//! The multi-station scenarios (plan `2026-10-22-multi-station-load-test-scenarios.md`): what
//! the main run does not exercise, each on a fresh host and a fresh site of its own, after the
//! main run, with metrics of its own. A scenario's checks are correctness checks (a failure is a
//! defect to report); its latencies and its deliberate refusals are recorded, never judged by
//! the profile's thresholds. A scenario that needs what the run's host mode lacks says so
//! (`judged: false`) instead of passing.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, Instant};

use markiro_proto::FactKind;
use serde_json::{json, Value};
use sqlx::SqlitePool;
use tokio::task::JoinHandle;

use crate::api::{pinned_client, Api, Auth, Reply, REQUEST_TIMEOUT};
use crate::checks::Check;
use crate::dbcheck;
use crate::device::{Shared, SimDevice};
use crate::engine::{Block, Engine, EngineCfg};
use crate::gen;
use crate::host::Host;
use crate::metrics::{Metrics, Route};
use crate::profile::Profile;
use crate::report::ScenarioResult;
use crate::rng::Rng;
use crate::site::{provision_site, DeviceSpec, Site};

pub type Res<T> = Result<T, String>;

/// The scenarios that need a host this harness spawned (a kill, a stop and a restart on the
/// same port and data folder); with another host they are not judged.
pub const SPAWN_ONLY: &[&str] = &["kill-restart", "outage"];

/// How long a scenario's devices scan between its steps, in seconds.
pub const LOAD_S: u64 = 3;

/// The host mode the run uses, and so every scenario's.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HostKind {
    InProcess,
    Spawn { bin: PathBuf },
    Attach,
}

/// A scenario's load: no link drops, no injected duplicates and no races, so its ledger
/// reconciles exactly; resends are kept.
pub fn quiet(base: &Profile) -> Profile {
    let mut profile = base.clone();
    profile.mean_offline_s = 0.0;
    profile.late_dup_rate = 0.0;
    profile.checked_dup_rate = 0.0;
    profile.race_rate = 0.0;
    profile.backup_at = Vec::new();
    profile.scenarios = Vec::new();
    profile
}

fn result(name: &str, judged: bool, note: &str, checks: Vec<Check>) -> ScenarioResult {
    ScenarioResult {
        name: name.to_owned(),
        judged,
        note: note.to_owned(),
        duration_ms: 0,
        checks,
        observed: BTreeMap::new(),
        latency: BTreeMap::new(),
        errors: BTreeMap::new(),
    }
}

/// A scenario this run cannot judge, and why.
pub fn not_judged(name: &str, note: &str) -> ScenarioResult {
    result(name, false, note, Vec::new())
}

/// A scenario that could not even start: one failed check naming why.
pub fn broken(name: &str, error: String) -> ScenarioResult {
    result(name, true, "", vec![Check::new("scenario_ran", false, error)])
}

/// One scenario's host, site and findings.
pub struct Ctx {
    pub name: String,
    pub host: Host,
    pub metrics: Arc<Metrics>,
    pub site: Site,
    /// The scenario's (quiet) profile; its devices are the scenario's.
    pub profile: Profile,
    /// `<work>/scenarios/<name>`: the host's data, its log, copies and restores.
    pub dir: PathBuf,
    pub kind: HostKind,
    /// A scenario that injects faults: requests without an answer and ERROR lines of the host's
    /// log are expected, and recorded instead of checked.
    pub faults: bool,
    /// Paths a judged run did not exercise this time, said in the report.
    pub note: String,
    checks: Vec<Check>,
    observed: BTreeMap<String, Value>,
}

impl Ctx {
    /// A fresh host in `kind`'s mode on `<work_dir>/scenarios/<name>/data` and a site of
    /// `stations` stations and `handhelds` handhelds, all on the first line, no shift.
    pub async fn new(
        name: &str,
        kind: &HostKind,
        work_dir: &Path,
        base: &Profile,
        stations: u32,
        handhelds: u32,
    ) -> Res<Ctx> {
        let dir = work_dir.join("scenarios").join(name);
        std::fs::create_dir_all(&dir).map_err(|error| format!("{}: {error}", dir.display()))?;
        let data = dir.join("data");
        let host = match kind {
            HostKind::InProcess => Host::in_process(&data).await,
            HostKind::Spawn { bin } => {
                Host::spawned(bin, &data, &dir.join("host-stdout.log")).await
            }
            HostKind::Attach => return Err("attach: no fresh host for a scenario".to_owned()),
        }
        .map_err(|error| error.to_string())?;
        let mut profile = quiet(base);
        profile.stations = stations;
        profile.handhelds = handhelds;
        let metrics = Arc::new(Metrics::new());
        let site = match provision_site(&host, metrics.clone(), &profile, None).await {
            Ok(site) => site,
            Err(error) => {
                let mut host = host;
                host.stop().await.ok();
                return Err(error);
            }
        };
        Ok(Ctx {
            name: name.to_owned(),
            host,
            metrics,
            site,
            profile,
            dir,
            kind: kind.clone(),
            faults: false,
            note: String::new(),
            checks: Vec::new(),
            observed: BTreeMap::new(),
        })
    }

    pub fn check(&mut self, check: Check) {
        self.checks.push(check);
    }

    pub fn checks(&mut self, checks: impl IntoIterator<Item = Check>) {
        self.checks.extend(checks);
    }

    pub fn same<T: PartialEq + std::fmt::Debug>(&mut self, name: &str, expected: T, actual: T) {
        self.checks.push(Check::same(name, expected, actual));
    }

    pub fn observe(&mut self, key: &str, value: Value) {
        self.observed.insert(key.to_owned(), value);
    }

    pub fn device(&self, index: usize) -> DeviceSpec {
        self.site.devices[index].clone()
    }

    /// One request of `device`, answered whatever its status.
    pub async fn send(
        &self,
        device: &DeviceSpec,
        route: Route,
        method: &str,
        path: &str,
        body: Option<Value>,
    ) -> Res<Reply> {
        send_raw(&self.site.office.api, &device.key, route, method, path, body).await
    }

    /// `POST …/enter` naming `supports` (`None`: no body, as a protocol 3 station sends).
    pub async fn enter(
        &self,
        device: &DeviceSpec,
        shift: &str,
        supports: Option<Vec<&'static str>>,
    ) -> Res<Reply> {
        let body = supports.map(|names| json!({ "supports": names }));
        let path = format!("/v1/device/shifts/{shift}/enter");
        self.send(device, Route::Enter, "POST", &path, body).await
    }

    /// `POST …/leave` with `{ joinedRev }` when a token is given, with no body otherwise.
    pub async fn leave(
        &self,
        device: &DeviceSpec,
        shift: &str,
        joined_rev: Option<u64>,
    ) -> Res<Reply> {
        let body = joined_rev.map(|rev| json!({ "joinedRev": rev }));
        let path = format!("/v1/device/shifts/{shift}/leave");
        self.send(device, Route::Other, "POST", &path, body).await
    }

    pub async fn office_shift(&self, shift: &str) -> Res<Value> {
        self.site
            .office
            .ok("GET", &format!("/v1/office/shifts/{shift}"), None)
            .await
    }

    /// The office's close of the whole shift over the revision it reads first.
    pub async fn office_close(&self, shift: &str, reason: &str) -> Res<Reply> {
        let view = self.office_shift(shift).await?;
        self.site
            .office
            .call(
                "POST",
                &format!("/v1/office/shifts/{shift}/close"),
                Some(json!({ "reason": reason, "expectedRev": view["rev"] })),
            )
            .await
    }

    /// A planned shift on `line_id`; nobody entered it.
    pub async fn plan(&self, line_id: &str, planned: Option<u32>) -> Res<String> {
        crate::site::plan_shift(&self.site, &self.profile, line_id, planned)
            .await
            .map(|(id, _)| id)
    }

    /// `PUT /v1/office/lines/{id}` with the limit, over the line's current revision.
    pub async fn set_max_stations(&self, line_id: &str, max: u32) -> Res<Reply> {
        let lines = self.site.office.ok("GET", "/v1/office/lines", None).await?;
        let rev = lines
            .as_array()
            .and_then(|lines| lines.iter().find(|line| line["id"] == json!(line_id)))
            .and_then(|line| line["rev"].as_i64())
            .ok_or_else(|| format!("no line {line_id}"))?;
        self.site
            .office
            .call(
                "PUT",
                &format!("/v1/office/lines/{line_id}"),
                Some(json!({ "maxStations": max, "expectedRev": rev })),
            )
            .await
    }

    /// Put a device on another line: a station chooses it, a handheld is assigned by the office.
    pub async fn move_to_line(&self, device: &DeviceSpec, line_id: &str) -> Res<()> {
        let reply = if device.is_handheld() {
            self.site
                .office
                .call(
                    "PUT",
                    &format!("/v1/office/devices/{}", device.id),
                    Some(json!({ "name": device.name, "lineId": line_id })),
                )
                .await?
        } else {
            let body = json!({ "lineId": line_id });
            self.send(device, Route::Other, "PUT", "/v1/device/line", Some(body))
                .await?
        };
        if reply.ok() {
            Ok(())
        } else {
            Err(format!(
                "device {} to line {line_id}: {} {}",
                device.index, reply.status, reply.body
            ))
        }
    }

    /// The live database, read-only.
    pub async fn db(&self) -> Res<SqlitePool> {
        let dir = self
            .host
            .data_dir
            .as_ref()
            .ok_or("the scenario host has no data folder")?;
        dbcheck::open_read_only(
            &markiro_host::config::HostPaths::new(dir).database_file(),
            false,
        )
        .await
    }

    /// Simulated devices `indices` scanning into `shift` (run number `run` keeps their codes and
    /// record ids apart from any other load of this host).
    pub fn load(&self, run: u32, shift: &str, issuer_prefix: &str, indices: &[usize]) -> Load {
        let mut profile = self.profile.clone();
        profile.seed ^= u64::from(run).wrapping_mul(0x1_0000_0001);
        let shared = Arc::new(Shared::new(
            profile,
            run,
            shift,
            issuer_prefix,
            self.metrics.clone(),
        ));
        let devices: Vec<Arc<SimDevice>> = indices
            .iter()
            .map(|at| {
                SimDevice::new(
                    self.site.devices[*at].clone(),
                    Api::new(&self.host.base, &self.host.fingerprint, self.metrics.clone()),
                    shared.clone(),
                )
            })
            .collect();
        let scanners = devices
            .iter()
            .map(|device| tokio::spawn(device.clone().scanner()))
            .collect();
        let syncers = devices
            .iter()
            .map(|device| tokio::spawn(device.clone().syncer()))
            .collect();
        Load {
            shared,
            devices,
            scanners,
            syncers,
        }
    }

    /// The scenario's result and its site's secrets: the host stops; its log (a spawned host)
    /// must name no busy database, nor an ERROR unless the scenario injects faults; the
    /// scenario's own requests must have had no 5xx, nor a request without an answer unless it
    /// injects faults.
    pub async fn finish(mut self, outcome: Res<()>) -> (ScenarioResult, Vec<String>) {
        if let Err(error) = outcome {
            self.checks.push(Check::new("scenario_ran", false, error));
        }
        if let Err(error) = self.host.stop().await {
            self.checks
                .push(Check::new("host_stop", false, error.to_string()));
        }
        let log = self.host.log_scan();
        if log.available {
            self.checks
                .push(Check::at_most("host_log_busy_lines", 0, log.busy_lines));
            if self.faults {
                self.observed
                    .insert("hostLogErrorLines".to_owned(), json!(log.error_lines));
            } else {
                self.checks
                    .push(Check::at_most("host_log_error_lines", 0, log.error_lines));
            }
            if !log.first_errors.is_empty() {
                self.observed
                    .insert("hostLogFirstErrors".to_owned(), json!(log.first_errors));
            }
        }
        let errors = self.metrics.errors();
        let count = |tail: &str| -> u64 {
            errors
                .iter()
                .filter(|(class, _)| class.contains(tail))
                .map(|(_, count)| *count)
                .sum()
        };
        self.checks
            .push(Check::at_most("no_5xx_answer", 0, count(":http_5xx")));
        if !self.faults {
            self.checks
                .push(Check::at_most("no_request_without_an_answer", 0, count(":net_")));
        }
        let latency = self
            .metrics
            .latency()
            .into_iter()
            .map(|(route, histogram)| (route.to_owned(), histogram.summary()))
            .collect();
        (
            ScenarioResult {
                name: self.name,
                judged: true,
                note: self.note.trim().to_owned(),
                duration_ms: 0,
                checks: self.checks,
                observed: self.observed,
                latency,
                errors,
            },
            self.site.secrets,
        )
    }
}

/// Simulated devices working one shift: the scanners and syncers of `SimDevice`.
pub struct Load {
    pub shared: Arc<Shared>,
    pub devices: Vec<Arc<SimDevice>>,
    scanners: Vec<JoinHandle<()>>,
    syncers: Vec<JoinHandle<Result<(), String>>>,
}

impl Load {
    /// The device of site index `index`.
    pub fn of(&self, index: usize) -> &Arc<SimDevice> {
        self.devices
            .iter()
            .find(|device| device.spec.index as usize == index)
            .expect("a device of this load")
    }

    /// Stop scanning, drain every outbox (each syncer closes its open box and pallet first), and
    /// say whether each device drained and answered its resends alike.
    pub async fn stop(self, prefix: &str) -> (Arc<Shared>, Vec<Arc<SimDevice>>, Vec<Check>) {
        self.shared.stop.store(true, Ordering::SeqCst);
        for task in self.scanners {
            let _ = task.await;
        }
        for device in &self.devices {
            device.quiesce();
        }
        let mut checks = Vec::new();
        for (device, task) in self.devices.iter().zip(self.syncers) {
            let index = device.spec.index;
            let outcome = task
                .await
                .map_err(|error| error.to_string())
                .and_then(|result| result);
            checks.push(Check::new(
                &format!("{prefix}device_{index}_drained"),
                outcome.is_ok(),
                format!("{outcome:?}"),
            ));
            checks.push(Check::same(
                &format!("{prefix}device_{index}_resends_answered_alike"),
                0,
                device.stats().resend_mismatches,
            ));
        }
        (self.shared, self.devices, checks)
    }
}

/// One request with a device key, answered whatever its status; no answer is an error.
pub async fn send_raw(
    api: &Api,
    key: &str,
    route: Route,
    method: &str,
    path: &str,
    body: Option<Value>,
) -> Res<Reply> {
    let auth = Auth {
        device_key: Some(key),
        session: None,
    };
    api.send(route, method, path, auth, body.as_ref())
        .await
        .map_err(|error| format!("{method} {path}: {error:?}"))
}

/// A request with a protocol version of the caller's choice (the harness's own client always
/// names the current one).
pub async fn send_with_protocol(
    ctx: &Ctx,
    device: &DeviceSpec,
    method: &str,
    path: &str,
    protocol: u32,
    body: Option<Value>,
) -> Res<Reply> {
    let client = pinned_client(&ctx.host.fingerprint, REQUEST_TIMEOUT);
    let verb = reqwest::Method::from_bytes(method.as_bytes()).map_err(|error| error.to_string())?;
    let mut request = client
        .request(verb, format!("{}{path}", ctx.host.base))
        .header(markiro_proto::PROTOCOL_HEADER, protocol.to_string())
        .header("authorization", format!("Bearer {}", device.key));
    if let Some(body) = &body {
        request = request.json(body);
    }
    let response = request
        .send()
        .await
        .map_err(|error| format!("{method} {path}: {}", error.without_url()))?;
    let status = response.status().as_u16();
    let bytes = response
        .bytes()
        .await
        .map_err(|error| error.without_url().to_string())?;
    let body = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap_or(Value::Null)
    };
    Ok(Reply {
        status,
        body,
        micros: 0,
    })
}

/// `details.constraint` of a refusal.
pub fn constraint(reply: &Reply) -> Option<&str> {
    reply
        .body
        .pointer("/error/details/constraint")
        .and_then(Value::as_str)
}

/// `error.code` of a refusal.
pub fn error_code(reply: &Reply) -> Option<&str> {
    reply.body.pointer("/error/code").and_then(Value::as_str)
}

/// The asking device's state in a shift answer (`""` when absent).
pub fn my_state(shift: &Value) -> &str {
    shift["myState"].as_str().unwrap_or("")
}

/// A participant of a shift answer.
pub fn part<'a>(shift: &'a Value, device_id: &str) -> Option<&'a Value> {
    shift
        .get("participants")
        .and_then(Value::as_array)?
        .iter()
        .find(|part| part["deviceId"] == json!(device_id))
}

/// A participant's leave token in a shift answer.
pub fn joined_rev(shift: &Value, device_id: &str) -> Option<u64> {
    part(shift, device_id)?.get("joinedRev").and_then(Value::as_u64)
}

/// Every participant's state in a shift answer, by device id.
pub fn states(shift: &Value) -> BTreeMap<String, String> {
    shift
        .get("participants")
        .and_then(Value::as_array)
        .map(|parts| {
            parts
                .iter()
                .filter_map(|part| {
                    Some((
                        part["deviceId"].as_str()?.to_owned(),
                        part["state"].as_str()?.to_owned(),
                    ))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// The issuer prefix an entry's snapshot froze.
pub fn issuer_prefix(entered: &Value) -> Option<String> {
    entered
        .pointer("/snapshot/issuerPrefix")
        .and_then(Value::as_str)
        .map(str::to_owned)
}

pub fn part_closed(receipt: &Value) -> bool {
    receipt.pointer("/details/partClosed") == Some(&Value::Bool(true))
}

pub fn already_closed(receipt: &Value) -> bool {
    receipt.pointer("/details/alreadyClosed") == Some(&Value::Bool(true))
}

pub fn reason_missing(receipt: &Value) -> bool {
    receipt.pointer("/details/reasonMissing") == Some(&Value::Bool(true))
}

/// The checks with `prefix` before each name.
pub fn prefixed(prefix: &str, checks: Vec<Check>) -> Vec<Check> {
    checks
        .into_iter()
        .map(|mut check| {
            check.name = format!("{prefix}{}", check.name);
            check
        })
        .collect()
}

/// Every device of `indices` enters `shift` naming what it supports; the issuer prefix of the
/// first answer that carries a snapshot. Any refusal is an error.
pub async fn enter_all(ctx: &Ctx, shift: &str, indices: &[usize]) -> Res<String> {
    let mut prefix = None;
    for at in indices {
        let device = ctx.device(*at);
        let entered = ctx.enter(&device, shift, Some(device.supports())).await?;
        if !entered.ok() {
            return Err(format!(
                "entry of device {at}: {} {}",
                entered.status, entered.body
            ));
        }
        prefix = prefix.or_else(|| issuer_prefix(&entered.body));
    }
    prefix.ok_or_else(|| "no entry answered a snapshot".to_owned())
}

/// What a scripted device did: the boxes it closed and every receipt, in order.
pub struct Scripted {
    pub boxes: u32,
    pub receipts: Vec<Value>,
}

/// `scans` fresh codes of run `run` into boxes, the boxes and pallets closed, everything sent
/// in order (the drills' `work`, keeping every receipt instead of requiring `accepted`).
pub async fn scripted_work(
    ctx: &Ctx,
    device: &DeviceSpec,
    shift: &str,
    issuer_prefix: &str,
    run: u32,
    scans: u32,
) -> Res<Scripted> {
    let profile = &ctx.profile;
    let cfg = EngineCfg {
        device: device.index,
        run,
        shift_id: shift.to_owned(),
        issuer_prefix: issuer_prefix.to_owned(),
        box_capacity: profile.box_capacity,
        pallet_boxes: profile.pallet_boxes,
        box_block_size: profile.box_block_size,
        pallet_block_size: profile.pallet_block_size,
    };
    let mut engine = Engine::new(
        cfg,
        profile.seed ^ u64::from(run) ^ (u64::from(device.index) << 32),
    );
    for extension in [0u8, 1] {
        if extension == 1 && profile.pallet_boxes == 0 {
            continue;
        }
        let body = json!({
            "requestId": engine.fresh_id(), "issuerPrefix": issuer_prefix, "extension": extension
        });
        let reply = ctx
            .send(device, Route::SsccBlock, "POST", "/v1/device/sscc/blocks", Some(body))
            .await?;
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
        return Err("a scripted device's block ran out of serials".to_owned());
    }
    let mut receipts = Vec::new();
    loop {
        let batch = engine.batch(100);
        if batch.is_empty() {
            break;
        }
        let records: Vec<Value> = batch.iter().map(|queued| queued.record.clone()).collect();
        receipts.extend(ctx.site.office.api.facts(&device.key, &records).await?);
        engine.ack(batch.len());
    }
    Ok(Scripted {
        boxes: engine.boxes_closed as u32,
        receipts,
    })
}

/// One accepted-verdict scan of `code` at `at_ms` into a new box of `shift`; its receipt. `salt`
/// keeps the record id apart from any other scripted record of the device.
pub async fn scripted_scan(
    ctx: &Ctx,
    device: &DeviceSpec,
    shift: &str,
    code: &gen::Code,
    at_ms: i64,
    salt: u64,
) -> Res<Value> {
    let mut rng = Rng::new(
        ctx.profile.seed ^ salt.wrapping_mul(0x9E37_79B9_7F4A_7C15) ^ u64::from(device.index),
    );
    let record = gen::record(
        &rng.uuid(),
        FactKind::Scan,
        shift,
        gen::scan_ok(code, &rng.uuid(), &gen::text_of(at_ms)),
    );
    let mut receipts = ctx.site.office.api.facts(&device.key, &[record]).await?;
    Ok(receipts.remove(0))
}

/// A `shift_closed` record of `device` for `shift`; its id is the device's, the shift's and
/// `salt`'s own, so a second close (another salt) is a new record, not a `payload_mismatch`.
#[allow(clippy::too_many_arguments)]
pub fn close_record(
    shift: &str,
    device: &DeviceSpec,
    salt: u64,
    planned: Option<u32>,
    actual: u32,
    boxes: u32,
    reason: Option<&str>,
    closed_at: &str,
) -> Value {
    let seed = shift.bytes().fold(0xC105E_u64 ^ salt, |seed, byte| {
        seed.wrapping_mul(131).wrapping_add(u64::from(byte))
    });
    let mut rng = Rng::new(seed ^ u64::from(device.index));
    gen::record(
        &rng.uuid(),
        FactKind::ShiftClosed,
        shift,
        gen::shift_closed(planned, actual, boxes, reason, closed_at),
    )
}

/// A scripted device's close of its part (no ledger); its receipt.
#[allow(clippy::too_many_arguments)]
pub async fn close_fact(
    ctx: &Ctx,
    device: &DeviceSpec,
    shift: &str,
    salt: u64,
    planned: Option<u32>,
    actual: u32,
    boxes: u32,
    reason: Option<&str>,
    closed_at: Option<String>,
) -> Res<Value> {
    let at = closed_at.unwrap_or_else(|| gen::text_of(gen::now_ms()));
    let record = close_record(shift, device, salt, planned, actual, boxes, reason, &at);
    let mut receipts = ctx.site.office.api.facts(&device.key, &[record]).await?;
    Ok(receipts.remove(0))
}

/// Rows of the audit log for `shift` with `action`.
pub async fn audit_count(pool: &SqlitePool, shift: &str, action: &str) -> Res<i64> {
    sqlx::query_scalar(
        "SELECT COUNT(*) FROM audit_log WHERE target_type = 'shift' AND target_id = ? AND action = ?",
    )
    .bind(shift)
    .bind(action)
    .fetch_one(pool)
    .await
    .map_err(|error| format!("audit_log {action}: {error}"))
}

/// The close columns of a shift's row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShiftRow {
    pub status: String,
    pub closed_at: Option<String>,
    pub closed_by: Option<String>,
    pub closed_by_kind: Option<String>,
    pub close_reason_code: Option<String>,
    pub close_reason_missing: bool,
}

pub async fn shift_row(pool: &SqlitePool, shift: &str) -> Res<ShiftRow> {
    type Row = (
        String,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        bool,
    );
    let row: Option<Row> = sqlx::query_as(
        "SELECT status, closed_at, closed_by, closed_by_kind, close_reason_code, \
         close_reason_missing FROM shifts WHERE id = ?",
    )
    .bind(shift)
    .fetch_optional(pool)
    .await
    .map_err(|error| format!("shifts: {error}"))?;
    let (status, closed_at, closed_by, closed_by_kind, close_reason_code, close_reason_missing) =
        row.ok_or_else(|| format!("no shift {shift}"))?;
    Ok(ShiftRow {
        status,
        closed_at,
        closed_by,
        closed_by_kind,
        close_reason_code,
        close_reason_missing,
    })
}

/// The database tier of one shift of a load, prefixed: the structural checks, the
/// reconciliation with the load's ledger (every scripted close went through
/// `close_part_ledgered` or `apply_receipt`), the participant invariants, and no rejected record.
pub async fn reconcile(
    ctx: &Ctx,
    prefix: &str,
    shift: &str,
    shared: &Shared,
    devices: &[Arc<SimDevice>],
) -> Vec<Check> {
    let ids: Vec<(u32, String)> = devices
        .iter()
        .map(|device| (device.spec.index, device.spec.id.clone()))
        .collect();
    let snapshot = shared.ledger.lock().expect("ledger").snapshot();
    let pool = match ctx.db().await {
        Ok(pool) => pool,
        Err(error) => return vec![Check::new(&format!("{prefix}db_open"), false, error)],
    };
    let found = [
        ("db_structural", dbcheck::structural(&pool).await),
        (
            "db_reconcile",
            dbcheck::reconcile(&pool, shift, &ids, &snapshot).await,
        ),
        (
            "db_invariants",
            dbcheck::participant_invariants(&pool, shift).await,
        ),
    ];
    pool.close().await;
    let mut checks = Vec::new();
    for (name, made) in found {
        match made {
            Ok(found) => checks.extend(prefixed(prefix, found)),
            Err(error) => checks.push(Check::new(&format!("{prefix}{name}"), false, error)),
        }
    }
    let rejected = shared.ledger.lock().expect("ledger").rejected.clone();
    checks.push(Check::new(
        &format!("{prefix}no_record_rejected"),
        rejected.is_empty(),
        format!("{rejected:?}"),
    ));
    checks
}

/// One scenario by name. Each scenario task adds its arm.
async fn run_one(
    name: &str,
    kind: &HostKind,
    work_dir: &Path,
    profile: &Profile,
) -> (ScenarioResult, Vec<String>) {
    let _ = (kind, work_dir, profile);
    match name {
        other => (
            broken(other, format!("no scenario is named {other}")),
            Vec::new(),
        ),
    }
}

/// Every scenario of `profile`, in order, each on a fresh host of `kind`'s mode under
/// `<work_dir>/scenarios/`; their results and every secret their sites made.
pub async fn run_all(
    kind: &HostKind,
    work_dir: &Path,
    profile: &Profile,
) -> (Vec<ScenarioResult>, Vec<String>) {
    let mut results = Vec::new();
    let mut secrets = Vec::new();
    for name in &profile.scenarios {
        let started = Instant::now();
        let (mut done, found) = if *kind == HostKind::Attach {
            (
                not_judged(
                    name,
                    "attach: the harness makes a fresh host for each scenario and cannot make one beside an attached host",
                ),
                Vec::new(),
            )
        } else {
            run_one(name, kind, work_dir, profile).await
        };
        done.duration_ms = started.elapsed().as_millis() as u64;
        let failed = done.checks.iter().filter(|check| !check.ok).count();
        eprintln!(
            "[scenario {name}] {} ({} checks, {failed} failed, {:.0} s)",
            if !done.judged {
                "not judged"
            } else if failed == 0 {
                "held"
            } else {
                "FAILED"
            },
            done.checks.len(),
            started.elapsed().as_secs_f64()
        );
        results.push(done);
        secrets.extend(found);
    }
    (results, secrets)
}
```

The single-arm `match` in `run_one` is deliberate: Task 4 adds the first named arm (until then the compiler may warn that the match has one arm; warnings are not a gate).

- [ ] **Step 5: The run.** In `src/run.rs`, add `use crate::scenarios::{self, HostKind};` to the imports. Replace the host match

```rust
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
```

with

```rust
    let (mut host, kind, attach, scenario_host) = match choice {
        HostChoice::InProcess => (
            Host::in_process(&data_dir)
                .await
                .map_err(|e| e.to_string())?,
            "in-process",
            None,
            HostKind::InProcess,
        ),
        HostChoice::Spawn { bin } => (
            Host::spawned(&bin, &data_dir, &work_dir.join("host-stdout.log"))
                .await
                .map_err(|e| e.to_string())?,
            "spawn",
            None,
            HostKind::Spawn { bin },
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
            HostKind::Attach,
        ),
    };
```

After the `let restore = match … };` statement add:

```rust
    // The scenarios, each on a fresh host of the same mode: the main host is stopped by now and
    // nothing of theirs reaches the main run's metrics, series or log.
    let (scenario_results, scenario_secrets) =
        scenarios::run_all(&scenario_host, &work_dir, &profile).await;
```

In the `Report { … }` literal replace `scenarios: Vec::new(),` (Task 1) with `scenarios: scenario_results,`. Replace the last line `Ok((report, site.secrets.clone()))` with:

```rust
    let mut secrets = site.secrets.clone();
    secrets.extend(scenario_secrets);
    Ok((report, secrets))
```

- [ ] **Step 6: The cleanup of a passing run.** In `src/cli.rs`, in `run`, after `let _ = std::fs::remove_dir_all(work_dir.join("restored"));` add:

```rust
        let _ = std::fs::remove_dir_all(work_dir.join("scenarios"));
```

- [ ] **Step 7: The self-test.** In `tests/self_run.rs`, in `the_tiny_profile_passes_every_check_against_a_host_in_this_process`, before `// \`execute\` hands back a report…` add:

```rust
    // Every scenario of the profile ran: a judged one held (the verdict says so), a spawn-only
    // one is not judged with a host in this process.
    assert_eq!(
        report.scenarios.len(),
        markiro_loadtest::profile::SCENARIOS.len()
    );
    for scenario in &report.scenarios {
        let spawn_only = markiro_loadtest::scenarios::SPAWN_ONLY.contains(&scenario.name.as_str());
        assert_eq!(scenario.judged, !spawn_only, "{}", scenario.name);
    }
```

- [ ] **Step 8: Run the tests to verify they pass.**

Run (sandbox off): `cargo --offline --locked test --manifest-path "$WT/apps/standalone/Cargo.toml" -p markiro-loadtest --lib scenarios::tests`
Expected: `test result: ok. 4 passed`.

Run (sandbox off): `cargo --offline --locked test --manifest-path "$WT/apps/standalone/Cargo.toml" -p markiro-loadtest --lib host::tests`
Expected: `test result: ok.`, including `a_stopped_spawned_host_is_not_signalled_again` (it builds `markiro-host` first when the binary is missing).

Run (sandbox off): `cargo --offline --locked test --manifest-path "$WT/apps/standalone/Cargo.toml" -p markiro-loadtest --test self_run -- --ignored the_tiny_profile_passes`
Expected: `test result: ok. 1 passed` (no scenario yet: `SCENARIOS` is empty, the new loop asserts nothing).

- [ ] **Step 9: Mutation check.** In `Ctx::finish`, change `Check::at_most("no_5xx_answer", 0, count(":http_5xx"))` to `Check::at_most("no_5xx_answer", 0, count(":http_5xx") + 1)`; `a_context_makes_a_site_of_three_lines_and_no_shift_and_finishes_clean` must FAIL. Restore; ok.

- [ ] **Step 10: Commit.**

```bash
git -C "$WT" add apps/standalone/loadtest/src/scenarios/mod.rs apps/standalone/loadtest/src/lib.rs apps/standalone/loadtest/src/host.rs apps/standalone/loadtest/src/run.rs apps/standalone/loadtest/src/cli.rs apps/standalone/loadtest/tests/self_run.rs
git -C "$WT" commit -m "feat(loadtest): scenario context, quiet load and the run's wiring

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: `line-full` — the line's limit under load, a leave, a revoked device

**Files:**

- Create: `apps/standalone/loadtest/src/scenarios/line_full.rs`
- Modify: `apps/standalone/loadtest/src/scenarios/mod.rs`, `apps/standalone/loadtest/src/profile.rs`, `apps/standalone/loadtest/tests/self_run.rs`

**Interfaces:**

- Consumes: Task 3.
- Produces: the scenario `line-full` (in `SCENARIOS` and the dispatcher).

**What the host does (E7):** of N + 1 simultaneous first entries into a shift of a line limited to N, the `BEGIN IMMEDIATE` of `enter_shift` lets N in and answers the last `409 conflict` with `details = { constraint: "shift_line_full", maxStations: N, active: N }`. A leave (`left`) frees a slot; the device that left meets a full line while someone else holds the slot. A limit below the live slots is `line_stations_in_use` with `details.active`. A revoked device's slot is free (`active_others`), its key is `401`, but its part stays `active` and `open_others` counts it, so the working parts' closes all answer `partClosed` and only the office closes the shift (`notClosed` includes the revoked part, closed by `office_user`).

- [ ] **Step 1: Write the failing test.** Create `src/scenarios/line_full.rs` holding only its test for now:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn the_line_full_scenario_holds_against_a_host_in_this_process() {
        let work = tempfile::tempdir().unwrap();
        let profile = Profile::preset("tiny").unwrap();
        let (result, secrets) = run(&HostKind::InProcess, work.path(), &profile).await;
        for check in &result.checks {
            eprintln!("OBSERVED {} {} {}", check.name, check.ok, check.detail);
        }
        eprintln!("OBSERVED {:?}", result.observed);
        assert!(result.judged);
        assert!(
            result.checks.iter().all(|check| check.ok),
            "{:#?}",
            result.checks
        );
        for name in [
            "entries_admitted",
            "refusal_names_the_limit",
            "a_refused_device_enters_after_a_leave",
            "a_limit_below_the_slots_held_is_refused",
            "a_revoked_key_is_refused",
            "a_revoked_device_holds_no_slot",
            "closes_leave_the_shift_open_while_a_revoked_part_is_open",
            "the_office_closes_the_revoked_part",
            "db_code_owners",
            "background_db_code_owners",
        ] {
            assert!(
                result.checks.iter().any(|check| check.name == name),
                "no check {name}"
            );
        }
        assert!(!secrets.is_empty());
    }
}
```

In `src/scenarios/mod.rs` add `pub mod line_full;` below the module's `//!` text (before the `use` lines).

- [ ] **Step 2: Run it to verify it fails.**

Run: `cargo --offline --locked test --manifest-path "$WT/apps/standalone/Cargo.toml" -p markiro-loadtest --lib --no-run`
Expected: FAIL to compile: `cannot find function run in this scope` (and the unresolved imports of the test).

- [ ] **Step 3: Write the scenario.** Put this above the tests module of `src/scenarios/line_full.rs`:

```rust
//! `line-full`: a line allows N devices in a shift and N + 1 enter at the same instant while
//! another line's shift is under load. Exactly N get in and the other is told `shift_line_full`
//! with the limit and the slots held; a leave frees a slot; a revoked device holds none, but its
//! open part keeps the shift open until the office closes it (host
//! `shift_participants::{decide_entry, active_others, open_others, line_slots_in_use}`).

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};

use super::{
    constraint, issuer_prefix, joined_rev, my_state, part, part_closed, send_raw, Ctx, HostKind,
    Res, LOAD_S,
};
use crate::checks::Check;
use crate::metrics::Route;
use crate::profile::Profile;
use crate::report::ScenarioResult;

pub const NAME: &str = "line-full";
/// The line's limit; one device more than this enters at once.
const LIMIT: u32 = 3;

pub async fn run(
    kind: &HostKind,
    work_dir: &Path,
    base: &Profile,
) -> (ScenarioResult, Vec<String>) {
    // Five stations and a handheld: three stations and the handheld contend on line 1; the
    // office station (0) and station 4 scan on line 2 meanwhile.
    let mut ctx = match Ctx::new(NAME, kind, work_dir, base, 5, 1).await {
        Ok(ctx) => ctx,
        Err(error) => return (super::broken(NAME, error), Vec::new()),
    };
    let outcome = body(&mut ctx).await;
    ctx.finish(outcome).await
}

async fn body(ctx: &mut Ctx) -> Res<()> {
    let line_1 = ctx.site.line_ids[0].clone();
    let line_2 = ctx.site.line_ids[1].clone();
    // The background: devices 0 and 4 work a shift of line 2 for the whole scenario. The wizard's
    // lines allow one device; line 2 takes two.
    for at in [0usize, 4] {
        let device = ctx.device(at);
        ctx.move_to_line(&device, &line_2).await?;
    }
    let widened = ctx.set_max_stations(&line_2, 2).await?;
    ctx.same("background_limit_set", 200u16, widened.status);
    let busy = ctx.plan(&line_2, None).await?;
    let busy_prefix = super::enter_all(ctx, &busy, &[0, 4]).await?;
    let background = ctx.load(1, &busy, &busy_prefix, &[0, 4]);
    // The limit, with no active shift on line 1: always taken.
    let set = ctx.set_max_stations(&line_1, LIMIT).await?;
    ctx.same("limit_set", 200u16, set.status);
    let shift = ctx.plan(&line_1, None).await?;
    // N + 1 first entries at the same instant.
    let contenders = [1usize, 2, 3, 5];
    let barrier = Arc::new(tokio::sync::Barrier::new(contenders.len()));
    let mut tasks = Vec::new();
    for at in contenders {
        let device = ctx.device(at);
        let api = ctx.site.office.api.clone();
        let barrier = barrier.clone();
        let path = format!("/v1/device/shifts/{shift}/enter");
        tasks.push(tokio::spawn(async move {
            barrier.wait().await;
            let body = json!({ "supports": device.supports() });
            let reply = send_raw(&api, &device.key, Route::Enter, "POST", &path, Some(body)).await;
            (at, reply)
        }));
    }
    let mut entries = BTreeMap::new();
    for task in tasks {
        let (at, reply) = task.await.map_err(|error| error.to_string())?;
        entries.insert(at, reply?);
    }
    let admitted: Vec<usize> = entries
        .iter()
        .filter(|(_, reply)| reply.ok())
        .map(|(at, _)| *at)
        .collect();
    let refused: Vec<usize> = entries
        .iter()
        .filter(|(_, reply)| !reply.ok())
        .map(|(at, _)| *at)
        .collect();
    ctx.observe("admitted", json!(admitted));
    ctx.observe("refused", json!(refused));
    ctx.same("entries_admitted", LIMIT as usize, admitted.len());
    ctx.same("entries_refused", 1usize, refused.len());
    let Some(&refused_at) = refused.first() else {
        return Err(format!("no entry was refused: {admitted:?} admitted"));
    };
    let refusal = entries[&refused_at].clone();
    ctx.same(
        "refusal_is_shift_line_full",
        (409u16, Some("shift_line_full")),
        (refusal.status, constraint(&refusal)),
    );
    ctx.same(
        "refusal_names_the_limit",
        Some(u64::from(LIMIT)),
        refusal
            .body
            .pointer("/error/details/maxStations")
            .and_then(Value::as_u64),
    );
    ctx.same(
        "refusal_names_the_slots_held",
        Some(u64::from(LIMIT)),
        refusal
            .body
            .pointer("/error/details/active")
            .and_then(Value::as_u64),
    );
    let office = ctx.office_shift(&shift).await?;
    ctx.same(
        "participants_after_the_burst",
        LIMIT as usize,
        super::states(&office).len(),
    );
    let prefix = admitted
        .iter()
        .find_map(|at| issuer_prefix(&entries[at].body))
        .ok_or("no admitted entry answered a snapshot")?;
    let work = ctx.load(2, &shift, &prefix, &admitted);
    tokio::time::sleep(Duration::from_secs(LOAD_S)).await;
    // A leave frees a slot: the first admitted device pauses and leaves with its token.
    let leaver_at = admitted[0];
    let leaver = ctx.device(leaver_at);
    work.of(leaver_at).pause().await;
    let token = joined_rev(&entries[&leaver_at].body, &leaver.id);
    let left = ctx.leave(&leaver, &shift, token).await?;
    ctx.same("leave_frees_the_slot", "left", my_state(&left.body));
    let late = ctx.device(refused_at);
    let entered = ctx.enter(&late, &shift, Some(late.supports())).await?;
    ctx.same(
        "a_refused_device_enters_after_a_leave",
        (200u16, "active"),
        (entered.status, my_state(&entered.body)),
    );
    let back = ctx.enter(&leaver, &shift, Some(leaver.supports())).await?;
    ctx.same(
        "the_device_that_left_meets_a_full_line",
        (409u16, Some("shift_line_full")),
        (back.status, constraint(&back)),
    );
    // A limit below the slots held is refused and names them.
    let lower = ctx.set_max_stations(&line_1, LIMIT - 1).await?;
    ctx.same(
        "a_limit_below_the_slots_held_is_refused",
        (409u16, Some("line_stations_in_use"), Some(u64::from(LIMIT))),
        (
            lower.status,
            constraint(&lower),
            lower
                .body
                .pointer("/error/details/active")
                .and_then(Value::as_u64),
        ),
    );
    // A revoked device holds no slot. The device that entered last runs no load: revoke it.
    let revoked = ctx
        .site
        .office
        .call(
            "POST",
            &format!("/v1/office/devices/{}/revoke", late.id),
            None,
        )
        .await?;
    ctx.same("revoke_answered", 200u16, revoked.status);
    let refused_key = ctx.enter(&late, &shift, Some(late.supports())).await?;
    ctx.same("a_revoked_key_is_refused", 401u16, refused_key.status);
    let back = ctx.enter(&leaver, &shift, Some(leaver.supports())).await?;
    ctx.same(
        "a_revoked_device_holds_no_slot",
        (200u16, "active"),
        (back.status, my_state(&back.body)),
    );
    work.of(leaver_at).resume();
    let office = ctx.office_shift(&shift).await?;
    ctx.same(
        "a_revoked_part_stays_open",
        Some("active"),
        part(&office, &late.id).and_then(|part| part["state"].as_str()),
    );
    tokio::time::sleep(Duration::from_secs(LOAD_S)).await;
    let (shared, devices, drained) = work.stop("").await;
    ctx.checks(drained);
    // Every working part closes; the revoked part is open, so none of them closes the shift.
    let mut receipts = Vec::new();
    for device in &devices {
        receipts.push(device.close_part_ledgered(None, None, None).await?);
    }
    ctx.same(
        "closes_leave_the_shift_open_while_a_revoked_part_is_open",
        vec![true; devices.len()],
        receipts.iter().map(part_closed).collect::<Vec<_>>(),
    );
    let office = ctx.office_shift(&shift).await?;
    ctx.same(
        "status_after_the_working_parts_closed",
        "active",
        office["status"].as_str().unwrap_or(""),
    );
    let closed = ctx
        .office_close(&shift, "Нагрузочная проверка: отозванное устройство")
        .await?;
    ctx.same("the_office_closes_the_shift", 200u16, closed.status);
    ctx.same(
        "the_office_closes_the_revoked_part",
        (Some("closed"), Some("office_user")),
        part(&closed.body, &late.id).map_or((None, None), |part| {
            (part["state"].as_str(), part["closedBy"].as_str())
        }),
    );
    let found = super::reconcile(ctx, "", &shift, &shared, &devices).await;
    ctx.checks(found);
    let mut expected: Vec<(u32, String, &str)> = devices
        .iter()
        .map(|device| (device.spec.index, device.spec.id.clone(), "closed"))
        .collect();
    expected.push((late.index, late.id.clone(), "closed"));
    let pool = ctx.db().await?;
    let found = crate::dbcheck::participants_in(&pool, &shift, &expected).await;
    pool.close().await;
    match found {
        Ok(checks) => ctx.checks(checks),
        Err(error) => ctx.check(Check::new("db_participants", false, error)),
    }
    // The background shift: closed by its last part, and exact.
    let (bg_shared, bg_devices, drained) = background.stop("background_").await;
    ctx.checks(drained);
    let mut last = None;
    for device in &bg_devices {
        last = Some(device.close_part_ledgered(None, None, None).await?);
    }
    ctx.same(
        "background_shift_closed_by_its_last_part",
        Some(false),
        last.as_ref().map(part_closed),
    );
    let found = super::reconcile(ctx, "background_", &busy, &bg_shared, &bg_devices).await;
    ctx.checks(found);
    Ok(())
}
```

In `src/scenarios/mod.rs`, in `run_one`, replace

```rust
    let _ = (kind, work_dir, profile);
    match name {
        other => (
```

with

```rust
    match name {
        line_full::NAME => line_full::run(kind, work_dir, profile).await,
        other => (
```

In `src/profile.rs` replace `pub const SCENARIOS: &[&str] = &[];` with `pub const SCENARIOS: &[&str] = &["line-full"];`.

In `tests/self_run.rs`, in `the_written_files_carry_none_of_the_runs_secrets`, after `profile.set("durationS", "10").unwrap();` add `profile.set("scenarios", "line-full").unwrap();`, and after `assert!(secrets.iter().any(|secret| secret.starts_with("Load-")));` add:

```rust
    // The scenario's own site made a second administrator password, and it is among them.
    assert!(
        secrets
            .iter()
            .filter(|secret| secret.starts_with("Load-"))
            .count()
            >= 2,
        "the scenario's secrets are not among the run's"
    );
```

- [ ] **Step 4: Run the test to verify it passes.**

Run (sandbox off): `cargo --offline --locked test --manifest-path "$WT/apps/standalone/Cargo.toml" -p markiro-loadtest --lib scenarios::line_full -- --nocapture`
Expected: `test result: ok. 1 passed`; the `OBSERVED` lines list every check `true` and `{"admitted": [..three..], "refused": [..one..]}`.

If a check fails: do not change the scenario. Record the check's name and detail (e.g. `refusal_names_the_slots_held: expected Some(3), got Some(2)`), keep the test's work folder (rerun with `--nocapture` and a `std::mem::forget(work)` added only locally, not committed) and report it as a host finding with the exact host function from E7 it contradicts.

- [ ] **Step 5: Mutation check.** Change the check `ctx.same("entries_admitted", LIMIT as usize, admitted.len());` to `ctx.same("entries_admitted", LIMIT as usize + 1, admitted.len());`; the test must FAIL naming `entries_admitted`. Restore it. Then change `.filter(|(_, reply)| !reply.ok())` (the `refused` list) to `.filter(|(_, reply)| reply.status == 401)`; the test must FAIL (`entries_refused`, then `scenario_ran: no entry was refused`). Restore; ok.

- [ ] **Step 6: The self-test still passes.**

Run (sandbox off): `cargo --offline --locked test --manifest-path "$WT/apps/standalone/Cargo.toml" -p markiro-loadtest --test self_run -- --ignored`
Expected: `test result: ok. 2 passed` (`line-full` judged and held in the first; the second finds two `Load-` passwords).

- [ ] **Step 7: Commit.**

```bash
git -C "$WT" add apps/standalone/loadtest/src/scenarios/line_full.rs apps/standalone/loadtest/src/scenarios/mod.rs apps/standalone/loadtest/src/profile.rs apps/standalone/loadtest/tests/self_run.rs
git -C "$WT" commit -m "feat(loadtest): scenario line-full (limit under load, leave, revoked device)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: `capability` — a build that does not name `multi-station-v1`

**Files:**

- Create: `apps/standalone/loadtest/src/scenarios/capability.rs`
- Modify: `apps/standalone/loadtest/src/scenarios/mod.rs`, `apps/standalone/loadtest/src/profile.rs`

**Interfaces:**

- Consumes: Task 3.
- Produces: the scenario `capability`.

**What the host does (E7, `decide_entry`, `enter_shift`, `require_supports`, `protocol_guard`, `with_participation`):** a build naming nothing opens a planned shift; another such build meets an open shift as `shift_busy` whatever the slots — with free slots, and with no active participant at all; a build naming the capability joins; a participant that left comes back naming nothing; a closed part entered again naming nothing is `shift_status` / `closed` while the shift is active, and naming the capability reads its part back (`myState: closed`); a handheld must name `handheld-host-v1` (`station_update`); facts of a legacy participant are taken; the device list gives the shared shift's participants and totals to any device of the line; `protocol_unsupported` comes only from the protocol header.

- [ ] **Step 1: Write the failing test.** Create `src/scenarios/capability.rs` holding only:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn the_capability_scenario_holds_against_a_host_in_this_process() {
        let work = tempfile::tempdir().unwrap();
        let profile = Profile::preset("tiny").unwrap();
        let (result, _) = run(&HostKind::InProcess, work.path(), &profile).await;
        for check in &result.checks {
            eprintln!("OBSERVED {} {} {}", check.name, check.ok, check.detail);
        }
        assert!(result.judged);
        assert!(
            result.checks.iter().all(|check| check.ok),
            "{:#?}",
            result.checks
        );
        for name in [
            "legacy_opens_a_planned_shift",
            "legacy_entry_into_a_worked_shift_is_busy",
            "legacy_is_busy_with_no_active_participant",
            "a_legacy_participant_that_left_rejoins",
            "a_legacy_device_with_a_closed_part_is_told_the_shift_is_closed",
            "a_multi_entry_reads_its_closed_part",
            "a_non_participant_reads_the_shared_shift",
            "an_unknown_protocol_is_protocol_unsupported",
            "an_old_protocol_is_accepted_and_judged_by_the_capability",
            "the_last_part_closes_the_shift",
            "closed_shift_has_no_open_part",
        ] {
            assert!(
                result.checks.iter().any(|check| check.name == name),
                "no check {name}"
            );
        }
    }
}
```

and add `pub mod capability;` beside `pub mod line_full;` in `src/scenarios/mod.rs`.

- [ ] **Step 2: Run it to verify it fails.**

Run: `cargo --offline --locked test --manifest-path "$WT/apps/standalone/Cargo.toml" -p markiro-loadtest --lib --no-run`
Expected: FAIL to compile: `cannot find function run in this scope`.

- [ ] **Step 3: Write the scenario.** Put this above the tests module of `src/scenarios/capability.rs`:

```rust
//! `capability`: what a build that does not name `multi-station-v1` meets (host
//! `shift_participants::decide_entry`, `routes/device_shifts.rs::{enter_shift, require_supports,
//! with_participation}`, `server.rs::protocol_guard`). No load: every step is one request and its
//! exact answer.

use std::path::Path;

use serde_json::{json, Value};

use super::{
    close_fact, constraint, error_code, issuer_prefix, joined_rev, my_state, part_closed,
    scripted_work, send_with_protocol, Ctx, HostKind, Res,
};
use crate::checks::Check;
use crate::metrics::Route;
use crate::profile::Profile;
use crate::report::ScenarioResult;

pub const NAME: &str = "capability";

pub async fn run(
    kind: &HostKind,
    work_dir: &Path,
    base: &Profile,
) -> (ScenarioResult, Vec<String>) {
    // Device 0 names the capability, 1 and 2 are legacy stations, 3 a handheld.
    let mut ctx = match Ctx::new(NAME, kind, work_dir, base, 3, 1).await {
        Ok(ctx) => ctx,
        Err(error) => return (super::broken(NAME, error), Vec::new()),
    };
    let outcome = body(&mut ctx).await;
    ctx.finish(outcome).await
}

async fn body(ctx: &mut Ctx) -> Res<()> {
    let line = ctx.site.line_ids[0].clone();
    let (multi, legacy, other, handheld) =
        (ctx.device(0), ctx.device(1), ctx.device(2), ctx.device(3));
    let shift = ctx.plan(&line, None).await?;
    // A build that names nothing opens a planned shift alone, as in stage 2a.
    let opened = ctx.enter(&legacy, &shift, Some(Vec::new())).await?;
    ctx.same(
        "legacy_opens_a_planned_shift",
        (200u16, "active"),
        (opened.status, my_state(&opened.body)),
    );
    let prefix = issuer_prefix(&opened.body).ok_or("the opening answered no snapshot")?;
    // Another build that names nothing meets a shift somebody works. No body at all (a
    // protocol 3 station) reads the same.
    let busy = ctx.enter(&other, &shift, None).await?;
    ctx.same(
        "legacy_entry_into_a_worked_shift_is_busy",
        (409u16, Some("conflict"), Some("shift_busy")),
        (busy.status, error_code(&busy), constraint(&busy)),
    );
    // A build that names the capability joins the shift a legacy build opened.
    let joined = ctx.enter(&multi, &shift, Some(multi.supports())).await?;
    ctx.same(
        "multi_device_joins_a_shift_a_legacy_device_opened",
        (200u16, "active"),
        (joined.status, my_state(&joined.body)),
    );
    // Still busy with two of the line's four slots free: the capability decides, not the slots.
    let busy = ctx.enter(&other, &shift, Some(Vec::new())).await?;
    ctx.same(
        "legacy_stays_busy_while_slots_are_free",
        (409u16, Some("shift_busy")),
        (busy.status, constraint(&busy)),
    );
    // Reads are not gated by the capability: a device of the line that never entered sees the
    // shared shift's participants and totals.
    let list = ctx
        .send(&other, Route::DeviceShifts, "GET", "/v1/device/shifts", None)
        .await?;
    let seen = list.body["shifts"]
        .as_array()
        .and_then(|shifts| shifts.iter().find(|item| item["id"] == json!(shift)))
        .cloned()
        .unwrap_or(Value::Null);
    ctx.same(
        "a_non_participant_reads_the_shared_shift",
        (2usize, true, true),
        (
            super::states(&seen).len(),
            seen.get("totals").is_some_and(Value::is_object),
            seen.get("myState").map_or(true, Value::is_null),
        ),
    );
    // A handheld names its host capability whatever else it names.
    let update = ctx
        .enter(&handheld, &shift, Some(vec!["multi-station-v1"]))
        .await?;
    ctx.same(
        "a_handheld_without_its_host_capability_is_told_to_update",
        (409u16, Some("station_update")),
        (update.status, constraint(&update)),
    );
    // A legacy participant's facts are taken like anyone's.
    let made = scripted_work(ctx, &legacy, &shift, &prefix, 1, 3).await?;
    ctx.same(
        "a_legacy_participants_facts_are_accepted",
        vec!["accepted"; made.receipts.len()],
        made.receipts
            .iter()
            .map(|receipt| receipt["outcome"].as_str().unwrap_or(""))
            .collect::<Vec<_>>(),
    );
    // Nobody active at all: a legacy device that never entered is still busy.
    let left = ctx
        .leave(&legacy, &shift, joined_rev(&opened.body, &legacy.id))
        .await?;
    let left_multi = ctx
        .leave(&multi, &shift, joined_rev(&joined.body, &multi.id))
        .await?;
    ctx.same(
        "both_parts_left",
        ("left", "left"),
        (my_state(&left.body), my_state(&left_multi.body)),
    );
    let busy = ctx.enter(&other, &shift, Some(Vec::new())).await?;
    ctx.same(
        "legacy_is_busy_with_no_active_participant",
        (409u16, Some("shift_busy")),
        (busy.status, constraint(&busy)),
    );
    // A legacy participant that left comes back naming nothing: the capability guards a first
    // entry only.
    let back = ctx.enter(&legacy, &shift, Some(Vec::new())).await?;
    ctx.same(
        "a_legacy_participant_that_left_rejoins",
        (200u16, "active"),
        (back.status, my_state(&back.body)),
    );
    let back_multi = ctx.enter(&multi, &shift, Some(multi.supports())).await?;
    ctx.same(
        "the_multi_participant_rejoins",
        (200u16, "active"),
        (back_multi.status, my_state(&back_multi.body)),
    );
    // The legacy part closes; the other keeps the shift open.
    let receipt = close_fact(ctx, &legacy, &shift, 1, None, 3, made.boxes, None, None).await?;
    ctx.same(
        "legacy_close_closes_only_its_part",
        (Some("accepted"), true),
        (receipt["outcome"].as_str(), part_closed(&receipt)),
    );
    // Its legacy build entering again is told the shift is closed while it is active: every
    // older build shows `shift_status` as «закрыта».
    let again = ctx.enter(&legacy, &shift, Some(Vec::new())).await?;
    ctx.same(
        "a_legacy_device_with_a_closed_part_is_told_the_shift_is_closed",
        (409u16, Some("shift_status"), Some("closed")),
        (
            again.status,
            constraint(&again),
            again
                .body
                .pointer("/error/details/status")
                .and_then(Value::as_str),
        ),
    );
    let office = ctx.office_shift(&shift).await?;
    ctx.same(
        "the_shift_stays_active",
        "active",
        office["status"].as_str().unwrap_or(""),
    );
    // The same device naming the capability reads its closed part back.
    let read = ctx.enter(&legacy, &shift, Some(legacy.supports())).await?;
    ctx.same(
        "a_multi_entry_reads_its_closed_part",
        (200u16, "closed"),
        (read.status, my_state(&read.body)),
    );
    // `protocol_unsupported` is about the protocol header, never a capability.
    let unknown = send_with_protocol(ctx, &multi, "GET", "/v1/device/shifts", 99, None).await?;
    ctx.same(
        "an_unknown_protocol_is_protocol_unsupported",
        (
            400u16,
            Some("protocol_unsupported"),
            Some(u64::from(markiro_proto::PROTOCOL_VERSION)),
        ),
        (
            unknown.status,
            error_code(&unknown),
            unknown
                .body
                .pointer("/error/details/maxProtocol")
                .and_then(Value::as_u64),
        ),
    );
    let old = send_with_protocol(
        ctx,
        &other,
        "POST",
        &format!("/v1/device/shifts/{shift}/enter"),
        3,
        None,
    )
    .await?;
    ctx.same(
        "an_old_protocol_is_accepted_and_judged_by_the_capability",
        (409u16, Some("shift_busy")),
        (old.status, constraint(&old)),
    );
    // The last open part closes the shift.
    let last = close_fact(ctx, &multi, &shift, 1, None, 0, 0, None, None).await?;
    ctx.same(
        "the_last_part_closes_the_shift",
        (Some("accepted"), false),
        (last["outcome"].as_str(), part_closed(&last)),
    );
    let pool = ctx.db().await?;
    let invariants = crate::dbcheck::participant_invariants(&pool, &shift).await;
    let states = crate::dbcheck::participants_in(
        &pool,
        &shift,
        &[
            (legacy.index, legacy.id.clone(), "closed"),
            (multi.index, multi.id.clone(), "closed"),
        ],
    )
    .await;
    pool.close().await;
    for (name, found) in [("db_invariants", invariants), ("db_participants", states)] {
        match found {
            Ok(checks) => ctx.checks(checks),
            Err(error) => ctx.check(Check::new(name, false, error)),
        }
    }
    Ok(())
}
```

In `src/scenarios/mod.rs`, in `run_one`, add the arm `capability::NAME => capability::run(kind, work_dir, profile).await,` after the `line_full` arm. In `src/profile.rs` make `SCENARIOS` `&["line-full", "capability"]`.

- [ ] **Step 4: Run the test to verify it passes.**

Run (sandbox off): `cargo --offline --locked test --manifest-path "$WT/apps/standalone/Cargo.toml" -p markiro-loadtest --lib scenarios::capability -- --nocapture`
Expected: `test result: ok. 1 passed`, every `OBSERVED` check `true`.

The answers this scenario pins (`shift_busy` with no active participant; `shift_status` for a closed part while the shift is active) come from `decide_entry` and the `ReadClosed if !multi` arm of `enter_shift`. If the host answers otherwise, report it with the reply body; do not adapt the expectation.

- [ ] **Step 5: Mutation check.** In the check `legacy_is_busy_with_no_active_participant`, change `Some("shift_busy")` to `Some("shift_line_full")`; the test must FAIL naming it. Restore; ok.

- [ ] **Step 6: Commit.**

```bash
git -C "$WT" add apps/standalone/loadtest/src/scenarios/capability.rs apps/standalone/loadtest/src/scenarios/mod.rs apps/standalone/loadtest/src/profile.rs
git -C "$WT" commit -m "feat(loadtest): scenario capability (a build without multi-station-v1)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: `leave-reenter` — pauses and returns while scans flow

**Files:**

- Create: `apps/standalone/loadtest/src/scenarios/leave_reenter.rs`
- Modify: `apps/standalone/loadtest/src/scenarios/mod.rs`, `apps/standalone/loadtest/src/profile.rs`

**Interfaces:**

- Consumes: Task 3.
- Produces: the scenario `leave-reenter`.

**What the host does (E7, `leave_shift`, `decide_entry`, `facts::entered_shift`):** a leave with the current `joinedRev` makes the part `left`, frees its slot and writes `shift.leave`; a return stamps a new `joinedRev` and writes `shift.join` (a first entry is `shift.join` too, except the opener's `shift.open`); a leave carrying an earlier stay's token answers the part `active` and writes nothing (no revision, no audit). A left part's facts are accepted and never marked late. Three stations work a line limited to three; a handheld is the spare that takes a freed slot.

- [ ] **Step 1: Write the failing test.** Create `src/scenarios/leave_reenter.rs` holding only:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn the_leave_reenter_scenario_holds_against_a_host_in_this_process() {
        let work = tempfile::tempdir().unwrap();
        let profile = Profile::preset("tiny").unwrap();
        let (result, _) = run(&HostKind::InProcess, work.path(), &profile).await;
        for check in &result.checks {
            eprintln!("OBSERVED {} {} {}", check.name, check.ok, check.detail);
        }
        assert!(result.judged);
        assert!(
            result.checks.iter().all(|check| check.ok),
            "{:#?}",
            result.checks
        );
        for name in [
            "cycle_0_leave",
            "facts_of_a_left_part_are_accepted",
            "cycle_2_spare_takes_the_freed_slot",
            "cycle_2_full_while_the_spare_holds_the_slot",
            "cycle_2_reenters_with_a_new_token",
            "cycle_2_stale_leave_is_a_no_op",
            "audit_joins",
            "audit_leaves",
            "participant_state_device_3",
            "the_left_part_closes_the_shift",
            "db_receipts_device_0",
        ] {
            assert!(
                result.checks.iter().any(|check| check.name == name),
                "no check {name}"
            );
        }
    }
}
```

and add `pub mod leave_reenter;` beside the other modules in `src/scenarios/mod.rs`.

- [ ] **Step 2: Run it to verify it fails.**

Run: `cargo --offline --locked test --manifest-path "$WT/apps/standalone/Cargo.toml" -p markiro-loadtest --lib --no-run`
Expected: FAIL to compile: `cannot find function run in this scope`.

- [ ] **Step 3: Write the scenario.** Put this above the tests module of `src/scenarios/leave_reenter.rs`:

```rust
//! `leave-reenter`: devices pause (`leave` with their `joinedRev`) and return while the others
//! scan; the freed slot is taken by a spare; a leave of an earlier stay changes nothing; the
//! counts of joins and leaves, the states of the parts and the ledger stay exact (host
//! `routes/device_shifts.rs::leave_shift`, `shift_participants::decide_entry`).

use std::collections::BTreeMap;
use std::path::Path;
use std::time::Duration;

use super::{close_fact, constraint, joined_rev, my_state, part_closed, Ctx, HostKind, Res, LOAD_S};
use crate::checks::Check;
use crate::profile::Profile;
use crate::report::ScenarioResult;

pub const NAME: &str = "leave-reenter";
/// Pause-and-return cycles, one device after another.
const CYCLES: usize = 3;
/// The line's limit: exactly the three working stations.
const LIMIT: u32 = 3;

pub async fn run(
    kind: &HostKind,
    work_dir: &Path,
    base: &Profile,
) -> (ScenarioResult, Vec<String>) {
    // Stations 0, 1 and 2 work; handheld 3 is the spare.
    let mut ctx = match Ctx::new(NAME, kind, work_dir, base, 3, 1).await {
        Ok(ctx) => ctx,
        Err(error) => return (super::broken(NAME, error), Vec::new()),
    };
    let outcome = body(&mut ctx).await;
    ctx.finish(outcome).await
}

async fn body(ctx: &mut Ctx) -> Res<()> {
    let line = ctx.site.line_ids[0].clone();
    let set = ctx.set_max_stations(&line, LIMIT).await?;
    ctx.same("limit_set", 200u16, set.status);
    let shift = ctx.plan(&line, None).await?;
    let mut tokens: BTreeMap<usize, Option<u64>> = BTreeMap::new();
    let mut prefix = None;
    for at in [0usize, 1, 2] {
        let device = ctx.device(at);
        let entered = ctx.enter(&device, &shift, Some(device.supports())).await?;
        if !entered.ok() {
            return Err(format!(
                "entry of device {at}: {} {}",
                entered.status, entered.body
            ));
        }
        tokens.insert(at, joined_rev(&entered.body, &device.id));
        prefix = prefix.or_else(|| super::issuer_prefix(&entered.body));
    }
    let prefix = prefix.ok_or("no entry answered a snapshot")?;
    let spare = ctx.device(3);
    let work = ctx.load(1, &shift, &prefix, &[0, 1, 2]);
    tokio::time::sleep(Duration::from_secs(LOAD_S)).await;
    for cycle in 0..CYCLES {
        let at = cycle % 3;
        let device = ctx.device(at);
        let sim = work.of(at).clone();
        sim.pause().await;
        sim.wait_drained(Duration::from_secs(30)).await?;
        let before = tokens.get(&at).copied().flatten();
        let left = ctx.leave(&device, &shift, before).await?;
        ctx.same(&format!("cycle_{cycle}_leave"), "left", my_state(&left.body));
        if cycle == 0 {
            // A left part's facts are taken like an active one's.
            let made = sim.records_made();
            sim.resume();
            tokio::time::sleep(Duration::from_secs(1)).await;
            sim.pause().await;
            sim.wait_drained(Duration::from_secs(30)).await?;
            let rejected = work.shared.ledger.lock().expect("ledger").rejected.clone();
            ctx.check(Check::new(
                "facts_of_a_left_part_are_accepted",
                sim.records_made() > made && rejected.is_empty(),
                format!(
                    "{} records made while left, rejected {rejected:?}",
                    sim.records_made() - made
                ),
            ));
        }
        // The slot is free: the spare takes it.
        let spare_in = ctx.enter(&spare, &shift, Some(spare.supports())).await?;
        ctx.same(
            &format!("cycle_{cycle}_spare_takes_the_freed_slot"),
            (200u16, "active"),
            (spare_in.status, my_state(&spare_in.body)),
        );
        let spare_token = joined_rev(&spare_in.body, &spare.id);
        // While the spare holds it, the device that left meets a full line.
        let full = ctx.enter(&device, &shift, Some(device.supports())).await?;
        ctx.same(
            &format!("cycle_{cycle}_full_while_the_spare_holds_the_slot"),
            (409u16, Some("shift_line_full")),
            (full.status, constraint(&full)),
        );
        let spare_out = ctx.leave(&spare, &shift, spare_token).await?;
        ctx.same(
            &format!("cycle_{cycle}_spare_leaves"),
            "left",
            my_state(&spare_out.body),
        );
        // The return: a new token.
        let back = ctx.enter(&device, &shift, Some(device.supports())).await?;
        let after = joined_rev(&back.body, &device.id);
        ctx.same(
            &format!("cycle_{cycle}_reenters_with_a_new_token"),
            (200u16, "active", true),
            (back.status, my_state(&back.body), after > before),
        );
        tokens.insert(at, after);
        // A leave carrying the first stay's token: the part stays active and nothing is written.
        let rev_before = ctx.office_shift(&shift).await?["rev"].as_i64();
        let stale = ctx.leave(&device, &shift, before).await?;
        let rev_after = ctx.office_shift(&shift).await?["rev"].as_i64();
        ctx.same(
            &format!("cycle_{cycle}_stale_leave_is_a_no_op"),
            ("active", rev_before),
            (my_state(&stale.body), rev_after),
        );
        sim.resume();
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
    let (shared, devices, drained) = work.stop("").await;
    ctx.checks(drained);
    let office = ctx.office_shift(&shift).await?;
    ctx.same(
        "participants_after_the_cycles",
        4usize,
        super::states(&office).len(),
    );
    let mut expected: Vec<(u32, String, &str)> = (0..3)
        .map(|at| {
            let device = ctx.device(at);
            (device.index, device.id, "active")
        })
        .collect();
    expected.push((spare.index, spare.id.clone(), "left"));
    let pool = ctx.db().await?;
    let joins = super::audit_count(&pool, &shift, "shift.join").await;
    let leaves = super::audit_count(&pool, &shift, "shift.leave").await;
    let states = crate::dbcheck::participants_in(&pool, &shift, &expected).await;
    pool.close().await;
    // The opener's entry is `shift.open`; the two other first entries, the spare's first entry
    // and every return are `shift.join`; a refused entry and a stale leave write nothing.
    ctx.same("audit_joins", Ok(2 + 2 * CYCLES as i64), joins);
    ctx.same("audit_leaves", Ok(2 * CYCLES as i64), leaves);
    match states {
        Ok(checks) => ctx.checks(checks),
        Err(error) => ctx.check(Check::new("db_participants", false, error)),
    }
    // The working parts close first: the spare's left part keeps the shift open.
    let mut receipts = Vec::new();
    for device in &devices {
        receipts.push(device.close_part_ledgered(None, None, None).await?);
    }
    ctx.same(
        "closes_of_the_working_parts_leave_the_left_part_open",
        vec![true; devices.len()],
        receipts.iter().map(part_closed).collect::<Vec<_>>(),
    );
    let last = close_fact(ctx, &spare, &shift, 1, None, 0, 0, None, None).await?;
    ctx.same(
        "the_left_part_closes_the_shift",
        (Some("accepted"), false),
        (last["outcome"].as_str(), part_closed(&last)),
    );
    let found = super::reconcile(ctx, "", &shift, &shared, &devices).await;
    ctx.checks(found);
    Ok(())
}
```

In `src/scenarios/mod.rs`, in `run_one`, add `leave_reenter::NAME => leave_reenter::run(kind, work_dir, profile).await,`. In `src/profile.rs` make `SCENARIOS` `&["line-full", "capability", "leave-reenter"]`.

- [ ] **Step 4: Run the test to verify it passes.**

Run (sandbox off): `cargo --offline --locked test --manifest-path "$WT/apps/standalone/Cargo.toml" -p markiro-loadtest --lib scenarios::leave_reenter -- --nocapture`
Expected: `test result: ok. 1 passed`; `audit_joins` `expected Ok(8), got Ok(8)`, `audit_leaves` `expected Ok(6), got Ok(6)`.

- [ ] **Step 5: Mutation check.** In the stale-leave step, replace `ctx.leave(&device, &shift, before)` with `ctx.leave(&device, &shift, after)` (the current token: a real leave); the test must FAIL naming `cycle_0_stale_leave_is_a_no_op` (the part becomes `left` and the revision moves). Restore; ok.

- [ ] **Step 6: Commit.**

```bash
git -C "$WT" add apps/standalone/loadtest/src/scenarios/leave_reenter.rs apps/standalone/loadtest/src/scenarios/mod.rs apps/standalone/loadtest/src/profile.rs
git -C "$WT" commit -m "feat(loadtest): scenario leave-reenter (pauses and returns under load)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 7: `closed-part` — a closed part that keeps sending, and the last two closers at once

**Files:**

- Create: `apps/standalone/loadtest/src/scenarios/closed_part.rs`
- Modify: `apps/standalone/loadtest/src/scenarios/mod.rs`, `apps/standalone/loadtest/src/profile.rs`

**Interfaces:**

- Consumes: Task 3.
- Produces: the scenario `closed-part`.

**What the host does (E7, `facts::{apply, mark_part_late, close_part}`, `shift_closed::apply`):** a device closes its part while the shift stays active for the others and keeps scanning: its late facts are accepted, counted in its part's and the shift's figures, and its part is marked `lateDataAt` once, never reopened. A second close of the closed part answers `partClosed: true`. The last two open parts close at the same instant: the first to take the write lock closes its part, the second closes the shift; the shift's `closed_at` is the later of the moments the two devices wrote, whoever lands last; with the plan (9 999) away from the total, the closer's reason decides: none → `close_reason_missing` and `reasonMissing: true`, given → `close_reason_code` is the closer's. The order is timing's: the same race runs three more times on small scripted shifts with the moments and reasons swapped, and each outcome must obey the rule.

- [ ] **Step 1: Write the failing test.** Create `src/scenarios/closed_part.rs` holding only:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn the_closed_part_scenario_holds_against_a_host_in_this_process() {
        let work = tempfile::tempdir().unwrap();
        let profile = Profile::preset("tiny").unwrap();
        let (result, _) = run(&HostKind::InProcess, work.path(), &profile).await;
        for check in &result.checks {
            eprintln!("OBSERVED {} {} {}", check.name, check.ok, check.detail);
        }
        eprintln!("OBSERVED {:?}", result.observed);
        assert!(result.judged);
        assert!(
            result.checks.iter().all(|check| check.ok),
            "{:#?}",
            result.checks
        );
        for name in [
            "own_close_closes_only_the_part",
            "late_facts_of_a_closed_part_are_accepted",
            "a_closed_part_stays_closed_and_is_marked_late",
            "late_scans_count_in_the_parts_figure",
            "a_second_close_of_a_closed_part_says_part_closed",
            "exactly_one_close_closes_the_shift",
            "shift_closes_at_the_latest_moment",
            "reason_columns_follow_the_closer",
            "race_2_exactly_one_close_closes_the_shift",
            "db_receipts_device_1",
        ] {
            assert!(
                result.checks.iter().any(|check| check.name == name),
                "no check {name}"
            );
        }
        assert!(result.observed.contains_key("closer"));
    }
}
```

and add `pub mod closed_part;` beside the other modules in `src/scenarios/mod.rs`.

- [ ] **Step 2: Run it to verify it fails.**

Run: `cargo --offline --locked test --manifest-path "$WT/apps/standalone/Cargo.toml" -p markiro-loadtest --lib --no-run`
Expected: FAIL to compile: `cannot find function run in this scope`.

- [ ] **Step 3: Write the scenario.** Put this above the tests module of `src/scenarios/closed_part.rs`:

```rust
//! `closed-part`: a part closed while the shift stays active keeps sending (late facts, accepted,
//! counted, the part marked late, never reopened), and the last two open parts close at the same
//! instant (host `facts::{apply, mark_part_late, close_part}`, `facts/shift_closed.rs::apply`).

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use markiro_proto::FactKind;
use serde_json::{json, Value};

use super::{
    close_record, enter_all, part, part_closed, prefixed, reason_missing, scripted_work,
    shift_row, Ctx, HostKind, Res, LOAD_S,
};
use crate::checks::Check;
use crate::gen;
use crate::profile::Profile;
use crate::report::ScenarioResult;
use crate::site::DeviceSpec;

pub const NAME: &str = "closed-part";
/// The host's plan of every shift here: never the shift's total, so a closer's reason matters.
const PLANNED: u32 = 9_999;
/// The reason the reasoned closer gives.
const REASON: &str = "production_order_changed";
/// Scripted repetitions of the two-closer race.
const RACES: u32 = 3;

pub async fn run(
    kind: &HostKind,
    work_dir: &Path,
    base: &Profile,
) -> (ScenarioResult, Vec<String>) {
    let mut ctx = match Ctx::new(NAME, kind, work_dir, base, 3, 1).await {
        Ok(ctx) => ctx,
        Err(error) => return (super::broken(NAME, error), Vec::new()),
    };
    let outcome = body(&mut ctx).await;
    ctx.finish(outcome).await
}

/// Two closes sent at the same instant, `(device, actual, closedAt ms, reason)` each; their
/// receipts in that order.
async fn race_two(
    ctx: &Ctx,
    shift: &str,
    closes: [(DeviceSpec, u32, i64, Option<&'static str>); 2],
    salt: u64,
) -> Res<Vec<Value>> {
    let barrier = Arc::new(tokio::sync::Barrier::new(2));
    let mut tasks = Vec::new();
    for (device, actual, at_ms, reason) in closes {
        let api = ctx.site.office.api.clone();
        let barrier = barrier.clone();
        let record = close_record(
            shift,
            &device,
            salt,
            Some(PLANNED),
            actual,
            0,
            reason,
            &gen::text_of(at_ms),
        );
        tasks.push(tokio::spawn(async move {
            barrier.wait().await;
            api.facts(&device.key, &[record]).await
        }));
    }
    let mut receipts = Vec::new();
    for task in tasks {
        let mut answer = task.await.map_err(|error| error.to_string())??;
        receipts.push(answer.remove(0));
    }
    Ok(receipts)
}

/// The rules two closes at once must obey, whatever their order.
async fn judge_race(
    ctx: &mut Ctx,
    prefix: &str,
    shift: &str,
    devices: [&DeviceSpec; 2],
    reasons: [Option<&str>; 2],
    moments: [i64; 2],
    receipts: &[Value],
) -> Res<()> {
    let closing: Vec<usize> = (0..2)
        .filter(|at| receipts[*at]["outcome"] == "accepted" && !part_closed(&receipts[*at]))
        .collect();
    ctx.same(
        &format!("{prefix}exactly_one_close_closes_the_shift"),
        1usize,
        closing.len(),
    );
    ctx.same(
        &format!("{prefix}the_other_closes_only_its_part"),
        1usize,
        receipts.iter().filter(|receipt| part_closed(receipt)).count(),
    );
    let Some(&closer) = closing.first() else {
        return Ok(());
    };
    ctx.observe(&format!("{prefix}closer"), json!(devices[closer].index));
    // The plan is never the shift's total here: a closer without a reason leaves it missing.
    let missing = reasons[closer].is_none();
    ctx.same(
        &format!("{prefix}reason_missing_iff_the_closer_gave_none"),
        missing,
        reason_missing(&receipts[closer]),
    );
    let pool = ctx.db().await?;
    let row = shift_row(&pool, shift).await;
    let invariants = crate::dbcheck::participant_invariants(&pool, shift).await;
    pool.close().await;
    let row = row?;
    let latest = moments.iter().copied().max().unwrap_or(0);
    let expected_at = markiro_host::clock::format_timestamp(
        time::OffsetDateTime::from_unix_timestamp(latest.div_euclid(1000))
            .map_err(|error| error.to_string())?,
    );
    ctx.same(
        &format!("{prefix}shift_closed_by_the_closer"),
        (
            "closed".to_owned(),
            Some("device".to_owned()),
            Some(devices[closer].id.clone()),
        ),
        (row.status.clone(), row.closed_by_kind.clone(), row.closed_by.clone()),
    );
    ctx.same(
        &format!("{prefix}shift_closes_at_the_latest_moment"),
        Some(expected_at),
        row.closed_at.clone(),
    );
    ctx.same(
        &format!("{prefix}reason_columns_follow_the_closer"),
        (missing, reasons[closer].map(str::to_owned)),
        (row.close_reason_missing, row.close_reason_code.clone()),
    );
    match invariants {
        Ok(checks) => ctx.checks(prefixed(prefix, checks)),
        Err(error) => ctx.check(Check::new(&format!("{prefix}db_invariants"), false, error)),
    }
    Ok(())
}

async fn body(ctx: &mut Ctx) -> Res<()> {
    let line = ctx.site.line_ids[0].clone();
    let shift = ctx.plan(&line, Some(PLANNED)).await?;
    let prefix = enter_all(ctx, &shift, &[0, 1, 2, 3]).await?;
    let work = ctx.load(1, &shift, &prefix, &[0, 1, 2, 3]);
    tokio::time::sleep(Duration::from_secs(LOAD_S)).await;
    // Device 1 closes its part; the shift stays active for the others.
    let closer = work.of(1).clone();
    closer.seal(Duration::from_secs(60)).await?;
    let first = closer
        .close_part_ledgered(Some(PLANNED), None, None)
        .await?;
    ctx.same(
        "own_close_closes_only_the_part",
        (Some("accepted"), true),
        (first["outcome"].as_str(), part_closed(&first)),
    );
    // Its device keeps scanning: late facts of a closed part.
    let made = closer.records_made();
    closer.resume();
    tokio::time::sleep(Duration::from_secs(2)).await;
    closer.seal(Duration::from_secs(60)).await?;
    let late = closer.records_made() - made;
    ctx.observe("lateRecords", json!(late));
    let rejected = work.shared.ledger.lock().expect("ledger").rejected.clone();
    ctx.check(Check::new(
        "late_facts_of_a_closed_part_are_accepted",
        late > 0 && rejected.is_empty(),
        format!("{late} late records, rejected {rejected:?}"),
    ));
    let office = ctx.office_shift(&shift).await?;
    let closed_id = closer.spec.id.clone();
    ctx.same(
        "a_closed_part_stays_closed_and_is_marked_late",
        (Some("closed"), true),
        (
            part(&office, &closed_id).and_then(|part| part["state"].as_str()),
            part(&office, &closed_id).is_some_and(|part| part["lateDataAt"].is_string()),
        ),
    );
    ctx.same(
        "late_facts_do_not_close_the_shift",
        "active",
        office["status"].as_str().unwrap_or(""),
    );
    let accepted = work
        .shared
        .ledger
        .lock()
        .expect("ledger")
        .accepted_scans
        .get(&1)
        .copied()
        .unwrap_or(0);
    let figure = office["byDevice"]
        .as_array()
        .and_then(|parts| parts.iter().find(|part| part["deviceId"] == json!(closed_id)))
        .and_then(|part| part["accepted"].as_u64());
    ctx.same("late_scans_count_in_the_parts_figure", Some(accepted), figure);
    // A second close of the closed part changes nothing and says so.
    let second = closer
        .close_part_ledgered(Some(PLANNED), None, None)
        .await?;
    ctx.same(
        "a_second_close_of_a_closed_part_says_part_closed",
        (Some("accepted"), true),
        (second["outcome"].as_str(), part_closed(&second)),
    );
    // Device 3 closes; devices 0 and 2 close at the same instant, 0 without a reason and with the
    // later moment, 2 with a reason. Both moments are ahead of every other part's.
    let third = work.of(3).clone();
    third.seal(Duration::from_secs(60)).await?;
    let receipt = third
        .close_part_ledgered(Some(PLANNED), None, None)
        .await?;
    ctx.same("third_close_closes_only_the_part", true, part_closed(&receipt));
    for at in [0usize, 2] {
        work.of(at).seal(Duration::from_secs(60)).await?;
    }
    let actual = |at: u32| -> u32 {
        work.shared
            .ledger
            .lock()
            .expect("ledger")
            .accepted_scans
            .get(&at)
            .copied()
            .unwrap_or(0) as u32
    };
    let (a, b) = (ctx.device(0), ctx.device(2));
    let base_ms = gen::now_ms() + 60_000;
    let moments = [base_ms + 30_000, base_ms];
    let reasons: [Option<&'static str>; 2] = [None, Some(REASON)];
    let receipts = race_two(
        ctx,
        &shift,
        [
            (a.clone(), actual(0), moments[0], reasons[0]),
            (b.clone(), actual(2), moments[1], reasons[1]),
        ],
        1,
    )
    .await?;
    work.of(0).apply_receipt(FactKind::ShiftClosed, &receipts[0]);
    work.of(2).apply_receipt(FactKind::ShiftClosed, &receipts[1]);
    judge_race(ctx, "", &shift, [&a, &b], reasons, moments, &receipts).await?;
    let (shared, devices, drained) = work.stop("").await;
    ctx.checks(drained);
    let found = super::reconcile(ctx, "", &shift, &shared, &devices).await;
    ctx.checks(found);
    // The same race on small scripted shifts, moments and reasons swapped each time.
    for race in 0..RACES {
        let shift = ctx.plan(&line, Some(PLANNED)).await?;
        let issuer = enter_all(ctx, &shift, &[0, 2]).await?;
        scripted_work(ctx, &a, &shift, &issuer, 10 + race, 2).await?;
        scripted_work(ctx, &b, &shift, &issuer, 20 + race, 2).await?;
        let base_ms = gen::now_ms() + 60_000;
        let (moments, reasons): ([i64; 2], [Option<&'static str>; 2]) = if race % 2 == 0 {
            ([base_ms, base_ms + 30_000], [Some(REASON), None])
        } else {
            ([base_ms + 30_000, base_ms], [None, Some(REASON)])
        };
        let receipts = race_two(
            ctx,
            &shift,
            [
                (a.clone(), 2, moments[0], reasons[0]),
                (b.clone(), 2, moments[1], reasons[1]),
            ],
            100 + u64::from(race),
        )
        .await?;
        judge_race(
            ctx,
            &format!("race_{race}_"),
            &shift,
            [&a, &b],
            reasons,
            moments,
            &receipts,
        )
        .await?;
    }
    Ok(())
}
```

In `src/scenarios/mod.rs`, in `run_one`, add `closed_part::NAME => closed_part::run(kind, work_dir, profile).await,`. In `src/profile.rs` make `SCENARIOS` `&["line-full", "capability", "leave-reenter", "closed-part"]`.

- [ ] **Step 4: Run the test to verify it passes.**

Run (sandbox off): `cargo --offline --locked test --manifest-path "$WT/apps/standalone/Cargo.toml" -p markiro-loadtest --lib scenarios::closed_part -- --nocapture`
Expected: `test result: ok. 1 passed`; the observed map names the closer of each race (`closer`, `race_0_closer`, …): which device it is varies from run to run and is not judged.

- [ ] **Step 5: Mutation check.** In `judge_race`, change `let latest = moments.iter().copied().max().unwrap_or(0);` to `.min()`; the test must FAIL naming `shift_closes_at_the_latest_moment` (and its `race_*` twins). Restore. Then change `let missing = reasons[closer].is_none();` to `let missing = reasons[closer].is_some();`; it must FAIL naming `reason_missing_iff_the_closer_gave_none`. Restore; ok.

- [ ] **Step 6: Commit.**

```bash
git -C "$WT" add apps/standalone/loadtest/src/scenarios/closed_part.rs apps/standalone/loadtest/src/scenarios/mod.rs apps/standalone/loadtest/src/profile.rs
git -C "$WT" commit -m "feat(loadtest): scenario closed-part (late facts of a closed part, two closers at once)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 8: `close-races` — N closes at once, the office racing a device

**Files:**

- Create: `apps/standalone/loadtest/src/scenarios/close_races.rs`
- Modify: `apps/standalone/loadtest/src/scenarios/mod.rs`, `apps/standalone/loadtest/src/profile.rs`

**Interfaces:**

- Consumes: Task 3.
- Produces: the scenario `close-races`.

**What the host does (E7, `routes/facts.rs`, `close_part`, `routes/office_shifts.rs::close_shift`):** six devices close at the same instant: exactly one receipt closes the shift, five close their parts; one `shift.close`, five `shift.part_closed`, six accepted close events. The office's close (read revision, then `POST …/close` with `expectedRev`) racing a device's close of its part, four times: office first (200; the device's receipt `alreadyClosed: true`; its part closed by `office_user`) or device first (the office `409 stale_revision`; the part closed by the device; the shift active until the office closes it on a fresh read). Nothing else is allowed.

- [ ] **Step 1: Write the failing test.** Create `src/scenarios/close_races.rs` holding only:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn the_close_races_scenario_holds_against_a_host_in_this_process() {
        let work = tempfile::tempdir().unwrap();
        let profile = Profile::preset("tiny").unwrap();
        let (result, _) = run(&HostKind::InProcess, work.path(), &profile).await;
        for check in &result.checks {
            eprintln!("OBSERVED {} {} {}", check.name, check.ok, check.detail);
        }
        eprintln!("OBSERVED {:?}", result.observed);
        assert!(result.judged);
        assert!(
            result.checks.iter().all(|check| check.ok),
            "{:#?}",
            result.checks
        );
        for name in [
            "n_closes_at_once_exactly_one_closes_the_shift",
            "n_closes_at_once_one_shift_close_row",
            "n_closes_at_once_part_rows",
            "race_0_one_of_the_two_orders",
            "race_3_one_of_the_two_orders",
            "race_3_one_forced_close_row",
            "race_3_close_events_match_device_closed_parts",
            "close_events_match_device_closed_parts",
        ] {
            assert!(
                result.checks.iter().any(|check| check.name == name),
                "no check {name}"
            );
        }
        assert!(result.observed.contains_key("orders"));
    }
}
```

and add `pub mod close_races;` beside the other modules in `src/scenarios/mod.rs`.

- [ ] **Step 2: Run it to verify it fails.**

Run: `cargo --offline --locked test --manifest-path "$WT/apps/standalone/Cargo.toml" -p markiro-loadtest --lib --no-run`
Expected: FAIL to compile: `cannot find function run in this scope`.

- [ ] **Step 3: Write the scenario.** Put this above the tests module of `src/scenarios/close_races.rs`:

```rust
//! `close-races`: six devices close at the same instant, and the office's close of the whole
//! shift races a device's close of its part (host `routes/facts.rs`, `facts::close_part`,
//! `routes/office_shifts.rs::close_shift`: every close in `BEGIN IMMEDIATE`, every part close
//! stamping the shift's revision, the office's close over `expectedRev`).

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use serde_json::json;

use super::{
    already_closed, audit_count, close_record, enter_all, error_code, part, part_closed,
    prefixed, scripted_work, Ctx, HostKind, Res, LOAD_S,
};
use crate::checks::Check;
use crate::gen;
use crate::profile::Profile;
use crate::report::ScenarioResult;

pub const NAME: &str = "close-races";
/// Office-against-device races, each on a shift of its own.
const RACES: u32 = 4;

pub async fn run(
    kind: &HostKind,
    work_dir: &Path,
    base: &Profile,
) -> (ScenarioResult, Vec<String>) {
    let mut ctx = match Ctx::new(NAME, kind, work_dir, base, 4, 2).await {
        Ok(ctx) => ctx,
        Err(error) => return (super::broken(NAME, error), Vec::new()),
    };
    let outcome = body(&mut ctx).await;
    ctx.finish(outcome).await
}

async fn body(ctx: &mut Ctx) -> Res<()> {
    let line = ctx.site.line_ids[0].clone();
    // N closes at once.
    let shift = ctx.plan(&line, None).await?;
    let all: Vec<usize> = (0..ctx.site.devices.len()).collect();
    let prefix = enter_all(ctx, &shift, &all).await?;
    let work = ctx.load(1, &shift, &prefix, &all);
    tokio::time::sleep(Duration::from_secs(LOAD_S)).await;
    for device in &work.devices {
        device.seal(Duration::from_secs(60)).await?;
    }
    let barrier = Arc::new(tokio::sync::Barrier::new(work.devices.len()));
    let mut tasks = Vec::new();
    for device in &work.devices {
        let (device, barrier) = (device.clone(), barrier.clone());
        tasks.push(tokio::spawn(async move {
            barrier.wait().await;
            device.close_part_ledgered(None, None, None).await
        }));
    }
    let mut receipts = Vec::new();
    for task in tasks {
        receipts.push(task.await.map_err(|error| error.to_string())??);
    }
    let n = work.devices.len();
    ctx.same(
        "n_closes_at_once_exactly_one_closes_the_shift",
        1usize,
        receipts
            .iter()
            .filter(|receipt| receipt["outcome"] == "accepted" && !part_closed(receipt))
            .count(),
    );
    ctx.same(
        "n_closes_at_once_the_others_close_their_parts",
        n - 1,
        receipts.iter().filter(|receipt| part_closed(receipt)).count(),
    );
    let office = ctx.office_shift(&shift).await?;
    ctx.same(
        "n_closes_at_once_status",
        "closed",
        office["status"].as_str().unwrap_or(""),
    );
    let pool = ctx.db().await?;
    let closes = audit_count(&pool, &shift, "shift.close").await;
    let parts = audit_count(&pool, &shift, "shift.part_closed").await;
    pool.close().await;
    ctx.same("n_closes_at_once_one_shift_close_row", Ok(1), closes);
    ctx.same("n_closes_at_once_part_rows", Ok(n as i64 - 1), parts);
    let (shared, devices, drained) = work.stop("").await;
    ctx.checks(drained);
    let found = super::reconcile(ctx, "", &shift, &shared, &devices).await;
    ctx.checks(found);
    // The office against a device, on fresh shifts of three participants.
    let mut orders: BTreeMap<&str, u32> = BTreeMap::new();
    let racer = ctx.device(1);
    for race in 0..RACES {
        let p = format!("race_{race}_");
        let shift = ctx.plan(&line, None).await?;
        let issuer = enter_all(ctx, &shift, &[0, 1, 2]).await?;
        scripted_work(ctx, &racer, &shift, &issuer, 10 + race, 2).await?;
        let rev = ctx.office_shift(&shift).await?["rev"].clone();
        let barrier = Arc::new(tokio::sync::Barrier::new(2));
        let office = ctx.site.office.clone();
        let close_path = format!("/v1/office/shifts/{shift}/close");
        let office_task = {
            let barrier = barrier.clone();
            tokio::spawn(async move {
                barrier.wait().await;
                office
                    .call(
                        "POST",
                        &close_path,
                        Some(json!({ "reason": "Нагрузочная проверка: гонка закрытий", "expectedRev": rev })),
                    )
                    .await
            })
        };
        let record = close_record(
            &shift,
            &racer,
            200 + u64::from(race),
            None,
            2,
            1,
            None,
            &gen::text_of(gen::now_ms()),
        );
        let api = ctx.site.office.api.clone();
        let key = racer.key.clone();
        let device_task = {
            let barrier = barrier.clone();
            tokio::spawn(async move {
                barrier.wait().await;
                api.facts(&key, &[record]).await
            })
        };
        let office_reply = office_task.await.map_err(|error| error.to_string())??;
        let receipt = device_task
            .await
            .map_err(|error| error.to_string())??
            .remove(0);
        let view = ctx.office_shift(&shift).await?;
        let racer_part = part(&view, &racer.id).map(|part| {
            (
                part["state"].as_str().unwrap_or("").to_owned(),
                part["closedBy"].as_str().unwrap_or("").to_owned(),
            )
        });
        let order = match (
            office_reply.status,
            error_code(&office_reply),
            already_closed(&receipt),
            part_closed(&receipt),
        ) {
            (200, _, true, false) => "office-first",
            (409, Some("stale_revision"), false, true) => "device-first",
            _ => "neither",
        };
        *orders.entry(order).or_insert(0) += 1;
        ctx.check(Check::new(
            &format!("{p}one_of_the_two_orders"),
            order != "neither",
            format!(
                "office {} {}, device receipt {receipt}",
                office_reply.status, office_reply.body
            ),
        ));
        match order {
            "office-first" => {
                ctx.same(
                    &format!("{p}office_first_closes_the_racing_part_as_the_offices"),
                    Some(("closed".to_owned(), "office_user".to_owned())),
                    racer_part,
                );
                ctx.same(
                    &format!("{p}office_first_status"),
                    "closed",
                    view["status"].as_str().unwrap_or(""),
                );
            }
            "device-first" => {
                ctx.same(
                    &format!("{p}device_first_keeps_the_devices_own_close"),
                    Some(("closed".to_owned(), "device".to_owned())),
                    racer_part,
                );
                ctx.same(
                    &format!("{p}device_first_shift_stays_active"),
                    "active",
                    view["status"].as_str().unwrap_or(""),
                );
                let retried = ctx
                    .office_close(&shift, "Нагрузочная проверка: повтор после гонки")
                    .await?;
                ctx.same(&format!("{p}device_first_the_office_retries"), 200u16, retried.status);
            }
            _ => {}
        }
        let pool = ctx.db().await?;
        let forced = audit_count(&pool, &shift, "shift.force_closed").await;
        let invariants = crate::dbcheck::participant_invariants(&pool, &shift).await;
        pool.close().await;
        if order != "neither" {
            ctx.same(&format!("{p}one_forced_close_row"), Ok(1), forced);
        }
        match invariants {
            Ok(checks) => ctx.checks(prefixed(&p, checks)),
            Err(error) => ctx.check(Check::new(&format!("{p}db_invariants"), false, error)),
        }
    }
    ctx.observe("orders", json!(orders));
    Ok(())
}
```

In `src/scenarios/mod.rs`, in `run_one`, add `close_races::NAME => close_races::run(kind, work_dir, profile).await,`. In `src/profile.rs` make `SCENARIOS` `&["line-full", "capability", "leave-reenter", "closed-part", "close-races"]`.

- [ ] **Step 4: Run the test to verify it passes.**

Run (sandbox off): `cargo --offline --locked test --manifest-path "$WT/apps/standalone/Cargo.toml" -p markiro-loadtest --lib scenarios::close_races -- --nocapture`
Expected: `test result: ok. 1 passed`; `OBSERVED {"orders": {…}}` with counts adding up to 4 (`office-first` and `device-first` in any split; `neither` never).

A `neither` outcome is a host finding (for example an office 200 while the device's receipt says `partClosed`): report the check's detail, which holds both answers.

- [ ] **Step 5: Mutation check.** Change the arm `(409, Some("stale_revision"), false, true) => "device-first",` to `(409, Some("stale_revision"), true, false) => "device-first",`; if any race of the run went device first the test FAILS (`race_N_one_of_the_two_orders`); if every race went office first this mutation is invisible, so also change `(200, _, true, false) => "office-first",` to `(200, _, false, true) => "office-first",` and the test must FAIL. Restore both; ok.

- [ ] **Step 6: Commit.**

```bash
git -C "$WT" add apps/standalone/loadtest/src/scenarios/close_races.rs apps/standalone/loadtest/src/scenarios/mod.rs apps/standalone/loadtest/src/profile.rs
git -C "$WT" commit -m "feat(loadtest): scenario close-races (N closes at once, office against device)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 9: `lines` — three lines, three shifts, different limits, at once

**Files:**

- Create: `apps/standalone/loadtest/src/scenarios/lines.rs`
- Modify: `apps/standalone/loadtest/src/scenarios/mod.rs`, `apps/standalone/loadtest/src/profile.rs`

**Interfaces:**

- Consumes: Task 3.
- Produces: the scenario `lines`.

**What the host does (E7, `enter_shift`, `list_device_shifts`, `facts::apply`, `facts/registry.rs::claim`, `shift_totals`):** line 1 (limit 2: stations 0, 1), line 2 (limit 3: stations 2, 3 and handheld 4), line 3 (limit 1: handheld 5) each work a shift under load at the same time. A device entering another line's shift is `conflict` on `shift_line`; a device lists only its line's open shifts (and those it entered); a fact for a shift the device never entered is `rejected` / `not_entered` (its receipt names no shift, so it touches no shift's figures). Each shift's totals and `byDevice` are its own and reconcile with its own ledger. The registry is the site's: a later scan of a code line 1's shift owns, sent into line 2's shift, is a `conflict` naming line 1's shift; an earlier one takes the code and moves it (line 1's total gains the first code only, line 2's gains the second). Closing one line's shift leaves the others active; line 3's one-device shift closes by stage 2a's rule.

- [ ] **Step 1: Write the failing test.** Create `src/scenarios/lines.rs` holding only:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn the_lines_scenario_holds_against_a_host_in_this_process() {
        let work = tempfile::tempdir().unwrap();
        let profile = Profile::preset("tiny").unwrap();
        let (result, _) = run(&HostKind::InProcess, work.path(), &profile).await;
        for check in &result.checks {
            eprintln!("OBSERVED {} {} {}", check.name, check.ok, check.detail);
        }
        assert!(result.judged);
        assert!(
            result.checks.iter().all(|check| check.ok),
            "{:#?}",
            result.checks
        );
        for name in [
            "entry_into_another_lines_shift_is_refused",
            "a_device_lists_only_its_lines_open_shifts",
            "a_fact_for_a_shift_not_entered_is_rejected",
            "shift_0_db_code_owners",
            "shift_1_by_device_names_only_its_devices",
            "shift_2_office_units_are_this_shifts_own",
            "a_later_scan_on_another_line_is_a_conflict_naming_the_owner_shift",
            "totals_follow_the_owner_shift",
            "the_code_moved_to_the_earlier_scans_shift",
            "closing_shift_2_leaves_shift_0_active",
            "shift_0_closed_by_its_last_part",
        ] {
            assert!(
                result.checks.iter().any(|check| check.name == name),
                "no check {name}"
            );
        }
    }
}
```

and add `pub mod lines;` beside the other modules in `src/scenarios/mod.rs`.

- [ ] **Step 2: Run it to verify it fails.**

Run: `cargo --offline --locked test --manifest-path "$WT/apps/standalone/Cargo.toml" -p markiro-loadtest --lib --no-run`
Expected: FAIL to compile: `cannot find function run in this scope`.

- [ ] **Step 3: Write the scenario.** Put this above the tests module of `src/scenarios/lines.rs`:

```rust
//! `lines`: three lines with different limits, each with its shared shift under load at the same
//! time. Nothing leaks between them but what the host shares on purpose: the registry of codes is
//! the site's, the totals are each shift's (host `enter_shift`, `list_device_shifts`,
//! `facts::apply`, `facts/registry.rs::claim`, `shift_totals`).

use std::path::Path;
use std::time::Duration;

use markiro_proto::FactKind;
use serde_json::Value;

use super::{
    constraint, enter_all, part_closed, prefixed, scripted_scan, Ctx, HostKind, Load, Res, LOAD_S,
};
use crate::checks::Check;
use crate::gen;
use crate::metrics::Route;
use crate::profile::Profile;
use crate::report::ScenarioResult;
use crate::rng::Rng;

pub const NAME: &str = "lines";
/// (line index, its limit, its devices).
const LAYOUT: [(usize, u32, &[usize]); 3] = [(0, 2, &[0, 1]), (1, 3, &[2, 3, 4]), (2, 1, &[5])];

pub async fn run(
    kind: &HostKind,
    work_dir: &Path,
    base: &Profile,
) -> (ScenarioResult, Vec<String>) {
    let mut ctx = match Ctx::new(NAME, kind, work_dir, base, 4, 2).await {
        Ok(ctx) => ctx,
        Err(error) => return (super::broken(NAME, error), Vec::new()),
    };
    let outcome = body(&mut ctx).await;
    ctx.finish(outcome).await
}

/// A shift's accepted units as the office reads them.
async fn units(ctx: &Ctx, shift: &str) -> Res<u64> {
    ctx.office_shift(shift)
        .await?
        .pointer("/totals/acceptedUnits")
        .and_then(Value::as_u64)
        .ok_or_else(|| format!("no acceptedUnits for {shift}"))
}

async fn body(ctx: &mut Ctx) -> Res<()> {
    for (line_at, max, members) in LAYOUT {
        let line = ctx.site.line_ids[line_at].clone();
        if line_at != 0 {
            for at in members {
                let device = ctx.device(*at);
                ctx.move_to_line(&device, &line).await?;
            }
        }
        let set = ctx.set_max_stations(&line, max).await?;
        ctx.same(&format!("line_{line_at}_limit_set"), 200u16, set.status);
    }
    let mut shifts: Vec<String> = Vec::new();
    let mut loads: Vec<Load> = Vec::new();
    for (k, (line_at, _, members)) in LAYOUT.into_iter().enumerate() {
        let line = ctx.site.line_ids[line_at].clone();
        let shift = ctx.plan(&line, None).await?;
        let prefix = enter_all(ctx, &shift, members).await?;
        loads.push(ctx.load(1 + k as u32, &shift, &prefix, members));
        shifts.push(shift);
    }
    tokio::time::sleep(Duration::from_secs(LOAD_S)).await;
    // While the three loads run: nothing crosses a line.
    let first = ctx.device(0);
    let foreign = ctx
        .enter(&first, &shifts[1], Some(first.supports()))
        .await?;
    ctx.same(
        "entry_into_another_lines_shift_is_refused",
        (409u16, Some("shift_line")),
        (foreign.status, constraint(&foreign)),
    );
    let lone = ctx.device(5);
    let list = ctx
        .send(&lone, Route::DeviceShifts, "GET", "/v1/device/shifts", None)
        .await?;
    let listed: Vec<String> = list.body["shifts"]
        .as_array()
        .map(|all| {
            all.iter()
                .filter(|item| item["status"] != "closed")
                .filter_map(|item| item["id"].as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default();
    ctx.same(
        "a_device_lists_only_its_lines_open_shifts",
        vec![shifts[2].clone()],
        listed,
    );
    let mut rng = Rng::new(ctx.profile.seed ^ 0x11E5);
    let stray = gen::record(
        &rng.uuid(),
        FactKind::Scan,
        &shifts[1],
        gen::scan_ok(
            &gen::Code::new(900, 0, 1),
            &rng.uuid(),
            &gen::text_of(gen::now_ms()),
        ),
    );
    let receipts = ctx.site.office.api.facts(&first.key, &[stray]).await?;
    ctx.same(
        "a_fact_for_a_shift_not_entered_is_rejected",
        (Some("rejected"), Some("not_entered")),
        (receipts[0]["outcome"].as_str(), receipts[0]["code"].as_str()),
    );
    tokio::time::sleep(Duration::from_secs(LOAD_S)).await;
    // Each shift is its own: exact against its own ledger, its totals and parts its own.
    let mut stopped = Vec::new();
    for (k, load) in loads.into_iter().enumerate() {
        let (shared, devices, drained) = load.stop(&format!("shift_{k}_")).await;
        ctx.checks(drained);
        stopped.push((shared, devices));
    }
    for (k, (shared, devices)) in stopped.iter().enumerate() {
        let p = format!("shift_{k}_");
        let found = super::reconcile(ctx, &p, &shifts[k], shared, devices).await;
        ctx.checks(found);
        let view = ctx.office_shift(&shifts[k]).await?;
        let expected = shared
            .ledger
            .lock()
            .expect("ledger")
            .expected()
            .distinct_accepted_codes;
        ctx.same(
            &format!("{p}office_units_are_this_shifts_own"),
            Some(expected),
            view.pointer("/totals/acceptedUnits").and_then(Value::as_u64),
        );
        let mut named: Vec<String> = view["byDevice"]
            .as_array()
            .map(|parts| {
                parts
                    .iter()
                    .filter_map(|part| part["deviceId"].as_str().map(str::to_owned))
                    .collect()
            })
            .unwrap_or_default();
        named.sort();
        let mut own: Vec<String> = devices.iter().map(|device| device.spec.id.clone()).collect();
        own.sort();
        ctx.same(&format!("{p}by_device_names_only_its_devices"), own, named);
    }
    // The registry is the site's: scripted scans of two fresh codes across lines 1 and 2.
    let other = ctx.device(2);
    let before = (units(ctx, &shifts[0]).await?, units(ctx, &shifts[1]).await?);
    let at = gen::now_ms() - 120_000;
    let late = gen::Code::new(901, 0, 1);
    let owner = scripted_scan(ctx, &first, &shifts[0], &late, at, 1).await?;
    let loser = scripted_scan(ctx, &other, &shifts[1], &late, at + 10_000, 2).await?;
    ctx.same(
        "the_first_scan_owns_the_code",
        Some("accepted"),
        owner["outcome"].as_str(),
    );
    ctx.same(
        "a_later_scan_on_another_line_is_a_conflict_naming_the_owner_shift",
        (Some("conflict"), Some(shifts[0].as_str())),
        (
            loser["outcome"].as_str(),
            loser
                .pointer("/details/winner/shiftId")
                .and_then(Value::as_str),
        ),
    );
    let early = gen::Code::new(901, 0, 2);
    let owner = scripted_scan(ctx, &first, &shifts[0], &early, at + 20_000, 3).await?;
    let taker = scripted_scan(ctx, &other, &shifts[1], &early, at, 4).await?;
    ctx.same(
        "an_earlier_scan_on_another_line_takes_the_code",
        (Some("accepted"), Some("accepted")),
        (owner["outcome"].as_str(), taker["outcome"].as_str()),
    );
    let after = (units(ctx, &shifts[0]).await?, units(ctx, &shifts[1]).await?);
    // Line 1's shift gained `late` and gained then lost `early`; line 2's gained `early`.
    ctx.same(
        "totals_follow_the_owner_shift",
        (before.0 + 1, before.1 + 1),
        after,
    );
    let pool = ctx.db().await?;
    let owned: Result<Option<String>, String> =
        sqlx::query_scalar("SELECT shift_id FROM code_owners WHERE code_hash = ?")
            .bind(&early.hash)
            .fetch_optional(&pool)
            .await
            .map_err(|error| error.to_string());
    pool.close().await;
    ctx.same(
        "the_code_moved_to_the_earlier_scans_shift",
        Ok(Some(shifts[1].clone())),
        owned,
    );
    // Each shift closed by its own devices, line 3's first: the others stay active.
    for k in (0..shifts.len()).rev() {
        let (_, devices) = &stopped[k];
        let mut last = None;
        for device in devices {
            last = Some(device.close_part_ledgered(None, None, None).await?);
        }
        ctx.same(
            &format!("shift_{k}_closed_by_its_last_part"),
            Some(false),
            last.as_ref().map(part_closed),
        );
        for (j, other_shift) in shifts.iter().enumerate().take(k) {
            let view = ctx.office_shift(other_shift).await?;
            ctx.same(
                &format!("closing_shift_{k}_leaves_shift_{j}_active"),
                "active",
                view["status"].as_str().unwrap_or(""),
            );
        }
        let pool = ctx.db().await?;
        let invariants = crate::dbcheck::participant_invariants(&pool, &shifts[k]).await;
        pool.close().await;
        match invariants {
            Ok(checks) => ctx.checks(prefixed(&format!("shift_{k}_closed_"), checks)),
            Err(error) => ctx.check(Check::new(&format!("shift_{k}_db_invariants"), false, error)),
        }
    }
    Ok(())
}
```

In `src/scenarios/mod.rs`, in `run_one`, add `lines::NAME => lines::run(kind, work_dir, profile).await,`. In `src/profile.rs` make `SCENARIOS` `&["line-full", "capability", "leave-reenter", "closed-part", "close-races", "lines"]`.

- [ ] **Step 4: Run the test to verify it passes.**

Run (sandbox off): `cargo --offline --locked test --manifest-path "$WT/apps/standalone/Cargo.toml" -p markiro-loadtest --lib scenarios::lines -- --nocapture`
Expected: `test result: ok. 1 passed`.

- [ ] **Step 5: Mutation check.** Change the expected value of `totals_follow_the_owner_shift` to `(before.0 + 2, before.1 + 1)` (as if the earlier scan had not displaced line 1's owner); the test must FAIL naming it. Restore; ok.

- [ ] **Step 6: Commit.**

```bash
git -C "$WT" add apps/standalone/loadtest/src/scenarios/lines.rs apps/standalone/loadtest/src/scenarios/mod.rs apps/standalone/loadtest/src/profile.rs
git -C "$WT" commit -m "feat(loadtest): scenario lines (three lines and shifts at once, the site's registry)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 10: `backup-mid-close` — a copy taken while the parts close

**Files:**

- Create: `apps/standalone/loadtest/src/scenarios/backup_mid_close.rs`
- Modify: `apps/standalone/loadtest/src/scenarios/mod.rs`, `apps/standalone/loadtest/src/profile.rs`

**Interfaces:**

- Consumes: Task 3, `probes::{backup, restore_roundtrip}`, `markiro_host::restore::restore_now`.
- Produces: the scenario `backup-mid-close`.

**What the host does:** `POST /v1/office/backups` makes a copy with the backup worker's own connection (`VACUUM INTO`, `backup/worker.rs`): a consistent snapshot at one moment. Six devices close their parts one after another, 40 ms apart, while the copy runs: the copy holds some number k of closed parts (0 to 6; recorded, not judged) and must be consistent: every participant `active` or `closed`, the participant invariants (Task 2), the structural checks, the backup bounds of `probes::backup`. Restored into a folder of its own, it passes the same checks, and a host started on it answers the copy's participant states. A last copy at rest is restored by `probes::restore_roundtrip` (nine tables equal, the shift's total answered).

- [ ] **Step 1: Write the failing test.** Create `src/scenarios/backup_mid_close.rs` holding only:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    // Restoring a copy the backup worker may still hold (`os error 32`) is unverified on Windows
    // (runbook §14).
    #[cfg_attr(windows, ignore = "os error 32 on a held copy is unverified on Windows")]
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn the_backup_mid_close_scenario_holds_against_a_host_in_this_process() {
        let work = tempfile::tempdir().unwrap();
        let profile = Profile::preset("tiny").unwrap();
        let (result, _) = run(&HostKind::InProcess, work.path(), &profile).await;
        for check in &result.checks {
            eprintln!("OBSERVED {} {} {}", check.name, check.ok, check.detail);
        }
        eprintln!("OBSERVED {:?}", result.observed);
        assert!(result.judged);
        assert!(
            result.checks.iter().all(|check| check.ok),
            "{:#?}",
            result.checks
        );
        for name in [
            "exactly_one_close_closes_the_shift",
            "copy_backup_scans_between_the_acknowledged_and_the_sent",
            "copy_states_are_active_or_closed",
            "copy_closed_shift_has_no_open_part",
            "copy_db_integrity",
            "mid_close_copy_restores",
            "restored_states_are_the_copys",
            "restored_host_answers_the_copys_participant_states",
            "restore_restore_rows_scans",
            "restore_restore_host_answers_the_shift_total",
        ] {
            assert!(
                result.checks.iter().any(|check| check.name == name),
                "no check {name}"
            );
        }
        assert!(result.observed.contains_key("partsClosedInTheCopy"));
    }
}
```

and add `pub mod backup_mid_close;` beside the other modules in `src/scenarios/mod.rs`.

- [ ] **Step 2: Run it to verify it fails.**

Run: `cargo --offline --locked test --manifest-path "$WT/apps/standalone/Cargo.toml" -p markiro-loadtest --lib --no-run`
Expected: FAIL to compile: `cannot find function run in this scope`.

- [ ] **Step 3: Write the scenario.** Put this above the tests module of `src/scenarios/backup_mid_close.rs`:

```rust
//! `backup-mid-close`: a copy asked for while six parts close one after another is a consistent
//! snapshot of the closes (the backup worker's `VACUUM INTO` on its own connection); restored, it
//! passes the same checks and a host on it answers the same states. A last copy at rest restores
//! whole.

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use markiro_host::config::HostPaths;
use markiro_host::restore::{restore_now, IdentityChoice, RestoreOptions};
use serde_json::{json, Value};

use super::{enter_all, part_closed, prefixed, Ctx, HostKind, Res, LOAD_S};
use crate::api::{Api, Auth};
use crate::checks::Check;
use crate::dbcheck;
use crate::device::SimDevice;
use crate::host::Host;
use crate::metrics::Route;
use crate::profile::Profile;
use crate::report::ScenarioResult;

pub const NAME: &str = "backup-mid-close";

pub async fn run(
    kind: &HostKind,
    work_dir: &Path,
    base: &Profile,
) -> (ScenarioResult, Vec<String>) {
    let mut ctx = match Ctx::new(NAME, kind, work_dir, base, 4, 2).await {
        Ok(ctx) => ctx,
        Err(error) => return (super::broken(NAME, error), Vec::new()),
    };
    let outcome = body(&mut ctx).await;
    ctx.finish(outcome).await
}

async fn body(ctx: &mut Ctx) -> Res<()> {
    let line = ctx.site.line_ids[0].clone();
    let shift = ctx.plan(&line, None).await?;
    let all: Vec<usize> = (0..ctx.site.devices.len()).collect();
    let prefix = enter_all(ctx, &shift, &all).await?;
    let work = ctx.load(1, &shift, &prefix, &all);
    tokio::time::sleep(Duration::from_secs(LOAD_S)).await;
    for device in &work.devices {
        device.seal(Duration::from_secs(60)).await?;
    }
    let data_dir = ctx
        .host
        .data_dir
        .clone()
        .ok_or("the scenario host has no data folder")?;
    // The closes go out one after another while a copy is asked for.
    let closers: Vec<Arc<SimDevice>> = work.devices.clone();
    let closing = tokio::spawn(async move {
        let mut receipts = Vec::new();
        for device in closers {
            receipts.push(device.close_part_ledgered(None, None, None).await);
            tokio::time::sleep(Duration::from_millis(40)).await;
        }
        receipts
    });
    let copy = crate::probes::backup(&ctx.site.office, &data_dir, &work.shared, 0.5, 0).await;
    let receipts: Vec<Value> = closing
        .await
        .map_err(|error| error.to_string())?
        .into_iter()
        .collect::<Res<Vec<Value>>>()?;
    ctx.same(
        "exactly_one_close_closes_the_shift",
        1usize,
        receipts
            .iter()
            .filter(|receipt| receipt["outcome"] == "accepted" && !part_closed(receipt))
            .count(),
    );
    let (result, path) = copy?;
    ctx.checks(prefixed("copy_", result.checks.clone()));
    if !result.file.is_empty() {
        let pool = dbcheck::open_read_only(&path, true).await?;
        let states = dbcheck::participant_states(&pool, &shift).await;
        let invariants = dbcheck::participant_invariants(&pool, &shift).await;
        pool.close().await;
        let states = states?;
        let closed = states.values().filter(|state| *state == "closed").count();
        ctx.observe("partsClosedInTheCopy", json!(closed));
        ctx.check(Check::new(
            "copy_states_are_active_or_closed",
            states.len() == work.devices.len()
                && states
                    .values()
                    .all(|state| state == "active" || state == "closed"),
            format!("{states:?}"),
        ));
        match invariants {
            Ok(checks) => ctx.checks(prefixed("copy_", checks)),
            Err(error) => ctx.check(Check::new("copy_db_invariants", false, error)),
        }
        // The copy restored into a folder of its own, and a host started on it.
        let restored = ctx.dir.join("restored-mid-close");
        let done = match restore_now(
            &HostPaths::new(&restored),
            &path,
            RestoreOptions {
                without_manifest: false,
                identity: IdentityChoice::Auto,
            },
        )
        .await
        {
            Ok(_) => Ok(()),
            Err(error) => Err(error.to_string()),
        };
        ctx.check(Check::new(
            "mid_close_copy_restores",
            done.is_ok(),
            format!("{done:?}"),
        ));
        if done.is_ok() {
            let pool =
                dbcheck::open_read_only(&HostPaths::new(&restored).database_file(), true).await?;
            let again = dbcheck::participant_states(&pool, &shift).await;
            let invariants = dbcheck::participant_invariants(&pool, &shift).await;
            pool.close().await;
            let again = again?;
            ctx.same("restored_states_are_the_copys", states.clone(), again.clone());
            match invariants {
                Ok(checks) => ctx.checks(prefixed("restored_", checks)),
                Err(error) => ctx.check(Check::new("restored_db_invariants", false, error)),
            }
            let mut host = Host::in_process(&restored)
                .await
                .map_err(|error| error.to_string())?;
            let api = Api::new(&host.base, &host.fingerprint, ctx.metrics.clone());
            let device = ctx.device(0);
            let listed = api
                .send(
                    Route::DeviceShifts,
                    "GET",
                    "/v1/device/shifts",
                    Auth {
                        device_key: Some(&device.key),
                        session: None,
                    },
                    None,
                )
                .await;
            host.stop().await.map_err(|error| error.to_string())?;
            let answered: BTreeMap<String, String> = listed
                .ok()
                .and_then(|reply| {
                    reply.body["shifts"]
                        .as_array()
                        .and_then(|all| all.iter().find(|item| item["id"] == json!(shift)).cloned())
                })
                .map(|seen| super::states(&seen))
                .unwrap_or_default();
            ctx.same(
                "restored_host_answers_the_copys_participant_states",
                again,
                answered,
            );
        }
    }
    let (shared, devices, drained) = work.stop("").await;
    ctx.checks(drained);
    let found = super::reconcile(ctx, "", &shift, &shared, &devices).await;
    ctx.checks(found);
    // A last copy at rest, restored whole.
    let expected = shared
        .ledger
        .lock()
        .expect("ledger")
        .expected()
        .distinct_accepted_codes;
    let (last, last_path) =
        crate::probes::backup(&ctx.site.office, &data_dir, &shared, 1.0, 0).await?;
    ctx.checks(prefixed("last_copy_", last.checks.clone()));
    ctx.host.stop().await.map_err(|error| error.to_string())?;
    if !last.file.is_empty() {
        let key = ctx.device(0).key;
        let restored = crate::probes::restore_roundtrip(
            &data_dir,
            &last_path,
            &ctx.dir,
            &key,
            &shift,
            expected,
            ctx.metrics.clone(),
        )
        .await?;
        ctx.checks(prefixed("restore_", restored.checks));
    }
    Ok(())
}
```

In `src/scenarios/mod.rs`, in `run_one`, add `backup_mid_close::NAME => backup_mid_close::run(kind, work_dir, profile).await,`. In `src/profile.rs` make `SCENARIOS` `&["line-full", "capability", "leave-reenter", "closed-part", "close-races", "lines", "backup-mid-close"]`.

- [ ] **Step 4: Run the test to verify it passes.**

Run (sandbox off): `cargo --offline --locked test --manifest-path "$WT/apps/standalone/Cargo.toml" -p markiro-loadtest --lib scenarios::backup_mid_close -- --nocapture`
Expected: `test result: ok. 1 passed`; `OBSERVED {"partsClosedInTheCopy": k}` with k between 0 and 6 (where the snapshot fell; not judged). If k is 0 or 6 in three runs out of three, the copy never fell inside the closes on this machine: record it in the report of the task (the checks still hold, but «mid-close» was not exercised) and try `40` → `150` ms between closes locally to see whether k moves; do not commit a change to the interval without saying why.

- [ ] **Step 5: Mutation check.** Change `states.values().all(|state| state == "active" || state == "closed")` to `states.values().all(|state| state == "active")`; the test FAILS when k > 0 (if k was 0 in that run, rerun). Restore; ok.

- [ ] **Step 6: Commit.**

```bash
git -C "$WT" add apps/standalone/loadtest/src/scenarios/backup_mid_close.rs apps/standalone/loadtest/src/scenarios/mod.rs apps/standalone/loadtest/src/profile.rs
git -C "$WT" commit -m "feat(loadtest): scenario backup-mid-close (a copy inside the closes, restored)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Process faults on a spawned host — `kill-restart` and `outage`

**Files:**

- Create: `apps/standalone/loadtest/src/scenarios/kill_restart.rs`, `apps/standalone/loadtest/src/scenarios/outage.rs`
- Modify: `apps/standalone/loadtest/src/host.rs`, `apps/standalone/loadtest/src/scenarios/mod.rs`, `apps/standalone/loadtest/src/profile.rs`

**Interfaces:**

- Consumes: Task 3 (`Host::stop` guard, `Ctx`, `Load`), Task 2 (`SimDevice::set_online`).
- Produces: `Host::{spawned_on(bin, data_dir, log, port, append), port(), kill_hard(), restart(bin)}`, `host::test_host_binary()` (tests only); the scenarios `kill-restart` and `outage`, both in `SPAWN_ONLY` (Task 3) and not judged without a spawned host.

**What is exercised (E8, E9):** `kill-restart`: four devices scan into a shared shift of a spawned host; the harness reads the wal-index (the backlog at the kill), sends `SIGKILL` to its own child, holds the devices offline (they keep scanning into their outboxes), waits half a second (no answer can arrive any more: the ledger now holds every acknowledged record), restarts the host on the same data folder and port, and before any device returns checks the database read-only: integrity and the structural checks (SQLite's recovery of the WAL), and for each device at least as many receipts as it had acknowledged («no acknowledged record lost»; more means a batch committed whose answer the kill swallowed). Then the devices return and resend what they never had answered; at the end the exact reconciliation proves no row was written twice and every resend got the stored receipts. Whether the kill landed inside a commit, and whether the WAL held frames, is timing: recorded, and said in the note when not exercised. `outage`: the host is stopped on request (SIGINT) under load; every device keeps retrying with its back-off (250 ms doubling to 2 s), no device gives up, the number of unanswered facts requests stays under what the back-off allows; the host restarts, the outboxes drain, the reconciliation is exact.

- [ ] **Step 1: Write the failing tests.** Append to the `tests` module of `src/host.rs`:

```rust
    #[tokio::test]
    async fn an_in_process_host_is_never_killed_or_restarted_by_the_harness() {
        let dir = tempfile::tempdir().unwrap();
        let mut host = Host::in_process(dir.path()).await.unwrap();
        assert!(host.kill_hard().is_err());
        assert!(host.restart(Path::new("no-such-binary")).await.is_err());
        host.stop().await.unwrap();
    }

    #[cfg_attr(windows, ignore = "restarting on the same port is unverified on Windows")]
    #[tokio::test]
    async fn a_killed_host_restarts_on_its_port_with_its_identity() {
        let dir = tempfile::tempdir().unwrap();
        let log = dir.path().join("host.log");
        let bin = host_binary();
        let mut host = Host::spawned(&bin, &dir.path().join("data"), &log)
            .await
            .unwrap();
        let (base, fingerprint, pid) = (host.base.clone(), host.fingerprint.clone(), host.pid);
        assert_eq!(host.port(), base.rsplit(':').next().and_then(|p| p.parse().ok()));
        let logged = std::fs::metadata(&log).unwrap().len();
        assert!(host.kill_hard().unwrap(), "it was running");
        let client = pinned_client(&fingerprint, Duration::from_secs(2));
        assert!(client.get(format!("{base}/v1/hello")).send().await.is_err());
        assert!(!host.kill_hard().unwrap(), "an ended child is not signalled");
        host.restart(&bin).await.unwrap();
        assert_eq!(
            (host.base.clone(), host.fingerprint.clone()),
            (base.clone(), fingerprint)
        );
        assert_ne!(host.pid, pid);
        assert!(client
            .get(format!("{base}/v1/hello"))
            .send()
            .await
            .unwrap()
            .status()
            .is_success());
        assert!(host.restart(&bin).await.is_err(), "a running host is not restarted");
        if logged > 0 {
            assert!(
                std::fs::metadata(&log).unwrap().len() > logged,
                "the log is appended to, not truncated"
            );
        }
        host.stop().await.unwrap();
    }
```

Create `src/scenarios/kill_restart.rs` holding only:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn the_kill_restart_scenario_is_not_judged_in_this_process() {
        let work = tempfile::tempdir().unwrap();
        let profile = Profile::preset("tiny").unwrap();
        let (result, secrets) = run(&HostKind::InProcess, work.path(), &profile).await;
        assert!(!result.judged);
        assert!(result.note.contains("--host spawn"), "{}", result.note);
        assert!(secrets.is_empty());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    #[ignore = "spawns markiro-host, kills it and restarts it on its port; run with --ignored"]
    async fn the_kill_restart_scenario_holds_against_a_spawned_host() {
        let work = tempfile::tempdir().unwrap();
        let profile = Profile::preset("tiny").unwrap();
        let bin = crate::host::test_host_binary();
        let (result, _) = run(&HostKind::Spawn { bin }, work.path(), &profile).await;
        for check in &result.checks {
            eprintln!("OBSERVED {} {} {}", check.name, check.ok, check.detail);
        }
        eprintln!("OBSERVED {:?} note: {}", result.observed, result.note);
        assert!(result.judged);
        assert!(
            result.checks.iter().all(|check| check.ok),
            "{:#?}",
            result.checks
        );
        for name in [
            "the_host_was_running_when_killed",
            "the_host_restarted_on_the_same_data",
            "after_the_crash_db_integrity",
            "no_acknowledged_record_lost_device_0",
            "db_receipts_device_3",
            "the_last_part_closes_the_shift_after_the_restart",
        ] {
            assert!(
                result.checks.iter().any(|check| check.name == name),
                "no check {name}"
            );
        }
        for key in ["walBacklogAtKill", "committedButUnacknowledged"] {
            assert!(result.observed.contains_key(key), "{key}");
        }
    }
}
```

Create `src/scenarios/outage.rs` holding only:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn the_outage_scenario_is_not_judged_in_this_process() {
        let work = tempfile::tempdir().unwrap();
        let profile = Profile::preset("tiny").unwrap();
        let (result, _) = run(&HostKind::InProcess, work.path(), &profile).await;
        assert!(!result.judged);
        assert!(result.note.contains("--host spawn"), "{}", result.note);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    #[ignore = "spawns markiro-host, stops it under load and restarts it; run with --ignored"]
    async fn the_outage_scenario_holds_against_a_spawned_host() {
        let work = tempfile::tempdir().unwrap();
        let profile = Profile::preset("tiny").unwrap();
        let bin = crate::host::test_host_binary();
        let (result, _) = run(&HostKind::Spawn { bin }, work.path(), &profile).await;
        for check in &result.checks {
            eprintln!("OBSERVED {} {} {}", check.name, check.ok, check.detail);
        }
        eprintln!("OBSERVED {:?}", result.observed);
        assert!(result.judged);
        assert!(
            result.checks.iter().all(|check| check.ok),
            "{:#?}",
            result.checks
        );
        for name in [
            "the_host_stopped_on_request",
            "every_device_kept_retrying",
            "the_back_off_caps_the_retries",
            "no_device_gave_up",
            "the_host_came_back",
            "db_scans_device_0",
        ] {
            assert!(
                result.checks.iter().any(|check| check.name == name),
                "no check {name}"
            );
        }
    }
}
```

Add `pub mod kill_restart;` and `pub mod outage;` beside the other modules in `src/scenarios/mod.rs`.

- [ ] **Step 2: Run them to verify they fail.**

Run: `cargo --offline --locked test --manifest-path "$WT/apps/standalone/Cargo.toml" -p markiro-loadtest --lib --no-run`
Expected: FAIL to compile: `no method named kill_hard / restart / port`, `cannot find function test_host_binary`, `cannot find function run`.

- [ ] **Step 3: The host.** In `src/host.rs`:

Replace the whole `pub async fn spawned(bin: &Path, data_dir: &Path, log: &Path) -> Result<Host, Error> { … }` with:

```rust
    /// `bin run --data-dir <data_dir> --port <free port>` with its output in `log`. The command
    /// line binds every interface (it has no flag for less), for as long as the run lasts: run
    /// it on a machine you trust.
    pub async fn spawned(bin: &Path, data_dir: &Path, log: &Path) -> Result<Host, Error> {
        let port = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?
            .local_addr()?
            .port();
        Host::spawned_on(bin, data_dir, log, port, false).await
    }

    /// `spawned` on a given port; `append` keeps what `log` holds (a restart).
    pub async fn spawned_on(
        bin: &Path,
        data_dir: &Path,
        log: &Path,
        port: u16,
        append: bool,
    ) -> Result<Host, Error> {
        let out = if append {
            std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(log)?
        } else {
            std::fs::File::create(log)?
        };
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
        // The identity appears when the host has started (at once on a restart); a child that
        // ends meanwhile (its port taken, its folder refused) is said at once, not after a minute.
        let paths = HostPaths::new(data_dir);
        let started = Instant::now();
        loop {
            if let Process::Spawned { child, .. } = &mut host.process {
                if let Some(status) = child.try_wait()? {
                    return Err(format!(
                        "markiro-host ended at its start ({status}): see {}",
                        log.display()
                    )
                    .into());
                }
            }
            if host.fingerprint.is_empty() {
                if let Ok(identity) = markiro_host::tls::TlsIdentity::load(&paths.tls_dir()) {
                    host.fingerprint = identity.fingerprint;
                }
            }
            if !host.fingerprint.is_empty()
                && wait_ready(&host.base, &host.fingerprint, Duration::from_millis(1))
                    .await
                    .is_ok()
            {
                return Ok(host);
            }
            if started.elapsed() > Duration::from_secs(60) {
                host.stop().await.ok();
                return Err("the host did not answer /v1/hello in 60 s".into());
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    }

    /// The port of the host's address.
    pub fn port(&self) -> Option<u16> {
        self.base.rsplit(':').next().and_then(|port| port.parse().ok())
    }

    /// Kill the host this harness spawned at once, as a crash would (`SIGKILL` on Unix,
    /// `TerminateProcess` on Windows), and reap it; `true` when it was still running. Any other
    /// host is refused: the harness kills only the child it started, never a process found by
    /// name, and never signals a child that already ended.
    pub fn kill_hard(&mut self) -> Result<bool, Error> {
        match &mut self.process {
            Process::Spawned { child, .. } => {
                if child.try_wait()?.is_some() {
                    return Ok(false);
                }
                child.kill()?;
                child.wait()?;
                Ok(true)
            }
            _ => Err("only a host this harness spawned is killed".into()),
        }
    }

    /// Start the binary again on the same data folder and port, appending to the same log, after
    /// a kill or a stop; the identity (fingerprint) must be the same.
    pub async fn restart(&mut self, bin: &Path) -> Result<(), Error> {
        let (Some(data_dir), Some(port)) = (self.data_dir.clone(), self.port()) else {
            return Err("no data folder or port to restart on".into());
        };
        let log = match &mut self.process {
            Process::Spawned { child, log } => {
                if child.try_wait()?.is_none() {
                    return Err("the host still runs: stop or kill it first".into());
                }
                log.clone()
            }
            _ => return Err("only a host this harness spawned restarts".into()),
        };
        let mut fresh = Host::spawned_on(bin, &data_dir, &log, port, true).await?;
        if fresh.fingerprint != self.fingerprint {
            fresh.stop().await.ok();
            return Err("the restarted host has another identity".into());
        }
        self.pid = fresh.pid;
        self.process = std::mem::replace(&mut fresh.process, Process::Attached);
        Ok(())
    }
```

Below `fn ask_to_stop` (both variants) add:

```rust
/// The `markiro-host` binary of this build's target folder, built when it is missing (tests).
#[cfg(test)]
pub(crate) fn test_host_binary() -> PathBuf {
    let exe = std::env::current_exe().unwrap();
    let debug_dir = exe.parent().unwrap().parent().unwrap();
    let name = if cfg!(windows) {
        "markiro-host.exe"
    } else {
        "markiro-host"
    };
    let bin = debug_dir.join(name);
    if !bin.exists() {
        let status = Command::new(env!("CARGO"))
            .args(["build", "--offline", "--locked", "-p", "markiro-host"])
            .arg("--manifest-path")
            .arg(concat!(env!("CARGO_MANIFEST_DIR"), "/../Cargo.toml"))
            .status()
            .unwrap();
        assert!(status.success());
    }
    assert!(bin.exists(), "no markiro-host at {}", bin.display());
    bin
}
```

and in the tests module replace the body of `fn host_binary() -> PathBuf { … }` with `super::test_host_binary()`.

- [ ] **Step 4: Write `kill-restart`.** Put this above the tests module of `src/scenarios/kill_restart.rs`:

```rust
//! `kill-restart`: a spawned host killed (`SIGKILL`) while devices write, restarted on the same
//! data folder and port. SQLite recovers its log; no acknowledged record is lost; the devices'
//! resends of batches they never had answered get the stored receipts and write nothing twice.
//! A kill is a process crash, not a power cut (`synchronous=FULL` keeps what was committed
//! either way); a power cut is not simulated.

use std::collections::BTreeMap;
use std::path::Path;
use std::time::Duration;

use serde_json::json;

use super::{enter_all, part_closed, prefixed, Ctx, HostKind, Res, LOAD_S};
use crate::checks::Check;
use crate::profile::Profile;
use crate::report::ScenarioResult;

pub const NAME: &str = "kill-restart";

pub async fn run(
    kind: &HostKind,
    work_dir: &Path,
    base: &Profile,
) -> (ScenarioResult, Vec<String>) {
    let HostKind::Spawn { bin } = kind else {
        return (
            super::not_judged(
                NAME,
                "needs a host this harness spawned (--host spawn): a host in this process or an attached one cannot be killed and restarted",
            ),
            Vec::new(),
        );
    };
    let mut ctx = match Ctx::new(NAME, kind, work_dir, base, 3, 1).await {
        Ok(ctx) => ctx,
        Err(error) => return (super::broken(NAME, error), Vec::new()),
    };
    ctx.faults = true;
    let outcome = body(&mut ctx, bin).await;
    ctx.finish(outcome).await
}

async fn body(ctx: &mut Ctx, bin: &Path) -> Res<()> {
    let line = ctx.site.line_ids[0].clone();
    let shift = ctx.plan(&line, None).await?;
    let all = [0usize, 1, 2, 3];
    let prefix = enter_all(ctx, &shift, &all).await?;
    let work = ctx.load(1, &shift, &prefix, &all);
    tokio::time::sleep(Duration::from_secs(LOAD_S)).await;
    let data_dir = ctx
        .host
        .data_dir
        .clone()
        .ok_or("the scenario host has no data folder")?;
    let at_kill = crate::sampler::take(0.0, Some(data_dir.as_path()), None);
    let running = ctx.host.kill_hard().map_err(|error| error.to_string())?;
    ctx.same("the_host_was_running_when_killed", true, running);
    ctx.observe("walBacklogAtKill", json!(at_kill.wal_backlog_frames));
    ctx.observe("walBytesAtKill", json!(at_kill.wal_bytes));
    for device in &work.devices {
        device.set_online(false);
    }
    // The requests in flight at the kill fail now; nothing more can be acknowledged.
    tokio::time::sleep(Duration::from_millis(500)).await;
    let acked: BTreeMap<u32, u64> = work.shared.ledger.lock().expect("ledger").records.clone();
    let before = ctx.host.pid;
    ctx.host
        .restart(bin)
        .await
        .map_err(|error| error.to_string())?;
    ctx.check(Check::new(
        "the_host_restarted_on_the_same_data",
        ctx.host.pid != before,
        format!("pid {before:?} then {:?}", ctx.host.pid),
    ));
    // Before any device returns: the recovered database, read-only.
    let pool = ctx.db().await?;
    let rows: Result<Vec<(String, i64)>, String> = sqlx::query_as(
        "SELECT device_id, COUNT(*) FROM fact_receipts WHERE shift_id = ? GROUP BY device_id",
    )
    .bind(&shift)
    .fetch_all(&pool)
    .await
    .map_err(|error| error.to_string());
    let structural = crate::dbcheck::structural(&pool).await;
    pool.close().await;
    let kept: BTreeMap<String, i64> = rows?.into_iter().collect();
    let mut swallowed = 0u64;
    for device in &work.devices {
        let index = device.spec.index;
        let acknowledged = acked.get(&index).copied().unwrap_or(0);
        let in_db = kept.get(&device.spec.id).copied().unwrap_or(0) as u64;
        ctx.check(Check::new(
            &format!("no_acknowledged_record_lost_device_{index}"),
            in_db >= acknowledged,
            format!("{acknowledged} acknowledged, {in_db} in the database after the restart"),
        ));
        swallowed += in_db.saturating_sub(acknowledged);
    }
    match structural {
        Ok(checks) => ctx.checks(prefixed("after_the_crash_", checks)),
        Err(error) => ctx.check(Check::new("after_the_crash_db_structural", false, error)),
    }
    ctx.observe("committedButUnacknowledged", json!(swallowed));
    if swallowed == 0 {
        ctx.note.push_str(
            "the kill swallowed no committed batch's answer this run, so no resend met a stored \
             receipt after the crash (the logic has its unit test \
             device::tests::a_batch_the_host_kept_but_whose_answer_was_lost_is_counted_once). ",
        );
    }
    if !at_kill.wal_backlog_frames.is_some_and(|frames| frames > 0) {
        ctx.note.push_str(
            "the WAL held no un-checkpointed frame at the kill (or it could not be read): the \
             recovery of such frames was not exercised this run. ",
        );
    }
    // The devices come back, resend and go on.
    for device in &work.devices {
        device.set_online(true);
    }
    tokio::time::sleep(Duration::from_secs(LOAD_S)).await;
    let (shared, devices, drained) = work.stop("").await;
    ctx.checks(drained);
    let flush_errors: u64 = devices.iter().map(|device| device.stats().flush_errors).sum();
    ctx.observe("flushErrors", json!(flush_errors));
    let found = super::reconcile(ctx, "", &shift, &shared, &devices).await;
    ctx.checks(found);
    let mut last = None;
    for device in &devices {
        last = Some(device.close_part_ledgered(None, None, None).await?);
    }
    ctx.same(
        "the_last_part_closes_the_shift_after_the_restart",
        Some(false),
        last.as_ref().map(part_closed),
    );
    Ok(())
}
```

- [ ] **Step 5: Write `outage`.** Put this above the tests module of `src/scenarios/outage.rs`:

```rust
//! `outage`: the host stopped on request under load and started again. The devices keep
//! scanning, their sends fail (connection refused), each backs off (`device.rs`: 250 ms doubling
//! to 2 s) and none gives up; after the restart the outboxes drain and nothing is written twice.
//! The back-off exercised is the harness's device model: the station's and the handheld's own
//! clients are not exercised here. A host 5xx is not induced (E9).

use std::path::Path;
use std::time::{Duration, Instant};

use serde_json::json;

use super::{enter_all, part_closed, Ctx, HostKind, Res, LOAD_S};
use crate::checks::Check;
use crate::metrics::Metrics;
use crate::profile::Profile;
use crate::report::ScenarioResult;

pub const NAME: &str = "outage";
/// How long the host stays down, in seconds.
const OUTAGE_S: u64 = 6;

pub async fn run(
    kind: &HostKind,
    work_dir: &Path,
    base: &Profile,
) -> (ScenarioResult, Vec<String>) {
    let HostKind::Spawn { bin } = kind else {
        return (
            super::not_judged(
                NAME,
                "needs a host this harness spawned (--host spawn): a host in this process or an attached one cannot be stopped and restarted on its port",
            ),
            Vec::new(),
        );
    };
    let mut ctx = match Ctx::new(NAME, kind, work_dir, base, 3, 1).await {
        Ok(ctx) => ctx,
        Err(error) => return (super::broken(NAME, error), Vec::new()),
    };
    ctx.faults = true;
    let outcome = body(&mut ctx, bin).await;
    ctx.finish(outcome).await
}

/// Facts requests that got no answer so far.
fn facts_without_an_answer(metrics: &Metrics) -> u64 {
    metrics
        .errors()
        .iter()
        .filter(|(class, _)| class.starts_with("facts:net_"))
        .map(|(_, count)| *count)
        .sum()
}

async fn body(ctx: &mut Ctx, bin: &Path) -> Res<()> {
    let line = ctx.site.line_ids[0].clone();
    let shift = ctx.plan(&line, None).await?;
    let all = [0usize, 1, 2, 3];
    let prefix = enter_all(ctx, &shift, &all).await?;
    let work = ctx.load(1, &shift, &prefix, &all);
    tokio::time::sleep(Duration::from_secs(LOAD_S)).await;
    let failed_before: Vec<u64> = work
        .devices
        .iter()
        .map(|device| device.stats().flush_errors)
        .collect();
    let unanswered_before = facts_without_an_answer(&ctx.metrics);
    let began = Instant::now();
    let graceful = ctx.host.stop().await.map_err(|error| error.to_string())?;
    ctx.same("the_host_stopped_on_request", cfg!(unix), graceful);
    tokio::time::sleep(Duration::from_secs(OUTAGE_S)).await;
    let window_s = began.elapsed().as_secs_f64();
    let unanswered = facts_without_an_answer(&ctx.metrics) - unanswered_before;
    let retried: Vec<u64> = work
        .devices
        .iter()
        .zip(&failed_before)
        .map(|(device, before)| device.stats().flush_errors - before)
        .collect();
    ctx.observe("failedSendsPerDevice", json!(retried));
    ctx.observe("outageS", json!(window_s));
    ctx.check(Check::new(
        "every_device_kept_retrying",
        retried.iter().all(|count| *count > 0),
        format!("{retried:?} failed sends per device in {window_s:.1} s"),
    ));
    // Without the back-off a device would retry every flush interval (300 ms): about 20 times in
    // 6 s. With it: 0, 0.3, 0.8, 1.8, 3.8, 5.8 s — six. The bound leaves room for the stop itself.
    let bound = work.devices.len() as u64 * (3 + window_s.ceil() as u64);
    ctx.check(Check::new(
        "the_back_off_caps_the_retries",
        unanswered <= bound,
        format!(
            "{unanswered} facts requests without an answer from {} devices in {window_s:.1} s, at most {bound}",
            work.devices.len()
        ),
    ));
    ctx.check(Check::new(
        "no_device_gave_up",
        work.devices.iter().all(|device| device.stats().fatal.is_none()),
        format!(
            "{:?}",
            work.devices
                .iter()
                .map(|device| device.stats().fatal)
                .collect::<Vec<_>>()
        ),
    ));
    let restarted = ctx.host.restart(bin).await.map_err(|error| error.to_string());
    ctx.check(Check::new(
        "the_host_came_back",
        restarted.is_ok(),
        format!("{restarted:?}"),
    ));
    restarted?;
    tokio::time::sleep(Duration::from_secs(LOAD_S)).await;
    let (shared, devices, drained) = work.stop("").await;
    ctx.checks(drained);
    let found = super::reconcile(ctx, "", &shift, &shared, &devices).await;
    ctx.checks(found);
    let mut last = None;
    for device in &devices {
        last = Some(device.close_part_ledgered(None, None, None).await?);
    }
    ctx.same(
        "the_last_part_closes_the_shift_after_the_outage",
        Some(false),
        last.as_ref().map(part_closed),
    );
    Ok(())
}
```

In `src/scenarios/mod.rs`, in `run_one`, add `kill_restart::NAME => kill_restart::run(kind, work_dir, profile).await,` and `outage::NAME => outage::run(kind, work_dir, profile).await,`. In `src/profile.rs` make `SCENARIOS` `&["line-full", "capability", "leave-reenter", "closed-part", "close-races", "lines", "backup-mid-close", "kill-restart", "outage"]`.

- [ ] **Step 6: Run the tests to verify they pass.**

Run (sandbox off): `cargo --offline --locked test --manifest-path "$WT/apps/standalone/Cargo.toml" -p markiro-loadtest --lib host::tests`
Expected: `test result: ok.`, including `an_in_process_host_is_never_killed_or_restarted_by_the_harness` and `a_killed_host_restarts_on_its_port_with_its_identity`.

Run (sandbox off): `cargo --offline --locked test --manifest-path "$WT/apps/standalone/Cargo.toml" -p markiro-loadtest --lib scenarios::kill_restart`, then the same with `scenarios::outage`.
Expected for each: `test result: ok. 1 passed; 0 failed; 1 ignored` (the in-process test runs; the spawned one is ignored).

Run (sandbox off, the spawned ones): `cargo --offline --locked test --manifest-path "$WT/apps/standalone/Cargo.toml" -p markiro-loadtest --lib scenarios::kill_restart -- --ignored --nocapture`, then the same with `scenarios::outage`.
Expected: `test result: ok. 1 passed` each. Record the `OBSERVED` lines (`walBacklogAtKill`, `committedButUnacknowledged`, `flushErrors`, `failedSendsPerDevice`, the note) for Task 13's report. After each run check no host is left: `pgrep -f "markiro-host run --data-dir $TMPDIR"` prints nothing (`pgrep` only lists; it signals nothing).

If `no_acknowledged_record_lost_device_*` or the reconciliation fails after the restart, that is a durability defect of the host: keep the folder (rerun locally with the tempdir leaked), and report the check's detail and the log (`scenarios/kill-restart/host-stdout.log`). Do not retry until green.

- [ ] **Step 7: Mutation checks.** (a) In `kill_hard`, replace the two lines `child.kill()?;` and `child.wait()?;` with nothing (the method then answers `Ok(true)` without killing); `a_killed_host_restarts_on_its_port_with_its_identity` must FAIL (`/v1/hello` still answers). Restore. (b) In `outage.rs` change `let bound = work.devices.len() as u64 * (3 + window_s.ceil() as u64);` to `let bound = 0;`; the ignored outage test must FAIL naming `the_back_off_caps_the_retries`. Restore; ok.

- [ ] **Step 8: Commit.**

```bash
git -C "$WT" add apps/standalone/loadtest/src/host.rs apps/standalone/loadtest/src/scenarios/kill_restart.rs apps/standalone/loadtest/src/scenarios/outage.rs apps/standalone/loadtest/src/scenarios/mod.rs apps/standalone/loadtest/src/profile.rs
git -C "$WT" commit -m "feat(loadtest): process faults on a spawned host (kill -9 and restart, outage and back-off)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 12: The WAL watch and the measurement of the backlog near 1000 frames

**Files:**

- Create: `apps/standalone/loadtest/src/wal_watch.rs`
- Modify: `apps/standalone/loadtest/src/lib.rs`, `apps/standalone/loadtest/src/report.rs`, `apps/standalone/loadtest/src/run.rs`, `docs/runbooks/standalone-load-test.md`

**Interfaces:**

- Consumes: Task 3 (`Ctx`, `Load` for its end-to-end test).
- Produces: `wal_watch::{wal_header, shm_point, read_point, run, summarize, findings, WalWatch, Point, WalHeader, ShmPoint, AUTOCHECKPOINT_FRAMES, EVERY}`; `Report.wal_watch: Option<WalWatch>` (`#[serde(default)]`), warnings in the verdict, a «WAL watch» section in the Markdown; the runbook's measured finding.

**Why (the observation to settle):** the merged harness saw the backlog (`mxFrame − nBackfill`) peak at 986–1004 frames in every run, with p99 equal to the maximum, and the load-test plan had no explicit checkpoint («plan gap 3»). A 5-second sampler cannot tell a healthy sawtooth (the automatic checkpoint fires after a commit leaves ≥ 1000 frames, copies them, and the log restarts) from a checkpoint that barely keeps up. The WAL header's checkpoint sequence counts the restarts exactly, and a 100 ms wal-index sample gives the backlog's distribution. The harness never runs `PRAGMA wal_checkpoint` (E10).

- [ ] **Step 1: Write the failing tests.** Create `src/wal_watch.rs` holding only its tests for now, and add `pub mod wal_watch;` after `pub mod wal;` in `src/lib.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn header_bytes(page_size: u32, seq: u32) -> Vec<u8> {
        let mut bytes = vec![0u8; 32];
        bytes[0..4].copy_from_slice(&0x377f_0682u32.to_be_bytes());
        bytes[4..8].copy_from_slice(&3_007_000u32.to_be_bytes());
        bytes[8..12].copy_from_slice(&page_size.to_be_bytes());
        bytes[12..16].copy_from_slice(&seq.to_be_bytes());
        bytes
    }

    fn shm_bytes(frames: u32, copied: u32, attempted: u32) -> Vec<u8> {
        let mut bytes = vec![0u8; 136];
        bytes[12] = 1;
        bytes[16..20].copy_from_slice(&frames.to_ne_bytes());
        let copy: Vec<u8> = bytes[..48].to_vec();
        bytes[48..96].copy_from_slice(&copy);
        bytes[96..100].copy_from_slice(&copied.to_ne_bytes());
        bytes[128..132].copy_from_slice(&attempted.to_ne_bytes());
        bytes
    }

    #[test]
    fn the_wal_header_and_the_wal_index_are_read_or_refused() {
        assert_eq!(
            wal_header(&header_bytes(4096, 7)),
            Some(WalHeader {
                page_size: 4096,
                checkpoint_seq: 7
            })
        );
        let mut bad = header_bytes(4096, 7);
        bad[0] = 0;
        assert_eq!(wal_header(&bad), None, "not a WAL magic");
        assert_eq!(wal_header(&[0u8; 10]), None);
        let point = shm_point(&shm_bytes(1200, 1000, 1200)).unwrap();
        assert_eq!(
            (point.mx_frame, point.backfill, point.backfill_attempted, point.backlog()),
            (1200, 1000, 1200, 200)
        );
        let mut torn = shm_bytes(1200, 1000, 1200);
        torn[16] ^= 0xFF;
        assert_eq!(shm_point(&torn), None, "a torn read");
        assert_eq!(shm_point(&shm_bytes(1, 0, 0)[..100]), None, "too short");
    }

    fn point(t_s: f64, seq: u32, frames: u32, copied: u32) -> Point {
        Point {
            t_s,
            wal_bytes: Some(32 + 4120 * 1004),
            header: Some(WalHeader {
                page_size: 4096,
                checkpoint_seq: seq,
            }),
            shm: Some(ShmPoint {
                mx_frame: frames,
                backfill: copied,
                backfill_attempted: copied,
            }),
        }
    }

    #[test]
    fn a_sawtooth_is_summarised_with_its_restarts_and_quantiles() {
        let points = vec![
            point(0.0, 3, 10, 0),
            point(1.0, 3, 990, 0),
            point(2.0, 3, 1004, 1004),
            point(3.0, 4, 12, 0),
            point(4.0, 4, 600, 0),
        ];
        let watch = summarize(&points, 1000);
        assert_eq!(watch.restarts, 1);
        assert_eq!(watch.backlog_max, Some(990));
        assert_eq!(watch.backlog_p50, Some(12));
        assert_eq!(watch.frames_max, Some(1004));
        assert_eq!(watch.wal_file_max_frames, Some(1004));
        assert_eq!(watch.longest_without_restart_s, 3.0);
        assert_eq!(watch.share_over_autocheckpoint, Some(0.0));
        assert_eq!(watch.duration_s, 4.0);
        assert!(
            watch
                .findings
                .iter()
                .any(|line| line.contains("started again from its beginning 1 times")),
            "{:?}",
            watch.findings
        );
        let blind: Vec<Point> = points
            .iter()
            .map(|point| Point {
                shm: None,
                ..*point
            })
            .collect();
        let watch = summarize(&blind, 1000);
        assert_eq!(watch.readable_points, 0);
        assert!(watch.findings[0].contains("never readable"));
    }

    /// E10: an observer that only reads cannot checkpoint, and so the harness never tries.
    #[tokio::test]
    async fn a_read_only_observer_cannot_checkpoint_the_log() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("host.db");
        let writer = markiro_host::db::open(&path).await.unwrap();
        let reader = crate::dbcheck::open_read_only(&path, false).await.unwrap();
        let outcome: Result<(i64, i64, i64), sqlx::Error> =
            sqlx::query_as("PRAGMA wal_checkpoint(PASSIVE)")
                .fetch_one(&reader)
                .await;
        eprintln!("OBSERVED read-only wal_checkpoint: {outcome:?}");
        assert!(outcome.is_err(), "a read-only connection checkpointed: {outcome:?}");
        reader.close().await;
        writer.close().await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_host_in_this_process_is_watched_while_devices_write() {
        use crate::scenarios::{enter_all, Ctx, HostKind};
        let work = tempfile::tempdir().unwrap();
        let profile = crate::profile::Profile::preset("tiny").unwrap();
        let ctx = Ctx::new("wal", &HostKind::InProcess, work.path(), &profile, 2, 1)
            .await
            .unwrap();
        let dir = ctx.host.data_dir.clone().unwrap();
        let (stop, watching) = watch::channel(false);
        let task = tokio::spawn(run(dir, Duration::from_millis(50), watching));
        let line = ctx.site.line_ids[0].clone();
        let shift = ctx.plan(&line, None).await.unwrap();
        let prefix = enter_all(&ctx, &shift, &[0, 1, 2]).await.unwrap();
        let load = ctx.load(1, &shift, &prefix, &[0, 1, 2]);
        tokio::time::sleep(Duration::from_secs(3)).await;
        let _ = load.stop("").await;
        stop.send_replace(true);
        let points = task.await.unwrap();
        let summary = summarize(&points, 50);
        eprintln!("OBSERVED {summary:#?}");
        assert!(summary.readable_points > 0, "the wal-index was never read");
        assert!(summary.frames_max.is_some_and(|frames| frames > 0));
        assert!(summary.page_size.is_some(), "the WAL header was never read");
        let _ = ctx.finish(Ok(())).await;
    }
}
```

If `a_read_only_observer_cannot_checkpoint_the_log` fails (SQLite let a read-only connection checkpoint), record the `OBSERVED` line and keep the decision of E10 regardless: a checkpoint writes the database file and the harness never writes it. Change the test's assertion to document what was observed only with the reason in its comment.

Append to the `tests` module of `src/report.rs`:

```rust
    #[test]
    fn the_wal_watch_warns_when_the_log_never_restarted_and_reads_back() {
        let mut report = sample_passing();
        report.wal_watch = Some(crate::wal_watch::WalWatch {
            every_ms: 100,
            points: 1800,
            readable_points: 1800,
            duration_s: 180.0,
            restarts: 0,
            ..Default::default()
        });
        let verdict = evaluate(&report);
        assert!(verdict.pass, "a WAL finding is a warning, not a failure");
        assert!(
            verdict.warnings.iter().any(|w| w.contains("never started again")),
            "{:?}",
            verdict.warnings
        );
        report.wal_watch.as_mut().unwrap().restarts = 12;
        assert!(!evaluate(&report)
            .warnings
            .iter()
            .any(|w| w.contains("never started again")));
        let text = serde_json::to_string(&report).unwrap();
        let back: Report = serde_json::from_str(&text).unwrap();
        assert_eq!(back.wal_watch, report.wal_watch);
        let mut value = serde_json::to_value(&report).unwrap();
        value.as_object_mut().unwrap().remove("walWatch");
        let old: Report = serde_json::from_value(value).unwrap();
        assert!(old.wal_watch.is_none());
    }
```

- [ ] **Step 2: Run them to verify they fail.**

Run: `cargo --offline --locked test --manifest-path "$WT/apps/standalone/Cargo.toml" -p markiro-loadtest --lib --no-run`
Expected: FAIL to compile: `cannot find function wal_header`, `no field wal_watch on type Report`, ….

- [ ] **Step 3: Write the observer.** Put this above the tests module of `src/wal_watch.rs`:

```rust
//! A fine observer of SQLite's write-ahead log, from outside and from files only (plan
//! `2026-10-22-multi-station-load-test-scenarios.md`, E10): the log's header (`host.db-wal`, big
//! endian: its page size, and its checkpoint sequence, which goes up each time the log starts
//! again from its beginning) and the wal-index (`host.db-shm`, native order: the last frame
//! written, the frames a checkpoint copied, the frames a checkpoint set out to copy), every
//! 100 ms. It says how close to SQLite's automatic checkpoint the backlog sits, how often the
//! log restarts and how large its file grows. It never checkpoints: a read-only connection
//! cannot, and a checkpoint writes the database file, which the harness never does.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tokio::sync::watch;

/// SQLite runs a checkpoint after a commit leaves this many frames or more in the log
/// (`wal_autocheckpoint`'s default; the host sets no other, `host/src/db.rs`).
pub const AUTOCHECKPOINT_FRAMES: u64 = 1000;
/// How often the run samples the log.
pub const EVERY: Duration = Duration::from_millis(100);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WalHeader {
    pub page_size: u32,
    pub checkpoint_seq: u32,
}

/// The first 32 bytes of `host.db-wal`: magic, version, page size, checkpoint sequence, salts.
pub fn wal_header(bytes: &[u8]) -> Option<WalHeader> {
    if bytes.len() < 32 {
        return None;
    }
    let word = |at: usize| u32::from_be_bytes(bytes[at..at + 4].try_into().expect("four bytes"));
    if !matches!(word(0), 0x377f_0682 | 0x377f_0683) {
        return None;
    }
    Some(WalHeader {
        page_size: word(8),
        checkpoint_seq: word(12),
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ShmPoint {
    pub mx_frame: u32,
    pub backfill: u32,
    pub backfill_attempted: u32,
}

impl ShmPoint {
    /// Frames written that no checkpoint has copied yet.
    pub fn backlog(&self) -> u64 {
        u64::from(self.mx_frame.saturating_sub(self.backfill))
    }
}

/// The wal-index header (`mxFrame` at 16, written twice) and the checkpoint info (`nBackfill`
/// at 96, `nBackfillAttempted` at 128); a torn, short or unset header is no point.
pub fn shm_point(bytes: &[u8]) -> Option<ShmPoint> {
    if bytes.len() < 132 || bytes[12] == 0 || bytes[..48] != bytes[48..96] {
        return None;
    }
    let word = |at: usize| u32::from_ne_bytes(bytes[at..at + 4].try_into().expect("four bytes"));
    Some(ShmPoint {
        mx_frame: word(16),
        backfill: word(96),
        backfill_attempted: word(128),
    })
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Point {
    pub t_s: f64,
    pub wal_bytes: Option<u64>,
    pub header: Option<WalHeader>,
    pub shm: Option<ShmPoint>,
}

fn head(path: &Path, n: usize) -> Option<Vec<u8>> {
    let mut file = std::fs::File::open(path).ok()?;
    let mut bytes = vec![0u8; n];
    file.read_exact(&mut bytes).ok()?;
    Some(bytes)
}

/// One sample of the data folder `dir`; the wal-index is read twice at most.
pub fn read_point(t_s: f64, dir: &Path) -> Point {
    let wal = dir.join("host.db-wal");
    let shm = dir.join("host.db-shm");
    let read_shm = || std::fs::read(&shm).ok().and_then(|bytes| shm_point(&bytes));
    Point {
        t_s,
        wal_bytes: std::fs::metadata(&wal).ok().map(|meta| meta.len()),
        header: head(&wal, 32).and_then(|bytes| wal_header(&bytes)),
        shm: read_shm().or_else(read_shm),
    }
}

/// Sample `dir` every `every` until `stop` turns true.
pub async fn run(dir: PathBuf, every: Duration, mut stop: watch::Receiver<bool>) -> Vec<Point> {
    let started = Instant::now();
    let mut points = Vec::new();
    loop {
        let (path, at) = (dir.clone(), started.elapsed().as_secs_f64());
        if let Ok(point) = tokio::task::spawn_blocking(move || read_point(at, &path)).await {
            points.push(point);
        }
        tokio::select! {
            _ = tokio::time::sleep(every) => {}
            _ = stop.changed() => break,
        }
        if *stop.borrow() {
            break;
        }
    }
    points
}

/// What the samples say, with plain findings; nothing here is a threshold.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WalWatch {
    pub every_ms: u64,
    pub points: usize,
    pub readable_points: usize,
    pub duration_s: f64,
    pub page_size: Option<u32>,
    /// The highest frame the log reached before it started again.
    pub frames_max: Option<u64>,
    pub backlog_p50: Option<u64>,
    pub backlog_p90: Option<u64>,
    pub backlog_p99: Option<u64>,
    pub backlog_max: Option<u64>,
    /// Samples whose backlog was above the automatic checkpoint's trigger, as a share.
    pub share_over_autocheckpoint: Option<f64>,
    /// Times the log started again from its beginning (its checkpoint sequence went up).
    pub restarts: u64,
    /// The longest stretch between two observed restarts (or an end of the watch), in seconds.
    pub longest_without_restart_s: f64,
    /// Samples that caught a checkpoint which had not reached the end it set out for.
    pub checkpoint_short_points: u64,
    pub wal_file_max_bytes: Option<u64>,
    /// The file's largest size in frames: (bytes − 32) / (page size + 24).
    pub wal_file_max_frames: Option<u64>,
    pub findings: Vec<String>,
}

fn quantile(sorted: &[u64], q: f64) -> Option<u64> {
    (!sorted.is_empty()).then(|| {
        sorted[((sorted.len() as f64 * q).ceil() as usize).clamp(1, sorted.len()) - 1]
    })
}

pub fn summarize(points: &[Point], every_ms: u64) -> WalWatch {
    let readable: Vec<ShmPoint> = points.iter().filter_map(|point| point.shm).collect();
    let mut backlog: Vec<u64> = readable.iter().map(ShmPoint::backlog).collect();
    backlog.sort_unstable();
    let page_size = points
        .iter()
        .rev()
        .find_map(|point| point.header.map(|header| header.page_size));
    let mut restarts = 0u64;
    let first = points.first().map_or(0.0, |point| point.t_s);
    let last = points.last().map_or(0.0, |point| point.t_s);
    let mut marks = vec![first];
    let mut previous: Option<u32> = None;
    for point in points {
        if let Some(header) = point.header {
            if let Some(seen) = previous {
                if header.checkpoint_seq > seen {
                    restarts += u64::from(header.checkpoint_seq - seen);
                    marks.push(point.t_s);
                }
            }
            previous = Some(header.checkpoint_seq);
        }
    }
    marks.push(last);
    let longest = marks
        .windows(2)
        .map(|pair| pair[1] - pair[0])
        .fold(0.0_f64, f64::max);
    let wal_file_max_bytes = points.iter().filter_map(|point| point.wal_bytes).max();
    let over = backlog
        .iter()
        .filter(|frames| **frames > AUTOCHECKPOINT_FRAMES)
        .count();
    let mut watch = WalWatch {
        every_ms,
        points: points.len(),
        readable_points: readable.len(),
        duration_s: last - first,
        page_size,
        frames_max: readable.iter().map(|shm| u64::from(shm.mx_frame)).max(),
        backlog_p50: quantile(&backlog, 0.5),
        backlog_p90: quantile(&backlog, 0.9),
        backlog_p99: quantile(&backlog, 0.99),
        backlog_max: backlog.last().copied(),
        share_over_autocheckpoint: (!backlog.is_empty())
            .then(|| over as f64 / backlog.len() as f64),
        restarts,
        longest_without_restart_s: longest,
        checkpoint_short_points: readable
            .iter()
            .filter(|shm| shm.backfill_attempted > shm.backfill)
            .count() as u64,
        wal_file_max_bytes,
        wal_file_max_frames: match (wal_file_max_bytes, page_size) {
            (Some(bytes), Some(page)) if page > 0 => {
                Some(bytes.saturating_sub(32) / (u64::from(page) + 24))
            }
            _ => None,
        },
        findings: Vec::new(),
    };
    watch.findings = findings(&watch);
    watch
}

/// The summary in plain sentences: what was seen, not what it should be.
pub fn findings(watch: &WalWatch) -> Vec<String> {
    let mut found = Vec::new();
    if watch.readable_points == 0 {
        found.push("the wal-index was never readable: nothing is known of the checkpoints".to_owned());
        return found;
    }
    found.push(format!(
        "{} of {} samples (every {} ms over {:.0} s) read the wal-index",
        watch.readable_points, watch.points, watch.every_ms, watch.duration_s
    ));
    if let (Some(p50), Some(p99), Some(max)) =
        (watch.backlog_p50, watch.backlog_p99, watch.backlog_max)
    {
        found.push(format!(
            "backlog (frames written, not yet copied by a checkpoint): p50 {p50}, p99 {p99}, max {max}; \
             SQLite checkpoints after a commit leaves {AUTOCHECKPOINT_FRAMES} frames or more; \
             {:.1} % of samples were above that",
            watch.share_over_autocheckpoint.unwrap_or(0.0) * 100.0
        ));
    }
    if watch.restarts == 0 {
        found.push(format!(
            "the log never started again from its beginning in {:.0} s",
            watch.duration_s
        ));
    } else {
        found.push(format!(
            "the log started again from its beginning {} times; the longest stretch without a restart was {:.0} s",
            watch.restarts, watch.longest_without_restart_s
        ));
    }
    if let Some(frames) = watch.frames_max {
        found.push(format!("the highest frame written: {frames}"));
    }
    if let (Some(bytes), Some(frames)) = (watch.wal_file_max_bytes, watch.wal_file_max_frames) {
        found.push(format!(
            "the log file reached {bytes} bytes ({frames} frames); SQLite reuses it from its start and never shrinks it"
        ));
    }
    if watch.checkpoint_short_points > 0 {
        found.push(format!(
            "{} samples caught a checkpoint that had not reached the end it set out for (a reader held the log)",
            watch.checkpoint_short_points
        ));
    }
    found
}
```

- [ ] **Step 4: Into the report and the run.** In `src/report.rs`, in `pub struct Report`, after the `scenarios` field add:

```rust
    /// The fine WAL watch of the main run (`wal_watch.rs`); a schema-1 report has none.
    #[serde(default)]
    pub wal_watch: Option<crate::wal_watch::WalWatch>,
```

In `evaluate`, before `if r.fds_max.is_none() …` add:

```rust
    if let Some(watch) = &report.wal_watch {
        if watch.readable_points == 0 {
            warnings.push("the WAL watch never read the wal-index: checkpoints were not observed".to_owned());
        } else if watch.restarts == 0 && watch.duration_s >= 60.0 {
            warnings.push(format!(
                "the WAL never started again in {:.0} s: the automatic checkpoint never caught up with the end of the log (see walWatch.findings)",
                watch.duration_s
            ));
        }
    }
```

In `render_markdown`, before the `## Under load and at the end` line add:

```rust
    if let Some(watch) = &report.wal_watch {
        let _ = writeln!(out, "## WAL watch\n");
        for finding in &watch.findings {
            let _ = writeln!(out, "- {finding}");
        }
        out.push('\n');
    }
```

In `sample_passing`, after `scenarios: vec![],` add `wal_watch: None,`.

In `src/run.rs`, replace

```rust
    let (sampler_stop, sampler_watch) = watch::channel(false);
    let sampler = tokio::spawn(sampler::run(
```

with

```rust
    let (sampler_stop, sampler_watch) = watch::channel(false);
    let wal_task = host.data_dir.clone().map(|dir| {
        tokio::spawn(crate::wal_watch::run(
            dir,
            crate::wal_watch::EVERY,
            sampler_watch.clone(),
        ))
    });
    let sampler = tokio::spawn(sampler::run(
```

replace

```rust
    sampler_stop.send_replace(true);
    let series = sampler.await.unwrap_or_default();
```

with

```rust
    sampler_stop.send_replace(true);
    let series = sampler.await.unwrap_or_default();
    let wal_points = match wal_task {
        Some(task) => task.await.unwrap_or_default(),
        None => Vec::new(),
    };
    let wal_watch = (!wal_points.is_empty()).then(|| {
        crate::wal_watch::summarize(&wal_points, crate::wal_watch::EVERY.as_millis() as u64)
    });
```

and in the `Report { … }` literal, after `scenarios: scenario_results,` add `wal_watch,`.

- [ ] **Step 5: Run the tests to verify they pass.**

Run (pure): `cargo --offline --locked test --manifest-path "$WT/apps/standalone/Cargo.toml" -p markiro-loadtest --lib report::tests`
Expected: `test result: ok.`, including `the_wal_watch_warns_when_the_log_never_restarted_and_reads_back`.

Run (sandbox off): `cargo --offline --locked test --manifest-path "$WT/apps/standalone/Cargo.toml" -p markiro-loadtest --lib wal_watch:: -- --nocapture`
Expected: `test result: ok. 4 passed`; `OBSERVED read-only wal_checkpoint: Err(…readonly…)` and the summary of three seconds of a host in this process.

- [ ] **Step 6: Mutation check.** In `wal_header`, change `checkpoint_seq: word(12)` to `checkpoint_seq: word(16)`; `the_wal_header_and_the_wal_index_are_read_or_refused` must FAIL. Restore. In `summarize`, change `if header.checkpoint_seq > seen` to `if header.checkpoint_seq < seen`; `a_sawtooth_is_summarised_with_its_restarts_and_quantiles` must FAIL. Restore; ok.

- [ ] **Step 7: Measure.** Build in release and run two smokes without the scenarios (the measurement is the main run's), one with the host in this process and one spawned on this machine's loopback (a trusted machine: the spawned host listens on every interface for the run):

```bash
cargo --offline --locked build --release --manifest-path "$WT/apps/standalone/Cargo.toml" -p markiro-host -p markiro-loadtest
"$WT/apps/standalone/target/release/markiro-loadtest" run --profile smoke --set scenarios=none --host in-process --out "$HOME/markiro-load"
"$WT/apps/standalone/target/release/markiro-loadtest" run --profile smoke --set scenarios=none --accept-network-exposure --out "$HOME/markiro-load"
```

Expected: each prints `# Load run \`smoke\`: PASS`(a failing latency threshold is recorded, not a reason to stop; a failing correctness check is a defect to report) and a`## WAL watch`section. From each`report.json`read`walWatch` (`restarts`, `longestWithoutRestartS`, `backlogP50`, `backlogP99`, `backlogMax`, `shareOverAutocheckpoint`, `framesMax`, `walFileMaxBytes`, `walFileMaxFrames`, `checkpointShortPoints`) and `resources.walBacklogMaxFrames` (the 5 s sampler's figure, for comparison).

- [ ] **Step 8: Record the finding.** In `docs/runbooks/standalone-load-test.md`, replace the paragraph that starts with `**Что значит «очередь WAL около 997 кадров».**` (to the end of that paragraph) with the paragraph below, putting the measured numbers of Step 7 where the braces stand (one sentence per run if the two differ):

```text
**Очередь WAL: измерение (Задача 12 плана 2026-10-22).** Хост пишет в журнал WAL; SQLite сама переносит его в основной
файл (автоматическая контрольная точка) после коммита, оставившего в журнале 1000 кадров или больше, и затем начинает
журнал сначала. Наблюдатель `walWatch` читает заголовок `host.db-wal` (счётчик перезапусков журнала) и `host.db-shm`
каждые 100 мс, ничего не записывая. smoke, 180 с, {режим хоста}: журнал начинался заново {restarts} раз, самый
длинный промежуток без перезапуска {longestWithoutRestartS} с; очередь p50 {backlogP50}, p99 {backlogP99}, максимум
{backlogMax} кадров, выше 1000 — {shareOverAutocheckpoint×100} % замеров; файл журнала не больше {walFileMaxFrames}
кадров ({walFileMaxBytes} байт). Вывод: {один из двух абзацев ниже}.
```

The conclusion is one of these two, chosen by the numbers, never both:

```text
пик очереди около 1000 кадров — верх «пилы» автоматической контрольной точки: она срабатывает, переносит журнал и он
начинается сначала каждые несколько секунд; явная контрольная точка при такой нагрузке не нужна. Порог 8000 кадров
остаётся сторожем на случай, если контрольные точки перестанут успевать (долгое чтение, копия).
```

```text
автоматическая контрольная точка не успевает: журнал {не перезапускался / перезапускался реже, чем раз в N с}, и
файл вырос до {walFileMaxFrames} кадров. Это вопрос владельцу: явная контрольная точка (`PRAGMA wal_checkpoint` в
хосте, по таймеру или после пакета) — отдельное изменение хоста, в этом плане не делается.
```

The first fits when `restarts > 0`, `longestWithoutRestartS` is a few seconds to tens of seconds, `backlogMax` is at most about 1000 plus one batch's frames and `shareOverAutocheckpoint` is small; the second when the log did not restart for most of the run or its file kept growing. If the numbers fit neither cleanly, write what they are and say that the conclusion is open. Copy the same numbers and the conclusion, in English, into the task's report for the controller.

- [ ] **Step 9: Commit.**

```bash
git -C "$WT" add apps/standalone/loadtest/src/wal_watch.rs apps/standalone/loadtest/src/lib.rs apps/standalone/loadtest/src/report.rs apps/standalone/loadtest/src/run.rs docs/runbooks/standalone-load-test.md
git -C "$WT" commit -m "feat(loadtest): WAL watch of the main run and the measured checkpoint finding

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 13: The runbook and the scoped guide, acceptance runs and the final gates

**Files:**

- Modify: `docs/runbooks/standalone-load-test.md`, `apps/standalone/AGENTS.md`

**Interfaces:** none (documentation, runs and gates).

- [ ] **Step 1: Acceptance runs (no soak).** Release build as in Task 12 Step 7, then four runs with every scenario (the default for `tiny` and `smoke`), results outside the repository:

```bash
B="$WT/apps/standalone/target/release/markiro-loadtest"
"$B" run --profile tiny --host in-process --out "$HOME/markiro-load"
"$B" run --profile tiny --accept-network-exposure --out "$HOME/markiro-load"
"$B" run --profile smoke --host in-process --out "$HOME/markiro-load"
"$B" run --profile smoke --accept-network-exposure --out "$HOME/markiro-load"
```

Expected: each prints its summary with a `## Scenarios` section. In-process runs: nine scenarios, seven `held`, `kill-restart` and `outage` `not judged (needs a host this harness spawned …)` and two matching warnings. Spawned runs: nine `held`. Each exits 0 unless a threshold or a check failed. For every run note: the verdict, the main run's figures (facts p99, scans, checks held), each scenario's checks and duration, `observed` of `closed-part`, `close-races`, `backup-mid-close`, `kill-restart` and `outage`, the scenario notes, and `walWatch`. A failing latency threshold is recorded with its report path; a failing correctness check, a scenario's included, is a defect: stop, keep the folder (`--keep-data` is implied for a failing run), report the check's name, detail and the folder.

Also run the ignored tests once (sandbox off):

```bash
cargo --offline --locked test --manifest-path "$WT/apps/standalone/Cargo.toml" -p markiro-loadtest --test self_run -- --ignored
cargo --offline --locked test --manifest-path "$WT/apps/standalone/Cargo.toml" -p markiro-loadtest --lib scenarios:: -- --ignored
```

Expected: `self_run` 2 passed; the spawned `kill_restart` and `outage` tests pass. Then check nothing is left behind: `pgrep -f "markiro-host run"` prints no process of these runs (it only lists), and `ls "$HOME/markiro-load"/*/scenarios` shows folders only for runs that failed.

- [ ] **Step 2: The runbook.** In `docs/runbooks/standalone-load-test.md`:

(a) In the second paragraph («**Что доказано на сегодня.**…»), after its first sentence add:

```text
С плана 2026-10-22 после основного прогона идут девять сценариев нескольких станций (п. 6а), каждый на своём
свежем хосте; два из них (`kill-restart`, `outage`) судятся только с `--host spawn`.
```

(b) In §5, replace `4 станции и 2 ТСД по 5 сканов/с, 3 минуты, затем закрытия, шесть сценариев (п. 6), последняя копия и восстановление.` with:

```text
4 станции и 2 ТСД по 5 сканов/с, 3 минуты, затем закрытия, шесть сценариев завершения (п. 6), последняя копия и
восстановление, затем девять сценариев нескольких станций (п. 6а, около двух-трёх минут). Без них:
`--set scenarios=none`; только некоторые: `--set scenarios=line-full,lines`.
```

(c) After §6 add a new section:

```text
## 6а. Сценарии нескольких станций

Каждый сценарий — на своём свежем хосте и своей площадке (папка `scenarios/<имя>/` рядом с отчётом; при успехе
удаляется), со своими метриками: его намеренные отказы (409, 401, оборванные соединения) не попадают в пороги
основного прогона, его задержки записываются, но не судятся. Проверки сценария — проверки правильности: провал —
дефект хоста или теста, его разбирают, а не подгоняют.

| Сценарий           | Что доказывает                                                                                                                                                                                                       |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `line-full`        | на линии с лимитом 3 одновременно входят 4 устройства под нагрузкой соседней линии: входят ровно 3, четвёртое получает `shift_line_full` с `maxStations` и `active`; выход освобождает место; отозванное устройство места не держит, но его открытая часть не даёт сменам закрыться без офиса |
| `capability`       | сборка без `multi-station-v1`: открывает плановую смену одна; в чужую смену получает `shift_busy` (даже когда в ней никого нет); вернувшись из выхода, входит; с закрытой частью получает «смена закрыта», хотя смена идёт; `protocol_unsupported` — только про версию протокола |
| `leave-reenter`    | выходы и возвраты под нагрузкой: место освобождается, устаревший выход ничего не меняет, число входов и выходов в журнале аудита и состояния частей точны, сверка точна |
| `closed-part`      | закрывшая свою часть станция продолжает сканировать: факты приняты, посчитаны, часть помечена «поздние данные» и не открывается; два последних закрытия в одно мгновение: смену закрывает ровно одно, время закрытия — позднее из двух, причина — по правилу последнего закрывшего |
| `close-races`      | шесть закрытий разом — одно закрывает смену, пять свои части; закрытие из офиса наперегонки с закрытием части: только «офис первым» или «устройство первым», третьего не бывает |
| `lines`            | три линии с разными лимитами и тремя сменами разом: чужая смена не принимает вход и факты, итоги каждой смены свои; реестр кодов общий на площадку (поздний скан на другой линии — конфликт, ранний — забирает код) |
| `backup-mid-close` | копия, снятая посреди закрытий, согласована, восстанавливается, и хост на ней отвечает теми же состояниями; копия в покое восстанавливается целиком |
| `kill-restart`     | только `spawn`: хост убит (`SIGKILL`) посреди записи и перезапущен на тех же данных: база цела, ни одна подтверждённая запись не потеряна, повторы устройств дают те же квитанции и не пишут дважды |
| `outage`           | только `spawn`: хост остановлен под нагрузкой: устройства повторяют с нарастающей паузой, не сдаются, после возврата очереди сходятся точно |

С `--host in-process` (и в workflow GitHub) `kill-restart` и `outage` помечены «не судится» с предупреждением; с
`--host attach` не судится ни один сценарий.
```

(d) In §7's list of profile fields, after `closeOrder` add `, scenarios` (so the list ends `` `sampleS`, `seed`, `closeOrder`, `scenarios` ``).

(e) In §8's table add one row per acceptance run of Step 1 (the measured figures; `scenarios` = how many held / judged), e.g. `| tiny, \`in-process\`, со сценариями (план 2026-10-22) | {сканы}, факты p99 {…} мс, {N} из {M} проверок, сценарии: 7 выдержаны, 2 не судились |`, and likewise for the other three runs. Write the numbers measured, not these words.

(f) In §10's table add the rows:

```text
| `scenario <имя> <проверка>`                                           | сценарий нескольких станций нашёл расхождение с правилом хоста: имя проверки и её `detail` в отчёте, папка `scenarios/<имя>/` сохранена (данные, журнал хоста); правило — в плане 2026-10-22, E7 |
| `scenario <имя> not judged`                                           | предупреждение: сценарию нужен `--host spawn` (`kill-restart`, `outage`) или режим `attach`; не провал |
| `the WAL never started again`                                         | предупреждение `walWatch`: журнал не перезапускался больше минуты — контрольная точка не догоняла; смотрите `walWatch.findings` и п. 8 |
```

(g) In §14, replace the whole list under `**Не упражнено нагрузкой (этих путей в прогоне нет, даже если у части есть модульные тесты):**` (the seven bullets) with:

```text
**Упражнено сценариями (п. 6а), а не основным прогоном:** отказ `shift_line_full` и отозванные устройства; сборка
без `multi-station-v1`; выход и повторный вход под нагрузкой; закрытая часть, которая присылает факты, и два
последних закрытия разом; шесть закрытий разом и закрытие из офиса наперегонки; три линии и три смены разом; копия
и восстановление посреди закрытий; с `--host spawn` — убийство хоста посреди записи с восстановлением WAL и
остановка хоста с повторами устройств.

**Остаётся не упражнённым:**

- ответ хоста 5xx: его нельзя вызвать без изменения хоста или второго писателя базы; повторы устройств проверены только
  на отказе соединения (хост остановлен или убит);
- повторы с нарастающей паузой — это модель устройства в тесте (`device.rs`), а не клиент станции или ТСД;
- потеря питания: `kill -9` — авария процесса, а не диска (с `synchronous=FULL` подтверждённое на диске в обоих случаях,
  но это не проверено);
- повтор пакета, ответ на который потерян при аварии, зависит от того, попало ли убийство внутрь коммита: если в
  прогоне не попало, отчёт `kill-restart` говорит это в `note`;
- `kill-restart` и `outage` не судятся в `in-process` и в workflow GitHub;
- копия «посреди закрытий» могла оказаться до первого или после последнего закрытия (`observed.partsClosedInTheCopy`
  0 или 6): тогда середина не упражнена в этом прогоне.
```

(h) In §15's checklist, after the item about §14 add:

```text
- [ ] сценарии нескольких станций (п. 6а) выдержаны на smoke с `--host spawn` (девять из девяти), отчёт приложен
- [ ] вывод про контрольные точки WAL (п. 8, «Очередь WAL: измерение») прочитан; решение про явную контрольную точку принято
```

- [ ] **Step 3: The scoped guide.** In `apps/standalone/AGENTS.md`, section `## Load and soak harness`:

(a) After the sentence ending `(\`probes.rs\`).` in the first paragraph add:

```text
After the main run, nine multi-station scenarios (`scenarios/`, plan `docs/superpowers/plans/2026-10-22-multi-station-load-test-scenarios.md`) run one by one, each on a fresh host and site in the run's host mode with its own metrics (its deliberate 409/401/refused connections never reach the main thresholds; its latencies are recorded, not judged): `line-full`, `capability`, `leave-reenter`, `closed-part`, `close-races`, `lines`, `backup-mid-close`, and, with `--host spawn` only, `kill-restart` and `outage` (not judged in-process or attached: a verdict warning). A failed scenario check is a correctness failure. `Profile.scenarios` (`--set scenarios=all|none|a,b`): all for tiny and smoke, none for soak. A file-only WAL observer (`wal_watch.rs`, 100 ms, the WAL header's checkpoint sequence and the wal-index) adds `walWatch` to the report; the harness never checkpoints.
```

(b) Replace the bullet that begins `- Not simulated: label checks,` with:

```text
- Not simulated: label checks, box exceptions, validation shifts, disaggregation, warehouse pallets, the handheld's warehouse and
  pallet-event routes, printers, scanners, a real LAN, the Windows service. Exercised by the scenarios, not by the main load:
  `shift_line_full` and revoked devices, a build without `multi-station-v1` (the host answers `shift_busy`, and `shift_status` for a
  closed part, never `protocol_unsupported`, which is only about the protocol header), leave and re-entry under load, late facts of a
  closed part and two closers at once, N closes at once and the office racing a device, three lines and shifts at once, a copy in the
  middle of the closes, and on a spawned host a `kill -9` with WAL recovery and a stop with device back-off. Still not exercised: a host
  5xx (not inducible without a host change), the stations' and handhelds' own back-off (the harness's device model is), a power cut,
  the process scenarios in-process or in the workflow. Windows-only and unverified: reading `host.db-shm`, retry of the restore's
  `os error 32`, PowerShell vitals, restarting a host on the same port. `soak`, `attach`, Linux and the workflow have never run.
```

(c) Replace the bullet that begins `- Observed (one macOS debug build, in-process host): smoke 180 s,` with one that keeps its first sentence and replaces the backlog sentences by the finding of Task 12 in one line (the measured restarts and backlog quantiles, and the conclusion), and adds the scenario runs of Step 1 (nine held with spawn, seven judged in-process).

- [ ] **Step 4: Final gates.**

```bash
cargo fmt --all --manifest-path "$WT/apps/standalone/Cargo.toml" -- --check
cargo --offline --locked test --manifest-path "$WT/apps/standalone/Cargo.toml" --workspace --no-fail-fast
git -C "$WT" diff --check
pnpm --dir "$WT" --config.verifyDepsBeforeRun=false exec prettier --check docs/runbooks/standalone-load-test.md apps/standalone/AGENTS.md docs/superpowers/plans/2026-10-22-multi-station-load-test-scenarios.md
```

Expected: `fmt` prints nothing; the workspace tests end with `test result: ok` for every crate (sandbox off; the scenario tests take a few minutes; ignored tests are reported as ignored); `git diff --check` prints nothing; prettier reports the three files formatted (fix with `--write` on those paths only if not). CI routing is unchanged (no new crate, no new path outside `apps/standalone/loadtest/` and the two docs, which `tools/ci/affected.mjs` already routes), so `node --test tools/ci/test/*.test.mjs` is not needed; say so in the report. `cargo clippy` is not a gate. If `graphify-out/graph.json` exists in the worktree, run `graphify update .`.

- [ ] **Step 5: Commit.**

```bash
git -C "$WT" add docs/runbooks/standalone-load-test.md apps/standalone/AGENTS.md
git -C "$WT" commit -m "docs(standalone): load-test runbook and guide — the multi-station scenarios and the WAL finding

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 6: The report.** List: behaviour changed (nine scenarios, the WAL watch, schema 2), files, automated checks and results (unit and in-process scenario tests, ignored spawned tests, `self_run`), the four acceptance runs with their figures and paths, the WAL finding, every host finding a scenario raised (none expected; each with its check, detail and kept folder), and what was not exercised: Windows, a real LAN, real stations and handhelds, a soak, a power cut, a host 5xx, the process scenarios in-process, the GitHub workflow.

---

## Self-review

**Spec coverage (the task's list):**

| Asked                                                                                                                                                             | Where                                                                                                                                                                                        |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. `shift_line_full`: N + 1 concurrent entries under load, exact details, leave frees, revoked holds no slot, `open_others` still counts it                       | Task 4 (`line-full`): barrier burst, `refusal_names_the_limit` / `_slots_held`, leave, revoke (401, slot free, part open, closes `partClosed`, office closes it), lower limit refused        |
| 2. A device without `multi-station-v1`; what the host does with reads                                                                                             | Task 5 (`capability`), behaviours read from `decide_entry` / `enter_shift` (E7): `shift_busy`, `shift_status` for a closed part, reads not gated, `protocol_unsupported` only for the header |
| 3. Leave then re-entry under load, stale-token no-op, slot freed, counts and states, exact ledger                                                                 | Task 6 (`leave-reenter`)                                                                                                                                                                     |
| 4. Closed part receiving live facts; last closer under concurrency, `partClosed=false` once, MAX `closed_at`, reason rule                                         | Task 7 (`closed-part`), with three scripted repetitions of the race                                                                                                                          |
| 5. N closes at once; office forced close racing a device                                                                                                          | Task 8 (`close-races`)                                                                                                                                                                       |
| 6. 2–3 lines, own shifts, different limits, isolation                                                                                                             | Task 9 (`lines`): three lines (limits 2, 3, 1), per-shift ledgers, `shift_line`, `not_entered`, the site-wide registry                                                                       |
| 7. Backup/restore mid-close                                                                                                                                       | Task 10 (`backup-mid-close`)                                                                                                                                                                 |
| 8. Spawned-only process faults: kill -9 + restart + WAL recovery + resend; graceful restart; device back-off; skip in-process with a warning; kill only own child | Task 11 (`kill-restart`, `outage`, `Host::kill_hard` / `restart`), E4, E8, Task 3's `stop` guard                                                                                             |
| WAL backlog decision, measured precisely, no host change, read-only checkpoint question                                                                           | Task 12, E10                                                                                                                                                                                 |
| Runbook and AGENTS updates, acceptance tiny/smoke in-process and spawn, final gates                                                                               | Task 13                                                                                                                                                                                      |
| Wired into report checks, run, CLI, profiles                                                                                                                      | Tasks 1 and 3 (`ScenarioResult`, verdict, Markdown, `run_all`, `--set scenarios=`, presets)                                                                                                  |
| Secrets redacted                                                                                                                                                  | Task 1 (redaction reaches scenario checks), Task 3 (scenario secrets joined), Task 4 (`self_run` finds the scenario's password among them)                                                   |

**Placeholder scan:** every code step holds the whole code; the only filled-in-later text is the runbook's measured numbers (Task 12 Step 8, Task 13 Step 2e, 3c), which cannot be known before the runs and are named by their report fields.

**Type consistency:** `Ctx::enter(&DeviceSpec, &str, Option<Vec<&'static str>>)` is called with `Some(device.supports())` (`Vec<&'static str>`), `Some(Vec::new())`, `Some(vec!["multi-station-v1"])` and `None`; `Load::of(usize) -> &Arc<SimDevice>`; `close_part_ledgered(Option<u32>, Option<&str>, Option<String>)`; `close_fact(ctx, device, shift, salt, planned, actual, boxes, reason, closed_at)` and `close_record(shift, device, salt, planned, actual, boxes, reason, closed_at)` keep one argument order; `dbcheck::participants_in` takes `&[(u32, String, &str)]` everywhere; `reconcile(&Ctx, prefix, shift, &Shared, &[Arc<SimDevice>])` is called with `&Arc<Shared>` and `&Vec<_>`, both coercing. `SCENARIOS` grows by exactly one task each (two in Task 11) and ends with the nine names `SPAWN_ONLY` and the runbook use.

**Known risks for the executor:** the code was not compiled at planning time (header); `Ctx::finish` checks `host_log_error_lines == 0` for a spawned host in every non-fault scenario, so an ERROR line the host logs for a deliberate refusal would fail it — if that happens, read the line: a refusal the host logs as ERROR is itself worth reporting (refusals are `WARN` in `facts::receive`); the outage bound assumes the device back-off of `device.rs` (250 ms doubling to 2 s, flush every `flushMs`); `backup-mid-close` may not land inside the closes on a fast machine (recorded in `observed`, Task 10 Step 4).
