/**
 * Box-label field composition now lives in `@markiro/domain`: the handheld
 * closes boxes too and computes the same fields, and one label rule owned by
 * two apps is exactly what the root AGENTS.md forbids. Re-exported here so
 * every existing import site in the station keeps working unchanged.
 */
export {
  addCalendarDays,
  boxLabelFields,
  effectiveProductionIsoDate,
  expiryIsoDate,
  localIsoDate,
} from "@markiro/domain";
export type { BoxLabelInput } from "@markiro/domain";
