# Repository docs completion — design

**Date:** 2026-08-20
**Status:** approved by owner (brainstorming session)

## Context

README.md, README.ru.md, and the proprietary LICENSE were finalized earlier
(commits `2c9c67187`, `b9d50f3fd`, `ccc2cac66`) and match the desired shape:
logo with light/dark variants, badges, product previews, popular-first then
technical structure, English default with a separate Russian file. They are
kept as-is except for targeted fixes.

This design closes the remaining gaps: community/legal files GitHub surfaces
in its UI, repository templates, and license metadata in package manifests.

Owner decisions:

- Keep and augment the existing README; no rewrite.
- Add the full file set: SECURITY.md, CONTRIBUTING.md, SUPPORT.md, CODEOWNERS,
  issue/PR templates, license fields in package.json.
- Contribution policy: external contributions are **not accepted**.
- Vulnerability contact: private GitHub Security Advisories, no public email.
- New files are English-only; the RU translation exists only for the README.
- No CHANGELOG.md.

## Changes

### 1. README.md and README.ru.md (targeted edits, kept in sync)

- Extend the `Development` tree with the missing workspaces:
  `apps/landing` (public website), `apps/saas-admin` (SaaS operator panel),
  `packages/legal-documents`.
- Add a short "Contributing, security, and support" section linking to
  CONTRIBUTING.md, SECURITY.md, and SUPPORT.md. The Russian README carries the
  same block in Russian, linking to the same English files.

### 2. New root files (English only)

- **SECURITY.md** — report vulnerabilities privately via GitHub Security
  Advisories ("Report a vulnerability" on the repository), never via public
  issues; the supported version is `main`; acknowledgement target is five
  business days; no public email address is published.
- **CONTRIBUTING.md** — external contributions are not accepted because the
  code base is proprietary (see LICENSE); unsolicited external pull requests
  are closed; bug reports and questions via issues are welcome;
  vulnerabilities go through SECURITY.md only.
- **SUPPORT.md** — questions and bug reports go to GitHub issues; commercial
  licensing and private inquiries go through the owner's GitHub profile
  (`@thevladbog`); links to LICENSE for the licensing terms.

### 3. `.github/`

- **CODEOWNERS** — single rule `* @thevladbog`.
- **ISSUE_TEMPLATE/** — GitHub issue forms:
  - `bug_report.yml` — what happened, expected behaviour, steps, surface
    (admin/kiosk/station/api/other), environment.
  - `question.yml` — free-form question with context.
  - `config.yml` — `blank_issues_enabled: false`; contact link pointing to
    the repository's private security-advisory form.
- **PULL_REQUEST_TEMPLATE.md** — note that external PRs are not accepted
  (link to CONTRIBUTING.md) plus the internal checklist from AGENTS.md:
  `pnpm turbo lint typecheck test build --concurrency=1 --force` and
  `pnpm format:check`.

### 4. Package manifests

Add `"license": "SEE LICENSE IN LICENSE"` to all 13 manifests: the root
`package.json`, six under `apps/`, six under `packages/`. All packages are
already `private: true`; this only makes the license metadata explicit.

## Out of scope

- CHANGELOG.md (declined by owner).
- Russian duplicates of the new files.
- GitHub repository settings (branch protection, labels) — not file-driven.
- Any change to LICENSE, the README structure, logos, or screenshots.

## Verification

- `pnpm format:check` (prettier covers Markdown and JSON).
- Visual check of the rendered README sections and issue forms syntax
  (YAML issue forms fail loudly on GitHub if malformed; keys follow the
  documented schema).
