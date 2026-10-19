# Preserve ICU database semantics and use target-compatible recovery image

The current Yandex database is PostgreSQL17/UTF8/C/C, locale provider ICU, en-US, genuine stored/actual collation version153.112. The pinned Timeweb target PG17.11 Alpine3.24 supplies153.136; Bookworm17.11 supplies153.120. No target production DB has been imported. Earlier libc-only rehearsals are not locale preservation acceptance.

## Binding requirements

- Preserve existing libc four-field inventory shape and behavior unchanged.
- Add strict ICU locale shape: encoding,collate,ctype,provider='i',icuLocale,icuRules(nullable),collationVersion,actualCollationVersion. Exact keys, bounded strings, no NUL. Genuine nonempty stored and actual versions must match. Reject other providers.
- Query PG17 datlocale/daticurules/datcollversion/pg_database_collation_actual_version. Reuse locale validation and SQL building; quote literals correctly under explicit standard_conforming_strings=on.
- ICU restore creates TEMPLATE template0, explicit encoding,C/C,LOCALE_PROVIDER icu, ICU_LOCALE and ICU_RULES when non-null. Never set COLLATION_VERSION, refresh or rewrite versions. Check all ICU metadata immediately after CREATE before loading objects, and in final whole inventory.
- Keep all other inventory, writer-fence, ownership, cleanup, bounds and runtime checks intact. Existing source role transformations remain separate.
- Keep target postgres17alpine UID70 and observer identity unchanged. Add explicit separately selected Alpine worker recipe with same immutable target PG base. Preserve Bookworm/libc harness default. Alpine worker UID/GID999, checked no collisions, correct owned writable locations, compatibility symlink /usr/lib/postgresql/17/bin to actual PostgreSQL utilities. No runtime capability relaxation, apk upgrade, ICU library substitution or glibc copying.
- Official verified multiarch PG base: postgres:17-alpine@sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24. AMD64 manifest sha256:aa90e97ee862e558111d34cfb8b2c4bec768c2b039fb791341686928560263b3 matches target. ARM64 sha256:0b2882c46a2b8d8e148431b333394348cf4d7f15aec6df7f17d51dc641e56cfa.
- Official verified Node base: node:24.18.0-alpine3.24@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd. AMD64 sha256:4ba75f835bb8802193e4c114572113d4b26f95f6f094f4b5229d2a77773e0afc. ARM64 sha256:eef73a25205e27bd016ce672af71560ad6b681142ddf00ff63c7b3098eafcd4d. Check Node dynamic dependencies as constrained UID; do not replace target ICU dependencies.
- Bind recipe/base digests/source bytes/tested image into existing exporter provenance. Only passing synthetic isolated ICU roundtrip may export Alpine worker. Preserve default non-export ARM behavior and LinuxAMD64-only production artifact rule.
- Test valid ICU custom rules containing quoting punctuation plus en-US default and Unicode data. Test natural runtime mismatch (Alpine136 to Bookworm120) fails without completed evidence and verifies cleanup. Preserve existing libc real harness coverage, all denial tests, metadata1MiB and archive caps.
- Explicit target bootstrap locale will be en-US ICU/C/C rather than accidental defaultlibc; implement through reviewed compact Compose configuration with fixture assertions, not ad hoc override of runtime identity.

## Separate operational acceptance (not claimed by implementation)

Source112 to target136 is an ICU upgrade, not an exact recovery roundtrip. Before cutover, compare snapshot-bound source/target text ordering/equality across every collatable column and relevant expressions/indexes/checks using counts/hashes only. Preserve char/domain semantics, disable sourceindex shortcuts, compare structural/data fingerprints under explicit rolemapping. Logical restore builds all indexes in targetICU. Report changes and futureUnicode limitations. Obtain explicit acceptance of upgrade before final target activation. Do not forge metadata or loosen normal recovery equality. Fresh target136 backup+136 isolatedrestore remains mandatory.

User confirms independent key copy outsideMac; archives1385files fully readbackverified Timeweb. Those recovery facts do not replace ICU or final frozen-source acceptance. No source/DNS writes within code task.
