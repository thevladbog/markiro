import { ServiceUnavailableException } from "@nestjs/common";
import { expect, it, vi } from "vitest";
import {
  UsHostedRequestHttpResources,
  assertUsHostedRequestHttpResources,
} from "../src/deployment/us-hosted-request-http-resources";
import { UsRequestPackageArtifactStore } from "../src/modules/traceability/requests/us-request-package-artifacts";

it("refuses structural resource/owner imitations without constructing a package client", async () => {
  const factory = vi.spyOn(UsRequestPackageArtifactStore, "createHosted");
  try {
    expect(() => new UsHostedRequestHttpResources({}, {})).toThrow(ServiceUnavailableException);
    const imitation: unknown = Object.create(UsHostedRequestHttpResources.prototype);
    expect(() => assertUsHostedRequestHttpResources(imitation)).toThrow(
      ServiceUnavailableException,
    );
    const load: unknown = Reflect.get(UsHostedRequestHttpResources.prototype, "checkedBuild");
    const store: unknown = Reflect.get(
      UsHostedRequestHttpResources.prototype,
      "requirePackageStore",
    );
    if (typeof load !== "function" || typeof store !== "function")
      throw new Error("named boundary missing");
    const pending: unknown = Reflect.apply(load, imitation, []);
    await expect(pending).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(() => Reflect.apply(store, imitation, [])).toThrow(ServiceUnavailableException);
    expect(factory).not.toHaveBeenCalled();
  } finally {
    factory.mockRestore();
  }
});
