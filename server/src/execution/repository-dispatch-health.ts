export function createRepositoryDispatchHealth(now: () => number = Date.now) {
  let active = false;
  let stopped = false;
  let failed = false;
  let lastScan: number | undefined;
  let lastAuthority: number | undefined;
  return {
    active(value: boolean) {
      active = value;
      if (value) lastAuthority = now();
    },
    authority() { if (active) lastAuthority = now(); },
    cycle(result: { failed: boolean }) {
      failed = result.failed;
      if (!failed) lastScan = now();
    },
    stop() { stopped = true; },
    healthy() {
      const last = active ? lastAuthority : lastScan;
      const age = last === undefined ? Infinity : now() - last;
      return !stopped && (active || !failed) && age >= 0 && age < (active ? 45_000 : 15_000);
    },
  };
}
