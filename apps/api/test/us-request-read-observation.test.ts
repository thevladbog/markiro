import { ClientRequest, IncomingMessage, createServer } from "node:http";
import type { ServerResponse } from "node:http";
import { once } from "node:events";
import { channel } from "node:diagnostics_channel";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { expect, it } from "vitest";
import { createUsRequestReadObservation } from "../src/modules/traceability/requests/us-request-read-observation";

// These are real SDK requests. Losing request association must lose the stronger
// diagnostic, without changing the original error or issuing a retry.
for (const warm of [false, true]) {
  it(`observes a real ${warm ? "reused" : "new"} request reset before response`, async () => {
    let requests = 0;
    const server = createServer((request, response) => {
      requests++;
      if (warm && requests === 1) {
        response.writeHead(200, { "Content-Length": "2" });
        response.end("ok");
      } else request.socket.destroy();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected owned TCP listener");
    const handler = new NodeHttpHandler({
      connectionTimeout: 1000,
      requestTimeout: 1000,
      socketTimeout: 1000,
      throwOnRequestTimeout: true,
    });
    const client = new S3Client({
      endpoint: `http://127.0.0.1:${address.port}`,
      region: "us-east-1",
      credentials: { accessKeyId: "synthetic", secretAccessKey: "synthetic" },
      forcePathStyle: true,
      maxAttempts: 1,
      requestHandler: handler,
    });
    const observation = createUsRequestReadObservation(handler);
    const command = () =>
      client.send(new GetObjectCommand({ Bucket: "synthetic", Key: "fixture" }));
    const token = {};
    try {
      if (warm) {
        const response = await command();
        expect(await response.Body?.transformToString()).toBe("ok");
      }
      const error: unknown = await observation.run(token, command).catch((value: unknown) => value);
      expect(error).toMatchObject({ code: "ECONNRESET" });
      expect(observation.take(token, error)).toBe(
        warm ? "reused-before-response" : "new-before-response",
      );
      expect(observation.take(token, error)).toBeUndefined();
      expect(requests).toBe(warm ? 2 : 1);
    } finally {
      observation.finish(token);
      observation.destroy();
      client.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
}

it("keeps overlapping real requests isolated and rejects a rewrapped error", async () => {
  let requests = 0;
  const pending: Array<() => void> = [];
  const server = createServer((request) => {
    requests++;
    pending.push(() => request.socket.destroy());
    if (pending.length === 2) for (const close of pending) close();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected owned TCP listener");
  const handler = new NodeHttpHandler({ connectionTimeout: 1000, socketTimeout: 1000 });
  const client = new S3Client({
    endpoint: `http://127.0.0.1:${address.port}`,
    region: "us-east-1",
    credentials: { accessKeyId: "synthetic", secretAccessKey: "synthetic" },
    forcePathStyle: true,
    maxAttempts: 1,
    requestHandler: handler,
  });
  const observation = createUsRequestReadObservation(handler);
  const first = {},
    second = {};
  try {
    const call = (token: object) =>
      observation
        .run(token, () =>
          client.send(new GetObjectCommand({ Bucket: "synthetic", Key: "fixture" })),
        )
        .catch((error: unknown) => error);
    const [a, b] = await Promise.all([call(first), call(second)]);
    expect(a).toMatchObject({ code: "ECONNRESET" });
    expect(b).toMatchObject({ code: "ECONNRESET" });
    expect(a).not.toBe(b);
    expect(observation.take(first, b)).toBeUndefined();
    expect(observation.take(second, a)).toBeUndefined();
    expect(observation.take(first, new Error("rewrapped"))).toBeUndefined();
    expect(observation.take(first, a)).toBe("new-before-response");
    observation.finish(first);
    expect(observation.take(first, a)).toBeUndefined();
    observation.destroy();
    expect(observation.take(second, b)).toBeUndefined();
    expect(requests).toBe(2);
  } finally {
    observation.finish(first);
    observation.finish(second);
    observation.destroy();
    client.destroy();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

for (const mode of ["accessor", "duplicate", "destroyed"] as const) {
  it(`degrades ${mode} observation without changing the actual request`, async () => {
    let requests = 0,
      getterCalls = 0;
    const server = createServer((request) => {
      requests++;
      request.socket.destroy();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected owned TCP listener");
    const handler = new NodeHttpHandler({ connectionTimeout: 1000, socketTimeout: 1000 });
    const client = new S3Client({
      endpoint: `http://127.0.0.1:${address.port}`,
      region: "us-east-1",
      credentials: { accessKeyId: "synthetic", secretAccessKey: "synthetic" },
      forcePathStyle: true,
      maxAttempts: 1,
      requestHandler: handler,
    });
    const observation = createUsRequestReadObservation(handler);
    const created = channel("http.client.request.created");
    let duplicated = false;
    const duplicate = (message: unknown) => {
      if (!duplicated) {
        duplicated = true;
        created.publish(message);
      }
    };
    if (mode === "duplicate") created.subscribe(duplicate);
    if (mode === "destroyed") observation.destroy();
    const token = {};
    let original: unknown;
    try {
      const error: unknown = await observation
        .run(token, async () => {
          if (mode === "accessor")
            created.publish({
              get request() {
                getterCalls++;
                throw new Error("private");
              },
            });
          try {
            return await client.send(new GetObjectCommand({ Bucket: "synthetic", Key: "fixture" }));
          } catch (value) {
            original = value;
            throw value;
          }
        })
        .catch((value: unknown) => value);
      expect(error).toBe(original);
      expect(error).toMatchObject({ code: "ECONNRESET" });
      expect(observation.take(token, error)).toBeUndefined();
      expect(getterCalls).toBe(0);
      expect(requests).toBe(1);
    } finally {
      created.unsubscribe(duplicate);
      observation.finish(token);
      observation.destroy();
      client.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
}

it("freezes response state at the first observed error", async () => {
  let reply: (() => void) | undefined;
  let received: (() => void) | undefined;
  const incoming = new Promise<void>((resolve) => {
    received = resolve;
  });
  const server = createServer((_request, response) => {
    reply = () => {
      response.writeHead(200, { "Content-Length": "2" });
      response.end("ok");
    };
    received?.();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected owned TCP listener");
  const handler = new NodeHttpHandler({ connectionTimeout: 1000, socketTimeout: 1000 });
  const client = new S3Client({
    endpoint: `http://127.0.0.1:${address.port}`,
    region: "us-east-1",
    credentials: { accessKeyId: "synthetic", secretAccessKey: "synthetic" },
    forcePathStyle: true,
    maxAttempts: 1,
    requestHandler: handler,
  });
  const observation = createUsRequestReadObservation(handler);
  const created = channel("http.client.request.created");
  let native: ClientRequest | undefined;
  const capture = (message: unknown) => {
    const descriptor = Object.getOwnPropertyDescriptor(message, "request");
    const value: unknown = descriptor && "value" in descriptor ? descriptor.value : undefined;
    if (value instanceof ClientRequest) native = value;
  };
  created.subscribe(capture);
  const original = Object.assign(new Error("synthetic ordered event"), { code: "ECONNRESET" });
  const token = {};
  try {
    const error = await observation.run(token, async () => {
      const sent = client
        .send(new GetObjectCommand({ Bucket: "synthetic", Key: "fixture" }))
        .catch((value: unknown) => value);
      await incoming;
      const request = native;
      if (!request) throw new Error("Expected actual native request");
      // Construct a hostile event order on a real request. This is an ordering
      // regression, not evidence that ordinary TCP produces this sequence.
      request.emit("error", original);
      const response = once(request, "response");
      reply?.();
      const [body] = await response;
      if (!(body instanceof IncomingMessage)) throw new Error("Expected actual native response");
      body.resume();
      return sent;
    });
    expect(error).toBe(original);
    expect(observation.take(token, error)).toBe("new-before-response");
  } finally {
    created.unsubscribe(capture);
    observation.finish(token);
    observation.destroy();
    client.destroy();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

async function ownedHttpFixture(
  respond: (request: IncomingMessage, response: ServerResponse, count: number) => void,
) {
  let requests = 0;
  const server = createServer((request, response) => respond(request, response, ++requests));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected owned TCP listener");
  const handler = new NodeHttpHandler({ connectionTimeout: 1000, socketTimeout: 1000 });
  const client = new S3Client({
    endpoint: `http://127.0.0.1:${address.port}`,
    region: "us-east-1",
    credentials: { accessKeyId: "synthetic", secretAccessKey: "synthetic" },
    forcePathStyle: true,
    maxAttempts: 1,
    requestHandler: handler,
  });
  const created = channel("http.client.request.created");
  const subscribedBefore = created.hasSubscribers;
  const observation = createUsRequestReadObservation(handler);
  const natives: ClientRequest[] = [];
  const capture = (message: unknown) => {
    const descriptor = Object.getOwnPropertyDescriptor(message, "request");
    const value: unknown = descriptor && "value" in descriptor ? descriptor.value : undefined;
    if (value instanceof ClientRequest) {
      const agent = Object.getOwnPropertyDescriptor(value, "agent");
      if (agent && "value" in agent && agent.value === handler.httpHandlerConfigs().httpAgent)
        natives.push(value);
    }
  };
  created.subscribe(capture);
  let closed = false;
  return {
    observation,
    natives,
    get requests() {
      return requests;
    },
    send: (signal?: AbortSignal) =>
      client.send(
        new GetObjectCommand({ Bucket: "synthetic", Key: "fixture" }),
        signal ? { abortSignal: signal } : {},
      ),
    async close() {
      if (closed) return;
      closed = true;
      observation.destroy();
      created.unsubscribe(capture);
      client.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      expect(created.hasSubscribers).toBe(subscribedBefore);
    },
  };
}

for (const warm of [false, true]) {
  it(`records ${warm ? "reused" : "new"} response state before active native destruction`, async () => {
    const fixture = await ownedHttpFixture((_request, response, count) => {
      if (warm && count === 1) {
        response.writeHead(200, { "Content-Length": "2" });
        response.end("ok");
      } else {
        response.writeHead(200, { "Content-Length": "100" });
        response.write("x");
      }
    });
    const token = {};
    const original = Object.assign(new Error("synthetic local destruction"), {
      code: "ECONNRESET",
    });
    try {
      if (warm) expect(await (await fixture.send()).Body?.transformToString()).toBe("ok");
      const error: unknown = await fixture.observation
        .run(token, async () => {
          const response = await fixture.send();
          const consumed = response.Body?.transformToByteArray().catch(() => undefined);
          const request = fixture.natives.at(-1);
          if (!request) throw new Error("Expected owned native request");
          const errored = once(request, "error");
          // A controlled local destruction characterizes an after-headers event;
          // this does not identify the origin of the actual CI reset.
          request.destroy(original);
          const [value] = await errored;
          await consumed;
          throw value;
        })
        .catch((value: unknown) => value);
      expect(error).toBe(original);
      expect(fixture.observation.take(token, error)).toBe(
        warm ? "reused-after-response" : "new-after-response",
      );
      expect(fixture.requests).toBe(warm ? 2 : 1);
      fixture.observation.finish(token);
    } finally {
      await fixture.close();
    }
  });
}

it("does not turn a later SDK error-body failure into a request error witness", async () => {
  const fixture = await ownedHttpFixture((request, response) => {
    response.writeHead(500, { "Content-Type": "application/xml", "Content-Length": "100" });
    response.write("<Error>");
    setImmediate(() => request.socket.destroy());
  });
  const token = {};
  try {
    const error: unknown = await fixture.observation
      .run(token, () => fixture.send())
      .catch((value: unknown) => value);
    expect(error).toBeInstanceOf(Error);
    expect(fixture.observation.take(token, error)).toBeUndefined();
    expect(fixture.requests).toBe(1);
    fixture.observation.finish(token);
  } finally {
    await fixture.close();
  }
});

for (const mode of ["finish", "destroy"] as const) {
  it(`removes active observation listeners on ${mode}, leaving abort and later tokens intact`, async () => {
    let received: (() => void) | undefined;
    const incoming = new Promise<void>((resolve) => {
      received = resolve;
    });
    const fixture = await ownedHttpFixture((request, response, count) => {
      if (count === 1) received?.();
      else {
        response.writeHead(200, { "Content-Length": "2" });
        response.end("ok");
      }
    });
    const first = {},
      next = {};
    const controller = new AbortController();
    try {
      const sent = fixture.observation
        .run(first, () => fixture.send(controller.signal))
        .catch((value: unknown) => value);
      await incoming;
      const request = fixture.natives[0];
      if (!request) throw new Error("Expected owned native request");
      const responseListeners = request.listenerCount("response"),
        errorListeners = request.listenerCount("error");
      if (mode === "finish") fixture.observation.finish(first);
      else fixture.observation.destroy();
      expect(request.listenerCount("response")).toBe(responseListeners - 1);
      expect(request.listenerCount("error")).toBe(errorListeners - 1);
      controller.abort();
      const error = await sent;
      expect(error).toMatchObject({ name: "AbortError" });
      expect(fixture.observation.take(first, error)).toBeUndefined();
      const value = await fixture.observation.run(next, () => fixture.send());
      expect(await value.Body?.transformToString()).toBe("ok");
      expect(fixture.observation.take(next, error)).toBeUndefined();
      fixture.observation.finish(next);
      expect(fixture.requests).toBe(2);
    } finally {
      controller.abort();
      fixture.observation.finish(first);
      fixture.observation.finish(next);
      await fixture.close();
    }
  });
}

it("isolates unrelated foreign-agent traffic and degrades multiple owned requests", async () => {
  const fixture = await ownedHttpFixture((_request, response, count) => {
    if (count <= 2) {
      response.writeHead(200, { "Content-Length": "2" });
      response.end("ok");
    } else response.destroy();
  });
  const foreign = await ownedHttpFixture((request) => request.socket.destroy());
  const isolated = {},
    ambiguous = {};
  try {
    const [response, unrelatedError] = await Promise.all([
      fixture.observation.run(isolated, () => fixture.send()),
      foreign.send().catch((value: unknown) => value),
    ]);
    expect(await response.Body?.transformToString()).toBe("ok");
    expect(unrelatedError).toMatchObject({ code: "ECONNRESET" });
    expect(fixture.observation.take(isolated, unrelatedError)).toBeUndefined();
    fixture.observation.finish(isolated);
    const error = await fixture.observation
      .run(ambiguous, async () => {
        const first = await fixture.send();
        expect(await first.Body?.transformToString()).toBe("ok");
        return fixture.send();
      })
      .catch((value: unknown) => value);
    expect(error).toMatchObject({ code: "ECONNRESET" });
    expect(fixture.observation.take(ambiguous, error)).toBeUndefined();
    expect(fixture.requests).toBe(3);
    expect(foreign.requests).toBe(1);
    fixture.observation.finish(ambiguous);
  } finally {
    await foreign.close();
    await fixture.close();
  }
});

it("preserves an active SDK abort and removes both pending observation listeners", async () => {
  let received: (() => void) | undefined;
  const incoming = new Promise<void>((resolve) => {
    received = resolve;
  });
  const fixture = await ownedHttpFixture(() => {
    received?.();
  });
  const token = {},
    controller = new AbortController();
  try {
    const sent = fixture.observation
      .run(token, () => fixture.send(controller.signal))
      .catch((value: unknown) => value);
    await incoming;
    const request = fixture.natives[0];
    if (!request) throw new Error("Expected owned native request");
    controller.abort();
    const error = await sent;
    expect(error).toMatchObject({ name: "AbortError" });
    expect(fixture.observation.take(token, error)).toBeUndefined();
    const responseListeners = request.listenerCount("response");
    fixture.observation.finish(token);
    expect(request.listenerCount("response")).toBe(responseListeners - 1);
    expect(fixture.observation.take(token, error)).toBeUndefined();
    expect(fixture.requests).toBe(1);
  } finally {
    controller.abort();
    fixture.observation.finish(token);
    await fixture.close();
  }
});

it("cleans a successful token and rejects foreign-agent acquisition in its own context", async () => {
  const fixture = await ownedHttpFixture((_request, response) => {
    response.writeHead(200, { "Content-Length": "2" });
    response.end("ok");
  });
  const foreign = await ownedHttpFixture((request) => request.socket.destroy());
  const good = {},
    bad = {};
  try {
    const response = await fixture.observation.run(good, () => fixture.send());
    expect(await response.Body?.transformToString()).toBe("ok");
    const request = fixture.natives[0];
    if (!request) throw new Error("Expected owned native request");
    const errors = request.listenerCount("error");
    fixture.observation.finish(good);
    expect(request.listenerCount("error")).toBe(errors - 1);
    const error = await fixture.observation
      .run(bad, () => foreign.send())
      .catch((value: unknown) => value);
    expect(error).toMatchObject({ code: "ECONNRESET" });
    expect(fixture.observation.take(good, error)).toBeUndefined();
    expect(fixture.observation.take(bad, error)).toBeUndefined();
    fixture.observation.finish(bad);
    expect(fixture.requests).toBe(1);
    expect(foreign.requests).toBe(1);
  } finally {
    await foreign.close();
    await fixture.close();
  }
});
