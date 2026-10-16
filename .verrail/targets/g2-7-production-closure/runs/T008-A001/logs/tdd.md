# T008 TDD Log

## RED

- The board had no operational surface for server-projected Target commands.
- A pending ActionRequest was compared with a nonexistent state, hiding approval attention and commands.
- The initial empty GraphRevision appeared activatable even though activation rejects empty graphs.
- A failed command retry generated a new idempotency key rather than replaying the same command envelope.
- The full tab rail clipped on a 1024px desktop viewport.

## GREEN

- Added typed API calls for graph, run, review, acceptance and connector commands.
- Added an authority-aware command list with immutable resource, submission, review, parameter and approval bindings.
- Added pending, authoritative success, server rejection and same-key retry states.
- Corrected ActionRequest and GraphRevision command projection behavior.
- Added real UI browser journeys through Target confirmation, Workbench and Home attention.

## REFACTOR

- Kept one mutation pipeline for command feedback and one envelope for exact retries.
- Kept candidate-only and automatic connector commands visible without presenting unauthorized controls.
- Switched narrow desktops to a select while retaining the full tab rail at wide widths.

## Verification

Five focused test files passed 67 tests. Locale parity matched 3,389 keys in each language.
All workspace typechecks, token gates, migration checks, production build and whitespace checks passed.
Six Playwright acceptance journeys passed at both supported desktop sizes.
