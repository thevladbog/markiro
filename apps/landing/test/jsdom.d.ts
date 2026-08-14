declare module "jsdom" {
  export class JSDOM {
    constructor(html?: string, options?: { contentType?: string; url?: string });
    readonly window: Window & typeof globalThis;
  }
}
