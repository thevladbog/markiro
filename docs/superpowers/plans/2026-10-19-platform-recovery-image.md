# Recovery image export implementation

1. Add a focused export helper and failing tests for exact tested-image binding,
   source-byte/SHA verification, safe exclusive output, save failures and manifests.
   Keep credentials, fixture DB files and raw subprocess output out of the artifact.
2. Invoke only after the existing backup harness completes successfully and its
   actual resources are verified removed. Optional explicit output defaults off.
3. In the existing production-bundle CI job, request export to a dedicated runner
   directory and upload only archive + metadata using the pinned artifact action.
   CI-policy/workflow tests assert ordering, exact allowlist, failure exclusion and
   retention. Runtime provenance distinguishes synthetic CI verification from live
   target use; no release/deployment gate is bypassed.
4. Document independent main-push CI/artifact/source/image admission. Run focused
   tests, platform suite and CI-policy, lint/format/diff checks. Task review, fixes,
   fresh complete feature review, then push dependent PR. Actual archive transfer
   and target restore are separate operational gates.
