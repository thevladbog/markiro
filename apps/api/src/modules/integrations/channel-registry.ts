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
   * входящий, но подключается через отдельные signer-agents эндпоинты
   * (агент подписи предъявляет собственный секрет агента, не эту пару), так
   * что заводить его на эту таблицу означало бы дублировать чужой контракт
   * аутентификации.
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

const commercemlSettings = z
  .object({
    /**
     * Какой тип цены ложится в `products.unit_price`. Пусто — решаем по файлу.
     *
     * Принятое ограничение (final review, Fix 9): раз однажды заданное, это
     * значение нельзя осознанно вернуть обратно в «решаем по файлу» —
     * `.min(1)` не пускает пустую строку как валидное значение, а
     * `IntegrationsService.updateChannel` (integrations.service.ts) трактует
     * ОТСУТСТВИЕ ключа в патче как «не трогать», а не как «очистить». Клиент
     * (`ChannelPage.tsx`) как раз опускает ключ, когда поле формы пустое, так
     * что поле молча возвращает прежнее значение при следующей пересинхронизации
     * формы. Нужна отдельная форма представления «явно не задано» (например,
     * `null`), а не просто более мягкая схема здесь.
     */
    priceType: z.string().min(1).optional(),
    /** Разделять ли списание в свой тип документа (используется в И-2). */
    splitWriteoffDocument: z.boolean().default(false),
    /**
     * Значение `<ХозОперация>` для заявок на списание, когда
     * `splitWriteoffDocument` включён (плана И-2, спека §2/§5: "словарь
     * документов в конфигурациях разный; разделение — настройка, а не
     * допущение"). Без этого значения `splitWriteoffDocument: true` не меняет
     * ничего — `order-export.ts`'s `buildOrdersDocument` падает обратно на
     * единый тип документа по умолчанию, если это поле пусто.
     */
    writeoffDocumentType: z.string().min(1).nullable().optional(),
    /**
     * Название реквизита статуса заказа в ЭТОЙ конфигурации 1С (плана И-2,
     * спека §6). Стандартного названия нет — приёмочный чек-лист
     * (`docs/1c-exchange-acceptance-checklist.md`) прямо называет его
     * неизвестным до первого живого сеанса. Пусто — входящий статус вообще
     * не читается (спека §6: "по умолчанию слой выключен").
     */
    orderStatusField: z.string().min(1).nullable().optional(),
    /**
     * Таблица «внешнее значение реквизита → наш статус» (спека §6: "данные, а
     * не код"). Значение — один из трёх терминальных статусов
     * `pickup_order_status`, никогда `pending` (спека §6: "инварианты
     * жизненного цикла сильнее внешнего статуса" — сопоставление не может
     * протащить заказ назад в `pending`).
     */
    statusMapping: z.record(z.string(), z.enum(["punched", "writtenoff", "cancelled"])).optional(),
  })
  // Review fix (PR #32, item 8): plain `z.object()` silently STRIPS a key it
  // doesn't recognise -- `safeParse` still reports `success: true`, so a
  // typo'd field name (`pricetype`, `priceTyp`) used to come back a clean
  // 200 that changed nothing, the exact "сохранено, ничего не изменилось"
  // this method's own comment already warns about for the empty-patch case.
  // `.strict()` turns an unrecognised key into a validation failure instead.
  .strict();

// `.passthrough()` stays: unlike `commercemlSettings` above, this schema
// declares no fields AT ALL on purpose -- these three channels have no
// settings contract yet, and accepting (not rejecting) an arbitrary shape
// here is the deliberate, already-tested placeholder for that
// (`channel-registry.test.ts`'s "схема другого канала принимает произвольные
// поля"). Item 8's regression was a NAMED field silently swallowing a typo of
// itself (`commercemlSettings`, above); it was never about a channel that
// declares no fields to begin with.
const emptySettings = z.object({}).passthrough();

/**
 * Настройки канала `chestny_znak`. Планировщик (задача 7) разбирает
 * `integration_channels.settings` этой схемой, так что имя экспорта и форма
 * должны совпадать с тем, что он ожидает.
 */
export const chzSignerSettingsSchema = z
  .object({
    environment: z.enum(["production", "sandbox"]).default("production"),
    mchdInn: z
      .string()
      .regex(/^\d{10}(\d{2})?$/)
      .optional(),
  })
  .strict();

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
    available: true,
    inbound: true,
    usesExchangeCredentials: false,
    settingsSchema: chzSignerSettingsSchema,
  },
];

export function describeChannel(type: IntegrationChannelType): ChannelDescriptor {
  const found = CHANNELS.find((c) => c.type === type);
  if (!found) throw new Error(`unknown channel: ${type}`);
  return found;
}
