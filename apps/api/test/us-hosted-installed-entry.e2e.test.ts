import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { Script } from "node:vm";
import {
  existsSync,
  readFileSync,
  mkdtempSync,
  lstatSync,
  writeFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

const invalidExercise = () => new Error("us_hosted_installed_exercise_failed");
const activeClients = new Set<Promise<string>>();
function runTestClient(
  file: string,
  args: string[],
  input?: string,
  observeStdout?: (chunk: string) => void,
): Promise<string> {
  const task = new Promise<string>((resolve, reject) => {
    try {
      let observationFailed = false;
      const client = execFile(
        file,
        args,
        {
          encoding: "utf8",
          maxBuffer: 1024 * 1024,
          timeout: 5000,
          killSignal: "SIGTERM",
        },
        (error, stdout) => {
          if (error || observationFailed) reject(invalidExercise());
          else resolve(stdout);
        },
      );
      client.stdout?.on("data", (chunk: string | Buffer) => {
        try {
          observeStdout?.(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
        } catch {
          observationFailed = true;
          client.kill("SIGTERM");
        }
      });
      client.stdin?.on("error", () => {
        /* The completion callback reports failed delivery. */
      });
      client.stdin?.end(input);
    } catch {
      reject(invalidExercise());
    }
  });
  activeClients.add(task);
  void task.then(
    () => activeClients.delete(task),
    () => activeClients.delete(task),
  );
  return task;
}

const auditFrameSchema = z
  .object({
    phase: z.number().int().min(1).max(11),
    microseconds: z.number().int().nonnegative().safe(),
  })
  .strict();
const auditReceiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    completed: z.boolean(),
    lastReached: z.number().int().min(0).max(11),
    frames: z
      .array(auditFrameSchema.extend({ parentMicroseconds: z.number().int().nonnegative().safe() }))
      .max(11),
  })
  .strict();
function createFixedAudit(signal: AbortSignal) {
  const directory = mkdtempSync(join(tmpdir(), "us-hosted-fixed-audit-"));
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700)
    throw invalidExercise();
  const path = join(directory, "receipt.json");
  let receipt: z.infer<typeof auditReceiptSchema> = {
    schemaVersion: 1,
    completed: false,
    lastReached: 0,
    frames: [],
  };
  let sequence = 0;
  let failed = signal.aborted;
  let pending = "";
  let total = 0;
  const started = process.hrtime.bigint();
  const elapsed = () => Number((process.hrtime.bigint() - started) / 1000n);
  const persist = (next: z.infer<typeof auditReceiptSchema>) => {
    const temporary = join(directory, `receipt-${sequence++}.tmp`);
    try {
      const bytes = JSON.stringify(auditReceiptSchema.parse(next));
      if (Buffer.byteLength(bytes) > 16384) throw invalidExercise();
      writeFileSync(temporary, bytes, { mode: 0o600, flag: "wx" });
      renameSync(temporary, path);
      receipt = next;
    } catch {
      failed = true;
      throw invalidExercise();
    }
  };
  persist(receipt);
  const fail = () => {
    failed = true;
    if (receipt.completed) persist({ ...receipt, completed: false });
  };
  signal.addEventListener("abort", fail, { once: true });
  return {
    directory,
    path,
    fail,
    observe(chunk: string) {
      try {
        if (failed || signal.aborted || elapsed() >= 5000000) {
          fail();
          throw invalidExercise();
        }
        total += Buffer.byteLength(chunk);
        if (total > 16384) throw invalidExercise();
        pending += chunk;
        while (pending.includes("\n")) {
          const index = pending.indexOf("\n");
          const line = pending.slice(0, index);
          pending = pending.slice(index + 1);
          if (Buffer.byteLength(line) > 1024) throw invalidExercise();
          const frame = auditFrameSchema.parse(JSON.parse(line));
          const previous = receipt.frames.at(-1);
          const parentMicroseconds = elapsed();
          if (
            frame.phase !== receipt.lastReached + 1 ||
            (frame.phase === 1 && frame.microseconds !== 0) ||
            frame.microseconds < (previous?.microseconds ?? 0) ||
            parentMicroseconds < (previous?.parentMicroseconds ?? 0)
          )
            throw invalidExercise();
          persist({
            schemaVersion: 1,
            completed: false,
            lastReached: frame.phase,
            frames: [...receipt.frames, { ...frame, parentMicroseconds }],
          });
        }
        if (Buffer.byteLength(pending) > 1024) throw invalidExercise();
      } catch {
        fail();
        throw invalidExercise();
      }
    },
    finish(assertionsPassed: boolean) {
      if (
        failed ||
        signal.aborted ||
        elapsed() >= 5000000 ||
        !assertionsPassed ||
        receipt.lastReached !== 11 ||
        pending
      ) {
        fail();
        return;
      }
      persist({ ...receipt, completed: true });
    },
  };
}

it("persists each fixed audit frame before an early child failure", async () => {
  const audit = createFixedAudit(new AbortController().signal);
  try {
    await expect(
      runTestClient(
        process.execPath,
        [
          "-e",
          "process.stdout.write(JSON.stringify({phase:1,microseconds:0})+'\\n');setTimeout(()=>process.exit(1),30)",
        ],
        undefined,
        audit.observe,
      ),
    ).rejects.toEqual(invalidExercise());
    const value = auditReceiptSchema.parse(JSON.parse(readFileSync(audit.path, "utf8")));
    expect(value.lastReached).toBe(1);
    expect(value.frames[0]?.parentMicroseconds).toBeGreaterThanOrEqual(0);
    expect(value.completed).toBe(false);
  } finally {
    rmSync(audit.directory, { recursive: true });
  }
});
it("latches a simulated test deadline before a late successful completion", () => {
  const controller = new AbortController();
  const audit = createFixedAudit(controller.signal);
  try {
    for (let phase = 1; phase <= 11; phase++)
      audit.observe(JSON.stringify({ phase, microseconds: phase - 1 }) + "\n");
    controller.abort(); // Simulation only; installed audit retains the actual Vitest deadline.
    audit.finish(true);
    const value = auditReceiptSchema.parse(JSON.parse(readFileSync(audit.path, "utf8")));
    expect(value.lastReached).toBe(11);
    expect(value.completed).toBe(false);
  } finally {
    rmSync(audit.directory, { recursive: true });
  }
});
it("rejects malformed fixed audit frames without replacing the last valid receipt", () => {
  for (const input of [
    '{"phase":1,"microseconds":0,"private":"rejected"}\n',
    '{"phase":2,"microseconds":0}\n',
    "x".repeat(1025),
  ]) {
    const audit = createFixedAudit(new AbortController().signal);
    try {
      expect(() => audit.observe(input)).toThrow("us_hosted_installed_exercise_failed");
      expect(
        auditReceiptSchema.parse(JSON.parse(readFileSync(audit.path, "utf8"))).lastReached,
      ).toBe(0);
      expect(readFileSync(audit.path, "utf8")).not.toContain("private");
    } finally {
      rmSync(audit.directory, { recursive: true });
    }
  }
});

it("marks fixed audit completion only after the full sequence and terminal assertions", () => {
  const audit = createFixedAudit(new AbortController().signal);
  try {
    audit.finish(true);
    expect(auditReceiptSchema.parse(JSON.parse(readFileSync(audit.path, "utf8"))).completed).toBe(
      false,
    );
  } finally {
    rmSync(audit.directory, { recursive: true });
  }
  const complete = createFixedAudit(new AbortController().signal);
  try {
    for (let phase = 1; phase <= 11; phase++)
      complete.observe(JSON.stringify({ phase, microseconds: phase - 1 }) + "\n");
    complete.finish(true);
    expect(
      auditReceiptSchema.parse(JSON.parse(readFileSync(complete.path, "utf8"))).completed,
    ).toBe(true);
    complete.fail();
    complete.finish(true);
    expect(
      auditReceiptSchema.parse(JSON.parse(readFileSync(complete.path, "utf8"))).completed,
    ).toBe(false);
  } finally {
    rmSync(complete.directory, { recursive: true });
  }
});
it("retains the last valid fixed audit receipt on duplicate frames or failed atomic persistence", () => {
  const audit = createFixedAudit(new AbortController().signal);
  try {
    audit.observe('{"phase":1,"microseconds":0}\n');
    expect(() => audit.observe('{"phase":1,"microseconds":0}\n')).toThrow(
      "us_hosted_installed_exercise_failed",
    );
    audit.finish(true);
    expect(auditReceiptSchema.parse(JSON.parse(readFileSync(audit.path, "utf8"))).lastReached).toBe(
      1,
    );
  } finally {
    rmSync(audit.directory, { recursive: true });
  }
  const broken = createFixedAudit(new AbortController().signal);
  const moved = broken.directory + "-unit-moved";
  renameSync(broken.directory, moved);
  try {
    expect(() => broken.observe('{"phase":1,"microseconds":0}\n')).toThrow(
      "us_hosted_installed_exercise_failed",
    );
    const value = auditReceiptSchema.parse(
      JSON.parse(readFileSync(join(moved, "receipt.json"), "utf8")),
    );
    expect(value.lastReached).toBe(0);
    expect(value.completed).toBe(false);
  } finally {
    rmSync(moved, { recursive: true });
  }
});

async function auditedCall<Args extends unknown[], Result>(
  receiver: unknown,
  original: (this: unknown, ...args: Args) => Promise<Result>,
  args: Args,
  before: () => void,
  after: () => void,
): Promise<Result> {
  before();
  const result = await original.apply(receiver, args);
  after();
  return result;
}
it("delegates an audit observation to the original receiver and preserves its rejection", async () => {
  const receiver = Object.freeze({});
  const argument = Object.freeze({});
  const value = Object.freeze({});
  const error = new Error("unit-original-refusal");
  const events: string[] = [];
  const original = async function (this: unknown, input: object) {
    expect(this).toBe(receiver);
    expect(input).toBe(argument);
    events.push("original");
    return value;
  };
  expect(
    await auditedCall(
      receiver,
      original,
      [argument],
      () => events.push("before"),
      () => events.push("after"),
    ),
  ).toBe(value);
  expect(events).toEqual(["before", "original", "after"]);
  events.length = 0;
  const refuses = async function (this: unknown) {
    expect(this).toBe(receiver);
    events.push("original");
    throw error;
  };
  await expect(
    auditedCall(
      receiver,
      refuses,
      [],
      () => events.push("before"),
      () => events.push("after"),
    ),
  ).rejects.toBe(error);
  expect(events).toEqual(["before", "original"]);
});

function createAuditStream(
  audit: ReturnType<typeof createFixedAudit>,
  onPid: (pid: number) => void,
) {
  let pending = "",
    total = 0,
    pidSeen = false;
  return {
    observe(chunk: string) {
      try {
        total += Buffer.byteLength(chunk);
        if (total > 16384) throw invalidExercise();
        pending += chunk;
        while (pending.includes("\n")) {
          const index = pending.indexOf("\n");
          const line = pending.slice(0, index);
          pending = pending.slice(index + 1);
          if (Buffer.byteLength(line) > 1024) throw invalidExercise();
          if (!pidSeen) {
            const value = z
              .object({ pid: z.number().int().min(2).safe() })
              .strict()
              .parse(JSON.parse(line));
            onPid(value.pid);
            pidSeen = true;
          } else audit.observe(line + "\n");
        }
        if (Buffer.byteLength(pending) > 1024) throw invalidExercise();
      } catch {
        audit.fail();
        throw invalidExercise();
      }
    },
    finish() {
      try {
        if (!pidSeen) throw invalidExercise();
        return z
          .array(z.union([z.literal(0), z.literal(1)]))
          .max(16)
          .parse(JSON.parse(pending));
      } catch {
        audit.fail();
        throw invalidExercise();
      }
    },
  };
}
it("separates audited PID and terminal flags from the bounded phase frames", () => {
  const audit = createFixedAudit(new AbortController().signal);
  const pids: number[] = [];
  const stream = createAuditStream(audit, (pid) => pids.push(pid));
  try {
    stream.observe('{"pid":42}\n{"phase":1,"microseconds":0}\n[1,1,1,1]');
    expect(stream.finish()).toEqual([1, 1, 1, 1]);
    expect(pids).toEqual([42]);
    expect(auditReceiptSchema.parse(JSON.parse(readFileSync(audit.path, "utf8"))).lastReached).toBe(
      1,
    );
  } finally {
    rmSync(audit.directory, { recursive: true });
  }
});

it("keeps the event loop available while a test client runs", async () => {
  let ticked = false;
  const immediate = setImmediate(() => {
    ticked = true;
  });
  try {
    const output = await runTestClient(process.execPath, [
      "-e",
      "setTimeout(()=>process.stdout.write('client-complete'),50)",
    ]);
    expect(output).toBe("client-complete");
    expect(ticked).toBe(true);
  } finally {
    clearImmediate(immediate);
  }
});

it("redacts failed test-client output without treating client exit as remote settlement", async () => {
  await expect(
    runTestClient(process.execPath, [
      "-e",
      "process.stdout.write('synthetic-rejected-output');process.stderr.write('synthetic-rejected-error');process.exit(1)",
    ]),
  ).rejects.toEqual(invalidExercise());
  expect(activeClients.size).toBe(0);
  await expect(runTestClient("\0", [])).rejects.toEqual(invalidExercise());
});

// Locator for an independently prepared, invocation-owned TEST installation.
// This is never runtime configuration, a release issuer or a positive owner seam.
const receiptPath = resolve(
  __dirname,
  "../../../.superpowers/sdd/2026-10-22-us-11-demo-viewer/installed-fixtures/current.json",
);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const container = z
  .object({
    containerId: digest,
    owner: z.string().regex(/^us-hosted-complete-[a-f0-9-]{36}$/),
  })
  .strict();
const receiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    purpose: z.literal("synthetic-test-only"),
    baseSha: sha,
    patchSha256: digest,
    fixtureSha: sha,
    manifestSha256: digest,
    services: z.object({ api: container, worker: container }).strict(),
  })
  .strict()
  .refine(
    (value) =>
      value.services.api.containerId !== value.services.worker.containerId &&
      value.services.api.owner !== value.services.worker.owner,
  );

it("rejects a shared single-container locator instead of co-locating service credentials", () => {
  expect(
    receiptSchema.safeParse({
      schemaVersion: 1,
      purpose: "synthetic-test-only",
      baseSha: "a".repeat(40),
      patchSha256: "b".repeat(64),
      fixtureSha: "c".repeat(40),
      manifestSha256: "d".repeat(64),
      containerId: "e".repeat(64),
      owner: "us-hosted-complete-11111111-1111-4111-8111-111111111111",
    }).success,
  ).toBe(false);
  const common = {
    schemaVersion: 1,
    purpose: "synthetic-test-only",
    baseSha: "a".repeat(40),
    patchSha256: "b".repeat(64),
    fixtureSha: "c".repeat(40),
    manifestSha256: "d".repeat(64),
  };
  const api = {
    containerId: "e".repeat(64),
    owner: "us-hosted-complete-11111111-1111-4111-8111-111111111111",
  };
  const worker = {
    containerId: "f".repeat(64),
    owner: "us-hosted-complete-22222222-2222-4222-8222-222222222222",
  };
  expect(receiptSchema.safeParse({ ...common, services: { api, worker } }).success).toBe(true);
  expect(
    receiptSchema.safeParse({
      ...common,
      services: { api, worker: { ...worker, containerId: api.containerId } },
    }).success,
  ).toBe(false);
  expect(
    receiptSchema.safeParse({
      ...common,
      services: { api, worker: { ...worker, owner: api.owner } },
    }).success,
  ).toBe(false);
});

const guestAuditSetup = String.raw`
  const {UsHostedReleaseFiles}=require('/app/apps/api/dist/deployment/us-hosted-release-files.js');
  const auditFs=require('node:fs');
  const auditManifest=JSON.parse(auditFs.readFileSync('/app/us-synthetic-release.json','utf8'));
  const auditDocument=JSON.parse(auditFs.readFileSync('/app/apps/api/dist/us-request-build.json','utf8'));
  const auditDirs={api:new Set(),contracts:new Set()};
  for(const f of auditDocument.files)if((f.tree==='api'||f.tree==='contracts')&&f.path.endsWith('.js'))auditDirs[f.tree].add(require('node:path').posix.dirname(f.path));
  const auditCaptureCount=3+3*auditDirs.api.size+auditDirs.contracts.size;
  const auditProto=UsHostedReleaseFiles.prototype;
  const auditOriginal={read:auditProto.read,capture:auditProto.capturePackage,inventory:auditProto.inventory,fence:auditProto.assertUnchanged};
  const auditSeen=new Set();let auditCaptures=0,auditBulk=false,auditReadComplete=false,auditFence=false;
  const auditNoop=()=>{};
  const auditedCall=${auditedCall.toString()};
  auditProto.capturePackage=async function(...args){return auditedCall(this,auditOriginal.capture,args,
    ()=>{if(auditCaptures===0)auditPhase(3);},
    ()=>{auditCaptures++;if(auditCaptures===auditCaptureCount)auditPhase(4);});};
  auditProto.inventory=async function(...args){return auditedCall(this,auditOriginal.inventory,args,auditNoop,
    ()=>{auditBulk=true;auditPhase(5);});};
  auditProto.read=async function(path,...args){return auditedCall(this,auditOriginal.read,[path,...args],auditNoop,
    ()=>{auditSeen.add(path);if(auditBulk&&!auditReadComplete&&auditManifest.files.every(f=>auditSeen.has(f.path))){auditReadComplete=true;auditPhase(6);}});};
  auditProto.assertUnchanged=async function(...args){
    const final=auditBulk&&auditReadComplete&&auditCaptures===auditCaptureCount&&!auditFence;
    return auditedCall(this,auditOriginal.fence,args,()=>{if(final){auditFence=true;auditPhase(7);}},()=>{if(final)auditPhase(8);});
  };
  const restoreAudit=()=>{auditProto.read=auditOriginal.read;auditProto.capturePackage=auditOriginal.capture;auditProto.inventory=auditOriginal.inventory;auditProto.assertUnchanged=auditOriginal.fence;};
`;

it("parses the exact generated guest audit setup without executing hosted prerequisites", () => {
  expect(() => new Script(guestAuditSetup)).not.toThrow();
});

describe.skipIf(!existsSync(receiptPath))("genuine installed hosted prerequisites", () => {
  let receipt: z.infer<typeof receiptSchema>;
  const remoteChildren = { api: new Set<number>(), worker: new Set<number>() };
  const pidSchema = z.object({ pid: z.number().int().min(2).safe() }).strict();
  const flagSchema = z.array(z.union([z.literal(0), z.literal(1)])).max(16);
  const docker = (
    args: string[],
    input?: string,
    observeStdout?: (chunk: string) => void,
  ): Promise<string> => {
    return runTestClient("docker", args, input, observeStdout);
  };
  beforeAll(async () => {
    receipt = receiptSchema.parse(JSON.parse(readFileSync(receiptPath, "utf8")));
    for (const service of ["api", "worker"] as const) {
      const owned = receipt.services[service];
      expect(
        (
          await docker([
            "inspect",
            "--format",
            '{{index .Config.Labels "us-fixture-owner"}}',
            owned.containerId,
          ])
        ).trim(),
      ).toBe(owned.owner);
      expect(
        (
          await docker(["inspect", "--format", "{{.HostConfig.NetworkMode}}", owned.containerId])
        ).trim(),
      ).toBe("none");
    }
  });
  afterAll(async () => {
    await Promise.allSettled([...activeClients]);
    if (!receipt) return;
    for (const service of ["api", "worker"] as const) {
      const rows = (await docker(["top", receipt.services[service].containerId, "-eo", "pid,comm"]))
        .trim()
        .split("\n")
        .slice(1)
        .map((line) => line.trim().split(/\s+/));
      const processes = rows.filter((row) => row[1] !== "ps");
      if (
        rows.filter((row) => row[1] === "ps").length > 1 ||
        processes.length !== 1 ||
        processes[0]?.[0] !== "1"
      )
        throw new Error("us_hosted_actual_child_settlement_pending");
      remoteChildren[service].clear();
    }
  });
  const exercise = async (
    service: "api" | "worker",
    body: string,
    auditSignal?: AbortSignal,
  ): Promise<unknown> => {
    const program = `
      process.stdout.write(JSON.stringify({pid:process.pid})+'\\n');
      const auditStarted=process.hrtime.bigint();
      const auditPhase=${auditSignal ? "(phase)=>process.stdout.write(JSON.stringify({phase,microseconds:phase===1?0:Number((process.hrtime.bigint()-auditStarted)/1000n)})+'\\n')" : "()=>{}"};
      auditPhase(1);
      const assert=require('node:assert/strict');
      const release=require('/app/apps/api/dist/deployment/us-hosted-release-verifier.js');
      const material=require('/app/apps/api/dist/deployment/us-hosted-material-owner.js');
      const service=${JSON.stringify(service)};
      auditPhase(2);
      (async()=>{${auditSignal ? guestAuditSetup : "const restoreAudit=()=>{};"}try{${body}}finally{restoreAudit();}})().catch(()=>{process.stderr.write('us_hosted_installed_exercise_failed\\n');process.exitCode=1});
    `;
    const audit = auditSignal ? createFixedAudit(auditSignal) : undefined;
    const stream = audit
      ? createAuditStream(audit, (pid) => remoteChildren[service].add(pid))
      : undefined;
    if (audit) console.info("us_hosted_fixed_audit_receipt", audit.path);
    let prefix = "";
    let observed = false;
    try {
      const output = await docker(
        ["exec", "-i", "--user", "10001:10001", receipt.services[service].containerId, "node"],
        program,
        (chunk) => {
          stream?.observe(chunk);
          if (observed) return;
          prefix = (prefix + chunk).slice(0, 1024);
          const newline = prefix.indexOf("\n");
          if (newline < 0) return;
          try {
            const value: unknown = JSON.parse(prefix.slice(0, newline));
            const parsed = pidSchema.safeParse(value);
            if (parsed.success) {
              remoteChildren[service].add(parsed.data.pid);
              observed = true;
            }
          } catch {
            /* Only the fixed completion error may escape. */
          }
        },
      );
      const lines = output.trimEnd().split("\n");
      if (!audit && lines.length !== 2) throw invalidExercise();
      const pidValue: unknown = JSON.parse(lines[0] ?? "");
      const flagValue: unknown = stream ? stream.finish() : JSON.parse(lines[1] ?? "");
      const pid = pidSchema.parse(pidValue);
      const flags = flagSchema.parse(flagValue);
      // A successful exec completion proves this process exited. A timeout or
      // killed CLI never takes this path; afterAll checks actual remote liveness.
      remoteChildren[service].delete(pid.pid);
      if (audit) {
        expect(flags).toEqual([1, 1, 1, 1]);
        audit.finish(true);
        expect(
          auditReceiptSchema.parse(JSON.parse(readFileSync(audit.path, "utf8"))).completed,
        ).toBe(true);
      }
      return flags;
    } catch {
      audit?.fail();
      throw invalidExercise();
    }
  };

  it.each(["early", "final"] as const)(
    "refuses simulated stat tampering at the %s acquisition boundary",
    async (boundary) => {
      const finalMutant =
        boundary === "final" && process.env.US_HOSTED_TEST_FINAL_FENCE_MUTANT === "1";
      const result = await exercise(
        "api",
        `
      const fs=require('node:fs');
      const {UsHostedReleaseFiles}=require('/app/apps/api/dist/deployment/us-hosted-release-files.js');
      const manifest=JSON.parse(fs.readFileSync('/app/us-synthetic-release.json','utf8'));
      const document=JSON.parse(fs.readFileSync('/app/apps/api/dist/us-request-build.json','utf8'));
      const dirs={api:new Set(),contracts:new Set()};
      for(const f of document.files)if((f.tree==='api'||f.tree==='contracts')&&f.path.endsWith('.js'))dirs[f.tree].add(require('node:path').posix.dirname(f.path));
      const expectedCaptures=3+3*dirs.api.size+dirs.contracts.size;
      const proto=UsHostedReleaseFiles.prototype;
      const original={lstat:fs.lstatSync,read:proto.read,capture:proto.capturePackage,inventory:proto.inventory,fence:proto.assertUnchanged};
      const seen=new Set();let captures=0,bulk=false,reached=false,armed=false,consumed=false,resolved=false,refused=false;
      const phase=${JSON.stringify(boundary)};
      const selectedPath=phase==='early'?'/app/apps/api/dist/main.us-hosted.js':'/app/apps/admin/dist-us/index.html';
      let selected=release;
      if(${JSON.stringify(finalMutant)}) {
        const Module=require('node:module');const filename='/app/apps/api/dist/deployment/us-hosted-release-verifier.js';
        const source=fs.readFileSync(filename,'utf8');const line='await files.assertUnchanged();';
        assert.equal(source.split(line).length,2);
        const candidate=new Module(filename,module);candidate.filename=filename;candidate.paths=Module._nodeModulePaths(require('node:path').dirname(filename));
        candidate._compile(source.replace(line,''),filename);selected=candidate.exports;
      }
      fs.lstatSync=function(path,...args){
        const stat=original.lstat.call(fs,path,...args);
        if(armed&&path===selectedPath){consumed=true;return new Proxy(stat,{get(target,key){if(key==='mtimeNs')return target.mtimeNs+1n;const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});}
        return stat;
      };
      proto.read=async function(path,...args){const bytes=await original.read.call(this,path,...args);seen.add(path);return bytes;};
      proto.inventory=async function(...args){bulk=true;return original.inventory.apply(this,args);};
      proto.capturePackage=async function(...args){
        const value=await original.capture.apply(this,args);captures++;
        if(phase==='early'&&captures===1&&!bulk){reached=true;armed=true;}
        return value;
      };
      proto.assertUnchanged=async function(...args){
        if(phase==='final'&&bulk&&captures===expectedCaptures&&manifest.files.every(f=>seen.has(f.path))){reached=true;armed=true;}
        return original.fence.apply(this,args);
      };
      try {
        const value=await selected.verifyUsHostedRelease('api');resolved=true;selected.disposeUsHostedRelease(value);
      } catch(error) {refused=error instanceof Error&&error.message==='us_hosted_release_invalid';}
      finally {fs.lstatSync=original.lstat;proto.read=original.read;proto.capturePackage=original.capture;proto.inventory=original.inventory;proto.assertUnchanged=original.fence;}
      process.stdout.write(JSON.stringify([Number(reached),Number(consumed),Number(refused),Number(!resolved)]));
    `,
      );
      expect(result).toEqual([1, 1, 1, 1]);
    },
  );

  it.each(["api", "worker"] as const)(
    "issues genuine %s owners in its separate installation and invalidates disposal",
    async (service) => {
      const result = await exercise(
        service,
        `
        const fs=require('node:fs');
        const forbidden=service==='api'?['worker-db-password','worker-storage-access-key','worker-storage-secret-key']:['api-db-password','api-auth-secret','api-key.pem','api-storage-access-key','api-storage-secret-key'];
        for(const name of forbidden) assert.equal(fs.existsSync('/run/secrets/us-demo/'+name),false);
        const r=await release.verifyUsHostedRelease(service);
        const identity=release.usHostedReleaseIdentity(r);
        const administrative=require('/app/apps/api/dist/deployment/us-hosted-admin-release.js');
        assert.throws(()=>administrative.assertUsHostedAdminRelease(r));
        assert.throws(()=>administrative.usHostedAdminReleaseIdentity(r));
        assert.throws(()=>administrative.disposeUsHostedAdminRelease(r));
        assert.equal(identity.sourceSha,${JSON.stringify(receipt.fixtureSha)});
        assert.equal(identity.manifestSha256,${JSON.stringify(receipt.manifestSha256)});
        const m=await material.collectUsHostedMaterial(r);
        material.assertUsHostedMaterial(m,r,service);
        assert.throws(()=>material.assertUsHostedMaterial(m,r,service==='api'?'worker':'api'));
        assert.throws(()=>release.assertUsHostedRelease({...r}));
        const {UsPlanArtifactStore}=require('/app/apps/api/dist/modules/traceability/plans/us-plan-artifacts.js');
        const {UsRequestPackageArtifactStore}=require('/app/apps/api/dist/modules/traceability/requests/us-request-package-artifacts.js');
        const plan=UsPlanArtifactStore.createHosted(r,m);
        const packages=UsRequestPackageArtifactStore.createHosted(r,m);
        plan.onModuleDestroy();packages.destroy();
        material.disposeUsHostedMaterial(m);
        assert.throws(()=>material.assertUsHostedMaterial(m,r,service));
        assert.throws(()=>UsPlanArtifactStore.createHosted(r,m));
        assert.throws(()=>UsRequestPackageArtifactStore.createHosted(r,m));
        release.disposeUsHostedRelease(r);
        assert.throws(()=>release.usHostedReleaseIdentity(r));
        process.stdout.write('[1]');
    `,
      );
      expect(result).toEqual([1]);
    },
  );

  it("serves actual CA-verified native HTTPS and rejects the wrong peer name and untrusted CA", async (context) => {
    const result = await exercise(
      "api",
      `
      const https=require('node:https');const fs=require('node:fs');
      const r=await release.verifyUsHostedRelease('api');auditPhase(9);
      const m=await material.collectUsHostedMaterial(r);auditPhase(10);
      const {UsHostedHttpsAdapter}=require('/app/apps/api/dist/deployment/us-hosted-https-adapter.js');
      const adapter=new UsHostedHttpsAdapter(r,m);
      adapter.getInstance().get('/',(_req,res)=>res.end('synthetic-tls-ok'));
      adapter.initHttpServer();const server=adapter.getHttpServer();
      try {
        await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});
        const port=server.address().port;
        const ca=fs.readFileSync('/run/secrets/us-demo/db-ca.pem');
        const request=(options)=>new Promise((resolve,reject)=>{
          const req=https.get({host:'127.0.0.1',port,path:'/',agent:false,rejectUnauthorized:true,...options},res=>{
            let body='';res.setEncoding('utf8');res.on('data',chunk=>{body+=chunk});res.on('end',()=>resolve(body));
          });req.on('error',reject);
        });
        assert.equal(await request({ca,servername:'api.us-demo.internal'}),'synthetic-tls-ok');
        await assert.rejects(request({ca,servername:'wrong.us-demo.internal'}));
        await assert.rejects(request({servername:'api.us-demo.internal'}));
      } finally {
        await adapter.close();await adapter.close();
        material.disposeUsHostedMaterial(m);release.disposeUsHostedRelease(r);
      }
      assert.equal(server.listening,false);auditPhase(11);
      process.stdout.write('[1,1,1,1]');
    `,
      process.env.US_HOSTED_TEST_ACQUISITION_AUDIT === "1" ? context.signal : undefined,
    );
    expect(result).toEqual([1, 1, 1, 1]);
  });
});

// Separate immutable operation installations. These locators are TEST ownership evidence only.
const adminReceiptPath = resolve(
  __dirname,
  "../../../.superpowers/sdd/2026-10-22-us-11-demo-viewer/installed-fixtures/admin-current.json",
);
const adminReceiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    purpose: z.literal("synthetic-test-only"),
    baseSha: sha,
    patchSha256: digest,
    fixtureSha: sha,
    manifestSha256: digest,
    adminManifestSha256: digest,
    operations: z.object({ migrate: container, seed: container, provision: container }).strict(),
    variants: z.object({ wrongSupplementEntry: container, wrongDescriptor: container }).strict(),
  })
  .strict()
  .refine((value) => {
    const instances = [...Object.values(value.operations), ...Object.values(value.variants)];
    return (
      new Set(instances.map((entry) => entry.containerId)).size === 5 &&
      new Set(instances.map((entry) => entry.owner)).size === 5
    );
  });

it("requires distinct administrative operation and negative installations", () => {
  const instance = {
    containerId: "a".repeat(64),
    owner: "us-hosted-complete-11111111-1111-4111-8111-111111111111",
  };
  const distinct = Array.from({ length: 5 }, (_, index) => ({
    containerId: String(index + 1).repeat(64),
    owner: `us-hosted-complete-11111111-1111-4111-8111-00000000000${index + 1}`,
  }));
  const [migrate, seed, provision, wrongSupplementEntry, wrongDescriptor] = distinct;
  expect(
    adminReceiptSchema.safeParse({
      schemaVersion: 1,
      purpose: "synthetic-test-only",
      baseSha: "b".repeat(40),
      patchSha256: "c".repeat(64),
      fixtureSha: "d".repeat(40),
      manifestSha256: "e".repeat(64),
      adminManifestSha256: "f".repeat(64),
      operations: { migrate, seed, provision },
      variants: { wrongSupplementEntry, wrongDescriptor },
    }).success,
  ).toBe(true);
  expect(
    adminReceiptSchema.safeParse({
      schemaVersion: 1,
      purpose: "synthetic-test-only",
      baseSha: "b".repeat(40),
      patchSha256: "c".repeat(64),
      fixtureSha: "d".repeat(40),
      manifestSha256: "e".repeat(64),
      adminManifestSha256: "f".repeat(64),
      operations: { migrate: instance, seed: instance, provision: instance },
      variants: { wrongSupplementEntry: instance, wrongDescriptor: instance },
    }).success,
  ).toBe(false);
});

describe.skipIf(!existsSync(adminReceiptPath))("genuine installed administrative admission", () => {
  let receipt: z.infer<typeof adminReceiptSchema>;
  const operations = ["migrate", "seed", "provision"] as const;
  const installations = [...operations, "wrongSupplementEntry", "wrongDescriptor"] as const;
  const owned = (name: (typeof installations)[number]) =>
    name === "wrongSupplementEntry" || name === "wrongDescriptor"
      ? receipt.variants[name]
      : receipt.operations[name];
  const children = new Map<string, Set<number>>();
  beforeAll(async () => {
    receipt = adminReceiptSchema.parse(JSON.parse(readFileSync(adminReceiptPath, "utf8")));
    const runtime = existsSync(receiptPath)
      ? receiptSchema.parse(JSON.parse(readFileSync(receiptPath, "utf8")))
      : undefined;
    for (const operation of installations) {
      const instance = owned(operation);
      children.set(operation, new Set());
      expect(
        (
          await runTestClient("docker", [
            "inspect",
            "--format",
            '{{index .Config.Labels "us-fixture-owner"}}',
            instance.containerId,
          ])
        ).trim(),
      ).toBe(instance.owner);
      expect(
        (
          await runTestClient("docker", [
            "inspect",
            "--format",
            "{{.HostConfig.NetworkMode}}",
            instance.containerId,
          ])
        ).trim(),
      ).toBe("none");
      if (runtime)
        for (const existing of Object.values(runtime.services)) {
          expect(existing.containerId).not.toBe(instance.containerId);
          expect(existing.owner).not.toBe(instance.owner);
        }
    }
  });
  afterAll(async () => {
    await Promise.allSettled([...activeClients]);
    if (!receipt) return;
    for (const operation of installations) {
      const rows = (
        await runTestClient("docker", ["top", owned(operation).containerId, "-eo", "pid,comm"])
      )
        .trim()
        .split("\n")
        .slice(1)
        .map((line) => line.trim().split(/\s+/));
      const processes = rows.filter((row) => row[1] !== "ps");
      if (
        rows.filter((row) => row[1] === "ps").length > 1 ||
        processes.length !== 1 ||
        processes[0]?.[0] !== "1"
      )
        throw Error("us_hosted_actual_child_settlement_pending");
      children.get(operation)?.clear();
    }
  });
  const exercise = async (
    operation: (typeof installations)[number],
    body: string,
  ): Promise<number[]> => {
    const program = `process.stdout.write(JSON.stringify({pid:process.pid})+'\\n');
      const assert=require('node:assert/strict');
      const admin=require('/app/apps/api/dist/deployment/us-hosted-admin-release.js');
      const operation=${JSON.stringify(operation === "wrongSupplementEntry" || operation === "wrongDescriptor" ? "migrate" : operation)};
      (async()=>{${body}})().catch(()=>{process.stderr.write('us_hosted_admin_installed_exercise_failed\\n');process.exitCode=1;});`;
    let prefix = "",
      observed = false;
    const pending = children.get(operation);
    const output = await runTestClient(
      "docker",
      ["exec", "-i", "--user", "10001:10001", owned(operation).containerId, "node"],
      program,
      (chunk) => {
        if (observed) return;
        prefix = (prefix + chunk).slice(0, 1024);
        const newline = prefix.indexOf("\n");
        if (newline < 0) return;
        try {
          const parsed = z
            .object({ pid: z.number().int().min(2).safe() })
            .strict()
            .safeParse(JSON.parse(prefix.slice(0, newline)));
          if (parsed.success) {
            pending?.add(parsed.data.pid);
            observed = true;
          }
        } catch {
          /* Completion and actual remote settlement remain required. */
        }
      },
    );
    const lines = output.trimEnd().split("\n");
    if (lines.length !== 2) throw invalidExercise();
    const pid = z
      .object({ pid: z.number().int().min(2).safe() })
      .strict()
      .parse(JSON.parse(lines[0] ?? ""));
    const flags = z
      .array(z.union([z.literal(0), z.literal(1)]))
      .max(16)
      .parse(JSON.parse(lines[1] ?? ""));
    pending?.delete(pid.pid);
    return flags;
  };
  it.each(operations)(
    "issues only immutable %s administrative provenance and invalidates disposal",
    async (operation) => {
      const flags = await exercise(
        operation,
        `
      const handle=await admin.verifyUsHostedAdminRelease(operation);
      const identity=admin.usHostedAdminReleaseIdentity(handle);
      assert.equal(identity.operation,operation);assert.equal(identity.config.operation,operation);
      assert.equal(identity.sourceSha,${JSON.stringify(receipt.fixtureSha)});
      assert.equal(identity.manifestSha256,${JSON.stringify(receipt.manifestSha256)});
      assert.equal(identity.adminManifestSha256,${JSON.stringify(receipt.adminManifestSha256)});
      for(const value of [handle,identity,identity.config,identity.config.database,identity.config.release,identity.build])assert.ok(Object.isFrozen(value));
      if(operation==='seed')assert.ok(Object.isFrozen(identity.config.storage));
      const copy=Object.freeze({...handle});
      assert.throws(()=>admin.assertUsHostedAdminRelease(copy));assert.throws(()=>admin.usHostedAdminReleaseIdentity(copy));
      const runtime=require('/app/apps/api/dist/deployment/us-hosted-release-verifier.js');
      assert.throws(()=>runtime.assertUsHostedRelease(handle));
      const material=require('/app/apps/api/dist/deployment/us-hosted-material-owner.js');
      await assert.rejects(material.collectUsHostedMaterial(handle));
      admin.disposeUsHostedAdminRelease(handle);assert.throws(()=>admin.assertUsHostedAdminRelease(handle));
      assert.throws(()=>admin.usHostedAdminReleaseIdentity(handle));
      console.log(JSON.stringify([1,1,1,1]));`,
      );
      expect(flags).toEqual([1, 1, 1, 1]);
    },
  );
  it.each(operations)(
    "refuses operation substitution in the %s installation before package capture",
    async (operation) => {
      const flags = await exercise(
        operation,
        `
      const {UsHostedReleaseFiles}=require('/app/apps/api/dist/deployment/us-hosted-release-files.js');
      const original=UsHostedReleaseFiles.prototype.capturePackage;let captures=0;
      UsHostedReleaseFiles.prototype.capturePackage=async function(...args){captures++;return original.apply(this,args);};
      let refused=false;try{await admin.verifyUsHostedAdminRelease(operation==='seed'?'migrate':'seed');}catch(e){refused=e instanceof Error&&e.message==='us_hosted_admin_release_invalid';}
      finally{UsHostedReleaseFiles.prototype.capturePackage=original;}
      console.log(JSON.stringify([Number(refused),Number(captures===0)]));`,
      );
      expect(flags).toEqual([1, 1]);
    },
  );
  it.each(["us-synthetic-admin.json", "us-synthetic-admin-release.json"])(
    "refuses consumed native-stat replacement of %s at the final fence",
    async (control) => {
      const mutant = process.env.US_HOSTED_TEST_ADMIN_FINAL_FENCE_MUTANT === "1";
      const flags = await exercise(
        "migrate",
        `
      const fs=require('node:fs');const {UsHostedReleaseFiles}=require('/app/apps/api/dist/deployment/us-hosted-release-files.js');
      const manifest=JSON.parse(fs.readFileSync('/app/us-synthetic-release.json','utf8'));
      const proto=UsHostedReleaseFiles.prototype,original={read:proto.read,fence:proto.assertUnchanged,stat:fs.lstatSync};
      const seen=new Set();let armed=false,reached=false,consumed=false,resolved=false,refused=false,selected=admin;
      if(${JSON.stringify(mutant)}){const Module=require('node:module'),filename='/app/apps/api/dist/deployment/us-hosted-admin-release.js';
        const source=fs.readFileSync(filename,'utf8'),line='await files.assertUnchanged();';assert.equal(source.split(line).length,2);
        const candidate=new Module(filename,module);candidate.filename=filename;candidate.paths=Module._nodeModulePaths(require('node:path').dirname(filename));
        candidate._compile(source.replace(line,''),filename);selected=candidate.exports;}
      proto.read=async function(path,...args){const bytes=await original.read.call(this,path,...args);seen.add(path);return bytes;};
      proto.assertUnchanged=async function(...args){if(manifest.files.every(file=>seen.has(file.path))){reached=true;armed=true;}return original.fence.apply(this,args);};
      fs.lstatSync=function(path,...args){const value=original.stat.call(fs,path,...args);if(armed&&path===${JSON.stringify("/app/" + control)}){consumed=true;return new Proxy(value,{get(target,key){if(key==='mtimeNs')return target.mtimeNs+1n;const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});}return value;};
      try{const handle=await selected.verifyUsHostedAdminRelease('migrate');resolved=true;selected.disposeUsHostedAdminRelease(handle);}catch(e){refused=e instanceof Error&&e.message==='us_hosted_admin_release_invalid';}
      finally{proto.read=original.read;proto.assertUnchanged=original.fence;fs.lstatSync=original.stat;}
      console.log(JSON.stringify([Number(reached),Number(consumed),Number(refused),Number(!resolved)]));`,
      );
      expect(flags).toEqual([1, 1, 1, 1]);
    },
  );

  it.each(operations)(
    "keeps the actual compiled %s executable locked after admission",
    async (operation) => {
      expect(
        await exercise(
          operation,
          `
      const result=require('node:child_process').spawnSync(process.execPath,['/app/apps/api/dist/main.us-hosted-admin.js',operation],
        {encoding:'utf8',timeout:5000,maxBuffer:1024,env:{PATH:process.env.PATH}});
      assert.equal(result.status,1);assert.equal(result.signal,null);assert.equal(result.error,undefined);
      assert.equal(result.stdout,'');assert.equal(result.stderr,'us_hosted_provisioning_required\\n');
      console.log(JSON.stringify([1,1,1,1]));`,
        ),
      ).toEqual([1, 1, 1, 1]);
    },
  );
  it.each(["wrongSupplementEntry", "wrongDescriptor"] as const)(
    "refuses the independently prepared %s package variant",
    async (variant) => {
      const entryMutant =
        variant === "wrongSupplementEntry" && process.env.US_HOSTED_TEST_ADMIN_ENTRY_MUTANT === "1";
      expect(
        await exercise(
          variant,
          `
      const fs=require('node:fs'),{UsHostedReleaseFiles}=require('/app/apps/api/dist/deployment/us-hosted-release-files.js');
      const manifest=JSON.parse(fs.readFileSync('/app/us-synthetic-release.json','utf8'));
      const original=UsHostedReleaseFiles.prototype.read,seen=new Set();
      UsHostedReleaseFiles.prototype.read=async function(path,...args){const bytes=await original.call(this,path,...args);seen.add(path);return bytes;};
      let selected=admin,resolved=false,refused=false;
      if(${JSON.stringify(entryMutant)}){const Module=require('node:module'),filename='/app/apps/api/dist/deployment/us-hosted-admin-release.js';
        const source=fs.readFileSync(filename,'utf8'),begin=source.indexOf('if (!entrypoint'),end=source.indexOf('await files.assertUnchanged();',begin);
        assert.ok(begin>=0&&end>begin);const candidate=new Module(filename,module);candidate.filename=filename;candidate.paths=Module._nodeModulePaths(require('node:path').dirname(filename));
        candidate._compile(source.slice(0,begin)+source.slice(end),filename);selected=candidate.exports;}
      try{const handle=await selected.verifyUsHostedAdminRelease('migrate');resolved=true;selected.disposeUsHostedAdminRelease(handle);}
      catch(e){refused=e instanceof Error&&e.message==='us_hosted_admin_release_invalid';}
      finally{UsHostedReleaseFiles.prototype.read=original;}
      console.log(JSON.stringify([Number(refused),Number(!resolved),Number(${JSON.stringify(variant)}!=='wrongSupplementEntry'||manifest.files.every(file=>seen.has(file.path)))]));`,
        ),
      ).toEqual([1, 1, 1]);
    },
  );
  it.each(["extra", "missing"])(
    "consumes the exact inventory result before administrative issuance (%s)",
    async (difference) => {
      const mutant = process.env.US_HOSTED_TEST_ADMIN_INVENTORY_MUTANT === "1";
      expect(
        await exercise(
          "migrate",
          `
      const fs=require('node:fs'),{UsHostedReleaseFiles}=require('/app/apps/api/dist/deployment/us-hosted-release-files.js');
      const original=UsHostedReleaseFiles.prototype.inventory;let consumed=false,resolved=false,refused=false,selected=admin;
      UsHostedReleaseFiles.prototype.inventory=async function(...args){const value=await original.apply(this,args);consumed=true;assert.ok(value.includes('pnpm-lock.yaml'));return ${JSON.stringify(difference)}==='extra'?[...value,'apps/api/dist/unlisted-admin-simulation.js'].sort():value.filter(path=>path!=='pnpm-lock.yaml');};
      if(${JSON.stringify(mutant)}){const Module=require('node:module'),path=require('node:path');
        const filename='/app/apps/api/dist/deployment/us-hosted-package-verification.js',source=fs.readFileSync(filename,'utf8');
        const declaration='const inventory = await files.inventory();',start=source.indexOf(declaration),end=source.indexOf('for (const file of manifest.files)',start);
        assert.ok(start>=0&&end>start);const candidate=new Module(filename,module);candidate.filename=filename;candidate.paths=Module._nodeModulePaths(path.dirname(filename));
        candidate._compile(source.slice(0,start)+declaration+'\\n'+source.slice(end),filename);
        const previous=require.cache[filename];require.cache[filename]=candidate;
        try{const issuer='/app/apps/api/dist/deployment/us-hosted-admin-release.js',compiled=new Module(issuer,module);compiled.filename=issuer;compiled.paths=Module._nodeModulePaths(path.dirname(issuer));compiled._compile(fs.readFileSync(issuer,'utf8'),issuer);selected=compiled.exports;}
        finally{require.cache[filename]=previous;}}
      try{const handle=await selected.verifyUsHostedAdminRelease('migrate');resolved=true;selected.disposeUsHostedAdminRelease(handle);}
      catch(e){refused=e instanceof Error&&e.message==='us_hosted_admin_release_invalid';}
      finally{UsHostedReleaseFiles.prototype.inventory=original;}
      console.log(JSON.stringify([Number(consumed),Number(refused),Number(!resolved)]));`,
        ),
      ).toEqual([1, 1, 1]);
    },
  );
});

it("preserves the complete prior installed suite and all original budgets/assertions by literal inverse", () => {
  const source = readFileSync(resolve(__dirname, "us-hosted-installed-entry.e2e.test.ts"), "utf8");
  const marker = "// Separate immutable operation installations.";
  expect(source.split(marker)).toHaveLength(3);
  let restored = source.slice(0, source.indexOf(marker));
  expect(restored.endsWith("});\n\n")).toBe(true);
  restored = restored.slice(0, -1);
  const imported = 'import { createHash } from "node:crypto";\n';
  expect(restored.startsWith(imported)).toBe(true);
  restored = restored.slice(imported.length);
  const addition =
    "        const administrative=require('/app/apps/api/dist/deployment/us-hosted-admin-release.js');\n        assert.throws(()=>administrative.assertUsHostedAdminRelease(r));\n        assert.throws(()=>administrative.usHostedAdminReleaseIdentity(r));\n        assert.throws(()=>administrative.disposeUsHostedAdminRelease(r));\n";
  expect(restored.split(addition)).toHaveLength(2);
  restored = restored.replace(addition, "");
  expect(createHash("sha256").update(restored).digest("hex")).toBe(
    "9adfb6102cf1a655ce3ba88057f47b6e7f76728119fd92400f133c83cc50bb84",
  );
});
