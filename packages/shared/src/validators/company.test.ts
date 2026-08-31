import { describe, expect, it } from "vitest";
import { updateCompanyBrandingSchema, updateCompanySchema } from "./company.js";

describe("workspace navigation compatibility flag", () => {
  it("allows board company updates to set enableVerrailNavigation", () => {
    expect(updateCompanySchema.parse({ enableVerrailNavigation: true })).toEqual({
      enableVerrailNavigation: true,
    });
  });

  it("keeps enableVerrailNavigation out of the agent branding contract", () => {
    expect(updateCompanyBrandingSchema.safeParse({ enableVerrailNavigation: true }).success).toBe(false);
  });
});
