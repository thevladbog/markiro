# CI recovery-worker artifact

The target backup adapter requires an independently verified Linux AMD64 worker
image containing the reviewed PostgreSQL backup/restore modules. The existing
CI round-trip builds and tests that image but discards the runner afterward.
Preserve that exact tested image as an immutable GitHub Actions artifact, without
building on the production VM or inventing live-source acceptance.

Extend the existing local backup harness with an optional, explicit export
location. Only after the complete positive/negative round-trip and verified
cleanup succeed, save the actual tested image and a bounded metadata manifest.
Metadata binds exact checked-out Git SHA, actual Linux architecture/configuration
image ID, archive byte count/SHA256, and hashes of the worker's reviewed repository
source closure. No runtime connection, password, dump, table inventory or fixture
data enters this artifact. Test-fixture source present in the tested image is
identified as such; the artifact does not assert production execution.

The workflow uploads only the image archive and manifest from the dedicated
location. A production operator must independently verify a successful exact
main-push CI run/attempt and artifact digest before loading, recheck archive hash,
configuration ID/architecture and source hashes against that main revision, then
bind the worker to the prepared operation. Pull-request artifacts never authorize
production use. Existing protected application publication remains unchanged.

Export must fail closed on unclean/mismatched source bytes, unexpected image
identity/architecture or ownership, partial image save, unsafe/existing output
paths, oversized metadata and failed cleanup. Do not weaken existing harness,
process isolation, archive or restore checks. No credentials or client data are
needed to produce this artifact. Server/DNS operations are out of scope.
