import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { createLocalHttpsRequest } from "../local-https-request.mjs";

const run = promisify(execFile);
test("local smoke transport validates its CA and requested hostname", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "markiro-local-tls-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const openssl = (...args) => run("openssl", args, { cwd: directory, timeout: 10000 });
  // Fresh keys stay inside the private temporary directory; no static private fixtures.
  for (const name of ["trusted", "untrusted"]) {
    await openssl(
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-keyout",
      `${name}.key`,
      "-out",
      `${name}.crt`,
      "-subj",
      `/CN=${name} test CA`,
    );
  }
  await openssl(
    "req",
    "-new",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    "server.key",
    "-out",
    "server.csr",
    "-subj",
    "/CN=saas-admin.localhost",
  );
  await writeFile(
    join(directory, "server.ext"),
    "subjectAltName=DNS:saas-admin.localhost\nextendedKeyUsage=serverAuth\nbasicConstraints=CA:FALSE\n",
  );
  await openssl(
    "x509",
    "-req",
    "-in",
    "server.csr",
    "-CA",
    "trusted.crt",
    "-CAkey",
    "trusted.key",
    "-CAcreateserial",
    "-out",
    "server.crt",
    "-days",
    "1",
    "-extfile",
    "server.ext",
  );
  const ca = await readFile(join(directory, "trusted.crt"));
  const server = createServer(
    {
      key: await readFile(join(directory, "server.key")),
      cert: await readFile(join(directory, "server.crt")),
    },
    (req, res) => {
      res.writeHead(201, { "content-type": "application/json", "x-test": "loopback" });
      res.end(
        JSON.stringify({
          host: req.headers.host,
          method: req.method,
          path: req.url,
          accept: req.headers.accept,
        }),
      );
    },
  );
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(
    () =>
      new Promise((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  const port = server.address().port;
  await t.test(
    "trusted CA and matching host preserve HTTP response and request contracts",
    async () => {
      const request = createLocalHttpsRequest({ port, ca });
      const response = await request("saas-admin.localhost", "/contract", {
        method: "POST",
        headers: { Accept: "application/json" },
      });
      assert.equal(response.status, 201);
      assert.equal(response.headers.get("x-test"), "loopback");
      assert.deepEqual(await response.json(), {
        host: "saas-admin.localhost",
        method: "POST",
        path: "/contract",
        accept: "application/json",
      });
    },
  );
  await t.test("an unrelated CA cannot authorize the server", async () => {
    const request = createLocalHttpsRequest({
      port,
      ca: await readFile(join(directory, "untrusted.crt")),
    });
    await assert.rejects(request("saas-admin.localhost", "/"), {
      code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    });
  });
  await t.test("a trusted certificate cannot authorize the wrong hostname", async () => {
    const request = createLocalHttpsRequest({ port, ca });
    await assert.rejects(request("wrong.localhost", "/"), { code: "ERR_TLS_CERT_ALTNAME_INVALID" });
  });
});
