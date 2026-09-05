import { createHmac } from "node:crypto";

/** Synthetic HTTP cookie jar; never emits credential-bearing responses in logs. */
export class UsAuthTestClient {
  private cookies = new Map<string, string>();
  constructor(private readonly handler: (request: Request) => Promise<Response>) {}
  headers(): Headers {
    return new Headers({
      cookie: [...this.cookies].map(([key, value]) => `${key}=${value}`).join("; "),
    });
  }
  async request(path: string, body?: unknown, origin: string | null = "http://localhost:5174") {
    const headers = this.headers();
    if (origin) headers.set("origin", origin);
    if (body !== undefined) headers.set("content-type", "application/json");
    const response = await this.handler(
      new Request(`http://localhost:3100/api/us-auth${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(";")[0] ?? "";
      const separator = pair.indexOf("=");
      const key = pair.slice(0, separator);
      const value = pair.slice(separator + 1);
      if (value) this.cookies.set(key, value);
      else this.cookies.delete(key);
    }
    return response;
  }
}

export function currentUsTotp(uri: string): string {
  const encoded = new URL(uri).searchParams.get("secret");
  if (!encoded) throw new Error("Missing synthetic enrollment URI");
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const character of encoded.toUpperCase().replaceAll("=", "")) {
    const value = alphabet.indexOf(character);
    if (value < 0) throw new Error("Invalid synthetic enrollment URI");
    bits += value.toString(2).padStart(5, "0");
  }
  const bytes = Buffer.alloc(Math.floor(bits.length / 8));
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(bits.slice(index * 8, index * 8 + 8), 2);
  }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const digest = createHmac("sha1", bytes).update(counter).digest();
  const offset = (digest.at(-1) ?? 0) & 0x0f;
  return ((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).toString().padStart(6, "0");
}
