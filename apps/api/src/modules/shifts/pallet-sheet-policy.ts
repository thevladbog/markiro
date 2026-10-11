import { ConflictException } from "@nestjs/common";
export type PalletSheetCaller =
  | { kind: "cabinet" }
  | { kind: "device"; deviceKind: string | undefined; capabilities: string | undefined };
import {
  PALLET_SHEET_PROTOCOL,
  PALLET_SHEET_FOOTER_CAPABILITY,
  palletSheetRequiresFooterCapability,
  parsePalletSheetSnapshot,
  type PalletSheetSpecV2,
} from "@markiro/domain";
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
export function assertPalletSheetClient(caller: PalletSheetCaller, spec?: PalletSheetSpecV2): void {
  if (!supportsPalletSheetClient(caller))
    throw new ConflictException({
      code: "PALLET_SHEET_UNSUPPORTED",
      message: "Printing A4 pallet sheets requires an updated Windows station",
    });
  if (
    spec &&
    palletSheetRequiresFooterCapability(spec) &&
    caller.kind === "device" &&
    !caller.capabilities
      ?.split(",")
      .map((value) => value.trim())
      .includes(PALLET_SHEET_FOOTER_CAPABILITY)
  )
    throw new ConflictException({
      code: "PALLET_SHEET_FOOTER_UNSUPPORTED",
      message: "Printing an A4 footer requires an updated Windows station",
    });
}
export function assertPalletSheetEntry(
  shift: { palletSheetTemplateId?: string | null; palletLabelTemplateId: string | null },
  caller: PalletSheetCaller,
  spec?: PalletSheetSpecV2,
): void {
  if (
    shift.palletSheetTemplateId &&
    (!shift.palletLabelTemplateId || supportsPalletSheetClient(caller))
  )
    assertPalletSheetClient(caller, spec);
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
  if (includeSheets && supportsPalletSheetClient(caller)) {
    const snapshot = value.palletSheetTemplateSnapshot ?? value.palletSheetTemplate;
    if (snapshot !== undefined && snapshot !== null)
      assertPalletSheetClient(caller, parsePalletSheetSnapshot(snapshot).spec);
    return value;
  }
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
