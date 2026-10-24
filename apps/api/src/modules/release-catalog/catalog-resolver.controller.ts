import { Controller, Get, Head, Inject, Req, Res } from "@nestjs/common";
import { ApiExcludeController, ApiExcludeEndpoint } from "@nestjs/swagger";
import type { Request, Response } from "express";
import { pipeline } from "node:stream/promises";
import { CatalogResolver } from "./catalog-resolver";
import { CatalogFault } from "./catalog-types";
const prefix = "/internal/release-catalog";
function rangeOf(value: string, size: number): { start: number; end: number } | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!m || (!m[1] && !m[2])) return null;
  const number = (v: string) => (v === "" ? undefined : Number(v));
  const a = number(m[1] ?? ""),
    b = number(m[2] ?? "");
  if ([a, b].some((n) => n !== undefined && !Number.isSafeInteger(n))) return null;
  if (a === undefined)
    return b !== undefined && b > 0 ? { start: Math.max(0, size - b), end: size - 1 } : null;
  if (a >= size || (b !== undefined && b < a)) return null;
  return { start: a, end: b === undefined ? size - 1 : Math.min(b, size - 1) };
}
/** Private container-network endpoint. Public edge rejects direct internal paths on ALL hosts. */
@ApiExcludeController()
@Controller("internal/release-catalog")
export class CatalogResolverController {
  constructor(@Inject(CatalogResolver) private readonly resolver: CatalogResolver | null) {}
  @ApiExcludeEndpoint()
  @Head("*path")
  async head(@Req() req: Request, @Res() res: Response) {
    return this.serve(req, res);
  }
  @ApiExcludeEndpoint()
  @Get("*path")
  async get(@Req() req: Request, @Res() res: Response) {
    return this.serve(req, res);
  }
  private async serve(req: Request, res: Response) {
    res.setHeader("Cache-Control", "no-store");
    let file: Awaited<ReturnType<CatalogResolver["resolve"]>> | undefined;
    try {
      if (!this.resolver) throw new CatalogFault("unavailable");
      const raw = req.originalUrl.split("?")[0] ?? "";
      if (!raw.startsWith(prefix + "/")) throw new CatalogFault("not_found");
      file = await this.resolver.resolve(raw.slice(prefix.length));
      const etag = `"sha256-${file.sha256}"`;
      res.setHeader("ETag", etag);
      res.setHeader("Content-Type", file.contentType);
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Accept-Ranges", "bytes");
      res.setHeader(
        "Cache-Control",
        file.mutable ? "public, max-age=0, must-revalidate" : "public, max-age=31536000, immutable",
      );
      if (/\.(?:exe|apk|zip)$/.test(file.name))
        res.setHeader("Content-Disposition", `attachment; filename="${file.name}"`);
      const condition = req.headers["if-none-match"];
      if (
        condition?.split(",").some((v) => v.trim() === "*" || v.trim().replace(/^W\//, "") === etag)
      ) {
        res.status(304).end();
        return;
      }
      let start = 0,
        end = file.sizeBytes - 1;
      if (req.headers.range && (!req.headers["if-range"] || req.headers["if-range"] === etag)) {
        const range = rangeOf(req.headers.range, file.sizeBytes);
        if (!range) {
          res.setHeader("Cache-Control", "no-store");
          res.setHeader("Content-Range", `bytes */${file.sizeBytes}`);
          res.status(416).end();
          return;
        }
        ({ start, end } = range);
        res.status(206);
        res.setHeader("Content-Range", `bytes ${start}-${end}/${file.sizeBytes}`);
      }
      res.setHeader("Content-Length", end - start + 1);
      if (req.method === "HEAD") {
        res.end();
        return;
      }
      await pipeline(file.stream(start, end), res);
    } catch (error) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.removeHeader("Content-Length");
      res.removeHeader("Content-Range");
      res.removeHeader("Content-Disposition");
      res.removeHeader("ETag");
      res.setHeader("Cache-Control", "no-store");
      res.status(error instanceof CatalogFault && error.code === "not_found" ? 404 : 503).end();
    } finally {
      await file?.close();
    }
  }
}
