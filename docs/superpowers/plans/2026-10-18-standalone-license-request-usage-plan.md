# Activation request usage implementation plan

1. Add focused failing tests for export parsing, encrypted support payload reuse and host-bound ingestion.
2. Add a separate optional-token export contract; retain the host/domain activation request.
3. Extract shared support-token generation and enrich activation exports with fresh usage, license and PC facts, omitting unavailable diagnostics.
4. Reuse diagnostics ingestion during platform request inspection, with expected-host verification before writes and explicit unbound-host confirmation. Strip token from persisted site snapshots.
5. Add JSON paste alongside file import, visible confirmation/results and tenant diagnostic query invalidation.
6. Run focused tests followed by package typecheck/lint/build and appropriate package suites. Run isolated database e2e when available; report remaining external boundaries accurately. Review diff and formatting. No commit, push or deployment.
