import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("names the app and its port", () => {
  const app = readFileSync(new URL("../deploy/app.yml", import.meta.url), "utf8");
  expect(app).toMatch(/^name: app$/m);
  expect(app).toMatch(/^port: 8080$/m);
});
