import { expect, it } from "vitest";

import { half, over } from "./calc.js";

it("compares", () => expect(over(5, 3)).toBe(true));

it("halves", () => expect(half(4)).toBe(2));
