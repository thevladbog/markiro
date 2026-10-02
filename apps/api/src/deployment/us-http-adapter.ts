import { createServer } from "node:http";
import { ExpressAdapter } from "@nestjs/platform-express";

/** Local U.S. transport envelope: an 8 KiB JSON TLC list expands when URL-encoded. */
export class UsHttpAdapter extends ExpressAdapter {
  override initHttpServer(): void {
    this.httpServer = createServer({ maxHeaderSize: 64 * 1024 }, this.getInstance());
  }
}
