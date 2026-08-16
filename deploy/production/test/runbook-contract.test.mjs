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

test("landing publication runbook derives legal release metadata from the legal package", async () => {
  const runbook = await read("docs/runbooks/landing-publication.md");
  assert.match(runbook, /@markiro\/legal-documents/);
  assert.match(runbook, /CURRENT_DEMO_CONSENT_ID/);
  for (const obsolete of [
    "PUBLIC_DEMO_CONSENT_VERSION",
    "LANDING_DEMO_CONSENT_VERSION",
    "PUBLIC_PRIVACY_POLICY_PATH",
    "PUBLIC_PERSONAL_DATA_CONSENT_PATH",
  ])
    assert.doesNotMatch(runbook, new RegExp(escapeRegExp(obsolete)));
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

test("landing publication records every external legal and artifact acceptance gate", async () => {
  const [runbook, secrets] = await Promise.all([
    read("docs/runbooks/landing-publication.md"),
    read("docs/runbooks/yandex-secrets.md"),
  ]);
  for (const required of [
    "квалифицированного российского юриста",
    "наименование провайдера",
    "договор с провайдером",
    "хранение в Российской Федерации",
    "Роскомнадзор",
    "уведомление не подано",
    "PDF/A-2b",
    "veraPDF 1.30.2",
    "Microsoft Word",
    "LibreOffice 26.2.5",
    "физическое сканирование",
    "A4",
    "12 месяцев",
    "удаление из почтового ящика",
  ])
    assert.match(runbook + "\n" + secrets, new RegExp(escapeRegExp(required), "i"));

  assert.match(runbook, /статус уведомления[^\n]*не является секретом/i);
  assert.match(runbook, /тесты репозитория не доказывают[^\n]*PDF\/A/i);
  assert.match(runbook, /тесты репозитория не доказывают[^\n]*Microsoft Word/i);
  assert.match(runbook, /тесты репозитория не доказывают[^\n]*физическ/i);
});

test("landing publication runbook maps every bounded deployment failure stage", async () => {
  const runbook = await read("docs/runbooks/landing-publication.md");
  const stages = [
    "configuration",
    "transfer",
    "reconcile-host",
    "runtime-inventory",
    "runtime-env",
    "prepare",
    "smoke",
    "finalize",
    "rollback",
  ];

  for (const stage of stages)
    assert.match(runbook, new RegExp(`MARKIRO_DEPLOY_FAILURE ${escapeRegExp(stage)}(?:\\s|\`)`));
});

test("landing publication runbook places runtime inventory before remote mutation", async () => {
  const runbook = await read("docs/runbooks/landing-publication.md");
  const transfer = runbook.indexOf("`MARKIRO_DEPLOY_FAILURE transfer` —");
  const inventory = runbook.indexOf("`MARKIRO_DEPLOY_FAILURE runtime-inventory` —");
  const reconcile = runbook.indexOf("`MARKIRO_DEPLOY_FAILURE reconcile-host` —");
  assert.ok(transfer >= 0 && inventory > transfer && reconcile > inventory);
  assert.match(runbook, /runtime-inventory[^\n]*только[^\n]*имен/i);
  assert.match(runbook, /до[^\n]*(?:reconcile|изменен)/i);
});

test("landing publication runbook gives bounded and recoverable inventory actions", async () => {
  const runbook = await read("docs/runbooks/landing-publication.md");
  for (const required of [
    ".env.production.example",
    "активной версии Lockbox",
    "только имена ключей",
    "новую версию Lockbox",
    "повторно запустить тот же failed deployment",
    "значения секретов",
    "логи",
    "issue",
  ])
    assert.match(runbook, new RegExp(escapeRegExp(required), "i"));

  for (const unproved of [
    "SMTP delivery",
    "captcha validity",
    "database connectivity",
    "application health",
  ])
    assert.match(
      runbook,
      new RegExp(`runtime-inventory[^\\n]*не доказывает[^\\n]*${escapeRegExp(unproved)}`, "i"),
    );
});
