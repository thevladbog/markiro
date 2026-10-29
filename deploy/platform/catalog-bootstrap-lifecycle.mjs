function rejected(uncertain = false) {
  const error = new Error(
    "Catalog bootstrap failed; preserve receipts and reconcile before another operation.",
  );
  error.code = "ERR_CATALOG_BOOTSTRAP";
  if (uncertain) error.durabilityUncertain = true;
  return error;
}
/** Trusted host adapter supplies fresh GH/physical guards; caller holds the canonical deployment lock.
 * This lifecycle neither enables writers nor edits the accepted deployment journal.
 */
export async function runReadBootstrapLifecycle(io) {
  await io.authorize();
  await io.observe(false);
  // Exclusive, durable marker makes this operation one-shot, including interrupted attempts.
  await io.receipt("started");
  try {
    await io.prepareWorker();
    await io.authorize();
    await io.observe(false);
  } catch (cause) {
    try {
      const cleanup = await io.abortPreparedWorker();
      if (cleanup?.terminationConfirmed !== true) throw rejected(true);
      await io.observe(false);
      await io.receipt("preflight-aborted");
    } catch {
      throw rejected(true);
    }
    throw cause;
  }
  let uncertain = true;
  try {
    await io.stopApi();
    await io.observe(true);
    await io.receipt("api-stopped");
    const worker = await io.runWorker();
    if (worker?.terminationConfirmed !== true) throw rejected(true);
    await io.observe(true);
    await io.receipt("worker-exited");
    // No replacement, Compose or migration: resume the exact same accepted API container.
    await io.startApi();
    await io.observe(false);
    await io.receipt("api-resumed");
    uncertain = false;
    if (
      worker.exitCode !== 0 ||
      worker.result?.revision !== "1" ||
      worker.result?.readable !== true ||
      worker.result?.writersMayEnable !== false
    )
      throw rejected();
    await io.receipt("completed");
    return worker.result;
  } catch (cause) {
    // An unconfirmed stop, live daemon workload, changed source or failed resume cannot release the shared lock.
    if (uncertain) throw rejected(true);
    throw cause;
  }
}
