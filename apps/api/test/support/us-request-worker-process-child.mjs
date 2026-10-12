// Test-only trusted composition. The production executable has no IPC or overrides.
import { createRequire } from "node:module";
import { Readable } from "node:stream";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { createDb } = require("@markiro/db");
let sequence = 0;
const pending = new Map();
let releaseCommit;
const safeSend = (value) => {
  if (process.connected) process.send(value);
};
process.on("message", (value) => {
  if (value?.type === "commit_release") {
    releaseCommit?.();
    return;
  }
  if (value?.type !== "storage_reply" || !Number.isSafeInteger(value.id)) return;
  const request = pending.get(value.id);
  if (!request) return;
  pending.delete(value.id);
  request.finish();
  if (value.error) {
    request.reject(
      Object.assign(new Error("synthetic provider category"), {
        name: value.error,
        $metadata: { httpStatusCode: value.error === "NoSuchKey" ? 404 : 412 },
      }),
    );
    return;
  }
  if (value.bytes !== undefined) {
    if (typeof value.bytes !== "string" || value.bytes.length > 42_666_668) {
      request.reject(new Error("Invalid fixture reply"));
      return;
    }
    const bytes = Buffer.from(value.bytes, "base64");
    if (bytes.length !== value.length || bytes.toString("base64") !== value.bytes) {
      request.reject(new Error("Invalid fixture reply"));
      return;
    }
    request.resolve({
      Body: Readable.from([bytes]),
      ContentLength: bytes.length,
      ContentType: value.contentType,
    });
  } else
    request.resolve(
      value.length === undefined
        ? {}
        : { ContentLength: value.length, ContentType: value.contentType },
    );
});
const transport = {
  send(command, { abortSignal }) {
    return new Promise((resolve, reject) => {
      const kinds = {
        PutObjectCommand: "put",
        GetObjectCommand: "get",
        HeadObjectCommand: "head",
        DeleteObjectCommand: "delete",
      };
      const kind = kinds[command.constructor.name];
      const {
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        IfNoneMatch: conditional,
        ACL: acl,
      } = command.input;
      if (
        !kind ||
        acl !== undefined ||
        pending.size >= 8 ||
        abortSignal.aborted ||
        (kind === "put" &&
          (!(body instanceof Uint8Array) || body.length > 32_000_000 || conditional !== "*"))
      ) {
        reject(new Error("Invalid fixture request"));
        return;
      }
      const id = ++sequence;
      const abort = () => {
        pending.delete(id);
        reject(new Error("Synthetic operation aborted"));
      };
      pending.set(id, {
        resolve,
        reject,
        finish: () => abortSignal.removeEventListener("abort", abort),
      });
      abortSignal.addEventListener("abort", abort, { once: true });
      safeSend({
        type: "storage",
        id,
        kind,
        bucket,
        key,
        ...(kind === "put"
          ? { bytes: Buffer.from(body).toString("base64"), contentType, conditional }
          : {}),
      });
    });
  },
};
process.on("disconnect", () => process.exit(1));
process.once("message", async (config) => {
  try {
    if (config?.type !== "initialize") throw new Error("Invalid fixture initialization");
    const url = new URL(config.ownedUrl);
    if (
      url.protocol !== "postgres:" ||
      url.hostname !== "127.0.0.1" ||
      url.port !== "55432" ||
      url.username !== "markiro_us" ||
      url.password !== "markiro-us-development-only" ||
      url.pathname !== `/${config.databaseName}` ||
      !/^markiro_us_profile_[a-f0-9_]+$/.test(config.databaseName) ||
      url.search ||
      url.hash
    )
      throw new Error("Fixture database scope refused");
    const compiled = createRequire(join(config.roots.trees.api, "main.us-request-worker.js"));
    const { createUsRequestWorkerRuntime } = compiled("./deployment/us-request-worker-runtime.js");
    const { loadUsRequestBuildDescriptor } = compiled(
      "./deployment/us-request-build-descriptor.js",
    );
    if (config.mode === "cli_probe") {
      // A checked clean default-root snapshot; the probe cannot enter runtime/DB.
      await loadUsRequestBuildDescriptor(config.raw);
      safeSend({ type: "descriptor_checked" });
      const module = compiled("./deployment/us-request-worker-runtime.js");
      module.createUsRequestWorkerRuntime = async () => {
        safeSend({ type: "runtime_boundary_reached" });
        throw new module.UsRequestWorkerStartupError("us_request_worker_startup_refused");
      };
      process.env = config.raw;
      process.argv = [
        process.execPath,
        join(config.roots.trees.api, "main.us-request-worker.js"),
        ...config.arguments,
      ];
      process.removeAllListeners("disconnect");
      compiled("./main.us-request-worker.js");
      setImmediate(() => {
        if (process.connected) process.disconnect();
      });
      return;
    }
    let lost = false;
    const connect = (configured, options) => {
      if (
        configured !==
        "postgres://markiro_us:markiro-us-development-only@127.0.0.1:55432/markiro_us_dev"
      )
        throw new Error("Synthetic raw policy changed");
      const connection = createDb(url.toString(), options);
      // Fault only the driver response, after forwarding the real publication COMMIT.
      const connectClient = connection.pool.connect.bind(connection.pool);
      connection.pool.connect = async (...args) => {
        // pool.query uses callback acquisition; leave that driver path intact.
        if (typeof args[0] === "function") return connectClient(...args);
        const client = await connectClient();
        const query = client.query.bind(client);
        let publishing = false;
        client.query = async (...args) => {
          const text = typeof args[0] === "string" ? args[0] : args[0]?.text;
          // Drizzle passes queryConfig and the parameter array separately.
          const values = Array.isArray(args[1]) ? args[1] : args[0]?.values;
          if (text?.toLowerCase().startsWith("begin")) publishing = false;
          if (Array.isArray(values) && values.includes("traceability.request.worker.published"))
            publishing = true;
          const result = await query(...args);
          if (
            text?.toLowerCase() === "commit" &&
            publishing &&
            !lost &&
            config.commit !== "normal"
          ) {
            lost = true;
            safeSend({ type: "commit" });
            if (config.commit === "hold_reply")
              await new Promise((done) => {
                releaseCommit = done;
              });
            else throw Object.assign(new Error("Synthetic COMMIT reply loss"), { code: "08007" });
          }
          return result;
        };
        return client;
      };
      return connection;
    };
    const runtime = await createUsRequestWorkerRuntime(config.raw, {
      connect,
      loadBuild: (raw) => loadUsRequestBuildDescriptor(raw, config.roots),
      packageTransport: transport,
      planTransport: transport,
    });
    let stopping;
    const stop = () => {
      stopping ??= runtime.stop().then((result) => {
        if (result.kind === "force_exit") {
          process.stderr.write("us_request_worker_force_exit\n");
          process.exit(1);
        }
      });
      return stopping;
    };
    const signal = () => {
      void stop().catch(() => process.exit(1));
    };
    process.on("SIGTERM", signal);
    process.on("SIGINT", signal);
    safeSend({ type: "ready" });
    await runtime.run();
    await stop();
    process.removeListener("SIGTERM", signal);
    process.removeListener("SIGINT", signal);
    process.removeAllListeners("disconnect");
    process.disconnect();
    process.exit(0);
  } catch {
    process.stderr.write("synthetic_worker_child_refused\n");
    process.exit(1);
  }
});
