# GitHub security signals — 2026-09-13

Repository: `thevladbog/markiro`. Reviewed base:
`4d0d2317920feeb07c9112dd4253c225423ea7fe` (`main`, PR #555).

The GitHub APIs returned **11 open CodeQL alerts, one open Dependabot alert,
and no open secret-scanning alerts**. This is an inventory of reported signals,
not a claim that every issue in the repository has been discovered.
The current main CodeQL jobs for JavaScript/TypeScript, Rust and Actions completed
successfully; successful analysis does not mean that it found no issues.
Socket reported success; Debricked reported neutral.

## Changes prepared

| Signals                                                                                                                                               | Finding and change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [CodeQL #24](https://github.com/thevladbog/markiro/security/code-scanning/24), [#27](https://github.com/thevladbog/markiro/security/code-scanning/27) | Billing email names used an unbounded tag-stripping regex before the 120-grapheme limit. Many unmatched `<` characters caused repeated scans. A single pass now removes complete and unfinished tag fragments, then applies the existing whitespace and grapheme rules. React remains responsible for escaping HTML text; no exploitable HTML injection was demonstrated at that boundary.                                                                                                                 |
| [CodeQL #25](https://github.com/thevladbog/markiro/security/code-scanning/25)                                                                         | The CSP contract test built a regex from a pinned script URL. It now parses `script-src` and compares a complete source token literally, covering the exact host, pinned revision and filename. Production CSP is unchanged.                                                                                                                                                                                                                                                                               |
| [CodeQL #28–32](https://github.com/thevladbog/markiro/security/code-scanning/28)                                                                      | Reported sinks are diagnostic assertions/panics in synthetic True API tests. `TrueApiToken` nevertheless exposed its credential through derived `Debug`. Its formatter now redacts the token, including when nested in `Result`. The same protection covers the adjacent `PairRequest`, `PairResponse` and `TaskComplete` credential fields. One assertion no longer prints the provider-returned expiry. Serialization and protocol values are unchanged. No production credential leak was demonstrated. |

No alert has been dismissed, suppressed, or marked fixed manually. A subsequent
GitHub analysis of the published changes must establish the resulting alert state.
The five Rust alerts are grouped by their shared diagnostic-output path; this
report does not assume that the scanner will understand every custom formatter.

## Findings without a safe code change in this patch

### Dependabot #11: glib 0.18.5

[Dependabot #11](https://github.com/thevladbog/markiro/security/dependabot/11)
identifies `glib` in `apps/signer/Cargo.lock`.
[RUSTSEC-2024-0429](https://rustsec.org/advisories/RUSTSEC-2024-0429.html)
requires `glib >=0.20.0` to fix `VariantStrIter` unsoundness.

The locked Linux dependency tree contains GTK 0.18.2 / glib 0.18.5 through
Tauri 2.11.5, WebKit and tray/menu dependencies. GTK's 0.18 requirement cannot
be satisfied by a lockfile-only change to glib 0.20. The
[upstream Tauri manifest](https://github.com/tauri-apps/tauri/blob/dev/crates/tauri/Cargo.toml)
also retains GTK 0.18 at the time of review. A framework migration or maintained
backport needs separate platform verification.

`cargo tree --locked --offline --target x86_64-pc-windows-msvc --invert glib`
has no dependency path for Signer's supported Windows target. The Linux target
does contain the vulnerable library. This target distinction does not remove
the dependency alert. Cargo manifests and lockfiles were not changed.

### CodeQL #26: API-key hashing

[#26](https://github.com/thevladbog/markiro/security/code-scanning/26) applies
a password-hashing rule to `hashStationApiKey` in `TenantGuard`.
These keys are generated by Better Auth, not selected as user passwords.
The current configuration retains the plugin's random 64-character key default;
the plugin stores SHA-256 encoded as unpadded base64url. The guard reproduces
that exact representation for database lookup. Its source and the installed
`@better-auth/api-key` implementation were compared.

The signal is not evidence of weak password storage here. Replacing this with
a password KDF would break existing device authentication. Authentication,
key-generation configuration and stored credentials remain unchanged.

### CodeQL #5: exchange body length

[#5](https://github.com/thevladbog/markiro/security/code-scanning/5) reports
`body.length` in the CommerceML upload journal. Source tracing confirms that
the value is first accepted only by `isRequestBuffer`, which calls
`Buffer.isBuffer`; strings, arrays and plain objects cannot pass that guard.
Query values are separately checked by `singleQueryValue`.

The existing protocol suite verifies repeated parameters, bracket notation,
missing filenames and non-JSON raw payload handling. This remains a source-backed
false-positive assessment, not a newly fixed vulnerability. The helper's existing
comment about CodeQL recognition is not proof: the current analysis still reports
the sink despite the runtime check. No protocol behavior was changed.

### CodeQL #1: historical input IDs

[#1](https://github.com/thevladbog/markiro/security/code-scanning/1) belongs to
the old `.github/workflows/codeql.yml:analyze` analysis at
`8d00334995016eb8c5ad8ba5a5f42d834f0253c3`. The current handoff component already
uses `React.useId()` after merged PR #477. The old alert instance remains open;
there is no remaining `Math.random()` expression to fix in that component.

## Verification

- Email regression tests first failed on unfinished markup and 50,000 unmatched
  `<` characters; the old focused run took 7.08 seconds, including 5.21 seconds
  in tests. After the change, all 27 email tests passed, preserving localized
  content, React escaping, astral characters and combining sequences.
- Two new Rust regression tests first failed because diagnostic strings contained
  synthetic credential markers, then passed with redaction. They also verify
  unchanged JSON credential values for the cloud protocol.
- All 23 edge contracts passed, including actual local Caddy adaptation.
- The isolated local PostgreSQL database was freshly migrated through 0144;
  all 46 selected API tests passed across exchange protocol, tenant guard and
  billing-notification consumers. No database-backed case was skipped.
- Signer frontend: 40 tests, lint, typecheck and production build passed.
- Email lint, typecheck and build passed; API and Signer dependencies were built
  in the isolated worktree before consumer tests.

- The final locked/offline Rust workspace run passed **87 tests**: 7 Tauri-shell
  tests and 80 signer-core tests, with no failures or ignored cases.
- Full repository formatting and `git diff --check` passed.

The first Rust workspace build lacked Tauri's required `frontendDist` directory;
the frontend was built before repeating the workspace check. This was a local
build-order failure, not a passing Rust gate.

No production deployment, live alert mutation, credential rotation, external mail
delivery, real True API request, Windows installation or physical certificate
operation was performed. Tests use local PostgreSQL and synthetic HTTP fixtures.
Host Rust tests and the Windows dependency-tree inspection do not prove Windows
CryptoAPI/DPAPI behavior. Dependency auditing here covers GitHub's reported alert
and its target-specific tree, not a fresh scan of every dependency advisory source.
