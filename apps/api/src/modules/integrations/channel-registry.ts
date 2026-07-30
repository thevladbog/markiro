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
  /**
   * Аутентифицируется ли канал именно парой логин+секрет из
   * `IntegrationsService.issueCredentials` (`integration_channels.credentialLogin`/
   * `credentialHash`, которую проверяет `exchange.controller.ts` на
   * `POST /1c_exchange`). Уже, чем `available`: канал может быть построен и
   * доступен, ни разу не тронув эту таблицу — у `public_api` своя
   * аутентификация через `apikey` (`api-keys.service.ts`), у файловых
   * экспортов её вообще нет. Уже и чем `inbound`: `chestny_znak` тоже
   * входящий, но его реальная схема подключения ещё не решена (таблица
   * брифа 08, «Undecided» для остальных строк не про это, но для
   * `chestny_znak` статус — «placeholder»), так что заводить его на эту
   * таблицу заранее значит угадывать контракт, которого ещё нет.
   *
   * Единственный канал с `true` сегодня — `commerceml`: это единственный,
   * кто реально предъявляет этот логин+секрет на `POST /1c_exchange`.
   * `IntegrationsService.issueCredentials` отказывает (409) любому каналу,
   * для которого здесь `false` — без этой проверки `POST
   * /integrations/:type/credentials` проверял только `available`, и
   * `public_api` (доступен, но не обменивается по этому протоколу) мог
   * выпустить и сохранить настоящий логин+хэш, которые на проверяющей
   * стороне никто и никогда не читает.
   */
  usesExchangeCredentials: boolean;
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
    usesExchangeCredentials: true,
    settingsSchema: commercemlSettings,
  },
  {
    type: "public_api",
    labelKey: "integrations.channel.publicApi",
    available: true,
    inbound: false,
    usesExchangeCredentials: false,
    settingsSchema: emptySettings,
  },
  {
    type: "gis_mt_files",
    labelKey: "integrations.channel.gisMtFiles",
    available: false,
    inbound: false,
    usesExchangeCredentials: false,
    settingsSchema: emptySettings,
  },
  {
    type: "chestny_znak",
    labelKey: "integrations.channel.chestnyZnak",
    available: false,
    inbound: true,
    usesExchangeCredentials: false,
    settingsSchema: emptySettings,
  },
];

export function describeChannel(type: IntegrationChannelType): ChannelDescriptor {
  const found = CHANNELS.find((c) => c.type === type);
  if (!found) throw new Error(`unknown channel: ${type}`);
  return found;
}
