# ICU recovery preparation plan

1. Add locale helper and RED/GREEN tests; update inventory/schema/restore to strict ICU representation, early comparison and unchanged libc contract. No workerrecipe change in this task.
2. Add pinned Alpine worker recipe and explicit harness mode, UID/path/runtime checks, genuine ICU fixtures/default and customrules roundtrips plus natural Bookworm mismatch. Reuse existing exporter and bind recipe/base/source. Update compact initialization to explicit ICUen-US/C/C and scoped contracts. CI exercise old libc and new ICU routes; export only respective tested workers to separate exact paths/artifactnames. Avoid doubling unrelated broad build steps.
3. Run focused tests and actual local synthetic Docker harness, platform suite once after final changes, scoped lint/format/diff and affectedCIpolicy. Document precise external limitations. Independent task review plus final feature review, then scoped push/PR on reviewed base.
4. Separate operational source-upgrade evidence, accepted ICUdiff, frozen import, fenced targetbackup/restore and mainCI artifact admission. No phase4 implementation shortcuts in phase1-3.
