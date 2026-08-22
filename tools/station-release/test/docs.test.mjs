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
  assert.match(stableAcceptance, /NOT RUN/);
  assert.match(stableAcceptance, /beta.*stable/is);
  assert.match(stableAcceptance, /stable.*stable/is);
  assert.match(betaRunbook, /station-stable-release/);
  assert.match(readme, /Manual stable updates/);
  assert.match(checklist, /Station stable/);
});
