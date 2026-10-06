import "reflect-metadata";
import { PassThrough } from "node:stream";
import { BadRequestException, type ExecutionContext, type NestInterceptor } from "@nestjs/common";
import { INTERCEPTORS_METADATA } from "@nestjs/common/constants";
import { of } from "rxjs";
import { describe, expect, it, vi } from "vitest";
import { InventoriesController } from "../src/modules/inventories/inventories.controller";
import { OrgProfileController } from "../src/modules/org-profile/org-profile.controller";
import { PublicInventoriesController } from "../src/modules/public-api/public-inventories.controller";
import { TenantBillingController } from "../src/modules/tenant-billing/tenant-billing.controller";

/**
 * multer 2.4 changed what `limits.parts` means: it now hands busboy
 * `parts + 1`, so the value is the inclusive maximum. Under 2.3 the same
 * number was an exclusive threshold. These cases pin the accepted request
 * shape of every route that sets `parts`, plus one extra part on top of it.
 */
const BOUNDARY = "markiro-part-limit-boundary";

function fieldPart(name: string): string {
  return `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\nvalue\r\n`;
}

function filePart(name: string): string {
  return `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"; filename="upload.bin"\r\nContent-Type: application/octet-stream\r\n\r\nbytes\r\n`;
}

/** No Content-Disposition: busboy counts it as a part but not as a field or file. */
function unclassifiedPart(): string {
  return `--${BOUNDARY}\r\nContent-Type: application/octet-stream\r\n\r\nunexpected\r\n`;
}

function interceptorFor(prototype: object, handler: string): NestInterceptor {
  const method = (prototype as Record<string, unknown>)[handler];
  if (typeof method !== "function") throw new Error(`Missing handler ${handler}`);
  const [Interceptor] = Reflect.getMetadata(INTERCEPTORS_METADATA, method) as Array<
    new () => NestInterceptor
  >;
  if (!Interceptor) throw new Error(`Expected an upload interceptor on ${handler}`);
  return new Interceptor();
}

async function intercept(interceptor: NestInterceptor, parts: string[]): Promise<void> {
  const body = Buffer.from(`${parts.join("")}--${BOUNDARY}--\r\n`);
  const request = Object.assign(new PassThrough(), {
    headers: {
      "content-type": `multipart/form-data; boundary=${BOUNDARY}`,
      "content-length": String(body.byteLength),
    },
    method: "POST",
    url: "/upload",
  });
  queueMicrotask(() => request.end(body));
  const context = {
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => ({}) }),
  } as ExecutionContext;
  const next = vi.fn(() => of(undefined));
  await interceptor.intercept(context, { handle: next });
  expect(next).toHaveBeenCalledOnce();
}

const routes = [
  {
    name: "organization logo",
    interceptor: () => interceptorFor(OrgProfileController.prototype, "uploadLogo"),
    accepted: [filePart("logo")],
  },
  {
    name: "cabinet inventory import",
    interceptor: () => interceptorFor(InventoriesController.prototype, "importEvidence"),
    accepted: [filePart("file")],
  },
  {
    name: "public API inventory import",
    interceptor: () => interceptorFor(PublicInventoriesController.prototype, "importEvidence"),
    accepted: [filePart("file")],
  },
  {
    name: "billing request attachment",
    interceptor: () => interceptorFor(TenantBillingController.prototype, "attachToRequest"),
    accepted: [fieldPart("idempotencyKey"), filePart("file")],
  },
];

describe("multipart part limits", () => {
  for (const route of routes) {
    it(`${route.name} accepts its exact request shape`, async () => {
      await expect(intercept(route.interceptor(), route.accepted)).resolves.toBeUndefined();
    });

    it(`${route.name} rejects one part more than that shape`, async () => {
      await expect(
        intercept(route.interceptor(), [...route.accepted, unclassifiedPart()]),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  }
});
