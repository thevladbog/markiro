import { createHash } from "node:crypto";
if (process.argv[2] === "ignore") setInterval(() => {}, 1000);
else if (process.argv[2] === "early") process.exit(0);
else {
  const hash = createHash("sha256");
  for await (const chunk of process.stdin) hash.update(chunk);
  process.stdout.write(hash.digest("hex"));
}
