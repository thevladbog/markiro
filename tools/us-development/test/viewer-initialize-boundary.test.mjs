import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import {
  createInitializeBoundaryBootstrap,
  openInitializeBoundarySession,
  retainInitializeBoundaryFailure,
  takeInitializeBoundaryFailure,
  writeInitializeBoundaryFrame,
  createInitializeBoundaryObservation,
  parseInitializeBoundary,
} from "./support/viewer-initialize-boundary.mjs";
import {
  observeDatasetInitializeFailures,
  runDatasetPositiveChild,
} from "./support/dataset-command-positive-fixture.mjs";
import { existsSync, fstatSync, writeSync } from "node:fs";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const tick = () => new Promise((resolve) => setImmediate(resolve));
function observer() {
  const lines = [];
  let now = 0;
  return {
    lines,
    observation: createInitializeBoundaryObservation(
      (line) => lines.push(line),
      () => ++now,
    ),
  };
}

test("native fulfillment preserves receiver, arguments and exact promise with closed frames", async () => {
  const { observation, lines } = observer();
  const receiver = {},
    argument = {},
    result = {};
  const promise = Promise.resolve(result);
  let calls = 0;
  const wrapped = observation.wrap(function (value) {
    assert.equal(this, receiver);
    assert.equal(value, argument);
    calls++;
    return promise;
  }, 1);
  assert.equal(wrapped.call(receiver, argument), promise);
  assert.equal(await promise, result);
  await tick();
  assert.equal(calls, 1);
  assert.equal(lines.length, 3);
  assert.match(lines[2], /^2 3 1 262 [0-9]+\n$/);
  // A synthetic early fulfillment cannot impersonate all 262 native unit calls.
  assert.equal(parseInitializeBoundary(Buffer.from(lines.join(""))).available, false);
});

test("native rejection and synchronous throw retain original identity", async () => {
  const { observation, lines } = observer();
  const error = new Error("private-value-never-emitted");
  const promise = Promise.reject(error);
  const wrapped = observation.wrap(() => promise, 1);
  assert.equal(wrapped(), promise);
  await assert.rejects(promise, (value) => value === error);
  await tick();
  assert.equal(lines.length, 3);
  assert.equal(parseInitializeBoundary(Buffer.from(lines.join(""))).event, 4);
  const sync = observer();
  assert.throws(
    sync.observation.wrap(() => {
      throw error;
    }, 1),
    (value) => value === error,
  );
  assert.equal(parseInitializeBoundary(Buffer.from(sync.lines.join(""))).event, 2);
  assert.ok(!lines.join("").includes("private"));
});

test("observer never evaluates a native promise's replaced then property", async () => {
  const { observation, lines } = observer();
  const promise = Promise.resolve(17);
  Object.defineProperty(promise, "then", {
    get() {
      throw new Error("private-then-trap");
    },
  });
  assert.equal(observation.wrap(() => promise, 1)(), promise);
  assert.equal(await promise, 17);
  await tick();
  assert.equal(lines.length, 3);
});

test("an unrecognized selector invalidates attribution without invoking descriptor traps or changing native return", () => {
  const { observation, lines } = observer();
  const selector = new Proxy(
    {},
    {
      getOwnPropertyDescriptor() {
        throw new Error("private-trap");
      },
    },
  );
  const result = {};
  let calls = 0;
  assert.equal(
    observation.wrap(() => {
      calls++;
      return result;
    }, 2)({}, selector),
    result,
  );
  assert.equal(calls, 1);
  assert.equal(parseInitializeBoundary(Buffer.from(lines.join(""))).available, false);
});

test("a lost next frame cannot leave an older valid prefix looking current", async () => {
  const directory = await mkdtemp(join(tmpdir(), "us-boundary-zero-progress-"));
  const receipt = await open(join(directory, "frames"), "wx+", 0o600);
  const original = fs.writeSync;
  try {
    writeInitializeBoundaryFrame(receipt.fd, "0 0 0 262 0\n");
    writeInitializeBoundaryFrame(receipt.fd, "1 0 1 262 1\n");
    assert.equal(
      parseInitializeBoundary(await readFile(join(directory, "frames"))).available,
      true,
    );
    fs.writeSync = () => 0;
    syncBuiltinESMExports();
    assert.throws(() => writeInitializeBoundaryFrame(receipt.fd, "2 0 2 0 2\n"));
    assert.equal(
      parseInitializeBoundary(await readFile(join(directory, "frames"))).available,
      false,
    );
  } finally {
    fs.writeSync = original;
    syncBuiltinESMExports();
    await receipt.close();
    await rm(directory, { recursive: true });
  }
});

test("synchronous returns remain synchronous and observer sink failure is contained", () => {
  const { observation, lines } = observer();
  const value = {};
  assert.equal(observation.wrap(() => value, 1)(), value);
  assert.match(lines[2], /^2 1 1 262 [0-9]+\n$/);
  const bad = createInitializeBoundaryObservation(() => {
    throw new Error("sink");
  });
  assert.equal(bad.wrap(() => value, 1)(), value);
});

test("valid interrupted prefix retains active composition unit without claiming completion", () => {
  const bytes = Buffer.from("0 0 0 262 0\n1 0 1 262 1\n2 0 2 17 2\n");
  const parsed = parseInitializeBoundary(bytes);
  // Unit17 cannot be the first regular unit: the parser validates the exact sequence.
  assert.equal(parsed.available, false);
  const valid = parseInitializeBoundary(Buffer.from(bytes.toString().replace("2 17", "2 0")));
  assert.equal(valid.available, true);
  assert.equal(valid.complete, false);
  assert.equal(valid.method, 2);
  assert.equal(valid.unit, 0);
  assert.equal(valid.active, 1);
  assert.equal(valid.activeStartedMicroseconds, 2);
  assert.equal(valid.activeObservedLowerBoundMicroseconds, 0);
  assert.equal(Object.hasOwn(valid, "activeElapsedMicroseconds"), false);
});

test(
  "actual bootstrap completes short writes and invalidates zero-progress writes",
  {
    timeout: 60000,
    skip: !existsSync(new URL("../../../apps/api/dist/main.us-dataset.js", import.meta.url)),
  },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "us-boundary-bootstrap-writes-"));
    try {
      const root = resolve(new URL("../../..", import.meta.url).pathname);
      const script = join(directory, "bootstrap.cjs");
      await writeFile(script, createInitializeBoundaryBootstrap(root), { mode: 0o600, flag: "wx" });
      for (const zero of [false, true]) {
        const path = join(directory, zero ? "zero" : "partial");
        const receipt = await open(path, "wx+", 0o600);
        try {
          const setup = `const fs=require('node:fs');const {syncBuiltinESMExports}=require('node:module');const native=fs.writeSync;fs.writeSync=function(fd,value,offset,length,position){if(fd!==3)return Reflect.apply(native,this,arguments);if(${zero})return 0;if(typeof value==='string')return native(fd,value.slice(0,2));return native(fd,value,offset,Math.min(length,2),position)};syncBuiltinESMExports();process.argv=[process.execPath,${JSON.stringify(script)},'--not-a-dataset-mode'];require(${JSON.stringify(script)});`;
          const observed = await child(process.execPath, ["-e", setup], receipt.fd);
          assert.equal(observed.code, 1);
          assert.equal(observed.stdout, "");
          assert.equal(observed.stderr, '{"code":"us_dataset_command_arguments_invalid"}\n');
          const bytes = await readFile(path);
          if (zero) assert.equal(parseInitializeBoundary(bytes).available, false);
          else assert.deepEqual(bytes, Buffer.from("0 0 0 262 0\n"));
        } finally {
          await receipt.close();
        }
      }
    } finally {
      await rm(directory, { recursive: true });
    }
  },
);

test("malformed, truncated, oversized, displaced and nonmonotonic frames are unavailable", () => {
  for (const text of [
    "",
    "0 0 0 262 0",
    "0 0 0 262 0\n1 0 99 0 1\n",
    "0 0 0 262 0\n1 0 1 262 2\n2 3 1 262 1\n",
    "0 0 0 262 0\n1 0 1 262 1\n1 3 1 262 2\n",
    "0 0 0 262 0\nprivate-secret\n",
    "0".repeat(16385),
  ])
    assert.deepEqual(parseInitializeBoundary(Buffer.from(text)), {
      available: false,
      complete: false,
    });
});

test("complete native order has 536 frames; unknown suffix still grants no CLI success", () => {
  const lines = ["0 0 0 262 0\n"];
  let sequence = 0;
  const add = (event, method, unit) =>
    lines.push(`${++sequence} ${event} ${method} ${unit} ${sequence}\n`);
  add(0, 1, 262);
  for (let unit = 0; unit < 262; unit++) {
    add(0, 2, unit);
    add(3, 2, unit);
  }
  add(3, 1, 262);
  add(0, 3, 262);
  add(0, 4, 262);
  add(3, 4, 262);
  for (let unit = 263; unit < 266; unit++) {
    add(0, 5, unit);
    add(3, 5, unit);
  }
  add(3, 3, 262);
  const parsed = parseInitializeBoundary(Buffer.from(lines.join("")));
  assert.equal(parsed.available, true);
  assert.equal(parsed.complete, true);
  assert.equal(parsed.frames, 536);
  assert.equal(parsed.traceMicroseconds, 525);
  assert.equal(parsed.unitsMicroseconds, 262);
  assert.equal(parsed.planMicroseconds, 1);
  assert.equal(parsed.requestsMicroseconds, 3);
  assert.equal(parsed.active, 0);
  assert.equal(Object.hasOwn(parsed, "commandAccepted"), false);
  assert.equal(
    parseInitializeBoundary(Buffer.from(lines.join("") + "537 0 5 265 537\n")).available,
    false,
  );
});

async function child(file, args, fd) {
  const process_ = spawn(file, args, { stdio: ["ignore", "pipe", "pipe", fd] });
  let stdout = "",
    stderr = "";
  process_.stdout.on("data", (bytes) => {
    stdout += bytes;
  });
  process_.stderr.on("data", (bytes) => {
    stderr += bytes;
  });
  const code = await new Promise((resolve, reject) => {
    process_.once("error", reject);
    process_.once("close", resolve);
  });
  return { code, stdout, stderr };
}

// Two cold, complete Nest/renderer imports; this is a refusal test, not a startup performance gate.
test(
  "fixed bootstrap preserves actual compiled CLI refusal and argument tail",
  {
    timeout: 60000,
    skip: !existsSync(new URL("../../../apps/api/dist/main.us-dataset.js", import.meta.url)),
  },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "us-boundary-bootstrap-"));
    const receipt = await open(join(directory, "frames"), "wx+", 0o600);
    try {
      const root = resolve(new URL("../../..", import.meta.url).pathname);
      const script = join(directory, "bootstrap.cjs");
      await writeFile(script, createInitializeBoundaryBootstrap(root), { mode: 0o600, flag: "wx" });
      const tail = ["--not-a-dataset-mode"];
      const original = await child(
        process.execPath,
        [join(root, "apps/api/dist/main.us-dataset.js"), ...tail],
        receipt.fd,
      );
      const observed = await child(process.execPath, [script, ...tail], receipt.fd);
      assert.equal(original.code, 1);
      assert.deepEqual(observed, original);
      const bytes = await readFile(join(directory, "frames"));
      assert.deepEqual(bytes, Buffer.from("0 0 0 262 0\n"));
      assert.equal(parseInitializeBoundary(bytes).complete, false);
    } finally {
      await receipt.close();
      await rm(directory, { recursive: true });
    }
  },
);

test(
  "actual GNU time inherits fd3 into Node",
  { skip: process.platform !== "linux", timeout: 10000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "us-boundary-gnu-"));
    const receipt = await open(join(directory, "frames"), "wx+", 0o600);
    try {
      const result = await child(
        "/usr/bin/time",
        [
          "-v",
          "-o",
          join(directory, "time"),
          process.execPath,
          "-e",
          "require('node:fs').writeSync(3,'0 0 0 262 0\\n')",
        ],
        receipt.fd,
      );
      assert.deepEqual(result, { code: 0, stdout: "", stderr: "" });
      assert.deepEqual(await readFile(join(directory, "frames")), Buffer.from("0 0 0 262 0\n"));
      assert.match(await readFile(join(directory, "time"), "utf8"), /Maximum resident set size/);
    } finally {
      await receipt.close();
      await rm(directory, { recursive: true });
    }
  },
);

test(
  "real bounded child forwards an owned fd and retains a valid prefix after actual termination",
  { timeout: 10000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "us-boundary-child-"));
    const receipt = await open(join(directory, "frames"), "wx+", 0o600);
    try {
      await assert.rejects(
        runDatasetPositiveChild(
          process.execPath,
          [
            "-e",
            "const fs=require('node:fs');fs.writeSync(3,'0 0 0 262 0\\n1 0 1 262 1\\n');setInterval(()=>{},1000)",
          ],
          {
            cap: 500,
            initializeBoundaryFd: receipt.fd,
          },
        ),
        (error) => error.evidence.timedOut === true && error.evidence.code !== 0,
      );
      const parsed = parseInitializeBoundary(await readFile(join(directory, "frames")));
      assert.equal(parsed.available, true);
      assert.equal(parsed.active, 1);
      assert.equal(parsed.complete, false);
    } finally {
      await receipt.close();
      await rm(directory, { recursive: true });
    }
  },
);

test("private session closes its own fd once and reads only the bounded frame prefix", async () => {
  const directory = await mkdtemp(join(tmpdir(), "us-boundary-session-"));
  try {
    const session = await openInitializeBoundarySession(
      directory,
      resolve(new URL("../../..", import.meta.url).pathname),
    );
    assert.equal(fstatSync(session.fd).mode & 0o777, 0o600);
    writeSync(session.fd, "0 0 0 262 0\n1 0 1 262 1\n");
    const first = session.finishAfterSettled();
    assert.equal(session.finishAfterSettled(), first);
    const parsed = await first;
    assert.equal(parsed.available, true);
    assert.equal(parsed.active, 1);
    assert.throws(
      () => fstatSync(session.fd),
      (error) => error.code === "EBADF",
    );
    assert.match(await readFile(session.script, "utf8"), /us-dataset-command-runtime/);
  } finally {
    await rm(directory, { recursive: true });
  }
});

test("short native reads cannot hide a malformed tail behind a valid header", async () => {
  const directory = await mkdtemp(join(tmpdir(), "us-boundary-short-read-"));
  const probe = await open(join(directory, "probe"), "wx+", 0o600);
  const prototype = Object.getPrototypeOf(probe);
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "read");
  await probe.close();
  try {
    const session = await openInitializeBoundarySession(
      directory,
      resolve(new URL("../../..", import.meta.url).pathname),
    );
    writeSync(session.fd, "0 0 0 262 0\nmalformed-private-tail\n");
    Object.defineProperty(prototype, "read", {
      ...descriptor,
      value(buffer, offset, length, position) {
        return Reflect.apply(descriptor.value, this, [
          buffer,
          offset,
          Math.min(length, 12),
          position,
        ]);
      },
    });
    assert.equal((await session.finishAfterSettled()).available, false);
  } finally {
    Object.defineProperty(prototype, "read", descriptor);
    await rm(directory, { recursive: true });
  }
});

test("only a parsed snapshot is retained on the exact error and consumed once", () => {
  const error = new Error("private-value");
  const parsed = parseInitializeBoundary(Buffer.from("0 0 0 262 0\n1 0 1 262 1\n"));
  retainInitializeBoundaryFailure(error, parsed);
  assert.equal(takeInitializeBoundaryFailure(new Error("private-value")), undefined);
  const line = takeInitializeBoundaryFailure(error);
  assert.match(line, /^US_DEMO_VIEWER_INITIALIZE_BOUNDARY /);
  const values = JSON.parse(line.slice("US_DEMO_VIEWER_INITIALIZE_BOUNDARY ".length));
  assert.ok(Object.values(values).every(Number.isSafeInteger));
  assert.equal(values.method, 1);
  assert.equal(values.complete, 0);
  assert.equal(takeInitializeBoundaryFailure(error), undefined);
  retainInitializeBoundaryFailure(error, { ...parsed });
  assert.equal(takeInitializeBoundaryFailure(error), undefined);
  assert.ok(!line.includes("private-value"));
});

test("actual failure observer emits the retained numeric boundary only after owned close", async () => {
  const error = new Error("native-original-error");
  const parsed = parseInitializeBoundary(Buffer.from("0 0 0 262 0\n1 0 1 262 1\n"));
  retainInitializeBoundaryFailure(error, parsed);
  const promise = Promise.reject(error),
    lines = [];
  const installation = { command: () => promise, close: () => Promise.resolve() };
  const observed = observeDatasetInitializeFailures(installation, (line) => lines.push(line));
  assert.equal(observed.command("initialize"), promise);
  await assert.rejects(promise, (value) => value === error);
  await tick();
  assert.equal(lines.length, 0);
  await observed.close();
  await tick();
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^US_DEMO_VIEWER_INITIALIZE_OBSERVATION /);
  assert.match(lines[1], /^US_DEMO_VIEWER_INITIALIZE_BOUNDARY /);
  assert.ok(!lines.join("").includes("native-original-error"));
});
