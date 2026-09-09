import type { LookupAddress, LookupOptions } from "node:dns";
import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import type { RequestOptions, request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";
import { PassThrough } from "node:stream";
import { beforeEach, expect, it, vi } from "vitest";

const dnsLookup = vi.hoisted(() => vi.fn());
vi.mock("node:dns", () => ({ lookup: dnsLookup }));

import { downloadBoundedImage } from "../src/modules/media/bounded-image-download";

const publicAddresses: LookupAddress[] = [
  { address: "93.184.216.34", family: 4 },
  { address: "2606:2800:220:1::1", family: 6 },
];

beforeEach(() => {
  dnsLookup.mockReset();
});

function resolveAddresses(addresses: LookupAddress[]) {
  dnsLookup.mockImplementation(
    (
      _hostname: string,
      _options: LookupOptions,
      callback: (error: null, addresses: LookupAddress[]) => void,
    ) => callback(null, addresses),
  );
}

/** Exercise the actual connection-time callback installed by the downloader. */
async function lookupViaDownloader(options: LookupOptions) {
  let lookup: LookupFunction | undefined;
  const request = ((
    _url: URL,
    requestOptions: RequestOptions,
    onResponse: (response: IncomingMessage) => void,
  ) => {
    lookup = requestOptions.lookup;
    const response = Object.assign(new PassThrough(), { statusCode: 200, headers: {} });
    return Object.assign(new EventEmitter(), {
      end() {
        onResponse(response as unknown as IncomingMessage);
        response.end();
      },
      destroy() {},
    });
  }) as unknown as typeof httpsRequest;
  await downloadBoundedImage(
    "https://images.example/photo.jpg",
    { maxBytes: 1024, timeoutMs: 1000, maxRedirects: 0, allowedHosts: ["images.example"] },
    { request },
  );
  const resolve = lookup;
  if (!resolve) throw new Error("Downloader did not install its DNS guard");
  return new Promise<{ address: string | LookupAddress[]; family: number | undefined }>(
    (done, reject) => {
      resolve("images.example", options, (error, address, family) => {
        if (error) reject(error);
        else done({ address, family });
      });
    },
  );
}

it("returns all validated addresses when Node requests automatic family selection", async () => {
  resolveAddresses(publicAddresses);
  await expect(lookupViaDownloader({ all: true })).resolves.toEqual({
    address: publicAddresses,
    family: undefined,
  });
  expect(dnsLookup).toHaveBeenCalledWith("images.example", { all: true }, expect.any(Function));
});

it("keeps the single-address callback shape when all is false", async () => {
  resolveAddresses(publicAddresses);
  await expect(lookupViaDownloader({ all: false })).resolves.toEqual({
    address: "93.184.216.34",
    family: 4,
  });
});

it.each([true, false])("rejects a mixed public/private DNS result with all=%s", async (all) => {
  resolveAddresses([...publicAddresses, { address: "127.0.0.1", family: 4 }]);
  await expect(lookupViaDownloader({ all })).rejects.toMatchObject({ code: "EFORBIDDEN" });
});

it("rejects empty DNS results", async () => {
  resolveAddresses([]);
  await expect(lookupViaDownloader({ all: true })).rejects.toMatchObject({ code: "EFORBIDDEN" });
});
