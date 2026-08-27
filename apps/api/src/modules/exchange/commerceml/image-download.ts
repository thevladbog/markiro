import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { isIP } from "node:net";
import { request as httpsRequest } from "node:https";

/**
 * Скачивание `<Картинка>`-URL для mode=import. Значение приходит из файла на
 * НЕгейченном маршруте (см. exchange.controller.ts, класс-коммент) — то есть
 * URL контролирует внешняя сторона, и без ограничений это готовый SSRF:
 * «скачай http://169.254.169.254/…» руками нашего сервера. Отсюда правила:
 * только https, резолв через guardedLookup С ОТКАЗОМ приватным/служебным
 * адресам В МОМЕНТ КОННЕКТА (не заранее — иначе TOCTOU через DNS-rebinding),
 * потолок тела, таймаут на весь заход, редиректы вручную и под теми же
 * проверками.
 */
export const IMAGE_DOWNLOAD_MAX_BYTES = 5 * 1024 * 1024; // = MAX_SOURCE_BYTES медиа-пайплайна
export const IMAGE_DOWNLOAD_TIMEOUT_MS = 10_000;
export const IMAGE_DOWNLOAD_MAX_REDIRECTS = 3;

export type ImageDownloadReason =
  | "not_https"
  | "forbidden_address"
  | "too_large"
  | "timeout"
  | "too_many_redirects"
  | "bad_status"
  | "network";

export class ImageDownloadError extends Error {
  constructor(
    public readonly reason: ImageDownloadReason,
    detail?: string,
  ) {
    super(detail === undefined ? reason : `${reason}: ${detail}`);
  }
}

function isForbiddenIpv4(address: string): boolean {
  const [a, b] = address.split(".").map(Number);
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b! >= 16 && b! <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b! >= 64 && b! <= 127) return true; // CGNAT
  return false;
}

/** true для адресов, куда серверу ходить нельзя: loopback, RFC1918, link-local, ULA, v4-mapped. Не-IP тоже запрещён (сюда приходит уже РЕЗУЛЬТАТ резолва). */
export function isForbiddenAddress(address: string): boolean {
  const kind = isIP(address);
  if (kind === 4) return isForbiddenIpv4(address);
  if (kind === 6) {
    const lower = address.toLowerCase();
    if (lower === "::" || lower === "::1") return true;
    if (lower.startsWith("::ffff:")) {
      const mapped = lower.slice("::ffff:".length);
      return isIP(mapped) === 4 ? isForbiddenIpv4(mapped) : true;
    }
    return /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower);
  }
  return true;
}

/**
 * `lookup`-опция net/tls-коннекта: резолвит сам и отдаёт адрес сокету ТОЛЬКО
 * если ни один из результатов не запрещён. Проверка здесь, а не до запроса,
 * закрывает DNS-rebinding: сокет соединится ровно с тем адресом, который
 * прошёл проверку.
 */
function guardedLookup(
  hostname: string,
  options: object,
  callback: (error: NodeJS.ErrnoException | null, address: string, family: number) => void,
): void {
  dnsLookup(hostname, { all: true }, (error, addresses: LookupAddress[]) => {
    if (error) {
      callback(error, "", 0);
      return;
    }
    const forbidden = addresses.find((entry) => isForbiddenAddress(entry.address));
    if (forbidden !== undefined || addresses.length === 0) {
      callback(
        Object.assign(new Error(`forbidden address for ${hostname}`), { code: "EFORBIDDEN" }),
        "",
        0,
      );
      return;
    }
    const first = addresses[0]!;
    callback(null, first.address, first.family);
  });
}

export interface ImageDownloadDeps {
  /** Подменяется в тестах; в бою — node:https.request. */
  request?: typeof httpsRequest;
}

/** Один хоп: запрос, чтение тела под потолком, или редирект (location). */
function fetchHop(
  url: URL,
  request: typeof httpsRequest,
  budgetLeft: () => number,
): Promise<{ redirectTo: string } | { body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: "GET",
        // `lookup` — опция net.connect/tls.connect; http.RequestOptions
        // её не объявляет явно, но пропускает дальше по цепочке (проверено:
        // структурно совпадает с `LookupFunction`, приведение типа не нужно).
        lookup: guardedLookup,
        timeout: IMAGE_DOWNLOAD_TIMEOUT_MS,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const location = res.headers.location;
        if (status >= 300 && status < 400 && typeof location === "string") {
          res.resume(); // дочитать и отпустить сокет
          resolve({ redirectTo: new URL(location, url).toString() });
          return;
        }
        if (status < 200 || status >= 300) {
          res.resume();
          reject(new ImageDownloadError("bad_status", `HTTP ${status}`));
          return;
        }
        const chunks: Buffer[] = [];
        let received = 0;
        res.on("data", (chunk: Buffer) => {
          received += chunk.byteLength;
          if (received > IMAGE_DOWNLOAD_MAX_BYTES) {
            req.destroy();
            reject(new ImageDownloadError("too_large", `> ${IMAGE_DOWNLOAD_MAX_BYTES} bytes`));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => resolve({ body: Buffer.concat(chunks) }));
        res.on("error", (cause: Error) => reject(new ImageDownloadError("network", cause.message)));
      },
    );
    req.on("timeout", () => {
      req.destroy();
      reject(new ImageDownloadError("timeout", `${budgetLeft()}ms`));
    });
    req.on("error", (cause: NodeJS.ErrnoException) => {
      reject(
        cause.code === "EFORBIDDEN"
          ? new ImageDownloadError("forbidden_address", cause.message)
          : new ImageDownloadError("network", cause.message),
      );
    });
    req.end();
  });
}

export async function downloadImage(rawUrl: string, deps: ImageDownloadDeps = {}): Promise<Buffer> {
  const request = deps.request ?? httpsRequest;
  let current = rawUrl;
  for (let hop = 0; hop <= IMAGE_DOWNLOAD_MAX_REDIRECTS; hop++) {
    let url: URL;
    try {
      url = new URL(current);
    } catch {
      throw new ImageDownloadError("network", `не URL: ${current}`);
    }
    if (url.protocol !== "https:") throw new ImageDownloadError("not_https", url.protocol);
    const outcome = await fetchHop(url, request, () => IMAGE_DOWNLOAD_TIMEOUT_MS);
    if ("body" in outcome) return outcome.body;
    current = outcome.redirectTo;
  }
  throw new ImageDownloadError("too_many_redirects", `> ${IMAGE_DOWNLOAD_MAX_REDIRECTS}`);
}
