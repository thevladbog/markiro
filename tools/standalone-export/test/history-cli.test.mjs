import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, readdir, rm, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseArgs, main } from "../cli.mjs";
import { defaultHistorySince, runHistoryPsql } from "../history.mjs";

test("history CLI selects its own format and validates civil date", () => {
  const options = parseArgs([
    "--tenant",
    "tenant",
    "--out-dir",
    "/tmp",
    "--history",
    "--history-since",
    "2025-10-17",
  ]);
  assert.equal(options.history, true);
  assert.equal(options.historySince, "2025-10-17");
  for (const date of ["2025-02-29", "2025-13-01", "yesterday", "2026-1-01"]) {
    assert.throws(
      () => parseArgs(["--tenant", "t", "--out-dir", "/tmp", "--history", "--history-since", date]),
      /history-since/,
    );
  }
  assert.throws(
    () => parseArgs(["--tenant", "t", "--out-dir", "/tmp", "--history-since", "2025-01-01"]),
    /--history/,
  );
  assert.throws(
    () => parseArgs(["--tenant", "t", "--out-dir", "/tmp", "--history", "--rehearsal"]),
    /history/,
  );
});

test("history dispatch streams independently from catalog and never prints raw failures", async () => {
  const dir = await mkdtemp(join(tmpdir(), "history-cli-"));
  try {
    const golden = (
      await readFile(
        new URL("../../../apps/standalone/proto/fixtures/cloud-history.jsonl", import.meta.url),
        "utf8",
      )
    )
      .trim()
      .split("\n")
      .map(JSON.parse);
    async function* runHistory() {
      yield {
        type: "metadata",
        value: { source: golden[0].source, organization: golden[0].organization, clean: true },
      };
      for (const [type, values] of Object.entries(golden[1].payload))
        for (const value of values) yield { type, value };
    }
    const out = [],
      err = [];
    const deps = {
      runHistory,
      run: () => {
        throw Error("catalog should not run");
      },
      now: () => new Date(golden[0].exportedAt),
      stdout: (line) => out.push(line),
      stderr: (line) => err.push(line),
    };
    const args = ["--tenant", "history-tenant", "--out-dir", dir, "--history"];
    assert.equal(await main(args, deps), 0);
    assert.equal((await readdir(dir)).length, 1);
    assert.equal(
      await readFile(join(dir, "markiro-cloud-history-history-tenant-2026-10-17.jsonl"), "utf8"),
      golden.map(JSON.stringify).join("\n") + "\n",
    );
    assert.equal(await main(args, deps), 1);
    assert.equal(err.at(-1), "Выгрузка истории не удалась: history_file_exists");
    async function* bad() {
      throw new Error("PRIVATE canonical and hash");
    }
    assert.equal(await main(args, { ...deps, runHistory: bad }), 1);
    assert.equal(err.at(-1), "Выгрузка истории не удалась: history_failed");
    assert.ok(![...out, ...err].join(" ").includes("SERIAL"));
    assert.ok(![...out, ...err].join(" ").includes("PRIVATE"));
    assert.equal(defaultHistorySince(new Date("2024-02-29T20:00:00Z")), "2023-02-28");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test(
  "history psql uses cursor batches and drains sensitive stderr without exposing it",
  { skip: process.platform === "win32" ? "POSIX fake executable" : false },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "history-psql-"));
    try {
      const executable = join(dir, "psql.mjs");
      await writeFile(
        executable,
        `#!/usr/bin/env node\nprocess.stderr.write('PRIVATE database row\\n');\nprocess.stdout.write(JSON.stringify({args:process.argv.slice(2)})+'\\n');\nprocess.exit(Number(process.env.HISTORY_EXIT ?? 0));\n`,
      );
      await chmod(executable, 0o700);
      const seen = [];
      for await (const row of runHistoryPsql({
        psql: executable,
        tenantId: "t",
        since: "2025-10-17",
      }))
        seen.push(row);
      assert.ok(seen[0].args.includes("FETCH_COUNT=1000"));
      assert.ok(seen[0].args.includes("tenant_id=t"));
      assert.ok(seen[0].args.includes("history_since=2025-10-17"));
      await assert.rejects(async () => {
        for await (const _ of runHistoryPsql({
          psql: executable,
          tenantId: "t",
          since: "2025-10-17",
          env: { ...process.env, HISTORY_EXIT: "3" },
        })) {
          /* drain */
        }
      }, /^Error: history_psql_failed$/u);
      await assert.rejects(async () => {
        for await (const _ of runHistoryPsql({
          psql: join(dir, "missing"),
          tenantId: "t",
          since: "2025-10-17",
        })) {
          /* drain */
        }
      }, /^Error: history_psql_failed$/u);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
