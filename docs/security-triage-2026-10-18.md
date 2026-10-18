# Standalone merge security review — 2026-10-18

Repository: `thevladbog/markiro`, [PR #730](https://github.com/thevladbog/markiro/pull/730).
The complete standalone branch is being compared with `main`, so the first
Rust scan covers substantially more code than an individual feature change.
This review concerns the findings introduced by that comparison, not every
dependency or historical alert in the repository.

## Findings requiring changes

### JavaScript regular expressions

The initial JavaScript/TypeScript scan reported two ReDoS findings:

- The office-control policy test used an ambiguous multiline expression to
  detect the `native` attribute of `Select`. It now inspects TypeScript's JSX
  syntax tree. The prohibition remains enforced, including attributes after
  arrow functions, without matching component examples inside strings/comments.
- The shared contents-report row-height calculation repeatedly tried to find
  a newline in a run of whitespace. It now processes whitespace runs once,
  retaining the original paragraph lengths, empty paragraphs and pagination.

Commit `2e2cc1f1504c47bc7bcb91ef11eeb55b5df71f92` contains these fixes.
The old report implementation exceeded the normal five-second test timeout on
100,000 spaces. The replacement passes that regression; 299,593 combinations
of short text/whitespace runs produced the same row height as the old code.
The JSX regression suite first exposed six failures in the old detector and
then passed all 22 checks, including an unfinished tag with 100,000 newlines.
The subsequent JavaScript/TypeScript scan no longer reports either finding.

### Cloud-import allocation amplification

Rust alerts [#40–48](https://github.com/thevladbog/markiro/security/code-scanning/40)
identify nine result-vector preallocations in `host/src/cloud_import.rs`.
The administrator is authorized before the body is read and the JSON body has
a 32 MiB limit, but those controls do not justify reserving an entire output
vector before validating its first row. Compact positional JSON records can
amplify a malformed file into a much larger unused allocation.

The result vectors grow only as validated rows are appended. This preserves
the accepted file format, validation order, errors and existing request limits.
It avoids allocating storage for all remaining rows when the first row fails.
The nine regression cases measure allocations during validation rather than
using a machine-dependent timing threshold. With 100,000 rows and an invalid
first row, the old code reserved 3.2–23.2 MB per output vector. The replacement
keeps the largest single validation allocation below 64 KiB and reports the
same first validation field. The existing import, replacement, import-rule and
license-seat suites also passed: 64 tests, with no skips.

## Findings assessed individually

These assessments use the source at
`2e2cc1f1504c47bc7bcb91ef11eeb55b5df71f92`. Each false-positive/test-only alert
has its own source-specific dismissal explanation in GitHub: 110 findings
are marked `used in tests`, and 11 are marked `false positive`. No query, language,
directory or security policy is excluded from scanning.

### Hard-coded cryptographic values: 104 alerts

- 102 locations belong to disposable test fixtures: 94 integration-test or
  harness locations and eight unit-test locations inside `#[cfg(test)]`.
  Fixed inputs exercise successful and rejected authentication, malformed
  verifiers, password-length boundaries and imported badge compatibility.
  The integration harness creates SQLite databases in temporary directories;
  these values are neither application defaults nor production accounts.
- [#129](https://github.com/thevladbog/markiro/security/code-scanning/129)
  is the intentional dummy PBKDF2 input for an unknown office login. Its salt
  is random. `routes/office_auth.rs` independently rejects a missing user row
  before opening a session, even if the dummy input matches. It equalizes work
  and grants no authentication capability.
- [#169](https://github.com/thevladbog/markiro/security/code-scanning/169)
  identifies the initial zero-filled salt buffer. `hash_password` overwrites
  it using `aws_lc_rs::rand::fill` before derivation. A failed fill panics;
  the zero-initialized buffer is never accepted as a password salt.

### Bounded route allocations: six alerts

The remaining allocation findings have explicit count guards before reservation:

| Alert | Route                      | Maximum entries |
| ----- | -------------------------- | --------------: |
| #49   | Bootstrap lines            |              20 |
| #50   | Bootstrap stock templates  |              32 |
| #51   | Device facts               |             100 |
| #52   | Recovery known blocks      |              64 |
| #53   | Handheld pallet events     |             100 |
| #54   | Warehouse reprint receipts |             100 |

The alert is not evidence of an arbitrary-size reservation at these sinks.
The existing limits and their refusal paths remain enforced.

### Logging and database findings: 11 alerts

- [#63](https://github.com/thevladbog/markiro/security/code-scanning/63)
  prints the public SHA-256 fingerprint of certificate DER for pairing
  verification. Neither the private key nor a credential is printed.
- #61 prints a fixed parser error from a unit test with invalid certificate
  base64, not certificate contents. #62 deliberately uses an assertion whose
  diagnostic prints only the field label, not either compared verifier.
- #55–60 are integration-test diagnostics for synthetic privacy/redaction
  fixtures. They are not production logging paths.
- #64 creates a test-only revocation trigger using a synthetic user UUID.
  #65 reads stored PIN/badge PHC verifiers to check import fidelity; it does
  not write plaintext passwords. Both operate on temporary test databases.

## Verification boundaries

Successful analysis jobs mean the scanner ran, not that its security gate
passed. The final CodeQL gate must be checked after all language results have
been uploaded; early intermediate summaries can omit still-running languages.
An additional strict Clippy run stopped on six existing warnings in unchanged
`markiro-proto`: five `unnecessary_map_or` and one `large_enum_variant`. This
review does not suppress those warnings or claim that strict Clippy passed.
Full CI, Windows builds and physical factory-device acceptance are separate
evidence. No production deployment, customer data replacement or release
publication is performed by this security review.
