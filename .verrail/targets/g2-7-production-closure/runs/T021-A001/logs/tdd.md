# T021 TDD Log

## RED

The release browser gate timed out before executing tests because the CLI moved its server away from occupied port 3203 while Playwright kept polling 3203. A fake-pnpm runner test then failed by proving that the default path did not propagate any `VERRAIL_ACCEPTANCE_PORT`; the explicit override test passed.

## GREEN

The runner now asks the operating system for an available IPv4 loopback port and passes the selected value to Playwright. Both runner tests passed, then all six real Playwright acceptance journeys completed on dynamically selected port 49784.

## REFACTOR

Port allocation stays inside the runner. The Playwright configuration remains the single consumer for its base URL, health URL and server `PORT`, and the temporary-home lifecycle is unchanged.
