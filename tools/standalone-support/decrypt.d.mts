/** Types of `decrypt.mjs`, for the webview's round-trip test. */
export function findBlob(text: string): string;
export function parseBlob(token: string): {
  kid: string;
  flag: number;
  epk: Uint8Array;
  iv: Uint8Array;
  sealed: Uint8Array;
};
export function decryptBlob(token: string, privatePem: string): { kid: string; json: unknown };
export function publicEntry(
  privatePem: string,
  kid?: string,
): { kid: string; jwk: { kty: string; crv: string; x: string; y: string } };
export function table(payload: unknown): string;
