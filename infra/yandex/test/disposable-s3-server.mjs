import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";

const statePath = process.argv[2];
if (!statePath) process.exitCode = 1;

const forcedListenerError = process.env.MARKIRO_DISPOSABLE_S3_FORCE_LISTENER_ERROR;

let state;
let stateEtag;
const server = createServer((request, response) => {
  // Terraform's S3 client may otherwise retain the disposable connection after
  // migration. This server is single-purpose, so every response closes it.
  response.setHeader("connection", "close");
  const url = new URL(request.url, "http://localhost");
  const isState = url.pathname === "/markiro-bootstrap-smoke/bootstrap/terraform.tfstate";

  if (request.method === "PUT" && isState) {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", async () => {
      state = Buffer.concat(chunks).toString("utf8");
      stateEtag = `"${createHash("md5").update(state).digest("hex")}"`;
      await writeFile(statePath, state);
      response.writeHead(200, { "content-length": "0", ETag: stateEtag });
      response.end();
    });
    return;
  }

  if (request.method === "GET" && isState) {
    response.writeHead(state === undefined ? 404 : 200, {
      "content-length": String(Buffer.byteLength(state ?? "")),
      "content-type": "application/json",
      ...(stateEtag ? { ETag: stateEtag } : {}),
    });
    response.end(state);
    return;
  }

  if (request.method === "HEAD" && isState) {
    response.writeHead(state === undefined ? 404 : 200, {
      "content-length": String(Buffer.byteLength(state ?? "")),
      ...(stateEtag ? { ETag: stateEtag } : {}),
    });
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

const sockets = new Set();
server.on("connection", (socket) => {
  sockets.add(socket);
  socket.once("close", () => sockets.delete(socket));
});

if (forcedListenerError) {
  process.stdout.write(`ERROR: ${forcedListenerError}\n`);
  process.exit(1);
} else {
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (!address || typeof address === "string") process.exitCode = 1;
    else process.stdout.write(`${address.port}\n`);
  });
}

server.on("error", (error) => {
  process.stdout.write(`ERROR: ${error.code}\n`);
  process.exit(1);
});

process.on("SIGTERM", () => {
  for (const socket of sockets) socket.destroy();
  server.closeAllConnections?.();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 250).unref();
});
