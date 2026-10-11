import { projectThermalLabelForClient } from "@markiro/domain";
import type { StationInventoryManifest } from "./station-inventory.dto";

/** The bundle and the signed task scope must describe the same client print model. */
export function projectThermalInventoryManifest<T extends StationInventoryManifest>(
  manifest: T,
  capabilities?: string,
): T {
  return {
    ...manifest,
    boxLabelTemplate: manifest.boxLabelTemplate
      ? {
          ...manifest.boxLabelTemplate,
          spec: projectThermalLabelForClient(manifest.boxLabelTemplate.spec, capabilities),
        }
      : null,
  };
}
