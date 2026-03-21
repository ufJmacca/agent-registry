# Implementation Notes: Technical Curator Web Console Rollout

This document is the pre-implementation contract for applying the Technical Curator design language to the current server-rendered web console. It exists to keep the route-to-reference mapping explicit, force truthful substitutions, and prevent unsupported mock controls from being rendered as inert UI.

Unsupported mock controls must be omitted rather than rendered inert.

## Route-to-Reference Mapping

| Current route | Reference asset | Implementation focus |
| --- | --- | --- |
| `/` | `sign_in_landing_page` | Preserve tenant and subject selection while reframing the page into the editorial hero, access card, and setup-pending companion layout. |
| `/console` | `console_dashboard` | Apply the shared shell and bento hierarchy while surfacing only real identity, tenant, version, and admin data. |
| `/tenants/:tenantId/environments` | `environment_management` | Restyle the environment list and add-environment panel into the reference structure without changing GET or POST behavior. |
| `/tenants/:tenantId/drafts/new` | `new_draft_registration` | Preserve all existing fields and multipart semantics while reorganizing the form into the reference groupings. |
| `/tenants/:tenantId/review` | `review_queue` | Present pending versions as a high-density decision queue without adding dead filters, tabs, or history controls. |
| `/tenants/:tenantId/agents/:agentId` | `active_agent_detail` | Use the reference shell and detail composition for overlay state, publication panels, version history, and admin controls. |
| `/tenants/:tenantId/agents/:agentId/versions/:versionId` | `version_detail` | Use the dedicated `version_detail` reference for the technical dossier layout, action cluster, manifest treatment, and publication sections. |

## Omissions and Truthful Substitutions

When a reference includes content or controls that the current product cannot support truthfully:

- Omit unsupported mock controls instead of rendering disabled, dead, or misleading affordances.
- Replace mock-only content with the closest truthful current product data.
- Preserve every existing route, permission boundary, field name, form target, and backend integration.
- Record the omission or substitution in the table below as implementation proceeds.

| Route | Reference asset | Mock-only content or unsupported control | Truthful implementation replacement or omission | Reason |
| --- | --- | --- | --- | --- |
| `/` | `sign_in_landing_page` | Email/password fields plus SSO and biometrics buttons | Tenant and subject selectors inside the access card; protocol buttons omitted | The console only supports the existing mock sign-in flow backed by tenant memberships. |
| `/console` | `console_dashboard` | Recent-intelligence activity feed, utilization ring, and urgent counters | Visible versions, active agents, tenant identity, and role-sensitive entry points | The current dashboard exposes registry inventory, not synthetic analytics. |
| `/tenants/:tenantId/environments` | `environment_management` | Export/log actions and cluster metadata columns such as region, uptime, and load | Environment-count summary cards and the existing add-environment form | The environment route only stores configured publication targets and the create action. |
| `/tenants/:tenantId/drafts/new` | `new_draft_registration` | Model selector, autosave language, and separate save-draft workflow | Existing multipart registration form grouped into metadata, contracts, publication panels, and a create-draft footer | The product only supports the current draft creation POST and does not expose model or autosave state. |
| `/tenants/:tenantId/review` | `review_queue` | History tab, search/filter/sort controls, and diff-review affordances | Pending-only decision queue with inspect-version, approve, and reject actions | The current review route only serves pending versions and immediate moderation actions. |
| `/tenants/:tenantId/agents/:agentId` | `active_agent_detail` | Restart, redeploy, and add-custom-protocol controls | Truthful overlay controls, publication telemetry, health, and version-history navigation | The active-agent route manages overlays and inspection only; deployment operations are not implemented. |
| `/tenants/:tenantId/agents/:agentId/versions/:versionId` | `version_detail` | Mock latency, throughput, and memory contract stats | Contract-summary cards derived from stored header-contract count, context-contract count, and publication-target count | The current version detail route does not store benchmark metrics for an individual version. |
| `/tenants/:tenantId/agents/:agentId/versions/:versionId` | `version_detail` | Mock audit-history narrative entries | Review-history timeline built from submitted, approved, rejected, and active-release metadata already stored on the version | The app records review-state timestamps, not editorial audit annotations. |
| `/tenants/:tenantId/agents/:agentId/versions/:versionId` | `version_detail` | Mock publisher, license, and production-readiness side metadata | Version-metadata panel exposing truthful publisher, version, capability, tag, role, and scope data | License and readiness fields are not available on the current route payload. |
| `/tenants/:tenantId/agents/:agentId/versions/:versionId` | `version_detail` | Copy-JSON utility and pending-review checklist callouts | Static manifest presentation plus truthful review-state copy and POST actions only where supported | The server-rendered route does not provide a copy utility or separate verification checklist data. |

## DESIGN.md Checklist

- No-Line Rule: Verified. All seven pages rely on surface changes, card nesting, and whitespace for structure rather than visible section dividers.
- Surface hierarchy: Verified. The shell, hero cards, and dense technical panels step from tinted background to elevated white surfaces in the same order across the console.
- Glass treatment: Verified. Glassmorphism only appears on floating shells, specifically the public and authenticated top bars; content panels remain solid surfaces.
- CTA treatment: Verified. Gradient primary CTAs are used for sign-in, new draft, approve, create environment, and create draft actions instead of flat solids.
- Typography: Verified. Manrope is used for hero and section headlines through the shared asset pipeline.
- Typography: Verified. Inter remains the body, label, form, and dense technical text face.
- Palette: Verified. Implemented pages stay within soft slate, deep blue, and neutral surfaces without introducing saturated accent colors.
- Layout rhythm: Verified. Each reference is adapted with generous spacing, oversized headlines, and deliberate asymmetry between main content and supporting rails.
- Card structure: Verified. Cards and background shifts replace separators, especially on the dashboard, dossier, and review queue compositions.
- Shadows: Verified. Shadows are low-contrast and blue-tinted; no hard black drop shadows are used.
- Shared shell: Verified. All authenticated routes use the same top bar, left rail, padding rhythm, navigation treatment, and button/input language.
- Responsiveness and accessibility: Verified. The visual suite captures desktop `1440x1200` and mobile `390x844` baselines, while the routes retain semantic forms, headings, and keyboard-operable controls.

## Fidelity Review Ledger

Each route below must be reviewed against both the reference `code.html` and `screen.png` before the page is considered complete.

### `/`

- Reference assets: `sign_in_landing_page/code.html`, `sign_in_landing_page/screen.png`
- Shell composition and overall layout: The implemented public shell keeps the floating top bar, oversized editorial hero, and two-panel stage from the reference, with the access card on the left and the setup/state companion on the right.
- Headline scale and spacing: The public hero uses the same oversized Manrope headline treatment and broad vertical spacing seen in the reference before the interaction panels begin.
- CTA treatment and access-card hierarchy: The gradient `Authenticate Identity` action anchors the access card, while setup information stays secondary but still prominent in its own panel.
- Card and background layering: Frosted chrome is reserved for the top bar; the page body uses a soft aura background and stacked white cards rather than flat sections.
- Navigation treatment: The top bar keeps a minimal family resemblance to the reference, but swaps the mock marketing nav for anchored `Setup State` and `Console Access` links that are truthful to the current route.
- Information density and grouping: Tenant selection and subject selection are grouped into a single interaction card, while deployment state and membership/setup context move into the adjacent summary panel.
- Functional constraints to preserve: Hosted tenant selection, self-hosted tenant collapse, setup-pending rendering, and signed-in redirection to `/console` all stay intact.
- Intentional deviations and truthful substitutions: Mock credential fields, SSO, and biometrics controls were removed and replaced with the current tenant/subject sign-in flow and truthful membership/setup copy.

### `/console`

- Reference assets: `console_dashboard/code.html`, `console_dashboard/screen.png`
- Shell composition and overall layout: The authenticated shell maps the reference’s side navigation and bento dashboard layout into the current route, with a large overview hero, stacked support cards, and a prominent inventory panel.
- Headline scale and spacing: `System Overview` remains the dominant dashboard headline, with the same oversized hero proportion and extra breathing room above the secondary cards.
- CTA treatment and dashboard hierarchy: The primary publish path is elevated as a gradient `New Draft Registration` card, while environment and review entry points remain secondary admin cards.
- Card and background layering: A dark hero card establishes the dashboard focal point, surrounded by pale statistical and inventory cards that mirror the reference’s layered hierarchy.
- Navigation treatment: The shared left rail replaces the reference’s icon-only mock menu with truthful route labels for dashboard, drafts, environments, and review.
- Information density and grouping: Identity, tenant context, visible versions, and active agents are grouped into the bento layout without introducing fake telemetry or analytics widgets.
- Functional constraints to preserve: Publisher and tenant-admin variants remain role-sensitive, and all current destination routes remain reachable from the dashboard.
- Intentional deviations and truthful substitutions: The mock activity feed, urgency counter, and utilization ring were replaced with visible-version inventory and active-agent surfaces backed by real data.

### `/tenants/:tenantId/environments`

- Reference assets: `environment_management/code.html`, `environment_management/screen.png`
- Shell composition and overall layout: The page follows the reference’s large hero plus summary-card opening, then splits into a primary environment catalog column and a secondary create-environment panel.
- Headline scale and spacing: `Environment Management` uses the same large display treatment as the reference and preserves the short technical lede directly beneath it.
- CTA treatment and creation-panel hierarchy: The create-environment action stays present but visually secondary to the configured-environment list, matching the reference’s supporting-panel intent.
- Card and background layering: Three summary cards, a large catalog panel, and an isolated creation card replace the former list-plus-form reading.
- Navigation treatment: The shared authenticated rail keeps the environment route anchored in the same shell as the dashboard and review pages.
- Information density and grouping: Environment count, tenant scope, and access rules are summarized above the catalog, while the right panel contains the only creation control.
- Functional constraints to preserve: Admin-only access, existing GET behavior, and the POST to create environments remain unchanged.
- Intentional deviations and truthful substitutions: Mock cluster rows, uptime/load metrics, export actions, and region metadata were omitted in favor of truthful environment-target summaries and the real add-environment form.

### `/tenants/:tenantId/drafts/new`

- Reference assets: `new_draft_registration/code.html`, `new_draft_registration/screen.png`
- Shell composition and overall layout: The route now mirrors the reference’s editorial form flow, with a large hero, a supporting review note, grouped metadata/contracts sections, environment-publication panels, and a dedicated action footer.
- Headline scale and spacing: `New Draft Registration` keeps the reference’s oversized title and deliberate spacing before the dense form fields begin.
- CTA treatment and action-footer placement: The create action is isolated in a footer card as the dominant gradient CTA, with the secondary navigation action kept separate.
- Card and background layering: Metadata, contracts, and each environment publication are segmented into layered panels instead of one long undifferentiated form.
- Navigation treatment: The authenticated rail and top bar remain shared with the rest of the console, preserving the product-family shell while the form body follows the reference.
- Information density and grouping: General metadata, shared contracts, and per-environment publication inputs are grouped exactly along the reference’s intended reading order.
- Functional constraints to preserve: Existing field names, multipart uploads, textarea contracts, and the draft-creation POST target remain untouched.
- Intentional deviations and truthful substitutions: The reference’s model selector, autosave language, and multi-action draft workflow were removed because the product only supports the current create-draft submission semantics.

### `/tenants/:tenantId/review`

- Reference assets: `review_queue/code.html`, `review_queue/screen.png`
- Shell composition and overall layout: The page follows the reference’s queue-first composition, using a large review hero and stacked horizontal decision cards instead of generic cards or tables.
- Headline scale and spacing: `Review Queue` stays as the dominant large-form headline with a single supporting summary and a compact awaiting-decision stat tile.
- CTA treatment and decision-action hierarchy: Approve actions remain the dominant gradient buttons, with reject controls secondary but immediately adjacent inside each queue row.
- Card and background layering: Each pending version sits inside its own elevated surface with the action cluster isolated on the right to preserve the reference’s high-density decision feel.
- Navigation treatment: The shared rail retains a truthful `Review` destination instead of the reference’s extra nav items.
- Information density and grouping: Each row groups the version identity, submission timestamp, inspect link, reject-reason field, and moderation actions without introducing unsupported controls.
- Functional constraints to preserve: Tenant-admin-only access remains enforced, and approve/reject actions still submit directly from the queue.
- Intentional deviations and truthful substitutions: Pending/history tabs, search, sort, and diff-review controls were omitted because the route only supports the current pending queue and direct moderation workflow.

### `/tenants/:tenantId/agents/:agentId`

- Reference assets: `active_agent_detail/code.html`, `active_agent_detail/screen.png`
- Shell composition and overall layout: The page keeps the reference’s strong hero, publication section, overlay-control area, and version-history rail, adapted to the shared authenticated shell.
- Headline scale and spacing: The active-agent hero uses the same oversized title, state chips, and generous lede spacing as the reference before the lower technical sections begin.
- CTA treatment and admin-action hierarchy: Overlay actions for the agent and each environment publication are kept prominent, but remain scoped to the actual deprecate/disable behaviors the backend supports.
- Card and background layering: Publication cards, overlay summaries, and the audit/version rail create a layered technical artifact instead of a single detail sheet.
- Navigation treatment: The left rail stays shared, and a contextual `Agent Detail` destination is introduced only where the current route genuinely exists.
- Information density and grouping: Active publication surfaces, overlay state, admin actions, and version history are separated into clear regions that match the reference’s technical-detail rhythm.
- Functional constraints to preserve: Admin-only access, overlay usability, and version-history links remain intact on the existing routes.
- Intentional deviations and truthful substitutions: Restart, redeploy, global-maintenance toggles, and custom-protocol actions from the mock were replaced with truthful overlay controls, publication telemetry, and health surfaces.

### `/tenants/:tenantId/agents/:agentId/versions/:versionId`

- Reference assets: `version_detail/code.html`, `version_detail/screen.png`
- Shell composition and overall layout: The dedicated version route now reads as a dossier, with a wide headline hero, left-side technical stack, and right-side review/meta rail in the same overall arrangement as the reference.
- Headline scale and spacing: The primary headline, summary lead, and state-chip row preserve the reference’s hierarchy while using truthful version identity and approval-state data.
- CTA treatment and action-cluster hierarchy: Existing submit, approve, and reject POST actions sit inside the review-state rail and only appear for the states that truthfully support them.
- Card and background layering: Contract summary cards, a dark manifest panel, and stacked environment-publication cards replace the fallback split-card treatment and match the reference’s elevated dossier feel.
- Navigation treatment: The shared authenticated shell is preserved, with a contextual `Version Detail` nav item standing in for the reference’s bespoke left-nav entry.
- Information density and grouping: Publication contracts, manifest, review history, per-environment publication details, telemetry, and health history are grouped into clear technical sections with asymmetrical spacing.
- Functional constraints to preserve: Publisher ownership checks, admin-only telemetry and health history, and existing state transitions all remain on the current server-rendered routes.
- Intentional deviations and truthful substitutions: Mock reference metrics, audit annotations, license metadata, production-readiness claims, and copy-json affordances were replaced or omitted in favor of stored contract counts, review timestamps, version metadata, and truthful route actions.

## Version Detail Deviation Table

The current version detail route has a dedicated `version_detail` reference. This table must be completed during implementation whenever the reference includes mock dossier content that needs a truthful replacement.

| Reference mock detail | Truthful implementation replacement | Reason for deviation |
| --- | --- | --- |
| Latency, throughput, and memory tiles in the publication-contract bento | Header-field count, context-key count, and publication-target count | The current registry does not persist benchmark metrics for version-detail pages. |
| Audit-history mock copy describing internal branch and baseline events | Review timeline built from stored submission, approval, rejection, and active-release records | Only review-state metadata is available on the current route. |
| Publisher, license, and environment side metadata from the mock | Publisher, version identity, capability, tag, role, and scope metadata from the stored version record | License and production-readiness fields are not part of the current product payload. |
