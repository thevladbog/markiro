import { render, type RenderResult } from "@testing-library/react";
import { vi, type Mock } from "vitest";

import { ThemeProvider } from "@markiro/ui";

import type { HostApi } from "../../src/host/api.js";
import type { OfficeUser } from "../../src/host/protocol.js";
import { Office } from "../../src/office/Office.js";
import type { OfficeSessionValue } from "../../src/office/office-session.js";
import { SESSION } from "./fixtures.js";

/** A `HostApi` of mocks. */
export type FakeHostApi = { [K in keyof HostApi]: Mock<HostApi[K]> };

function unexpected(name: keyof HostApi): Promise<never> {
  return Promise.reject(new Error(`unexpected HostApi.${name} call`));
}

/** Every method a test did not stub fails loudly; `officeLogout` succeeds. */
export function fakeHostApi(overrides: Partial<FakeHostApi> = {}): FakeHostApi {
  return {
    bootstrap: vi.fn<HostApi["bootstrap"]>(() => unexpected("bootstrap")),
    officeLogin: vi.fn<HostApi["officeLogin"]>(() => unexpected("officeLogin")),
    officeLogout: vi.fn<HostApi["officeLogout"]>(async () => undefined),
    officeMe: vi.fn<HostApi["officeMe"]>(() => unexpected("officeMe")),
    officeChangePassword: vi.fn<HostApi["officeChangePassword"]>(() =>
      unexpected("officeChangePassword"),
    ),
    getOrg: vi.fn<HostApi["getOrg"]>(() => unexpected("getOrg")),
    updateOrg: vi.fn<HostApi["updateOrg"]>(() => unexpected("updateOrg")),
    getSscc: vi.fn<HostApi["getSscc"]>(() => unexpected("getSscc")),
    updateSsccCounter: vi.fn<HostApi["updateSsccCounter"]>(() => unexpected("updateSsccCounter")),
    updateBlockSizes: vi.fn<HostApi["updateBlockSizes"]>(() => unexpected("updateBlockSizes")),
    listUsers: vi.fn<HostApi["listUsers"]>(() => unexpected("listUsers")),
    createUser: vi.fn<HostApi["createUser"]>(() => unexpected("createUser")),
    updateUser: vi.fn<HostApi["updateUser"]>(() => unexpected("updateUser")),
    setUserPassword: vi.fn<HostApi["setUserPassword"]>(() => unexpected("setUserPassword")),
    ...overrides,
  };
}

export type FakeOfficeSession = OfficeSessionValue & {
  api: FakeHostApi;
  logout: Mock<OfficeSessionValue["logout"]>;
  refreshUser: Mock<OfficeSessionValue["refreshUser"]>;
};

/** The session value the shell gives the office; `call` passes the fixture token through. */
export function fakeOfficeSession(
  options: { user?: OfficeUser; api?: FakeHostApi } = {},
): FakeOfficeSession {
  return {
    user: options.user ?? SESSION.user,
    api: options.api ?? fakeHostApi(),
    call: <T,>(operation: (token: string) => Promise<T>) => operation(SESSION.token),
    logout: vi.fn<OfficeSessionValue["logout"]>(),
    refreshUser: vi.fn<OfficeSessionValue["refreshUser"]>(async () => undefined),
  };
}

/** The office as the shell renders it, in the dark theme. */
export function renderOffice(session: OfficeSessionValue): RenderResult {
  return render(
    <ThemeProvider defaultTheme="dark">
      <Office session={session} />
    </ThemeProvider>,
  );
}

export const TECHNOLOGIST: OfficeUser = {
  id: "0b7e7dcb-3f56-4c43-9a4b-1f0b3b3f8a21",
  login: "tech",
  name: "Павел Орлов",
  role: "technologist",
};
