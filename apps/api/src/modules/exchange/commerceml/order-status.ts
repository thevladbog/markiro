import { asObject, dig, parseXml, textOf } from "./parse";

export interface ParsedOrderStatusDocument {
  externalRef: string;
  /** `null` when this document carries no matching requisite, or none was configured to look for at all. */
  statusValue: string | null;
}

/**
 * Reads `<Документ>` entries off a `type=sale` file (спека §6, "Из 1С к нам")
 * -- 1С's own report of orders it knows changed, in the SAME
 * `<ЗначенияРеквизитов>` shape спека §5's outbound direction uses (a genuine
 * CommerceML mechanism for configuration-defined custom fields, not
 * something invented for this exchange). `statusFieldName` is this
 * connection's own answer to "what does THIS 1С configuration call its
 * status requisite" (`channel-registry.ts`'s `orderStatusField` setting) --
 * there is no standard name across configurations (спека §6), so an
 * unconfigured connection gets `statusValue: null` for every document, same
 * as one whose document genuinely carries no matching requisite.
 */
export function parseOrderStatusDocuments(
  bytes: Buffer,
  statusFieldName: string | undefined,
): ParsedOrderStatusDocument[] {
  const root = parseXml(bytes);
  const container = dig(root, "КоммерческаяИнформация", "ПакетДокументов");
  const rawDocuments = container["Документ"];
  return (Array.isArray(rawDocuments) ? rawDocuments : []).map((raw): ParsedOrderStatusDocument => {
    const document = asObject(raw);
    const externalRef = textOf(document["Ид"]);
    const rawValues = dig(document, "ЗначенияРеквизитов")["ЗначениеРеквизита"];
    const entries = Array.isArray(rawValues) ? rawValues : [];

    let statusValue: string | null = null;
    if (statusFieldName !== undefined) {
      for (const rawEntry of entries) {
        const entry = asObject(rawEntry);
        if (textOf(entry["Наименование"]) === statusFieldName) {
          statusValue = textOf(entry["Значение"]);
          break;
        }
      }
    }
    return { externalRef, statusValue };
  });
}

/** Statuses `PickupOrdersService.applyExternalStatus` can transition a `pending` order into -- never `pending` itself (спека §6). */
export type MappedOrderStatus = "punched" | "writtenoff" | "cancelled";

const MAPPED_STATUSES = new Set<MappedOrderStatus>(["punched", "writtenoff", "cancelled"]);

function isMappedOrderStatus(value: string): value is MappedOrderStatus {
  return MAPPED_STATUSES.has(value as MappedOrderStatus);
}

/**
 * Resolves one document's raw `statusValue` (from `parseOrderStatusDocuments`)
 * through the connection's own `statusMapping` table (спека §6: "данные, а не
 * код") into one of the three statuses `applyExternalStatus` can apply.
 * `null` covers every "cannot decide" case identically -- no value present in
 * the document, no mapping configured at all, or a value the table doesn't
 * list -- спека §6's "по умолчанию слой выключен: неизвестный внешний статус
 * не двигает заявку молча", so the caller journals all three the same way
 * ("статус не сопоставлен"), not as three different shapes.
 */
export function resolveMappedStatus(
  statusValue: string | null,
  statusMapping: Record<string, string> | undefined,
): MappedOrderStatus | null {
  if (statusValue === null || !statusMapping) return null;
  const mapped = statusMapping[statusValue];
  return mapped !== undefined && isMappedOrderStatus(mapped) ? mapped : null;
}
