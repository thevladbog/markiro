# Task 4: Fix details field type parity

## Fix: details object parity

### Verification commands and results

1. **cargo fmt --manifest-path apps/standalone/Cargo.toml --all**
   - Result: No output (formatting applied)

2. **cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check**
   - Result: No output (clean, no formatting issues)

3. **cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-proto --offline**
   - Result: `cargo test: 5 passed (3 suites, 0.00s)` ✓

4. **cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --offline**
   - Result: Sandbox denied local port binding (EPERM); re-run with dangerouslyDisableSandbox=true
   - Result (unsandboxed): `cargo test: 15 passed (5 suites, 0.09s)` ✓

5. **pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/protocol.test.ts**
   - Result: `Test Files  1 passed (1)`, `Tests  4 passed (4)` ✓

6. **pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck**
   - Result: No output (clean, no type errors)

7. **node_modules/.bin/prettier --check apps/standalone/test/protocol.test.ts**
   - Result: `All matched files use Prettier code style!` ✓

### Commit

Commit SHA: a6a1246
Message: `fix(standalone): details ошибки — всегда объект с обеих сторон протокола`
Trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`

Working tree status: Clean (all files committed)

### Summary

- Changed Rust `ErrorDetail.details` type from `Option<serde_json::Value>` to `Option<serde_json::Map<String, serde_json::Value>>`
- Added validation test in Rust fixtures that rejects non-object details
- Added validation test in TypeScript protocol schema that rejects non-object details
- All tests pass: proto (5), host (15), protocol.test.ts (4)
- All formatting and type checks pass
- Sandbox restrictions noted: host tests require unsandboxed execution for port binding
