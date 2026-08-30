/**
 * A promise a test releases by hand.
 *
 * Used to hold one `SqlExecutor.run` open so a screen's in-flight write can be
 * observed mid-flight — that is the only way to assert what a dialog does while
 * its write is pending. The statement each test gates on is deliberately its
 * own: the check-mode screen writes the terminal date, the repack screen writes
 * the repack journal, so the gates are not interchangeable and stay local.
 */
export function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
