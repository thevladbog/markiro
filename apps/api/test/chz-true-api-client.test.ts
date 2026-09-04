import { describe, expect, it } from "vitest";

import {
  TrueApiClient,
  type TrueApiClientDependencies,
} from "../src/modules/chz-exports/true-api.client";

const auth = { baseUrl: "https://markirovka.sandbox.crptech.ru/api/v3/true-api", token: "t0ken" };
const emptyZip = new Uint8Array([
  0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
]);
const singleEmptyFileZip = new Uint8Array(
  Buffer.from(
    "UEsDBAoAAAAAABivH10AAAAAAAAAAAAAAAABAAAAYVBLAQIeAwoAAAAAABivH10AAAAAAAAAAAAAAAABAAAAAAAAAAAAAACkgQAAAABhUEsFBgAAAAABAAEALwAAAB8AAAAAAA==",
    "base64",
  ),
);

function deps(fetchImpl: TrueApiClientDependencies["fetch"]): TrueApiClientDependencies {
  return { fetch: fetchImpl, scheduleAbort: () => () => {} };
}

describe("TrueApiClient", () => {
  it("orders a filtered CIS report using the documented dispenser task contract", async () => {
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
    expect(body).toEqual({
      format: "CSV",
      name: "FILTERED_CIS_REPORT",
      periodicity: "SINGLE",
      productGroupCode: "8",
      params: expect.any(String),
    });
    // `params` travels as a STRING, not a nested object -- this is the part of
    // the dispenser contract that is easy to get wrong and silent when wrong.
    expect(typeof body.params).toBe("string");
    expect(JSON.parse(body.params as string)).toEqual({
      participantInn: "7700000000",
      packageType: ["UNIT"],
      status: "EMITTED",
      includeGtin: ["04600000000017"],
    });
  });

  it("maps 401 to unauthorized so the caller can refuse instead of retrying", async () => {
    const client = new TrueApiClient(deps(async () => new Response("", { status: 401 })));
    await expect(client.listDispenserResults(auth, 8, ["task-1"])).resolves.toEqual({
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
      source: "http",
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
      source: "http",
    });
  });

  it("maps 429 to unavailable so the job retries with backoff", async () => {
    const client = new TrueApiClient(deps(async () => new Response("", { status: 429 })));
    await expect(client.listDispenserResults(auth, 8, ["task-1"])).resolves.toEqual({
      status: "unavailable",
    });
  });

  it("maps a 5xx and a thrown fetch to unavailable so the job retries", async () => {
    const server = new TrueApiClient(deps(async () => new Response("", { status: 503 })));
    await expect(server.listDispenserResults(auth, 8, ["t"])).resolves.toEqual({
      status: "unavailable",
    });
    const offline = new TrueApiClient(
      deps(async () => {
        throw new Error("ECONNRESET");
      }),
    );
    await expect(offline.listDispenserResults(auth, 8, ["t"])).resolves.toEqual({
      status: "unavailable",
    });
  });

  it("passes task ids as a repeated query parameter and returns the archive bytes", async () => {
    const urls: string[] = [];
    const client = new TrueApiClient(
      deps(async (url) => {
        urls.push(String(url));
        return String(url).includes("/file?")
          ? new Response(singleEmptyFileZip, { status: 200 })
          : new Response(
              JSON.stringify({
                list: [
                  {
                    id: "r1",
                    archiveSize: 4,
                    available: "AVAILABLE",
                    dataStartDate: null,
                    dataEndDate: null,
                    downloadStatus: "SUCCESS",
                    downloadingTime: 12,
                    downloadFormat: "CSV",
                    errorMessage: null,
                    fullErrorMessage: null,
                    fileDeleteDate: "2026-09-30T00:00:00.000Z",
                    generationStartDate: "2026-08-31T10:00:00.000Z",
                    generationEndDate: "2026-08-31T10:00:12.000Z",
                    notEditable: true,
                    taskId: "a",
                    fileFormat: "CSV",
                    resultFilePartsSize: 0,
                    resultFileParts: [],
                  },
                ],
              }),
              { status: 200 },
            );
      }),
    );

    await expect(client.listDispenserResults(auth, 8, ["a", "b"])).resolves.toEqual({
      status: "ok",
      value: [
        {
          taskId: "a",
          resultId: "r1",
          status: "SUCCESS",
          errorMessage: null,
          archiveSize: 4,
          available: "AVAILABLE",
          fileDeleteDate: "2026-09-30T00:00:00.000Z",
        },
      ],
    });
    expect(urls[0]).toContain("page=0");
    expect(urls[0]).toContain("size=2");
    expect(urls[0]).toContain("pg=8");
    expect(urls[0]).toContain("task_ids=a");
    expect(urls[0]).toContain("task_ids=b");

    const file = await client.downloadDispenserResult(auth, "r1", 8, 64 * 1024 * 1024);
    expect(urls[1]).toBe(`${auth.baseUrl}/dispenser/results/r1/file?pg=8`);
    expect(file).toMatchObject({ status: "ok" });
    // ZIP magic -- the bytes must arrive unmodified, because they go straight
    // into the existing importer.
    expect(Array.from((file as { value: Uint8Array }).value.slice(0, 4))).toEqual([
      0x50, 0x4b, 0x03, 0x04,
    ]);
  });

  it("requests binary content and rejects a download that exceeds the input limit", async () => {
    let headers = new Headers();
    const client = new TrueApiClient(
      deps(async (_url, init) => {
        headers = new Headers((init as RequestInit).headers);
        return new Response(new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
      }),
    );

    await expect(client.downloadDispenserResult(auth, "r1", 8, 3)).resolves.toEqual({
      status: "rejected",
      code: "CHZ_DOWNLOAD_TOO_LARGE",
      message: "",
    });
    expect(headers.get("Accept")).toBe("*/*");
  });

  it("rejects a successful response that is not a ZIP archive", async () => {
    const client = new TrueApiClient(
      deps(async () => new Response(new TextEncoder().encode("Error"), { status: 200 })),
    );

    await expect(client.downloadDispenserResult(auth, "r1", 8, 1024)).resolves.toEqual({
      status: "rejected",
      code: "CHZ_DOWNLOAD_INVALID_ARCHIVE",
      message: "",
    });
  });

  it("rejects a truncated ZIP signature and an incomplete end record", async () => {
    const truncated = new TrueApiClient(
      deps(async () => new Response(new Uint8Array([0x50, 0x4b, 0x05, 0x06]), { status: 200 })),
    );
    await expect(truncated.downloadDispenserResult(auth, "r1", 8, 1024)).resolves.toEqual({
      status: "rejected",
      code: "CHZ_DOWNLOAD_INVALID_ARCHIVE",
      message: "",
    });

    const incompleteEnd = new Uint8Array([
      0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0,
    ]);
    const malformed = new TrueApiClient(
      deps(async () => new Response(incompleteEnd, { status: 200 })),
    );
    await expect(malformed.downloadDispenserResult(auth, "r1", 8, 1024)).resolves.toEqual({
      status: "rejected",
      code: "CHZ_DOWNLOAD_INVALID_ARCHIVE",
      message: "",
    });
  });

  it("accepts an empty ZIP because a zero-row export is a successful result", async () => {
    const client = new TrueApiClient(deps(async () => new Response(emptyZip, { status: 200 })));

    await expect(client.downloadDispenserResult(auth, "r1", 8, 1024)).resolves.toMatchObject({
      status: "ok",
    });
  });

  it("preserves recognition of a complete ZIP carrying a split-archive marker", async () => {
    const markedZip = new Uint8Array(singleEmptyFileZip.byteLength + 4);
    markedZip.set([0x50, 0x4b, 0x07, 0x08]);
    markedZip.set(singleEmptyFileZip, 4);
    const client = new TrueApiClient(deps(async () => new Response(markedZip, { status: 200 })));

    await expect(client.downloadDispenserResult(auth, "r1", 8, 1024)).resolves.toMatchObject({
      status: "ok",
    });
  });

  it("reads dispenser tasks from the documented paged response", async () => {
    const urls: string[] = [];
    const client = new TrueApiClient(
      deps(async (url) => {
        urls.push(String(url));
        return new Response(
          JSON.stringify({
            list: [
              {
                id: "task-1",
                name: "FILTERED_CIS_REPORT",
                createDate: "2026-08-31T10:00:00.000",
                currentStatus: "PREPARATION",
                dataStartDate: null,
                dataEndDate: null,
                orgInn: "7700000000",
                period: null,
                periodicity: "SINGLE",
                productGroups: [{ id: 8, name: "Пиво" }],
                timeoutSecs: 3600,
              },
            ],
          }),
          { status: 200 },
        );
      }),
    );

    await expect(client.listDispenserTasks(auth, 8)).resolves.toEqual({
      status: "ok",
      value: [
        {
          taskId: "task-1",
          status: "PREPARATION",
          createdAt: "2026-08-31T10:00:00.000",
        },
      ],
    });
    expect(urls).toEqual([`${auth.baseUrl}/dispenser/tasks?page=0&size=100&pg=8`]);
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
              cisInfo: {
                requestedCis: "01046000000000172150",
                cis: "01046000000000172150-normalized",
                status: "INTRODUCED",
                statusEx: "MOVING_BY_UD",
                ownerInn: "7700000000",
              },
            },
          ]),
          { status: 200 },
        );
      }),
    );

    const result = await client.cisesInfo(auth, "milk", ["01046000000000172150"]);

    expect(calls[0]!.url).toBe(`${auth.baseUrl}/cises/info?pg=milk`);
    expect(calls[0]!.init.method).toBe("POST");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual(["01046000000000172150"]);
    expect(result).toEqual({
      status: "ok",
      value: {
        values: [
          {
            cis: "01046000000000172150",
            status: "INTRODUCED",
            statusEx: "MOVING_BY_UD",
            ownerInn: "7700000000",
            withdrawReason: null,
          },
        ],
        errors: [],
      },
    });
  });

  it("maps an element-level 401 response to unauthorized", async () => {
    const client = new TrueApiClient(
      deps(
        async () =>
          new Response(
            JSON.stringify([
              {
                cisInfo: { requestedCis: "01046000000000172150" },
                errorCode: "401",
                errorMessage: "Авторизация не пройдена",
              },
            ]),
            { status: 200 },
          ),
      ),
    );

    await expect(client.cisesInfo(auth, "milk", ["01046000000000172150"])).resolves.toEqual({
      status: "unauthorized",
    });
  });

  it("maps an element-level terminal error to a rejection with its message", async () => {
    const client = new TrueApiClient(
      deps(
        async () =>
          new Response(
            JSON.stringify([
              {
                cisInfo: { requestedCis: "01046000000000172150" },
                errorCode: "403",
                errorMessage: "Нет доступа к товарной группе",
              },
            ]),
            { status: 200 },
          ),
      ),
    );

    await expect(client.cisesInfo(auth, "milk", ["01046000000000172150"])).resolves.toEqual({
      status: "rejected",
      code: "403",
      message: "Нет доступа к товарной группе",
      source: "element",
    });
  });

  it("preserves refused codes alongside valid facts in a mixed response", async () => {
    const client = new TrueApiClient(
      deps(
        async () =>
          new Response(
            JSON.stringify([
              {
                cisInfo: {
                  requestedCis: "01046000000000172150",
                  status: "INTRODUCED",
                },
              },
              {
                cisInfo: { requestedCis: "01046000000000172151" },
                errorCode: "403",
                errorMessage: "Нет доступа к коду",
              },
            ]),
            { status: 200 },
          ),
      ),
    );

    await expect(
      client.cisesInfo(auth, "milk", ["01046000000000172150", "01046000000000172151"]),
    ).resolves.toEqual({
      status: "ok",
      value: {
        values: [
          {
            cis: "01046000000000172150",
            status: "INTRODUCED",
            statusEx: null,
            ownerInn: null,
            withdrawReason: null,
          },
        ],
        errors: [
          {
            cis: "01046000000000172151",
            code: "403",
            message: "Нет доступа к коду",
          },
        ],
      },
    });
  });

  it("drops a row with no usable cis rather than inventing one", async () => {
    const client = new TrueApiClient(
      deps(
        async () =>
          new Response(JSON.stringify([{ cisInfo: { status: "INTRODUCED" } }]), { status: 200 }),
      ),
    );
    // A row we cannot attribute to a code we asked about is worse than absent:
    // the caller matches on `cis`, and an empty string would match nothing
    // while looking like an answer.
    await expect(client.cisesInfo(auth, "milk", ["01046000000000172150"])).resolves.toEqual({
      status: "ok",
      value: { values: [], errors: [] },
    });
  });

  it("skips a null row instead of losing the whole batch to a throw", async () => {
    // `null` in the array is malformed, but it must not take the surviving
    // row down with it: `record.cis` on `null` would throw, and `request()`
    // converts any throw from `parse` into `unavailable` for the ENTIRE
    // batch -- losing the answer for every other code over one bad row.
    const client = new TrueApiClient(
      deps(
        async () =>
          new Response(
            JSON.stringify([
              null,
              {
                cisInfo: {
                  requestedCis: "01046000000000172150",
                  status: "INTRODUCED",
                },
              },
            ]),
            { status: 200 },
          ),
      ),
    );
    await expect(client.cisesInfo(auth, "milk", ["01046000000000172150"])).resolves.toEqual({
      status: "ok",
      value: {
        values: [
          {
            cis: "01046000000000172150",
            status: "INTRODUCED",
            statusEx: null,
            ownerInn: null,
            withdrawReason: null,
          },
        ],
        errors: [],
      },
    });
  });

  it("drops a row with no usable status rather than persisting an empty one", async () => {
    // An absent/non-string `status` is ЧЗ not answering, not ЧЗ answering
    // with "". Keeping the row would let the caller persist `status: ""` as
    // though it were a real fact, and `intervalFor("")` would then treat it
    // as freshly in-circulation instead of unknown.
    const client = new TrueApiClient(
      deps(
        async () =>
          new Response(JSON.stringify([{ cisInfo: { requestedCis: "01046000000000172150" } }]), {
            status: 200,
          }),
      ),
    );
    await expect(client.cisesInfo(auth, "milk", ["01046000000000172150"])).resolves.toEqual({
      status: "ok",
      value: { values: [], errors: [] },
    });
  });

  it("treats a non-array 200 response as a parse failure and retries", async () => {
    // A non-array response (object, null, string, etc.) is malformed and must
    // not be treated as an empty answer. Silently converting it to an empty
    // array would mark every code in the batch unknown, potentially backing
    // off a whole product group on a single malformed response.
    for (const payload of [{ result: [] }, null, "not an array"]) {
      const client = new TrueApiClient(
        deps(async () => new Response(JSON.stringify(payload), { status: 200 })),
      );
      await expect(client.cisesInfo(auth, "milk", ["01046000000000172150"])).resolves.toEqual({
        status: "unavailable",
      });
    }
  });

  it("refuses to send more than the documented batch size", async () => {
    const client = new TrueApiClient(deps(async () => new Response("[]", { status: 200 })));
    await expect(
      client.cisesInfo(
        auth,
        "milk",
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
    await client.cisesInfo(auth, "milk", ["01046000000000172150"]);
    expect(seen.join("|")).not.toContain("t0ken");
  });
});
