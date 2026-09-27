import { expect, it } from "vitest";
import { createRepositoryRecoveryHealth } from "./repository-recovery-health.js";

it("requires a recent successful cycle and fails closed on stalled scans", () => {
  let now = 0;
  const health = createRepositoryRecoveryHealth(() => now);
  expect(health.healthy()).toBe(false);
  health.cycle({ failed: false });
  expect(health.healthy()).toBe(true);
  now = 15_000;
  expect(health.healthy()).toBe(false);
  health.cycle({ failed: false });
  expect(health.healthy()).toBe(true);
  health.cycle({ failed: true });
  expect(health.healthy()).toBe(false);
  health.cycle({ failed: false });
  now--;
  expect(health.healthy()).toBe(false);
  now++;
  health.stop();
  health.cycle({ failed: false });
  expect(health.healthy()).toBe(false);
});
