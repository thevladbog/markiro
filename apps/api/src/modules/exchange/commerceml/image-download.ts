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

/**
 * Разворачивает валидный (по `isIP() === 6`) IPv6-адрес в 8 16-битных групп,
 * учитывая `::`-сжатие и dotted-quad-хвост (v4-mapped/v4-compatible/NAT64
 * запись вроде `::ffff:1.2.3.4`), приводя такой хвост к двум hex-группам.
 * Возвращает `null`, если строка не разбирается — сюда это не должно
 * попадать (вызывающий код уже проверил `isIP() === 6`), но на этот случай
 * `isForbiddenAddress` трактует `null` как «запрещено» (см. вызов ниже).
 */
function expandIpv6(address: string): number[] | null {
  const parseGroups = (part: string): number[] | null => {
    if (part === "") return [];
    const segments = part.split(":");
    const groups: number[] = [];
    for (const [i, segment] of segments.entries()) {
      if (i === segments.length - 1 && segment.includes(".")) {
        const octets = segment.split(".").map(Number);
        if (octets.length !== 4 || octets.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
          return null;
        }
        groups.push(((octets[0]! << 8) | octets[1]!) & 0xffff);
        groups.push(((octets[2]! << 8) | octets[3]!) & 0xffff);
        continue;
      }
      const value = Number.parseInt(segment, 16);
      if (Number.isNaN(value) || value < 0 || value > 0xffff) return null;
      groups.push(value);
    }
    return groups;
  };

  const compressionIndex = address.indexOf("::");
  if (compressionIndex === -1) {
    const groups = parseGroups(address);
    return groups !== null && groups.length === 8 ? groups : null;
  }
  const headGroups = parseGroups(address.slice(0, compressionIndex));
  const tailGroups = parseGroups(address.slice(compressionIndex + 2));
  if (headGroups === null || tailGroups === null) return null;
  const missing = 8 - headGroups.length - tailGroups.length;
  if (missing < 0) return null;
  const padding = new Array<number>(missing).fill(0);
  return [...headGroups, ...padding, ...tailGroups];
}

/** Собирает `a.b.c.d` из двух 16-битных групп (последние 32 бита адреса). */
function embeddedIpv4(hi: number, lo: number): string {
  return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
}

function allGroupsZero(groups: number[], from: number, to: number): boolean {
  return groups.slice(from, to).every((group) => group === 0);
}

/** true для адресов, куда серверу ходить нельзя: loopback, RFC1918, link-local, ULA, v4-mapped. Не-IP тоже запрещён (сюда приходит уже РЕЗУЛЬТАТ резолва). */
export function isForbiddenAddress(address: string): boolean {
  const kind = isIP(address);
  if (kind === 4) return isForbiddenIpv4(address);
  if (kind === 6) {
    // Текстовый матчинг (dotted-quad-хвост через regex) не годится: WHATWG
    // URL нормализует bracketed-литералы в hex ДО того, как этот код их
    // увидит (`new URL("https://[::127.0.0.1]/x").hostname` ->
    // `"[::7f00:1]"`, dotted-quad уже нет). Поэтому адрес разбирается в 8
    // 16-битных групп и решение принимается по структуре — это одинаково
    // ловит текстовую dotted-quad форму и её hex-эквивалент.
    const groups = expandIpv6(address.toLowerCase());
    if (groups === null) return true;

    if (allGroupsZero(groups, 0, 5) && groups[5] === 0xffff) {
      // v4-mapped: ::ffff:a.b.c.d (или её hex-эквивалент ::ffff:xxxx:xxxx).
      return isForbiddenIpv4(embeddedIpv4(groups[6]!, groups[7]!));
    }
    if (allGroupsZero(groups, 0, 6)) {
      // Unspecified/loopback/v4-compatible: ::, ::1, ::a.b.c.d.
      if (groups[6] === 0 && (groups[7] === 0 || groups[7] === 1)) return true;
      return isForbiddenIpv4(embeddedIpv4(groups[6]!, groups[7]!));
    }
    if (groups[0] === 0x64 && groups[1] === 0xff9b && allGroupsZero(groups, 2, 6)) {
      // NAT64: 64:ff9b::/96 embedding a.b.c.d (dotted-quad или hex-хвост —
      // структурная проверка ловит оба варианта одинаково, в отличие от
      // прежнего regex-по-тексту, который узнавал только dotted-quad).
      return isForbiddenIpv4(embeddedIpv4(groups[6]!, groups[7]!));
    }
    if ((groups[0]! & 0xfe00) === 0xfc00) return true; // ULA fc00::/7
    if ((groups[0]! & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
    return false;
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
