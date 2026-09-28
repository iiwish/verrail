import { expect, it } from "vitest";
import { createRepositoryDispatchHealth } from "./repository-dispatch-health.js";

it("requires a recent successful idle scan", () => {
  let now = 0; const health = createRepositoryDispatchHealth(() => now);
  expect(health.healthy()).toBe(false);
  health.cycle({ failed: false }); expect(health.healthy()).toBe(true);
  now = 15000; expect(health.healthy()).toBe(false);
  health.cycle({ failed: true }); expect(health.healthy()).toBe(false);
  health.cycle({ failed: false }); expect(health.healthy()).toBe(true);
});

it("keeps a long task healthy only while authority renews", () => {
  let now = 0; const health = createRepositoryDispatchHealth(() => now);
  health.active(true);
  for (let i = 0; i < 40; i++) { now += 20000; health.authority(); expect(health.healthy()).toBe(true); }
  now += 45000; expect(health.healthy()).toBe(false);
  health.active(false); expect(health.healthy()).toBe(false);
  health.cycle({ failed: false }); expect(health.healthy()).toBe(true);
});

it("does not let an idle authority callback conceal stale scanning", () => {
  let now = 0; const health = createRepositoryDispatchHealth(() => now);
  health.cycle({ failed: false }); now = 20000; health.authority();
  expect(health.healthy()).toBe(false);
});

it("never becomes healthy after shutdown or on a backward clock jump", () => {
  let now = 100; const health = createRepositoryDispatchHealth(() => now);
  health.active(true); now = 99; expect(health.healthy()).toBe(false);
  now = 100; health.stop(); health.authority(); health.cycle({ failed: false });
  expect(health.healthy()).toBe(false);
});
