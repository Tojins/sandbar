import { expect, it } from "vitest";

import { half, over } from "./calc.js";

it("compares", () => {
  expect(over(5, 3)).toBe(true);
  expect(over(3, 3)).toBe(false);
  expect(over(1, 3)).toBe(false);
});

it("halves", () => expect(half(4)).toBe(2));
