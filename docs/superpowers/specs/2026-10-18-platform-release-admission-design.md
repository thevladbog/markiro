# Published platform release admission

Status: implementation slice of the Timeweb host delivery design. No host executor
or provisioning is included. User delegated the migration preparation; source
production and DNS remain unchanged.

## Outcome

Provide a read-only, repeatable verifier for the first actual protected publisher
output. An operator selects its exact source SHA, run, attempt and artifact ID.
The verifier checks GitHub provenance, immutable artifact bytes and the complete
published evidence, then writes a sanitized admission record. It must not publish
images, load Docker archives, contact a target host or assert that deployment,
restoration or capacity acceptance has occurred.

## Evidence contract

Inputs are repository fixed to `thevladbog/markiro`, source SHA, publisher run ID,
publisher attempt and artifact ID; SHA is a complete lowercase 40-character value,
IDs are canonical positive safe-integer decimal strings. Source/tooling SHA in
publisher evidence must match the selected source SHA. The future host executor
has a separately recorded tooling identity and is outside this contract.

Require the selected successful main manual run of the exact platform publication
workflow, with both `build` and `publish` successful in that attempt. Resolve both
the current run and selected attempt; reject rerun divergence and incomplete or
mixed job inventories. The repository and head repository must both match.

Artifact metadata must bind the explicit artifact ID, selected run, source SHA,
head branch and repository IDs, have the expected exact release name
`markiro-platform-release-RUN-ATTEMPT`, be unexpired and have a valid SHA256 digest.
Reject artifacts larger than 1 MiB. The downloaded ZIP must hash to the metadata
digest. Extract only the two regular files `platform-manifest.json` and
`release-evidence.json`, each at most 256 KiB; no duplicates, extra entries,
directories, links, traversal, encryption or nested paths. Bound compressed and
uncompressed sizes and reject truncated/CRC-invalid contents. A private temporary
working directory is removed after success/failure. Do not extract using paths
from the archive. Python 3 standard-library `zipfile` may be used as an explicit
runtime prerequisite to avoid writing a ZIP parser or adding an npm dependency.

The strict release evidence has exactly `status`, `verified`, `published`,
`createdAt`; status must be `complete`. Reuse `parseVerifiedImagesEvidence` and
`parsePlatformManifest`. `published` has exactly `api` and `edge`, each exactly
`tag`, `id`, `pushCompleted`, `digest`. Tags/IDs must match verified evidence,
`pushCompleted` must be true and digests must match the manifest's exact image
repository. Evidence and manifest timestamps must agree. Fetch and validate the
exact successful CI run/attempt claimed by verified evidence using the existing
CI validator, requiring its source SHA to match.

After evidence validation, optionally verify registry images through the existing
Docker CLI's read-only `manifest inspect --verbose` against exact digest references.
For this first admission, registry confirmation is mandatory: require a single
linux/amd64 manifest and matching config digest (= captured Docker image ID),
and require the reported manifest digest/repository binding to match the exact
requested immutable reference. Reject indexes/ambiguous output rather than guess.
Do not pull, tag, load, login, push or change Docker configuration. Existing local
Docker authentication is an operational prerequisite when the registry is private.
No record is accepted from JSON validation alone.

## Transport, errors and output

Use authenticated HTTPS to fixed GitHub API routes, with timeouts and complete
bounded job pagination. Never include the token in arguments, output or errors.
Resolve the artifact download redirect only from that trusted API response;
follow HTTPS without credentials, reject URL credentials and bound total bytes.
Do not forward the GitHub Authorization header to blob storage. Validate all
identifiers before any request. Failure messages contain phase names only.

CLI: `node deploy/platform/admit-release.mjs SOURCE_SHA RUN_ID ATTEMPT ARTIFACT_ID OUTPUT_FILE`.
`GH_TOKEN` is environment-only. Output must not already exist. Use a protected
regular output file mode 0600 and exclusive creation after all checks succeed;
never leave a success record on failure. No archive, raw response or child output
is written to the output directory. The record contains version 1, kind
`platform-release-admission`, the validated manifest and verified evidence,
artifact ID/SHA256, publisher/CI attempts and checked registry image IDs. It is
verification evidence, not a signature or authorization to mutate a host.

## Verification

Use native Node tests with mocked HTTP/process adapters and real local ZIP fixtures.
Prove identity substitution, failed/skipped/rerun workflows, incomplete pages,
metadata/archive/file tampering, unsafe extraction, partial publication, CI mismatch,
registry mismatch and output reuse fail without a success record. Include a real
CLI subprocess failure that never echoes a token or raw upstream text. Read-only
live verification of an actual successful publisher remains a separate gate.
