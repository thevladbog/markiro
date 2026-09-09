import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import type { request as httpsRequest } from "node:https";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  downloadImage,
  IMAGE_DOWNLOAD_MAX_BYTES,
  IMAGE_DOWNLOAD_MAX_REDIRECTS,
  IMAGE_DOWNLOAD_TIMEOUT_MS,
  ImageDownloadError,
  isForbiddenAddress,
} from "../src/modules/exchange/commerceml/image-download";
import {
  downloadBoundedImage,
  ImageDownloadError as SharedImageDownloadError,
  isForbiddenAddress as isSharedForbiddenAddress,
  type ImageDownloadPolicy,
} from "../src/modules/media/bounded-image-download";
import { normalizeBoundedImage } from "../src/modules/media/bounded-image-processor";

describe("isForbiddenAddress", () => {
  it.each([
    ["10.0.0.1", true],
    ["127.0.0.1", true],
    ["169.254.1.1", true],
    ["172.16.0.1", true],
    ["172.31.255.255", true],
    ["192.168.1.1", true],
    ["0.0.0.0", true],
    ["100.64.0.1", true],
    ["::1", true],
    ["fc00::1", true],
    ["fe80::1", true],
    ["::ffff:127.0.0.1", true],
    // IPv4-compatible (::a.b.c.d) и NAT64 (64:ff9b::a.b.c.d) — приватный
    // IPv4 спрятан в hex-адресе. Проверка декодирует адрес в группы бит, а не
    // матчит текст, поэтому одинаково ловит и dotted-quad, и hex-хвост
    // (WHATWG URL нормализует bracketed-литералы именно в hex — см.
    // downloadImage-тесты ниже).
    ["::127.0.0.1", true],
    ["0:0:0:0:0:0:127.0.0.1", true],
    ["64:ff9b::10.0.0.1", true],
    ["::7f00:1", true], // hex-нормализация ::127.0.0.1
    ["64:ff9b::a00:1", true], // hex-нормализация 64:ff9b::10.0.0.1
    ["64:ff9b::808:808", false], // hex-нормализация 64:ff9b::8.8.8.8 (публичный)
    ["8.8.8.8", false],
    ["93.184.216.34", false],
    ["2606:2800:220:1::1", false],
    ["::ffff:8.8.8.8", false],
  ])("%s -> %s", (address, forbidden) => {
    expect(isForbiddenAddress(address)).toBe(forbidden);
  });
});

/** Фейковый https.request: маршрутизирует по URL, отдаёт статус/заголовки/тело чанками. */
type FakeRoute = { status: number; headers?: Record<string, string>; chunks?: Buffer[] };
function fakeRequestFor(routes: Record<string, FakeRoute>): typeof httpsRequest {
  const fake = (url: URL, _options: unknown, onResponse: (res: IncomingMessage) => void) => {
    const req = Object.assign(new EventEmitter(), {
      end() {
        const route = routes[url.toString()];
        if (!route) {
          queueMicrotask(() => req.emit("error", new Error(`no fake route: ${url}`)));
          return;
        }
        // Один и тот же поток под двумя именами: `source` — для write/end
        // (Writable-часть PassThrough), `res` — вид, который видит вызывающий
        // код (IncomingMessage: statusCode/headers, без write/end в типах).
        const source = new PassThrough();
        const res = source as unknown as IncomingMessage;
        res.statusCode = route.status;
        res.headers = route.headers ?? {};
        queueMicrotask(() => {
          onResponse(res);
          for (const chunk of route.chunks ?? []) source.write(chunk);
          source.end();
        });
      },
      destroy() {
        /* совместимость с таймаут-веткой */
      },
    });
    return req;
  };
  return fake as unknown as typeof httpsRequest;
}

describe("downloadBoundedImage", () => {
  const policy = (overrides: Partial<ImageDownloadPolicy> = {}): ImageDownloadPolicy => ({
    maxBytes: 5 * 1024 * 1024,
    timeoutMs: 15_000,
    maxRedirects: 2,
    allowedHosts: ["images.example"],
    ...overrides,
  });

  it.each([302, 503])(
    "closes an unfinished %i body before settling or following a redirect",
    async (status) => {
      const controller = new AbortController();
      const responses: PassThrough[] = [];
      const requests: Array<ReturnType<typeof vi.fn>> = [];
      const request = ((_url: URL, _options: unknown, callback: (res: IncomingMessage) => void) => {
        if (responses.length) {
          expect(responses[0]?.destroyed).toBe(true);
          expect(requests[0]).toHaveBeenCalledOnce();
        }
        const response = new PassThrough();
        responses.push(response);
        const destroy = vi.fn();
        requests.push(destroy);
        const first = responses.length === 1;
        const res = response as unknown as IncomingMessage;
        res.statusCode = first ? status : 200;
        res.headers = first ? { location: "/next" } : {};
        return Object.assign(new EventEmitter(), {
          destroy,
          end() {
            queueMicrotask(() => {
              callback(res);
              if (!first) response.end(Buffer.from("ok"));
            });
          },
        });
      }) as unknown as typeof httpsRequest;
      const result = downloadBoundedImage("https://images.example/start", policy(), {
        request,
        signal: controller.signal,
      });
      if (status === 302) await expect(result).resolves.toEqual(Buffer.from("ok"));
      else await expect(result).rejects.toMatchObject({ reason: "bad_status" });
      expect(responses[0]?.destroyed).toBe(true);
      expect(requests[0]).toHaveBeenCalledOnce();
      controller.abort();
      expect(responses[0]?.destroyed).toBe(true);
    },
  );

  it("destroys the actual request and response on caller abort without exposing signed URLs", async () => {
    const controller = new AbortController();
    const response = new PassThrough();
    const req = Object.assign(new EventEmitter(), { end: vi.fn(), destroy: vi.fn() });
    const request = vi.fn(
      (_url: URL, _options: unknown, callback: (res: IncomingMessage) => void) => {
        const res = response as unknown as IncomingMessage;
        res.statusCode = 200;
        res.headers = {};
        queueMicrotask(() => callback(res));
        return req;
      },
    ) as unknown as typeof httpsRequest;
    const pending = downloadBoundedImage("https://images.example/a?secret=never-log", policy(), {
      request,
      signal: controller.signal,
    });
    await Promise.resolve();
    controller.abort();
    await expect(pending).rejects.toMatchObject({
      reason: "timeout",
      message: "timeout: request aborted",
    });
    expect(req.destroy).toHaveBeenCalledOnce();
    expect(response.destroyed).toBe(true);
  });

  it("does not open a request when the caller has already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const request = vi.fn() as unknown as typeof httpsRequest;
    await expect(
      downloadBoundedImage("https://images.example/a", policy(), {
        request,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ reason: "timeout" });
    expect(request).not.toHaveBeenCalled();
  });

  it("checks the allowlist again after a redirect", async () => {
    await expect(
      downloadBoundedImage(
        "https://images.example/a",
        {
          maxBytes: 5 * 1024 * 1024,
          timeoutMs: 15_000,
          maxRedirects: 2,
          allowedHosts: ["images.example"],
        },
        {
          request: fakeRequestFor({
            "https://images.example/a": {
              status: 302,
              headers: { location: "https://other.example/a" },
            },
          }),
        },
      ),
    ).rejects.toMatchObject({ reason: "forbidden_host" });
  });

  it("allows two redirects and rejects a third redirect", async () => {
    const twoRedirects = fakeRequestFor({
      "https://images.example/1": {
        status: 302,
        headers: { location: "https://images.example/2" },
      },
      "https://images.example/2": {
        status: 302,
        headers: { location: "https://images.example/3" },
      },
      "https://images.example/3": { status: 200, chunks: [Buffer.from("ok")] },
    });
    await expect(
      downloadBoundedImage("https://images.example/1", policy(), { request: twoRedirects }),
    ).resolves.toEqual(Buffer.from("ok"));

    const threeRedirects = fakeRequestFor({
      "https://images.example/1": {
        status: 302,
        headers: { location: "https://images.example/2" },
      },
      "https://images.example/2": {
        status: 302,
        headers: { location: "https://images.example/3" },
      },
      "https://images.example/3": {
        status: 302,
        headers: { location: "https://images.example/4" },
      },
    });
    await expect(
      downloadBoundedImage("https://images.example/1", policy(), { request: threeRedirects }),
    ).rejects.toMatchObject({ reason: "too_many_redirects" });
  });

  it("uses the policy byte ceiling", async () => {
    const request = fakeRequestFor({
      "https://images.example/a": { status: 200, chunks: [Buffer.from("abc")] },
    });
    await expect(
      downloadBoundedImage("https://images.example/a", policy({ maxBytes: 2 }), { request }),
    ).rejects.toMatchObject({ reason: "too_large" });
  });

  it("denies credentials on the first hop and after redirects without exposing them", async () => {
    let called = false;
    const inner = fakeRequestFor({});
    const request = ((...args: Parameters<typeof httpsRequest>) => {
      called = true;
      return inner(...args);
    }) as typeof httpsRequest;
    const firstHop = downloadBoundedImage(
      "https://user:top-secret@images.example/a?signature=query-secret",
      policy(),
      { request },
    );
    await expect(firstHop).rejects.toMatchObject({ reason: "forbidden_host" });
    await expect(firstHop).rejects.not.toThrow(/top-secret|query-secret|user/);
    expect(called).toBe(false);

    const redirectRequest = fakeRequestFor({
      "https://images.example/a": {
        status: 302,
        headers: {
          location: "https://user:redirect-secret@images.example/b?signature=redirect-query",
        },
      },
    });
    const redirected = downloadBoundedImage("https://images.example/a", policy(), {
      request: redirectRequest,
    });
    await expect(redirected).rejects.toMatchObject({ reason: "forbidden_host" });
    await expect(redirected).rejects.not.toThrow(/redirect-secret|redirect-query|user/);
  });

  it("treats an empty allowlist as deny-all", async () => {
    let called = false;
    const inner = fakeRequestFor({});
    const request = ((...args: Parameters<typeof httpsRequest>) => {
      called = true;
      return inner(...args);
    }) as typeof httpsRequest;
    await expect(
      downloadBoundedImage("https://images.example/a", policy({ allowedHosts: [] }), { request }),
    ).rejects.toMatchObject({ reason: "forbidden_host" });
    expect(called).toBe(false);
  });

  it.each([
    [{ maxBytes: 0 }, "invalid maxBytes policy"],
    [{ maxBytes: Number.POSITIVE_INFINITY }, "invalid maxBytes policy"],
    [{ timeoutMs: 0 }, "invalid timeoutMs policy"],
    [{ timeoutMs: Number.NaN }, "invalid timeoutMs policy"],
    [{ maxRedirects: -1 }, "invalid maxRedirects policy"],
    [{ maxRedirects: 4 }, "invalid maxRedirects policy"],
    [{ maxRedirects: 1.5 }, "invalid maxRedirects policy"],
    [{ allowedHosts: [""] }, "invalid allowedHosts policy"],
  ])("validates every policy field before requesting: %j", async (overrides, detail) => {
    let called = false;
    const inner = fakeRequestFor({});
    const request = ((...args: Parameters<typeof httpsRequest>) => {
      called = true;
      return inner(...args);
    }) as typeof httpsRequest;
    await expect(
      downloadBoundedImage("https://images.example/a", policy(overrides), { request }),
    ).rejects.toThrow(detail);
    expect(called).toBe(false);
  });

  it("keeps the connection-time DNS guard on the shared path", async () => {
    await expect(
      downloadBoundedImage("https://localhost/rebinding", policy({ allowedHosts: ["localhost"] })),
    ).rejects.toMatchObject({ reason: "forbidden_address" });
  });

  it("keeps private redirect and IPv6 literal guards on the shared path", async () => {
    const request = fakeRequestFor({
      "https://images.example/a": {
        status: 302,
        headers: { location: "https://169.254.169.254/latest/meta-data" },
      },
    });
    await expect(
      downloadBoundedImage("https://images.example/a", policy({ allowedHosts: null }), { request }),
    ).rejects.toMatchObject({ reason: "forbidden_address" });
    await expect(
      downloadBoundedImage("https://[64:ff9b::10.0.0.1]/a", policy({ allowedHosts: null }), {
        request: fakeRequestFor({}),
      }),
    ).rejects.toMatchObject({ reason: "forbidden_address" });
  });

  it("does not send authorization, cookies, or caller-defined headers", async () => {
    let requestOptions: Record<string, unknown> | undefined;
    const request = ((
      _url: URL,
      options: Record<string, unknown>,
      onResponse: (res: IncomingMessage) => void,
    ) => {
      requestOptions = options;
      const source = new PassThrough();
      const res = source as unknown as IncomingMessage;
      res.statusCode = 200;
      res.headers = {};
      const req = Object.assign(new EventEmitter(), {
        end() {
          queueMicrotask(() => {
            onResponse(res);
            source.end(Buffer.from("ok"));
          });
        },
        destroy() {},
      });
      return req;
    }) as unknown as typeof httpsRequest;

    await downloadBoundedImage("https://images.example/a", policy(), { request });
    expect(requestOptions).toMatchObject({ method: "GET", timeout: expect.any(Number) });
    expect(requestOptions).not.toHaveProperty("headers");
  });

  it("redacts malformed redirect URLs and arbitrary request error messages", async () => {
    const malformedRequest = fakeRequestFor({
      "https://images.example/a": {
        status: 302,
        headers: { location: "https://[::1?signature=malformed-secret" },
      },
    });
    const malformed = downloadBoundedImage("https://images.example/a", policy(), {
      request: malformedRequest,
    });
    await expect(malformed).rejects.toMatchObject({ reason: "network" });
    await expect(malformed).rejects.not.toThrow(/malformed-secret|signature/);

    const networkRequest = ((_url: URL, _options: unknown) => {
      const req = Object.assign(new EventEmitter(), {
        end() {
          queueMicrotask(() => req.emit("error", new Error("bearer credential-secret")));
        },
        destroy() {},
      });
      return req;
    }) as unknown as typeof httpsRequest;
    const network = downloadBoundedImage("https://images.example/a", policy(), {
      request: networkRequest,
    });
    await expect(network).rejects.toMatchObject({ reason: "network" });
    await expect(network).rejects.not.toThrow(/bearer|credential-secret/);

    const throwingRequest = (() => {
      throw new Error("synchronous credential-secret");
    }) as unknown as typeof httpsRequest;
    const synchronous = downloadBoundedImage("https://images.example/a", policy(), {
      request: throwingRequest,
    });
    await expect(synchronous).rejects.toMatchObject({ reason: "network" });
    await expect(synchronous).rejects.not.toThrow(/synchronous|credential-secret/);
  });

  it("enforces one 15-second deadline across redirects and a slow-drip body", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const request = ((_url: URL, _options: unknown, onResponse: (res: IncomingMessage) => void) => {
      const source = new PassThrough();
      const res = source as unknown as IncomingMessage;
      const call = calls++;
      res.statusCode = call === 0 ? 302 : 200;
      res.headers = call === 0 ? { location: "https://images.example/drip" } : {};
      const req = Object.assign(new EventEmitter(), {
        end() {
          setTimeout(
            () => {
              onResponse(res);
              if (call === 0) source.end();
              else source.write(Buffer.from("x"));
            },
            call === 0 ? 8_000 : 0,
          );
        },
        destroy() {},
      });
      return req;
    }) as unknown as typeof httpsRequest;

    const startedAt = Date.now();
    const promise = downloadBoundedImage("https://images.example/start", policy(), { request });
    const assertion = expect(promise).rejects.toMatchObject({ reason: "timeout" });
    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;
    expect(Date.now() - startedAt).toBe(15_000);
    vi.useRealTimers();
  });

  it("leaves media type trust to the decoder when content-type is absent or wrong", async () => {
    const invalidRequest = fakeRequestFor({
      "https://images.example/invalid": {
        status: 200,
        headers: { "content-type": "image/png" },
        chunks: [Buffer.from("not an image")],
      },
    });
    const invalid = await downloadBoundedImage("https://images.example/invalid", policy(), {
      request: invalidRequest,
    });
    await expect(
      normalizeBoundedImage(invalid, { subject: "Product image", kind: "product" }),
    ).rejects.toThrow("must contain valid JPEG, PNG, or WebP content");

    const tinyPng = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );
    for (const headers of [{}, { "content-type": "text/plain" }]) {
      const validRequest = fakeRequestFor({
        "https://images.example/valid": { status: 200, headers, chunks: [tinyPng] },
      });
      const valid = await downloadBoundedImage("https://images.example/valid", policy(), {
        request: validRequest,
      });
      await expect(
        normalizeBoundedImage(valid, { subject: "Product image", kind: "product" }),
      ).resolves.toMatchObject({ width: 1, height: 1 });
    }
  });

  it("re-exports the shared error and address guard from the CommerceML wrapper", () => {
    expect(ImageDownloadError).toBe(SharedImageDownloadError);
    expect(isForbiddenAddress).toBe(isSharedForbiddenAddress);
  });
});

describe("downloadImage", () => {
  it("отдаёт тело при 200", async () => {
    const request = fakeRequestFor({
      "https://disk.sbis.ru/x": { status: 200, chunks: [Buffer.from("ab"), Buffer.from("cd")] },
    });
    await expect(downloadImage("https://disk.sbis.ru/x", { request })).resolves.toEqual(
      Buffer.from("abcd"),
    );
  });

  it("не https — отказ без единого запроса", async () => {
    await expect(
      downloadImage("http://disk.sbis.ru/x", { request: fakeRequestFor({}) }),
    ).rejects.toMatchObject({ reason: "not_https" });
  });

  it("ходит по редиректу и режет их после третьего", async () => {
    const hop = (n: number, to: string): FakeRoute => ({ status: 302, headers: { location: to } });
    const request = fakeRequestFor({
      "https://a.example/1": hop(1, "https://a.example/2"),
      "https://a.example/2": hop(2, "https://a.example/3"),
      "https://a.example/3": hop(3, "https://a.example/4"),
      "https://a.example/4": hop(4, "https://a.example/5"),
    });
    await expect(downloadImage("https://a.example/1", { request })).rejects.toMatchObject({
      reason: "too_many_redirects",
    });
  });

  it("редирект на http — отказ", async () => {
    const request = fakeRequestFor({
      "https://a.example/1": { status: 302, headers: { location: "http://a.example/2" } },
    });
    await expect(downloadImage("https://a.example/1", { request })).rejects.toMatchObject({
      reason: "not_https",
    });
  });

  it("обрывает тело больше лимита", async () => {
    const request = fakeRequestFor({
      "https://a.example/big": { status: 200, chunks: [Buffer.alloc(5 * 1024 * 1024 + 1)] },
    });
    await expect(downloadImage("https://a.example/big", { request })).rejects.toMatchObject({
      reason: "too_large",
    });
  });

  it("сохраняет прежние CommerceML-лимиты", () => {
    expect(IMAGE_DOWNLOAD_MAX_BYTES).toBe(5 * 1024 * 1024);
    expect(IMAGE_DOWNLOAD_TIMEOUT_MS).toBe(10_000);
    expect(IMAGE_DOWNLOAD_MAX_REDIRECTS).toBe(3);
  });

  it("не-2xx без location — bad_status", async () => {
    const request = fakeRequestFor({ "https://a.example/x": { status: 404 } });
    await expect(downloadImage("https://a.example/x", { request })).rejects.toMatchObject({
      reason: "bad_status",
    });
  });

  it("IP-литерал в хосте — forbidden_address без единого запроса (guardedLookup не вызывается для литералов)", async () => {
    let called = false;
    const inner = fakeRequestFor({
      "https://127.0.0.1/x": { status: 200, chunks: [Buffer.from("x")] },
    });
    const request = ((...args: Parameters<typeof httpsRequest>) => {
      called = true;
      return inner(...args);
    }) as typeof httpsRequest;
    await expect(downloadImage("https://127.0.0.1/x", { request })).rejects.toMatchObject({
      reason: "forbidden_address",
    });
    expect(called).toBe(false);
  });

  it("числовой обфусцированный IP-литерал (2130706433 = 127.0.0.1) — тоже forbidden_address", async () => {
    const request = fakeRequestFor({});
    await expect(downloadImage("https://2130706433/x", { request })).rejects.toMatchObject({
      reason: "forbidden_address",
    });
  });

  it("IPv6-литерал в скобках — тоже forbidden_address", async () => {
    const request = fakeRequestFor({});
    await expect(downloadImage("https://[fd00::1]/x", { request })).rejects.toMatchObject({
      reason: "forbidden_address",
    });
  });

  it("IPv4-compatible IPv6-литерал в скобках (WHATWG нормализует в hex до пре-чека) — forbidden_address без запроса", async () => {
    // new URL("https://[::127.0.0.1]/x").hostname === "[::7f00:1]" — текстовый
    // dotted-quad-матчинг такое не узнает, нужно декодировать группы битов.
    let called = false;
    const inner = fakeRequestFor({});
    const request = ((...args: Parameters<typeof httpsRequest>) => {
      called = true;
      return inner(...args);
    }) as typeof httpsRequest;
    await expect(downloadImage("https://[::127.0.0.1]/x", { request })).rejects.toMatchObject({
      reason: "forbidden_address",
    });
    expect(called).toBe(false);
  });

  it("NAT64 IPv6-литерал в скобках (WHATWG нормализует в hex до пре-чека) — forbidden_address без запроса", async () => {
    // new URL("https://[64:ff9b::10.0.0.1]/x").hostname === "[64:ff9b::a00:1]".
    let called = false;
    const inner = fakeRequestFor({});
    const request = ((...args: Parameters<typeof httpsRequest>) => {
      called = true;
      return inner(...args);
    }) as typeof httpsRequest;
    await expect(downloadImage("https://[64:ff9b::10.0.0.1]/x", { request })).rejects.toMatchObject(
      { reason: "forbidden_address" },
    );
    expect(called).toBe(false);
  });

  it("редирект с разрешённого хоста на IP-литерал метадаты — forbidden_address", async () => {
    const request = fakeRequestFor({
      "https://a.example/1": {
        status: 302,
        headers: { location: "https://169.254.169.254/latest/meta-data" },
      },
    });
    await expect(downloadImage("https://a.example/1", { request })).rejects.toMatchObject({
      reason: "forbidden_address",
    });
  });

  it("публичный IP-литерал в хосте по-прежнему проходит через fake", async () => {
    const request = fakeRequestFor({
      "https://93.184.216.34/x": { status: 200, chunks: [Buffer.from("ok")] },
    });
    await expect(downloadImage("https://93.184.216.34/x", { request })).resolves.toEqual(
      Buffer.from("ok"),
    );
  });

  it('битый Location ("https://") на редиректе — типизированный отказ, а не краш процесса', async () => {
    const request = fakeRequestFor({
      "https://a.example/1": { status: 302, headers: { location: "https://" } },
    });
    await expect(downloadImage("https://a.example/1", { request })).rejects.toMatchObject({
      reason: "network",
    });
  });

  it('битый Location ("https://[::1") на редиректе — типизированный отказ', async () => {
    const request = fakeRequestFor({
      "https://a.example/1": { status: 302, headers: { location: "https://[::1" } },
    });
    await expect(downloadImage("https://a.example/1", { request })).rejects.toBeInstanceOf(
      ImageDownloadError,
    );
  });

  it('битый Location ("https://:80") на редиректе — типизированный отказ', async () => {
    const request = fakeRequestFor({
      "https://a.example/1": { status: 302, headers: { location: "https://:80" } },
    });
    await expect(downloadImage("https://a.example/1", { request })).rejects.toBeInstanceOf(
      ImageDownloadError,
    );
  });

  it("относительный Location на редиректе разрешается от предыдущего URL", async () => {
    const request = fakeRequestFor({
      "https://a.example/dir/1": { status: 302, headers: { location: "2" } },
      "https://a.example/dir/2": { status: 200, chunks: [Buffer.from("ok")] },
    });
    await expect(downloadImage("https://a.example/dir/1", { request })).resolves.toEqual(
      Buffer.from("ok"),
    );
  });
});

describe("downloadImage — абсолютный дедлайн хопа (не продлевается входящими байтами)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("капающий хост (один байт, тело никогда не завершается) — timeout по абсолютному дедлайну, а не зависает вечно", async () => {
    vi.useFakeTimers();
    // Фейк намеренно НЕ использует fakeRequestFor: тело нужно оставить
    // незавершённым (ни `end()`, ни новых чанков после первого) — именно
    // так выглядит «капель» в 1 байт раз в много секунд, которая держит
    // idle-таймаут (`timeout:` в опциях запроса) вечно взведённым.
    const request = ((_url: URL, _options: unknown, onResponse: (res: IncomingMessage) => void) => {
      const source = new PassThrough();
      const res = source as unknown as IncomingMessage;
      res.statusCode = 200;
      res.headers = {};
      const req = Object.assign(new EventEmitter(), {
        end() {
          queueMicrotask(() => {
            onResponse(res);
            source.write(Buffer.from("x")); // один байт — и тишина навсегда
          });
        },
        destroy() {
          /* абсолютный дедлайн должен вызвать это; фейку реально закрывать нечего */
        },
      });
      return req;
    }) as unknown as typeof httpsRequest;

    const promise = downloadImage("https://a.example/drip", { request });
    // Подписываемся на рассинхронизированный reject ДО advance, иначе
    // временное состояние "pending" между advance-тиками может всплыть как
    // unhandledRejection.
    const assertion = expect(promise).rejects.toMatchObject({ reason: "timeout" });
    await vi.advanceTimersByTimeAsync(IMAGE_DOWNLOAD_TIMEOUT_MS);
    await assertion;
  });
});
