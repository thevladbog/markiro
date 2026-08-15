import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const appRoot = path.resolve(import.meta.dirname, "../../../apps/landing");
const astro = path.join(appRoot, "node_modules/.bin/astro");
const environment = { ...process.env, ASTRO_TELEMETRY_DISABLED: "1" };
const distRoot = path.join(appRoot, "dist");

execFileSync(astro, ["build"], { cwd: appRoot, env: environment, stdio: "inherit" });
const files = new Map();
function collect(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) collect(absolute);
    else if (entry.isFile()) {
      const relative = path.relative(distRoot, absolute).split(path.sep).join("/");
      files.set(`/${relative}`, absolute);
      if (relative === "index.html") files.set("/", absolute);
      else if (relative.endsWith("/index.html")) {
        files.set(`/${relative.slice(0, -"index.html".length)}`, absolute);
      }
    }
  }
}
collect(distRoot);

const mediaTypes = new Map([
  [".avif", "image/avif"],
  [".css", "text/css; charset=utf-8"],
  [".docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  [".html", "text/html; charset=utf-8"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".pdf", "application/pdf"],
  [".svg", "image/svg+xml"],
  [".txt", "text/plain; charset=utf-8"],
  [".webmanifest", "application/manifest+json"],
  [".webp", "image/webp"],
  [".xml", "application/xml; charset=utf-8"],
]);
const notFound = files.get("/404.html");
if (notFound === undefined) throw new Error("landing build must contain 404.html");

const server = createServer((request, response) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url ?? "/", "http://127.0.0.1").pathname);
  } catch {
    pathname = "";
  }
  const target = files.get(pathname);
  const file = target ?? notFound;
  response.statusCode = target === undefined ? 404 : 200;
  response.setHeader(
    "Content-Type",
    mediaTypes.get(path.extname(file)) ?? "application/octet-stream",
  );
  response.setHeader("X-Content-Type-Options", "nosniff");
  if (request.method === "HEAD") response.end();
  else response.end(readFileSync(file));
});
server.listen(5473, "127.0.0.1");

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
