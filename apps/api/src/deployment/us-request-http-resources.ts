import type { UsRequestAvailability } from "@markiro/platform-contracts";
import { ServiceUnavailableException } from "@nestjs/common";
import {
  assertLoadedUsRequestBuildDescriptor,
  loadUsRequestBuildDescriptor,
  type LoadedUsRequestBuildDescriptor,
} from "./us-request-build-descriptor";
import {
  loadUsRequestPackageArtifactStorageConfig,
  type UsRequestPackageArtifactStorageConfig,
} from "../modules/traceability/requests/us-request-package-artifact-config";
import {
  UsRequestPackageArtifactStore,
  type UsRequestPackageArtifactS3Transport,
} from "../modules/traceability/requests/us-request-package-artifacts";
import type { UsRequestHttpGates } from "../modules/traceability/requests/us-request-http-commands";

export interface UsRequestHttpResourceDependencies {
  readonly loadBuild?: (source: NodeJS.ProcessEnv) => Promise<LoadedUsRequestBuildDescriptor>;
  readonly packageTransport?: UsRequestPackageArtifactS3Transport;
}

/** HTTP operation gates only. Configuration describes availability without
 * connecting to storage, opening a database or starting a worker. */
export class UsRequestHttpResources implements UsRequestHttpGates {
  private readonly source: NodeJS.ProcessEnv;
  private readonly loader: (source: NodeJS.ProcessEnv) => Promise<LoadedUsRequestBuildDescriptor>;
  private readonly transport: UsRequestPackageArtifactS3Transport | undefined;
  private readonly packageConfig: UsRequestPackageArtifactStorageConfig | null;
  private readonly packageAvailability: UsRequestAvailability["packageStorage"];
  private store: UsRequestPackageArtifactStore | undefined;
  private disposed = false;

  constructor(source: NodeJS.ProcessEnv, deps: UsRequestHttpResourceDependencies = {}) {
    this.source = Object.freeze({ ...source });
    this.loader = deps.loadBuild ?? loadUsRequestBuildDescriptor;
    this.transport = deps.packageTransport;
    try {
      this.packageConfig = loadUsRequestPackageArtifactStorageConfig(this.source);
      this.packageAvailability = this.packageConfig ? "configured" : "unconfigured";
    } catch {
      this.packageConfig = null;
      this.packageAvailability = "invalid";
    }
  }

  async loadBuild(): Promise<LoadedUsRequestBuildDescriptor> {
    try {
      if (this.disposed) throw new Error("disposed");
      const loaded = await this.loader(this.source);
      assertLoadedUsRequestBuildDescriptor(loaded);
      return loaded;
    } catch {
      throw new ServiceUnavailableException({ code: "us_request_build_unavailable" });
    }
  }

  requirePackageStore(): UsRequestPackageArtifactStore {
    try {
      if (this.disposed || !this.packageConfig) throw new Error("unavailable");
      this.store ??= new UsRequestPackageArtifactStore(this.packageConfig, this.transport);
      return this.store;
    } catch {
      throw new ServiceUnavailableException({ code: "us_request_package_storage_unavailable" });
    }
  }

  async availability(): Promise<UsRequestAvailability> {
    let build: UsRequestAvailability["build"] = "unavailable";
    try {
      await this.loadBuild();
      build = "available";
    } catch {
      // Refusal is local to commands; API startup and descriptive reads stay available.
    }
    return { build, packageStorage: this.packageAvailability };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    // The store owns its active operations; an injected transport remains caller-owned.
    this.store?.destroy();
  }
}
