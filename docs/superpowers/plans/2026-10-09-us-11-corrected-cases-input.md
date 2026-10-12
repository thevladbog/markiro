# Corrected Cases input implementation plan

> Execute with a separate implementer and independent task review, then final
> review. Ordinary approval pauses are waived by the user's standing instruction.

**Goal:** establish a strict corrected Transformation → Cases evidence boundary.

**Architecture:** a distinct input codec delegates accepted upstream validation;
no regular-chain alias, native Cases writes, executor or runtime changes.

## Global constraints

Follow `docs/superpowers/specs/2026-10-09-us-11-corrected-cases-input-design.md`.
Keep US isolation, inherited edits, recipe and regular contracts intact. No
commit/push, deployment, cleanup, dependencies, environment or schema edits.
Database tests may only use owned disposable children of the configured US fixture.

### Task 1: Corrected Cases input and prerequisite binding

Create `apps/api/src/modules/traceability/demo/us-dataset-corrected-cases-contract.ts`.
Export `UsDatasetCorrectedCasesInput`,
`parseUsDatasetCorrectedCasesInput(raw: unknown)` and
`makeUsDatasetCorrectedCasesInput(references: unknown, amendmentStage: unknown,
transformationStage: unknown, support: unknown)`.

Implement the exact design constraints. Reuse the accepted descriptor-safe guard,
upstream factory and result parser; validate support explicitly rather than
pretending it belongs to a regular chain. No Cases result/executor in this task.

Extend `apps/api/test/us-dataset-corrected-transformation-contract.test.ts` with
focused transition-contract tests. Keep its existing native gate and fixture safety
unchanged. Add a separate native test using the real corrected Transformation seed
store and actual journal stage. Demonstrate no Cases support or links are created.

Use TDD: record a meaningful assertion failure with an importable minimal stub,
then passing focused tests. Run corrected Transformation, regular Cases and special
contract suites with one worker. Native coverage uses configured US fixture only;
never set DATABASE_URL. Report exact pass/skip counts, commands and warnings.

Controller runs API static/package gates, formatting, isolation contracts and
source-byte scope verification. The existing six-suite CI owner remains unchanged
because tests extend an already-owned test file. Append truthful checkpoint notes
to development-isolation and implementation-plan only after verification.
