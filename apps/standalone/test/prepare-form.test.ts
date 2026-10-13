import { readFileSync } from "node:fs";

import type * as Domain from "@markiro/domain";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  boxReportRowsSchema,
  palletReportRowsSchema,
  type CounterpartyRecord,
} from "../src/host/protocol.js";
import { prepareForm, renderForm, type FormRequest } from "../src/office/forms/render-form.js";
import { taskFormInputs } from "../src/office/forms/task-inputs.js";
import { ORG_PROFILE } from "./support/office.js";
import { ACTIVE, LINE_10, LINE_2, MILK, NORTH, PLANNED, WATER } from "./support/shifts.js";

// The domain's box form, counted: what `prepareForm` must not call.
const drawn = vi.hoisted(() => ({ box: 0 }));
vi.mock("@markiro/domain", async (original) => {
  const domain = await original<typeof Domain>();
  return {
    ...domain,
    renderBoxReportHtml: (...args: Parameters<typeof domain.renderBoxReportHtml>) => {
      drawn.box += 1;
      return domain.renderBoxReportHtml(...args);
    },
  };
});

// Through a variable: Vite would take `new URL(…, import.meta.url)` for an asset.
const testModuleUrl = import.meta.url;
function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../proto/fixtures/${name}`, testModuleUrl), "utf8"));
}
const BOX_ROWS = boxReportRowsSchema.parse(fixture("box-report-rows.json"));
const PALLET_ROWS = palletReportRowsSchema.parse(fixture("pallet-report-rows.json"));

beforeEach(() => {
  drawn.box = 0;
});

describe("preparing a form apart from drawing it (plan О-Ф)", () => {
  it("draws nothing until it is told to, and draws what renderForm draws", () => {
    const request = { kind: "box", rows: BOX_ROWS, timeZone: "Europe/Moscow" } as const;
    const prepared = prepareForm(request);
    expect(prepared).not.toBeNull();
    expect(drawn.box).toBe(0);
    const html = prepared?.draw();
    expect(drawn.box).toBe(1);
    expect(html).toBe(renderForm(request)?.html);
    expect(prepared?.fileName).toBe(renderForm(request)?.fileName);
    expect(prepared?.kind).toBe("box");
  });

  it("refuses what the cloud refuses, as renderForm does", () => {
    const missing = {
      kind: "pallet",
      rows: PALLET_ROWS,
      palletId: "none",
      timeZone: "UTC",
    } as const;
    expect(prepareForm(missing)).toBeNull();
    expect(renderForm(missing)).toBeNull();
    const none: FormRequest = {
      kind: "placards",
      rows: { ...PALLET_ROWS, pallets: [] },
      format: "a4",
    };
    expect(prepareForm(none)).toBeNull();
  });
});

describe("the records a blank is drawn from (plan О-Ф)", () => {
  const north: CounterpartyRecord = NORTH;

  it("takes the shift's own product, line, counterparty and the organization", () => {
    expect(
      taskFormInputs(ACTIVE, [WATER, MILK], [LINE_10, LINE_2], [north], ORG_PROFILE, null),
    ).toEqual({
      shift: ACTIVE,
      product: MILK,
      line: LINE_2,
      counterparty: north,
      organization: ORG_PROFILE,
      photo: null,
    });
  });

  it("names no counterparty for a shift with none, and reads none for it", () => {
    expect(
      taskFormInputs(PLANNED, [WATER], [LINE_10], [], ORG_PROFILE, null)?.counterparty,
    ).toBeNull();
  });

  it("reads the product's photo when it has one, waits for it, and goes without it when it does not read (plan ТОВ)", () => {
    const photo = {
      width: 2,
      height: 1,
      dataBase64: "/9j/4AAQSkZJRgABAQ==",
      checksum: "ae0e381fa858d6782d6859eb9337b80e670dc0021361fdd55d49299f1b4c26fd",
      updatedAt: "2026-10-13T09:00:00.000Z",
    };
    const pictured = { ...MILK, photoChecksum: photo.checksum };
    const read = (given: typeof photo | null | undefined) =>
      taskFormInputs(ACTIVE, [pictured], [LINE_2], [north], ORG_PROFILE, given);
    expect(read(photo)?.photo).toEqual(photo);
    // Still reading: the blank waits, as for every record it names.
    expect(read(undefined)).toBeNull();
    // Not read: the blank goes without it.
    expect(read(null)?.photo).toBeNull();
    // A product without a photo never waits for one.
    expect(
      taskFormInputs(ACTIVE, [MILK], [LINE_2], [north], ORG_PROFILE, undefined)?.photo,
    ).toBeNull();
    expect(taskFormInputs(ACTIVE, [MILK], [LINE_2], [north], ORG_PROFILE, photo)?.photo).toBeNull();
  });

  it("is nothing while any record it names is not read", () => {
    expect(taskFormInputs(ACTIVE, undefined, [LINE_2], [north], ORG_PROFILE, null)).toBeNull();
    expect(taskFormInputs(ACTIVE, [MILK], undefined, [north], ORG_PROFILE, null)).toBeNull();
    expect(taskFormInputs(ACTIVE, [MILK], [LINE_2], undefined, ORG_PROFILE, null)).toBeNull();
    expect(taskFormInputs(ACTIVE, [MILK], [LINE_2], [north], undefined, null)).toBeNull();
    // A record the list lacks is not read either.
    expect(taskFormInputs(ACTIVE, [WATER], [LINE_2], [north], ORG_PROFILE, null)).toBeNull();
    expect(taskFormInputs(ACTIVE, [MILK], [LINE_10], [north], ORG_PROFILE, null)).toBeNull();
    expect(taskFormInputs(ACTIVE, [MILK], [LINE_2], [], ORG_PROFILE, null)).toBeNull();
  });
});
