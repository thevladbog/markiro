# Signer agent — manual end-to-end verification

The signing path cannot be exercised in CI: it needs CryptoPro CSP, a GOST
certificate with a private key, and a live True API sandbox account. Run this
once per release candidate on a Windows machine that has all three.

**Before the first manual session:** `signer_capi.rs`, `storage_dpapi.rs`, and
`signer_cades.rs` are Windows-only (`#[cfg(windows)]`) and have never been
executed — not by their author, not anywhere. They were written on macOS,
where that `cfg` arm is not even compiled, so the `signer-windows-build` CI job
(`.github/workflows/ci.yml`) is the first thing that compiles them at all, and
this manual session is the first thing that runs them. Check that job is green
before scheduling a manual session; a red `signer-windows-build` is the
expected first signal of a problem, and it is cheaper to fix there than to
discover the same failure by hand.

## Known limitations (as built, not as originally specced)

- **Updates never install themselves.** The agent checks the mirror at startup
  and once a day, announces an available version in the tray once, and then
  waits: nothing downloads or installs until the operator presses the button in
  the window. This is by design — installing restarts the agent, and the agent
  is what keeps the tenant's token fresh. See
  [`signer-release.md`](signer-release.md) for cutting a release and for
  verifying the update path end to end.
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

## The updater signing key

Done, and not to be redone. The minisign keypair exists: the public half is
committed as `plugins.updater.pubkey` in
`apps/signer/src-tauri/tauri.conf.json`, and the private half and its password
are secrets in the `station-release` GitHub environment
(`SIGNER_TAURI_SIGNING_PRIVATE_KEY`, `SIGNER_TAURI_SIGNING_PRIVATE_KEY_PASSWORD`).

Regenerating the keypair strands every already-installed agent — an agent only
accepts updates signed by the key it shipped with — so treat the committed
public key as fixed. Rotating it is a migration, not a config change.

None of this is needed for the manual sandbox verification below, which builds
with plain `tauri build` and never produces a signed updater artifact. It
matters only for the release workflow; see
[`signer-release.md`](signer-release.md).

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

## СУЗ: token and detached signature (sandbox)

This plan taught the agent two things no test here can reach: obtaining a СУЗ
client token through `simpleSignIn`, and producing a **detached** GOST
signature over exact bytes for `X-Signature`. Both signing backends changed —
CryptoAPI (`signer_capi.rs`, default) and CAdESCOM (`signer_cades.rs`,
selected by `MARKIRO_SIGNER_BACKEND=cades`) — and **this session is their
first execution, ever, by anyone**. No job runs them: the Windows CI job
compiles both arms and runs `cargo test`, but no test calls `CryptSignMessage`
or `SignCades`. A failure here is a code failure until proven otherwise, not
an environment quirk. This run is the only evidence that will exist for that
code before it reaches a customer, and the person doing it may not be the
person who wrote it.

**Do, in order:**

1. Install a build from **this branch** — step 1 of «Steps» above, then the
   NSIS package — even if an agent is already installed and paired. An older
   binary cannot deserialize an `oms_auth` or `sign_detached` envelope; it
   reports nothing, and the run dies at step 5 below looking like a cloud
   fault.
2. Pair the agent with a sandbox tenant using steps 2–4 above (pairing code,
   certificate selection). Skip this if the agent is already paired to the
   tenant you are using; step 1 is not optional either way.
3. Register an installation for Markiro with СУЗ. Either register it through
   the СУЗ sandbox cabinet's own interface — the path a tenant without
   partner status would take — or call
   `POST https://suz-integrator.sandbox.crptech.ru/api/v3/integration/connection?omsId={omsId}`
   (`omsId` is your own СУЗ operator identifier from the cabinet's settings)
   with the header `X-RegistrationKey: 4344d884-7f21-456c-981e-cd68e92391e8`
   (the public sandbox registration key every participant may use) and a
   **detached** signature of the request body in `X-Signature`. Record the
   `omsConnection` the response returns.
4. Enter `omsId` and `omsConnection` in the cabinet's Chestny ZNAK channel
   settings.
5. Wait for the scheduler's `oms_auth` task — up to 15 minutes: it is the same
   cron tick step 5 of «Steps» above names. To skip the wait, delete the
   tenant's `chz_oms_tokens` row so the next tick enqueues a task immediately.
   Confirm «СУЗ token delivered» in the agent's journal, and the СУЗ token row
   in the cabinet's signer panel.
6. Place a two-code order. In the cabinet open **Заказы кодов → Заказ кодов
   маркировки**, pick a product whose GTIN belongs to a Chestny ZNAK group
   with a single СУЗ UNIT template (beer, template 18, is the shortest path —
   a group with several UNIT templates is refused by preflight), set
   **Количество кодов** to `2`, and submit. Confirm «Detached signature
   delivered» in the agent journal.
7. Watch the order card's **Ход заказа** timeline. The expected sequence is
   Создан → Подписание → Отправлен в СУЗ → Ожидание буфера → Буфер готов →
   Получение кодов → Завершён; the runner polls, so this takes minutes rather
   than seconds. Record which step the order sat in longest, and the buffer
   expiry the card shows («Заказ в СУЗ действует до …»). A stall in
   Подписание is the agent, not СУЗ: the signer task is visible in the signer
   panel.
8. Export one code as TXT. Press **Выгрузить**, ask for `1` code, choose
   **TXT**, and download. Check that the file holds exactly one line, that the
   code carries the GS1 group separator (the byte СУЗ sends as the JSON escape
   `\u001d`), and that **Доступно к выдаче** on the card dropped from 2 to 1
   while **Выдачи кодов** gained a row with the range. Do not paste the code
   itself into this document or into an issue — a marking code is a sellable
   asset; record its shape (length, the AIs present, the separator) instead.
9. Print the remaining code as one label. Press **Печать**, ask for `1` code,
   accept the preselected «Этикетка КМ» template, and submit. A new tab opens
   with exactly one page. Record:
   - that the page size in the browser's print dialog matches the template's
     millimetre size (the on-screen note names it) and that «поля: Нет» gives
     one label per page with no second blank page;
   - that the printed DataMatrix scans back on a real scanner as a valid KM
     for this order's GTIN;
   - that **Доступно к выдаче** is now 0 and a second **Печать** is refused
     with «Свободных кодов в этом заказе не осталось».
10. Repeat steps 6–9 with `MARKIRO_SIGNER_BACKEND=cades` set before launching
    the agent, to exercise the CAdESCOM backend. Both backends changed and
    neither has been executed, so both must be run — do not skip the second
    pass because the first one worked.

**What to record**, because this run is the only evidence that exists for
code no test can reach:

- whether СУЗ accepted the CryptoAPI detached signature, and separately the
  CAdESCOM one;
- any HTTP 413 from СУЗ — that specific code means an attached signature
  reached `X-Signature` instead of a detached one;
- whether a rejected order's `rejectionReason` matches what the cabinet
  displays in «СУЗ отклонил заказ»;
- whether `GET /codes` honours the 10 000-code block size the runner asks for
  (`CODES_BLOCK_SIZE`), or returns fewer codes per call;
- whether the sandbox validates the GTIN against the National Catalogue
  before accepting the order;
- the four request/response shapes below.

### Response shapes to record

Note that three different sandbox hosts are involved, and that the first block
below is not observed in the same place as the other three:

- the installation is registered at `https://suz-integrator.sandbox.crptech.ru`
  (step 3);
- the **first block**, `POST {trueApiBaseUrl}/auth/simpleSignIn/{omsConnection}`,
  is called by the **agent** on the Windows machine against the True API host
  (`CHZ_TRUE_API_BASE_URLS`), not by the cloud — watch the agent, not the API;
- the other three blocks are called by the **cloud** against
  `https://suz.sandbox.crptech.ru/api/v3` (`CHZ_OMS_BASE_URLS`).

Both constants live in `apps/api/src/modules/signer-agents/chz-constants.ts`.

Fill the four blocks in during the run and commit them filled. They are
placeholders, not observations: until somebody replaces them, this section
records nothing. Paste bodies verbatim **except** for values that are secrets,
assets or personal data — replace each of the following with `<redacted>` and
describe its shape instead (length, character set, whether the token is
UUID-shaped):

- the СУЗ token and any raw marking code;
- any `X-Signature` base64;
- `attributes.contactPerson` in the order body — it is a real person's name;
- `omsId` and `omsConnection`, in the bodies and in the request lines alike.

```text
POST {trueApiBaseUrl}/auth/simpleSignIn/{omsConnection}
request body:   <paste, with the signed challenge data redacted>
HTTP status:    <...>
response body:  <paste; "token" redacted — is it UUID-shaped? yes/no>
expiry field:   <name and format, or "none — only the documented 10 hours">
```

```text
POST {suzBaseUrl}/order?omsId={omsId}
X-Signature:    <detached CMS, base64 — redacted>
request body:   <paste the exact bytes the agent signed>
HTTP status:    <...>
response body:  <paste — omsId / orderId / expectedCompleteTimestamp,
                 plus any field the client does not read>
```

```text
GET {suzBaseUrl}/order/status?omsId={omsId}&orderId={orderId}&gtin={gtin}
HTTP status:    <...>
response body:  <paste one PENDING and one ACTIVE reply: bufferStatus,
                 availableCodes, leftInBuffer, totalPassed, expiredDate
                 (Unix ms?), rejectionReason when rejected>
```

```text
GET {suzBaseUrl}/codes?omsId={omsId}&orderId={orderId}&gtin={gtin}&quantity={n}
HTTP status:    <...>
response body:  <paste with every code redacted: how many codes came back for
                 the quantity asked, whether "blockId" is present and what
                 shape it has, and whether the codes carry the group
                 separator as the JSON escape \u001d>
```

Write the group separator in this document only as the escape sequence
`\u001d`. A literal separator byte pasted into Markdown is invisible, survives
review, and has already had to be removed from this branch three times.

| Date | Backend | simpleSignIn | order | order/status | codes | Export TXT | Print 1 label |
| ---- | ------- | ------------ | ----- | ------------ | ----- | ---------- | ------------- |
|      |         |              |       |              |       |            |               |

A green host-only `cargo test` proves the runtime loop — task dispatch, retry
classification, journal wording — and nothing about CryptoAPI, DPAPI,
CAdESCOM or a real certificate. Only this run does.
