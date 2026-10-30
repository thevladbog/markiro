import "reflect-metadata";
import { createUsHostedApplication } from "./deployment/us-hosted-bootstrap";

function diagnostic(code: "us_hosted_api_startup_refused" | "us_hosted_api_shutdown_failed"): void {
  process.stderr.write(`${code}\n`);
}
async function main(): Promise<void> {
  if (process.argv.length !== 2) {
    diagnostic("us_hosted_api_startup_refused");
    process.exitCode = 1;
    return;
  }
  let stopRequested = false;
  const startup = (async () => {
    const app = await createUsHostedApplication();
    try {
      if (!stopRequested) await app.listen(8443, "0.0.0.0");
      return app;
    } catch {
      try {
        await app.close();
      } catch {
        /* Keep startup diagnostics fixed. */
      }
      throw new Error("us_hosted_api_startup_refused");
    }
  })();
  let stopping: Promise<void> | undefined;
  let finishLifetime = () => {};
  let rejectLifetime: (error: Error) => void = () => {};
  const lifetime = new Promise<void>((resolve, reject) => {
    finishLifetime = resolve;
    rejectLifetime = reject;
  });
  void lifetime.catch(() => {});
  const stop = (): Promise<void> => {
    stopping ??= (async () => {
      const app = await startup;
      await app.close();
    })();
    return stopping;
  };
  const signal = () => {
    stopRequested = true;
    void stop().then(finishLifetime, () =>
      rejectLifetime(new Error("us_hosted_api_shutdown_failed")),
    );
  };
  process.on("SIGTERM", signal);
  process.on("SIGINT", signal);
  let started = false;
  try {
    await startup;
    started = true;
    if (stopping) await stopping;
    else await lifetime;
  } catch {
    diagnostic(started ? "us_hosted_api_shutdown_failed" : "us_hosted_api_startup_refused");
    process.exitCode = 1;
    try {
      await stop();
    } catch {
      process.exit(1);
    }
  } finally {
    process.removeListener("SIGTERM", signal);
    process.removeListener("SIGINT", signal);
  }
}
void main().catch(() => {
  diagnostic("us_hosted_api_startup_refused");
  process.exit(1);
});
