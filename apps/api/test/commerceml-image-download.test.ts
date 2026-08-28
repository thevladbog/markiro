import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import type { request as httpsRequest } from "node:https";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  downloadImage,
  ImageDownloadError,
  isForbiddenAddress,
} from "../src/modules/exchange/commerceml/image-download";

describe("isForbiddenAddress", () => {
  it.each([
    ["10.0.0.1", true], ["127.0.0.1", true], ["169.254.1.1", true],
    ["172.16.0.1", true], ["172.31.255.255", true], ["192.168.1.1", true],
    ["0.0.0.0", true], ["100.64.0.1", true],
    ["::1", true], ["fc00::1", true], ["fe80::1", true], ["::ffff:127.0.0.1", true],
    // IPv4-compatible (::a.b.c.d) и NAT64 (64:ff9b::a.b.c.d) — приватный
    // IPv4 спрятан в hex-адресе, но узнаваем по dotted-quad хвосту.
    ["::127.0.0.1", true],
    ["0:0:0:0:0:0:127.0.0.1", true],
    ["64:ff9b::10.0.0.1", true],
    ["8.8.8.8", false], ["93.184.216.34", false], ["2606:2800:220:1::1", false],
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
    await expect(downloadImage("http://disk.sbis.ru/x", { request: fakeRequestFor({}) }))
      .rejects.toMatchObject({ reason: "not_https" });
  });

  it("ходит по редиректу и режет их после третьего", async () => {
    const hop = (n: number, to: string): FakeRoute => ({ status: 302, headers: { location: to } });
    const request = fakeRequestFor({
      "https://a.example/1": hop(1, "https://a.example/2"),
      "https://a.example/2": hop(2, "https://a.example/3"),
      "https://a.example/3": hop(3, "https://a.example/4"),
      "https://a.example/4": hop(4, "https://a.example/5"),
    });
    await expect(downloadImage("https://a.example/1", { request }))
      .rejects.toMatchObject({ reason: "too_many_redirects" });
  });

  it("редирект на http — отказ", async () => {
    const request = fakeRequestFor({
      "https://a.example/1": { status: 302, headers: { location: "http://a.example/2" } },
    });
    await expect(downloadImage("https://a.example/1", { request }))
      .rejects.toMatchObject({ reason: "not_https" });
  });

  it("обрывает тело больше лимита", async () => {
    const request = fakeRequestFor({
      "https://a.example/big": { status: 200, chunks: [Buffer.alloc(5 * 1024 * 1024 + 1)] },
    });
    await expect(downloadImage("https://a.example/big", { request }))
      .rejects.toMatchObject({ reason: "too_large" });
  });

  it("не-2xx без location — bad_status", async () => {
    const request = fakeRequestFor({ "https://a.example/x": { status: 404 } });
    await expect(downloadImage("https://a.example/x", { request }))
      .rejects.toMatchObject({ reason: "bad_status" });
  });

  it("IP-литерал в хосте — forbidden_address без единого запроса (guardedLookup не вызывается для литералов)", async () => {
    let called = false;
    const inner = fakeRequestFor({ "https://127.0.0.1/x": { status: 200, chunks: [Buffer.from("x")] } });
    const request = ((...args: Parameters<typeof httpsRequest>) => {
      called = true;
      return inner(...args);
    }) as typeof httpsRequest;
    await expect(downloadImage("https://127.0.0.1/x", { request }))
      .rejects.toMatchObject({ reason: "forbidden_address" });
    expect(called).toBe(false);
  });

  it("числовой обфусцированный IP-литерал (2130706433 = 127.0.0.1) — тоже forbidden_address", async () => {
    const request = fakeRequestFor({});
    await expect(downloadImage("https://2130706433/x", { request }))
      .rejects.toMatchObject({ reason: "forbidden_address" });
  });

  it("IPv6-литерал в скобках — тоже forbidden_address", async () => {
    const request = fakeRequestFor({});
    await expect(downloadImage("https://[fd00::1]/x", { request }))
      .rejects.toMatchObject({ reason: "forbidden_address" });
  });

  it("редирект с разрешённого хоста на IP-литерал метадаты — forbidden_address", async () => {
    const request = fakeRequestFor({
      "https://a.example/1": {
        status: 302,
        headers: { location: "https://169.254.169.254/latest/meta-data" },
      },
    });
    await expect(downloadImage("https://a.example/1", { request }))
      .rejects.toMatchObject({ reason: "forbidden_address" });
  });

  it("публичный IP-литерал в хосте по-прежнему проходит через fake", async () => {
    const request = fakeRequestFor({
      "https://93.184.216.34/x": { status: 200, chunks: [Buffer.from("ok")] },
    });
    await expect(downloadImage("https://93.184.216.34/x", { request })).resolves.toEqual(
      Buffer.from("ok"),
    );
  });

  it("битый Location (\"https://\") на редиректе — типизированный отказ, а не краш процесса", async () => {
    const request = fakeRequestFor({
      "https://a.example/1": { status: 302, headers: { location: "https://" } },
    });
    await expect(downloadImage("https://a.example/1", { request })).rejects.toMatchObject({
      reason: "network",
    });
  });

  it("битый Location (\"https://[::1\") на редиректе — типизированный отказ", async () => {
    const request = fakeRequestFor({
      "https://a.example/1": { status: 302, headers: { location: "https://[::1" } },
    });
    await expect(downloadImage("https://a.example/1", { request })).rejects.toBeInstanceOf(
      ImageDownloadError,
    );
  });

  it("битый Location (\"https://:80\") на редиректе — типизированный отказ", async () => {
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
