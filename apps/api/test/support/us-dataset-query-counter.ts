import type { createDb } from "@markiro/db";
type DriverPool = ReturnType<typeof createDb>["pool"];
type DriverClient = NonNullable<Parameters<Parameters<DriverPool["connect"]>[0]>[1]>;

/** Count actual driver dispatches, including BEGIN/COMMIT, without changing arguments/results. */
export async function countActualQueries<T>(
  pool: ReturnType<typeof createDb>["pool"],
  run: () => Promise<T>,
) {
  let count = 0;
  const restore = new Map<object, () => void>();
  // acquire fires for reused clients too; install once so repeated acquisition cannot inflate counts.
  pool.on("acquire", instrument);
  function instrument(client: DriverClient) {
    if (restore.has(client)) return;
    const original = client.query;
    client.query = new Proxy(original, {
      apply(target, receiver, args) {
        count++;
        return Reflect.apply(target, receiver, args);
      },
    });
    restore.set(client, () => {
      client.query = original;
    });
  }
  const started = performance.now();
  try {
    const value = await run();
    return { value, count, durationMs: performance.now() - started };
  } finally {
    pool.off("acquire", instrument);
    for (const reset of restore.values()) reset();
  }
}
