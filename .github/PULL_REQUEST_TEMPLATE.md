> **External contributors:** external pull requests are not accepted — see
> [CONTRIBUTING.md](../CONTRIBUTING.md). This template is for internal work.

## What changed

<!-- Short summary of the change and why it is needed. -->

## Checklist

- [ ] `pnpm turbo lint typecheck test build --concurrency=1 --force` passes
- [ ] `pnpm format:check` passes
- [ ] Database-backed tests ran with `DATABASE_URL` exported (or were not touched)
- [ ] Intentional skips and external/browser/hardware verification are reported in the PR description
