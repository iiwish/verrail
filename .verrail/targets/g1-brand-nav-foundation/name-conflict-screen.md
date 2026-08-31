# Verrail Preliminary Name Screen

Screen date: 2026-08-26 UTC

## Decision Boundary

This is a reproducible knockout screen for implementation planning. It is not a legal opinion, comprehensive trademark clearance, domain ownership proof, or permission to launch publicly. A qualified trademark professional must review confusingly similar marks, relevant classes, territories, unregistered use, and the final logo before public launch.

## Findings

| Surface | Check | Observed result | Planning implication |
| --- | --- | --- | --- |
| General web | Exact `"Verrail"` and software/AI/agent variants | No obvious exact-name software product appeared in the reviewed result set. A surname result and unrelated near-name products appeared. | Exact-name collision risk appears low in the sampled results, but similarity risk is not cleared. |
| USPTO | Official search entry point and exact-name web indexing | No obvious indexed exact result was found. The official search workflow requires a fuller structured search. | Treat US trademark status as unresolved, not clear. |
| npm | `npm view verrail` | Registry returned `E404`. | The exact unscoped package was not published at screen time; reservation was not performed. |
| npm scope sample | `npm view @verrail/cli` | Registry returned `E404`. | This only proves that package is absent; it does not prove the npm organization is claimable. |
| PyPI | `GET /pypi/verrail/json` | HTTP `404`. | Exact project was not published at screen time. |
| RubyGems | `GET /api/v1/gems/verrail.json` | HTTP `404`. | Exact gem was not published at screen time. |
| GitHub repository search | `verrail in:name` | API returned zero repository matches. | No exact repository-name collision was observed in this search snapshot. |
| GitHub account | `GET /users/verrail` | HTTP `404`. | Exact account was not present at screen time; reservation was not performed. |
| Docker Hub account | `GET /v2/users/verrail/` | HTTP `404`. | Exact account was not present at screen time; reservation was not performed. |
| `verrail.com` | Verisign RDAP and DNS | Registered 2026-03-26, delegated to Hover nameservers, and resolves. | Do not assume availability. Confirm that the project controls the registrant account before B1 public-link work. |
| `verrail.ai` | DNS and owner confirmation | Delegated to Cloudflare nameservers. The product owner confirmed control on 2026-08-26. | Use as the canonical public domain; verify registrar access, DNS recovery, and renewal controls before launch. |

## Similarity Risks

- `Vibrail` appeared as a nearby software/package name in search results. It is not an exact match, but pronunciation and letter-shape similarity should be included in professional review.
- The words `verify`, `rail`, `Verra`, `Verity`, and products using a `V` rail/check motif are conceptually crowded. Clearance must test overall commercial impression, not exact spelling alone.
- The selected geometric `V` mark is intentionally simple. A professional image-mark search and final optical refinement are required before broad public launch.

## Sources And Reproduction

- Official US trademark search guidance: <https://www.uspto.gov/trademarks/search>
- Verisign RDAP endpoint: <https://rdap.verisign.com/com/v1/domain/verrail.com>
- npm registry: `npm view verrail name version --json`
- PyPI JSON API: <https://pypi.org/pypi/verrail/json>
- GitHub repository API: <https://api.github.com/search/repositories?q=verrail+in:name>
- GitHub account API: <https://api.github.com/users/verrail>
- Docker Hub account API: <https://hub.docker.com/v2/users/verrail/>

## Gate

B0 product implementation may proceed because no exact software/package/repository collision was found in the sampled public sources and the product owner confirmed control of `verrail.ai`. B1 may use local product assets and `verrail.ai` as the canonical domain. Public announcement, paid acquisition, and package publication remain gated on operational domain checks and professional trademark clearance.
