import type {
  CounterpartyRecord,
  OfficeLine,
  OfficeProduct,
  OfficeShift,
  OrgProfile,
} from "../../host/protocol.js";
import type { TaskFormInputs } from "./form-data.js";

/**
 * What «Бланк смены» is drawn from, out of the records the card reads: `null`
 * while one of them it names is not read (the cloud reads them in one query,
 * so it prints all of them or none). A shift without a counterparty names
 * none; a counterparty the list lacks is not read.
 */
export function taskFormInputs(
  shift: OfficeShift,
  products: readonly OfficeProduct[] | undefined,
  lines: readonly OfficeLine[] | undefined,
  counterparties: readonly CounterpartyRecord[] | undefined,
  organization: OrgProfile | undefined,
): TaskFormInputs | null {
  const product = products?.find((each) => each.id === shift.productId);
  const line = lines?.find((each) => each.id === shift.lineId);
  const counterparty =
    shift.counterpartyId === null
      ? null
      : counterparties?.find((each) => each.id === shift.counterpartyId);
  if (
    product === undefined ||
    line === undefined ||
    counterparty === undefined ||
    organization === undefined
  ) {
    return null;
  }
  return { shift, product, line, counterparty, organization };
}
