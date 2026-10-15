import { readFileSync } from "node:fs";

// Bound first: Vite rewrites a literal `new URL(..., import.meta.url)` under jsdom.
const supportModuleUrl = import.meta.url;

/** A shared Rust fixture of `proto/fixtures`, parsed as JSON. */
export function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../../proto/fixtures/${name}`, supportModuleUrl), "utf8"));
}
