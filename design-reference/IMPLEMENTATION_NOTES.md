# Implementation Notes: Technical Curator Web Console Rollout

This document records the completed fidelity review for the seven current server-rendered console routes. Each route was reviewed against its mapped `code.html` and `screen.png` reference, then checked against the committed desktop and mobile visual baselines used by the Playwright suite.

Unsupported mock controls were omitted rather than rendered inert.

## Sign-Off Record

- Approver/design authority: Builder agent (Codex) using the repository-stored Technical Curator references as the approval authority for this Ralph slice.
- Review date: 2026-03-23 UTC
- Reference code.html reviewed by: Builder agent (Codex)
- Reference screen.png reviewed by: Builder agent (Codex)
- Manual checklist status: Complete
- Dead controls audit: Complete
- Baseline set: `tests/visual/__screenshots__/` with approved desktop `1440x1200` and mobile `390x844` captures for all seven routes.

## Route-to-Reference Mapping

| Current route | Reference asset | Implementation focus |
| --- | --- | --- |
| `/` | `sign_in_landing_page` | Preserve tenant and subject selection while reframing the page into the editorial hero, access card, and setup-state companion layout. |
| `/console` | `console_dashboard` | Apply the shared shell and bento hierarchy while surfacing only real identity, tenant, version, and admin data. |
| `/tenants/:tenantId/environments` | `environment_management` | Restyle the environment list and add-environment panel into the reference structure without changing GET or POST behavior. |
| `/tenants/:tenantId/drafts/new` | `new_draft_registration` | Preserve all current fields and multipart semantics while reorganizing the form into the reference groupings. |
| `/tenants/:tenantId/review` | `review_queue` | Present pending versions as a high-density decision queue without adding dead filters, tabs, or history controls. |
| `/tenants/:tenantId/agents/:agentId` | `active_agent_detail` | Use the reference shell and detail composition for overlay state, publication panels, version history, and admin controls. |
| `/tenants/:tenantId/agents/:agentId/versions/:versionId` | `version_detail` | Use the dedicated `version_detail` reference for the technical dossier layout, action cluster, manifest treatment, and publication sections. |

## Omissions and Truthful Substitutions

| Route | Reference asset | Mock-only content or unsupported control | Truthful implementation replacement or omission | Reason |
| --- | --- | --- | --- | --- |
| `/` | `sign_in_landing_page` | Organization email, security token, SSO login, biometrics, and marketing navigation links | Tenant selector, subject selector, and the existing `/session` POST sign-in form inside the editorial access card; unsupported public nav links omitted | The current console only supports membership-based mock sign-in and does not expose external auth providers or separate marketing routes. |
| `/console` | `console_dashboard` | Synthetic activity feed, utilization gauges, and mock settings-style destinations | Signed-in identity, tenant context, role-sensitive workspace actions, visible versions, and admin-only active agents rendered inside the shared shell | The app exposes truthful counts and links, not analytics feeds or extra destinations. |
| `/tenants/:tenantId/environments` | `environment_management` | Cluster KPI cards, per-row overflow menus, export JSON, and global logs controls | Configured environment inventory plus the existing add-environment form and POST target | The route currently supports truthful environment listing and creation only. |
| `/tenants/:tenantId/drafts/new` | `new_draft_registration` | Model picker, autosave messaging, save-as-draft / submit-for-review footer actions | Real draft metadata fields, shared contract JSON textareas, per-environment multipart publication panels, and a single create-draft submit action | The current workflow creates one draft version, then uses version detail for later submission; unsupported workflow controls were removed. |
| `/tenants/:tenantId/review` | `review_queue` | History tab, search, filters, load-more affordance, and diff tooling | Truthful pending-review entries with version detail links, approve action, reject reason input, and reject action | The current product has no server-rendered history, filter, or diff endpoints for this queue. |
| `/tenants/:tenantId/agents/:agentId` | `active_agent_detail` | Deploy-update CTA, analytics/deployments/settings rail items, and add-custom-protocol affordance | Active publication panels, agent and environment overlay controls, and direct version history links | The route only supports truthful overlay mutations and dossier navigation. |
| `/tenants/:tenantId/agents/:agentId/versions/:versionId` | `version_detail` | Mock KPI cards, copy-JSON utility, review checklist badges, and side metadata such as license and production-ready labels | Publication contract cards, read-only manifest, review timeline, release metadata, environment dossiers, telemetry, health history, and truthful action cluster | The current route exposes real review and publication data, but it does not store the reference's mock operational metrics or auxiliary utilities. |

## DESIGN.md Checklist

| Checklist item | Status | Review note |
| --- | --- | --- |
| No-Line Rule | Complete | The shared shell and route panels rely on layered surfaces, whitespace, and soft shadows; inputs keep only the low-opacity ghost outline required for accessibility. |
| Surface hierarchy | Complete | `paper`, `surface`, `surface-low`, and `surface-high` layers are used consistently across the shared shell, public shell, dossier cards, and form panels. |
| Glass treatment | Complete | Glassmorphism is limited to floating shells such as the public top bar and authenticated top bar. |
| CTA treatment | Complete | Primary actions use the shared gradient button treatment; secondary actions use softened surface fills instead of flat primary fills. |
| Typography: Manrope headlines | Complete | The document preloads and uses Manrope for `h1`, `h2`, `h3`, and branded display treatment. |
| Typography: Inter body | Complete | The document preloads and uses Inter for body copy, labels, and dense technical text. |
| Palette | Complete | The UI stays within soft slate, deep blue, and toned-neutral surfaces defined by the shared CSS tokens. |
| Layout rhythm | Complete | Hero sections, shell gutters, and dossier stacks preserve the editorial spacing rhythm on desktop and reflow cleanly on mobile. |
| Card structure | Complete | Routes use layered cards and tinted surfaces rather than section dividers to group information. |
| Shadows | Complete | Ambient tinted shadows are used sparingly; the UI avoids pure black text and hard black shadows. |
| Shared shell | Complete | All authenticated routes share the sticky top bar, persistent rail or mobile nav, control styling, and common page padding rhythm. |
| Responsiveness and accessibility | Complete | Desktop and mobile baselines are committed for every route, forms remain semantic, and the mobile layout swaps the rail for a horizontal nav without hiding workflows. |

## Fidelity Review Ledger

Each route below was reviewed against both the reference `code.html` and `screen.png` before sign-off.

### `/`

- Reference assets: `sign_in_landing_page/code.html`, `sign_in_landing_page/screen.png`
- Review evidence: `code.html` and `screen.png` were compared against the current public route plus the approved desktop and mobile baselines on 2026-03-23 UTC.
- Shell composition and overall layout: The public shell keeps the frosted top bar and editorial hero from the reference family, then splits the page into an access panel and a companion status panel that collapse into a single column on mobile.
- Headline scale and spacing: The route now uses a large Manrope hero with wide editorial spacing instead of the previous minimal card stack, matching the reference's headline-first composition.
- CTA treatment and hierarchy: The only primary CTA remains the truthful sign-in submit inside the access card, while setup-pending messaging becomes the lead panel only when the app is not bootstrapped.
- Card and background layering: The page uses the shared paper gradient, soft ambient shadowing, and layered companion cards rather than line dividers.
- Navigation treatment: The reference's extra marketing links were intentionally omitted; the public shell keeps only the truthful brand mark and product-family copy because the current product exposes `/` and the authenticated console, not a marketing site.
- Information density and grouping: Tenant and subject selection stay grouped inside one clear access card, and setup or workspace state lives in the companion card with concise status tiles that remain readable on mobile.
- Functional constraints to preserve: Signed-in users still redirect to `/console`; hosted tenant switching, self-hosted tenant collapse, and the existing `tenantId` and `subjectId` form fields plus `/session` POST target remain unchanged.
- Intentional deviations and truthful substitutions: Mock email/token auth and protocol buttons were replaced with the actual tenant-membership sign-in flow, and setup states surface bootstrap progress without leaking internal error detail.

### `/console`

- Reference assets: `console_dashboard/code.html`, `console_dashboard/screen.png`
- Review evidence: `code.html` and `screen.png` were compared against the current dashboard route plus the approved desktop and mobile baselines on 2026-03-23 UTC.
- Shell composition and overall layout: The authenticated shell supplies the sticky top bar and persistent rail, while the page body follows the reference's bento-style dashboard rhythm with a hero card and supporting inventory cards.
- Headline scale and spacing: The "Console Dashboard" headline anchors the page with editorial spacing above role-sensitive metrics and action clusters, closely mirroring the reference's system-overview emphasis.
- CTA treatment and hierarchy: New draft registration remains the primary CTA for publishers, while environment management and review queue appear as secondary actions for tenant admins only.
- Card and background layering: The dashboard uses layered hero, metric, and inventory cards with softened shadows and tinted surfaces instead of borders or fake chart chrome.
- Navigation treatment: The common rail and mobile nav replace the reference's mock analytics/settings destinations with the actual console routes that exist today.
- Information density and grouping: Signed-in identity, tenant context, workspace actions, visible versions, and admin-only active agents are separated into scannable cards so dense workspace data reads like a curated dashboard rather than a list page.
- Functional constraints to preserve: Role-sensitive entry points remain intact, publishers do not see admin-only controls, and existing links to draft registration, review, environments, active agents, and version detail remain reachable.
- Intentional deviations and truthful substitutions: Synthetic activity rows, percentage gauges, and urgent analytics tiles from the reference were replaced with truthful counts, route links, and active-agent inventory the current app actually stores.

### `/tenants/:tenantId/environments`

- Reference assets: `environment_management/code.html`, `environment_management/screen.png`
- Review evidence: `code.html` and `screen.png` were compared against the current environment-management route plus the approved desktop and mobile baselines on 2026-03-23 UTC.
- Shell composition and overall layout: The page uses the shared authenticated shell, a large hero, a primary inventory panel, and a secondary creation panel that stack vertically on mobile without changing workflow order.
- Headline scale and spacing: The headline, tenant meta, and supporting copy mirror the reference's premium technical pacing rather than the old list-plus-form treatment.
- CTA treatment and hierarchy: Add Environment remains the only submit CTA and stays visually secondary to the configured inventory panel, matching the slice requirement that creation not dominate the page.
- Card and background layering: Inventory and creation sit on separate layered surfaces with generous spacing and no hard separators.
- Navigation treatment: The shared rail and mobile nav keep the environments page inside the common console shell instead of introducing one-off settings navigation from the mock reference.
- Information density and grouping: Configured environments remain the primary information block, while the add-environment form is contained in its own technical panel with supporting copy and unchanged field semantics.
- Functional constraints to preserve: Admin-only access still applies; GET and POST environment flows still use the existing route and `environmentKey` field; redirects remain unchanged.
- Intentional deviations and truthful substitutions: Mock uptime/load KPI cards, export controls, and per-row overflow menus were omitted because the current product truthfully supports only environment listing and creation.

### `/tenants/:tenantId/drafts/new`

- Reference assets: `new_draft_registration/code.html`, `new_draft_registration/screen.png`
- Review evidence: `code.html` and `screen.png` were compared against the current draft-registration route plus the approved desktop and mobile baselines on 2026-03-23 UTC.
- Shell composition and overall layout: The authenticated shell frames a long-form editorial layout with a hero, two upper technical sections, environment publication panels, and a persistent action footer that linearizes cleanly on mobile.
- Headline scale and spacing: The page leads with a strong headline and generous section spacing so the dense form reads as a designed technical workflow rather than a default multipart form.
- CTA treatment and hierarchy: The footer keeps a single gradient Create Draft action because this route only creates drafts; review submission remains deferred to version detail where the real action already exists.
- Card and background layering: Metadata, shared contracts, publication panels, and actions each live on distinct surfaces with softened inputs and no section dividers.
- Navigation treatment: The route stays inside the shared rail/mobile shell and does not inherit the reference's extra admin destinations or unsupported footer actions.
- Information density and grouping: General metadata, shared contracts, per-environment publication controls, and final actions follow the reference grouping while keeping the current field set readable at both desktop and mobile widths.
- Functional constraints to preserve: All existing field names, multipart uploads, POST target, publisher permissions, and per-environment publication semantics remain unchanged.
- Intentional deviations and truthful substitutions: Mock model selection, autosave language, and save/submit dual actions were replaced with the real draft fields and the current create-then-review workflow already enforced by the app.

### `/tenants/:tenantId/review`

- Reference assets: `review_queue/code.html`, `review_queue/screen.png`
- Review evidence: `code.html` and `screen.png` were compared against the current review-queue route plus the approved desktop and mobile baselines on 2026-03-23 UTC.
- Shell composition and overall layout: The page keeps the shared authenticated shell, then moves into a queue-first composition with a strong hero and dense review cards that resemble the reference's decision list.
- Headline scale and spacing: The large headline and introductory copy establish the page as a review workspace rather than a generic table, matching the reference's top-heavy hierarchy.
- CTA treatment and hierarchy: Approve stays the primary gradient action, reject remains visually distinct with its own reason input and softened secondary button treatment, and version-detail navigation stays immediately adjacent.
- Card and background layering: Pending items are grouped as elevated queue cards without line dividers or fake table chrome.
- Navigation treatment: The common rail and mobile nav keep the route consistent with the rest of the console while omitting the reference's unsupported history/search/filter shell.
- Information density and grouping: Each queue entry groups identity, publisher, submission time, detail link, and decisions into one readable unit so the page remains dense but still scannable.
- Functional constraints to preserve: Tenant-admin-only access is still enforced, approve and reject still submit to the current routes, and version detail remains the truthful path for deeper inspection.
- Intentional deviations and truthful substitutions: Search, filter, history, load-more, and diff tooling were omitted because the current server-rendered queue only exposes pending-review decisions and detail links.

### `/tenants/:tenantId/agents/:agentId`

- Reference assets: `active_agent_detail/code.html`, `active_agent_detail/screen.png`
- Review evidence: `code.html` and `screen.png` were compared against the current active-agent-detail route plus the approved desktop and mobile baselines on 2026-03-23 UTC.
- Shell composition and overall layout: The shared shell feeds into a dossier-style layout with a wide hero, primary publication surface, side action panels, and a separate audit-trail section that stacks vertically on smaller viewports.
- Headline scale and spacing: The active-agent headline and pulsed status signal reproduce the premium artifact feel from the reference without adding unsupported monitoring chrome.
- CTA treatment and hierarchy: Agent overlay actions and per-environment overlay actions stay visually obvious inside dedicated action panels, while version history links remain easy to locate as tertiary navigation.
- Card and background layering: Publication, overlay, control, and history areas use layered surfaces and soft gradients rather than lines or hard status boxes.
- Navigation treatment: The route remains inside the common rail/mobile shell and intentionally omits the reference's deploy/update CTA and mock analytics/deployments/settings destinations.
- Information density and grouping: Active publications, overlay state, environment controls, and version history are separated into focused panels so technical detail remains readable and truthful.
- Functional constraints to preserve: Admin-only access, agent-level overlay actions, environment-level overlay actions, and direct version-history navigation remain unchanged.
- Intentional deviations and truthful substitutions: The reference's deploy-update and add-custom-protocol controls were removed because the current route only supports overlay mutations and dossier navigation.

### `/tenants/:tenantId/agents/:agentId/versions/:versionId`

- Reference assets: `version_detail/code.html`, `version_detail/screen.png`
- Review evidence: `code.html` and `screen.png` were compared against the current version-detail route plus the approved desktop and mobile baselines on 2026-03-23 UTC.
- Shell composition and overall layout: The shared authenticated shell leads into a dossier layout with a wide main column for contracts, manifest, environment sections, telemetry, and health history plus a review sidebar that remains sticky on desktop and stacks on mobile.
- Headline scale and spacing: The page keeps the display headline, approval-state framing, and generous editorial spacing that define the dedicated reference while preserving the route's current density.
- CTA treatment and hierarchy: Submit, approve, and reject remain the only primary actions, grouped inside one explicit action cluster card that only appears when the current state and permissions allow those routes.
- Card and background layering: Layered surface panels, soft shadows, and the dark manifest block reproduce the reference's technical-panel treatment without relying on line dividers.
- Navigation treatment: The route uses the same common rail and mobile navigation as the rest of the authenticated console, replacing the reference's mock side destinations with actual console navigation.
- Information density and grouping: Release metadata, publication contracts, manifest data, environment dossiers, telemetry, health history, review notes, and timeline are split into distinct dossier panels so dense technical content stays scannable.
- Functional constraints to preserve: Publisher ownership restrictions, draft submission, admin approval and rejection, review-note visibility, and admin-only telemetry and health sections remain unchanged.
- Intentional deviations and truthful substitutions: Mock KPI cards, copy utilities, review badges, and fictional side metadata were replaced with truthful contracts, lifecycle metadata, review timeline entries, and read-only manifest output from the current product.

## Version Detail Deviation Table

The current version-detail route has a dedicated `version_detail` reference. The table below captures the approved truthful substitutions required to keep the dossier honest.

| Reference mock detail | Truthful implementation replacement | Reason for deviation |
| --- | --- | --- |
| Mock latency / throughput / memory KPI cards in the dossier hero | Publication contract cards built from stored required roles, required scopes, capabilities, tags, and current publication count | The current product does not store synthetic benchmark KPIs for versions, so the dossier surfaces truthful contract data instead of invented metrics. |
| Mock review checklist badges such as unit tests passed and security audit clear | Approval state, review notes, and timeline entries sourced from submitted, approved, and rejected lifecycle records | The route exposes real review lifecycle state, but it does not store the reference's discrete machine-generated checklist badges. |
| Mock audit-history narrative and side metadata such as license and production-ready environment labels | Review timeline entries and release metadata sourced from publisher ownership, active status, version identifiers, and review timestamps | The current route exposes real review and release metadata but not the reference's fictional editorial side facts. |
| Copy-JSON affordance and richer mock manifest utilities | Read-only rendered technical manifest and per-environment raw-card panels | The current server-rendered console does not implement clipboard or secondary manifest tooling on this route, so unsupported controls were omitted. |
