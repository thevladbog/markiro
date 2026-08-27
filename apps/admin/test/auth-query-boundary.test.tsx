import { useQuery } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { StrictMode, useEffect } from "react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CABINET_CAPABILITY } from "@markiro/domain";
import { ThemeProvider } from "@markiro/ui";

import {
  AuthClientProvider,
  type AuthClientLike,
  type OrganizationSummary,
  type SessionData,
} from "../src/auth/client.js";
import { AuthQueryBoundary } from "../src/query/AuthQueryBoundary.js";
import { ShellPage } from "../src/pages/Shell.js";

interface TenantSecret {
  value: string;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

const ADMIN_ACCESS = {
  roles: ["admin"],
  capabilities: [
    CABINET_CAPABILITY.OPERATIONS_READ,
    CABINET_CAPABILITY.OPERATIONS_WRITE,
    CABINET_CAPABILITY.INTEGRATIONS_READ,
    CABINET_CAPABILITY.INTEGRATIONS_WRITE,
    CABINET_CAPABILITY.TENANT_SETTINGS_MANAGE,
    CABINET_CAPABILITY.BILLING_READ,
    CABINET_CAPABILITY.BILLING_REQUEST,
    CABINET_CAPABILITY.CREDENTIALS_MANAGE,
  ],
};

const MANAGER_ACCESS = {
  roles: ["manager"],
  capabilities: [CABINET_CAPABILITY.OPERATIONS_READ, CABINET_CAPABILITY.OPERATIONS_WRITE],
};

const MEMBER_ACCESS = { roles: ["member"], capabilities: [] };

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function session(userId: string, organizationId: string): SessionData {
  return {
    session: { activeOrganizationId: organizationId },
    user: { id: userId, email: `${userId}@example.com`, name: userId },
  };
}

function createFakeAuthClient(readSession: () => SessionData): AuthClientLike {
  const organizations: OrganizationSummary[] = [
    { id: "org_a", name: "Organization A", slug: "organization-a" },
    { id: "org_b", name: "Organization B", slug: "organization-b" },
  ];

  return {
    useSession: () => ({ data: readSession(), isPending: false, error: null }),
    useListOrganizations: () => ({ data: organizations, isPending: false, error: null }),
    signIn: { email: async () => ({ data: {}, error: null }) },
    signUp: { email: async () => ({ data: {}, error: null }) },
    resetPassword: async () => ({ data: { status: true }, error: null }),
    signOut: async () => ({ data: {}, error: null }),
    organization: {
      create: async () => ({ data: { id: "org_a" }, error: null }),
      list: async () => ({ data: organizations, error: null }),
      setActive: async () => ({ data: {}, error: null }),
    },
  };
}

function TenantSecretProbe({ onMount }: { onMount: () => void }) {
  const secret = useQuery({
    queryKey: ["tenant-secret"],
    queryFn: async (): Promise<TenantSecret> => {
      const response = await fetch("/api/tenant-secret");
      return (await response.json()) as TenantSecret;
    },
  });

  useEffect(() => {
    onMount();
  }, [onMount]);

  if (secret.isPending) return <div data-testid="tenant-secret-pending" />;
  return <div data-testid="tenant-secret">{secret.data?.value}</div>;
}

function renderBoundary(client: AuthClientLike, onProbeMount: () => void) {
  const tree = () => (
    <StrictMode>
      <ThemeProvider defaultTheme="light">
        <MemoryRouter initialEntries={["/"]}>
          <AuthClientProvider client={client}>
            <AuthQueryBoundary>
              <Routes>
                <Route path="/" element={<ShellPage />}>
                  <Route index element={<TenantSecretProbe onMount={onProbeMount} />} />
                </Route>
                <Route path="/login" element={<div>LOGIN_PAGE</div>} />
                <Route path="/org/select" element={<div>ORG_SELECT_PAGE</div>} />
              </Routes>
            </AuthQueryBoundary>
          </AuthClientProvider>
        </MemoryRouter>
      </ThemeProvider>
    </StrictMode>
  );

  const view = render(tree());
  return { ...view, rerenderBoundary: () => view.rerender(tree()) };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("AuthQueryBoundary", () => {
  it("does not expose admin A cache or mount protected queries for member B in the same organization", async () => {
    let activeSession = session("admin_a", "org_a");
    const nextAccess = deferred<Response>();
    const accessResponses: Array<Response | Promise<Response>> = [
      jsonResponse(200, ADMIN_ACCESS),
      nextAccess.promise,
    ];
    let tenantRequests = 0;
    let probeMounts = 0;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/profile")) {
          return jsonResponse(200, {
            firstName: "Test",
            lastName: "User",
            middleName: null,
            hasAvatar: false,
          });
        }
        if (url.endsWith("/api/access/me")) return await accessResponses.shift()!;
        if (url.includes("/api/pickup-orders")) return jsonResponse(200, { items: [] });
        if (url.endsWith("/api/tenant-secret")) {
          tenantRequests += 1;
          return jsonResponse(200, { value: "ADMIN_A_SECRET" });
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );

    const client = createFakeAuthClient(() => activeSession);
    const view = renderBoundary(client, () => {
      probeMounts += 1;
    });

    expect(await screen.findByText("ADMIN_A_SECRET")).toBeDefined();
    const mountsBeforeTransition = probeMounts;

    activeSession = session("member_b", "org_a");
    view.rerenderBoundary();

    expect(screen.queryByText("ADMIN_A_SECRET")).toBeNull();
    expect(screen.queryByTestId("tenant-secret")).toBeNull();
    expect(screen.queryByRole("link", { name: "Обзор" })).toBeNull();
    expect(tenantRequests).toBe(1);
    expect(probeMounts).toBe(mountsBeforeTransition);

    nextAccess.resolve(jsonResponse(200, MEMBER_ACCESS));
    expect(await screen.findByText("Доступ к кабинету пока не открыт")).toBeDefined();
    expect(tenantRequests).toBe(1);
    expect(probeMounts).toBe(mountsBeforeTransition);
  });

  it("waits for manager B access and fetches fresh tenant data instead of rendering admin A cache", async () => {
    let activeSession = session("admin_a", "org_a");
    const nextAccess = deferred<Response>();
    const nextSecret = deferred<Response>();
    const accessResponses: Array<Response | Promise<Response>> = [
      jsonResponse(200, ADMIN_ACCESS),
      nextAccess.promise,
    ];
    const secretResponses: Array<Response | Promise<Response>> = [
      jsonResponse(200, { value: "ADMIN_A_SECRET" }),
      nextSecret.promise,
    ];
    let tenantRequests = 0;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/profile")) {
          return jsonResponse(200, {
            firstName: "Test",
            lastName: "User",
            middleName: null,
            hasAvatar: false,
          });
        }
        if (url.endsWith("/api/access/me")) return await accessResponses.shift()!;
        if (url.includes("/api/pickup-orders")) return jsonResponse(200, { items: [] });
        if (url.endsWith("/api/tenant-secret")) {
          tenantRequests += 1;
          return await secretResponses.shift()!;
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );

    const client = createFakeAuthClient(() => activeSession);
    const view = renderBoundary(client, () => undefined);
    expect(await screen.findByText("ADMIN_A_SECRET")).toBeDefined();

    activeSession = session("manager_b", "org_a");
    view.rerenderBoundary();

    expect(screen.queryByText("ADMIN_A_SECRET")).toBeNull();
    expect(screen.queryByTestId("tenant-secret")).toBeNull();
    expect(tenantRequests).toBe(1);

    nextAccess.resolve(jsonResponse(200, MANAGER_ACCESS));
    await waitFor(() => expect(tenantRequests).toBe(2));
    expect(screen.queryByText("ADMIN_A_SECRET")).toBeNull();
    expect(screen.getByTestId("tenant-secret-pending")).toBeDefined();

    nextSecret.resolve(jsonResponse(200, { value: "MANAGER_B_SECRET" }));
    expect(await screen.findByText("MANAGER_B_SECRET")).toBeDefined();
  });

  it("waits for fresh access and tenant data when the active organization changes", async () => {
    let activeSession = session("admin_a", "org_a");
    const nextAccess = deferred<Response>();
    const nextSecret = deferred<Response>();
    const accessResponses: Array<Response | Promise<Response>> = [
      jsonResponse(200, ADMIN_ACCESS),
      nextAccess.promise,
    ];
    const secretResponses: Array<Response | Promise<Response>> = [
      jsonResponse(200, { value: "ORG_A_SECRET" }),
      nextSecret.promise,
    ];
    let tenantRequests = 0;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/profile")) {
          return jsonResponse(200, {
            firstName: "Test",
            lastName: "User",
            middleName: null,
            hasAvatar: false,
          });
        }
        if (url.endsWith("/api/access/me")) return await accessResponses.shift()!;
        if (url.includes("/api/pickup-orders")) return jsonResponse(200, { items: [] });
        if (url.endsWith("/api/tenant-secret")) {
          tenantRequests += 1;
          return await secretResponses.shift()!;
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );

    const client = createFakeAuthClient(() => activeSession);
    const view = renderBoundary(client, () => undefined);
    expect(await screen.findByText("ORG_A_SECRET")).toBeDefined();

    activeSession = session("admin_a", "org_b");
    view.rerenderBoundary();

    expect(screen.queryByText("ORG_A_SECRET")).toBeNull();
    expect(screen.queryByTestId("tenant-secret")).toBeNull();
    expect(tenantRequests).toBe(1);

    nextAccess.resolve(jsonResponse(200, ADMIN_ACCESS));
    await waitFor(() => expect(tenantRequests).toBe(2));
    expect(screen.queryByText("ORG_A_SECRET")).toBeNull();

    nextSecret.resolve(jsonResponse(200, { value: "ORG_B_SECRET" }));
    expect(await screen.findByText("ORG_B_SECRET")).toBeDefined();
  });
});
