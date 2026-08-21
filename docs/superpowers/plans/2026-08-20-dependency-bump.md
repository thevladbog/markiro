# Dependency Bump Implementation Plan

> **⚠️ HISTORICAL — pre-implementation plan. Do not copy commands or snippets from it.**
>
> This is the plan as drafted **before** implementation, kept unchanged as a record of what was intended. The design changed under review, so parts of it no longer describe the shipped code. For what actually shipped, read **`docs/superpowers/specs/2026-08-20-dependency-bump-design.md`** and the code in `tools/`.
>
> Known divergences (non-exhaustive):
>
> - **Baseline generation.** Task 1's inline baseline script scans only `dependencies` and `devDependencies`. The shipped `tools/generate-dependency-baseline.mjs` also scans `peerDependencies` and `optionalDependencies`, sharing discovery with the guard via `tools/dependency-manifests.mjs`.
> - **The guard.** The draft guard here predates `breakingVersionOf` and compares majors only. The shipped guard treats the MINOR as breaking below `1.0.0` (`0.45.2 -> 0.46.0` is a crossing), because `majorOf` reports `0` for every pre-1.0 version.
> - **Unparseable pins.** The draft skips a version it cannot parse. The shipped guard fails on it — "cannot judge" is never "unchanged".
> - **Task 2, Step 4.** It expects `pnpm-lock.yaml` to gain a `packageManager` entry. It did not, and the lockfile was correctly left alone.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Raise pnpm from 11.10.0 to 11.22.0 and bring all 47 outdated JavaScript dependencies up to date within their current majors, holding back the two upgrades that would cross a major.

**Architecture:** Two commits in one branch — pnpm first, in isolation, so a lockfile-regeneration problem cannot be confused with a dependency problem; then the dependency sweep. Every manifest pins versions EXACTLY (no `^`), so `pnpm update -r` alone is a no-op and `--latest` is required; a verification script is what keeps `--latest` from crossing a major.

**Tech Stack:** pnpm 11 workspace (12 manifests: root, 6 apps, 5 packages), turbo, vitest, corepack.

**Spec:** `docs/superpowers/specs/2026-08-20-dependency-bump-design.md`

## Global Constraints

- **Within-major only.** Exactly two available upgrades cross a major and MUST be held back at their current versions: `typescript` stays `6.0.3` (latest is 7.0.2) and `jsdom` stays `29.1.1` (latest is 30.0.1).
- pnpm target: `packageManager` becomes `pnpm@11.22.0` in the root `package.json`.
- **Do not edit `.github/workflows/`.** Every `pnpm/action-setup@v4` step omits `version:`, so CI reads `packageManager` from `package.json`. That field moves CI and the local corepack shim together.
- **Do not** activate `minimumReleaseAge`, and do not migrate `saveExact`/`engineStrict` into `pnpm-workspace.yaml`. Out of scope by explicit decision.
- **Do not** touch `apps/station/src-tauri` (Rust/Tauri crates) or the Node engine floor (`>=24`).
- **Never hand-edit `pnpm-lock.yaml`.** It is generated. If it lacks something, that is a finding to report.
- Database-backed suites run against a throwaway database. Never run migrations against the shared `markiro` or `markiro_e2e` — both carry other branches' migrations.
- Report skipped counts, never just exit codes. A green gate can be empty: API e2e suites are wrapped in `describe.skipIf` on `DATABASE_URL` and the auth secrets.
- `pnpm format:check` is a separate CI step that turbo does NOT cover. When it flags files, format only those paths with `npx prettier --write <paths>` — never `prettier --write .`, which wanders into sibling git worktrees.
- Work in the worktree `/Users/thevladbog/PRSOME/q/.claude/worktrees/deps-bump` on branch `claude/deps-bump`. Do not touch the main checkout — another session has it on a different branch. Do not touch `git stash`.

---

### Task 1: The major-jump guard

**Files:**

- Create: `tools/check-no-major-bumps.mjs`

**Interfaces:**

- Produces: a script runnable as `node tools/check-no-major-bumps.mjs`, which exits non-zero and names offenders when any manifest pin has crossed a major relative to a recorded baseline. Task 3 depends on it.

This task exists first because it is the only thing standing between `--latest` and an accidental TypeScript 7 migration. Build the guard before the thing it guards.

- [ ] **Step 1: Record the pre-bump baseline**

```bash
cd /Users/thevladbog/PRSOME/q/.claude/worktrees/deps-bump
node --input-type=module -e "
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
const files = ['package.json',
  ...readdirSync('apps').map((d) => \`apps/\${d}/package.json\`),
  ...readdirSync('packages').map((d) => \`packages/\${d}/package.json\`)];
const out = {};
for (const f of files) {
  const d = JSON.parse(readFileSync(f, 'utf8'));
  for (const sec of ['dependencies', 'devDependencies']) {
    for (const [k, v] of Object.entries(d[sec] ?? {})) {
      if (!v.startsWith('workspace:')) out[k] ??= v;
    }
  }
}
writeFileSync('tools/dependency-baseline.json', JSON.stringify(out, null, 2) + '\n');
console.log('baseline packages:', Object.keys(out).length);
"
```

Expected: `baseline packages: 100` or thereabouts. Commit this file — it is the record of what the majors were before the sweep, and the guard reads it.

- [ ] **Step 2: Write the guard**

Create `tools/check-no-major-bumps.mjs`:

```js
#!/usr/bin/env node
/**
 * Fails when any manifest pin has crossed a MAJOR version relative to
 * `tools/dependency-baseline.json`.
 *
 * Every manifest in this repository pins exact versions, so the only way to
 * upgrade is `pnpm update --latest` — which happily crosses majors. This guard
 * is what makes that command safe to run: the sweep is allowed to move
 * anything within a major and nothing across one.
 */
import { readFileSync, readdirSync } from "node:fs";

const baseline = JSON.parse(readFileSync("tools/dependency-baseline.json", "utf8"));

const manifests = [
  "package.json",
  ...readdirSync("apps").map((d) => `apps/${d}/package.json`),
  ...readdirSync("packages").map((d) => `packages/${d}/package.json`),
];

const majorOf = (v) => {
  const m = /^(\d+)\./.exec(String(v).replace(/^[\^~]/, ""));
  return m ? Number(m[1]) : null;
};

const crossed = [];
for (const file of manifests) {
  const d = JSON.parse(readFileSync(file, "utf8"));
  for (const section of ["dependencies", "devDependencies"]) {
    for (const [name, version] of Object.entries(d[section] ?? {})) {
      if (String(version).startsWith("workspace:")) continue;
      const before = baseline[name];
      if (!before) continue;
      const a = majorOf(before);
      const b = majorOf(version);
      if (a !== null && b !== null && b !== a) {
        crossed.push(`${file}: ${name} ${before} -> ${version}`);
      }
    }
  }
}

if (crossed.length > 0) {
  console.error(`Major version change is out of scope for this branch:\n  ${crossed.join("\n  ")}`);
  process.exit(1);
}
console.log(`No major version changes across ${manifests.length} manifests.`);
```

- [ ] **Step 3: Prove the guard actually catches a major**

Temporarily edit `packages/domain/package.json` and change `typescript` to `7.0.2`, then run:

```bash
node tools/check-no-major-bumps.mjs
```

Expected: exit 1, printing `packages/domain/package.json: typescript 6.0.3 -> 7.0.2`.

Restore the file (`git checkout -- packages/domain/package.json`) and re-run.

Expected: `No major version changes across 12 manifests.`, exit 0.

A guard that has never failed is not known to work — do not skip this step.

- [ ] **Step 4: Commit**

```bash
git add tools/check-no-major-bumps.mjs tools/dependency-baseline.json
git commit -m "chore: guard the dependency sweep against major bumps"
```

---

### Task 2: pnpm 11.10.0 → 11.22.0

**Files:**

- Modify: `package.json` (the `packageManager` field)
- Modify: `pnpm-lock.yaml` (regenerated, never hand-edited)

**Interfaces:**

- Consumes: nothing.
- Produces: a lockfile regenerated by pnpm 11.22.0, which Task 3 then updates further.

pnpm moves alone, before any dependency changes, so that if the lockfile regeneration behaves oddly there is exactly one candidate cause.

- [ ] **Step 1: Change the pin**

In `package.json`, change:

```json
  "packageManager": "pnpm@11.10.0",
```

to:

```json
  "packageManager": "pnpm@11.22.0",
```

- [ ] **Step 2: Confirm the toolchain actually switched**

```bash
pnpm --version
```

Expected: `11.22.0`. Corepack reads `packageManager` and fetches it.

If this prints something else, the shell's `pnpm` is not corepack's shim — stop and report that, because everything downstream would then be measuring the wrong tool.

- [ ] **Step 3: Regenerate the lockfile**

```bash
pnpm install --no-frozen-lockfile
```

Expected: install succeeds; `git diff --stat pnpm-lock.yaml` shows changes.

- [ ] **Step 4: Check for the `packageManager` lockfile entry**

pnpm 11.18+ expects the lockfile to record the packageManager dependency with a registry path and an integrity-only resolution; its absence is what makes a global pnpm 11.18+ refuse to run here with `INVALID_PACKAGE_MANAGER_LOCKFILE`.

```bash
grep -n -A4 "packageManager" pnpm-lock.yaml | head -20
```

Record what you find in your report — either the entry now exists (the latent problem is closed) or it does not (a finding to report, NOT something to hand-write).

- [ ] **Step 5: Run the full gate**

```bash
pnpm turbo run lint typecheck test build --concurrency=1 --force
pnpm format:check
```

Expected: all tasks successful; `format:check` clean. Report real counts including skipped.

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "chore: raise pnpm to 11.22.0"
```

---

### Task 3: The dependency sweep

**Files:**

- Modify: all 12 manifests (root, `apps/*`, `packages/*`)
- Modify: `pnpm-lock.yaml`

**Interfaces:**

- Consumes: `node tools/check-no-major-bumps.mjs` from Task 1; the pnpm 11.22.0 toolchain from Task 2.

- [ ] **Step 1: Sweep everything to latest**

```bash
pnpm update -r --latest
```

This deliberately overshoots — it will also bump `typescript` to 7.x and `jsdom` to 30.x, which are out of scope. The next step puts them back.

- [ ] **Step 2: Hold back the two major jumps**

```bash
pnpm --filter @markiro/domain add -D typescript@6.0.3
node --input-type=module -e "
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
const files = ['package.json',
  ...readdirSync('apps').map((d) => \`apps/\${d}/package.json\`),
  ...readdirSync('packages').map((d) => \`packages/\${d}/package.json\`)];
const pins = { typescript: '6.0.3', jsdom: '29.1.1' };
for (const f of files) {
  const raw = readFileSync(f, 'utf8');
  const d = JSON.parse(raw);
  let touched = false;
  for (const sec of ['dependencies', 'devDependencies']) {
    for (const [name, want] of Object.entries(pins)) {
      if (d[sec]?.[name] && d[sec][name] !== want) { d[sec][name] = want; touched = true; }
    }
  }
  if (touched) { writeFileSync(f, JSON.stringify(d, null, 2) + '\n'); console.log('pinned back in', f); }
}
"
pnpm install --no-frozen-lockfile
```

- [ ] **Step 3: Run the guard**

```bash
node tools/check-no-major-bumps.mjs
```

Expected: `No major version changes across 12 manifests.`, exit 0.

If it names anything, put that package back to its baseline version and re-run until clean. Do not proceed while it is red.

- [ ] **Step 4: Run the full gate**

```bash
pnpm turbo run lint typecheck test build --concurrency=1 --force
pnpm format:check
```

Expected: all tasks successful. Report real counts including skipped.

If a suite goes red, **bisect the lockfile — do not revert the sweep wholesale.** Restore a suspect package to its baseline version (`pnpm --filter <pkg> add <name>@<baseline>`), reinstall, and re-run the failing suite until the culprit is isolated. Any package that cannot be upgraded safely stays at its baseline version and is **named explicitly in your report**; leaving it behind silently is not acceptable.

- [ ] **Step 5: Verify the database-backed suites really ran**

```bash
psql "postgres://markiro:markiro@localhost:5432/postgres" -c "CREATE DATABASE markiro_depsbump;"
DATABASE_URL=postgres://markiro:markiro@localhost:5432/markiro_depsbump pnpm --filter @markiro/db exec drizzle-kit migrate
DATABASE_URL=postgres://markiro:markiro@localhost:5432/markiro_depsbump pnpm --filter @markiro/db exec vitest run
psql "postgres://markiro:markiro@localhost:5432/postgres" -c "DROP DATABASE markiro_depsbump;"
```

Expected: 0 skipped. A skipped suite is not a passing suite.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: update dependencies within their current majors"
```

---

### Task 4: The station stress pass

**Files:** none modified unless a regression is found.

The station suite is timing-sensitive: `work-screen.test.tsx` has already flaked twice in CI on React passive-effect versus timer ordering, and this sweep moves `@testing-library/react` and `@testing-library/user-event` (eight patch releases). A single quiet run would not detect a scheduling regression.

- [ ] **Step 1: Run the station suite under two timezones**

```bash
cd apps/station
npx vitest run
TZ=UTC npx vitest run
TZ=Asia/Kolkata npx vitest run
```

Expected: identical pass counts, 0 skipped, in all three.

- [ ] **Step 2: Run it under load**

```bash
cd apps/station
for i in 1 2 3 4 5 6; do npx vitest run test/work-screen.test.tsx & done; wait
```

Expected: all six runs green. Report honestly if any run fails, including which test and how often — a flake that appears once in six is a finding, not noise to be dropped.

- [ ] **Step 3: Record the result**

No commit unless a regression was found and fixed. If one was, fix the root cause rather than adding timeouts or retries, and commit it separately with an explanation of the interleaving that failed.

---

### Task 5: Close out

**Files:**

- Modify: `docs/superpowers/specs/2026-08-20-dependency-bump-design.md` (Status line)

- [ ] **Step 1: Correct the spec's premise**

The spec says the set contains no major-version migration. That was written from a ten-line sample and is wrong: two upgrades cross a major (`typescript` 6.0.3 → 7.0.2 and `jsdom` 29.1.1 → 30.0.1) and are held back. Amend the Decision record so it states this accurately, and note that manifests pin exact versions, which is why `--latest` plus a guard is the mechanism.

- [ ] **Step 2: Update the status**

Change `**Status:** Approved — pending implementation plan` to `**Status:** Implemented — full gate green; two major upgrades deferred by scope`.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-08-20-dependency-bump-design.md
git commit -m "docs: record the dependency bump outcome"
```
