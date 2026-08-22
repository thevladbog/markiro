import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";

const LOOPBACK_ADDRESS = "127.0.0.1";
const SAFE_INIT_KEYS = new Set(["method", "body", "headers", "redirect"]);
const SAFE_METHODS = new Set(["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]);

function invalidRequest() {
  return new Error("loopback TLS request is invalid");
}

function requestInput(url, init, signal) {
  let target;
  try {
    target = new URL(url);
  } catch {
    throw invalidRequest();
  }
  if (
    target.protocol !== "https:" ||
    target.port ||
    target.username ||
    target.password ||
    target.hash ||
    !target.hostname ||
    target.hostname.endsWith(".") ||
    isIP(target.hostname) !== 0 ||
    (signal !== undefined && !(signal instanceof AbortSignal))
  )
    throw invalidRequest();

  if (
    init !== undefined &&
    (init === null ||
      typeof init !== "object" ||
      Array.isArray(init) ||
      Reflect.ownKeys(init).some((key) => !SAFE_INIT_KEYS.has(key)))
  )
    throw invalidRequest();
  const options = init || {};
  const method = options.method ?? "GET";
  if (typeof method !== "string" || !SAFE_METHODS.has(method)) throw invalidRequest();
  if (options.redirect !== undefined && options.redirect !== "manual") throw invalidRequest();
  if ((method === "GET" || method === "HEAD") && options.body !== undefined) throw invalidRequest();
  const body = options.body;
  if (
    body !== undefined &&
    typeof body !== "string" &&
    !Buffer.isBuffer(body) &&
    !(body instanceof Uint8Array)
  )
    throw invalidRequest();

  let headers;
  try {
    headers = Object.fromEntries(new Headers(options.headers).entries());
  } catch {
    throw invalidRequest();
  }
  return { body, headers, method, signal, target };
}

function responseHeaders(rawHeaders) {
  if (!Array.isArray(rawHeaders) || rawHeaders.length % 2 !== 0) throw invalidRequest();
  const headers = new Headers();
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = rawHeaders[index];
    const value = rawHeaders[index + 1];
    if (typeof name !== "string" || typeof value !== "string") throw invalidRequest();
    headers.append(name, value);
  }
  return headers;
}

function webResponse(incoming, method) {
  const status = incoming?.statusCode;
  if (!Number.isSafeInteger(status) || status < 200 || status > 599) throw invalidRequest();
  const hasBody = method !== "HEAD" && ![204, 205, 304].includes(status);
  if (!hasBody) incoming.resume();
  return new Response(hasBody ? Readable.toWeb(incoming) : null, {
    status,
    headers: responseHeaders(incoming.rawHeaders),
  });
}

export function createLoopbackTlsRequest(request = httpsRequest) {
  if (typeof request !== "function") throw invalidRequest();
  return async function loopbackTlsRequest(url, init, signal) {
    const input = requestInput(url, init, signal);
    return new Promise((resolveRequest, rejectRequest) => {
      let outgoing;
      try {
        outgoing = request(
          {
            protocol: "https:",
            hostname: input.target.hostname,
            port: 443,
            path: `${input.target.pathname}${input.target.search}`,
            method: input.method,
            headers: input.headers,
            servername: input.target.hostname,
            rejectUnauthorized: true,
            signal: input.signal,
            lookup(hostname, options, callback) {
              if (hostname !== input.target.hostname) {
                callback(invalidRequest());
                return;
              }
              if (options?.all) {
                callback(null, [{ address: LOOPBACK_ADDRESS, family: 4 }]);
                return;
              }
              callback(null, LOOPBACK_ADDRESS, 4);
            },
          },
          (incoming) => {
            try {
              resolveRequest(webResponse(incoming, input.method));
            } catch (error) {
              incoming.destroy?.();
              rejectRequest(error);
            }
          },
        );
        outgoing.once("error", rejectRequest);
        outgoing.end(input.body);
      } catch (error) {
        outgoing?.destroy?.();
        rejectRequest(error);
      }
    });
  };
}

export const loopbackTlsRequest = createLoopbackTlsRequest();
