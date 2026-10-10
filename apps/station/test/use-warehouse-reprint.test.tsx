import { DatabaseSync } from "node:sqlite";
import { act, renderHook, waitFor } from "@testing-library/react";
import { expect, it } from "vitest";
import { productLabelValueDigest, WAREHOUSE_REPRINT_PROTOCOL } from "@markiro/domain";
import { applyMigrations } from "../src/lib/mirror";
import { makeRotatingExec } from "./support/sqlite-exec";
import {
  createCredentialGeneration,
  credentialGenerationOwnership,
  createFloorWorkRegistry,
} from "../src/lib/credential-recovery";
import type { StationClient } from "../src/lib/api-client";
import { useWarehouseReprint } from "../src/lib/use-warehouse-reprint";
import {
  readWarehouseJob,
  saveWarehouseSession,
  prepareWarehouseJob,
} from "../src/lib/warehouse-reprint/store";
import { warehousePreparedJobInput, seedWarehouseOperator } from "./support/warehouse-reprint";

async function fixture() {
  const db = new DatabaseSync(":memory:");
  const exec = makeRotatingExec([db, db]);
  await applyMigrations(exec);
  const generation = createCredentialGeneration("hook-print-key");
  const owner = await credentialGenerationOwnership(generation);
  if (!owner) throw new Error("owner");
  const input = { ...warehousePreparedJobInput(), owner };
  await seedWarehouseOperator(exec, input.operatorId);
  await saveWarehouseSession(exec, {
    owner,
    sessionId: input.sessionId,
    operatorId: input.operatorId,
    reason: input.reason,
    status: "active",
    unitTemplate: null,
    boxTemplate: input.template,
  });
  await prepareWarehouseJob(exec, input);
  let complete: () => void = () => {};
  const transport = new Promise<void>((resolve) => {
    complete = resolve;
  });
  let calls = 0;
  let catalogCalls = 0;
  const client: StationClient = {
    get: async <T,>(path: string) => {
      if (path === "/shifts/box-label-templates")
        return { items: [], defaultBoxLabelTemplateId: null, defaultSource: null } as T;
      catalogCalls += 1;
      return {
        protocol: WAREHOUSE_REPRINT_PROTOCOL,
        revision: productLabelValueDigest([input.template]),
        templates: [input.template],
      } as T;
    },
    post: async () => {
      throw new Error("unexpected POST");
    },
    download: async () => {
      throw new Error("unexpected download");
    },
    whoami: async () => ({ ok: true }),
  };
  const options = {
    exec,
    client,
    generation,
    deviceId: input.deviceId,
    operatorId: input.operatorId,
    hardware: () => ({
      scanner: null,
      printer: input.printer.target,
      printerLanguage: "tspl" as const,
      printerDpi: 203 as const,
      verifyPrintedLabel: false,
    }),
    print: async () => {
      calls += 1;
      await transport;
    },
  };
  const registry = createFloorWorkRegistry();
  return {
    db,
    exec,
    input,
    options,
    complete,
    registry,
    register: registry.register.bind(registry),
    calls: () => calls,
    catalogCalls: () => catalogCalls,
  };
}

it("keeps the live print and lifecycle barrier when the API client object changes", async () => {
  const f = await fixture();
  const view = renderHook(
    ({ client }) => useWarehouseReprint({ ...f.options, client }, f.register),
    {
      initialProps: { client: f.options.client },
    },
  );
  let sending = Promise.resolve();
  const original = view.result.current.work;
  try {
    await act(async () => {
      await original.idle();
    });
    expect(view.result.current.state.initialized).toBe(true);
    act(() => {
      sending = original.sendPrepared();
    });
    await waitFor(() => expect(f.calls()).toBe(1));
    view.rerender({ client: { ...f.options.client } });
    expect(view.result.current.work).toBe(original);
    expect([...f.registry.current()]).toEqual([original]);
    expect((await readWarehouseJob(f.exec, f.input.owner, f.input.jobId)).projection.state).toBe(
      "sending",
    );
    await act(async () => {
      f.complete();
      await sending;
    });
    expect(view.result.current.state.job?.state).toBe("sent");
    expect(view.result.current.state.error).toBeNull();
    expect(f.catalogCalls()).toBe(1);
    expect(f.calls()).toBe(1);
  } finally {
    await act(async () => {
      f.complete();
      await sending;
    });
    view.unmount();
    await original.close();
    f.db.close();
  }
});

it("drains a removed controller before remount recovery without replacing its transport result", async () => {
  const f = await fixture();
  const first = renderHook(() => useWarehouseReprint(f.options, f.register));
  const original = first.result.current.work;
  let sending = Promise.resolve();
  try {
    await act(async () => {
      await original.idle();
    });
    expect(first.result.current.state.initialized).toBe(true);
    act(() => {
      sending = original.sendPrepared();
    });
    await waitFor(() => expect(f.calls()).toBe(1));
    first.unmount();
    const remounted = renderHook(() => useWarehouseReprint(f.options, f.register));
    try {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
      expect((await readWarehouseJob(f.exec, f.input.owner, f.input.jobId)).projection.state).toBe(
        "sending",
      );
      expect(remounted.result.current.state.initialized).toBe(false);
      expect([...f.registry.current()]).toContain(original);
      await act(async () => {
        f.complete();
        await sending;
      });
      await waitFor(() => expect(remounted.result.current.state.initialized).toBe(true));
      expect(remounted.result.current.state.job?.state).toBe("sent");
      expect(remounted.result.current.state.error).toBeNull();
      expect(f.calls()).toBe(1);
      expect(
        await f.exec.all(
          "SELECT json_extract(event_json,'$.kind') AS kind FROM warehouse_reprint_events ORDER BY sequence",
        ),
      ).toEqual([{ kind: "prepared" }, { kind: "sending" }, { kind: "sent" }]);
    } finally {
      await act(async () => {
        f.complete();
        await sending;
        await remounted.result.current.work.idle();
      });
      remounted.unmount();
      await remounted.result.current.work.close();
    }
  } finally {
    f.complete();
    await sending;
    first.unmount();
    await original.close();
    f.db.close();
  }
});
