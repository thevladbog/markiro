import type {
  CounterpartyRecord,
  OfficeLine,
  OfficeProduct,
  OfficeShift,
  OrgProfile,
  ProductPhoto,
} from "../../host/protocol.js";
import type { TaskFormInputs } from "./form-data.js";

/**
 * What «Бланк смены» is drawn from, out of the records the card reads: `null`
 * while one of them it names is not read (the cloud reads them in one query,
 * so it prints all of them or none). A shift without a counterparty names
 * none; a counterparty the list lacks is not read. The product's photo (plan
 * ТОВ) is waited for while it is read (`undefined`) when the product has one;
 * one that did not read (`null`) leaves the blank without it, as a photo is
 * no record the blank names.
 */
export function taskFormInputs(
  shift: OfficeShift,
  products: readonly OfficeProduct[] | undefined,
  lines: readonly OfficeLine[] | undefined,
  counterparties: readonly CounterpartyRecord[] | undefined,
  organization: OrgProfile | undefined,
  photo: ProductPhoto | null | undefined,
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
  if (product.photoChecksum === null) {
    return { shift, product, line, counterparty, organization, photo: null };
  }
  if (photo === undefined) return null;
  return { shift, product, line, counterparty, organization, photo };
}
