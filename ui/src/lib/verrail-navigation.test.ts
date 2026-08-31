import { describe, expect, it } from "vitest";
import { isVerrailNavigationEnabled, workspaceLandingRoute } from "./verrail-navigation";

describe("isVerrailNavigationEnabled", () => {
  it("is disabled without a selected workspace", () => {
    expect(isVerrailNavigationEnabled(null)).toBe(false);
  });

  it("follows the selected workspace flag without instance-level fallback", () => {
    expect(isVerrailNavigationEnabled({ enableVerrailNavigation: false })).toBe(false);
    expect(isVerrailNavigationEnabled({ enableVerrailNavigation: true })).toBe(true);
  });

  it("keeps the legacy landing route unless the workspace opts into Verrail navigation", () => {
    expect(workspaceLandingRoute(undefined)).toBe("dashboard");
    expect(workspaceLandingRoute({ enableVerrailNavigation: false })).toBe("dashboard");
    expect(workspaceLandingRoute({ enableVerrailNavigation: true })).toBe("home");
  });
});
