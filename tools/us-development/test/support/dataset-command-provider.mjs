import http from "node:http";
import { once } from "node:events";

const trailerPairs = (raw) =>
  Array.from({ length: raw.length / 2 }, (_, i) => [raw[i * 2], raw[i * 2 + 1]]);

/** Test-only streaming observer. It never manufactures a provider response. */
export async function startDatasetProviderObservation({ port, upstreamPort }) {
  for (const value of [port, upstreamPort])
    if (!Number.isInteger(value) || value < 1 || value > 65535)
      throw new Error("dataset_provider_port_invalid");
  if (port === upstreamPort) throw new Error("dataset_provider_port_invalid");
  const counters = { reads: 0, mutations: 0, failures: 0, active: 0 };
  const work = new Set();
  const server = http.createServer((request, response) => {
    counters[/^(GET|HEAD)$/.test(request.method) ? "reads" : "mutations"]++;
    counters.active++;
    let finish;
    const settled = new Promise((resolve) => {
      finish = resolve;
    });
    work.add(settled);
    let failed = false,
      outgoingClosed = false,
      downstreamClosed = false;
    const fail = () => {
      if (!failed) {
        failed = true;
        counters.failures++;
      }
    };
    const complete = () => {
      if (!outgoingClosed || !downstreamClosed) return;
      counters.active--;
      work.delete(settled);
      finish();
    };
    const outgoing = http.request(
      {
        hostname: "127.0.0.1",
        port: upstreamPort,
        method: request.method,
        path: request.url,
        headers: request.rawHeaders,
        agent: false,
      },
      (upstream) => {
        if (upstream.statusCode >= 400) fail();
        // Each leg owns its connection lifetime; upstream hints cannot describe this socket.
        const headers = upstream.rawHeaders.filter(
          (_value, index, raw) =>
            !["connection", "keep-alive"].includes(raw[index - (index % 2)].toLowerCase()),
        );
        response.writeHead(upstream.statusCode, upstream.statusMessage, headers);
        upstream.on("error", () => {
          fail();
          response.destroy();
        });
        upstream.on("aborted", () => {
          fail();
          response.destroy();
        });
        upstream.on("end", () => response.addTrailers(trailerPairs(upstream.rawTrailers)));
        upstream.pipe(response);
      },
    );
    outgoing.on("error", () => {
      fail();
      response.destroy();
    });
    outgoing.on("close", () => {
      outgoingClosed = true;
      complete();
    });
    request.on("aborted", () => {
      fail();
      outgoing.destroy();
    });
    request.on("error", () => {
      fail();
      outgoing.destroy();
    });
    request.on("end", () => outgoing.addTrailers(trailerPairs(request.rawTrailers)));
    response.on("error", () => {
      fail();
      outgoing.destroy();
    });
    response.on("close", () => {
      if (!response.writableFinished) {
        fail();
        outgoing.destroy();
      }
      downstreamClosed = true;
      complete();
    });
    request.pipe(outgoing);
  });
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  let closing;
  return {
    counts: () => ({ ...counters }),
    close() {
      closing ??= (async () => {
        const stopped = new Promise((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
        while (work.size) await Promise.all([...work]);
        server.closeIdleConnections();
        await stopped;
      })();
      return closing;
    },
  };
}
