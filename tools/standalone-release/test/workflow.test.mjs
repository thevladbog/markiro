import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { load } from "js-yaml";

// CRLF on a Windows checkout: every anchor below works on LF.
const text = async (path) => (await readFile(path, "utf8")).replaceAll("\r\n", "\n");

const workflow = await text(".github/workflows/ci.yml");
const parsed = load(workflow);
const job = parsed.jobs["standalone-windows-build"];
const runs = job.steps.map((step) => step.run ?? step.uses ?? "");
const smoke = await text("tools/standalone-release/smoke.ps1");

test("the Windows job builds, smoke-tests and keeps the installer, in that order", () => {
  assert.ok(job["timeout-minutes"] >= 60);
  const order = [
    "pnpm test:standalone-release:contract",
    "cargo test --manifest-path apps/standalone/Cargo.toml --workspace",
    "cargo build --release --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host",
    "apps/standalone/src-tauri/binaries/markiro-host-x86_64-pc-windows-msvc.exe",
    "tauri build --config src-tauri/tauri.installer.conf.json --bundles nsis",
    "./tools/standalone-release/smoke.ps1 -BundleDir apps/standalone/target/release/bundle/nsis",
    "node tools/standalone-release/prepare.mjs",
    "actions/upload-artifact@",
  ].map((needle) => runs.findIndex((run) => run.includes(needle)));
  assert.ok(
    order.every((index) => index >= 0),
    `every step is there: ${JSON.stringify(order)}`,
  );
  assert.deepEqual(
    order,
    [...order].sort((left, right) => left - right),
  );
  // A Windows-only overlay named tauri.windows.conf.json would be merged into
  // every Windows build by tauri-build, `cargo test` included.
  assert.doesNotMatch(workflow, /tauri\.windows\.conf\.json/);
  // The bundle lands under the workspace's target, not src-tauri's.
  assert.doesNotMatch(workflow, /apps\/standalone\/src-tauri\/target/);
  // A signing key or certificate never appears in CI (owner question П12).
  assert.doesNotMatch(workflow, /certificateThumbprint|signtool|STANDALONE_.*SIGN/);
});

test("the smoke test checks what the installer promises", () => {
  for (const promise of [
    "Install @('/S')",
    "/ROLE=host",
    "/ROLE=office",
    "/ROLE=station",
    "'NT AUTHORITY\\LocalService'",
    "RESTART -- Delay = 5000",
    "qfailureflag",
    "Stop-Process -Id $before -Force",
    "'Domain,Private'",
    "'LocalSubnet'",
    "S-1-5-18,S-1-5-19,S-1-5-32-544",
    "print-fingerprint",
    "'host.db', 'host.json', 'tls\\cert.der', 'tls\\key.der'",
  ]) {
    assert.ok(smoke.includes(promise), promise);
  }
});

/** The whole step that runs `needle`, as parsed YAML. */
const stepRunning = (needle) => job.steps.find((step) => (step.run ?? "").includes(needle));

test("the job holds no secret and gives none to a pull request from a fork", () => {
  // Workflow level: read-only token, and neither this job nor any other asks
  // for more through `permissions:`.
  assert.deepEqual(parsed.permissions, { contents: "read" });
  assert.equal(job.permissions, undefined);
  assert.equal(job.environment, undefined);
  assert.equal(job.env, undefined);
  // The job's own text: no secret, no token, no environment, no signing step.
  const body = JSON.stringify(job);
  assert.doesNotMatch(body, /secrets\./u);
  assert.doesNotMatch(body, /GITHUB_TOKEN|github\.token|\bAUTHENTICODE_|\bPFX\b|\bpassword\b/iu);
  for (const step of job.steps) {
    // The one exception, the pull request's head SHA for the evidence, is
    // pinned to exactly that value below.
    if ((step.run ?? "").includes("prepare.mjs")) continue;
    assert.equal(step.env, undefined, `${step.name ?? step.uses} sets no environment`);
    assert.equal(step.permissions, undefined);
  }
  // A job on `pull_request_target` would hand a fork's code a secret-bearing run.
  assert.doesNotMatch(workflow, /pull_request_target/u);
  assert.deepEqual(Object.keys(parsed.on).sort(), ["pull_request", "push", "workflow_dispatch"]);
  // The signed build is the owner's tool, never this job.
  assert.doesNotMatch(body, /sign-overlay/u);
});

test("every action is pinned to a commit and the job never executes a download", () => {
  for (const step of job.steps.filter((entry) => entry.uses !== undefined)) {
    assert.match(step.uses, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/u, step.uses);
  }
  const upload = job.steps.find((step) => (step.uses ?? "").startsWith("actions/upload-artifact@"));
  // The same pin as every other upload in the workflow.
  const pins = new Set(
    [...workflow.matchAll(/uses: (actions\/upload-artifact@[0-9a-f]{40})/gu)].map(
      (match) => match[1],
    ),
  );
  assert.equal(pins.size, 1, "one upload-artifact pin in the whole workflow");
  assert.ok(pins.has(upload.uses), "the installer upload uses that pin");
  // Nothing is fetched from the network and run, and nothing is run from a
  // branch expression: a `run:` text never interpolates `${{ }}`.
  for (const run of runs) {
    assert.doesNotMatch(
      run,
      /Invoke-WebRequest|Invoke-RestMethod|curl |wget |iwr |irm |\|\s*iex/iu,
    );
    assert.doesNotMatch(run, /\$\{\{/u);
  }
});

test("the installer is kept for thirty days, as prepare.mjs wrote it and nothing else", () => {
  const upload = job.steps.find((step) => (step.uses ?? "").startsWith("actions/upload-artifact@"));
  assert.deepEqual(upload.with, {
    name: "standalone-installer-${{ github.sha }}",
    path: "${{ runner.temp }}/standalone-installer",
    "if-no-files-found": "error",
    "retention-days": 30,
  });
  // The artifact is what prepare.mjs wrote to the temp directory: not the
  // bundle directory (which may hold unsigned leftovers) and not the data
  // directory the smoke test fills.
  const prepare = stepRunning("prepare.mjs");
  assert.equal(prepare.shell, "pwsh");
  assert.match(prepare.run, /--output-dir "\$env:RUNNER_TEMP\/standalone-installer"/u);
  assert.match(prepare.run, /--authenticode \$status/u);
  assert.match(prepare.run, /Get-AuthenticodeSignature/u);
  assert.doesNotMatch(prepare.run, /ProgramData|Markiro\\Host/u);
});

test("the release evidence names the pull request's head, given through env and never inline", () => {
  // On `pull_request` GITHUB_SHA is the synthetic merge commit, which is on
  // no branch; the head is the commit that was reviewed.
  const prepare = stepRunning("prepare.mjs");
  assert.deepEqual(prepare.env, {
    PR_HEAD_SHA: "${{ github.event.pull_request.head.sha || github.sha }}",
  });
  assert.match(prepare.run, /--source-sha "\$env:PR_HEAD_SHA"/u);
  assert.doesNotMatch(prepare.run, /GITHUB_SHA/u);
});

test("the export tool's tests run once the domain they compare with is built", () => {
  const build = runs.findIndex(
    (run) => run === "pnpm turbo build --filter '@markiro/standalone...'",
  );
  const exportTests = runs.findIndex((run) => run === "pnpm test:standalone-export");
  assert.ok(build >= 0, "the workspace build is there");
  assert.ok(exportTests > build, `the export tests come after it: ${build} < ${exportTests}`);
});

test("the smoke test runs where PowerShell 7 and administrator rights are", () => {
  assert.equal(job["runs-on"], "windows-latest");
  assert.equal(stepRunning("smoke.ps1").shell, "pwsh");
  assert.match(smoke, /^#requires -Version 7$/mu);
  // The installer is built before it is installed, from the same checkout.
  const build = stepRunning("tauri build --config");
  assert.match(build.run, /--bundles nsis$/u);
  assert.equal(build["working-directory"], undefined);
  // The contract tests of this very directory run before anything is built.
  const contract = runs.findIndex((run) => run === "pnpm test:standalone-release:contract");
  const compile = runs.findIndex((run) => run.startsWith("cargo build --release"));
  assert.ok(contract >= 0 && contract < compile);
  // The host is copied under the Rust target triple Tauri's sidecar lookup uses.
  assert.match(
    stepRunning("mkdir -p apps/standalone/src-tauri/binaries").run,
    /cp apps\/standalone\/target\/release\/markiro-host\.exe \\\n\s+apps\/standalone\/src-tauri\/binaries\/markiro-host-x86_64-pc-windows-msvc\.exe/u,
  );
  assert.equal(stepRunning("mkdir -p apps/standalone/src-tauri/binaries").shell, "bash");
});

// A small PowerShell tokenizer: it only has to tell code from strings and
// comments well enough to count brackets. pwsh is not installed where this
// runs, so this is the only syntax check the script gets before CI.
function code(source) {
  let out = "";
  let index = 0;
  while (index < source.length) {
    const rest = source.slice(index);
    if (rest.startsWith("<#")) {
      const end = source.indexOf("#>", index + 2);
      assert.ok(end > 0, "a block comment is closed");
      index = end + 2;
    } else if (source[index] === "#") {
      index = source.indexOf("\n", index);
      if (index < 0) break;
    } else if (source[index] === "'") {
      let end = index + 1;
      while (end < source.length) {
        if (source[end] === "'" && source[end + 1] === "'") end += 2;
        else if (source[end] === "'") break;
        else end += 1;
      }
      assert.ok(end < source.length, "a single-quoted string is closed");
      out += "''";
      index = end + 1;
    } else if (source[index] === '"') {
      let end = index + 1;
      while (end < source.length && source[end] !== '"') end += source[end] === "`" ? 2 : 1;
      assert.ok(end < source.length, "a double-quoted string is closed");
      // `"$(...)"` holds code: keep it, drop the literal text around it.
      out += `"${[...source.slice(index + 1, end).matchAll(/\$\(([^)]*)\)/gu)].map((m) => m[1]).join(";")}"`;
      index = end + 1;
    } else {
      out += source[index];
      index += 1;
    }
  }
  return out;
}

test("smoke.ps1 is balanced and written defensively", () => {
  const stripped = code(smoke);
  const stack = [];
  const pairs = { ")": "(", "]": "[", "}": "{" };
  for (const char of stripped) {
    if ("([{".includes(char)) stack.push(char);
    if (char in pairs) assert.equal(stack.pop(), pairs[char], `unbalanced ${char}`);
  }
  assert.deepEqual(stack, []);
  assert.match(smoke, /^\$ErrorActionPreference = 'Stop'$/mu);
  assert.match(smoke, /^Set-StrictMode -Version Latest$/mu);
  assert.match(smoke, /^param\(\[Parameter\(Mandatory\)\]\[string\]\$BundleDir\)$/mu);
  // No string is ever evaluated as code, and nothing is downloaded or run
  // from outside the bundle the job built.
  assert.doesNotMatch(
    stripped,
    /Invoke-Expression|\biex\b|Invoke-WebRequest|Invoke-RestMethod\s+-Uri\s+(?!')|\bcurl\b|\bwget\b|DownloadString|-EncodedCommand|Set-ExecutionPolicy|\[Convert\]::FromBase64/iu,
  );
  // The only network call is the host on this machine.
  const uris = [...smoke.matchAll(/-Uri\s+'([^']+)'/gu)].map((match) => match[1]);
  assert.deepEqual(uris, ["https://127.0.0.1:45710/v1/hello"]);
  // The certificate check is skipped on that one call only.
  assert.equal(smoke.match(/-SkipCertificateCheck/gu)?.length, 1);
  // Every installer and uninstaller run is waited for and its exit code read.
  const starts = [...smoke.matchAll(/Start-Process[^\n]*/gu)].map((match) => match[0]);
  assert.equal(starts.length, 2);
  for (const start of starts) assert.match(start, /-Wait -PassThru\)\.ExitCode/u);
  // Nothing the script touches is outside the product's own places.
  assert.doesNotMatch(
    stripped,
    /Set-NetFirewallProfile|Disable-NetFirewall|Set-ItemProperty|New-ItemProperty|Remove-ItemProperty/iu,
  );
  // The one deletion is the test's own marker file.
  assert.deepEqual(
    [...stripped.matchAll(/Remove-Item[^\n]*/gu)].map((match) => match[0].trim()),
    ["Remove-Item -LiteralPath $marker -Force"],
  );
  // Secrets: none are read, written or printed.
  assert.doesNotMatch(smoke, /\$env:(?!ProgramFiles\b|ProgramData\b)/iu);
  assert.doesNotMatch(smoke, /password|token|secret|PIN\b|badge/iu);
  // Only the role file is read as bytes; the host's key never is, and
  // nothing prints a file's content.
  assert.doesNotMatch(
    smoke,
    /Get-Content[^\n]*key\.der|ReadAllBytes\((?!\$roleFile\))|Format-Hex/iu,
  );
});

test("the smoke test finds a verified copy in backups with the data folder's SIDs, and Administrators own the data folder", () => {
  const host = smoke.slice(smoke.indexOf("Step 'role host"), smoke.indexOf("Step 'a crash"));
  // The host copies its database at every start (plan РК). A copy flushed
  // through a read-only handle fails on Windows only, so only this run can
  // see it; a copy counts once its manifest is beside it.
  assert.match(smoke, /Get-ChildItem -Path \$backups -Filter 'markiro-host-\*\.db'/u);
  assert.match(smoke, /\[System\.IO\.Path\]::ChangeExtension\(\$_\.FullName, '\.json'\)/u);
  assert.match(
    host,
    /WaitFor \{ @\(VerifiedCopies\)\.Count -ge 1 \} 120 'the host made a verified copy in backups'/u,
  );
  // The copy and its folder get the data folder's access list: backups was
  // made before icacls ran, so this proves the grants reached it.
  assert.match(
    host,
    /\(\(Sids \$backups\) -join ','\) -eq 'S-1-5-18,S-1-5-19,S-1-5-32-544'\) 'the backups folder is not readable by users'/u,
  );
  assert.match(
    host,
    /\(\(Sids \$copy\.FullName\) -join ','\) -eq 'S-1-5-18,S-1-5-19,S-1-5-32-544'\) 'the copy is not readable by users'/u,
  );
  // A folder a user made before the install would keep that user as its
  // owner, who could grant themselves the database again.
  assert.match(
    smoke,
    /\(Get-Acl \$path\)\.GetOwner\(\[System\.Security\.Principal\.SecurityIdentifier\]\)\.Value/u,
  );
  assert.match(
    host,
    /\(OwnerSid \$dataDir\) -eq 'S-1-5-32-544'\) 'Administrators own the data directory'/u,
  );
  assert.match(host, /\(OwnerSid \$markiroDir\) -eq 'S-1-5-32-544'\) 'and its Markiro folder'/u);
});

test("the smoke test follows the installer's life in order, and every step is bounded", () => {
  const steps = [...smoke.matchAll(/^Step '([^']+)'$/gmu)].map((match) => match[1]);
  assert.deepEqual(steps, [
    "a silent install without a role installs nothing",
    "role host: the service, its account, its restart policy, the port",
    "a crash: Windows starts the service again",
    "a reinstall keeps the role and the host",
    "a reinstall over an unfinished restore ends with exit 4: a warning, not a failure",
    "another role on a reinstall is refused",
    "uninstall with the host running removes the service and the rule and keeps the data",
    "role office: no host, no service, no autostart",
    "role station: no host, opens at sign-in",
  ]);
  // Every wait has a bound written in seconds, and none is larger than the
  // job's own budget allows for.
  const waits = [...smoke.matchAll(/^\s*WaitFor \{.*\} (\d+) '/gmu)].map((match) =>
    Number(match[1]),
  );
  assert.ok(waits.length >= 10, `waits found: ${waits.length}`);
  assert.ok(
    waits.every((seconds) => seconds > 0 && seconds <= 120),
    JSON.stringify(waits),
  );
  assert.doesNotMatch(
    smoke,
    /while\s*\(\s*\$true\s*\)|Start-Sleep\s+-Seconds\s+(?:[6-9]\d|\d{3,})/iu,
  );
  assert.match(smoke, /throw "FAILED: \$what within \$seconds s"/u);
});

test("the service is read by numeric states and the role file by its exact text", () => {
  // ServiceControllerStatus: Stopped 1, Running 4. The words are localized
  // on a Russian Windows and the numbers are not.
  assert.match(smoke, /\$Stopped = 1/u);
  assert.match(smoke, /\$Running = 4/u);
  // StrictMode throws on .Status of the $null an absent service gives, so the
  // function answers 0 first (the first Windows run failed on exactly this).
  assert.match(
    smoke,
    /function ServiceState \{[^}]*Get-Service -Name MarkiroHost[^}]*if \(\$null -eq \$found\) \{ return 0 \}[^}]*\[int\]\$found\.Status/u,
  );
  assert.doesNotMatch(smoke, /\[int\]\(Get-Service/u);
  assert.doesNotMatch(smoke, /State -(?:eq|ne) '(?:Running|Stopped|Start Pending)'/u);
  // The failure policy is read from the service's registry values as well as
  // from sc.exe's text.
  assert.match(smoke, /FailureActionsOnNonCrashFailures/u);
  // The role file: exactly one key, the exact lower-case literal, no BOM.
  assert.match(smoke, /\(-not \$hasBom\) -and \(\$text -ceq "\{`"role`":`"\$expected`"\}"\)/u);
  assert.match(smoke, /\[System\.IO\.File\]::ReadAllBytes\(\$roleFile\)/u);
  assert.match(smoke, /0xEF/u);
  for (const role of ["host", "office", "station"]) {
    assert.ok(smoke.includes(`RoleFileIs '${role}'`), role);
  }
});

test("the smoke test covers an uninstall with a running host, exit 4 and data kept", () => {
  const section = (from, to) => smoke.slice(smoke.indexOf(from), smoke.indexOf(to));
  const exit4 = section("Step 'a reinstall over an unfinished restore", "Step 'another role");
  // The marker that makes `start` refuse (host/src/config.rs), a stopped
  // service, an installer that still succeeds, a service that stays
  // registered with its policy, and a clean way back.
  assert.match(exit4, /host\.restore-intent/u);
  assert.match(exit4, /Stop-Service -Name MarkiroHost/u);
  assert.match(exit4, /\(Install @\('\/S'\)\) -eq 0\) 'the installer still succeeds/u);
  assert.match(exit4, /\(ServiceState\) -ne \$Running/u);
  assert.match(exit4, /@\(Get-NetFirewallRule -Name 'MarkiroHost'\)\.Count -eq 1/u);
  assert.match(exit4, /Remove-Item -LiteralPath \$marker/u);
  assert.match(exit4, /WaitFor \{ HostAnswers \} 120/u);
  // The marker is removed on the failure path too: a left marker would make
  // every later step meet a host that cannot start.
  assert.match(exit4, /finally \{/u);

  const uninstall = section("Step 'uninstall with the host running", "Step 'role office");
  assert.match(
    uninstall,
    /\(ServiceState\) -eq \$Running\) 'the host is running when the uninstall starts'/u,
  );
  assert.match(uninstall, /HostAnswers\) 'and answers'/u);
  assert.match(uninstall, /\(Uninstall\) -eq 0/u);
  assert.match(uninstall, /Get-Process -Name markiro-host -ErrorAction SilentlyContinue/u);
  assert.match(uninstall, /-not \(Test-Path \$hostExe\)/u);
  assert.match(uninstall, /host\.json[^\n]*-eq \$hostJson/u);
  assert.match(uninstall, /Get-NetFirewallRule -Name 'MarkiroHost' -ErrorAction SilentlyContinue/u);
  assert.match(uninstall, /Check \(-not \(HostAnswers\)\)/u);
  assert.match(uninstall, /\(RegValue \$roleKey 'Role'\)/u);
  // The role in capitals is the same role and is written in lower case.
  assert.match(smoke, /Install @\('\/S', '\/ROLE=HOST'\)\) -eq 0\)/u);
  // The data survives the station role's uninstall at the very end too.
  assert.match(smoke, /'the host data from the first install is still there'/u);
});
