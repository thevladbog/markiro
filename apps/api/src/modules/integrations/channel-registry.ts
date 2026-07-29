import { z } from "zod";

export type IntegrationChannelType = "commerceml" | "public_api" | "gis_mt_files" | "chestny_znak";

/**
 * Дескриптор канала. Реестр — КОД, конфигурация — данные: добавить интеграцию
 * значит добавить сюда запись и адаптер, а не миграцию, экран и свой журнал
 * (бриф 08, «How this grows»).
 */
export interface ChannelDescriptor {
  type: IntegrationChannelType;
  /** Ключ i18n названия; текст живёт в админке, не на сервере. */
  labelKey: string;
  /** false — карточка рисуется как все, но в состоянии «недоступно». */
  available: boolean;
  /** Приходит ли внешняя система сама (влияет на состояние «молчит»). */
  inbound: boolean;
  settingsSchema: z.ZodType<Record<string, unknown>>;
}

const commercemlSettings = z.object({
  /** Какой тип цены ложится в `products.unit_price`. Пусто — решаем по файлу. */
  priceType: z.string().min(1).optional(),
  /** Разделять ли списание в свой тип документа (используется в И-2). */
  splitWriteoffDocument: z.boolean().default(false),
});

const emptySettings = z.object({}).passthrough();

export const CHANNELS: readonly ChannelDescriptor[] = [
  {
    type: "commerceml",
    labelKey: "integrations.channel.commerceml",
    available: true,
    inbound: true,
    settingsSchema: commercemlSettings,
  },
  {
    type: "public_api",
    labelKey: "integrations.channel.publicApi",
    available: true,
    inbound: false,
    settingsSchema: emptySettings,
  },
  {
    type: "gis_mt_files",
    labelKey: "integrations.channel.gisMtFiles",
    available: false,
    inbound: false,
    settingsSchema: emptySettings,
  },
  {
    type: "chestny_znak",
    labelKey: "integrations.channel.chestnyZnak",
    available: false,
    inbound: true,
    settingsSchema: emptySettings,
  },
];

export function describeChannel(type: IntegrationChannelType): ChannelDescriptor {
  const found = CHANNELS.find((c) => c.type === type);
  if (!found) throw new Error(`unknown channel: ${type}`);
  return found;
}
