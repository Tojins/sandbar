import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("names the app", () => {
  expect(readFileSync(new URL("../deploy/app.yml", import.meta.url), "utf8")).toMatch(/^name: app$/m);
});
