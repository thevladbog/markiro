import { SetMetadata } from "@nestjs/common";
import type { CabinetCapability } from "@markiro/domain";

export const ROUTE_ACCESS_POLICY = Symbol("ROUTE_ACCESS_POLICY");

export type RouteAccessPolicy =
  | { mode: "cabinet"; capabilities: readonly CabinetCapability[] }
  | { mode: "station-or-cabinet"; capabilities: readonly CabinetCapability[] }
  | { mode: "membership" };

export const RequirePermissions = (...capabilities: CabinetCapability[]) =>
  SetMetadata(ROUTE_ACCESS_POLICY, { mode: "cabinet", capabilities } satisfies RouteAccessPolicy);

export const AllowStationOrPermissions = (...capabilities: CabinetCapability[]) =>
  SetMetadata(ROUTE_ACCESS_POLICY, {
    mode: "station-or-cabinet",
    capabilities,
  } satisfies RouteAccessPolicy);

export const RequireMembership = () =>
  SetMetadata(ROUTE_ACCESS_POLICY, { mode: "membership" } satisfies RouteAccessPolicy);
