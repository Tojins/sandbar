import { expect, it } from "vitest";

import { twice } from "./calc.js";

it("doubles", () => expect(twice(2)).toBe(4));
