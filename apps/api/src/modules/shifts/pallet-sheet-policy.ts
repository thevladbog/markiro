import { ConflictException } from "@nestjs/common";
export type PalletSheetCaller =
  | { kind: "cabinet" }
  | { kind: "device"; deviceKind: string | undefined; capabilities: string | undefined };
import { PALLET_SHEET_PROTOCOL } from "@markiro/domain";
export { PALLET_SHEET_PROTOCOL } from "@markiro/domain";
export function supportsPalletSheetClient(caller: PalletSheetCaller): boolean {
  return (
    caller.kind === "cabinet" ||
    (caller.deviceKind === "station" &&
      Boolean(
        caller.capabilities
          ?.split(",")
          .map((value) => value.trim())
          .includes(PALLET_SHEET_PROTOCOL),
      ))
  );
}
export function assertPalletSheetClient(caller: PalletSheetCaller): void {
  if (!supportsPalletSheetClient(caller))
    throw new ConflictException({
      code: "PALLET_SHEET_UNSUPPORTED",
      message: "Printing A4 pallet sheets requires an updated Windows station",
    });
}
export function assertPalletSheetEntry(
  shift: { palletSheetTemplateId?: string | null; palletLabelTemplateId: string | null },
  caller: PalletSheetCaller,
): void {
  if (shift.palletSheetTemplateId && !shift.palletLabelTemplateId) assertPalletSheetClient(caller);
}
interface PalletSheetResponseFields {
  palletSheetTemplateId?: unknown;
  palletSheetTemplateSnapshot?: unknown;
  palletSheetTemplateName?: unknown;
  palletSheetTemplateRevision?: unknown;
  palletSheetDefaultSource?: unknown;
  palletSheetTemplate?: unknown;
  defaultPalletSheetTemplateId?: unknown;
  palletSheetProtocol?: unknown;
}
export function projectPalletSheetFields<T extends PalletSheetResponseFields>(
  value: T,
  caller: PalletSheetCaller,
  includeSheets = supportsPalletSheetClient(caller),
) {
  if (includeSheets && supportsPalletSheetClient(caller)) return value;
  const {
    palletSheetTemplateId,
    palletSheetTemplateSnapshot,
    palletSheetTemplateName,
    palletSheetTemplateRevision,
    palletSheetDefaultSource,
    palletSheetTemplate,
    defaultPalletSheetTemplateId,
    palletSheetProtocol,
    ...legacy
  } = value;
  void palletSheetTemplateId;
  void palletSheetTemplateSnapshot;
  void palletSheetTemplateName;
  void palletSheetTemplateRevision;
  void palletSheetDefaultSource;
  void palletSheetTemplate;
  void defaultPalletSheetTemplateId;
  void palletSheetProtocol;
  return legacy;
}
