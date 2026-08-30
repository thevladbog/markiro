# Signer agent — manual end-to-end verification

The signing path cannot be exercised in CI: it needs CryptoPro CSP, a GOST
certificate with a private key, and a live True API sandbox account. Run this
once per release candidate on a Windows machine that has all three.

**Before the first manual session:** `signer_capi.rs`, `storage_dpapi.rs`, and
`signer_cades.rs` are Windows-only (`#[cfg(windows)]`) and have never been
compiled or executed anywhere except locally by their author — the
`signer-windows-build` CI job (`.github/workflows/ci.yml`) is the first thing
that builds and tests them on a real Windows runner. Check that job is green
before scheduling a manual session; a red `signer-windows-build` is the
expected first signal of a problem, and it is cheaper to fix there than to
discover the same failure by hand.

## Known limitations (as built, not as originally specced)

- **No auto-update check yet.** The updater plugin is registered and the release
  workflow produces signed artifacts, but nothing in the app calls the updater's
  check/download/install APIs. Today "auto-update" only means the artifacts exist —
  getting a fix onto a customer machine still requires manually shipping a new
  installer, not a self-triggered update.
- **The local journal is in-memory, not a rolling file.** It holds the last 200 entries
  and is empty again after any restart (crash, update, reboot, `Отвязать агента`). If an
  incident happened overnight and the process restarted since, the journal cannot answer
  "what happened" — only the cloud's `integration_sessions` / `integration_events` audit
  can, for whatever the agent successfully reported before failing.

## Prerequisites

- Windows 10/11 with CryptoPro CSP installed and a valid test certificate in
  the current user's **Личное / MY** store.
- A Markiro tenant with the Chestny ZNAK integration enabled and its
  `environment` setting set to `sandbox`.
- `CHZ_TOKEN_ENCRYPTION_KEY` configured on the API instance, otherwise the
  scheduler pauses and no task is ever enqueued.

## One-time setup: the updater signing key

The app ships with a placeholder `plugins.updater.pubkey` value
(`REPLACE_WITH_SIGNER_MINISIGN_PUBLIC_KEY`) in
`apps/signer/src-tauri/tauri.conf.json`. This is intentional: generating and
holding the updater's private key is a product-owner action, not something an
agent session should do, because whoever runs the keygen command ends up
holding (even briefly) the private key material and must be the one who
stores it as a repository secret. Do this once, before the first signed
release build (it is not required for the manual sandbox verification below,
which only needs `tauri build`, not a signed updater artifact):

1. Run, on a trusted machine, from the repo root:

   ```bash
   pnpm --filter @markiro/signer exec tauri signer generate -w ~/.markiro/signer-updater.key
   ```

   This prints a public key and writes the private key + password to
   `~/.markiro/signer-updater.key` (and prompts for or generates a password —
   keep it).

2. Replace `REPLACE_WITH_SIGNER_MINISIGN_PUBLIC_KEY` in
   `apps/signer/src-tauri/tauri.conf.json` (`plugins.updater.pubkey`) with the
   printed public key, and commit that change on its own.

3. Store the private key file's contents and its password as two GitHub
   repository secrets, never committed:
   - `SIGNER_TAURI_SIGNING_PRIVATE_KEY` — the contents of
     `~/.markiro/signer-updater.key`.
   - `SIGNER_TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — the password chosen in
     step 1.

4. Delete the local private key file once it is safely stored, or keep it in
   a password manager — do not leave it on disk on a shared machine.

Until this is done, `tauri.stable.conf.json` and `tauri.conf.json` correctly
have no working updater signature, and
`apps/signer/test/tauri-release-config.test.ts` is written to pass either way
(it only asserts that a pubkey string is present in the base config, not that
it is real).

## Steps

1. Build the agent: `pnpm turbo build --filter '@markiro/signer...'` then
   `pnpm --filter @markiro/signer tauri build`. Install the NSIS package.
2. In the Markiro cabinet open **Интеграции → Честный ЗНАК** and press
   **Получить код привязки**.
3. In the agent's tray window enter the eight-digit code. Expect the tenant
   name to appear within a few seconds.
4. Choose the GOST certificate in the picker. The list only shows certificates
   with a private key and a GOST public key.
5. Force a refresh: in the cabinet, revoke nothing — instead wait for the
   scheduler (runs every 15 minutes) or delete the tenant's `chz_api_tokens`
   row so the next tick enqueues a task immediately.
6. Watch the agent journal. A healthy run reads: _Task received_ → _True API
   token delivered_.
7. Confirm in the cabinet that the token status shows **действует** with an
   expiry roughly ten hours out.
8. Open the agent's row in the cabinet (Интеграции → Честный ЗНАК → agent
   list) and read back **hostname**, **certSubject**, and **certInn**.
   Confirm all three look like real values, not placeholders or artifacts:
   - `hostname` is the actual machine name (e.g. `BUH-PC`), never
     `tauri.localhost` or any other webview-origin-shaped string.
   - `certSubject` is the certificate's real X.500 subject line, not
     truncated mid-word at a suspicious length.
   - `certInn` is a plausible 10-digit (legal entity) or 12-digit
     (individual entrepreneur) INN — in particular, a legal-entity INN must
     not be silently zero-padded to 12 digits (e.g. `007712345678` instead
     of `7712345678`).

   This step is what would have caught two release-blocking bugs that
   otherwise only show up as quietly wrong data in the cabinet with no error
   anywhere: the agent registering under the webview's origin instead of the
   real machine name, and a zero-padded legal-entity INN passing validation
   as a bogus 12-digit INN.

## The signature-format verdict

Step 6 is the decision point for the signing backend. Both backends already
ship in this codebase — `signer_capi.rs` (CryptoAPI, `CryptSignMessage`,
selected by default) and `signer_cades.rs` (CAdESCOM, selected by setting the
environment variable `MARKIRO_SIGNER_BACKEND=cades` before launching the
agent; see `signer_backend.rs`). CAdESCOM additionally requires the CryptoPro
CAdES SDK / browser plug-in installed on top of the CSP. There is no code to
write here — this step is purely about recording which backend ГИС МТ
actually accepts:

- **`True API token delivered`** — the current backend's signature was
  accepted. Record which backend that was (CryptoAPI is the default; only
  count as CAdESCOM if `MARKIRO_SIGNER_BACKEND=cades` was set for this run)
  and the verdict below. No further action needed.
- **`Signing failed` with a `TRUE_API` code mentioning the signature** — the
  attached-CMS shape from CryptoAPI was rejected. Set
  `MARKIRO_SIGNER_BACKEND=cades` (confirm the CAdES SDK is installed), repeat
  from step 5, and record the second attempt's verdict as well. If CAdESCOM
  is also rejected, stop and escalate — do not extend or fork the signing
  code as part of this runbook.

Record the date, the CryptoPro version, and the verdict below.

| Date | CryptoPro version | Backend | Verdict |
| ---- | ----------------- | ------- | ------- |
|      |                   |         |         |

## Failure cases worth exercising

- Pull the Rutoken mid-run: the journal must show
  `CRYPTO_CONTAINER_UNAVAILABLE` and the cabinet journal must show the same
  code — not a generic error.
- Revoke the agent in the cabinet: the tray window must return to the pairing
  screen on the next poll, and `%APPDATA%\app.markiro.signer\signer.json` must
  no longer contain `agentSecretProtected`.
- Stop the API: the agent must back off and recover on its own once the API
  returns, without failing the claimed task.

## Chestny ZNAK inventory exports — two questions only the sandbox can settle

Both are unverifiable from the repository, and each is isolated to one place
so that settling it changes one line rather than a design.

### 1. Is `PACKAGE_TYPE` the value `FILTERED_CIS_REPORT` expects?

`apps/api/src/modules/chz-exports/true-api.client.ts` sends
`packageType: "UNIT"` inside the string-encoded `params` of a dispenser task.
`packageType` is required, and it selects the packaging level the report
covers; the cabinet export operators use today is the unit-level one, which is
what an inventory counts. The exact enum spelling is not published in a form we
could verify.

**Do:** order one export for a real inventory against the sandbox.

**Pass:** `POST dispenser/tasks` returns a task id.

**Fail:** ЧЗ answers 4xx and its message names the field. The run lands in
`chz_export_runs` as `failed` with `errorCode = 'CHZ_TASK_REJECTED'` and the ЧЗ
text in `errorMessage`, which the inventory screen shows verbatim. Change the
`PACKAGE_TYPE` constant and nothing else.

### 2. Is the dispenser's CSV byte-identical to the cabinet export?

The importer is shared with manual upload deliberately, and its parser compares
the 35-column header character by character. The dispenser almost certainly
uses the same generator as the cabinet export, but "almost" is not a guarantee.

**Do:** let a successful export run through to import.

**Pass:** the run reaches `imported` and its file appears in the status slot on
the inventory screen exactly as a hand-uploaded one does.

**Fail:** the run lands `failed` carrying the parser's own diagnostic code
(a header mismatch names the header). The shared parser must stay untouched
either way — manual upload depends on it too, and a fix that changed what it
accepts would silently change the manual path's behavior as well. The
adapter in `chz-export-runner.service.ts` that names the synthesised file
only selects the container kind (`.zip`); it does not touch the bytes handed
to `importEvidence`, so renaming the file again would just repeat the same
diagnostic. If this fails, the fix is for that same adapter to normalise or
repackage the dispenser's archive bytes into the shape the parser expects
before handing them to `importEvidence` — not to touch the parser itself.

### While you are there: can adoption be widened?

`resolveAdoption` in `chz-export-runner.service.ts` recovers a dispenser task
whose create response was lost, but only when the pairing is forced — exactly
one waiting run and exactly one candidate task — because `GET dispenser/tasks`
gives us no filter data to match a task to the status that requested it. The
cost is that a pass with two runs simultaneously awaiting a task id pays for one
task twice.

**Do:** call `GET dispenser/tasks` and record the full response shape.

If it carries the report filter (product group, status, or the `params` the task
was created with), the rule can widen to match on it and the double-pay case
disappears. Note the answer here either way.

## Code status refresh — the response shape of `cises/info`

The refresh job asks Chestny ZNAK about up to 1000 codes per call and records
`status`, `statusEx`, `ownerInn` and `withdrawReason` against each. The exact
field names in the response are not verifiable from the repository, so the
parsing is confined to one function — `TrueApiClient.cisesInfo` — and settling
this changes that function and nothing else.

**Do:** let one refresh pass run for a tenant that has codes. The job runs on a
ten-minute cron and once at boot, so restarting the API is the quickest way to
trigger it.

**Pass:** rows in `chz_code_statuses` move from `status = null` to a real
status, and the Chestny ZNAK integration panel's freshness line reports codes
refreshed in the last day.

**Fail, and how to tell which:**

- _Every code comes back unknown_ — `unknown_attempts` climbs while `status`
  stays null. The response is shaped differently than assumed: the rows are
  arriving but `cis` is not the field the code matches on, so nothing pairs up.
  Fix `cisesInfo`'s parser with the real field names.
- _The whole batch is refused_ — the journal shows a `warn` entry ("Честный
  Знак отказал в запросе статусов кодов") carrying ЧЗ's own message, and the
  affected codes are parked at a 30-day interval. That is a product-group or
  contract problem, not a parsing one; the message names it.
- _Nothing happens at all_ — the journal shows a `warn` entry naming the token
  status. The agent has not delivered a usable token; that is the signer
  runbook above, not this section.

Note that a wrong `pg` surfaces as the second case, not the first — a rejection
rather than silence — so the three are distinguishable from the journal alone
without reading the database.

### While you are here: how big is the population?

The design deliberately left retention and archival out, because the volumes
were unknown. Record them now that a real tenant exists — filtered to that one
tenant, not summed across every tenant in the table, since `chz_code_statuses`
is shared and the volume question is "how big is this tenant's population",
not the platform's:

```sql
select count(*) as total,
       count(*) filter (where chz_product_group_code is null) as unaskable,
       count(*) filter (where status is null) as never_answered
from chz_code_statuses
where tenant_id = '<tenant id>';
```

A tenant in the hundreds of thousands needs nothing further. Millions is the
point at which detaching and archiving an old monthly partition of `codes`
becomes worth designing — and the number in the second column is the one that
needs an operator rather than an engineer, because those codes are unaskable
until their product is given a Chestny ZNAK group. Giving the product a group
does not resolve them instantly: the ingest job re-resolves a null group the
next time that exact code is scanned, or, for a row already sitting in the
table with nothing left to scan it again (e.g. one that only ever arrived
through a bootstrap inventory export), within the next daily full sweep
(`CHZ_CODE_STATUS_FULL_SWEEP_INTERVAL_MS`, currently 24 hours). So the remedy
does reach every row already in the table — just not instantly.
