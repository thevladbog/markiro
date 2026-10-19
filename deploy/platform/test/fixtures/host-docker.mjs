// Static local fake daemon. No evaluated or generated JavaScript.
import { readFile, appendFile, writeFile } from "node:fs/promises";
const [path, serialized] = process.argv.slice(2);
const state = JSON.parse(await readFile(path, "utf8"));
const args = JSON.parse(serialized);
await appendFile(
  `${path}.trace`,
  JSON.stringify({ args, keys: Object.keys(process.env).sort() }) + "\n",
);
const output = (value) => process.stdout.write(JSON.stringify(value));
const select = (name) =>
  state.containers.find((c) => c.Id === name || c.Name === name || c.Name === `/${name}`);
const value = (flag) => args[args.indexOf(flag) + 1];
const remove = (name) => {
  state.containers = state.containers.filter((c) => c !== select(name));
};
let changed = false;
if (args[0] === "info") output(state.info);
else if (args[0] === "container" && args[1] === "ls") {
  if (args.at(-1) === "json")
    output(
      state.containers.map((c) => ({
        Names: c.Name.slice(1),
        Labels: Object.entries(c.Config.Labels)
          .map(([k, v]) => `${k}=${v}`)
          .join(","),
      })),
    );
  else
    process.stdout.write(
      state.containers
        .map((c) => (args.at(-1) === "{{.Names}}" ? c.Name.slice(1) : c.Id))
        .join("\n"),
    );
} else if (args[0] === "volume" && args[1] === "ls")
  output([{ Name: state.volume.Name, Labels: "" }]);
else if (args[1] === "inspect") {
  const source =
    args[0] === "container"
      ? state.containers
      : args[0] === "network"
        ? state.networks
        : args[0] === "volume"
          ? [state.volume]
          : state.images;
  const found = source.find((v) =>
    [v.Id, v.Name, v.Name?.slice(1), ...(v.RepoDigests ?? [])].includes(args[2]),
  );
  if (!found) process.exitCode = 1;
  else output([found]);
} else if (args[0] === "exec") output(state.adminResult);
else if (args[0] === "create") {
  const reference = args.at(-2),
    image = state.images.find((i) => i.RepoDigests.includes(reference));
  const network = state.networks.find((n) => n.Id === value("--network"));
  const mounts = args.flatMap((arg, i) =>
    arg === "--mount" ? [Object.fromEntries(args[i + 1].split(",").map((p) => p.split("=")))] : [],
  );
  const label = value("--label").split("=");
  state.containers.push({
    Id: "7".repeat(64),
    Name: `/${value("--name")}`,
    Image: image.Id,
    Config: {
      Image: reference,
      User: value("--user"),
      Labels: { [label[0]]: label[1] },
      Entrypoint: [value("--entrypoint")],
      Cmd: [args.at(-1)],
    },
    State: { Status: "created", Running: false },
    HostConfig: {
      ReadonlyRootfs: args.includes("--read-only"),
      Privileged: false,
      CapDrop: [value("--cap-drop")],
      SecurityOpt: [value("--security-opt")],
      PortBindings: {},
    },
    NetworkSettings: { Networks: { [network.Name]: { NetworkID: network.Id } } },
    Mounts: mounts.map((m) => ({
      Type: m.type,
      Source: m.source,
      Destination: m.target,
      RW: !Object.hasOwn(m, "readonly"),
    })),
  });
  changed = true;
} else if (args[0] === "start") {
  const c = select(args.at(-1));
  c.State = { Status: "exited", ExitCode: 0, Running: false };
  changed = true;
  output(state.probeResult);
} else if (args[0] === "container" && args[1] === "rm") {
  remove(args.at(-1));
  changed = true;
} else if (args[0] === "container" && args[1] === "stop") {
  select(args.at(-1)).State = { Status: "exited", Running: false };
  changed = true;
} else if (args[0] === "compose") {
  const action = args[7];
  if (action === "stop") {
    for (const c of state.containers)
      if (["api", "edge"].includes(c.Config.Labels["com.docker.compose.service"]))
        c.State = { Status: "exited", Running: false };
  } else if (action === "run") {
    if (state.failureMode === "uncertain-migration")
      state.containers.push(structuredClone(state.templates.migrate));
    else if (state.failureMode === "migration-failure") process.exitCode = 1;
  } else if (action === "up" && args.at(-1) !== "postgres") {
    const service = args.at(-1);
    remove(state.templates[service].Name);
    state.containers.push(structuredClone(state.templates[service]));
  } else if (!["up", "pull"].includes(action)) process.exitCode = 1;
  changed = true;
} else process.exitCode = 1;
if (changed) {
  for (const n of state.networks)
    n.Containers = Object.fromEntries(
      state.containers
        .filter((c) => Object.hasOwn(c.NetworkSettings.Networks, n.Name))
        .map((c) => [c.Id, {}]),
    );
  await writeFile(path, JSON.stringify(state), { mode: 0o600 });
}
