import { createHash } from "node:crypto";

// Bootstrap assumes the standard runtime. Private ownership/metadata operations
// retain these identities even when caller code later changes global intrinsics.
const safeDescriptor = Object.getOwnPropertyDescriptor;
const safeDescriptors = Object.getOwnPropertyDescriptors;
const safePrototype = Object.getPrototypeOf;
const safeKeys = Reflect.ownKeys;
const safeFreeze = Object.freeze;
const safeClone = structuredClone;
const safeApply = Reflect.apply;
const SafeSet = Set;
const SafeWeakSet = WeakSet;
const SafeWeakMap = WeakMap;
/* eslint-disable @typescript-eslint/unbound-method -- These captured methods are invoked only with trusted Reflect.apply and an explicit receiver. */
const setHas = Set.prototype.has,
  setAdd = Set.prototype.add,
  setDelete = Set.prototype.delete;
const weakHas = WeakSet.prototype.has,
  weakAdd = WeakSet.prototype.add;
const mapGet = WeakMap.prototype.get,
  mapSet = WeakMap.prototype.set;
/* eslint-enable @typescript-eslint/unbound-method */
const safeFinite = Number.isFinite;
const safeArray = Array.isArray;
const safeString = String;
const plainPrototype: unknown = Object.prototype;

type Guard = { target: object; key: PropertyKey; descriptor: PropertyDescriptor };
const guards: Guard[] = [];
function guard(target: object, key: PropertyKey): void {
  const descriptor = safeDescriptor(target, key);
  if (!descriptor) throw new Error("Missing canonical runtime intrinsic");
  guards[guards.length] = { target, key, descriptor };
}
for (const key of ["JSON", "Array", "Object", "Reflect", "Number", "Set", "RegExp"])
  guard(globalThis, key);
for (const [target, keys] of [
  [JSON, ["stringify"]],
  [Array, ["from", "isArray", "prototype", Symbol.species]],
  [Array.prototype, [Symbol.iterator, "values", "sort", "map", "join", "constructor"]],
  [Object, ["prototype", "getPrototypeOf", "getOwnPropertyDescriptors", "keys"]],
  [Reflect, ["ownKeys"]],
  [Number, ["isFinite"]],
  [Set, ["prototype"]],
  [Set.prototype, ["has", "add", "delete"]],
  [RegExp, ["prototype"]],
  [RegExp.prototype, ["test", "exec"]],
] as const)
  for (const key of keys) guard(target, key);
const arrayIteratorPrototype: unknown = safePrototype([][Symbol.iterator]());
if (typeof arrayIteratorPrototype !== "object" || arrayIteratorPrototype === null)
  throw new Error("Missing array iterator prototype");
guard(arrayIteratorPrototype, "next");

function stableIntrinsics(): boolean {
  for (let i = 0; i < guards.length; i++) {
    const item = guards[i];
    if (!item) return false;
    const current = safeDescriptor(item.target, item.key);
    if (!current) return false;
    const savedValue = safeDescriptor(item.descriptor, "value");
    const currentValue = safeDescriptor(current, "value");
    if (savedValue) {
      if (!currentValue || currentValue.value !== savedValue.value) return false;
    } else if (
      currentValue ||
      current.get !== item.descriptor.get ||
      current.set !== item.descriptor.set
    )
      return false;
  }
  return true;
}

const owned = new SafeWeakSet<object>();
type Bytes = {
  root: string | undefined;
  nested: string | undefined;
  unordered: string | undefined;
};
let bytesByNode = new SafeWeakMap<object, Bytes>();
let retainedBytes = 0;

function isBytes(value: unknown): value is Bytes {
  if (typeof value !== "object" || value === null) return false;
  const keys = ["root", "nested", "unordered"];
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (key === undefined) return false;
    const item: unknown = safeDescriptor(value, key)?.value;
    if (item !== undefined && typeof item !== "string") return false;
  }
  return true;
}

/** Detach/freeze first; only a completely finite plain JSON graph is admitted. */
export function ownedUsDemoJsonCopy<T>(input: T): T {
  const result = safeClone(input);
  const visited = new SafeSet<object>();
  const nodes: object[] = [];
  const freeze = (value: unknown): void => {
    if (value === null || typeof value !== "object" || safeApply(setHas, visited, [value])) return;
    safeApply(setAdd, visited, [value]);
    nodes[nodes.length] = value;
    const descriptors = safeDescriptors(value);
    const keys = safeKeys(descriptors);
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      const descriptor = key === undefined ? undefined : safeDescriptor(value, key);
      if (descriptor && "value" in descriptor) freeze(descriptor.value);
    }
    safeFreeze(value);
  };
  freeze(result);
  const active = new SafeSet<object>();
  const weights = new SafeWeakMap<object, number>();
  // Escaping can only increase this lower bound; no canonical traversal is needed.
  const finiteJson = (value: unknown): number | undefined => {
    if (value === null) return 4;
    if (typeof value === "string") return value.length + 2;
    if (typeof value === "boolean") return value ? 4 : 5;
    if (typeof value === "number") return safeFinite(value) ? safeString(value).length : undefined;
    if (typeof value !== "object" || safeApply(setHas, active, [value])) return undefined;
    const previousWeight: unknown = safeApply(mapGet, weights, [value]);
    if (typeof previousWeight === "number") return previousWeight;
    const array = safeArray(value);
    if (!array && safePrototype(value) !== plainPrototype && safePrototype(value) !== null)
      return undefined;
    safeApply(setAdd, active, [value]);
    const keys = safeKeys(value);
    let count = 0;
    let weight = 2;
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      if (array && key === "length") continue;
      const descriptor = key === undefined ? undefined : safeDescriptor(value, key);
      if (typeof key !== "string" || !descriptor?.enumerable || !("value" in descriptor))
        return undefined;
      const childWeight = finiteJson(descriptor.value);
      if (childWeight === undefined) return undefined;
      if (array && key !== safeString(count)) return undefined;
      weight += childWeight + (array ? 0 : key.length + 3) + (count > 0 ? 1 : 0);
      count++;
    }
    if (array && count !== safeDescriptor(value, "length")?.value) return undefined;
    safeApply(setDelete, active, [value]);
    safeApply(mapSet, weights, [value, weight]);
    return weight;
  };
  if (finiteJson(result) !== undefined)
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      const weight: unknown = node ? safeApply(mapGet, weights, [node]) : undefined;
      if (node && typeof weight === "number" && weight * 2 >= 1024)
        safeApply(weakAdd, owned, [node]);
    }
  return result;
}

function quoteJsonString(text: string): string {
  // eslint-disable-next-line no-control-regex -- Keep the domain reference's exact escaping fallback.
  return /["\\\x00-\x1f\x7f-\uffff]/.test(text) ? JSON.stringify(text) : '"' + text + '"';
}

/** Exact reference traversal; only successful owned subgraphs may reuse bytes. */
export function canonicalExportJson(input: unknown): string {
  const ancestors = new Set<object>();
  const serialize = (value: unknown, root = false, unordered = false): string => {
    if (value === null) return "null";
    if (typeof value === "string") return quoteJsonString(value);
    if (typeof value === "boolean") return JSON.stringify(value);
    if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
    if (typeof value !== "object") throw new TypeError("Export digest requires finite JSON values");
    if (ancestors.has(value)) throw new TypeError("Export digest cannot contain cycles");
    const context = unordered ? "unordered" : root ? "root" : "nested";
    const eligible = safeApply(weakHas, owned, [value]) && stableIntrinsics();
    const previous: unknown = eligible ? safeApply(mapGet, bytesByNode, [value]) : undefined;
    if (isBytes(previous) && previous[context] !== undefined) return previous[context];
    ancestors.add(value);
    try {
      let bytes: string;
      if (Array.isArray(value)) {
        if (Object.keys(value).length !== value.length)
          throw new TypeError("Export digest requires dense JSON arrays");
        const parts = Array.from(value, (item: unknown) => serialize(item));
        if (unordered) parts.sort();
        bytes = `[${parts.join(",")}]`;
      } else {
        const prototype: unknown = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null)
          throw new TypeError("Export digest requires plain JSON objects");
        const descriptors = Object.getOwnPropertyDescriptors(value);
        if (Reflect.ownKeys(value).length !== Object.keys(value).length)
          throw new TypeError("Export digest cannot discard hidden or symbol properties");
        bytes = `{${Object.keys(descriptors)
          .sort()
          .map((key) => {
            const descriptor = descriptors[key];
            if (!descriptor || !("value" in descriptor))
              throw new TypeError("Export digest cannot evaluate getters");
            return `${quoteJsonString(key)}:${serialize(descriptor.value, false, root && (key === "events" || key === "findings"))}`;
          })
          .join(",")}}`;
      }
      const size = bytes.length * 2;
      if (eligible && size >= 1024 && size <= 256 * 1024 && stableIntrinsics()) {
        if (retainedBytes + size > 8 * 1024 * 1024) {
          bytesByNode = new SafeWeakMap<object, Bytes>();
          retainedBytes = 0;
        }
        const existing: unknown = safeApply(mapGet, bytesByNode, [value]);
        const entry: Bytes = isBytes(existing)
          ? existing
          : {
              root: undefined,
              nested: undefined,
              unordered: undefined,
            };
        if (entry[context] === undefined) {
          entry[context] = bytes;
          retainedBytes += size;
          safeApply(mapSet, bytesByNode, [value, entry]);
        }
      }
      return bytes;
    } finally {
      ancestors.delete(value);
    }
  };
  return serialize(input, true);
}

export function canonicalExportEqual(left: unknown, right: unknown): boolean {
  const primitive = (value: unknown): boolean =>
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value));
  if (primitive(left) && primitive(right)) return left === right;
  return canonicalExportJson(left) === canonicalExportJson(right);
}

/** Hash exactly the canonical bytes; never retain hashes or mutable input bytes. */
export function canonicalExportDigest(input: unknown): string {
  return createHash("sha256").update(canonicalExportJson(input), "utf8").digest("hex");
}
