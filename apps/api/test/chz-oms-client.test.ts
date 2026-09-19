import { describe, expect, it } from "vitest";

import { OmsClient, type OmsClientDependencies } from "../src/modules/chz-km-orders/oms.client";

const auth = {
  baseUrl: "https://suz.sandbox.crptech.ru/api/v3",
  clientToken: "tok",
  omsId: "cdf12109-10d3-11e6-8b6f-0050569977a1",
};
const deps = (fetchImpl: OmsClientDependencies["fetch"]): OmsClientDependencies => ({
  fetch: fetchImpl,
  scheduleAbort: () => () => {},
});

describe("OmsClient", () => {
  it("posts the body bytes verbatim with clientToken and X-Signature", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const client = new OmsClient(
      deps(async (url, init) => {
        calls.push({ url: String(url), init: init as RequestInit });
        return new Response(
          JSON.stringify({
            omsId: auth.omsId,
            orderId: "b024ae09-ef7c-449e-b461-05d8eb116c79",
            expectedCompleteTimestamp: 5100,
          }),
          { status: 200 },
        );
      }),
    );
    const body = '{"productGroup":"beer"}';
    const result = await client.createOrder(auth, body, "c2ln");
    expect(result).toEqual({
      status: "ok",
      value: { orderId: "b024ae09-ef7c-449e-b461-05d8eb116c79", expectedCompleteMs: 5100 },
    });
    expect(calls[0]!.url).toBe(`${auth.baseUrl}/order?omsId=${auth.omsId}`);
    const headers = new Headers(calls[0]!.init.headers);
    expect(headers.get("clientToken")).toBe("tok");
    expect(headers.get("X-Signature")).toBe("c2ln");
    expect(calls[0]!.init.body).toBe(body);
  });

  it("parses codes as JSON so the GS escape becomes the raw separator", async () => {
    const client = new OmsClient(
      deps(
        async () =>
          new Response(
            '{"omsId":"x","codes":["010460165303004621=rxDV3M\\u001d93VXQI"],"blockId":"012cc7b0-c9e4-4511-8058-2de1f97a87b0"}',
            { status: 200 },
          ),
      ),
    );
    const result = await client.getCodes(
      auth,
      "b024ae09-ef7c-449e-b461-05d8eb116c79",
      "04601653030046",
      1,
    );
    expect(result).toEqual({
      status: "ok",
      value: {
        codes: ["010460165303004621=rxDV3M\u001d93VXQI"],
        blockId: "012cc7b0-c9e4-4511-8058-2de1f97a87b0",
      },
    });
  });

  it("maps buffer status, including a rejected order's reason", async () => {
    const client = new OmsClient(
      deps(
        async () =>
          new Response(
            JSON.stringify([
              {
                omsId: "x",
                orderId: "y",
                leftInBuffer: -1,
                totalCodes: -1,
                availableCodes: -1,
                unavailableCodes: -1,
                totalPassed: -1,
                gtin: "04606038003172",
                bufferStatus: "REJECTED",
                rejectionReason: "Order declined: 0106",
                templateId: 18,
              },
            ]),
            { status: 200 },
          ),
      ),
    );
    const result = await client.getBufferStatus(auth, "y", "04606038003172");
    // `leftInBuffer`, `totalCodes` and `unavailableCodes` are in the response
    // above and deliberately absent here: nothing reads them, so the client
    // does not parse them.
    expect(result).toEqual({
      status: "ok",
      value: {
        bufferStatus: "REJECTED",
        availableCodes: -1,
        totalPassed: -1,
        expiredDate: null,
        rejectionReason: "Order declined: 0106",
      },
    });
  });

  it("classifies 401 as unauthorized, 4xx as rejected with the message, 5xx and 429 as unavailable", async () => {
    const mk = (status: number, body: string) =>
      new OmsClient(deps(async () => new Response(body, { status })));
    expect(await mk(401, "").getBufferStatus(auth, "y", "04606038003172")).toEqual({
      status: "unauthorized",
    });
    expect(
      await mk(
        400,
        '{"fieldErrors":[{"fieldName":"gtin","fieldError":"bad"}],"globalErrors":["nope"]}',
      ).getBufferStatus(auth, "y", "04606038003172"),
    ).toMatchObject({ status: "rejected", code: "400" });
    expect(await mk(429, "").getBufferStatus(auth, "y", "04606038003172")).toEqual({
      status: "unavailable",
    });
    expect(await mk(503, "").getBufferStatus(auth, "y", "04606038003172")).toEqual({
      status: "unavailable",
    });
  });

  it("refuses more than 150000 codes per call before any request", async () => {
    const client = new OmsClient(
      deps(async () => {
        throw new Error("must not be called");
      }),
    );
    await expect(client.getCodes(auth, "y", "04606038003172", 150_001)).rejects.toThrow(RangeError);
  });

  it("lists blocks by filtering malformed entries and mapping valid ones", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const client = new OmsClient(
      deps(async (url, init) => {
        calls.push({ url: String(url), init: init as RequestInit });
        return new Response(
          JSON.stringify({
            blocks: [
              { blockId: "012cc7b0-c9e4-4511-8058-2de1f97a87b0", quantity: 100 },
              { blockId: "not-a-uuid", quantity: 50 },
              { quantity: 25 },
              { blockId: "523dc9b1-d8f5-5622-9169-3ef2b08b98c1", quantity: 75 },
            ],
          }),
          { status: 200 },
        );
      }),
    );
    const result = await client.listBlocks(
      auth,
      "b024ae09-ef7c-449e-b461-05d8eb116c79",
      "04606038003172",
    );
    expect(result).toEqual({
      status: "ok",
      value: [
        { blockId: "012cc7b0-c9e4-4511-8058-2de1f97a87b0", quantity: 100 },
        { blockId: "523dc9b1-d8f5-5622-9169-3ef2b08b98c1", quantity: 75 },
      ],
    });
    expect(calls[0]!.url).toBe(
      `${auth.baseUrl}/order/codes/blocks?omsId=${auth.omsId}&orderId=b024ae09-ef7c-449e-b461-05d8eb116c79&gtin=04606038003172`,
    );
    const headers = new Headers(calls[0]!.init.headers);
    expect(headers.get("clientToken")).toBe("tok");
  });

  it("re-fetches a block's codes with raw GS separator and degrades mismatched shapes", async () => {
    const clientOk = new OmsClient(
      deps(
        async () =>
          new Response(
            '{"omsId":"x","codes":["product\\u001dserialcode"],"blockId":"012cc7b0-c9e4-4511-8058-2de1f97a87b0"}',
            { status: 200 },
          ),
      ),
    );
    const result = await clientOk.retryBlock(auth, "012cc7b0-c9e4-4511-8058-2de1f97a87b0");
    expect(result).toEqual({
      status: "ok",
      value: {
        codes: ["product\u001dserialcode"],
        blockId: "012cc7b0-c9e4-4511-8058-2de1f97a87b0",
      },
    });

    const clientBadShape = new OmsClient(
      deps(
        async () =>
          new Response(JSON.stringify({ omsId: "x", codes: "not-an-array" }), { status: 200 }),
      ),
    );
    const resultBad = await clientBadShape.retryBlock(auth, "012cc7b0-c9e4-4511-8058-2de1f97a87b0");
    expect(resultBad).toEqual({ status: "unavailable" });
  });
});
