import { describe, expect, it } from "vitest";

import {
  TrueApiClient,
  type TrueApiClientDependencies,
} from "../src/modules/chz-exports/true-api.client";

const auth = { baseUrl: "https://markirovka.sandbox.crptech.ru/api/v3/true-api", token: "t0ken" };

function deps(fetchImpl: TrueApiClientDependencies["fetch"]): TrueApiClientDependencies {
  return { fetch: fetchImpl, scheduleAbort: () => () => {} };
}

describe("TrueApiClient", () => {
  it("orders a filtered CIS report with the params object encoded as a string", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const client = new TrueApiClient(
      deps(async (url, init) => {
        calls.push({ url: String(url), init: init as RequestInit });
        return new Response(JSON.stringify({ taskId: "task-1" }), { status: 200 });
      }),
    );

    const result = await client.createDispenserTask(auth, {
      participantInn: "7700000000",
      productGroupCode: 8,
      chzStatus: "EMITTED",
      gtins: ["04600000000017"],
    });

    expect(result).toEqual({ status: "ok", value: { taskId: "task-1" } });
    expect(calls[0]!.url).toBe(`${auth.baseUrl}/dispenser/tasks`);
    const headers = new Headers(calls[0]!.init.headers);
    expect(headers.get("Authorization")).toBe("Bearer t0ken");

    const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>;
    expect(body.productGroupCode).toBe(8);
    expect(body.periodicity).toBe("SINGLE");
    // `params` travels as a STRING, not a nested object -- this is the part of
    // the dispenser contract that is easy to get wrong and silent when wrong.
    expect(typeof body.params).toBe("string");
    expect(JSON.parse(body.params as string)).toMatchObject({
      participantInn: "7700000000",
      status: "EMITTED",
      includeGtin: ["04600000000017"],
    });
  });

  it("maps 401 to unauthorized so the caller can refuse instead of retrying", async () => {
    const client = new TrueApiClient(deps(async () => new Response("", { status: 401 })));
    await expect(client.listDispenserResults(auth, ["task-1"])).resolves.toEqual({
      status: "unauthorized",
    });
  });

  it("maps 403 to a terminal rejection carrying ChZ's own message, not to unauthorized", async () => {
    // True API answers 403 for "no active contract for the product group" --
    // a terminal, operator-actionable refusal that no token refresh can fix.
    // Folding it into `unauthorized` alongside 401 would send it down the
    // token-retry path and discard this message entirely.
    const client = new TrueApiClient(
      deps(
        async () =>
          new Response(
            JSON.stringify({ error_message: "no active contract for the product group" }),
            { status: 403 },
          ),
      ),
    );
    const result = await client.createDispenserTask(auth, {
      participantInn: "7700000000",
      productGroupCode: 8,
      chzStatus: "EMITTED",
      gtins: [],
    });
    expect(result).toEqual({
      status: "rejected",
      code: "403",
      message: "no active contract for the product group",
    });
  });

  it("maps a 4xx rejection to a terminal result carrying the ChZ message", async () => {
    const client = new TrueApiClient(
      deps(
        async () =>
          new Response(JSON.stringify({ error_message: "no active contract" }), { status: 400 }),
      ),
    );
    const result = await client.createDispenserTask(auth, {
      participantInn: "7700000000",
      productGroupCode: 8,
      chzStatus: "EMITTED",
      gtins: [],
    });
    expect(result).toEqual({
      status: "rejected",
      code: "400",
      message: "no active contract",
    });
  });

  it("maps 429 to unavailable so the job retries with backoff", async () => {
    const client = new TrueApiClient(deps(async () => new Response("", { status: 429 })));
    await expect(client.listDispenserResults(auth, ["task-1"])).resolves.toEqual({
      status: "unavailable",
    });
  });

  it("maps a 5xx and a thrown fetch to unavailable so the job retries", async () => {
    const server = new TrueApiClient(deps(async () => new Response("", { status: 503 })));
    await expect(server.listDispenserResults(auth, ["t"])).resolves.toEqual({
      status: "unavailable",
    });
    const offline = new TrueApiClient(
      deps(async () => {
        throw new Error("ECONNRESET");
      }),
    );
    await expect(offline.listDispenserResults(auth, ["t"])).resolves.toEqual({
      status: "unavailable",
    });
  });

  it("passes task ids as a repeated query parameter and returns the archive bytes", async () => {
    const urls: string[] = [];
    const client = new TrueApiClient(
      deps(async (url) => {
        urls.push(String(url));
        return String(url).endsWith("/file")
          ? new Response(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), { status: 200 })
          : new Response(JSON.stringify([{ taskId: "a", resultId: "r1", status: "COMPLETED" }]), {
              status: 200,
            });
      }),
    );

    await client.listDispenserResults(auth, ["a", "b"]);
    expect(urls[0]).toContain("task_ids=a");
    expect(urls[0]).toContain("task_ids=b");

    const file = await client.downloadDispenserResult(auth, "r1");
    expect(file).toMatchObject({ status: "ok" });
    // ZIP magic -- the bytes must arrive unmodified, because they go straight
    // into the existing importer.
    expect(Array.from((file as { value: Uint8Array }).value.slice(0, 4))).toEqual([
      0x50, 0x4b, 0x03, 0x04,
    ]);
  });

  it("does not put the token anywhere but the Authorization header", async () => {
    const seen: string[] = [];
    const client = new TrueApiClient(
      deps(async (url, init) => {
        seen.push(String(url), String((init as RequestInit).body ?? ""));
        return new Response("[]", { status: 200 });
      }),
    );
    await client.listDispenserTasks(auth, 8);
    expect(seen.join("|")).not.toContain("t0ken");
  });

  it("posts the codes as a body and the product group as a query parameter", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const client = new TrueApiClient(
      deps(async (url, init) => {
        calls.push({ url: String(url), init: init as RequestInit });
        return new Response(
          JSON.stringify([
            {
              cis: "01046000000000172150",
              status: "INTRODUCED",
              statusEx: "MOVING_BY_UD",
              ownerInn: "7700000000",
            },
          ]),
          { status: 200 },
        );
      }),
    );

    const result = await client.cisesInfo(auth, 8, ["01046000000000172150"]);

    expect(calls[0]!.url).toBe(`${auth.baseUrl}/cises/info?pg=8`);
    expect(calls[0]!.init.method).toBe("POST");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual(["01046000000000172150"]);
    expect(result).toEqual({
      status: "ok",
      value: [
        {
          cis: "01046000000000172150",
          status: "INTRODUCED",
          statusEx: "MOVING_BY_UD",
          ownerInn: "7700000000",
          withdrawReason: null,
        },
      ],
    });
  });

  it("drops a row with no usable cis rather than inventing one", async () => {
    const client = new TrueApiClient(
      deps(async () => new Response(JSON.stringify([{ status: "INTRODUCED" }]), { status: 200 })),
    );
    // A row we cannot attribute to a code we asked about is worse than absent:
    // the caller matches on `cis`, and an empty string would match nothing
    // while looking like an answer.
    await expect(client.cisesInfo(auth, 8, ["01046000000000172150"])).resolves.toEqual({
      status: "ok",
      value: [],
    });
  });

  it("refuses to send more than the documented batch size", async () => {
    const client = new TrueApiClient(deps(async () => new Response("[]", { status: 200 })));
    await expect(
      client.cisesInfo(
        auth,
        8,
        Array.from({ length: 1001 }, (_, index) => `cis-${index}`),
      ),
    ).rejects.toThrow(RangeError);
  });

  it("does not put the token anywhere but the Authorization header", async () => {
    const seen: string[] = [];
    const client = new TrueApiClient(
      deps(async (url, init) => {
        seen.push(String(url), String((init as RequestInit).body ?? ""));
        return new Response("[]", { status: 200 });
      }),
    );
    await client.cisesInfo(auth, 8, ["01046000000000172150"]);
    expect(seen.join("|")).not.toContain("t0ken");
  });
});
