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
 * потолок тела, таймаут на ВЕСЬ заход (не на хоп — иначе цепочка редиректов
 * растягивает его кратно), редиректы вручную и под теми же проверками.
 *
 * Отдельная оговорка про IP-литералы: если хост в URL УЖЕ является IP-адресом
 * (`https://127.0.0.1/x`, включая числовые/скобочные формы вроде
 * `https://2130706433/x` или `https://[fd00::1]/x`), Node вообще не вызывает
 * кастомный `lookup` — net/tls коннектят такой адрес напрямую. guardedLookup
 * в этом случае бесполезен, поэтому IP-литералы проверяются отдельно, ДО
 * запроса (см. `downloadImage`).
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
    // IPv4-compatible (`::a.b.c.d`) и NAT64 (`64:ff9b::a.b.c.d`) прячут
    // приватный/служебный IPv4 внутри hex-адреса — тот же риск, что и
    // v4-mapped выше. Распознаём по dotted-quad хвосту записи. ВАЖНО:
    // узнаётся только dotted-quad форма — полностью hex-embedded запись
    // (например `64:ff9b::808:808` для 8.8.8.8) сюда не попадает и уходит
    // в общие правила ниже; это осознанное ограничение, а не дыра «на
    // особый случай» — такие адреса на практике не встречаются в URL из
    // CommerceML-файлов, а общие ULA/link-local правила всё равно
    // применяются.
    const embeddedMatch = /:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(lower);
    if (embeddedMatch) {
      const embedded = embeddedMatch[1]!;
      if (isIP(embedded) === 4) return isForbiddenIpv4(embedded);
    }
    return /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower);
  }
  return true;
}

/** Снимает `[...]`-скобки с IPv6-хоста, как их отдаёт `URL#hostname`. */
function stripBrackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

/**
 * `lookup`-опция net/tls-коннекта: резолвит сам и отдаёт адрес сокету ТОЛЬКО
 * если ни один из результатов не запрещён. Проверка здесь, а не до запроса,
 * закрывает DNS-rebinding: сокет соединится ровно с тем адресом, который
 * прошёл проверку. Работает только для ХОСТНЕЙМОВ — для IP-литералов Node
 * эту опцию не вызывает вовсе (см. класс-коммент), поэтому их проверяет
 * `downloadImage` напрямую через `isForbiddenAddress`.
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

/**
 * Один хоп: запрос, чтение тела под потолком, или редирект (сырой
 * `Location`, БЕЗ разбора в URL — см. ниже почему).
 *
 * `timeoutMs` — остаток бюджета НА ВЕСЬ downloadImage, не таймаут этого
 * конкретного хопа: считает и передаёт его вызывающий код.
 */
function fetchHop(
  url: URL,
  request: typeof httpsRequest,
  timeoutMs: number,
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
        timeout: timeoutMs,
      },
      (res) => {
        // Этот колбэк вызывается АСИНХРОННО, на событии от сокета — то есть
        // вне тела Promise-экзекьютора выше. Throw отсюда НЕ становится
        // отказом промиса: он либо улетает как uncaughtException и валит
        // процесс, либо (в лучшем случае) теряется. Поэтому вся логика
        // обёрнута в try/catch с явным reject, и никакого `new URL(...)`
        // (единственная операция здесь, которая может бросить на «грязном»
        // Location) внутри этого колбэка больше нет — сырой `location`
        // просто прокидывается наверх, разбор в URL происходит в
        // `downloadImage`, в его собственном try/catch.
        try {
          const status = res.statusCode ?? 0;
          const location = res.headers.location;
          if (status >= 300 && status < 400 && typeof location === "string") {
            res.resume(); // дочитать и отпустить сокет
            resolve({ redirectTo: location });
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
        } catch (cause) {
          reject(
            cause instanceof ImageDownloadError
              ? cause
              : new ImageDownloadError(
                  "network",
                  cause instanceof Error ? cause.message : String(cause),
                ),
          );
        }
      },
    );
    req.on("timeout", () => {
      req.destroy();
      reject(new ImageDownloadError("timeout", `${timeoutMs}ms`));
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
  // Один дедлайн на ВЕСЬ downloadImage (все хопы редиректа вместе), а не
  // per-hop таймаут — иначе цепочка из IMAGE_DOWNLOAD_MAX_REDIRECTS хопов
  // могла растянуться в IMAGE_DOWNLOAD_MAX_REDIRECTS+1 раз дольше заявленных
  // 10 секунд.
  const deadline = Date.now() + IMAGE_DOWNLOAD_TIMEOUT_MS;
  let current = rawUrl;
  let base: URL | undefined;
  for (let hop = 0; hop <= IMAGE_DOWNLOAD_MAX_REDIRECTS; hop++) {
    let url: URL;
    try {
      url = base === undefined ? new URL(current) : new URL(current, base);
    } catch {
      throw new ImageDownloadError("network", `не URL: ${current}`);
    }
    if (url.protocol !== "https:") throw new ImageDownloadError("not_https", url.protocol);

    // IP-литерал в хосте (числовой, dotted-quad или `[...]`-IPv6) — net/tls
    // коннектят его напрямую, минуя `guardedLookup` (см. класс-коммент), так
    // что без этой проверки `https://169.254.169.254/x` прошёл бы вообще без
    // единой проверки адреса. Проверяем ДО запроса.
    const hostname = stripBrackets(url.hostname);
    if (isIP(hostname) !== 0 && isForbiddenAddress(hostname)) {
      throw new ImageDownloadError("forbidden_address", hostname);
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new ImageDownloadError("timeout", `бюджет ${IMAGE_DOWNLOAD_TIMEOUT_MS}ms исчерпан`);
    }

    const outcome = await fetchHop(url, request, remainingMs);
    if ("body" in outcome) return outcome.body;
    current = outcome.redirectTo;
    base = url;
  }
  throw new ImageDownloadError("too_many_redirects", `> ${IMAGE_DOWNLOAD_MAX_REDIRECTS}`);
}
