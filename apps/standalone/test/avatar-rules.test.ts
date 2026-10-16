import { describe, expect, it } from "vitest";

import { HostError } from "../src/host/client.js";
import {
  avatarProblemOfError,
  canDeleteAvatar,
  canReplaceAvatar,
  checkAvatarDimensions,
  checkAvatarFile,
  isAvatarUnsupported,
} from "../src/office/avatar/avatar-rules.js";

const apiError = (code: string, status = 422) =>
  new HostError({ kind: "api", code, message: code, status });

describe("avatar file checks", () => {
  it("accepts JPEG, PNG and WebP up to 2 MiB", () => {
    for (const type of ["image/jpeg", "image/png", "image/webp"]) {
      expect(checkAvatarFile({ type, size: 2 * 1024 * 1024 })).toBeNull();
    }
  });
  it("refuses another type before size", () => {
    expect(checkAvatarFile({ type: "image/gif", size: 10 })).toBe("unsupportedType");
    expect(checkAvatarFile({ type: "", size: 10 })).toBe("unsupportedType");
    expect(checkAvatarFile({ type: "image/svg+xml", size: 99_999_999 })).toBe("unsupportedType");
  });
  it("refuses more than 2 MiB", () => {
    expect(checkAvatarFile({ type: "image/png", size: 2 * 1024 * 1024 + 1 })).toBe("tooLarge");
  });
  it("judges the picture's sides: 128..4096", () => {
    expect(checkAvatarDimensions(128, 128)).toBeNull();
    expect(checkAvatarDimensions(4096, 4096)).toBeNull();
    expect(checkAvatarDimensions(127, 900)).toBe("tooSmall");
    expect(checkAvatarDimensions(900, 100)).toBe("tooSmall");
    expect(checkAvatarDimensions(4097, 900)).toBe("tooBig");
    expect(checkAvatarDimensions(0, 0)).toBe("unreadable");
  });
});

describe("host error codes to the file problems of the profile", () => {
  it.each([
    ["avatar_too_large", "tooLarge"],
    ["avatar_unsupported_type", "unsupportedType"],
    ["avatar_too_small", "tooSmall"],
    ["avatar_dimensions_too_large", "tooBig"],
    ["avatar_not_square", "notSquare"],
    ["avatar_corrupt", "unreadable"],
    ["rate_limited", "rateLimited"],
    ["forbidden_replace_other", "forbidden"],
    ["forbidden", "forbidden"],
  ])("%s -> %s", (code, problem) => {
    expect(avatarProblemOfError(apiError(code))).toBe(problem);
  });
  it("is generic for anything else", () => {
    expect(avatarProblemOfError(apiError("internal", 500))).toBe("generic");
    expect(avatarProblemOfError(new Error("boom"))).toBe("generic");
  });
});

describe("who may change a photo", () => {
  const admin = { id: "a", role: "admin" as const };
  const tech = { id: "t", role: "technologist" as const };
  it("only the owner uploads or replaces", () => {
    expect(canReplaceAvatar(admin, "a")).toBe(true);
    expect(canReplaceAvatar(admin, "t")).toBe(false);
    expect(canReplaceAvatar(tech, "t")).toBe(true);
    expect(canReplaceAvatar(tech, "a")).toBe(false);
  });
  it("the owner deletes their own; an administrator deletes anyone's", () => {
    expect(canDeleteAvatar(tech, "t", true)).toBe(true);
    expect(canDeleteAvatar(admin, "t", true)).toBe(true);
    expect(canDeleteAvatar(tech, "a", true)).toBe(false);
  });
  it("nothing to delete when the user has no photo", () => {
    expect(canDeleteAvatar(admin, "t", false)).toBe(false);
    expect(canDeleteAvatar(admin, "a", false)).toBe(false);
  });
});

describe("an old host", () => {
  it("answers not_found for the missing route: the feature is absent", () => {
    expect(isAvatarUnsupported(apiError("not_found", 404))).toBe(true);
    expect(isAvatarUnsupported(apiError("avatar_not_found", 404))).toBe(false);
    expect(isAvatarUnsupported(new Error("x"))).toBe(false);
  });
});
