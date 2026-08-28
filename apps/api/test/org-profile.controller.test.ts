import "reflect-metadata";
import { PassThrough } from "node:stream";
import { BadRequestException, type ExecutionContext, type NestInterceptor } from "@nestjs/common";
import { INTERCEPTORS_METADATA } from "@nestjs/common/constants";
import { of } from "rxjs";
import { describe, expect, it, vi } from "vitest";
import { OrgProfileController } from "../src/modules/org-profile/org-profile.controller";
import { putOrgProfileSchema } from "../src/modules/org-profile/dto";

interface MulterInterceptor extends NestInterceptor {
  multer: { limits?: { fields?: number; files?: number; parts?: number } };
}

function logoUploadInterceptor(): MulterInterceptor {
  const [Interceptor] = Reflect.getMetadata(
    INTERCEPTORS_METADATA,
    OrgProfileController.prototype.uploadLogo,
  ) as Array<new () => MulterInterceptor>;
  if (!Interceptor) throw new Error("Expected logo upload interceptor");
  return new Interceptor();
}

function multipartRequest(parts: string[]): PassThrough & {
  headers: Record<string, string>;
  method: string;
  url: string;
} {
  const boundary = "markiro-logo-boundary";
  const body = Buffer.from(`${parts.join("")}--${boundary}--\r\n`);
  const request = Object.assign(new PassThrough(), {
    headers: {
      "content-type": `multipart/form-data; boundary=${boundary}`,
      "content-length": String(body.byteLength),
    },
    method: "POST",
    url: "/org/profile/logo",
  });
  queueMicrotask(() => request.end(body));
  return request;
}

function fieldPart(name: string): string {
  return `--markiro-logo-boundary\r\nContent-Disposition: form-data; name="${name}"\r\n\r\nvalue\r\n`;
}

function filePart(name: string, filename: string): string {
  return `--markiro-logo-boundary\r\nContent-Disposition: form-data; name="${name}"; filename="${filename}"\r\nContent-Type: image/png\r\n\r\npng\r\n`;
}

function unclassifiedPart(): string {
  return "--markiro-logo-boundary\r\nContent-Type: application/octet-stream\r\n\r\nunexpected\r\n";
}

async function intercept(parts: string[]): Promise<{ next: ReturnType<typeof vi.fn> }> {
  const request = multipartRequest(parts);
  const context = {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => ({}),
    }),
  } as ExecutionContext;
  const next = vi.fn(() => of(undefined));

  await logoUploadInterceptor().intercept(context, { handle: next });
  return { next };
}

describe("OrgProfileController logo multipart boundary", () => {
  it("sets an exclusive second-part boundary with no text fields", () => {
    expect(logoUploadInterceptor().multer.limits).toMatchObject({
      fileSize: 5 * 1024 * 1024,
      files: 1,
      fields: 0,
      parts: 2,
    });
  });

  it("rejects a text field before calling the route handler", async () => {
    await expect(intercept([fieldPart("unexpected")])).rejects.toBeInstanceOf(BadRequestException);
  });

  it("accepts exactly one logo file part", async () => {
    const { next } = await intercept([filePart("logo", "logo.png")]);

    expect(next).toHaveBeenCalledOnce();
  });

  it("rejects any multipart part after the logo file", async () => {
    await expect(
      intercept([filePart("logo", "logo.png"), unclassifiedPart()]),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe("OrgProfileController PUT profile validation", () => {
  it("accepts IANA timezones and rejects invalid or empty timezone input", () => {
    expect(putOrgProfileSchema.safeParse({ timeZone: "Asia/Yekaterinburg" }).success).toBe(true);
    expect(putOrgProfileSchema.safeParse({ timeZone: "Mars/Olympus" }).success).toBe(false);
    expect(putOrgProfileSchema.safeParse({ timeZone: "" }).success).toBe(false);
  });

  it("accepts a UUID and explicit null for the box label default while preserving omission", () => {
    const templateId = "a0000000-0000-4000-8000-000000000001";

    expect(putOrgProfileSchema.safeParse({ defaultBoxLabelTemplateId: templateId })).toMatchObject({
      success: true,
      data: { defaultBoxLabelTemplateId: templateId },
    });
    expect(putOrgProfileSchema.safeParse({ defaultBoxLabelTemplateId: null })).toMatchObject({
      success: true,
      data: { defaultBoxLabelTemplateId: null },
    });
    expect(putOrgProfileSchema.safeParse({ inn: "7701234567" })).toMatchObject({
      success: true,
      data: { inn: "7701234567" },
    });
  });

  it("rejects a malformed box label template identifier", () => {
    expect(putOrgProfileSchema.safeParse({ defaultBoxLabelTemplateId: "not-a-uuid" }).success).toBe(
      false,
    );
  });
});
