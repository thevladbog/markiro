import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";

export function createLocalHttpsRequest({ port: httpsPort, ca }) {
  return function request(host, path, init = {}) {
    return new Promise((resolveResponse, reject) => {
      const req = httpsRequest(
        {
          hostname: "127.0.0.1",
          port: httpsPort,
          servername: host,
          path,
          method: init.method ?? "GET",
          headers: { Host: host, ...init.headers },
          ca,
          rejectUnauthorized: true,
          timeout: 10000,
        },
        (incoming) =>
          resolveResponse(
            new Response(Readable.toWeb(incoming), {
              status: incoming.statusCode,
              headers: incoming.headers,
            }),
          ),
      );
      req.on("error", reject);
      req.on("timeout", () => req.destroy(new Error("local smoke timeout")));
      req.end();
    });
  };
}
