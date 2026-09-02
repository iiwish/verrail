import { describe, expect, it } from "vitest";
import { createCollectionSchema } from "./collection.js";

describe("createCollectionSchema", () => {
  it("accepts a lightweight Collection and rejects empty names", () => {
    expect(createCollectionSchema.parse({ name: "Release work", description: "Related Targets" })).toEqual({
      name: "Release work",
      description: "Related Targets",
    });
    expect(createCollectionSchema.safeParse({ name: "   " }).success).toBe(false);
  });
});
