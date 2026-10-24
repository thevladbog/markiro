import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

const scenarioLinePattern = /^\| [A-Z]+(?:-[A-Z]+)*-\d{2} — /;
const scenarioId = (cells) => cells[0].split(" — ", 1)[0];
const parseScenarioRows = (markdown) =>
  markdown
    .split("\n")
    .filter((line) => scenarioLinePattern.test(line))
    .map((line) =>
      line
        .split("|")
        .slice(1, -1)
        .map((cell) => cell.trim().replace(/\s+/g, " ")),
    );

const scenarioTuple = (cells) => {
  assert.equal(cells.length, 8, `${cells[0]} column inventory`);
  const separator = cells[0].indexOf(" — ");
  assert.ok(separator > 0, `${cells[0]} scenario separator`);
  assert.equal(cells[0].indexOf(" — ", separator + 3), -1, `${cells[0]} unique separator`);
  return [cells[0].slice(0, separator), cells[0].slice(separator + 3), ...cells.slice(1)];
};

const mutateScenarioRows = (markdown, mutations) => {
  const seen = new Set();
  const result = markdown
    .split("\n")
    .map((line) => {
      if (!scenarioLinePattern.test(line)) return line;
      const cells = line
        .split("|")
        .slice(1, -1)
        .map((cell) => cell.trim());
      const id = scenarioId(cells);
      const mutation = mutations[id];
      if (!mutation) return line;
      seen.add(id);
      const mutated = mutation([...cells]);
      assert.notDeepEqual(mutated, cells, `${id} mutation must change the row`);
      return `| ${mutated.join(" | ")} |`;
    })
    .join("\n");
  assert.deepEqual([...seen].sort(), Object.keys(mutations).sort(), "mutation target inventory");
  return result;
};

const expectedBootstrapScenarios = [
  [
    "BASELINE-01",
    "the strict DNS-disabled Phase 2 pre-transition beta rollback baseline is complete, publicly/provider-read verified, and no historical immutable release was retrofitted",
    "BOOTSTRAP_READY",
    "Live cloud/publication",
    "NOT_RUN",
    "",
    "",
    "",
    "",
  ],
  [
    "BOOTSTRAP-PUBLISH-01",
    "the first dual-origin-adapter bootstrap beta normal `mode=publish` produces and publicly revalidates both immutable trees before both manifests and the beta alias promotion",
    "BOOTSTRAP_READY",
    "Live publication",
    "NOT_RUN",
    "",
    "",
    "",
    "",
  ],
  [
    "BOOTSTRAP-MIGRATION-01",
    "a GitHub-reachable legacy client uses the exact public binary-repository installer for a manual install-over to the bootstrap beta",
    "BOOTSTRAP_READY",
    "Windows migration",
    "NOT_RUN",
    "",
    "",
    "",
    "",
  ],
  [
    "BOOTSTRAP-MIGRATION-02",
    "a GitHub-blocked legacy client uses the verified explicit Yandex beta installer for a manual install-over to the bootstrap beta",
    "BOOTSTRAP_READY",
    "Restricted-network migration",
    "NOT_RUN",
    "",
    "",
    "",
    "",
  ],
  [
    "BOOTSTRAP-PRESERVE-01",
    "application ID `app.markiro.station` is unchanged across bootstrap install-over",
    "BOOTSTRAP_READY",
    "Windows data preservation",
    "NOT_RUN",
    "",
    "",
    "",
    "",
  ],
  [
    "BOOTSTRAP-PRESERVE-02",
    "`station-mirror.db` stays readable with the prior data at the resolved Station SQLite path, which a storage-move build relocates once from the roaming profile to the local app data folder",
    "BOOTSTRAP_READY",
    "Windows data preservation",
    "NOT_RUN",
    "",
    "",
    "",
    "",
  ],
  [
    "BOOTSTRAP-PRESERVE-03",
    "station identity and pairing remain usable without re-pairing or exposing credentials",
    "BOOTSTRAP_READY",
    "Windows data preservation",
    "NOT_RUN",
    "",
    "",
    "",
    "",
  ],
  [
    "BOOTSTRAP-PRESERVE-04",
    "local hardware and operator settings remain present after bootstrap install-over",
    "BOOTSTRAP_READY",
    "Windows data preservation",
    "NOT_RUN",
    "",
    "",
    "",
    "",
  ],
  [
    "BOOTSTRAP-PRESERVE-05",
    "scan and print journals retain safe before/after identifiers and counts",
    "BOOTSTRAP_READY",
    "Windows data preservation",
    "NOT_RUN",
    "",
    "",
    "",
    "",
  ],
  [
    "BOOTSTRAP-PRESERVE-06",
    "open/closed boxes and pending print recovery retain safe identifiers and SSCC relationships",
    "BOOTSTRAP_READY",
    "Windows data preservation",
    "NOT_RUN",
    "",
    "",
    "",
    "",
  ],
  [
    "BOOTSTRAP-PRESERVE-07",
    "exceptions remain visible, recoverable, and synchronized according to prior state",
    "BOOTSTRAP_READY",
    "Windows data preservation",
    "NOT_RUN",
    "",
    "",
    "",
    "",
  ],
  [
    "BOOTSTRAP-PRESERVE-08",
    "pending outbox entries survive bootstrap install/restart and later synchronize without duplication or deletion",
    "BOOTSTRAP_READY",
    "Windows data preservation",
    "NOT_RUN",
    "",
    "",
    "",
    "",
  ],
  [
    "BOOTSTRAP-BASIC-01",
    "packaged bootstrap Station starts on the identified Windows and WebView2 runtime, opens the manual update center, and completes a manual update check",
    "BOOTSTRAP_READY",
    "Windows basic operation",
    "NOT_RUN",
    "",
    "",
    "",
    "",
  ],
  [
    "BOOTSTRAP-BASIC-02",
    "the configured scanner accepts a production-like scan through the supported serial or keyboard-wedge path",
    "BOOTSTRAP_READY",
    "Physical scanner smoke",
    "NOT_RUN",
    "",
    "",
    "",
    "",
  ],
  [
    "BOOTSTRAP-BASIC-03",
    "the configured printer completes a print and preserves recoverability across a reported failure and retry",
    "BOOTSTRAP_READY",
    "Physical printer smoke",
    "NOT_RUN",
    "",
    "",
    "",
    "",
  ],
];

const expectedBetaScenarios = [
  [
    "BETA-PUBLISH-01",
    "the strictly newer validation/candidate beta normal `mode=publish` produces and publicly revalidates both immutable trees before both manifests and the beta alias promotion",
    "BETA_SIGN_OFF",
    "Live publication",
    "NOT_RUN",
    "",
    "",
    "",
    "",
  ],
  [
    "BETA-RECOVERY-01",
    "mutable-only recovery uses `mode=promote-existing` with the exact validation/candidate `repair_tag` after both existing immutable trees validate and match",
    "BETA_SIGN_OFF",
    "Live publication recovery",
    "NOT_RUN",
    "",
    "",
    "",
    "",
  ],
  [
    "BETA-RECOVERY-02",
    "a partial origin or origin mismatch is preserved as an incident; no overwrite, cross-copy, or mutable promotion occurs",
    "BETA_SIGN_OFF",
    "Live publication incident",
    "NOT_RUN",
    "",
    "",
    "",
    "",
  ],
  [
    "BETA-UPDATE-01",
    "bootstrap beta → validation/candidate beta Yandex primary update succeeds with GitHub blocked, including Yandex metadata selection and Yandex package download",
    "BETA_SIGN_OFF",
    "Customer restricted network",
    "NOT_RUN",
    "",
    "",
    "",
    "",
  ],
  [
    "BETA-METADATA-FALLBACK-01",
    "validation/candidate metadata request at Yandex fails before selection, then the exact GitHub fallback metadata is rechecked and visibly used",
    "BETA_SIGN_OFF",
    "Customer fallback network",
    "NOT_RUN",
    "",
    "",
    "",
    "",
  ],
  [
    "BETA-PACKAGE-FALLBACK-01",
    "validation/candidate Yandex metadata selects the candidate, its package download fails before install, then the exact GitHub fallback is rechecked and visibly supplies the package",
    "BETA_SIGN_OFF",
    "Customer fallback network",
    "NOT_RUN",
    "",
    "",
    "",
    "",
  ],
  [
    "BETA-NO-UPDATE-01",
    "a valid validation/candidate Yandex beta no-update response is authoritative and causes no GitHub request",
    "BETA_SIGN_OFF",
    "Customer network/diagnostics",
    "NOT_RUN",
    "",
    "",
    "",
    "",
  ],
  [
    "BETA-INTEGRITY-01",
    "validation/candidate origin version, date, target, or signature mismatch is terminal; no package request, install, or silent fallback starts",
    "BETA_SIGN_OFF",
    "Windows integrity boundary",
    "NOT_RUN",
    "",
    "",
    "",
    "",
  ],
  [
    "BETA-INTEGRITY-02",
    "a bad validation/candidate updater signature is terminal; no fallback or installer process starts",
    "BETA_SIGN_OFF",
    "Windows integrity boundary",
    "NOT_RUN",
    "",
    "",
    "",
    "",
  ],
  [
    "BETA-PRESERVE-01",
    "application ID `app.markiro.station` is unchanged from bootstrap through validation/candidate update",
    "BETA_SIGN_OFF",
    "Windows data preservation",
    "NOT_RUN",
    "",
    "",
    "",
    "",
  ],
  [
    "BETA-PRESERVE-02",
    "`station-mirror.db` stays readable at the resolved Station SQLite path after validation/candidate update; a storage-move build relocates it once from the roaming profile to the local app data folder",
    "BETA_SIGN_OFF",
    "Windows data preservation",
    "NOT_RUN",
    "",
    "",
    "",
    "",
  ],
  [
    "BETA-PRESERVE-03",
    "station identity and pairing remain usable without re-pairing or exposing credentials",
    "BETA_SIGN_OFF",
    "Windows data preservation",
    "NOT_RUN",
    "",
    "",
    "",
    "",
  ],
  [
    "BETA-PRESERVE-04",
    "local hardware and operator settings remain present after validation/candidate update",
    "BETA_SIGN_OFF",
    "Windows data preservation",
    "NOT_RUN",
    "",
    "",
    "",
    "",
  ],
  [
    "BETA-PRESERVE-05",
    "scan and print journals retain safe before/after identifiers and counts",
    "BETA_SIGN_OFF",
    "Windows data preservation",
    "NOT_RUN",
    "",
    "",
    "",
    "",
  ],
  [
    "BETA-PRESERVE-06",
    "open/closed boxes and pending print recovery retain safe identifiers and SSCC relationships",
    "BETA_SIGN_OFF",
    "Windows data preservation",
    "NOT_RUN",
    "",
    "",
    "",
    "",
  ],
  [
    "BETA-PRESERVE-07",
    "exceptions remain visible, recoverable, and synchronized according to prior state",
    "BETA_SIGN_OFF",
    "Windows data preservation",
    "NOT_RUN",
    "",
    "",
    "",
    "",
  ],
  [
    "BETA-PRESERVE-08",
    "pending outbox entries survive validation/candidate install/restart and later synchronize without duplication or deletion",
    "BETA_SIGN_OFF",
    "Windows data preservation",
    "NOT_RUN",
    "",
    "",
    "",
    "",
  ],
  [
    "BETA-SHIFT-01",
    "an active shift denies installation while scans, printing, journals, boxes, exceptions, and outbox continue; install becomes available only after safe shift closure",
    "BETA_SIGN_OFF",
    "Packaged Windows/active shift",
    "NOT_RUN",
    "",
    "",
    "",
    "",
  ],
  [
    "BETA-RECOVERY-03",
    "restart while offline and later reconnect preserve the selected validation/candidate beta and all durable Station work",
    "BETA_SIGN_OFF",
    "Packaged Windows/recovery",
    "NOT_RUN",
    "",
    "",
    "",
    "",
  ],
  [
    "BETA-HARDWARE-01",
    "configured scanner serial and keyboard-wedge paths accept production-like scans after update",
    "BETA_SIGN_OFF",
    "Physical scanner",
    "NOT_RUN",
    "",
    "",
    "",
    "",
  ],
  [
    "BETA-HARDWARE-02",
    "configured printer prints, reports failure, retries, and supports scan-back without losing the pending box",
    "BETA_SIGN_OFF",
    "Physical printer",
    "NOT_RUN",
    "",
    "",
    "",
    "",
  ],
  [
    "BETA-HARDWARE-03",
    "operator sounds remain audible and correctly mapped after update",
    "BETA_SIGN_OFF",
    "Physical audio",
    "NOT_RUN",
    "",
    "",
    "",
    "",
  ],
  [
    "BETA-HARDWARE-04",
    "touch controls, fullscreen, and supported viewport remain operable after update",
    "BETA_SIGN_OFF",
    "Physical touch/display",
    "NOT_RUN",
    "",
    "",
    "",
    "",
  ],
  [
    "BETA-WINDOWS-01",
    "packaged Station starts and updates under the identified Windows and WebView2 runtime",
    "BETA_SIGN_OFF",
    "Windows/WebView2",
    "NOT_RUN",
    "",
    "",
    "",
    "",
  ],
  [
    "BETA-WINDOWS-02",
    "unsigned NSIS and the actual SmartScreen/unknown-publisher outcome are recorded without treating the Tauri updater signature as Authenticode",
    "BETA_SIGN_OFF",
    "Windows NSIS/SmartScreen",
    "NOT_RUN",
    "",
    "",
    "",
    "",
  ],
  [
    "BETA-OFFLINE-01",
    "a complete shift continues offline through scan, journal, box/exception handling, restart, and later outbox reconnect",
    "BETA_SIGN_OFF",
    "Packaged Windows/offline shift",
    "NOT_RUN",
    "",
    "",
    "",
    "",
  ],
  [
    "BETA-ROLLBACK-01",
    "the bootstrap predecessor is deliberately re-promoted by exact `repair_tag`; both beta channel manifests and the beta alias are verified against its immutable trees",
    "BETA_SIGN_OFF",
    "Live publication rollback",
    "NOT_RUN",
    "",
    "",
    "",
    "",
  ],
  [
    "BETA-ROLLBACK-02",
    "the validation/candidate beta is then re-promoted by exact `repair_tag`; both beta channel manifests and the beta alias are verified again before beta Overall can pass",
    "BETA_SIGN_OFF",
    "Live publication restoration",
    "NOT_RUN",
    "",
    "",
    "",
    "",
  ],
];

const expectedStableScenarios = [
  [
    "PUBLISH-01",
    "first dual-origin stable normal `mode=publish` creates and publicly revalidates both immutable trees before GitHub manifest, Yandex manifest, and default stable alias promotion",
    "FIRST_STABLE_SIGN_OFF",
    "Live publication",
    "NOT_RUN",
    "",
    "",
    "",
    "",
  ],
  [
    "STABLE-RECOVERY-01",
    "stable mutable-only repair revalidates the exact accepted beta and both stable immutable trees before using the protected promotion transaction",
    "FIRST_STABLE_SIGN_OFF",
    "Live publication recovery",
    "NOT_RUN",
    "",
    "",
    "",
    "",
  ],
  [
    "STABLE-RECOVERY-02",
    "a partial origin or origin mismatch is preserved as an incident; no overwrite, cross-copy, or mutable promotion occurs",
    "FIRST_STABLE_SIGN_OFF",
    "Live publication incident",
    "NOT_RUN",
    "",
    "",
    "",
    "",
  ],
  [
    "STABLE-INSTALL-01",
    "beta → stable manual install-over uses the verified default Yandex installer outside an active shift",
    "FIRST_STABLE_SIGN_OFF",
    "Packaged Windows migration",
    "NOT_RUN",
    "",
    "",
    "",
    "",
  ],
  [
    "STABLE-CURRENT-01",
    "the installed first stable receives an authoritative Yandex stable no-update response and makes no GitHub request",
    "FIRST_STABLE_SIGN_OFF",
    "Customer network/diagnostics",
    "NOT_RUN",
    "",
    "",
    "",
    "",
  ],
  [
    "STABLE-UPDATE-01",
    "stable → stable Yandex primary update succeeds with GitHub blocked, including Yandex metadata selection and Yandex package download",
    "SUBSEQUENT_STABLE_SIGN_OFF",
    "Customer restricted network",
    "NOT_RUN",
    "",
    "",
    "",
    "",
  ],
  [
    "STABLE-METADATA-FALLBACK-01",
    "stable update metadata request fails at Yandex before candidate selection, then the exact GitHub fallback metadata is rechecked and visibly used",
    "SUBSEQUENT_STABLE_SIGN_OFF",
    "Customer fallback network",
    "NOT_RUN",
    "",
    "",
    "",
    "",
  ],
  [
    "STABLE-PACKAGE-FALLBACK-01",
    "stable Yandex metadata selects a candidate, its package download fails before install, then the exact GitHub fallback is rechecked and visibly supplies the package",
    "SUBSEQUENT_STABLE_SIGN_OFF",
    "Customer fallback network",
    "NOT_RUN",
    "",
    "",
    "",
    "",
  ],
  [
    "STABLE-INTEGRITY-01",
    "a stable origin mismatch is terminal; no package request, install, or silent fallback starts",
    "SUBSEQUENT_STABLE_SIGN_OFF",
    "Windows integrity boundary",
    "NOT_RUN",
    "",
    "",
    "",
    "",
  ],
  [
    "STABLE-INTEGRITY-02",
    "a bad updater signature is terminal; no fallback or installer process starts",
    "SUBSEQUENT_STABLE_SIGN_OFF",
    "Windows integrity boundary",
    "NOT_RUN",
    "",
    "",
    "",
    "",
  ],
  [
    "PRESERVE-01",
    "application ID is `app.markiro.station` before and after stable install-over",
    "EVERY_STABLE_SIGN_OFF",
    "Windows data preservation",
    "NOT_RUN",
    "",
    "",
    "",
    "",
  ],
  [
    "PRESERVE-02",
    "`station-mirror.db` stays readable at the resolved Station SQLite path; a storage-move build relocates it once from the roaming profile to the local app data folder",
    "EVERY_STABLE_SIGN_OFF",
    "Windows data preservation",
    "NOT_RUN",
    "",
    "",
    "",
    "",
  ],
  [
    "PRESERVE-03",
    "station identity and pairing remain usable without re-pairing or exposing credentials",
    "EVERY_STABLE_SIGN_OFF",
    "Windows data preservation",
    "NOT_RUN",
    "",
    "",
    "",
    "",
  ],
  [
    "PRESERVE-04",
    "local hardware and operator settings remain present",
    "EVERY_STABLE_SIGN_OFF",
    "Windows data preservation",
    "NOT_RUN",
    "",
    "",
    "",
    "",
  ],
  [
    "PRESERVE-05",
    "scan and print journals retain safe before/after identifiers and counts",
    "EVERY_STABLE_SIGN_OFF",
    "Windows data preservation",
    "NOT_RUN",
    "",
    "",
    "",
    "",
  ],
  [
    "PRESERVE-06",
    "open/closed boxes and pending print recovery retain safe identifiers and SSCC relationships",
    "EVERY_STABLE_SIGN_OFF",
    "Windows data preservation",
    "NOT_RUN",
    "",
    "",
    "",
    "",
  ],
  [
    "PRESERVE-07",
    "exceptions remain visible, recoverable, and synchronized according to prior state",
    "EVERY_STABLE_SIGN_OFF",
    "Windows data preservation",
    "NOT_RUN",
    "",
    "",
    "",
    "",
  ],
  [
    "PRESERVE-08",
    "pending outbox entries survive install/restart and later synchronize without duplication or deletion",
    "EVERY_STABLE_SIGN_OFF",
    "Windows data preservation",
    "NOT_RUN",
    "",
    "",
    "",
    "",
  ],
  [
    "SHIFT-01",
    "an active shift denies installation while scans, printing, journals, boxes, exceptions, and outbox continue; install becomes available only after safe shift closure",
    "EVERY_STABLE_SIGN_OFF",
    "Packaged Windows/active shift",
    "NOT_RUN",
    "",
    "",
    "",
    "",
  ],
  [
    "RECOVERY-03",
    "restart while offline and later reconnect preserve the selected stable state and all durable Station work",
    "EVERY_STABLE_SIGN_OFF",
    "Packaged Windows/recovery",
    "NOT_RUN",
    "",
    "",
    "",
    "",
  ],
  [
    "HARDWARE-01",
    "configured scanner serial and keyboard-wedge paths accept production-like scans after update",
    "EVERY_STABLE_SIGN_OFF",
    "Physical scanner",
    "NOT_RUN",
    "",
    "",
    "",
    "",
  ],
  [
    "HARDWARE-02",
    "configured printer prints, reports failure, retries, and supports scan-back without losing the pending box",
    "EVERY_STABLE_SIGN_OFF",
    "Physical printer",
    "NOT_RUN",
    "",
    "",
    "",
    "",
  ],
  [
    "HARDWARE-03",
    "operator sounds remain audible and correctly mapped after update",
    "EVERY_STABLE_SIGN_OFF",
    "Physical audio",
    "NOT_RUN",
    "",
    "",
    "",
    "",
  ],
  [
    "HARDWARE-04",
    "touch controls, fullscreen, and supported viewport remain operable after update",
    "EVERY_STABLE_SIGN_OFF",
    "Physical touch/display",
    "NOT_RUN",
    "",
    "",
    "",
    "",
  ],
  [
    "WINDOWS-01",
    "packaged Station starts and updates under the identified Windows and WebView2 runtime",
    "EVERY_STABLE_SIGN_OFF",
    "Windows/WebView2",
    "NOT_RUN",
    "",
    "",
    "",
    "",
  ],
  [
    "WINDOWS-02",
    "unsigned NSIS and the actual SmartScreen/unknown-publisher outcome are recorded without treating the Tauri updater signature as Authenticode",
    "EVERY_STABLE_SIGN_OFF",
    "Windows NSIS/SmartScreen",
    "NOT_RUN",
    "",
    "",
    "",
    "",
  ],
  [
    "OFFLINE-01",
    "a complete shift continues offline through scan, journal, box/exception handling, restart, and later outbox reconnect",
    "EVERY_STABLE_SIGN_OFF",
    "Packaged Windows/offline shift",
    "NOT_RUN",
    "",
    "",
    "",
    "",
  ],
  [
    "ROLLBACK-01",
    "the previous accepted stable is deliberately re-promoted using its recorded `source_beta_tag`; both stable channel manifests and the default alias are verified against its immutable trees",
    "SUBSEQUENT_STABLE_SIGN_OFF",
    "Live publication rollback",
    "NOT_RUN",
    "",
    "",
    "",
    "",
  ],
  [
    "ROLLBACK-02",
    "the current candidate stable is then re-promoted using its recorded `source_beta_tag`; both stable channel manifests and the default alias are verified again before stable Overall can pass",
    "SUBSEQUENT_STABLE_SIGN_OFF",
    "Live publication restoration",
    "NOT_RUN",
    "",
    "",
    "",
    "",
  ],
];

const expectedAcceptanceScenarios = [
  ...expectedBootstrapScenarios,
  ...expectedBetaScenarios,
  ...expectedStableScenarios,
];

const assertAcceptanceScenarioTable = (markdown) => {
  const actual = parseScenarioRows(markdown).map(scenarioTuple);
  const actualIds = actual.map(([id]) => id);
  const expectedIds = expectedAcceptanceScenarios.map(([id]) => id);
  assert.equal(new Set(actualIds).size, actualIds.length, "scenario IDs must be unique");
  assert.equal(
    new Set(expectedIds).size,
    expectedIds.length,
    "expected scenario IDs must be unique",
  );
  assert.deepStrictEqual(actual, expectedAcceptanceScenarios);
};

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
  assert.match(runbook, /owner_confirmation.*PUBLISH-STATION-BETA/is);
  assert.match(runbook, /владел.*репозитор.*github\.actor.*github\.repository_owner/is);
  for (const name of [
    "RELEASES_S3_ACCESS_KEY_ID",
    "RELEASES_S3_SECRET_ACCESS_KEY",
    "RELEASES_S3_BUCKET",
    "RELEASES_S3_ENDPOINT",
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
  assert.match(runbook, /private.*source repository|приватн.*source repository/is);
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
  assert.match(stableRunbook, /owner_confirmation.*PUBLISH-STATION-STABLE/is);
  assert.match(stableRunbook, /владел.*репозитор.*github\.actor.*github\.repository_owner/is);
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
    "https://github.com/thevladbog/markiro-station-releases/releases/download/station-stable-channel/latest.json",
    "https://github.com/thevladbog/markiro-station-releases/releases/download/station-beta-channel/latest.json",
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

test("dual-origin acceptance uses non-circular phase gates", async () => {
  const [bootstrap, acceptance] = await Promise.all([
    read("docs/runbooks/station-release-origin-bootstrap.md"),
    read("docs/acceptance/station-dual-origin-release.md"),
  ]);

  assert.match(acceptance, /## Gate model/);
  assert.match(acceptance, /## Bootstrap beta readiness record/);
  assert.match(acceptance, /## Validation\/candidate beta acceptance record/);
  assert.match(acceptance, /## Stable acceptance record/);
  assert.match(
    acceptance,
    /`BASELINE-01`[\s\S]*`PASS`[\s\S]*permits[\s\S]*bootstrap beta publication/i,
  );
  assert.match(
    acceptance,
    /every `BOOTSTRAP_READY` row[\s\S]*`PASS`[\s\S]*permits[\s\S]*validation\/candidate beta/i,
  );
  assert.match(acceptance, /validation\/candidate beta[\s\S]*strictly newer[\s\S]*bootstrap beta/i);
  assert.match(acceptance, /`BETA_SIGN_OFF` applies only to[\s\S]*validation\/candidate beta/i);
  assert.match(
    acceptance,
    /first stable publication requires[\s\S]*validation\/candidate beta[\s\S]*Overall result[\s\S]*`PASS`/i,
  );
  assert.match(acceptance, /stable `source_beta_tag`[\s\S]*exact validation\/candidate beta tag/i);
  assert.match(acceptance, /`PUBLISH-01`[\s\S]*does not block[\s\S]*first stable publication/i);
  assert.match(acceptance, /`NOT_RUN`[\s\S]*blocks[\s\S]*sign-off[\s\S]*Required for/i);
  assert.match(acceptance, /`SUBSEQUENT_STABLE_SIGN_OFF`[\s\S]*does not block[\s\S]*first stable/i);
  assert.match(
    bootstrap,
    /Phase 3 — transitional beta[\s\S]*bootstrap beta[\s\S]*validation\/candidate beta/is,
  );
  assert.match(
    bootstrap,
    /bootstrap beta[\s\S]*first dual-origin-adapter\s+build[\s\S]*GitHub-reachable[\s\S]*публичн.*binary-only repository[\s\S]*GitHub-blocked[\s\S]*Yandex[\s\S]*manual install-over/is,
  );
  assert.match(
    bootstrap,
    /`BOOTSTRAP_READY`[\s\S]*publication[\s\S]*preservation[\s\S]*basic operation[\s\S]*next beta/is,
  );
});

test("dual-origin acceptance records distinct flows with complete blank evidence fields", async () => {
  const acceptance = await read("docs/acceptance/station-dual-origin-release.md");

  const identityFields = (heading, nextMarker, expectedFields) => {
    const start = acceptance.indexOf(heading);
    const end = acceptance.indexOf(nextMarker, start);
    assert.ok(start >= 0 && end > start, `missing identity section ${heading}`);
    const rows = acceptance
      .slice(start, end)
      .split("\n")
      .filter((line) => /^\| (?!-)(?!Field\s+\|)[^|]+\|/.test(line))
      .map((line) =>
        line
          .split("|")
          .slice(1, -1)
          .map((cell) => cell.trim()),
      );
    assert.deepEqual(
      rows.map(([field]) => field),
      expectedFields,
      `${heading} field inventory`,
    );
    for (const [field, value] of rows) {
      assert.equal(value, "", `${heading} ${field} must start blank`);
    }
  };

  const commonIdentity = [
    "`baseSha`",
    "`releaseSha`",
    "GitHub evidence SHA-256",
    "Yandex evidence SHA-256",
    "Installer SHA-256",
    "Updater bundle SHA-256",
    "GitHub immutable URL",
    "Yandex immutable URL",
    "GitHub channel URL",
    "Yandex channel URL",
    "Installer URL",
    "Workflow URL",
    "Transaction backup verification step",
    "Previous installer SHA-256",
    "SQLite compatibility window",
  ];
  identityFields("### Bootstrap beta identity", "| Scenario", [
    "Exact bootstrap beta tag",
    ...commonIdentity,
    "Phase 2 pre-transition baseline tag",
  ]);
  identityFields("### Validation/candidate beta identity", "| Scenario", [
    "Exact validation/candidate beta tag",
    ...commonIdentity,
    "Exact bootstrap predecessor tag",
    "Strict ordering proof (`candidate > bootstrap`)",
    "First-stable `source_beta_tag` (must equal candidate)",
    "Rollback-to-bootstrap workflow/evidence",
    "Candidate-restoration workflow/evidence",
  ]);
  identityFields("### Stable identity", "| Scenario", [
    "Exact release tag",
    "Exact `source_beta_tag`",
    ...commonIdentity,
    "Previous accepted stable tag",
    "Previous stable `source_beta_tag`",
    "Rollback-to-previous workflow/evidence",
    "Candidate-restoration workflow/evidence",
  ]);

  assert.match(
    acceptance,
    /\| Scenario\s*\| Required for\s*\| Evidence class\s*\| Result\s*\| Operator \| UTC timestamp \| Device \/ Windows identity \| Evidence path \/ SHA-256 \|/,
  );
  assert.match(
    acceptance,
    /Automated CI and host proof[\s\S]*Windows, hardware, and customer proof/i,
  );

  assertAcceptanceScenarioTable(acceptance);

  assert.deepEqual(
    acceptance.split(/\r?\n/).filter((line) => /Overall result:/.test(line)),
    [
      "Bootstrap beta Overall result: `NOT_RUN`",
      "Validation/candidate beta Overall result: `NOT_RUN`",
      "First/subsequent stable Overall result: `NOT_RUN`",
    ],
  );
});

test("strict acceptance table rejects semantic and structural mutations", async () => {
  const acceptance = await read("docs/acceptance/station-dual-origin-release.md");
  const rows = new Map(parseScenarioRows(acceptance).map((cells) => [scenarioId(cells), cells]));
  const descriptions = new Map([...rows].map(([id, cells]) => [id, scenarioTuple(cells)[1]]));
  const betaAudioRow = acceptance
    .split("\n")
    .find((line) => line.startsWith("| BETA-HARDWARE-03 — "));
  assert.ok(betaAudioRow, "BETA-HARDWARE-03 source row");

  const mutations = {
    "negated scanner operation": mutateScenarioRows(acceptance, {
      "BOOTSTRAP-BASIC-02": (cells) => [
        cells[0].replace("accepts", "does not accept"),
        ...cells.slice(1),
      ],
    }),
    "negated candidate re-promotion": mutateScenarioRows(acceptance, {
      "BETA-ROLLBACK-02": (cells) => [
        cells[0].replace("is then re-promoted", "is not re-promoted"),
        ...cells.slice(1),
      ],
    }),
    "weakened outbox synchronization": mutateScenarioRows(acceptance, {
      "BETA-PRESERVE-08": (cells) => [
        cells[0].replace(
          "survive validation/candidate install/restart and later synchronize without duplication or deletion",
          "survive validation/candidate install/restart and may later synchronize; duplication or deletion safety is not guaranteed",
        ),
        ...cells.slice(1),
      ],
    }),
    "swapped descriptions": mutateScenarioRows(acceptance, {
      "BETA-HARDWARE-03": (cells) => [
        `BETA-HARDWARE-03 — ${descriptions.get("BETA-HARDWARE-04")}`,
        ...cells.slice(1),
      ],
      "BETA-HARDWARE-04": (cells) => [
        `BETA-HARDWARE-04 — ${descriptions.get("BETA-HARDWARE-03")}`,
        ...cells.slice(1),
      ],
    }),
    "swapped applicability": mutateScenarioRows(acceptance, {
      "BOOTSTRAP-BASIC-02": (cells) => [cells[0], "BETA_SIGN_OFF", ...cells.slice(2)],
      "BETA-HARDWARE-01": (cells) => [cells[0], "BOOTSTRAP_READY", ...cells.slice(2)],
    }),
    "swapped evidence classes": mutateScenarioRows(acceptance, {
      "BETA-HARDWARE-03": (cells) => [
        cells[0],
        cells[1],
        "Physical touch/display",
        ...cells.slice(3),
      ],
      "BETA-HARDWARE-04": (cells) => [cells[0], cells[1], "Physical audio", ...cells.slice(3)],
    }),
    "changed live-result default": mutateScenarioRows(acceptance, {
      "BETA-HARDWARE-03": (cells) => [...cells.slice(0, 3), "PASS", ...cells.slice(4)],
    }),
    "filled evidence default": mutateScenarioRows(acceptance, {
      "BETA-HARDWARE-03": (cells) => [...cells.slice(0, 7), "invented-evidence.txt"],
    }),
    "duplicated row": acceptance.replace(
      /(?=\nValidation\/candidate beta Overall result:)/,
      `\n${betaAudioRow}`,
    ),
    "removed row": acceptance.replace(`${betaAudioRow}\n`, ""),
    "unexpected ID": mutateScenarioRows(acceptance, {
      "BETA-HARDWARE-03": (cells) => [
        cells[0].replace("BETA-HARDWARE-03", "BETA-HARDWARE-99"),
        ...cells.slice(1),
      ],
    }),
  };

  for (const [name, mutatedAcceptance] of Object.entries(mutations)) {
    assert.throws(
      () => assertAcceptanceScenarioTable(mutatedAcceptance),
      { name: "AssertionError" },
      name,
    );
  }
});

test("beta and stable runbooks define exact post-success acceptance rollback inputs", async () => {
  const [beta, stable, acceptance] = await Promise.all([
    read("docs/runbooks/station-beta-release.md"),
    read("docs/runbooks/station-stable-release.md"),
    read("docs/acceptance/station-dual-origin-release.md"),
  ]);

  assert.match(beta, /BOOTSTRAP_BETA_TAG/);
  assert.match(beta, /VALIDATION_BETA_TAG/);
  assert.match(
    beta,
    /gh workflow run station-beta-release\.yml[\s\S]*mode=promote-existing[\s\S]*repair_tag="\$BOOTSTRAP_BETA_TAG"[\s\S]*gh workflow run station-beta-release\.yml[\s\S]*mode=promote-existing[\s\S]*repair_tag="\$VALIDATION_BETA_TAG"/i,
  );
  assert.match(stable, /PREVIOUS_STABLE_SOURCE_BETA_TAG/);
  assert.match(stable, /CANDIDATE_STABLE_SOURCE_BETA_TAG/);
  assert.match(
    stable,
    /gh workflow run station-stable-release\.yml[\s\S]*source_beta_tag="\$PREVIOUS_STABLE_SOURCE_BETA_TAG"[\s\S]*acceptance_confirmed=true[\s\S]*gh workflow run station-stable-release\.yml[\s\S]*source_beta_tag="\$CANDIDATE_STABLE_SOURCE_BETA_TAG"[\s\S]*acceptance_confirmed=true/i,
  );
  for (const text of [beta, stable, acceptance]) {
    assert.match(text, /previous.*accepted|предыдущ.*принят/is);
    assert.match(
      text,
      /both immutable trees|обе immutable(?: stable)?\s+trees|обе публичные trees/i,
    );
    assert.match(text, /backup.*temporary|временн.*backup/is);
    assert.match(text, /alias.*last|alias.*последн/is);
    assert.match(text, /stop[\s\S]*mismatch|mismatch[\s\S]*остан/i);
  }
  assert.match(acceptance, /repair_tag/);
  assert.match(acceptance, /source_beta_tag/);
  assert.match(acceptance, /does not automatically downgrade|не делает.*автомат.*downgrade/is);
  for (const text of [beta, stable, acceptance]) {
    assert.match(text, /restore|восстанов.*candidate|верн.*candidate/is);
    assert.match(
      text,
      /candidate restoration[\s\S]*Overall[\s\S]*`FAIL`|восстанов.*candidate[\s\S]*Overall[\s\S]*`FAIL`/is,
    );
    assert.match(text, /do not leave.*channel.*rolled back|не оставляйте.*channel.*rollback/is);
  }
});

test("release hosting runbook inventories the Timeweb bucket, keys and edge", async () => {
  // A Windows checkout reads CRLF; every boundary below is a line.
  const [hosting, bootstrap, beta, stable] = (
    await Promise.all([
      read("docs/runbooks/release-hosting.md"),
      read("docs/runbooks/station-release-origin-bootstrap.md"),
      read("docs/runbooks/station-beta-release.md"),
      read("docs/runbooks/station-stable-release.md"),
    ])
  ).map((text) => text.replaceAll("\r\n", "\n"));
  for (const deleted of [
    "docs/runbooks/yandex-infrastructure.md",
    "docs/runbooks/yandex-infrastructure-secrets.md",
    "docs/runbooks/yandex-infrastructure-apply.md",
    "docs/runbooks/standalone-release-bucket.md",
  ])
    await assert.rejects(read(deleted), /ENOENT/u, deleted);
  // The Yandex bootstrap stays only as a retired record.
  assert.match(bootstrap, /Выведено из работы 22\.10\.2026/u);
  assert.match(bootstrap, /\(release-hosting\.md\)/u);
  for (const text of [beta, stable]) {
    assert.match(text, /историческое имя источника `releases\.markiro\.app`/u);
    assert.match(text, /RELEASES_S3_ENDPOINT/u);
    assert.doesNotMatch(text, /YANDEX_STATION_RELEASE|storage\.yandexcloud\.net/u);
  }

  assert.match(hosting, /https:\/\/s3\.twcstorage\.ru/u);
  assert.match(hosting, /`ru-1`/u);
  const section = (heading) => {
    const start = hosting.indexOf(heading);
    assert.notEqual(start, -1, heading);
    const end = hosting.indexOf("\n### ", start + heading.length);
    return hosting.slice(start, end === -1 ? undefined : end);
  };
  const environments = section("### GitHub environments");
  // Each environment owns exactly the list under its own heading line, up to
  // the first line that is not a list item.
  const inventory = (name) => {
    const lines = environments.split("\n");
    const heading = lines.findIndex((line) => line.startsWith(`\`${name}\` (`));
    assert.notEqual(heading, -1, name);
    assert.equal(lines[heading + 1], "", name);
    const items = [];
    for (const line of lines.slice(heading + 2)) {
      if (!line.startsWith("- ")) break;
      const match = /^- (secret|variable) `([^`]+)`/u.exec(line);
      assert.ok(match, line);
      items.push(`${match[1]} ${match[2]}`);
    }
    return items;
  };
  assert.deepEqual(inventory("station-release"), [
    "secret RELEASES_S3_ACCESS_KEY_ID",
    "secret RELEASES_S3_SECRET_ACCESS_KEY",
    "variable RELEASES_S3_BUCKET",
    "variable RELEASES_S3_ENDPOINT",
  ]);
  assert.deepEqual(inventory("handheld-release"), [
    "secret RELEASES_S3_ACCESS_KEY_ID",
    "secret RELEASES_S3_SECRET_ACCESS_KEY",
    "variable RELEASES_S3_BUCKET",
  ]);
  assert.match(
    environments,
    /gh secret set RELEASES_S3_ACCESS_KEY_ID --env station-release < "\$access_key_file"/u,
  );
  assert.doesNotMatch(
    hosting,
    /gh secret set RELEASES_S3_(?:ACCESS_KEY_ID|SECRET_ACCESS_KEY)[^\n]*(?:--body|--value|=\$)/u,
  );
  assert.match(environments, /YANDEX_STATION_RELEASE_\*/u);

  for (const prefix of ["station/*", "signer/*", "handheld/*", "standalone/*"])
    assert.ok(hosting.includes(`\`${prefix}\``), prefix);
  for (const requirement of [
    "GetObjectVersion",
    "ListBucketVersions",
    "VersionId",
    "no-cache",
    "no-store",
    "RELEASE_CATALOG_WRITERS_ENABLED=false",
    "writers disabled",
    "revision0",
    "reviewed writer epoch",
    "1.0.0 уже выпущен",
    "полные байты",
    "HEAD+PUT",
  ])
    assert.ok(hosting.includes(requirement), requirement);
  for (const key of [
    "MARKIRO_RELEASES_DOMAIN",
    "MARKIRO_RELEASES_BUCKET",
    "RELEASE_CATALOG_CACHE_BYTES",
    "RELEASE_CATALOG_DISK_RESERVE_BYTES",
    "RELEASE_CATALOG_PUBLISHERS_JSON",
  ])
    assert.ok(hosting.includes(key), key);
  assert.match(hosting, /CORS[\s\S]*PUT[\s\S]*x-amz-version-id/u);
  assert.match(hosting, /`empty_channel_confirmation=1\.6\.1 \(15\)`/u);
  assert.match(hosting, /`seed-baseline` закрыт/u);
  await access(new URL(".github/workflows/station-release-reseed.yml", root));
  for (const input of [
    "station-release-reseed.yml",
    "owner_confirmation=RESEED-STATION-RELEASES",
    "beta_tag",
    "stable_tag",
  ])
    assert.ok(hosting.includes(input), input);
  assert.match(hosting, /истории[\s\S]*VersionId/u);
  assert.match(hosting, /не бинарники/u);
  assert.match(hosting, /нет[\s\S]*fallback|без fallback/iu);
  assert.match(hosting, /Windows updater[\s\S]*установленный ТСД/u);
  assert.doesNotMatch(
    hosting,
    /Указатель пишется первым|Повторный запуск безопасен|Переносить нечего/u,
  );
});
