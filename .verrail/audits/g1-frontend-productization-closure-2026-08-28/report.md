# G1 Frontend Productization Audit

## Decision

The Infrastructure and Governance management shell is a PR candidate pending human review. The sparse route indexes have been removed, every published child route reaches an implemented capability, and the selected in-app browser completed the representative desktop and narrow-desktop journeys without console errors.

## Baseline

- `04-governance-index-before.png` and `05-infrastructure-index-before.png` show the prior list-only pages and unused content area.
- `03-paperclip-settings-secondary-nav.png` captures the inherited Paperclip interaction contract: collapsed primary rail, persistent contextual sidebar, and unframed operational content.

## Implemented Contract

- Infrastructure opens Secrets and keeps Secrets, Environments, Adapters, and Plugins in a persistent secondary sidebar.
- Governance opens Attention and keeps Attention, Approvals, Activity, and Costs in the same contextual workflow.
- Settings keeps General, Profile, Members, Invites, Access, Heartbeats, Import, Export, and Experimental settings. Infrastructure-owned entries are not duplicated there in Verrail mode.
- Existing Settings, Decisions, Approvals, Activity, Costs, Environment, Adapter, and Plugin routes remain registered as compatibility paths.
- Canonical child pages preserve section breadcrumbs and canonical back/detail links where the inherited page has child navigation.
- Disabled Environments now provides a direct path to Experimental settings instead of a dead instruction.
- The Secrets usage panel uses Verrail terminology and localized English/Simplified Chinese copy.

## Browser Journey

| Entry | Verified outcome | Representative action |
| --- | --- | --- |
| `/GFR/infrastructure` | Redirects to `/infrastructure/secrets`; Infrastructure sidebar visible | Opened and closed New Secret dialog |
| `/GFR/infrastructure/environments` | Infrastructure context retained | Experimental-settings link resolves to the real settings route |
| `/GFR/infrastructure/adapters` | Adapter management page loads | Install Adapter command visible |
| `/GFR/infrastructure/plugins` | Plugin management page loads | Install Plugin command visible |
| `/GFR/governance` | Redirects to `/governance/attention`; Governance sidebar visible | Attention desk and filters load |
| `/GFR/governance/approvals` | Redirects to pending approvals | Pending/all filter surface loads |
| `/GFR/governance/audit` | Activity feed loads | Audit modes and empty/data states remain available |
| `/GFR/governance/costs` | Cost controls and summaries load | Range and cost tabs remain usable |
| `/GFR/settings` | Redirects to `/company/settings` | Settings sidebar excludes Infrastructure ownership |

The 1440x900 and 1024x768 journeys produced no browser console errors, stuck skeletons, overlapping navigation, or clipped secondary controls. `12-infrastructure-final-1440.png`, `09-governance-costs-1440.png`, and `10-settings-ownership-1024.png` are the final representative screenshots.

## Visual Review

Compared with `03-paperclip-settings-secondary-nav.png`, the final shell keeps the same left-edge rhythm, fixed contextual navigation width, compact row density, inset active state, divider treatment, and unframed content area. Infrastructure and Governance add a concise section identity row because the primary rail is icon-only; the rest of the secondary navigation uses the existing `SidebarNavItem` system rather than a new visual language.

## Residual Risk

- Some provider and plugin descriptions are source-owned technical content and remain English under the i18n boundary.
- The dedicated Playwright acceptance suite was extended but not executed in this run; the same route and interaction matrix was exercised through the selected in-app browser.
- The full UI test run had two unrelated five-second timeouts under parallel load; both failing tests passed immediately when rerun alone.
- Human product review is still required before commit, PR, merge, or ship approval.
