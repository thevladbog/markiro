import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { canonical } from "../backup/schemas.mjs";
/** Daemon-shaped test double: only the injectable process boundary is replaced. */
export function fakeDocker({
  root,
  operationId,
  image,
  failDump = false,
  failCleanup = false,
  restored,
}) {
  const containers = new Map(),
    volumes = new Set(),
    calls = [];
  const response = (value) => ({ stdout: Buffer.from(value), stderr: Buffer.alloc(0) });
  const run = async ({ args, env }) => {
    calls.push({ args, env });
    const a = args.slice(2);
    if (a[0] === "image")
      return response(
        canonical([
          {
            Id: image,
            Os: "linux",
            Architecture: "arm64",
            Config: { Volumes: { "/var/lib/postgresql/data": {} } },
          },
        ]),
      );
    if (a[0] === "network" && a[1] === "inspect") return response(canonical([{ Internal: true }]));
    if (a[0] === "volume" && a[1] === "create") {
      volumes.add(a.at(-1));
      return response(a.at(-1));
    }
    if (a[0] === "create") {
      const name = a[a.indexOf("--name") + 1],
        network = a[a.indexOf("--network") + 1],
        user = a[a.indexOf("--user") + 1],
        mounts = [];
      for (let i = 0; i < a.length; i++)
        if (a[i] === "--mount") {
          const fields = Object.fromEntries(a[i + 1].split(",").map((x) => x.split("=")));
          mounts.push({
            Type: "volume",
            Name: fields.source,
            Destination: fields.target,
            RW: !Object.hasOwn(fields, "readonly"),
          });
        }
      containers.set(name, {
        Config: { User: user, Labels: { "markiro.backup-operation": operationId } },
        HostConfig: { NetworkMode: network, PortBindings: {}, ReadonlyRootfs: true },
        NetworkSettings: { Networks: { [network]: {} } },
        Mounts: mounts,
        State: { Status: "exited", ExitCode: 0 },
      });
      return response(name);
    }
    if (a[0] === "inspect")
      return response(
        a.includes("--format")
          ? canonical(containers.get(a.at(-1)).State)
          : canonical([containers.get(a.at(-1))]),
      );
    if (a[1] === "ls")
      return response([...(a[0] === "volume" ? volumes : containers.keys())].join("\n"));
    if (a[1] === "inspect")
      return response(
        canonical([
          { Labels: { "markiro.backup-operation": operationId }, ...(containers.get(a[2]) ?? {}) },
        ]),
      );
    if (a[1] === "rm") {
      const name = a.at(-1);
      if (failCleanup && name.endsWith("worker")) throw new Error("controlled cleanup failure");
      (a[0] === "volume" ? volumes : containers).delete(name);
      return response(name);
    }
    if (a[0] === "start") {
      if (failDump && a.includes("--attach")) throw new Error("controlled dump failure");
      return response("");
    }
    if (a[0] === "cp" && a[1].includes("/work/out/failure.json")) throw new Error("no diagnostics");
    if (a[0] === "cp" && a[1].includes("/work/out/.")) {
      if (restored)
        await writeFile(join(a[2], "restored.json"), canonical(restored), { mode: 0o600 });
      return response("");
    }
    if (a[0] === "exec" || a[0] === "cp") return response("");
    throw new Error("Unexpected fake Docker operation");
  };
  return { run, calls, containers, volumes, root };
}
