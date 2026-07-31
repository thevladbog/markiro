import { randomUUID } from "node:crypto";
import type { Response } from "express";
import { describe, expect, it, vi } from "vitest";
import { ExchangeController } from "../src/modules/exchange/exchange.controller";

describe("sale import failure boundary", () => {
  it("does not swallow a transient status-application error or advance the cursor", async () => {
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(async () => [
            {
              settings: {
                orderStatusField: "СтатусЗаказа",
                statusMapping: { Оплачен: "punched" },
              },
            },
          ]),
        })),
      })),
    };
    const sessions = {
      readSaleImportCursor: vi.fn(async () => null),
      writeSaleImportCursor: vi.fn(async () => undefined),
    };
    const journal = { append: vi.fn(async () => undefined) };
    const transient = new Error("database unavailable");
    const pickupOrders = {
      applyExternalStatus: vi.fn(async () => Promise.reject(transient)),
    };
    const controller = new ExchangeController(
      db as never,
      sessions as never,
      journal as never,
      pickupOrders as never,
    );
    const orderId = randomUUID();
    const bytes = Buffer.from(
      `<?xml version="1.0" encoding="UTF-8"?><КоммерческаяИнформация><ПакетДокументов><Документ><Ид>${orderId}</Ид><ЗначенияРеквизитов><ЗначениеРеквизита><Наименование>СтатусЗаказа</Наименование><Значение>Оплачен</Значение></ЗначениеРеквизита></ЗначенияРеквизитов></Документ></ПакетДокументов></КоммерческаяИнформация>`,
    );
    const importOrderStatuses = (
      controller as unknown as {
        importOrderStatuses: (
          session: { id: string; tenantId: string; channelType: "commerceml" },
          filename: string,
          body: Buffer,
          response: Response,
        ) => Promise<void>;
      }
    ).importOrderStatuses.bind(controller);

    await expect(
      importOrderStatuses(
        { id: randomUUID(), tenantId: randomUUID(), channelType: "commerceml" },
        "sale.xml",
        bytes,
        {} as Response,
      ),
    ).rejects.toBe(transient);
    expect(sessions.writeSaleImportCursor).not.toHaveBeenCalled();
  });

  it("treats an already-applied prefix as idempotent after a mid-batch retry", async () => {
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(async () => [
            {
              settings: {
                orderStatusField: "СтатусЗаказа",
                statusMapping: { Оплачен: "punched" },
              },
            },
          ]),
        })),
      })),
    };
    const sessions = {
      readSaleImportCursor: vi.fn(async () => null),
      writeSaleImportCursor: vi.fn(async () => undefined),
    };
    const journal = { append: vi.fn(async () => undefined) };
    const transient = new Error("database unavailable after the first row");
    const pickupOrders = {
      applyExternalStatus: vi
        .fn()
        .mockResolvedValueOnce({ outcome: "applied" })
        .mockRejectedValueOnce(transient)
        .mockResolvedValueOnce({ outcome: "not_pending", currentStatus: "punched" })
        .mockResolvedValueOnce({ outcome: "applied" }),
    };
    const controller = new ExchangeController(
      db as never,
      sessions as never,
      journal as never,
      pickupOrders as never,
    );
    const orderIds = [randomUUID(), randomUUID()];
    const documents = orderIds
      .map(
        (id) =>
          `<Документ><Ид>${id}</Ид><ЗначенияРеквизитов><ЗначениеРеквизита>` +
          "<Наименование>СтатусЗаказа</Наименование><Значение>Оплачен</Значение>" +
          "</ЗначениеРеквизита></ЗначенияРеквизитов></Документ>",
      )
      .join("");
    const bytes = Buffer.from(
      `<?xml version="1.0" encoding="UTF-8"?><КоммерческаяИнформация><ПакетДокументов>${documents}</ПакетДокументов></КоммерческаяИнформация>`,
    );
    const importOrderStatuses = (
      controller as unknown as {
        importOrderStatuses: (
          session: { id: string; tenantId: string; channelType: "commerceml" },
          filename: string,
          body: Buffer,
          response: Response,
        ) => Promise<void>;
      }
    ).importOrderStatuses.bind(controller);
    const session = {
      id: randomUUID(),
      tenantId: randomUUID(),
      channelType: "commerceml",
    } as const;

    await expect(importOrderStatuses(session, "sale.xml", bytes, {} as Response)).rejects.toBe(
      transient,
    );
    expect(sessions.writeSaleImportCursor).not.toHaveBeenCalled();

    const send = vi.fn();
    const type = vi.fn(() => ({ send }));
    const status = vi.fn(() => ({ type }));
    await importOrderStatuses(session, "sale.xml", bytes, { status } as unknown as Response);

    expect(sessions.writeSaleImportCursor).toHaveBeenCalledWith(
      session.id,
      "sale.xml",
      expect.objectContaining({ applied: 2, discrepancies: 0, completed: true }),
    );
    expect(send).toHaveBeenCalledWith("success");
  });
});
