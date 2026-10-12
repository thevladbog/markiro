export function createUsRequestResourceTestScope() {
  const work = new Set<Promise<void>>();
  const phase =
    <Args extends unknown[]>(body: (...args: Args) => Promise<void>) =>
    (...args: Args): Promise<void> => {
      const pending = Promise.resolve().then(() => body(...args));
      work.add(pending);
      void pending.then(
        () => work.delete(pending),
        () => work.delete(pending),
      );
      return pending;
    };

  async function drain() {
    while (work.size) await Promise.allSettled([...work]);
  }

  function assertIdle() {
    if (work.size) throw new Error("us_request_resource_prior_work_live");
  }

  return {
    phase,
    drain,
    assertIdle,
  };
}
