import express from "express";
import { createServer, type Server } from "node:http";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { disableScalarDynamicCodeProbe, mountOpenApiDocs } from "../src/openapi-docs";

function scriptElements(html: string): Array<{ attributes: string; body: string }> {
  const lower = html.toLowerCase();
  const elements: Array<{ attributes: string; body: string }> = [];
  let cursor = 0;

  while (cursor < html.length) {
    const opening = lower.indexOf("<script", cursor);
    if (opening === -1) break;
    const openingBoundary = lower[opening + "<script".length];
    if (openingBoundary !== ">" && !/\s/.test(openingBoundary ?? "")) {
      cursor = opening + "<script".length;
      continue;
    }
    const openingEnd = lower.indexOf(">", opening + "<script".length);
    if (openingEnd === -1) throw new Error("documentation HTML contains an unclosed script tag");

    let closing = lower.indexOf("</script", openingEnd + 1);
    let closingEnd = -1;
    while (closing !== -1) {
      closingEnd = closing + "</script".length;
      while (/\s/.test(lower[closingEnd] ?? "")) closingEnd += 1;
      if (lower[closingEnd] === ">") break;
      closing = lower.indexOf("</script", closing + "</script".length);
    }
    if (closing === -1) throw new Error("documentation HTML contains an unclosed script element");

    elements.push({
      attributes: html.slice(opening + "<script".length, openingEnd),
      body: html.slice(openingEnd + 1, closing),
    });
    cursor = closingEnd + 1;
  }

  return elements;
}

function scriptSources(html: string): string[] {
  return scriptElements(html).map(({ attributes, body }) => {
    if (body.trim()) throw new Error("documentation HTML contains an inline script");
    const source = attributes.match(/\bsrc=["']([^"']+)["']/i)?.[1];
    if (!source) throw new Error("documentation HTML contains an inline script");
    return source;
  });
}

describe("self-hosted OpenAPI documentation", () => {
  let server: Server;

  it("parses script end tags with valid whitespace before the closing bracket", () => {
    expect(scriptSources('<script src="/docs/scalar.js"></script   >')).toEqual([
      "/docs/scalar.js",
    ]);
  });

  beforeAll(async () => {
    const app = express();
    mountOpenApiDocs(app);
    server = createServer(app);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
  });

  afterAll(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );

  it.each(["/docs", "/docs/"])("serves a CSP-compatible same-origin shell at %s", async (path) => {
    const response = await request(server).get(path).expect(200).expect("content-type", /html/);

    expect(scriptSources(response.text)).toEqual(["/docs/scalar.js", "/docs/bootstrap.js"]);
    expect(response.text).toContain('<div id="app"></div>');
    expect(response.text).not.toMatch(/\b(?:src|href)=["'](?:https?:)?\/\//i);
  });

  it("serves the Scalar browser bundle from the API runtime", async () => {
    const response = await request(server)
      .get("/docs/scalar.js")
      .expect(200)
      .expect("content-type", /javascript/);

    expect(response.text.length).toBeGreaterThan(100_000);
    expect(response.text).toContain("createApiReference");
    expect(response.text).not.toContain("Function(``)");
  });

  it("fails closed if Scalar changes its exact dynamic-code feature probe", () => {
    const probe = "try{return Function(``),!0}catch{return!1}";

    expect(() => disableScalarDynamicCodeProbe("no probe")).toThrow(/exactly one/);
    expect(() => disableScalarDynamicCodeProbe(`${probe}${probe}`)).toThrow(/exactly one/);
  });

  it("initializes Scalar from an external script against the same-origin OpenAPI document", async () => {
    const response = await request(server)
      .get("/docs/bootstrap.js")
      .expect(200)
      .expect("content-type", /javascript/);

    expect(response.text).toContain('Scalar.createApiReference("#app"');
    expect(response.text).toContain('url: "/openapi.json"');
    expect(response.text).toContain("withDefaultFonts: false");
    expect(response.text).toContain("agent: { disabled: true }");
    expect(response.text).toContain("mcp: { disabled: true }");
    expect(response.text).toContain("hideTestRequestButton: true");
    expect(response.text).not.toContain("showToolbar");
    expect(response.text).not.toMatch(/https?:\/\//i);
  });

  it("does not turn unknown documentation resources into the documentation shell", async () => {
    await request(server).get("/docs/missing.js").expect(404);
  });
});
