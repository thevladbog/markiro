import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

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
    assert.match(runbook + "\n" + secrets, new RegExp(escapeRegExp(value)));
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
    assert.match(runbook, new RegExp(escapeRegExp(required), "i"));
  assert.match(runbook, /D0[^\n]*только[^\n]*(?:доступност|reachability)/i);
  assert.match(runbook, /D7/);
  assert.match(runbook, /D30/);
  assert.match(runbook, /field Core Web Vitals[^\n]*не[^\n]*Lighthouse/i);
});

test("landing publication runbook keeps demo email release gates observable", async () => {
  const runbook = await read("docs/runbooks/landing-publication.md");
  for (const required of [
    "postbox.sender",
    "yc.postbox.send",
    "postbox.cloud.yandex.net",
    "DKIM",
    "SPF",
    "DMARC",
    "hello@v-b.tech",
    "SmartCaptcha",
    "PUBLIC_DEMO_SUBMISSION_ENABLED",
    "LANDING_DEMO_SUBMISSION_ENABLED",
    "queued",
    "retrying",
    "failed",
  ])
    assert.match(runbook, new RegExp(escapeRegExp(required)));

  for (const unproved of [
    "юридическое одобрение",
    "live DNS/TLS",
    "приём sender identity в Postbox",
    "доставку письма во входящие",
    "размещение в спаме",
    "отображение в почтовых клиентах",
  ])
    assert.match(
      runbook,
      new RegExp(`Тесты репозитория не доказывают[^\\n]*${escapeRegExp(unproved)}`),
    );
});

test("landing publication runbook keeps enablement, monitoring, and rollback fail-closed", async () => {
  const runbook = await read("docs/runbooks/landing-publication.md");
  const disabledFirst = runbook.indexOf("Гейт 1. Развернуть код с двумя выключенными флагами");
  const controlledPair = runbook.indexOf("контролируемую RU/EN пару");
  const publicEnable = runbook.indexOf("Гейт 5. Собрать и опубликовать форму");
  assert.ok(disabledFirst >= 0 && controlledPair > disabledFirst && publicEnable > controlledPair);

  for (const required of [
    "один и тот же request UUID",
    "ровно две durable mail delivery rows",
    "ровно две durable outbox rows",
    "внутреннее письмо отвечает посетителю",
    "confirmation отвечает на публичный адрес Markiro",
    "400 + captcha_invalid",
    "503 + captcha_unavailable",
    "429 + rate_limited",
    "сначала выключить публичную форму",
    "сохранить уже созданные и queued письма",
    "отзыв credentials выполняется отдельно",
    "CRM integration остаётся отдельным release gate",
    "status/code",
    "locale",
    "source path",
  ])
    assert.match(runbook, new RegExp(escapeRegExp(required), "i"));
});
