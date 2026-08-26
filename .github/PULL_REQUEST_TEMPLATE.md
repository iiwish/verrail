<!-- Write all pull request text in Simplified Technical English (ASD-STE100): short sentences, one instruction per sentence, simple approved vocabulary, and the active voice. -->

## Thinking Path

<!--
  Required. Trace your reasoning from the top of the project down to this
  specific change. Start with what Verrail is, then narrow through the
  subsystem, the problem, and why this PR exists. Use blockquote style.
  Aim for 5–8 steps. See CONTRIBUTING.md for full examples.
-->

> - Verrail is an evidence-driven control plane for governed AI delivery
> - [Which subsystem or capability is involved]
> - [What problem or gap exists]
> - [Why it needs to be addressed]
> - This pull request ...
> - The benefit is ...

## Linked Issues or Issue Description

<!--
  Required. Pick ONE of the two paths below.

  (A) Issue exists — replace the placeholder below with your issue links.
      Tag each linked issue with `Fixes: #123`, `Closes #123`, or `Refs #123`.
      Include duplicates and closely related issues too.

  Only reference PUBLIC GitHub issues/PRs here. Do NOT paste internal,
  instance-local references — ticket ids like PAPA-123 / PAP-224,
  /PAP/issues/... or agent://... links, or localhost/tailnet URLs. Other
  contributors cannot open them. See CONTRIBUTING.md → "No Internal Issue
  References".

  (B) No issue exists — describe the underlying problem here. Follow the issue
      template that fits your change. Open the matching file and copy its field
      labels into your description:
        • Bug:         .github/ISSUE_TEMPLATE/bug_report.yml
        • Feature:     .github/ISSUE_TEMPLATE/feature_request.yml
        • Adapter:     .github/ISSUE_TEMPLATE/adapter_request.yml
        • Enhancement: .github/ISSUE_TEMPLATE/enhancement.yml
        • Docs:        .github/ISSUE_TEMPLATE/docs_issue.yml
      An automated check reads the literal bold labels AND the content under
      each label. Keep at least three of these labels, each alone on its own
      line, and write real content under each. A label with only the bare "-"
      placeholder does not count, and the check fails.

  See CONTRIBUTING.md → "Link Issues or Describe Them In-PR".
-->

-

## What Changed

<!-- Bullet list of concrete changes. One bullet per logical unit. -->

-

## Verification

<!--
  How can a reviewer confirm this works? Include test commands, manual
  steps, or both.
-->

-

## Risks

<!--
  What could go wrong? Mention migration safety, breaking changes,
  behavioral shifts, or "Low risk" if genuinely minor.
-->

-

> For core feature work, check `docs/product-goals.md`, `docs/product-design.md`, and `docs/architecture.md` before opening the pull request. Update the canonical document when the product scope or architecture changes.

## Model Used

<!--
  Required. Specify which AI model was used to produce or assist with
  this change. Be as descriptive as possible — include:
    • Provider and model name (e.g., Claude, GPT, Gemini, Codex)
    • Exact model ID or version (e.g., claude-opus-4-6, gpt-4-turbo-2024-04-09)
    • Context window size if relevant (e.g., 1M context)
    • Reasoning/thinking mode if applicable (e.g., extended thinking, chain-of-thought)
    • Any other relevant capability details (e.g., tool use, code execution)
  If no AI model was used, write "None — human-authored".
-->

-

## Checklist

- [ ] I have included a thinking path that traces from project context to this change
- [ ] I have specified the model used (with version and capability details)
- [ ] I have checked the canonical Verrail documents and confirmed this PR aligns with the product direction
- [ ] I have searched GitHub for duplicate or related PRs and linked them above
- [ ] I have either (a) linked existing issues with `Fixes: #` / `Closes #` / `Refs #` OR (b) described the issue in-PR following the relevant issue template
- [ ] I have not referenced internal or instance-local issues or links
- [ ] My branch name describes the change (e.g. `docs/...`, `fix/...`) and contains no internal Paperclip ticket id or instance-derived details
- [ ] I have run tests locally and they pass
- [ ] I have added or updated tests where applicable
- [ ] I have updated relevant documentation to reflect my changes
- [ ] I have considered and documented any risks above
- [ ] All required Verrail CI gates are green
- [ ] I will address all reviewer comments before requesting merge
