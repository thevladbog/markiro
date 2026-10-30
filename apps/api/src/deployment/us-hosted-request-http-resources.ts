import type { UsRequestAvailability } from "@markiro/platform-contracts";
import { ServiceUnavailableException } from "@nestjs/common";
import {
  assertUsHostedRelease,
  usHostedReleaseIdentity,
  type VerifiedUsHostedRelease,
  type UsHostedReleaseIdentity,
} from "./us-hosted-release-verifier";
import { assertUsHostedMaterial, type UsHostedMaterialOwner } from "./us-hosted-material-owner";
import { UsRequestPackageArtifactStore } from "../modules/traceability/requests/us-request-package-artifacts";

type ResourceRecord = {
  release: VerifiedUsHostedRelease;
  material: UsHostedMaterialOwner;
  store: UsRequestPackageArtifactStore | undefined;
  disposed: boolean;
};
const resources = new WeakMap<object, ResourceRecord>();
const invalid = () =>
  new ServiceUnavailableException({ code: "us_hosted_request_resources_invalid" });
function live(value: unknown): ResourceRecord {
  try {
    if (!value || typeof value !== "object") throw invalid();
    const record = resources.get(value);
    if (!record || record.disposed) throw invalid();
    assertUsHostedRelease(record.release);
    assertUsHostedMaterial(record.material, record.release, "api");
    if (usHostedReleaseIdentity(record.release).service !== "api") throw invalid();
    return record;
  } catch {
    throw invalid();
  }
}
/** Void identity assertion only; no construction/registration or proof can be supplied by callers. */
export function assertUsHostedRequestHttpResources(value: unknown): void {
  live(value);
}

/** Hosted command gates are distinct from the unchanged local descriptor loader. */
export class UsHostedRequestHttpResources {
  constructor(release: unknown, material: unknown) {
    try {
      assertUsHostedRelease(release);
      assertUsHostedMaterial(material, release, "api");
      if (usHostedReleaseIdentity(release).service !== "api") throw invalid();
      resources.set(this, { release, material, store: undefined, disposed: false });
    } catch {
      throw invalid();
    }
  }
  checkedBuild(): Promise<Readonly<{ build: UsHostedReleaseIdentity["build"]; digest: string }>> {
    try {
      const record = live(this);
      const identity = usHostedReleaseIdentity(record.release);
      return Promise.resolve(
        Object.freeze({ build: identity.build, digest: identity.descriptorDigest }),
      );
    } catch {
      return Promise.reject(
        new ServiceUnavailableException({ code: "us_request_build_unavailable" }),
      );
    }
  }
  requirePackageStore(): UsRequestPackageArtifactStore {
    try {
      const record = live(this);
      record.store ??= UsRequestPackageArtifactStore.createHosted(record.release, record.material);
      // A cached client confers no authority after its release/material owner is disposed.
      live(this);
      return record.store;
    } catch {
      throw new ServiceUnavailableException({ code: "us_request_package_storage_unavailable" });
    }
  }
  async availability(): Promise<UsRequestAvailability> {
    try {
      await this.checkedBuild();
      live(this);
      return { build: "available", packageStorage: "configured" };
    } catch {
      return { build: "unavailable", packageStorage: "invalid" };
    }
  }
  dispose(): void {
    const record = resources.get(this);
    if (!record) throw invalid();
    if (record.disposed) return;
    record.disposed = true;
    // Service lifecycle drains owned work before disposing this owned native client.
    record.store?.destroy();
  }
}
