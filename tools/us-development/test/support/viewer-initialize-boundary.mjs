import { types } from "node:util";
import { isAbsolute, join } from "node:path";
import { lstat, open, writeFile } from "node:fs/promises";
import { fstatSync, ftruncateSync, writeSync } from "node:fs";

const snapshots = new WeakSet();
const retainedFailures = new WeakMap();
const nativeThen = Promise.prototype.then;
const apply = Reflect.apply;
const registerSnapshot = (value) => {
  snapshots.add(value);
  return Object.freeze(value);
};
const unavailable = () => registerSnapshot({ available: false, complete: false });
const own = (value, key) =>
  value !== null && typeof value === "object" && !types.isProxy(value)
    ? Object.getOwnPropertyDescriptor(value, key)?.value
    : undefined;
const requests = ["request_scenario_a", "request_april", "request_september"];
export function writeInitializeBoundaryFrame(fd, line) {
  try {
    if (
      !Number.isSafeInteger(fd) ||
      fd < 3 ||
      typeof line !== "string" ||
      line.length > 24 ||
      (line !== "!\n" &&
        !/^(0|[1-9][0-9]*) [0-4] [0-5] (0|[1-9][0-9]*) (0|[1-9][0-9]*)\n$/.test(line))
    )
      throw new Error("invalid_frame");
    const metadata = fstatSync(fd);
    const bytes = Buffer.from(line, "ascii");
    if (
      !metadata.isFile() ||
      metadata.uid !== process.getuid?.() ||
      (metadata.mode & 0o777) !== 0o600 ||
      metadata.size + bytes.length > 16384
    )
      throw new Error("invalid_frame_file");
    // Reserve the entire frame first. An interrupted/short write leaves an invalid NUL tail.
    ftruncateSync(fd, metadata.size + bytes.length);
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(fd, bytes, offset, bytes.length - offset, metadata.size + offset);
      if (!Number.isSafeInteger(written) || written <= 0 || written > bytes.length - offset)
        throw new Error("frame_write_incomplete");
      offset += written;
    }
  } catch {
    try {
      ftruncateSync(fd, 0);
    } catch {
      /* An unusable observer cannot affect the native command. */
    }
    throw new Error("viewer_boundary_write_invalid");
  }
}
function unitFor(method, args) {
  if (method === 2) {
    const selector = args[1];
    const kind = own(selector, "kind"),
      index = own(selector, "index");
    if (kind === "regular" && Number.isInteger(index) && index >= 0 && index < 260) return index;
    if (kind === "correction") return 260;
    if (kind === "orphan") return 261;
    return -1;
  }
  if (method === 5) {
    const index = requests.indexOf(args[1]);
    return index < 0 ? -1 : 263 + index;
  }
  return 262;
}

/** Test-only side observation. It grants no command, source or material authority. */
export function createInitializeBoundaryObservation(sink, clock = () => performance.now() * 1000) {
  let sequence = 0,
    bytes = 0,
    disabled = false;
  const started = clock();
  const invalidate = () => {
    if (disabled) return;
    disabled = true;
    try {
      sink("!\n");
    } catch {
      /* A broken observer sink grants no authority. */
    }
  };
  const emit = (event, method, unit) => {
    try {
      if (disabled) return;
      const elapsed = Math.floor(clock() - started);
      if (!Number.isSafeInteger(elapsed) || elapsed < 0 || elapsed > 3_600_000_000 || unit < 0)
        throw new Error("invalid_observation");
      const line = `${++sequence} ${event} ${method} ${unit} ${elapsed}\n`;
      bytes += Buffer.byteLength(line);
      if (sequence > 536 || bytes > 16384 || line.length > 24)
        throw new Error("invalid_observation");
      sink(line);
    } catch {
      invalidate();
    }
  };
  try {
    sink("0 0 0 262 0\n");
  } catch {
    disabled = true;
  }
  return {
    wrap(original, method) {
      if (typeof original !== "function" || !Number.isInteger(method) || method < 1 || method > 5)
        throw new Error("viewer_boundary_method_invalid");
      return function (...args) {
        const unit = unitFor(method, args);
        emit(0, method, unit);
        let value;
        try {
          value = apply(original, this, args);
        } catch (error) {
          emit(2, method, unit);
          throw error;
        }
        if (types.isPromise(value)) {
          // This extra reaction is intentional observation scheduling, not native timing proof.
          try {
            const branch = apply(nativeThen, value, [
              () => {
                emit(3, method, unit);
              },
              () => {
                emit(4, method, unit);
              },
            ]);
            apply(nativeThen, branch, [undefined, () => {}]);
          } catch {
            invalidate();
          }
        } else emit(1, method, unit);
        return value;
      };
    },
  };
}

const expected = [[0, 1, 262]];
for (let unit = 0; unit < 262; unit++) expected.push([0, 2, unit], [1, 2, unit]);
expected.push([1, 1, 262], [0, 3, 262], [0, 4, 262], [1, 4, 262]);
for (let unit = 263; unit < 266; unit++) expected.push([0, 5, unit], [1, 5, unit]);
expected.push([1, 3, 262]);

/** A valid prefix is attribution only; even all boundaries do not accept the CLI. */
export function parseInitializeBoundary(bytes) {
  try {
    if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 16384) return unavailable();
    const text = bytes.toString("ascii");
    if (!Buffer.from(text, "ascii").equals(bytes) || !text.endsWith("\n")) return unavailable();
    const lines = text.slice(0, -1).split("\n");
    if (lines[0] !== "0 0 0 262 0" || lines.length > 537) return unavailable();
    let elapsed = 0,
      cursor = 0,
      failed = false,
      last;
    const totals = [0, 0, 0, 0, 0];
    const stack = [];
    for (let index = 1; index < lines.length; index++) {
      const line = lines[index];
      if (
        line.length + 1 > 24 ||
        !/^(0|[1-9][0-9]*) (0|[1-4]) [1-5] (0|[1-9][0-9]*) (0|[1-9][0-9]*)$/.test(line)
      )
        return unavailable();
      const [sequence, event, method, unit, time] = line.split(" ").map(Number);
      if (sequence !== index || unit > 265 || time < elapsed || time > 3_600_000_000)
        return unavailable();
      elapsed = time;
      const rejection = event === 2 || event === 4;
      const wanted = expected[cursor];
      if (event === 0) {
        if (failed || !wanted || wanted[0] !== 0 || wanted[1] !== method || wanted[2] !== unit)
          return unavailable();
        stack.push({ method, unit, started: time });
        cursor++;
      } else {
        const active = stack.pop();
        if (!active || active.method !== method || active.unit !== unit) return unavailable();
        totals[method - 1] += time - active.started;
        if (
          !rejection &&
          (failed || !wanted || wanted[0] !== 1 || wanted[1] !== method || wanted[2] !== unit)
        )
          return unavailable();
        if (rejection) failed = true;
        else cursor++;
      }
      last = { method, unit, event };
    }
    const active = stack.at(-1);
    return registerSnapshot({
      available: true,
      complete: !failed && cursor === expected.length && stack.length === 0,
      frames: lines.length - 1,
      method: active?.method ?? last?.method ?? 0,
      unit: active?.unit ?? last?.unit ?? 262,
      event: last?.event ?? 0,
      active: active ? 1 : 0,
      elapsedMicroseconds: elapsed,
      activeStartedMicroseconds: active?.started ?? 0,
      activeObservedLowerBoundMicroseconds: active ? elapsed - active.started : 0,
      traceMicroseconds: totals[0],
      unitsMicroseconds: totals[1],
      artifactsMicroseconds: totals[2],
      planMicroseconds: totals[3],
      requestsMicroseconds: totals[4],
    });
  } catch {
    return unavailable();
  }
}

/** Fixed test bootstrap; the generated file is outside attested product trees. */
export function createInitializeBoundaryBootstrap(root) {
  if (typeof root !== "string" || !isAbsolute(root) || root.includes("\0"))
    throw new Error("viewer_boundary_root_invalid");
  const dist = join(root, "apps/api/dist");
  const runtime = join(dist, "deployment/us-dataset-command-runtime.js");
  const modules = [
    ["us-dataset-trace-readiness-seed", "UsDatasetTraceReadinessSeedStore"],
    ["us-dataset-unit-composition", "UsDatasetUnitCompositionStore"],
    ["us-dataset-artifact-seed", "UsDatasetArtifactSeedStore"],
    ["us-dataset-plan-seed", "UsDatasetPlanSeedStore"],
    ["us-dataset-request-seed", "UsDatasetRequestSeedStore"],
  ].map(([file, name]) => [join(dist, "modules/traceability/demo", file + ".js"), name]);
  return `"use strict";
const runtime = require(${JSON.stringify(runtime)});
void (async () => {
  const { createInitializeBoundaryObservation, writeInitializeBoundaryFrame } = await import(${JSON.stringify(import.meta.url)});
  const observation = createInitializeBoundaryObservation(line => writeInitializeBoundaryFrame(3, line));
  const modules = ${JSON.stringify(modules)};
  for (let index = 0; index < modules.length; index++) {
    const [path, name] = modules[index];
    const resolved = require.resolve(path);
    const cached = require.cache[resolved];
    if (!cached || !cached.loaded) throw new Error("viewer_boundary_module_invalid");
    const actual = require(resolved);
    if (cached.exports !== actual) throw new Error("viewer_boundary_module_invalid");
    const descriptor = Object.getOwnPropertyDescriptor(actual[name].prototype, "initialize");
    if (!descriptor || typeof descriptor.value !== "function") throw new Error("viewer_boundary_module_invalid");
    Object.defineProperty(actual[name].prototype, "initialize", { ...descriptor, value: observation.wrap(descriptor.value, index + 1) });
  }
  if (require.cache[require.resolve(${JSON.stringify(runtime)})].exports !== runtime)
    throw new Error("viewer_boundary_module_invalid");
  require(${JSON.stringify(join(dist, "main.us-dataset.js"))});
})().catch(() => { process.stderr.write("viewer_boundary_bootstrap_failed\\n"); process.exitCode = 1; });
`;
}

export async function openInitializeBoundarySession(directory, root) {
  const metadata = await lstat(directory);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== process.getuid?.() ||
    (metadata.mode & 0o777) !== 0o700
  )
    throw new Error("viewer_boundary_directory_invalid");
  const script = join(directory, "initialize-boundary.cjs");
  const handle = await open(join(directory, "initialize-boundary.frames"), "wx+", 0o600);
  try {
    await writeFile(script, createInitializeBoundaryBootstrap(root), { mode: 0o600, flag: "wx" });
  } catch (error) {
    await handle.close();
    throw error;
  }
  let finishing;
  return {
    script,
    fd: handle.fd,
    finishAfterSettled() {
      return (finishing ??= (async () => {
        try {
          const buffer = Buffer.alloc(16385);
          let length = 0;
          while (length < buffer.length) {
            const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
            if (bytesRead === 0) break;
            length += bytesRead;
          }
          return parseInitializeBoundary(buffer.subarray(0, length));
        } catch {
          return unavailable();
        } finally {
          await handle.close();
        }
      })());
    },
  };
}

export function retainInitializeBoundaryFailure(error, snapshot) {
  if (
    error !== null &&
    (typeof error === "object" || typeof error === "function") &&
    snapshots.has(snapshot)
  )
    retainedFailures.set(error, snapshot);
}
export function takeInitializeBoundaryFailure(error) {
  const snapshot = retainedFailures.get(error);
  retainedFailures.delete(error);
  if (!snapshot) return undefined;
  const values = Object.fromEntries(
    Object.entries(snapshot).map(([key, value]) => [
      key,
      typeof value === "boolean" ? Number(value) : value,
    ]),
  );
  return `US_DEMO_VIEWER_INITIALIZE_BOUNDARY ${JSON.stringify(values)}`;
}
