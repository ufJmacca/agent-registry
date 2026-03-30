# AI-Native PRD: Near-Fidelity Alignment of the Web Console to the Design References

## Summary
Align every current server-rendered web page with the `design-reference` system as closely as possible while preserving truthful product behavior, existing routes, permissions, form submissions, and backend integrations.

This work is not complete when the UI is merely "improved" or "inspired by" the references. It is complete only when:

1. every current route is visually and structurally aligned with its mapped reference,
2. shared chrome and repeated visual language are extracted into central files instead of duplicated per page,
3. truthful substitutions are used wherever the mock contains unsupported content,
4. automated and manual verification show the implemented pages stay materially close to the approved references.

## Core Intent
The goal is to move from "styled server-rendered admin pages" to a near-direct implementation of the "Technical Curator" system.

The implementation should feel like one coherent product with:
- a deliberate public shell for sign-in and setup,
- a deliberate authenticated shell for all signed-in routes,
- shared technical-editorial components,
- minimal page-specific one-off styling,
- and a repeatable AI-native fidelity loop that keeps iterating until the gap to the references is small and defensible.

## Problem
The current web console already supports the right behaviors, but the implementation is only partially componentized and is still too loose relative to the design references.

Current structural gaps:
- only some pages have dedicated render modules under `apps/web/src/ui/pages/`,
- `Environment Management`, `Review Queue`, and `Active Agent Detail` are still rendered inline in `apps/web/src/http.ts`,
- shared visual language exists, but too much page structure is still expressed as one-off markup and monolithic CSS,
- the current PRD focuses on mapping pages to references, but it does not explicitly require a deep reference audit before implementation,
- the current PRD also does not clearly stage "shared extraction first, route implementation second, AI-native refinement third."

## Goals
- Deeply analyze all `design-reference` assets before implementation begins.
- Extract shared shell, primitives, and recurring page structures into central files.
- Move all page rendering out of `apps/web/src/http.ts` so route handling is orchestration-only.
- Rebuild each current route to match its mapped reference as closely as truthful behavior allows.
- Use AI-native web-design iteration after shared extraction so each page is refined against the reference until materially aligned.
- Keep existing functional and visual verification as part of the implementation contract.

## Non-Goals
- No route changes.
- No API or database contract changes.
- No client-side framework migration.
- No fake analytics, fake filters, fake tabs, or dead controls copied from the references.
- No placeholder content that implies product capabilities the console does not support.
- No bypassing truthful empty, pending, restricted, or unavailable states just to look like the mock.

## Source Inputs
- Design system guidance:
  `/workspace/design-reference/DESIGN.md`
- Reference assets:
  `/workspace/design-reference/sign_in_landing_page/code.html`
  `/workspace/design-reference/sign_in_landing_page/screen.png`
  `/workspace/design-reference/console_dashboard/code.html`
  `/workspace/design-reference/console_dashboard/screen.png`
  `/workspace/design-reference/environment_management/code.html`
  `/workspace/design-reference/environment_management/screen.png`
  `/workspace/design-reference/new_draft_registration/code.html`
  `/workspace/design-reference/new_draft_registration/screen.png`
  `/workspace/design-reference/review_queue/code.html`
  `/workspace/design-reference/review_queue/screen.png`
  `/workspace/design-reference/active_agent_detail/code.html`
  `/workspace/design-reference/active_agent_detail/screen.png`
  `/workspace/design-reference/version_detail/code.html`
  `/workspace/design-reference/version_detail/screen.png`
- Current web implementation:
  `/workspace/apps/web/src/http.ts`
  `/workspace/apps/web/src/ui/shell.ts`
  `/workspace/apps/web/src/ui/document.ts`
  `/workspace/apps/web/src/ui/assets.ts`
  `/workspace/apps/web/src/ui/icons.ts`
  `/workspace/apps/web/src/ui/pages/sign-in.ts`
  `/workspace/apps/web/src/ui/pages/dashboard.ts`
  `/workspace/apps/web/src/ui/pages/draft-registration.ts`
  `/workspace/apps/web/src/ui/pages/version-detail.ts`
  `/workspace/apps/web/assets/console.css`
- Current verification:
  `/workspace/tests/web-console-ui.test.ts`
  `/workspace/tests/visual/web-console.visual.spec.ts`
  `/workspace/tests/fidelity-signoff.test.ts`
  `/workspace/design-reference/IMPLEMENTATION_NOTES.md`

## Current Route Inventory

| Route | Purpose | Current renderer location |
| --- | --- | --- |
| `/` | Public sign-in and setup-pending landing page | `ui/pages/sign-in.ts` via `http.ts` |
| `/console` | Signed-in dashboard home page | `ui/pages/dashboard.ts` via `http.ts` |
| `/tenants/:tenantId/environments` | Tenant environment management | inline in `http.ts` |
| `/tenants/:tenantId/drafts/new` | New draft registration form | `ui/pages/draft-registration.ts` via `http.ts` |
| `/tenants/:tenantId/review` | Review queue | inline in `http.ts` |
| `/tenants/:tenantId/agents/:agentId` | Active agent detail | inline in `http.ts` |
| `/tenants/:tenantId/agents/:agentId/versions/:versionId` | Version detail dossier | `ui/pages/version-detail.ts` via `http.ts` |

## Deep Reference Analysis Requirements
Before implementation work begins, the agent must deeply analyze every `code.html` and `screen.png`.

This is a required phase, not optional prep.

### Analysis Deliverable
Create or update a structured reference audit in `design-reference/IMPLEMENTATION_NOTES.md` that records:
- shared shell patterns across the references,
- shared component patterns across the references,
- page-unique patterns for each route,
- truthful substitutions required by current product behavior,
- reference-only elements that must be omitted,
- unresolved fidelity deltas after each implementation pass.

### How to Interpret the Reference Assets
- `screen.png` is authoritative for macro layout, spacing rhythm, visual weight, asymmetry, and atmosphere.
- `code.html` is authoritative for component composition, repeated treatments, and likely DOM grouping.
- If `screen.png` and `code.html` differ, favor `screen.png` for visual hierarchy and `code.html` for component intent.
- Unsupported mock content must be replaced with truthful real content, not simulated.

## Design Reference Analysis Summary
The design-reference set already shows a strong repeated system that should be centralized instead of reimplemented per page.

### Shared Public-Shell Traits
- Sticky/fixed translucent top bar with soft blur.
- Strong centered or centered-feeling hero headline.
- Large editorial breathing room above the primary interaction.
- One primary interaction card plus one companion/secondary editorial panel.
- Soft footer treatment and spacious canvas.

### Shared Authenticated-Shell Traits
- Fixed or sticky top bar with glass treatment.
- Persistent left rail navigation on desktop.
- Large content canvas with generous top padding and wide gutters.
- Strong page intro with headline plus subdued contextual metadata.
- Sections defined by surface shifts, card elevation, and whitespace rather than dividers.

### Shared Component Traits Across the References
- Manrope for display/headline hierarchy and Inter for operational text.
- Uppercase micro-labels with high tracking.
- Gradient primary CTA treatment.
- Soft containers: `surface-container-lowest`, `surface-container-low`, `surface-container-high`.
- Rounded cards and pills.
- Low-contrast ambient shadow rather than obvious drop shadows.
- Utility iconography and technical micro-panels.
- No hard 1px layout dividers as primary structure.

### Current Implementation Gaps Relative to the References
- The shell is present but still less expressive than the reference chrome.
- Shared markup patterns are not centralized enough.
- Three route renderers still live inline in `http.ts`.
- `console.css` already contains the right design direction, but it mixes base styles, shell styles, and page-specific styles without a stricter component architecture.
- Some pages match the references directionally, but not yet with enough near-reference structure to support repeated AI-native refinement.

## Design Reference Mapping

| Route | Reference asset | Fidelity target |
| --- | --- | --- |
| `/` | `sign_in_landing_page` | Near-match public top bar, centered hero, access card, editorial setup companion, and footer rhythm. |
| `/console` | `console_dashboard` | Near-match authenticated shell, bento dashboard hierarchy, primary feature card, supporting tiles, and record-list treatment. |
| `/tenants/:tenantId/environments` | `environment_management` | Near-match page intro, inventory-vs-creation split, panel proportions, and editorial technical-management tone. |
| `/tenants/:tenantId/drafts/new` | `new_draft_registration` | Near-match structured form panels, softened technical input treatment, grouped sections, and deliberate action footer. |
| `/tenants/:tenantId/review` | `review_queue` | Near-match curated queue layout, list density, action grouping, and technical-review tone. |
| `/tenants/:tenantId/agents/:agentId` | `active_agent_detail` | Near-match hero, publication cards, overlay sections, version-history treatment, and right-column/admin control rhythm. |
| `/tenants/:tenantId/agents/:agentId/versions/:versionId` | `version_detail` | Near-match dossier layout, review-state side panel, technical manifest presentation, contract panels, and supporting metadata. |

## Centralization Requirements
Shared elements must be extracted before page-by-page fidelity passes begin.

### Required Refactor Outcome
`apps/web/src/http.ts` must become route orchestration only.

It must not continue to own large inline page templates for:
- environment management,
- review queue,
- active agent detail.

### Required Central Files
The implementation must use central files for shared UI responsibilities. The exact split may evolve, but the result must clearly isolate these responsibilities:

- `apps/web/src/ui/shell.ts`
  - public shell chrome
  - authenticated shell chrome
  - nav composition
  - shell-level metadata blocks
- `apps/web/src/ui/document.ts`
  - HTML document framing
  - escaping helpers
  - preformatted JSON helpers
- `apps/web/src/ui/icons.ts`
  - shared icon markup/helpers only
- `apps/web/src/ui/assets.ts`
  - shared asset path ownership only
- `apps/web/src/ui/pages/*.ts`
  - one module per route
- `apps/web/assets/console.css`
  - design tokens
  - shell/layout rules
  - shared component primitives
  - page-specific sections

### Required New Page Modules
Create dedicated page render modules for the routes that are still inline:
- `apps/web/src/ui/pages/environment-management.ts`
- `apps/web/src/ui/pages/review-queue.ts`
- `apps/web/src/ui/pages/agent-detail.ts`

### Required Shared Primitives
Extract reusable HTML structures for patterns repeated across pages.

At minimum, centralize helpers for:
- page hero / intro blocks,
- section headers with eyebrow + title + supporting copy,
- pill/chip rendering,
- card-head compositions,
- fact and stat tiles,
- action clusters,
- record lists / dossier rows,
- empty-state panels,
- side-panel / secondary-panel compositions.

The goal is that page files mostly compose shared primitives plus route-specific content, rather than re-defining the same visual language repeatedly.

## Implementation Phases

### Phase 0: Deep Reference Audit
Required outputs:
- review all `code.html` and `screen.png` files,
- document shared and page-specific patterns in `IMPLEMENTATION_NOTES.md`,
- identify truthful substitutions and non-functional mock elements,
- identify which pieces belong in shared primitives before any route refactor begins.

### Phase 1: Shared Foundation Extraction
Required outputs:
- move the remaining inline route renderers out of `http.ts`,
- extract shared primitives,
- tighten `console.css` into clear layers,
- standardize the shared public shell and authenticated shell,
- ensure each page renderer consumes shared building blocks rather than ad hoc markup.

This phase is complete only when:
- all seven pages have dedicated render modules,
- `http.ts` contains route wiring and data orchestration only,
- repeated shell and card structures are centralized.

### Phase 2: Page-by-Page Fidelity Implementation
Implement one route at a time against its mapped reference.

For each route:
- review the reference HTML and screenshot,
- map truthful current content into the reference structure,
- omit unsupported controls,
- preserve route/form behavior,
- update the visual baseline and notes for truthful deviations.

### Phase 3: AI-Native Web-Design Iteration
After shared extraction is complete, use the web-design AI-native workflow as a refinement loop rather than as first-pass implementation.

For each page, repeat:
1. capture current implementation at desktop and mobile widths,
2. compare against `screen.png` and `code.html`,
3. identify the highest-value fidelity deltas,
4. implement only those deltas,
5. rerun functional and visual checks,
6. update deviation notes,
7. repeat until the remaining gaps are small, intentional, and documented.

This loop should continue until the page is materially aligned in:
- shell composition,
- layout proportions,
- spacing rhythm,
- CTA placement,
- surface hierarchy,
- typography scale,
- card density,
- and interaction emphasis.

### Phase 4: Fidelity Signoff
Before signoff:
- all functional checks must pass,
- all visual tests must pass,
- `IMPLEMENTATION_NOTES.md` must explain any remaining deviations,
- the remaining deviations must be truthful substitutions, not unfinished design work.

## Page-Level Requirements

### `/` Sign-In and Setup Landing
Reference: `sign_in_landing_page`

Requirements:
- keep public top bar treatment distinct from the authenticated shell,
- preserve current tenant and subject selection behavior,
- preserve signed-in redirect to `/console`,
- use the reference composition: large editorial hero, primary access card, secondary setup/status panel, soft footer rhythm,
- keep setup-pending truthful and prominent when bootstrap is missing,
- keep the visual split between the access panel and the companion panel.

### `/console` Dashboard
Reference: `console_dashboard`

Requirements:
- use the authenticated shell and bento dashboard structure,
- preserve role-sensitive navigation and actions,
- map real versions, active agents, and workspace actions into the dashboard layout,
- use real lists and truthful empty states instead of fake dashboard analytics,
- keep the primary feature card visually dominant.

### `/tenants/:tenantId/environments`
Reference: `environment_management`

Requirements:
- extract into its own page module,
- preserve the current environment list and POST target,
- render inventory as the primary panel and creation as a secondary editorial panel,
- use layout asymmetry and spacing to avoid “list plus form” plainness,
- do not add unsupported filtering or utility controls.

### `/tenants/:tenantId/drafts/new`
Reference: `new_draft_registration`

Requirements:
- preserve every current field name and multipart behavior,
- keep metadata, shared contracts, publication sections, and footer actions as distinct panels,
- make dense technical form content feel curated and scannable,
- use shared form primitives and shared section framing.

### `/tenants/:tenantId/review`
Reference: `review_queue`

Requirements:
- extract into its own page module,
- preserve approve/reject behavior and version-detail linking,
- render queue entries as curated review objects instead of generic cards,
- make decision actions immediately visible,
- omit unsupported filters, tabs, or historical views.

### `/tenants/:tenantId/agents/:agentId`
Reference: `active_agent_detail`

Requirements:
- extract into its own page module,
- preserve truthful overlay state, active publications, and version-history linking,
- present the route as a technical dossier, not as a plain admin record page,
- keep environment controls obvious but not visually heavy,
- use shared hero, stat tile, card-head, and side-panel primitives.

### `/tenants/:tenantId/agents/:agentId/versions/:versionId`
Reference: `version_detail`

Requirements:
- preserve submission, approval, rejection, telemetry, health-history, and raw-card behavior,
- treat the route as a technical dossier with a strong right-column side panel,
- keep truthful review state and manifest content,
- replace mock-only KPIs or metadata with truthful equivalents when needed,
- keep action grouping and technical-manifest treatment near the reference.

## Truthful Substitutions Policy
Truthful substitutions are allowed and required when the reference shows content the product does not currently support.

Allowed substitutions:
- replace mock values with real values,
- replace mock status summaries with real state summaries,
- remove unsupported controls,
- replace unsupported analytics with truthful summaries or empty states,
- adapt reference-only metadata to current real metadata.

Not allowed:
- copying the mock literally when the product cannot support it,
- leaving inert CTA buttons, pills, filters, or tabs,
- inventing fake review state, telemetry, agent state, or metrics.

Every substitution must be documented in `design-reference/IMPLEMENTATION_NOTES.md`.

## Verification Requirements

### Functional Verification
The following must continue to pass:
- `/workspace/tests/web-console-ui.test.ts`
- any route-specific unit tests already covering affected flows

Functional behavior that must remain intact:
- sign-in and session behavior,
- tenant-aware routing,
- environment creation,
- draft creation,
- draft submission,
- review actions,
- overlay actions,
- role-based restrictions,
- self-hosted routing behavior.

### Visual Verification
Use the existing visual suite as the primary guardrail:
- `/workspace/tests/visual/web-console.visual.spec.ts`
- `/workspace/tests/visual/__screenshots__/*.png`

Required viewports:
- desktop `1440x1200`
- mobile `390x844`

Required visual targets:
- shell composition,
- layout proportions,
- spacing and whitespace rhythm,
- card hierarchy,
- CTA placement and treatment,
- navigation treatment,
- major supporting panels,
- truthful empty states.

### Fidelity Signoff Verification
Use `/workspace/tests/fidelity-signoff.test.ts` and `design-reference/IMPLEMENTATION_NOTES.md` to confirm:
- every route has a mapped reference,
- every route has approved baselines,
- DESIGN.md checklist items remain completed,
- version-detail deviations are truthful and documented,
- no placeholder or TODO implementation language remains.

## AI-Native Execution Guidance
The AI-native implementation should slice the work to reduce merge conflicts and keep shared extraction ahead of page refactors.

Recommended sequence:
1. reference audit and fidelity notes update
2. shared shell/primitives extraction
3. move inline renderers into dedicated page modules
4. sign-in page alignment
5. dashboard alignment
6. environment management alignment
7. draft registration alignment
8. review queue alignment
9. active agent detail alignment
10. version detail alignment
11. visual baseline refresh and fidelity signoff

The implementation should not start with seven independent page rewrites against a still-shared monolith. Shared extraction must happen first so the later AI-native page loops converge instead of diverging.

## Completion Criteria
The work is complete only when all of the following are true:
- every current route is visually aligned to its mapped reference,
- all seven pages have dedicated page render modules,
- `apps/web/src/http.ts` no longer owns large inline page markup,
- shared shell and component primitives are centralized,
- truthful substitutions are documented,
- functional tests pass,
- visual regression tests pass,
- fidelity signoff artifacts are updated,
- no dead controls or mock-only features are introduced.
