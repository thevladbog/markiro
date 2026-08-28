/**
 * A seeded `pickup_orders.order_no` that cannot collide with anything.
 *
 * Fixtures that insert orders directly (rather than through the API) still
 * have to satisfy `pickup_orders_tenant_order_no_uq`, and they used to fill
 * the column with `ORD-26-${randomUUID().slice(0, 4)}`. Four hex characters
 * is a space of 65 536 values, drawn 14 times into one tenant by
 * `pickup-orders.e2e.test.ts` alone -- a birthday collision roughly once in
 * every 700 runs, surfacing as `duplicate key value violates unique
 * constraint "pickup_orders_tenant_order_no_uq"` in whichever test happened
 * to draw second. That is what made the suite look flaky under load: nothing
 * about the run was concurrent, the fixture was simply gambling.
 *
 * Two properties, both structural rather than probabilistic:
 *
 * 1. A module-level counter, so two fixtures never draw the same value. The
 *    counter is per worker process, and Vitest isolates the module registry
 *    per test file, so each file starts at 1 -- fine, because the constraint
 *    is scoped to `(tenant_id, order_no)` and every file seeds its own tenant.
 * 2. A `T` marker in the sequence position. `formatOrderNo`
 *    (`src/pickup/order-number.ts`) emits `ORD-YY-NNNN` with a zero-padded
 *    DIGIT sequence starting at 1, so an API-created order in the same tenant
 *    is `ORD-26-0001`, `ORD-26-0002`, ... A fixture that drew "0001" used to
 *    collide with it; `T` puts fixtures in a namespace the generator cannot
 *    reach.
 *
 * The year stays hard-coded at `26` exactly as the literals it replaces did:
 * these numbers are opaque identifiers to every consumer (nothing parses
 * `order_no` -- it is looked up as a string and forwarded to 1С as one), so
 * the fixture never needs to agree with the real clock.
 */
let counter = 0;

export function fixtureOrderNo(): string {
  counter += 1;
  return `ORD-26-T${counter}`;
}
