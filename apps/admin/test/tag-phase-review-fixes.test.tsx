import { describe, expect, it } from "vitest";

import { chipPhaseFor } from "../src/pages/billing/BillingSections.js";
import { servicePeriodPhase } from "../src/pages/billing/format.js";
import { productStatusPhase } from "../src/pages/catalog/index.js";
import { chzStatusPhase } from "../src/pages/catalog/national-catalog/ChzStatus.js";
import { onlineStationsPhase } from "../src/pages/inventory/InventoryDetailPage.js";
import { lateEventResolutionPhase } from "../src/pages/inventory/InventoryLateEvents.js";
import { boxStatePhase, participantStatePhase } from "../src/pages/inventory/InventoryLivePage.js";
import { INVENTORY_STATUS_TO_PHASE } from "../src/pages/inventory/status.js";

/**
 * Закрепляет пары фаза↔состояние, исправленные при разборе находок ревью
 * задачи 12 (`.superpowers/sdd/briefs/task-12-report.md`, раздел «Правки по
 * находкам ревью»). Каждый барьер `.not.toBe(...)` фиксирует прежнее
 * неверное значение, чтобы случайная перестановка веток не прошла
 * незамеченной.
 */
describe("находка 1: период обслуживания — три состояния, не два", () => {
  it("предстоящий период получает ожидание, а не вывод из оборота", () => {
    expect(servicePeriodPhase("upcoming", false)).toBe("planned");
    expect(servicePeriodPhase("upcoming", false)).not.toBe("retired");
  });

  it("действующий период получает active", () => {
    expect(servicePeriodPhase("active", false)).toBe("active");
  });

  it("завершённый период получает done, а не вывод из оборота", () => {
    expect(servicePeriodPhase("expired", false)).toBe("done");
    expect(servicePeriodPhase("expired", false)).not.toBe("retired");
  });

  it("исчерпанный активный период остаётся отдельным случаем attention", () => {
    expect(servicePeriodPhase("active", true)).toBe("attention");
    expect(servicePeriodPhase("active", true)).not.toBe("active");
    expect(servicePeriodPhase("active", true)).not.toBe("retired");
  });
});

describe("находка 2: короб живого хода — три состояния, не два", () => {
  it("открытый короб идёт прямо сейчас", () => {
    expect(boxStatePhase("open")).toBe("active");
  });

  it("закрытый короб завершён штатно, а не идёт прямо сейчас", () => {
    expect(boxStatePhase("closed")).toBe("done");
    expect(boxStatePhase("closed")).not.toBe("active");
  });

  it("аннулированный короб остаётся ошибкой", () => {
    expect(boxStatePhase("invalidated")).toBe("failed");
  });
});

describe("находка 3: статусы национального каталога — пять значений, не одно серое", () => {
  it("черновик получает выделенную фазу, а не отсутствие значения", () => {
    expect(chzStatusPhase("draft")).toBe("draft");
    expect(chzStatusPhase("draft")).not.toBe("none");
  });

  it("модерация — идущий процесс с неизвестным исходом", () => {
    expect(chzStatusPhase("moderation")).toBe("running");
    expect(chzStatusPhase("moderation")).not.toBe("none");
  });

  it("неподписанный статус требует действия", () => {
    expect(chzStatusPhase("unsigned")).toBe("attention");
    expect(chzStatusPhase("unsigned")).not.toBe("none");
  });

  it("архив выведен из оборота, как и в каталоге товаров", () => {
    expect(chzStatusPhase("archived")).toBe("retired");
    expect(chzStatusPhase("archived")).not.toBe("none");
  });

  it("неизвестный статус — единственный законный none здесь", () => {
    expect(chzStatusPhase("unknown")).toBe("none");
  });

  it("published и errors остаются терминальными фазами", () => {
    expect(chzStatusPhase("published")).toBe("done");
    expect(chzStatusPhase("errors")).toBe("failed");
  });
});

describe("находка 4: черновик товара — не тревога", () => {
  it("активный товар получает active", () => {
    expect(productStatusPhase("active")).toBe("active");
  });

  it("черновик получает выделенную фазу draft, а не attention", () => {
    expect(productStatusPhase("draft")).toBe("draft");
    expect(productStatusPhase("draft")).not.toBe("attention");
  });
});

describe("находка 5: ноль онлайн-терминалов блокирует, а не отсутствует", () => {
  it("ноль онлайн-станций требует внимания, а не читается как «нет значения»", () => {
    expect(onlineStationsPhase(0)).toBe("attention");
    expect(onlineStationsPhase(0)).not.toBe("none");
  });

  it("хотя бы одна онлайн-станция — active", () => {
    expect(onlineStationsPhase(1)).toBe("active");
  });
});

describe("находка 6: подготовка инвентаризации — критерий явный", () => {
  it("preparing — системная обработка с исходом, не известным заранее", () => {
    expect(INVENTORY_STATUS_TO_PHASE.preparing).toBe("running");
  });

  it("буквальный статус running остаётся человеческой работой на линии, не системным running", () => {
    expect(INVENTORY_STATUS_TO_PHASE.running).toBe("active");
    expect(INVENTORY_STATUS_TO_PHASE.running).not.toBe("running");
  });
});

describe("спорная пара: участник инвентаризации left", () => {
  it("штатно завершивший участие терминал получает done, а не retired и не none", () => {
    expect(participantStatePhase("left")).toBe("done");
    expect(participantStatePhase("left")).not.toBe("retired");
    expect(participantStatePhase("left")).not.toBe("none");
  });
});

describe("minor: исключённое позднее событие выведено человеком", () => {
  it("discarded получает retired, а не done", () => {
    expect(lateEventResolutionPhase("discarded")).toBe("retired");
    expect(lateEventResolutionPhase("discarded")).not.toBe("done");
  });

  it("pending и replayed остаются прежними", () => {
    expect(lateEventResolutionPhase("pending")).toBe("attention");
    expect(lateEventResolutionPhase("replayed")).toBe("done");
  });
});

describe("minor: неподключённый биллинг-канал — none, а не attention", () => {
  it("unmanaged не требует вмешательства, которого не существует", () => {
    expect(chipPhaseFor("unmanaged")).toBe("none");
    expect(chipPhaseFor("unmanaged")).not.toBe("attention");
  });
});
