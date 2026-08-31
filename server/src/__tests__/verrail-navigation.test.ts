import { describe, expect, it } from "vitest";
import { findVerrailNavigationRouteConflicts } from "../services/verrail-navigation.js";

describe("findVerrailNavigationRouteConflicts", () => {
  it("finds installed plugin slots that predate the reserved Verrail roots", () => {
    const conflicts = findVerrailNavigationRouteConflicts([
      {
        pluginKey: "paperclip.legacy-home",
        manifestJson: {
          ui: {
            slots: [
              {
                type: "page",
                id: "legacy-home-page",
                displayName: "Legacy Home",
                exportName: "LegacyHome",
                routePath: "home",
              },
            ],
          },
        },
      },
      {
        pluginKey: "paperclip.unrelated",
        manifestJson: {
          ui: {
            slots: [
              {
                type: "page",
                id: "wiki-page",
                displayName: "Wiki",
                exportName: "WikiPage",
                routePath: "wiki",
              },
            ],
          },
        },
      },
      {
        pluginKey: "paperclip.legacy-governance-sidebar",
        manifestJson: {
          ui: {
            slots: [
              {
                type: "routeSidebar",
                id: "legacy-governance-sidebar",
                displayName: "Governance Sidebar",
                exportName: "GovernanceSidebar",
                routePath: "governance",
              },
            ],
          },
        },
      },
    ]);

    expect(conflicts).toEqual([
      {
        pluginKey: "paperclip.legacy-governance-sidebar",
        routePath: "governance",
        slotId: "legacy-governance-sidebar",
        slotType: "routeSidebar",
      },
      {
        pluginKey: "paperclip.legacy-home",
        routePath: "home",
        slotId: "legacy-home-page",
        slotType: "page",
      },
    ]);
  });

  it("ignores malformed persisted manifest data instead of crashing activation checks", () => {
    expect(
      findVerrailNavigationRouteConflicts([
        { pluginKey: "paperclip.invalid", manifestJson: null },
        { pluginKey: "paperclip.invalid-slots", manifestJson: { ui: { slots: "not-an-array" } } },
      ]),
    ).toEqual([]);
  });
});
