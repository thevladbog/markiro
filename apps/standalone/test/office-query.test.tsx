import { QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { HostError } from "../src/host/client.js";
import type { OrgProfile } from "../src/host/protocol.js";
import {
  createOfficeQueryClient,
  officeKeys,
  useOfficeMutation,
  useOfficeQuery,
} from "../src/office/office-query.js";
import { OfficeSessionProvider, type OfficeSessionValue } from "../src/office/office-session.js";
import { fakeOfficeSession } from "./support/office.js";

const PROFILE: OrgProfile = {
  name: "ООО «Атолл»",
  inn: null,
  gln: "4600682000013",
  gs1Prefixes: [],
  timeZone: "Europe/Moscow",
  rev: 4,
};

function wrapperFor(session: OfficeSessionValue) {
  const client = createOfficeQueryClient();
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>
        <OfficeSessionProvider value={session}>{children}</OfficeSessionProvider>
      </QueryClientProvider>
    );
  };
}

describe("useOfficeQuery", () => {
  it("reads through the session's call with its api and token", async () => {
    const session = fakeOfficeSession();
    session.api.getOrg.mockResolvedValue(PROFILE);
    const call = vi.spyOn(session, "call");
    const { result } = renderHook(
      () => useOfficeQuery(officeKeys.org, (api, token) => api.getOrg(token)),
      { wrapper: wrapperFor(session) },
    );
    await waitFor(() => expect(result.current.data).toEqual(PROFILE));
    expect(call).toHaveBeenCalledTimes(1);
    expect(session.api.getOrg).toHaveBeenCalledWith("office-session-token");
  });

  it("does not retry a failed read: the page explains it and offers a retry", async () => {
    const failure = new HostError({ kind: "api", code: "internal", status: 500, message: "boom" });
    const session = fakeOfficeSession();
    session.api.getOrg.mockRejectedValue(failure);
    const { result } = renderHook(
      () => useOfficeQuery(officeKeys.org, (api, token) => api.getOrg(token)),
      { wrapper: wrapperFor(session) },
    );
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toBe(failure);
    expect(session.api.getOrg).toHaveBeenCalledTimes(1);
  });
});

describe("useOfficeMutation", () => {
  it("writes through the session's call", async () => {
    const session = fakeOfficeSession();
    session.api.updateOrg.mockResolvedValue({ ...PROFILE, rev: 5 });
    const call = vi.spyOn(session, "call");
    const { result } = renderHook(
      () =>
        useOfficeMutation((api, token, expectedRev: number) =>
          api.updateOrg(token, {
            name: PROFILE.name,
            inn: null,
            gln: PROFILE.gln,
            gs1Prefixes: [],
            timeZone: PROFILE.timeZone,
            expectedRev,
          }),
        ),
      { wrapper: wrapperFor(session) },
    );
    await act(async () => {
      await expect(result.current.mutateAsync(4)).resolves.toMatchObject({ rev: 5 });
    });
    expect(call).toHaveBeenCalledTimes(1);
    expect(session.api.updateOrg).toHaveBeenCalledWith(
      "office-session-token",
      expect.objectContaining({ expectedRev: 4 }),
    );
  });
});
