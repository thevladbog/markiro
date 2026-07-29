import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["test/**/*.test.ts"],
    // Kept deliberately, but NOT for the reason this comment used to give.
    // The "stray sign-up 404s / Parse Error: Expected HTTP/" flake was never
    // about parallelism: it was supertest binding a fresh ephemeral port per
    // request and silently colliding with an unrelated local process. It
    // reproduces on a single file in a single process, and it is fixed at the
    // source -- see `test/support/listen-loopback.ts` for the full write-up.
    //
    // What is genuinely shared is Postgres, and not every row is tenant-scoped:
    // `kiosk_pair_attempts` is keyed on `(source, window)` alone, so every run
    // against that instance shares the `127.0.0.1` and `*` buckets for the
    // current 15-minute window. Today only `kiosk-pairing.e2e.test.ts` writes
    // those, so serial execution buys nothing measurable here -- 20 of 21 full
    // parallel runs passed, and the one failure traced to a concurrent run in
    // another worktree, which this setting cannot prevent either way. It stays
    // as cheap insurance for the next file that reaches for a global row.
    // Dropping it makes the suite ~5x faster (71s -> 14s); do that as its own
    // deliberate, separately-verified change rather than as a side effect.
    fileParallelism: false,
  },
});
