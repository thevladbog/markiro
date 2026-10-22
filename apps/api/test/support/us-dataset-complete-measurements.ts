import { countActualQueries } from "./us-dataset-query-counter.js";

const phaseModes = {
  fresh: null,
  generation: "initialize",
  pending: "verify",
  resume: "initialize",
  queued_baseline: null,
  replay_initialize: "initialize",
  replay_verify: "verify",
  wrong_tenant: null,
  owner_revoked: null,
  profile_changed: null,
  native_drift: null,
  missing: "verify",
  corrupt: "verify",
} as const;
type Phase = keyof typeof phaseModes;
type Mode = "initialize" | "verify";
const snapshots: Record<Phase, readonly string[]> = {
  fresh: ["fresh-before", "fresh-after"],
  generation: [],
  pending: ["pending-before", "pending-after"],
  resume: [],
  queued_baseline: ["completed-before"],
  replay_initialize: ["completed-initialize-after"],
  replay_verify: ["completed-verify-after"],
  wrong_tenant: ["refusal-before", "refusal-after"],
  owner_revoked: ["refusal-before", "refusal-after"],
  profile_changed: ["refusal-before", "refusal-after"],
  native_drift: ["drift-before", "drift-after"],
  missing: ["missing-before", "missing-after"],
  corrupt: ["corrupt-before", "corrupt-after"],
};
type Boundary = {
  phase: Phase;
  component: "trace" | "artifacts" | "snapshot";
  mode: Mode | "snapshot";
  snapshot: string | null;
  observation: "measured" | "unavailable";
  outcome: "returned" | "threw" | "not_called";
  elapsedMs: number | null;
  driverDispatches: number | null;
};
const keys = [
  "phase",
  "component",
  "mode",
  "snapshot",
  "observation",
  "outcome",
  "elapsedMs",
  "driverDispatches",
];
const failure = () => new Error("us_dataset_complete_measurement_invalid");

/** Closed data only: validate own data descriptors before reading any field. */
export function parseUsDatasetCompleteBoundary(value: unknown): Boundary {
  if (
    value === null ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw failure();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(descriptors).length !== keys.length ||
    keys.some((key) => {
      const descriptor = descriptors[key];
      return !descriptor || !Object.hasOwn(descriptor, "value");
    })
  )
    throw failure();
  const fields = value as Record<string, unknown>;
  const { phase, component, mode, snapshot, observation, outcome, elapsedMs, driverDispatches } =
    fields;
  if (typeof phase !== "string" || !Object.hasOwn(phaseModes, phase)) throw failure();
  const closedPhase = phase as Phase;
  if (component !== "trace" && component !== "artifacts" && component !== "snapshot")
    throw failure();
  if (mode !== "initialize" && mode !== "verify" && mode !== "snapshot") throw failure();
  if (component === "snapshot") {
    if (
      mode !== "snapshot" ||
      typeof snapshot !== "string" ||
      !snapshots[closedPhase].includes(snapshot)
    )
      throw failure();
  } else if (snapshot !== null || mode !== phaseModes[closedPhase]) throw failure();
  if (observation !== "measured" && observation !== "unavailable") throw failure();
  if (outcome !== "returned" && outcome !== "threw" && outcome !== "not_called") throw failure();
  if (observation === "measured") {
    if (
      outcome === "not_called" ||
      typeof elapsedMs !== "number" ||
      !Number.isFinite(elapsedMs) ||
      elapsedMs < 0 ||
      typeof driverDispatches !== "number" ||
      !Number.isSafeInteger(driverDispatches) ||
      driverDispatches < 0
    )
      throw failure();
  } else if (elapsedMs !== null || driverDispatches !== null) throw failure();
  return {
    phase: closedPhase,
    component,
    mode,
    snapshot: snapshot as string | null,
    observation,
    outcome,
    elapsedMs: elapsedMs as number | null,
    driverDispatches: driverDispatches as number | null,
  };
}

type Outcome<T> = { returned: true; value: T } | { returned: false; value: unknown };
type Owned = {
  target: object;
  mode: Mode;
  original: PropertyDescriptor;
  installed: PropertyDescriptor;
};
type Options = {
  pool: Parameters<typeof countActualQueries>[0];
  tracePrototype: object;
  artifactPrototype: object;
  emit: (line: string) => void;
};

/** Observation only. No values/errors/arguments enter the closed record ledger. */
export function createUsDatasetCompleteMeasurements(options: Options) {
  const records: Boundary[] = [];
  const owned: Owned[] = [];
  let bytes = 0;
  let invalid = false;
  let hasOriginalThrow = false;
  let originalThrow: unknown;
  let scopeActive = false;
  let windowActive = false;
  function invalidate(outcome?: Outcome<unknown>) {
    if (!invalid && outcome && !outcome.returned) {
      hasOriginalThrow = true;
      originalThrow = outcome.value;
    }
    invalid = true;
  }
  function abort(): never {
    if (hasOriginalThrow) throw originalThrow;
    throw failure();
  }
  function guard() {
    if (invalid) abort();
    if (windowActive) {
      invalidate();
      abort();
    }
  }
  function publish(value: Boundary) {
    const record = parseUsDatasetCompleteBoundary(value);
    const json = JSON.stringify(record);
    const size = Buffer.byteLength(json);
    if (records.length >= 40 || size > 512 || bytes + size > 20 * 1024) throw failure();
    options.emit(`Complete seed boundary: ${json}\n`);
    records.push(Object.freeze(record));
    bytes += size;
  }
  async function observe<T>(
    phase: Phase,
    component: Boundary["component"],
    mode: Boundary["mode"],
    snapshot: string | null,
    action: () => Promise<T>,
  ): Promise<T> {
    guard();
    if (records.length >= 40) {
      invalidate();
      abort();
    }
    const base = { phase, component, mode, snapshot };
    try {
      parseUsDatasetCompleteBoundary({
        ...base,
        observation: "measured",
        outcome: "returned",
        elapsedMs: 0,
        driverDispatches: 0,
      });
    } catch {
      invalidate();
      abort();
    }
    windowActive = true;
    const start = performance.now();
    let outcome: Outcome<T> | undefined;
    let count: number | undefined;
    try {
      const counted = await countActualQueries(options.pool, async () => {
        try {
          outcome = { returned: true, value: await action() };
        } catch (value) {
          outcome = { returned: false, value };
        }
        return outcome;
      });
      count = counted.count;
    } catch {
      invalidate(outcome);
    }
    try {
      publish({
        ...base,
        observation: count === undefined ? "unavailable" : "measured",
        outcome: outcome ? (outcome.returned ? "returned" : "threw") : "not_called",
        elapsedMs: count === undefined ? null : performance.now() - start,
        driverDispatches: count ?? null,
      });
    } catch {
      invalidate(outcome);
    } finally {
      windowActive = false;
    }
    if (outcome && !outcome.returned) throw outcome.value;
    if (invalid || !outcome) abort();
    return outcome.value;
  }
  function sameDescriptor(left: PropertyDescriptor | undefined, right: PropertyDescriptor) {
    return (
      left?.value === right.value &&
      left?.writable === right.writable &&
      left?.enumerable === right.enumerable &&
      left?.configurable === right.configurable &&
      left?.get === right.get &&
      left?.set === right.set
    );
  }
  function restoreDescriptors(outcome?: Outcome<unknown>) {
    for (const entry of owned.splice(0)) {
      try {
        if (
          !sameDescriptor(
            Object.getOwnPropertyDescriptor(entry.target, entry.mode),
            entry.installed,
          )
        )
          throw failure();
        Object.defineProperty(entry.target, entry.mode, entry.original);
      } catch {
        invalidate(outcome);
      }
    }
  }
  function install(target: object, component: "trace" | "artifacts", phase: Phase, mode: Mode) {
    guard();
    const original = Object.getOwnPropertyDescriptor(target, mode);
    if (
      !original ||
      !Object.hasOwn(original, "value") ||
      typeof original.value !== "function" ||
      !original.writable ||
      !original.configurable
    )
      throw failure();
    const callable: (...args: unknown[]) => unknown = original.value;
    const installed = {
      ...original,
      value: function (this: unknown, ...args: unknown[]) {
        return observe(phase, component, mode, null, async () =>
          Reflect.apply(callable, this, args),
        );
      },
    };
    Object.defineProperty(target, mode, installed);
    owned.push({ target, mode, original, installed });
  }
  return {
    async withComplete<T>(phase: Phase, mode: Mode, action: () => Promise<T>): Promise<T> {
      guard();
      if (scopeActive || phaseModes[phase] !== mode) {
        invalidate();
        abort();
      }
      scopeActive = true;
      let outcome: Outcome<T> | undefined;
      try {
        install(options.tracePrototype, "trace", phase, mode);
        install(options.artifactPrototype, "artifacts", phase, mode);
        try {
          outcome = { returned: true, value: await action() };
        } catch (value) {
          outcome = { returned: false, value };
        }
      } catch {
        invalidate(outcome);
      } finally {
        restoreDescriptors(outcome);
        scopeActive = false;
      }
      if (outcome && !outcome.returned) throw outcome.value;
      if (invalid || !outcome) abort();
      return outcome.value;
    },
    async snapshot<T>(phase: Phase, label: string, action: () => Promise<T>): Promise<T> {
      guard();
      if (scopeActive) {
        invalidate();
        abort();
      }
      return observe(phase, "snapshot", "snapshot", label, action);
    },
    assertCanContinue() {
      guard();
      if (scopeActive) {
        invalidate();
        abort();
      }
    },
    assertComplete() {
      guard();
      if (scopeActive || records.length !== 33) {
        invalidate();
        abort();
      }
      const expected: [Phase, string, string | null, Boundary["outcome"]][] = [];
      const snap = (phase: Phase, label: string) =>
        expected.push([phase, "snapshot", label, "returned"]);
      const complete = (phase: Phase, outcome: Boundary["outcome"] = "returned") => {
        expected.push([phase, "trace", null, "returned"], [phase, "artifacts", null, outcome]);
      };
      snap("fresh", "fresh-before");
      snap("fresh", "fresh-after");
      complete("generation", "threw");
      snap("pending", "pending-before");
      complete("pending", "threw");
      snap("pending", "pending-after");
      complete("resume");
      snap("queued_baseline", "completed-before");
      complete("replay_initialize");
      snap("replay_initialize", "completed-initialize-after");
      complete("replay_verify");
      snap("replay_verify", "completed-verify-after");
      for (const phase of ["wrong_tenant", "owner_revoked", "profile_changed"] as const) {
        snap(phase, "refusal-before");
        snap(phase, "refusal-after");
      }
      snap("native_drift", "drift-before");
      snap("native_drift", "drift-after");
      for (const phase of ["missing", "corrupt"] as const) {
        snap(phase, `${phase}-before`);
        complete(phase, "threw");
        snap(phase, `${phase}-after`);
      }
      if (
        records.some((r, i) => {
          const wanted = expected[i];
          return (
            !wanted ||
            r.observation !== "measured" ||
            r.phase !== wanted[0] ||
            r.component !== wanted[1] ||
            r.snapshot !== wanted[2] ||
            r.outcome !== wanted[3]
          );
        })
      ) {
        invalidate();
        abort();
      }
    },
    restoreOwned() {
      // Cleanup is deliberately permitted while invalid; no action/counter is entered.
      try {
        restoreDescriptors();
        if (invalid) abort();
      } finally {
        hasOriginalThrow = false;
        originalThrow = undefined;
      }
    },
  };
}
