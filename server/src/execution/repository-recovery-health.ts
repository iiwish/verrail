export function createRepositoryRecoveryHealth(now: () => number = Date.now) {
  let lastSuccess: number | undefined;
  let failed = false;
  let stopped = false;
  return {
    cycle(result: { failed: boolean }) {
      failed = result.failed;
      if (!failed) lastSuccess = now();
    },
    stop() { stopped = true; },
    healthy() {
      const age = lastSuccess === undefined ? Infinity : now() - lastSuccess;
      return !stopped && !failed && age >= 0 && age < 15_000;
    },
  };
}
