# Repository Docs Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the documentation gaps around the finished bilingual README: community files (SECURITY/CONTRIBUTING/SUPPORT), GitHub templates, CODEOWNERS, and license metadata in all 12 package manifests.

**Architecture:** Pure documentation/metadata change. New Markdown files at the repo root and under `.github/`, targeted edits to both READMEs, and a `license` field added to all 12 `package.json` files. No runtime code changes.

**Tech Stack:** Markdown, GitHub issue forms (YAML), npm package.json metadata, prettier for formatting checks.

**Spec:** `docs/superpowers/specs/2026-08-20-repo-docs-completion-design.md`

## Global Constraints

- Contribution policy: external contributions are **not accepted** (proprietary code base).
- Vulnerability reporting: private GitHub Security Advisories only; publish no email address anywhere.
- All new files are English-only.
- Do not change LICENSE, README structure, logos, or screenshots.
- License field value everywhere: exactly `SEE LICENSE IN LICENSE`.
- Owner GitHub handle: `@thevladbog`; repository: `thevladbog/markiro`.
- Verification command for every task: `pnpm format:check` (from repo root).

---

### Task 1: README workspace tree and support section (both languages)

**Files:**

- Modify: `README.md:135-165` (Development tree) and `README.md:166-177` (before/inside Documentation area)
- Modify: `README.ru.md:135-165` and `README.ru.md:166-177` (same edits in Russian)

**Interfaces:**

- Produces: links to `./CONTRIBUTING.md`, `./SECURITY.md`, `./SUPPORT.md` (created in Tasks 2–4; forward links are acceptable within this plan).

- [ ] **Step 1: Update the workspace tree in README.md**

In the `## Development` code block, replace:

```text
apps/
  api/       NestJS API, auth, jobs, integrations
  admin/     React/Vite production cabinet
  kiosk/     Offline-first pickup PWA
  station/   Tauri/React line workstation
packages/
  domain/    GS1, KM, SSCC, labels, shared policy
  db/        PostgreSQL schema, migrations, SQLite mirror
  email/     Transactional email templates
  ui/        Shared design tokens and React components
```

with:

```text
apps/
  api/         NestJS API, auth, jobs, integrations
  admin/       React/Vite production cabinet
  kiosk/       Offline-first pickup PWA
  station/     Tauri/React line workstation
  landing/     Public marketing website
  saas-admin/  SaaS operator panel
packages/
  domain/           GS1, KM, SSCC, labels, shared policy
  db/               PostgreSQL schema, migrations, SQLite mirror
  email/            Transactional email templates
  ui/               Shared design tokens and React components
  legal-documents/  Legal document sources and rendering
```

- [ ] **Step 2: Apply the same tree replacement in README.ru.md**

The tree block in `README.ru.md` is byte-identical to the English one (annotations are already in English there). Apply the exact same replacement as Step 1.

- [ ] **Step 3: Add a support section to README.md**

Insert immediately **before** the `## License` heading in `README.md`:

```markdown
## Contributing, security, and support

- External contributions are not accepted; see [CONTRIBUTING.md](./CONTRIBUTING.md).
- Report vulnerabilities privately; see [SECURITY.md](./SECURITY.md).
- Questions, bug reports, and commercial licensing; see [SUPPORT.md](./SUPPORT.md).
```

- [ ] **Step 4: Add the same section to README.ru.md in Russian**

Insert immediately **before** the `## Лицензия` heading in `README.ru.md`:

```markdown
## Контрибуции, безопасность и поддержка

- Внешние контрибуции не принимаются; см. [CONTRIBUTING.md](./CONTRIBUTING.md).
- Об уязвимостях сообщайте приватно; см. [SECURITY.md](./SECURITY.md).
- Вопросы, баг-репорты и коммерческая лицензия — см. [SUPPORT.md](./SUPPORT.md).
```

- [ ] **Step 5: Verify formatting**

Run: `pnpm format:check`
Expected: exit 0 (no formatting complaints about README.md / README.ru.md).

- [ ] **Step 6: Commit**

```bash
git add README.md README.ru.md
git commit -m "docs: list all workspaces and link community files from READMEs"
```

---

### Task 2: SECURITY.md

**Files:**

- Create: `SECURITY.md`

**Interfaces:**

- Produces: `SECURITY.md` linked from READMEs (Task 1), CONTRIBUTING.md (Task 3), and issue-template config (Task 5).

- [ ] **Step 1: Create SECURITY.md with exactly this content**

```markdown
# Security Policy

## Supported versions

Markiro is deployed from the `main` branch. Only the current state of `main`
receives security fixes.

## Reporting a vulnerability

Please report vulnerabilities **privately** through GitHub Security
Advisories: open the repository's **Security** tab and use **Report a
vulnerability**, or go directly to
<https://github.com/thevladbog/markiro/security/advisories/new>.

Do **not** open a public issue or pull request for a security problem, and do
not include exploit details in public discussions.

## What to include

- A description of the issue and its impact.
- Steps to reproduce, a proof of concept, or affected endpoints/components.
- Any known workarounds.

## What to expect

- Acknowledgement within five business days.
- A private discussion of impact, fix, and disclosure timing inside the
  advisory.
- Credit in the advisory if you want it.

Thank you for helping keep Markiro and its users safe.
```

- [ ] **Step 2: Verify formatting**

Run: `pnpm format:check`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add SECURITY.md
git commit -m "docs: add security policy with private advisory reporting"
```

---

### Task 3: CONTRIBUTING.md

**Files:**

- Create: `CONTRIBUTING.md`

**Interfaces:**

- Consumes: `SECURITY.md` (Task 2) for the vulnerability pointer.
- Produces: `CONTRIBUTING.md` linked from READMEs (Task 1) and the PR template (Task 5).

- [ ] **Step 1: Create CONTRIBUTING.md with exactly this content**

```markdown
# Contributing

Thank you for your interest in Markiro. Please read this before opening a
pull request.

## External contributions are not accepted

Markiro is proprietary software (see [LICENSE](./LICENSE)). The source code
is publicly visible, but no license is granted to use, copy, modify, or
create derivative works from it. Because of this, **external pull requests
are not accepted and will be closed**, regardless of their quality. This is
a legal constraint, not a judgement of your work.

## What is welcome

- **Bug reports** — open an issue with reproduction steps.
- **Questions and feedback** — open an issue.
- **Security vulnerabilities** — never via public issues; follow
  [SECURITY.md](./SECURITY.md).

## Commercial licensing

If you want to use Markiro or build on it, see [SUPPORT.md](./SUPPORT.md)
for how to reach the owner about a commercial license.
```

- [ ] **Step 2: Verify formatting**

Run: `pnpm format:check`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add CONTRIBUTING.md
git commit -m "docs: add contributing policy (external contributions not accepted)"
```

---

### Task 4: SUPPORT.md

**Files:**

- Create: `SUPPORT.md`

**Interfaces:**

- Consumes: `SECURITY.md` (Task 2), `CONTRIBUTING.md` (Task 3).
- Produces: `SUPPORT.md` linked from READMEs (Task 1) and CONTRIBUTING.md.

- [ ] **Step 1: Create SUPPORT.md with exactly this content**

```markdown
# Support

## Questions and bug reports

Open a [GitHub issue](https://github.com/thevladbog/markiro/issues) using
the provided templates. Please check existing issues first.

## Security vulnerabilities

Never use public issues for vulnerabilities — report them privately as
described in [SECURITY.md](./SECURITY.md).

## Commercial licensing and private inquiries

Markiro is proprietary (see [LICENSE](./LICENSE)); using it requires a
written agreement with the copyright holder. For commercial licensing,
partnership, or other private inquiries, contact the owner via the GitHub
profile [@thevladbog](https://github.com/thevladbog).

## Scope

There is no guaranteed support SLA for the public repository. Responses to
issues are made on a best-effort basis.
```

- [ ] **Step 2: Verify formatting**

Run: `pnpm format:check`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add SUPPORT.md
git commit -m "docs: add support and commercial licensing contact guide"
```

---

### Task 5: GitHub templates and CODEOWNERS

**Files:**

- Create: `.github/CODEOWNERS`
- Create: `.github/PULL_REQUEST_TEMPLATE.md`
- Create: `.github/ISSUE_TEMPLATE/bug_report.yml`
- Create: `.github/ISSUE_TEMPLATE/question.yml`
- Create: `.github/ISSUE_TEMPLATE/config.yml`

**Interfaces:**

- Consumes: `CONTRIBUTING.md` (Task 3) linked from the PR template; security advisory URL from Task 2.

- [ ] **Step 1: Create `.github/CODEOWNERS`**

```text
* @thevladbog
```

- [ ] **Step 2: Create `.github/PULL_REQUEST_TEMPLATE.md`**

```markdown
> **External contributors:** external pull requests are not accepted — see
> [CONTRIBUTING.md](../CONTRIBUTING.md). This template is for internal work.

## What changed

<!-- Short summary of the change and why it is needed. -->

## Checklist

- [ ] `pnpm turbo lint typecheck test build --concurrency=1 --force` passes
- [ ] `pnpm format:check` passes
- [ ] Database-backed tests ran with `DATABASE_URL` exported (or were not touched)
- [ ] Intentional skips and external/browser/hardware verification are reported in the PR description
```

- [ ] **Step 3: Create `.github/ISSUE_TEMPLATE/bug_report.yml`**

```yaml
name: Bug report
description: Something is broken or behaves unexpectedly
labels: ["bug"]
body:
  - type: markdown
    attributes:
      value: |
        Do **not** report security vulnerabilities here — use the private
        [security advisory form](https://github.com/thevladbog/markiro/security/advisories/new) instead.
  - type: dropdown
    id: surface
    attributes:
      label: Surface
      options:
        - Admin panel
        - Pickup kiosk
        - Line station
        - API
        - Landing / SaaS admin
        - Other / not sure
    validations:
      required: true
  - type: textarea
    id: what-happened
    attributes:
      label: What happened?
      description: What did you see, and what did you expect instead?
    validations:
      required: true
  - type: textarea
    id: steps
    attributes:
      label: Steps to reproduce
      placeholder: |
        1. …
        2. …
    validations:
      required: true
  - type: textarea
    id: environment
    attributes:
      label: Environment
      description: OS, browser or station build, connectivity state (online/offline), anything relevant.
```

- [ ] **Step 4: Create `.github/ISSUE_TEMPLATE/question.yml`**

```yaml
name: Question
description: Ask about behaviour, setup, or the project
labels: ["question"]
body:
  - type: textarea
    id: question
    attributes:
      label: Your question
      description: Include the context needed to answer without guessing.
    validations:
      required: true
```

- [ ] **Step 5: Create `.github/ISSUE_TEMPLATE/config.yml`**

```yaml
blank_issues_enabled: false
contact_links:
  - name: Report a security vulnerability
    url: https://github.com/thevladbog/markiro/security/advisories/new
    about: Please report vulnerabilities privately via GitHub Security Advisories.
```

- [ ] **Step 6: Verify formatting**

Run: `pnpm format:check`
Expected: exit 0 (if prettier flags the new YAML/MD under `.github/`, run `pnpm prettier --write .github/` and re-check).

- [ ] **Step 7: Commit**

```bash
git add .github/CODEOWNERS .github/PULL_REQUEST_TEMPLATE.md .github/ISSUE_TEMPLATE/
git commit -m "docs: add CODEOWNERS, PR template, and issue forms"
```

---

### Task 6: License metadata in all package manifests

**Files:**

- Modify: `package.json`, `apps/admin/package.json`, `apps/api/package.json`, `apps/kiosk/package.json`, `apps/landing/package.json`, `apps/saas-admin/package.json`, `apps/station/package.json`, `packages/db/package.json`, `packages/domain/package.json`, `packages/email/package.json`, `packages/legal-documents/package.json`, `packages/ui/package.json`

**Interfaces:**

- Produces: `"license": "SEE LICENSE IN LICENSE"` in all 12 manifests.

- [ ] **Step 1: Add the license field to every manifest**

In each of the 12 files, add directly after the `"private": true,` line:

```json
"license": "SEE LICENSE IN LICENSE",
```

A safe scripted way (from repo root):

```bash
node -e '
const fs = require("fs");
const files = ["package.json",
  ...["admin","api","kiosk","landing","saas-admin","station"].map(a => `apps/${a}/package.json`),
  ...["db","domain","email","legal-documents","ui"].map(p => `packages/${p}/package.json`)];
for (const f of files) {
  const j = JSON.parse(fs.readFileSync(f, "utf8"));
  if (j.license === "SEE LICENSE IN LICENSE") continue;
  const entries = Object.entries(j).filter(([k]) => k !== "license");
  const idx = entries.findIndex(([k]) => k === "private");
  entries.splice(idx + 1, 0, ["license", "SEE LICENSE IN LICENSE"]);
  fs.writeFileSync(f, JSON.stringify(Object.fromEntries(entries), null, 2) + "\n");
}
'
```

- [ ] **Step 2: Verify every manifest has the field**

Run: `grep -L '"license": "SEE LICENSE IN LICENSE"' package.json apps/*/package.json packages/*/package.json`
Expected: empty output (no file is missing the field).

- [ ] **Step 3: Verify install metadata still parses and formatting holds**

Run: `pnpm install --frozen-lockfile --offline || pnpm install --frozen-lockfile`
Expected: succeeds without lockfile changes (`git status --short pnpm-lock.yaml` is empty).

Run: `pnpm format:check`
Expected: exit 0 (if prettier reflows the JSON, run `pnpm prettier --write package.json 'apps/*/package.json' 'packages/*/package.json'` and re-check).

- [ ] **Step 4: Commit**

```bash
git add package.json apps/*/package.json packages/*/package.json
git commit -m "chore: declare proprietary license in all package manifests"
```

---

### Task 7: Final verification

- [ ] **Step 1: Full formatting check**

Run: `pnpm format:check`
Expected: exit 0.

- [ ] **Step 2: Confirm all spec deliverables exist**

Run: `ls SECURITY.md CONTRIBUTING.md SUPPORT.md .github/CODEOWNERS .github/PULL_REQUEST_TEMPLATE.md .github/ISSUE_TEMPLATE/bug_report.yml .github/ISSUE_TEMPLATE/question.yml .github/ISSUE_TEMPLATE/config.yml`
Expected: all eight paths listed, no errors.

- [ ] **Step 3: Confirm README links resolve**

Run:

```bash
for f in README.md README.ru.md; do
  for t in CONTRIBUTING.md SECURITY.md SUPPORT.md; do
    grep -q "(\./$t)" "$f" || { echo "missing link to $t in $f"; exit 1; }
    [ -f "$t" ] || { echo "missing target $t"; exit 1; }
  done
done && echo LINKS_OK
```

Expected: `LINKS_OK` (the loop exits non-zero naming the first missing per-file link or missing target).
