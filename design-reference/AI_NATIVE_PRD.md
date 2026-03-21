# AI-Native PRD: Apply "Technical Curator" Designs to the Current Web Console

## Summary
Apply the designs in `/workspace/design-reference` to every current server-rendered UI page in the web console, while preserving all existing routes, permissions, form behavior, and backend integrations.

This work is not complete when the pages merely "look better." It is only complete when:

1. each current page is aligned to its mapped design reference,
2. existing functional flows still pass,
3. automated visual verification proves the implemented pages stay close to the approved design language.

## Problem
The current web console is functionally complete enough to support sign-in, drafting, review, environment management, and agent inspection, but the UI needs to be elevated to match the "Technical Curator" reference system.

The challenge is not only visual polish. We need a design application plan that:

- maps every current page to a specific reference,
- preserves current product behavior,
- avoids introducing fake or dead controls,
- keeps the UI consistent across all pages,
- and creates a repeatable test harness so future edits do not drift from the approved design direction.

## Goals
- Apply the "Technical Curator" system from `DESIGN.md` across all current UI pages.
- Preserve all current routes and functional flows.
- Reuse a shared shell and shared design tokens so the pages feel like one product.
- Add automated verification strong enough to catch visual drift.
- Add page-level acceptance criteria that an implementation agent can execute against.

## Non-Goals
- No route changes.
- No workflow changes to sign-in, drafting, review, overlays, or environment creation.
- No API contract changes.
- No migration from server-rendered HTML to a client framework.
- No new product features that are only present in the design mocks but unsupported by current data or behavior.
- No decorative controls that cannot be implemented or that misrepresent current system capability.

## Source Inputs
- Design system guidance:
  `/workspace/design-reference/DESIGN.md`
- Page references:
  `/workspace/design-reference/sign_in_landing_page`
  `/workspace/design-reference/console_dashboard`
  `/workspace/design-reference/environment_management`
  `/workspace/design-reference/new_draft_registration`
  `/workspace/design-reference/review_queue`
  `/workspace/design-reference/active_agent_detail`
  `/workspace/design-reference/version_detail`
- Current implementation:
  `/workspace/apps/web/src/http.ts`
- Current behavioral coverage:
  `/workspace/tests/web-console-ui.test.ts`

## Current UI Page Inventory

### 1. `/`
Purpose: sign-in and setup landing page.

### 2. `/console`
Purpose: dashboard / home page for the signed-in tenant context.

### 3. `/tenants/:tenantId/environments`
Purpose: environment management page for tenant admins.

### 4. `/tenants/:tenantId/drafts/new`
Purpose: new draft registration page for publishers and tenant admins.

### 5. `/tenants/:tenantId/review`
Purpose: review queue for pending versions.

### 6. `/tenants/:tenantId/agents/:agentId`
Purpose: active agent detail page for tenant admins.

### 7. `/tenants/:tenantId/agents/:agentId/versions/:versionId`
Purpose: version detail page for publishers and tenant admins.

## Design Reference Mapping

| Current route | Reference asset | Implementation rule |
| --- | --- | --- |
| `/` | `sign_in_landing_page` | Preserve tenant/subject mock sign-in flow, but restyle into the reference composition. |
| `/console` | `console_dashboard` | Use the reference shell and bento-card hierarchy, but only surface real data already available in the app. |
| `/tenants/:tenantId/environments` | `environment_management` | Match the structural layout and editorial spacing; only show real environment actions and data. |
| `/tenants/:tenantId/drafts/new` | `new_draft_registration` | Keep all existing fields and multipart behavior; reorganize and style according to the reference. |
| `/tenants/:tenantId/review` | `review_queue` | Match the queue/list feel and control grouping; do not add dead filters or tabs. |
| `/tenants/:tenantId/agents/:agentId` | `active_agent_detail` | Match the side-nav/top-bar/detail layout and control styling. |
| `/tenants/:tenantId/agents/:agentId/versions/:versionId` | `version_detail` | Match the dedicated version detail layout, technical manifest treatment, and action grouping while preserving current route behavior. |

## Version Detail Reference
There is now a dedicated reference asset for the current Version Detail page: `design-reference/version_detail`.

Implementation rules:

- Preserve current truthful data and behavior, but map them into the reference's structure for publication contracts, technical manifest, action cluster, and supporting technical sections.
- If the reference includes mock content that does not exist in current product data, replace it with the closest truthful equivalent rather than leaving inert placeholders.

## Global Design System Requirements

### Creative Direction
The UI must read as "Architectural Precision meets Editorial Sophistication," not as a default SaaS admin.

### Required Global Rules
- Enforce the "No-Line Rule": no standard 1px section dividers for layout structure.
- Use surface hierarchy, not borders, to define regions.
- Use glassmorphism only for truly floating shells like sticky nav or elevated panels.
- Use gradient primary CTAs, not flat primary fills.
- Use `Manrope` for display/headlines and `Inter` for body/labels.
- Keep the palette soft and technical: slate, deep blue, toned neutrals.
- Use generous whitespace and asymmetry where appropriate.
- Prefer layered cards over hard separators.
- Avoid pure black text and hard black shadows.
- Use tinted, low-contrast ambient shadows only when necessary.

### Shared Shell Requirement
All authenticated pages must share a common shell:

- sticky or fixed top bar,
- persistent navigation rail or equivalent shared navigation structure,
- common typography scale,
- common page padding rhythm,
- common button/input/chip treatments,
- consistent action placement patterns.

The sign-in page may use a different shell, but it must still clearly belong to the same product family.

### Accessibility and Responsiveness
- Preserve semantic headings, labels, buttons, and form behavior.
- Maintain keyboard operability for all forms and actions.
- Ensure color contrast remains accessible despite the softened palette.
- Ensure every page works at desktop and mobile widths.
- Side navigation may collapse on smaller screens, but information hierarchy must remain intact.

## Functional Guardrails
- Existing route behavior must remain unchanged.
- Existing permissions must remain unchanged.
- Existing form field names and POST targets must remain unchanged unless tests are updated alongside them.
- Existing database-backed content must remain truthful.
- Any control shown in the UI must either be implemented or removed.
- Do not add "placeholder" actions that imply features the app does not support.
- The design may improve hierarchy and presentation, but it must not invent fake product state.

## Page-Level Product Requirements

### `/` Sign-In and Setup Landing
Reference: `sign_in_landing_page`

Requirements:
- Keep the page as the public entry point.
- Preserve the current tenant and subject selection behavior.
- Reframe the current mock sign-in UI into the reference layout:
  - editorial hero on the left/top,
  - access card as the primary interaction,
  - setup-pending state as a secondary but prominent companion panel.
- When the app is bootstrapped, the page must emphasize sign-in.
- When the app is not bootstrapped, the page must emphasize setup pending without exposing internal errors.

Acceptance criteria:
- Signed-out users see a high-fidelity design derived from the reference, not the current minimal card stack.
- Signed-in users still redirect to `/console`.
- Hosted mode tenant selection and self-hosted tenant collapse behavior still work.

### `/console` Console Dashboard
Reference: `console_dashboard`

Requirements:
- Make this the clear home page after sign-in.
- Use the bento-style dashboard layout and strong hierarchy from the reference.
- Map existing real data into the layout:
  - signed-in identity and tenant context,
  - visible versions,
  - active agents for admins,
  - role-sensitive entry points for draft creation, review, and environment management.
- Avoid fake "analytics" values unless backed by real data. Empty or unavailable areas must be honestly presented.

Acceptance criteria:
- The page feels like the dashboard reference in shell, spacing, card density, and CTA hierarchy.
- Publisher and tenant-admin views remain role-sensitive.
- Existing navigation targets remain reachable.

### `/tenants/:tenantId/environments` Environment Management
Reference: `environment_management`

Requirements:
- Use the reference page structure and premium technical feel.
- Present configured environments as the primary list.
- Present "Add Environment" as a clearly secondary creation panel with the same visual language.
- If the reference contains extra non-functional controls, those must only be included if implemented; otherwise omit them.

Acceptance criteria:
- The page no longer reads as a simple list plus form.
- Existing GET and POST environment flows still pass.
- Admin-only access remains enforced.

### `/tenants/:tenantId/drafts/new` New Draft Registration
Reference: `new_draft_registration`

Requirements:
- Preserve every existing form field and multipart upload behavior.
- Reorganize the page using the reference grouping:
  - general metadata,
  - shared contracts,
  - environment publication sections,
  - action footer.
- Make the form visually scannable despite high density.
- Use the design system's softened inputs and editorial section spacing.

Acceptance criteria:
- A publisher can still create a draft using the same route and form semantics.
- The page looks intentionally designed, not like a long default form.
- Environment publication sections feel like structured technical panels, not repeated plain fieldsets.

### `/tenants/:tenantId/review` Review Queue
Reference: `review_queue`

Requirements:
- Present pending versions as a high-density but readable queue.
- Use the reference's list-item composition for each reviewable entry.
- Retain truthful, real data only.
- Approval and rejection actions must remain immediately available and visually obvious.
- Search/filter/history controls from the reference are optional unless they are implemented end-to-end. No dead controls.

Acceptance criteria:
- Review entries feel like a curated decision queue rather than generic cards.
- Approve and reject are visually distinct and consistent with the reference treatment.
- Tenant-admin-only behavior remains intact.

### `/tenants/:tenantId/agents/:agentId` Active Agent Detail
Reference: `active_agent_detail`

Requirements:
- Use the reference as the primary visual model.
- Present the active agent as a premium technical artifact:
  - strong headline,
  - publication panels,
  - overlay state,
  - version history,
  - admin actions.
- Environment-level and agent-level overlay actions must remain obvious without feeling heavy.

Acceptance criteria:
- The page closely follows the reference shell and detail presentation.
- Overlay state and publication controls remain usable.
- Version history links remain easy to locate.

### `/tenants/:tenantId/agents/:agentId/versions/:versionId` Version Detail
Reference: `version_detail`

Requirements:
- Use the dedicated `version_detail` design as the primary visual model.
- Treat the page as a technical dossier for one version.
- Present:
  - headline and approval status,
  - version metadata,
  - publication contracts,
  - technical manifest / raw card presentation,
  - contracts,
  - per-environment publication sections,
  - telemetry,
  - health history,
  - approval/rejection/submission actions.
- Match the reference's action cluster layout and elevated technical-panel styling.
- Use asymmetry and spacing to reduce density while preserving completeness.

Acceptance criteria:
- The page closely follows the dedicated `version_detail` reference in layout, hierarchy, and component treatment.
- Publishers can still submit drafts.
- Tenant admins can still approve/reject pending versions.
- The page no longer relies on a derived fallback design.

## Implementation Workstreams

### Workstream 1: Shared Foundation
- Extract shared design tokens from `DESIGN.md`.
- Standardize typography, colors, spacing, glass treatment, shadows, chips, buttons, and form styling.
- Create a reusable authenticated shell for all signed-in pages.

### Workstream 2: Page Refactors
- Refactor each page to match its mapped reference.
- Preserve route handlers and form actions.
- Remove or avoid inert controls that cannot be backed by real behavior.

### Workstream 3: Version Detail Integration
- Apply the dedicated `version_detail` reference to the existing Version Detail route.
- Map current version-specific data into the reference's publication contract, manifest, and action sections.
- Document any intentional deviations where the reference contains mock-only content not supported by current product data.

### Workstream 4: Verification
- Expand functional route tests.
- Add automated visual regression coverage.
- Add a manual design review checklist tied to `DESIGN.md`.

## Test and Verification Requirements

### Functional Regression
Existing flows in `/workspace/tests/web-console-ui.test.ts` must continue to pass:
- sign-in and session behavior,
- draft creation,
- draft submission,
- environment creation,
- review actions,
- overlay actions,
- role-based access,
- self-hosted routing behavior.

Add or update assertions where necessary for:
- shared shell presence,
- navigation affordances,
- page-specific key headings,
- role-sensitive CTA presence.

### Automated Visual Regression
Add a visual regression test suite for the following pages:
- `/`
- `/console`
- `/tenants/tenant-alpha/environments`
- `/tenants/tenant-alpha/drafts/new`
- `/tenants/tenant-alpha/review`
- `/tenants/tenant-alpha/agents/<agentId>`
- `/tenants/tenant-alpha/agents/<agentId>/versions/<versionId>`

Recommended approach:
- use a headless browser with deterministic seeded data,
- capture screenshots at desktop and mobile widths,
- compare against committed baseline screenshots,
- mask or stabilize dynamic regions where necessary,
- fail CI on meaningful visual drift.

Target viewports:
- Desktop: 1440x1200
- Mobile: 390x844

Suggested fidelity rule:
- overall diff must stay below an agreed threshold after masking dynamic content,
- shell, typography scale, spacing rhythm, surface hierarchy, and CTA placement must be visually stable,
- any major layout shift or component regression must fail the suite.

### Design Review Checklist
Before sign-off, manually verify:
- no hard section dividers are used as primary structure,
- glass effects only appear on floating shells,
- primary CTAs use gradient treatment,
- typography uses Manrope for display/headlines and Inter for body/labels,
- background/surface hierarchy matches `DESIGN.md`,
- cards and sections breathe with generous spacing,
- the UI avoids generic admin-dashboard visual clichés,
- mobile layout still feels intentional rather than collapsed.

### Fidelity Review Against Reference Assets
For each mapped page:
- compare implemented page against both `code.html` and `screen.png`,
- verify shell composition,
- verify headline scale and spacing,
- verify CTA treatment,
- verify card/background layering,
- verify navigation treatment,
- verify information density and grouping,
- document any intentional deviations.

### Allowed Deviations
The following deviations are acceptable only when documented:
- replacing mock placeholder content from a reference with truthful real product data,
- omitting controls from a reference that would otherwise be non-functional,
- adapting layout to server-rendered form semantics already required by the current app,
- adapting `version_detail` mock content to the nearest truthful current Version Detail data.

## Delivery Requirements
The implementation is complete only when all of the following exist:
- updated UI for all seven current pages,
- a shared design foundation applied consistently,
- functional tests passing,
- visual regression tests added and passing,
- explicit documentation of any intentional deviations from the `version_detail` reference,
- no dead controls added solely to mimic the reference.

## Open Questions
- Which visual testing tool should be standardized for the repo?
- Should reference screenshot baselines live under `tests/visual/` or a dedicated `design-reference/baselines/` folder?

## Default Decision If Unblocked Work Must Continue
If no further direction is provided:
- place the implementation work on the existing server-rendered web console,
- use the seven provided reference assets as hard visual anchors,
- add a screenshot-based regression suite in the test tree,
- and consider the work unfinished until both functional and visual verification pass.
