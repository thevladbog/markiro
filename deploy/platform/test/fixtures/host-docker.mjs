// Static local fake daemon. No evaluated or generated JavaScript.
import { readFile, appendFile } from "node:fs/promises";
const [path, serialized] = process.argv.slice(2);
const state = JSON.parse(await readFile(path, "utf8"));
const args = JSON.parse(serialized);
await appendFile(
  `${path}.trace`,
  JSON.stringify({ args, keys: Object.keys(process.env).sort() }) + "\n",
);
if (args[0] === "info") process.stdout.write(JSON.stringify(state.info));
else if (args[0] === "container" && args[1] === "ls")
  process.stdout.write(state.containers.map((c) => c.Id).join("\n"));
else if (args[1] === "inspect") {
  const source =
    args[0] === "container"
      ? state.containers
      : args[0] === "network"
        ? state.networks
        : args[0] === "volume"
          ? [state.volume]
          : state.images;
  const found = source.find((v) => [v.Id, v.Name, ...(v.RepoDigests ?? [])].includes(args[2]));
  if (!found) process.exitCode = 1;
  else process.stdout.write(JSON.stringify([found]));
} else process.exitCode = 1;
