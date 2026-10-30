import {
  createUsHostedWorkerRuntime,
  UsHostedWorkerStartupError,
} from "./deployment/us-hosted-worker-runtime";

function diagnostic(
  code:
    | "us_request_worker_startup_refused"
    | "us_request_worker_storage_unavailable"
    | "us_request_worker_fatal"
    | "us_request_worker_force_exit",
): void {
  process.stderr.write(`${code}\n`);
}

async function main(): Promise<void> {
  if (process.argv.length !== 2) {
    diagnostic("us_request_worker_startup_refused");
    process.exitCode = 1;
    return;
  }
  const startup = createUsHostedWorkerRuntime();
  let stopping: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    stopping ??= (async () => {
      const runtime = await startup;
      const result = await runtime.stop();
      if (result.kind === "force_exit") {
        diagnostic("us_request_worker_force_exit");
        process.exit(1);
      }
    })();
    return stopping;
  };
  const signal = () => {
    void stop().catch(() => {
      diagnostic("us_request_worker_fatal");
      process.exit(1);
    });
  };
  process.on("SIGTERM", signal);
  process.on("SIGINT", signal);
  try {
    const runtime = await startup;
    if (!stopping) await runtime.run();
    await stop();
  } catch (error) {
    if (error instanceof UsHostedWorkerStartupError) {
      diagnostic(error.code);
      process.exitCode = error.code === "us_request_worker_storage_unavailable" ? 2 : 1;
    } else {
      diagnostic("us_request_worker_fatal");
      process.exitCode = 1;
      try {
        await stop();
      } catch {
        process.exit(1);
      }
    }
  } finally {
    process.removeListener("SIGTERM", signal);
    process.removeListener("SIGINT", signal);
  }
}

void main().catch(() => {
  diagnostic("us_request_worker_fatal");
  process.exit(1);
});
