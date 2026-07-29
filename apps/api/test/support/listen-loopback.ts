import type { INestApplication } from "@nestjs/common";
import type { Server } from "node:http";

/**
 * Binds the app's HTTP server ONCE, on the exact loopback address supertest
 * dials, and resolves when it is listening. Call it in `beforeAll` directly
 * after `await app.init()`.
 *
 * `init()` alone never makes the server listen, and supertest compensates by
 * binding a fresh ephemeral port for EVERY request -- `Test.serverAddress`
 * calls `app.listen(0)`, then `Test.end()` calls `server.close()` again. That
 * is 200-370 binds per run of a single e2e file.
 *
 * Which is not merely wasteful, it is unsound. `listen(0)` with no host binds
 * the `::` wildcard, and Node sets SO_REUSEADDR on listening sockets, so the
 * bind silently SUCCEEDS on a port that some unrelated local process already
 * holds on `127.0.0.1`. The kernel then routes supertest's connection to that
 * more specific socket, and the HTTP/1.1 client ends up parsing a stranger's
 * protocol. The symptoms are intermittent and masquerade as application bugs:
 * `Parse Error: Expected HTTP/, RTSP/ or ICE/`, stray 404s on `/api/auth/*`,
 * and ETIMEDOUT / "Hook timed out in 10000ms" out of `beforeEach`. Caught in
 * the act by dumping the bytes the client rejected -- a Node HTTP/2 SETTINGS
 * frame -- and matching the port against `lsof`: a browser was holding the
 * very port the app had just bound.
 *
 * Passing `127.0.0.1` explicitly makes the kernel pick a port that is free on
 * that exact address, so the collision cannot arise at all; binding once up
 * front means the draw happens once per file instead of once per request.
 *
 * `app.close()` in `afterAll` closes this listener, so no extra teardown is
 * needed.
 */
export async function listenOnLoopback(app: INestApplication): Promise<void> {
  const server = app.getHttpServer() as Server;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}
