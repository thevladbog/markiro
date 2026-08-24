import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CABINET_CAPABILITY } from "@markiro/domain";

import type { AccessDocument } from "../src/access/api.js";
import { AccessProvider } from "../src/access/context.js";
import type * as KiosksApiModule from "../src/pages/kiosks/api.js";
import { ReasonsPage } from "../src/pages/pickup/ReasonsPage.js";

const { writeHookMountSpy } = vi.hoisted(() => ({ writeHookMountSpy: vi.fn() }));

vi.mock("../src/pages/kiosks/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof KiosksApiModule>();
  return {
    ...actual,
    useCreateReason: () => {
      writeHookMountSpy("create-reason");
      return actual.useCreateReason();
    },
    useUpdateReason: () => {
      writeHookMountSpy("update-reason");
      return actual.useUpdateReason();
    },
    useArchiveReason: () => {
      writeHookMountSpy("archive-reason");
      return actual.useArchiveReason();
    },
  };
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  writeHookMountSpy.mockClear();
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const OPERATIONS_READ_ONLY: AccessDocument = {
  roles: [],
  capabilities: [CABINET_CAPABILITY.OPERATIONS_READ],
};

const REASON_A = { id: "r1", name: "Испорчен товар", sortOrder: 1 };

function renderReasonsPage(access: AccessDocument) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <AccessProvider value={access}>
        <MemoryRouter initialEntries={["/pickup/reasons"]}>
          <ReasonsPage />
        </MemoryRouter>
      </AccessProvider>
    </QueryClientProvider>,
  );
}

describe("ReasonsPage access", () => {
  it("does not mount reason mutations for read-only reasons access", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(200, { items: [REASON_A] })),
    );
    renderReasonsPage(OPERATIONS_READ_ONLY);

    expect(await screen.findByText(REASON_A.name)).toBeDefined();
    expect(writeHookMountSpy).not.toHaveBeenCalled();
  });
});
