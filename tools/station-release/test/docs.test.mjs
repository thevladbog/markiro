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
  assert.match(stableRunbook, /station-stable-channel/);
  assert.match(stableRunbook, /SmartScreen|неизвестн.*издател/i);
  assert.match(stableRunbook, /beta.*stable/is);
  assert.match(stableRunbook, /TAURI_SIGNING_PRIVATE_KEY/);
  assert.match(stableRunbook, /base64/i);
  assert.match(stableRunbook, /не\s+декодируйте.*не\s+перекодируйте.*не\s+нормализуйте/is);
  assert.match(stableAcceptance, /NOT RUN/);
  assert.match(stableAcceptance, /beta.*stable/is);
  assert.match(stableAcceptance, /stable.*stable/is);
  assert.match(betaRunbook, /station-stable-release/);
  assert.match(readme, /Manual stable updates/);
  assert.match(checklist, /Station stable/);
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
