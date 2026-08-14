import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("production deploy runbook describes one direct immutable Compose delivery", async () => {
  const runbook = await read("docs/runbooks/saas-production-deploy.md");
  assert.match(runbook, /одним GitHub-hosted job напрямую на app VM/);
  assert.match(runbook, /exact release run ID/);
  assert.match(runbook, /remote-deploy\.mjs/);
  assert.match(
    runbook,
    /transfer, prepare, migrations, start,[\s\S]*readiness, public smoke, finalize/,
  );
  assert.match(runbook, /один[\s\S]*rollback/);
});

test("production deploy runbook requires key-only pinned SSH and ephemeral GHCR auth", async () => {
  const [runbook, secrets] = await Promise.all([
    read("docs/runbooks/saas-production-deploy.md"),
    read("docs/runbooks/yandex-secrets.md"),
  ]);
  for (const value of [
    "YC_APP_PUBLIC_ADDRESS",
    "APP_SSH_HOST_KEYS_B64",
    "YC_APP_DEPLOY_SSH_PRIVATE_KEY",
    "github.token",
    "password-stdin",
  ])
    assert.match(runbook + "\n" + secrets, new RegExp(value.replace(".", "\\.")));
});

test("production runbooks keep API private and assign public TLS to direct Caddy", async () => {
  const runbook = await read("docs/runbooks/saas-production-deploy.md");
  assert.match(runbook, /Caddy слушает 80\/443 на VM/);
  assert.match(runbook, /ACME TLS/);
  assert.match(runbook, /API не[\s\S]*отдельный host port/);
});

test("production runbooks contain no legacy deployment ceremony", async () => {
  const runbook = await read("docs/runbooks/saas-production-deploy.md");
  assert.doesNotMatch(
    runbook,
    /deployment_phase=|rollback_rehearsal=|rehearsal_run_id=|production-controller|production-cleanup/,
  );
});

test("landing publication runbook separates reachability from indexed search evidence", async () => {
  const runbook = await read("docs/runbooks/landing-publication.md");
  for (const required of [
    "DNS",
    "TLS",
    "404",
    "robots.txt",
    "sitemap.xml",
    "Google Search Console",
    "Яндекс Вебмастер",
    "Bing Webmaster",
    "IndexNow",
    "Rich Results Test",
    "Валидатор микроразметки",
    "CRM",
    "consent",
    "docs/seo/ai-search-query-pack.md",
  ])
    assert.match(runbook, new RegExp(required.replaceAll(".", "\\."), "i"));
  assert.match(runbook, /D0[^\n]*только[^\n]*(?:доступност|reachability)/i);
  assert.match(runbook, /D7/);
  assert.match(runbook, /D30/);
  assert.match(runbook, /field Core Web Vitals[^\n]*не[^\n]*Lighthouse/i);
});
