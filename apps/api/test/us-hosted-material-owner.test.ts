import { inspect } from "node:util";
import { expect, it, vi } from "vitest";
import * as fileReader from "../src/deployment/us-hosted-file-reader";
import {
  assertUsHostedMaterial,
  collectUsHostedMaterial,
  disposeUsHostedMaterial,
  usHostedApiMaterial,
  usHostedWorkerMaterial,
} from "../src/deployment/us-hosted-material-owner";

it("refuses forged releases before constructing a secret reader", async () => {
  const reader = vi.spyOn(fileReader, "createUsHostedFileReader");
  try {
    for (const release of [null, undefined, {}, Object.freeze({ service: "api" })]) {
      await expect(collectUsHostedMaterial(release)).rejects.toThrow("us_hosted_material_invalid");
    }
    expect(reader).not.toHaveBeenCalled();
  } finally {
    reader.mockRestore();
  }
});
it("refuses copied or structural owners without exposing submitted fields", () => {
  const marker = "synthetic-private-input";
  const owner = { password: marker };
  for (const operation of [
    () => assertUsHostedMaterial(owner, {}, "api"),
    () => usHostedApiMaterial(owner, {}),
    () => usHostedWorkerMaterial(owner, {}),
    () => disposeUsHostedMaterial(owner),
  ]) {
    try {
      operation();
      throw new Error("unexpected_success");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect(inspect(error)).not.toContain(marker);
      expect(error).toHaveProperty("message", "us_hosted_material_invalid");
      expect(error).not.toHaveProperty("cause");
    }
  }
});
