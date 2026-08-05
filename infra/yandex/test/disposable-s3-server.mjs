import { createServer } from "node:http";
import { writeFile } from "node:fs/promises";

const statePath = process.argv[2];
if (!statePath) process.exitCode = 1;

let state;
const server = createServer((request, response) => {
  const url = new URL(request.url, "http://localhost");
  const isState = url.pathname === "/markiro-bootstrap-smoke/bootstrap/terraform.tfstate";

  if (request.method === "PUT" && isState) {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", async () => {
      state = Buffer.concat(chunks).toString("utf8");
      await writeFile(statePath, state);
      response.writeHead(200, { ETag: '"bootstrap-state"' });
      response.end();
    });
    return;
  }

  if (request.method === "GET" && isState) {
    response.writeHead(state === undefined ? 404 : 200, { "content-type": "application/json" });
    response.end(state);
    return;
  }

  if (request.method === "HEAD" && isState) {
    response.writeHead(state === undefined ? 404 : 200);
    response.end();
    return;
  }

  if (request.method === "GET" && url.searchParams.get("list-type") === "2") {
    response.writeHead(200, { "content-type": "application/xml" });
    response.end('<?xml version="1.0" encoding="UTF-8"?><ListBucketResult/>');
    return;
  }

  response.writeHead(200);
  response.end();
});

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address === "string") process.exitCode = 1;
  else process.stdout.write(`${address.port}\n`);
});

server.on("error", (error) => {
  process.stdout.write(`ERROR: ${error.code}\n`);
  process.exit(1);
});

process.on("SIGTERM", () => server.close(() => process.exit(0)));
