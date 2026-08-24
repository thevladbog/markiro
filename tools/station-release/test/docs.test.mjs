import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("station beta docs cover manual promotion and recovery", async () => {
  const [runbook, acceptance, readme, checklist, roadmap] = await Promise.all([
    read("docs/runbooks/station-beta-release.md"),
    read("docs/acceptance/station-beta-release.md"),
    read("apps/station/README.md"),
    read("docs/hardware-acceptance-checklist.md"),
    read("docs/superpowers/plans/2026-07-21-markiro-mvp-roadmap.md"),
  ]);
  assert.match(runbook, /promote-existing/);
  assert.match(runbook, /TAURI_SIGNING_PRIVATE_KEY/);
  assert.match(runbook, /base64/i);
  assert.match(runbook, /не\s+декодируйте.*не\s+перекодируйте.*не\s+нормализуйте/is);
  assert.match(runbook, /SmartScreen|неподпис/i);
  assert.match(runbook, /outbox/i);
  assert.match(runbook, /ротац|rotation/i);
  assert.match(acceptance, /beta\.1/);
  assert.match(acceptance, /NOT RUN/);
  assert.match(readme, /Manual beta updates/);
  assert.match(checklist, /Manual station beta update/);
  assert.match(roadmap, /Tauri .*updater channel/);
  await access(new URL("docs/runbooks/station-beta-release.md", root));
  await access(new URL("docs/acceptance/station-beta-release.md", root));
});

test("station beta docs define dual-origin baseline, repair and restricted-network operations", async () => {
  const runbook = await read("docs/runbooks/station-beta-release.md");
  assert.match(runbook, /Environment `station-release`/);
  for (const name of [
    "YANDEX_STATION_RELEASE_ACCESS_KEY_ID",
    "YANDEX_STATION_RELEASE_SECRET_ACCESS_KEY",
    "YANDEX_STATION_RELEASE_BUCKET",
    "YANDEX_STATION_RELEASE_ENDPOINT",
  ]) {
    assert.match(runbook, new RegExp(name));
  }
  assert.match(runbook, /mode=seed-baseline/);
  assert.match(runbook, /--confirm-empty-channel-bootstrap/);
  assert.match(runbook, /enableStationReleasePublicDns.*false/is);
  assert.match(runbook, /нов.*pre-transition beta|pre-transition beta.*нов/is);
  assert.match(runbook, /legacy.*beta.*нельзя|нельзя.*legacy.*beta/is);
  assert.match(runbook, /полной.*пар.*Yandex|Yandex.*полной.*пар/is);
  assert.match(runbook, /station\/beta\/latest\.json/);
  assert.match(runbook, /station\/beta\/download/);
  assert.match(runbook, /promote-existing[\s\S]*не пересобирает[\s\S]*не загружает.*immutable/is);
  assert.match(runbook, /частичн.*origin|partial-origin/is);
  assert.match(runbook, /https:\/\/releases\.markiro\.app\/station\/download/);
  assert.match(runbook, /https:\/\/releases\.markiro\.app\/station\/beta\/download/);
  assert.match(runbook, /GitHub-only.*transitional beta|transitional beta.*GitHub-only/is);
  assert.match(runbook, /install-over|поверх существующей установки/i);
  assert.match(runbook, /ограниченн.*сет|restricted network/is);
});

test("station stable docs separate automated release proof from physical acceptance", async () => {
  const [stableRunbook, stableAcceptance, betaRunbook, readme, checklist] = await Promise.all([
    read("docs/runbooks/station-stable-release.md"),
    read("docs/acceptance/station-stable-release.md"),
    read("docs/runbooks/station-beta-release.md"),
    read("apps/station/README.md"),
    read("docs/hardware-acceptance-checklist.md"),
  ]);
  assert.match(stableRunbook, /station-stable/);
  assert.match(stableRunbook, /source_beta_tag/);
  assert.match(stableRunbook, /acceptance_confirmed/);
  assert.match(stableRunbook, /promote-existing/);
  assert.match(stableRunbook, /Environment `station-release`/);
  assert.match(stableRunbook, /mode=seed-baseline/);
  assert.match(stableRunbook, /seed_stable_tag/);
  assert.match(stableRunbook, /enableStationReleasePublicDns.*false/is);
  assert.match(stableRunbook, /legacy.*stable.*rollback baseline/is);
  assert.match(stableRunbook, /не retrofit|не.*retrofit/is);
  assert.match(stableRunbook, /GitHub.*Yandex.*beta evidence/is);
  assert.match(stableRunbook, /station\/stable\/latest\.json/);
  assert.match(stableRunbook, /https:\/\/releases\.markiro\.app\/station\/download/);
  assert.match(stableRunbook, /GitHub.*latest\.json.*Yandex.*latest\.json.*station\/download/is);
  assert.match(stableRunbook, /обратн.*порядк.*alias.*manifest.*GitHub/is);
  assert.match(
    stableRunbook,
    /promote-existing[\s\S]*не пересобирает[\s\S]*не загружает.*immutable/is,
  );
  assert.match(stableRunbook, /ограниченн.*сет|restricted network/is);
  assert.match(stableRunbook, /install-over|поверх существующей установки/i);
  assert.match(stableRunbook, /station-stable-channel/);
  assert.match(stableRunbook, /SmartScreen|неизвестн.*издател/i);
  assert.match(stableRunbook, /beta.*stable/is);
  assert.match(stableRunbook, /TAURI_SIGNING_PRIVATE_KEY/);
  assert.match(stableRunbook, /base64/i);
  assert.match(stableRunbook, /не\s+декодируйте.*не\s+перекодируйте.*не\s+нормализуйте/is);
  assert.match(stableAcceptance, /NOT RUN/);
  assert.match(stableAcceptance, /beta.*stable/is);
  assert.match(stableAcceptance, /stable.*stable/is);
  assert.match(stableAcceptance, /GitHub beta evidence SHA-256/);
  assert.match(stableAcceptance, /Yandex beta evidence SHA-256/);
  assert.match(stableAcceptance, /GitHub stable evidence SHA-256/);
  assert.match(stableAcceptance, /Yandex stable evidence SHA-256/);
  assert.match(stableAcceptance, /rollback/i);
  assert.match(stableAcceptance, /application identity/i);
  assert.match(stableAcceptance, /SQLite/i);
  assert.match(stableAcceptance, /pairing/i);
  assert.match(stableAcceptance, /settings/i);
  assert.match(stableAcceptance, /journals/i);
  assert.match(stableAcceptance, /exceptions/i);
  assert.match(stableAcceptance, /outbox/i);
  assert.match(betaRunbook, /station-stable-release/);
  assert.match(readme, /Manual stable updates/);
  assert.match(checklist, /Station stable/);
});

test("dual-origin rollout docs preserve the phased migration and recovery contract", async () => {
  const [bootstrap, beta, stable, acceptance] = await Promise.all([
    read("docs/runbooks/station-release-origin-bootstrap.md"),
    read("docs/runbooks/station-beta-release.md"),
    read("docs/runbooks/station-stable-release.md"),
    read("docs/acceptance/station-dual-origin-release.md"),
  ]);
  const combined = `${bootstrap}\n${beta}\n${stable}\n${acceptance}`;

  const phases = [
    "Phase 1 — provision without DNS",
    "Phase 2 — dual-publish tooling and seed",
    "Phase 3 — transitional beta",
    "Phase 4 — first dual-origin stable",
  ];
  let previous = -1;
  for (const phase of phases) {
    const index = bootstrap.indexOf(phase);
    assert.ok(index > previous, `missing or unordered ${phase}`);
    previous = index;
  }

  for (const url of [
    "https://releases.markiro.app/station/download",
    "https://releases.markiro.app/station/beta/download",
    "https://releases.markiro.app/station/stable/latest.json",
    "https://releases.markiro.app/station/beta/latest.json",
    "https://github.com/thevladbog/markiro/releases/download/station-stable-channel/latest.json",
    "https://github.com/thevladbog/markiro/releases/download/station-beta-channel/latest.json",
  ]) {
    assert.match(combined, new RegExp(url.replaceAll(".", "\\.")));
  }

  assert.match(bootstrap, /Task 12.*not authorized|Task 12.*не авторизован/is);
  assert.match(
    combined,
    /immutable historical releases.*not.*retrofit|историческ.*immutable.*не.*retrofit/is,
  );
  assert.match(combined, /GitHub-reachable|GitHub доступен/i);
  assert.match(combined, /GitHub-blocked|GitHub.*заблокирован/i);
  assert.match(combined, /first-run rollback baseline|перв.*rollback baseline/i);
  assert.match(combined, /mode=publish/);
  assert.match(combined, /mode=promote-existing/);
  assert.match(combined, /partial-origin/i);
  assert.match(combined, /alias.*Yandex manifest.*GitHub manifest/is);
  assert.match(combined, /manual-only|только вручную|работает вручную/i);
  assert.match(combined, /active shift|активн.*смен/is);
  assert.match(combined, /без Authenticode|no Authenticode|NSIS не имеет Authenticode/is);
});

test("dual-origin acceptance matrix retains every evidence field and required scenario", async () => {
  const acceptance = await read("docs/acceptance/station-dual-origin-release.md");

  for (const field of [
    "Exact release tag",
    "baseSha",
    "releaseSha",
    "GitHub evidence SHA-256",
    "Yandex evidence SHA-256",
    "GitHub immutable URL",
    "Yandex immutable URL",
    "GitHub channel URL",
    "Yandex channel URL",
    "Installer URL",
  ]) {
    assert.match(acceptance, new RegExp(field));
  }

  assert.match(
    acceptance,
    /\| Scenario\s*\| Evidence class\s*\| Result\s*\| Operator \| UTC timestamp \| Device \/ Windows identity \| Evidence path \/ SHA-256 \|/,
  );
  assert.match(
    acceptance,
    /Automated CI and host proof[\s\S]*Windows, hardware, and customer proof/i,
  );

  const scenarios = [
    "BASELINE-01",
    "PUBLISH-01",
    "RECOVERY-01",
    "RECOVERY-02",
    "NETWORK-01",
    "NETWORK-02",
    "NETWORK-03",
    "INTEGRITY-01",
    "INTEGRITY-02",
    "MIGRATION-01",
    "MIGRATION-02",
    "PRESERVE-01",
    "PRESERVE-02",
    "PRESERVE-03",
    "PRESERVE-04",
    "PRESERVE-05",
    "PRESERVE-06",
    "PRESERVE-07",
    "PRESERVE-08",
    "SHIFT-01",
    "RECOVERY-03",
    "HARDWARE-01",
    "HARDWARE-02",
    "HARDWARE-03",
    "HARDWARE-04",
    "WINDOWS-01",
    "WINDOWS-02",
    "OFFLINE-01",
    "ROLLBACK-01",
  ];
  for (const scenario of scenarios) {
    assert.equal(
      [...acceptance.matchAll(new RegExp(`\\| ${scenario} `, "g"))].length,
      1,
      `${scenario} must have exactly one matrix row`,
    );
  }

  const scenarioRows = acceptance
    .split("\n")
    .filter((line) =>
      /^\| (?:BASELINE|PUBLISH|RECOVERY|NETWORK|INTEGRITY|MIGRATION|PRESERVE|SHIFT|HARDWARE|WINDOWS|OFFLINE|ROLLBACK)-\d{2} /.test(
        line,
      ),
    );
  assert.equal(scenarioRows.length, scenarios.length);
  for (const row of scenarioRows) {
    assert.match(row, /\| NOT_RUN \|\s*\|\s*\|\s*\|\s*\|$/);
  }
});

test("Station release origin bootstrap separates protected credentials and approval gates", async () => {
  const [infrastructure, secrets, bootstrap] = await Promise.all([
    read("docs/runbooks/yandex-infrastructure.md"),
    read("docs/runbooks/yandex-infrastructure-secrets.md"),
    read("docs/runbooks/station-release-origin-bootstrap.md"),
  ]);
  const combined = `${infrastructure}\n${secrets}\n${bootstrap}`;

  for (const value of [
    "YC_STATION_RELEASE_BUCKET_NAME",
    "MARKIRO_STATION_RELEASE_DOMAIN",
    "YC_STATION_RELEASE_PUBLISHER_PGP_KEY",
    "YANDEX_STATION_RELEASE_ACCESS_KEY_ID",
    "YANDEX_STATION_RELEASE_SECRET_ACCESS_KEY",
    "YANDEX_STATION_RELEASE_BUCKET",
    "YANDEX_STATION_RELEASE_ENDPOINT",
  ]) {
    assert.match(combined, new RegExp(value));
  }
  assert.match(secrets, /GitHub Environment `station-release`/);
  assert.match(secrets, /защит.*environment|environment.*защит/is);
  assert.match(secrets, /не созда(?:е|ё|ю)т.*Environment|Environment.*созда(?:е|ё|ю)т/is);
  const stationReleaseInventory = secrets.match(
    /## GitHub Environment `station-release`([\s\S]*?)## Ротация/,
  )?.[1];
  assert.ok(stationReleaseInventory);
  assert.deepEqual(
    [...stationReleaseInventory.matchAll(/- (?:secret|variable) `([^`]+)`/g)].map(
      (match) => match[1],
    ),
    [
      "YANDEX_STATION_RELEASE_ACCESS_KEY_ID",
      "YANDEX_STATION_RELEASE_SECRET_ACCESS_KEY",
      "YANDEX_STATION_RELEASE_BUCKET",
      "YANDEX_STATION_RELEASE_ENDPOINT",
    ],
  );

  const ordered = [
    "## 1. Подготовить защищённый план без release DNS",
    "## 2. Остановиться перед первым apply",
    "## 3. Получить зашифрованные outputs из защищённого state",
    "## 4. Расшифровать секрет локально",
    "## 5. Остановиться перед записью GitHub secrets",
    "## 6. Проверить разрешения только в release prefix",
    "## 7. Проверить certificate challenge",
    "## 8. Засеять baseline и проверить provider host",
    "## 9. Остановиться перед включением release DNS",
  ];
  let previous = -1;
  for (const heading of ordered) {
    const index = bootstrap.indexOf(heading);
    assert.ok(index > previous, `missing or unordered ${heading}`);
    previous = index;
  }

  assert.match(bootstrap, /enable_station_release_public_dns=false/);
  assert.match(bootstrap, /enable_station_release_public_dns=true/);
  assert.match(bootstrap, /umask 077/);
  assert.match(bootstrap, /mktemp -d/);
  assert.match(bootstrap, /chmod 600/);
  assert.match(bootstrap, /trap cleanup/);
  assert.match(
    bootstrap,
    /gpg --batch --quiet --decrypt "\$encrypted_packet_file" > "\$secret_key_file"/,
  );
  assert.doesNotMatch(bootstrap, /gpg[^\n]*--output "\$secret_key_file"/);
  assert.match(
    bootstrap,
    /gh secret set YANDEX_STATION_RELEASE_ACCESS_KEY_ID --env station-release < "\$access_key_file"/,
  );
  assert.match(
    bootstrap,
    /gh secret set YANDEX_STATION_RELEASE_SECRET_ACCESS_KEY --env station-release < "\$secret_key_file"/,
  );
  assert.match(bootstrap, /DELETE-PLAINTEXT/);
  assert.match(bootstrap, /release_prefix='station\/'/);
  assert.match(bootstrap, /storage\.yandexcloud\.net/);
  assert.match(bootstrap, /ISSUED/);
  assert.match(bootstrap, /baseline/is);
  assert.match(bootstrap, /отдельн.*одобрен.*apply/is);
  assert.match(infrastructure, /mode=plan/);
  assert.match(infrastructure, /mode=apply/);
  assert.match(infrastructure, /production-infrastructure-apply/);
  assert.match(infrastructure, /production\/plans\//);
  assert.match(infrastructure, /plan_key/);
  assert.match(infrastructure, /plan_sha256/);
  assert.match(infrastructure, /plan_version_id/);
  assert.match(infrastructure, /GITHUB_RUN_ATTEMPT/);
  assert.match(infrastructure, /точн.*key.*VersionId|key.*точн.*VersionId/is);
  assert.match(infrastructure, /residual|остаточн/is);
  assert.match(infrastructure, /version-id|VersionId/);
  assert.ok(bootstrap.indexOf("STOP 1 — APPLY") < bootstrap.indexOf("вручную разрешает apply"));
  assert.ok(
    bootstrap.indexOf("STOP 2 — SECRETS") <
      bootstrap.indexOf("gh secret set YANDEX_STATION_RELEASE_ACCESS_KEY_ID"),
  );
  assert.ok(
    bootstrap.indexOf("STOP 3 — DNS") < bootstrap.indexOf("enable_station_release_public_dns=true"),
  );

  assert.doesNotMatch(
    bootstrap,
    /gh secret set YANDEX_STATION_RELEASE_(?:ACCESS_KEY_ID|SECRET_ACCESS_KEY)[^\n]*(?:--body|--value|=\$)/,
  );
  assert.doesNotMatch(combined, /actions\/upload-artifact/);
});
