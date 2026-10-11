import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// CRLF on a Windows checkout: every anchor below works on LF.
const text = async (path) => (await readFile(path, "utf8")).replaceAll("\r\n", "\n");

const base = JSON.parse(await text("apps/standalone/src-tauri/tauri.conf.json"));
const overlay = JSON.parse(await text("apps/standalone/src-tauri/tauri.installer.conf.json"));
const hooksBytes = await readFile("apps/standalone/src-tauri/windows/installer-hooks.nsh");
const hooks = hooksBytes
  .toString("utf8")
  .replace(/^\uFEFF/, "")
  .replaceAll("\r\n", "\n");

/** The body of one hook macro. */
function macro(name) {
  const start = hooks.indexOf(`!macro ${name}\n`);
  assert.ok(start >= 0, `${name} is defined`);
  return hooks.slice(start, hooks.indexOf("!macroend", start));
}

test("only the installer build bundles the host: cargo and the debug build need no sidecar", () => {
  // tauri-build copies `externalBin` at compile time and fails without the
  // file, so a sidecar in tauri.conf.json would break `cargo test` everywhere.
  assert.equal(base.bundle.externalBin, undefined);
  assert.deepEqual(base.bundle.targets, ["nsis"]);
  assert.deepEqual(overlay.bundle.externalBin, ["binaries/markiro-host"]);
  assert.deepEqual(overlay.bundle.windows.nsis, {
    installMode: "perMachine",
    languages: ["Russian"],
    installerHooks: "windows/installer-hooks.nsh",
  });
});

test("the hooks file is UTF-8 with a byte order mark, or NSIS garbles the Russian text", () => {
  assert.deepEqual([...hooksBytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.match(hooks, /[а-я]/);
});

test("the role comes from /ROLE=, the earlier installation or the questions, and never changes", () => {
  const preinstall = macro("NSIS_HOOK_PREINSTALL");
  assert.match(preinstall, /\$\{GetOptions\} \$CMDLINE "\/ROLE=" \$0/);
  assert.match(preinstall, /ReadRegStr \$1 HKLM "\$\{MARKIRO_ROLE_KEY\}" "Role"/);
  for (const role of ["host", "station", "office"]) {
    assert.match(preinstall, new RegExp(`StrCpy \\$0 "${role}"`), role);
  }
  assert.match(preinstall, /\$\{AndIf\} \$0 != \$1\n\s+!insertmacro MARKIRO_FAIL/);
  assert.match(preinstall, /\$\{AndIf\} \$\{Silent\}\n\s+!insertmacro MARKIRO_FAIL/);
  // The running service holds its binary: it stops before files are copied.
  assert.match(preinstall, /"\$INSTDIR\\markiro-host\.exe" stop-service/);
});

test("only the host role registers the service; the others drop the host binary", () => {
  const postinstall = macro("NSIS_HOOK_POSTINSTALL");
  assert.match(postinstall, /FileWrite \$0 '\{"role":"\$MarkiroRole"\}\$\\r\$\\n'/);
  assert.match(
    postinstall,
    /\$\{If\} \$MarkiroRole == "host"\n[\s\S]*"\$INSTDIR\\markiro-host\.exe" install'\n\s+Pop \$0\n\s+\$\{If\} \$0 == "4"[\s\S]*?\$\{ElseIf\} \$0 != "0"\n\s+!insertmacro MARKIRO_FAIL/,
  );
  assert.match(postinstall, /"\$INSTDIR\\markiro-host\.exe" network-check'/);
  assert.match(postinstall, /\$\{If\} \$0 == "3"/);
  assert.match(
    postinstall,
    /\$\{Else\}\n\s+; Only the host role runs the host\.\n\s+Delete "\$INSTDIR\\markiro-host\.exe"/,
  );
  assert.match(
    postinstall,
    /\$\{If\} \$MarkiroRole == "office"\n\s+DeleteRegValue HKLM "\$\{MARKIRO_RUN_KEY\}"/,
  );
});

test("uninstall and upgrade never delete data", () => {
  const preuninstall = macro("NSIS_HOOK_PREUNINSTALL");
  assert.match(preuninstall, /StrCpy \$DeleteAppDataCheckboxState 0/);
  assert.match(
    preuninstall,
    /\$\{If\} \$UpdateMode = 1\n\s+nsExec::ExecToLog '"\$INSTDIR\\markiro-host\.exe" stop-service'\n\s+\$\{Else\}\n\s+nsExec::ExecToLog '"\$INSTDIR\\markiro-host\.exe" uninstall'/,
  );
  const code = hooks
    .split("\n")
    .filter((line) => !line.trimStart().startsWith(";"))
    .join("\n");
  assert.doesNotMatch(code, /RMDir|RmDir|ProgramData|LOCALAPPDATA|\$APPDATA/);
  assert.doesNotMatch(hooks, /NSIS_HOOK_POSTUNINSTALL/);
});

test("every jump label in the hooks is defined exactly once", () => {
  const defined = [...hooks.matchAll(/^\s*(markiro_[a-z_]+):$/gm)].map((match) => match[1]);
  assert.equal(new Set(defined).size, defined.length);
  for (const target of hooks.matchAll(/\b(?:IDNO|IDYES|Goto) (markiro_[a-z_]+)/g)) {
    assert.ok(defined.includes(target[1]), target[1]);
  }
});

test("the host binary the build copies in stays out of git", async () => {
  assert.match(await text("apps/standalone/.gitignore"), /^\/src-tauri\/binaries\/$/m);
});

test("exit code 4 of `install` (installed, not staying up) is a warning with the restore hint", () => {
  const postinstall = macro("NSIS_HOOK_POSTINSTALL");
  const warning = postinstall.slice(
    postinstall.indexOf('${If} $0 == "4"'),
    postinstall.indexOf('${ElseIf} $0 != "0"'),
  );
  assert.ok(warning.length > 0, "the exit-4 branch comes before the generic failure");
  assert.doesNotMatch(warning, /MARKIRO_FAIL|Abort/);
  assert.match(warning, /restore/);
  assert.match(warning, /sc stop MarkiroHost/);
  // The warning must not hang a silent install.
  assert.match(warning, /MessageBox MB_ICONEXCLAMATION .*\/SD IDOK/);
  // Anything else but 0 and 4 still fails closed, and nothing else is a warning.
  assert.equal(postinstall.match(/\$0 == "4"/g)?.length, 1);
  assert.equal(postinstall.match(/\$\{ElseIf\} \$0 != "0"/g)?.length, 1);
});

test("the role is written in the exact spelling the shell reads, whatever case /ROLE= had", () => {
  // NSIS `==` ignores case: /ROLE=HOST passes the checks above, but the shell's
  // reader accepts only the lower-case names (it would silently make the PC a
  // station, kiosk-locked), so the role is mapped to the literal before use.
  const preinstall = macro("NSIS_HOOK_PREINSTALL");
  const canonical =
    '${If} $0 == "host"\n    StrCpy $0 "host"\n  ${ElseIf} $0 == "station"\n    StrCpy $0 "station"\n  ${ElseIf} $0 == "office"\n    StrCpy $0 "office"\n  ${Else}\n    !insertmacro MARKIRO_FAIL';
  const at = preinstall.indexOf(canonical);
  assert.ok(at >= 0, "the role is mapped to one of three literals");
  assert.ok(at < preinstall.indexOf("StrCpy $MarkiroRole $0"), "before it is kept");
  assert.equal(preinstall.match(/StrCpy \$MarkiroRole /g)?.length, 1);
});

test("installation.json is written whole or the install fails; nothing else writes it", () => {
  const postinstall = macro("NSIS_HOOK_POSTINSTALL");
  assert.match(
    postinstall,
    /ClearErrors\n\s+FileOpen \$0 "\$INSTDIR\\installation\.json" w\n\s+\$\{If\} \$\{Errors\}\n\s+!insertmacro MARKIRO_FAIL/,
  );
  assert.equal(hooks.match(/FileOpen/g)?.length, 1);
  assert.equal(hooks.match(/FileWrite/g)?.length, 1);
});

test("a failure is silent-safe and ends the installer with error level 2", () => {
  const fail = macro("MARKIRO_FAIL message");
  assert.match(fail, /MessageBox MB_ICONSTOP "\$\{message\}" \/SD IDOK/);
  assert.match(fail, /SetErrorLevel 2\n\s+Abort "\$\{message\}"/);
  // Every other dialog either carries a silent default or sits behind a Silent test.
  for (const match of hooks.matchAll(/^.*MessageBox .*$/gm)) {
    if (match[0].includes("/SD")) continue;
    const before = hooks.slice(0, match.index);
    const open = before.lastIndexOf("!macro ");
    assert.match(before.slice(open), /\$\{Silent\}/, match[0]);
  }
});

test("the registers the template may use are saved and restored by each hook", () => {
  for (const name of ["NSIS_HOOK_PREINSTALL", "NSIS_HOOK_POSTINSTALL", "NSIS_HOOK_PREUNINSTALL"]) {
    const body = macro(name);
    assert.match(body, /^!macro [A-Z_]+\n\s+Push \$0\n\s+Push \$1\n/, name);
    assert.match(body, /\n\s+Pop \$1\n\s+Pop \$0\n$/, name);
  }
});

test("every path the hooks name is quoted and every deletion stays in the install directory or our keys", () => {
  const code = hooks
    .split("\n")
    .filter((line) => !line.trimStart().startsWith(";"))
    .join("\n");
  // A command line is single-quoted, its paths double-quoted inside: once the
  // double-quoted strings are gone, no $INSTDIR may be left.
  const unquoted = code.replaceAll(/"[^"\n]*"/g, '""');
  assert.doesNotMatch(unquoted, /\$INSTDIR/);
  const deletions = [
    ...code.matchAll(/^\s*(Delete|DeleteRegValue|DeleteRegKey(?: \/ifempty)?) (.+)$/gm),
  ]
    .map((match) => `${match[1]} ${match[2]}`)
    .sort();
  assert.deepEqual(deletions, [
    'Delete "$INSTDIR\\installation.json"',
    'Delete "$INSTDIR\\markiro-host.exe"',
    'DeleteRegKey /ifempty HKLM "${MARKIRO_ROLE_KEY}"',
    'DeleteRegKey /ifempty HKLM "Software\\Markiro"',
    'DeleteRegValue HKLM "${MARKIRO_ROLE_KEY}" "Role"',
    'DeleteRegValue HKLM "${MARKIRO_RUN_KEY}" "${MARKIRO_RUN_VALUE}"',
    'DeleteRegValue HKLM "${MARKIRO_RUN_KEY}" "${MARKIRO_RUN_VALUE}"',
  ]);
});

test("an upgrade stops the running host before files are copied and never runs `uninstall`", () => {
  const preinstall = macro("NSIS_HOOK_PREINSTALL");
  const stop = preinstall.indexOf("stop-service");
  assert.ok(stop > preinstall.indexOf("StrCpy $MarkiroRole $0"));
  assert.doesNotMatch(preinstall, /markiro-host\.exe" uninstall/);
  assert.doesNotMatch(
    macro("NSIS_HOOK_POSTINSTALL"),
    /markiro-host\.exe" (?:uninstall|stop-service)/,
  );
});

test("the installer hooks hold no secret, certificate or password", () => {
  assert.doesNotMatch(hooks, /password|passwd|secret|token|\.pfx|certificate|thumbprint/i);
});

test("the three roles are the only ones /ROLE= accepts, and every external command's code is read", () => {
  const preinstall = macro("NSIS_HOOK_PREINSTALL");
  assert.match(
    preinstall,
    /\$\{If\} \$0 != ""\n\s+\$\{AndIf\} \$0 != "host"\n\s+\$\{AndIf\} \$0 != "station"\n\s+\$\{AndIf\} \$0 != "office"\n\s+!insertmacro MARKIRO_FAIL/,
  );
  // nsExec leaves the exit code on the stack: each call is followed by its Pop,
  // or the registers the hook restores would get the wrong values.
  const lines = hooks.split("\n").map((line) => line.trim());
  let calls = 0;
  lines.forEach((line, index) => {
    if (!line.startsWith("nsExec::ExecToLog")) return;
    calls += 1;
    // The two branches of the uninstall hook share one Pop after the ${EndIf}.
    const next = lines
      .slice(index + 1)
      .find((later) => !/^(?:\$\{(?:Else|EndIf)\}|nsExec::ExecToLog .*)$/.test(later));
    assert.equal(next, "Pop $0", line);
  });
  assert.equal(calls, 6);
});

test("the root script runs these contracts", async () => {
  const root = JSON.parse(await text("package.json"));
  assert.equal(
    root.scripts["test:standalone-release:contract"],
    "node --test tools/standalone-release/test/*.test.mjs",
  );
});

test("blocks balance in each macro (makensis is not available where these tests run)", () => {
  assert.equal(hooks.match(/^!macro /gm)?.length, hooks.match(/^!macroend$/gm)?.length);
  for (const name of [
    "MARKIRO_FAIL message",
    "NSIS_HOOK_PREINSTALL",
    "NSIS_HOOK_POSTINSTALL",
    "NSIS_HOOK_PREUNINSTALL",
  ]) {
    const body = macro(name);
    const opened = body.match(/\$\{(?:If|IfNot)\}/g)?.length ?? 0;
    assert.equal(body.match(/\$\{EndIf\}/g)?.length ?? 0, opened, name);
    // An ElseIf or Else needs an open block: the depth never goes below zero.
    let depth = 0;
    for (const token of body.matchAll(/\$\{(If|IfNot|ElseIf|Else|EndIf)\}/g)) {
      if (token[1] === "If" || token[1] === "IfNot") depth += 1;
      else if (token[1] === "EndIf") depth -= 1;
      else assert.ok(depth > 0, `${name}: ${token[0]} outside a block`);
      assert.ok(depth >= 0, name);
    }
  }
});
