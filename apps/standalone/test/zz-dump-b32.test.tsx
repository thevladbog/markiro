// Not committed: dumps the work screen's real DOM for a browser look.
import { mkdirSync, writeFileSync } from "node:fs";

import { act } from "@testing-library/react";
import { describe, it } from "vitest";

import { km } from "./support/floor-work.js";
import { palletStation } from "./support/pallets.js";
import { renderWork } from "./support/work-screen.js";

const DIR = process.env["DUMP_DIR"];
const run = DIR === undefined ? describe.skip : describe;
function dump(name: string) {
  if (DIR === undefined) return;
  mkdirSync(DIR, { recursive: true });
  writeFileSync(`${DIR}/${name}.html`, document.body.innerHTML);
}

run("dump", () => {
  it("history", async () => {
    const at = await palletStation({ capacity: 40, boxCapacity: 12 });
    const work = renderWork(at);
    await work.scanner.listening();
    await work.settled();
    for (const code of ["A1", "A2", "A3", "A4", "A5"]) await work.scan(km(code));
    await work.scan(km("A5"));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 900)));
    dump("work");
    await work.scan("hello");
    await act(async () => new Promise((resolve) => setTimeout(resolve, 900)));
    await work.press("Вся история");
    await work.settled();
    dump("history");
  });
});
