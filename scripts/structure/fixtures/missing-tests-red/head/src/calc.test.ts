import { expect, it } from "vitest";

import { over } from "./calc.js";

it("compares", () => expect(over(5, 3)).toBe(true));
