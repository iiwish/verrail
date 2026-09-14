import { describe, expect, it } from "vitest";
import { samePublicationValue } from "./agent-publication";

describe("publication comparison", () => {
  it("ignores JSONB object key ordering without hiding changed content", () => {
    expect(samePublicationValue({ files: { a: "x", b: "y" }, skills: ["s"] }, { skills: ["s"], files: { b: "y", a: "x" } })).toBe(true);
    expect(samePublicationValue({ files: { a: "x" } }, { files: { a: "changed" } })).toBe(false);
    expect(samePublicationValue(["a", "b"], ["b", "a"])).toBe(false);
    expect(samePublicationValue({}, undefined)).toBe(false);
  });
});
