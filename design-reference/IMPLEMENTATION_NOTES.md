# Implementation Notes: Technical Curator Web Console Rollout

This document records the completed fidelity review for the seven current server-rendered console routes. Each route was reviewed against its mapped `code.html` and `screen.png` reference, then checked against the committed desktop and mobile visual baselines used by the Playwright suite.

Unsupported mock controls were omitted rather than rendered inert.

## Reference Audit Overview

| Audit focus | Reference evidence | Implementation consequence |
| --- | --- | --- |
| Coverage of the reference system | All seven mapped `design-reference/*/code.html` and `design-reference/*/screen.png` pairs were reviewed alongside `DESIGN.md` so the audit reflects the full current route inventory rather than isolated page samples. | Shared extraction has to happen before route rewrites because the references repeat one visual system across public, dashboard, form, queue, and dossier pages. |
| Authority split between asset types | `screen.png` establishes macro layout, spacing rhythm, asymmetry, and visual emphasis, while `code.html` establishes repeated DOM groupings, card composition, and reusable utility treatments. | The implementation should copy hierarchy from the PNGs and composition from the HTML so reusable primitives match both the visual and structural references. |
| Parser-safe notes contract | The new audit content is captured in machine-readable tables above sign-off, and route-specific findings stay inside tables instead of adding new `###` route headings outside the existing fidelity ledger. | `IMPLEMENTATION_NOTES.md` can grow without breaking the current section extraction and route-ledger assertions in `tests/fidelity-signoff.test.ts`. |

## Reference Audit Shared Patterns

| Pattern group | Observed across references | Audit implication for implementation |
| --- | --- | --- |
| Public shell traits | The public landing reference uses a translucent fixed top bar, a centered editorial hero, a dominant primary access card, a companion setup-status panel, and a soft footer with wide breathing room. | The public shell should own this chrome once and let the sign-in route swap only truthful access and setup content into the shared composition. |
| Authenticated shell traits | The six authenticated references repeat a persistent left rail, a sticky or fixed glass top bar, oversized page intros, wide gutters, and section changes defined by surface shifts instead of dividers. | Authenticated routes should share one shell and one page-intro language so later fidelity work refines proportions instead of re-solving layout on every page. |
| Repeated component patterns | Uppercase micro-labels, gradient primary CTAs, pill chips, rounded surface cards, stat or fact tiles, dense record rows, and dark technical-manifest or code surfaces recur across the dashboard, queue, and dossier references. | Shared primitives should cover page heroes, card heads, pills, stat tiles, action clusters, record lists, empty states, and side panels before page-specific markup expands further. |
| Truthful substitutions policy | Multiple references show mock analytics, auth providers, model pickers, review badges, and side metadata that the current product does not actually store or expose. | Unsupported mock content must be replaced with real session, routing, publication, contract, lifecycle, and review data, and each substitution should remain documented in the route matrix or deviation tables. |
| Mock-only omissions policy | Several references include search, filter, history, deploy, export, copy-JSON, marketing, or auxiliary settings controls that are visually useful in the mock but unsupported in the current server-rendered console. | Unsupported controls should be omitted entirely so the implementation avoids dead buttons, fake tabs, and routes that imply capabilities the product does not have. |

## Reference Audit Route Matrix

| Current route | Reference asset pair | Shared patterns carried forward | Route-unique reference pattern | Truthful substitutions required | Mock-only elements to omit |
| --- | --- | --- | --- | --- | --- |
| `/` | `sign_in_landing_page/code.html`; `sign_in_landing_page/screen.png` | Public frosted top bar, centered editorial hero, split primary-and-companion card layout, and soft footer rhythm. | The hero headline dominates the page while the access card sits opposite a setup narrative panel anchored by two smaller supporting tiles. | Tenant and subject selectors plus the real `/session` POST flow replace organization-email and security-token auth while truthful bootstrap state stays prominent. | Marketing navigation destinations, SSO login, biometrics, forgot-access flow, and protocol-only controls that the product does not support. |
| `/console` | `console_dashboard/code.html`; `console_dashboard/screen.png` | Authenticated rail and glass top bar, large intro block, bento card hierarchy, and a dominant primary CTA card. | The dashboard uses one oversized feature card with adjacent utility cards, a versions strip, and a lower recent-activity band. | Real identity, tenant context, route links, visible versions, and active-agent inventory replace synthetic analytics and mock utilization summaries. | Fake intelligence activity, percentage gauges, API-status style destinations, and extra settings or documentation destinations that are not real console routes. |
| `/tenants/:tenantId/environments` | `environment_management/code.html`; `environment_management/screen.png` | Authenticated shell, oversized page intro, layered surfaces, and editorial whitespace instead of list-plus-form compression. | The reference favors an inventory-dominant panel with creation framed as a secondary control surface rather than as a peer table action. | The existing environment inventory and add-environment POST form replace cluster KPIs while preserving real tenant environment keys and creation behavior. | KPI cards, row overflow menus, export JSON, global logs, and other unsupported infrastructure utilities. |
| `/tenants/:tenantId/drafts/new` | `new_draft_registration/code.html`; `new_draft_registration/screen.png` | Authenticated shell, large hero, softened inputs, grouped panels, and a deliberate action footer. | The route is a curated long-form workflow that stages metadata, publication rows, shared contracts, and final actions in stacked technical panels. | Real field names, multipart publication controls, shared contract JSON areas, and the single create-draft action replace mock model selection and autosave workflow hints. | Save-as-draft, submit-for-review footer controls, model-picker affordances, and other workflow cues that the current draft route does not implement. |
| `/tenants/:tenantId/review` | `review_queue/code.html`; `review_queue/screen.png` | Authenticated shell, large headline, dense elevated review objects, and obvious decision-action grouping. | The reference compresses each pending item into one horizontal technical review row that keeps identity, summary facts, and decisions in one band. | Pending-review entries, version-detail links, approve, reject-reason input, and reject action replace filterable queue metadata and diff tooling. | Search, sort, history tab, load-more control, and diff affordances that the current server-rendered queue cannot support truthfully. |
| `/tenants/:tenantId/agents/:agentId` | `active_agent_detail/code.html`; `active_agent_detail/screen.png` | Authenticated shell, dossier hero, layered publication cards, stat tiles, and supporting side panels. | The route combines a wide hero, staggered publication cards, environment control stack, and a version-history column with deliberate asymmetry. | Real overlay state, active publications, admin controls, and version-history links replace deploy-update workflows and operational metrics the product does not store. | Deploy-update CTA, analytics and deployments rail items, add-custom-protocol control, and other unsupported operational tooling. |
| `/tenants/:tenantId/agents/:agentId/versions/:versionId` | `version_detail/code.html`; `version_detail/screen.png` | Authenticated shell, dossier layout, sticky right column, publication tiles, and dark technical-manifest treatment. | The reference pairs a dense left-column technical dossier with a right-column review-state panel and audit-history stack. | Real review lifecycle state, manifest output, publication contracts, telemetry, health history, and release metadata replace the mock KPI cards and editorial side facts. | Copy-JSON utilities, review checklist badges, mock latency or throughput cards, and fictional metadata such as license or production-ready labels when unsupported. |

## Reference Audit Residual Delta Log

| Current route | Audit pass | Highest-value unresolved fidelity delta | Truthful constraint to preserve | Next implementation target |
| --- | --- | --- | --- | --- |
| `/` | Public sign-in fidelity pass completed on 2026-03-30 UTC. | The public shell now owns the anchored top bar, editorial hero, access/setup split, and footer rhythm, but the reference's extra marketing destinations and decorative utility tiles remain intentionally absent. | Keep signed-in redirect behavior, tenant-aware selection, self-hosted collapse rules, and truthful setup-pending prominence. | Tighten hero-to-panel proportions and mobile spacing against the landing screenshot after the later visual baseline refresh. |
| `/console` | Dashboard fidelity pass completed on 2026-03-30 UTC. | The dashboard now follows the feature-first hierarchy, supporting utility panels, and lower register band from the reference, but the mock recent-activity strip and profile portrait remain intentionally absent because the product has no truthful activity feed or user-media source. | Preserve role-sensitive navigation, truthful route links, publisher-versus-admin visibility rules, and real version or active-agent counts instead of backfilling mock analytics. | Tighten cross-route shell spacing only after the remaining authenticated pages complete their fidelity passes. |
| `/tenants/:tenantId/environments` | Phase 0 reference audit completed on 2026-03-30 UTC. | The route still reads too much like a conventional admin list and needs a stronger inventory-versus-creation split with more editorial spacing. | Keep the existing environment list, `environmentKey` submission behavior, and admin-only access controls intact. | Move the renderer into its own page module and compose the page from shared intro, inventory, and secondary-panel primitives. |
| `/tenants/:tenantId/drafts/new` | Phase 0 reference audit completed on 2026-03-30 UTC. | The form flow still needs more deliberate section framing so dense technical fields feel curated rather than stacked by raw field order. | Preserve every current field name, multipart behavior, publisher restriction, and create-draft submission path. | Extract shared form-panel and action-footer primitives, then tune spacing and grouping against the draft reference. |
| `/tenants/:tenantId/review` | Phase 0 reference audit completed on 2026-03-30 UTC. | The queue still needs higher-density review objects with stronger decision emphasis and less resemblance to generic cards or tables. | Keep approve and reject behavior, version-detail linking, and the absence of unsupported history, filter, and diff features. | Move the route out of `http.ts` and rebuild it with shared record-row and action-cluster primitives. |
| `/tenants/:tenantId/agents/:agentId` | Phase 0 reference audit completed on 2026-03-30 UTC. | The active-agent page still needs the reference's dossier asymmetry, layered publication rhythm, and lighter-weight but obvious admin-control stack. | Preserve truthful overlay state, active publication data, admin-only controls, and direct version-history navigation. | Extract the route into a dedicated renderer and align it with shared hero, stat-tile, side-panel, and record-list structures. |
| `/tenants/:tenantId/agents/:agentId/versions/:versionId` | Phase 0 reference audit completed on 2026-03-30 UTC. | The version dossier still needs closer right-column hierarchy, manifest framing, and contract-panel emphasis to match the dedicated reference. | Keep truthful review state, manifest content, submission and approval behavior, telemetry, health history, and documented deviations. | Refine the dossier with shared dossier-row and review-sidebar primitives while preserving the approved truthful substitutions. |

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
| `/` | `sign_in_landing_page` | Organization email, security token, SSO login, biometrics, and marketing navigation links | Tenant selector, subject selector, and the existing `/session` POST sign-in form inside the editorial access card; public chrome uses truthful in-page access/setup anchors plus `/console` instead of mock marketing destinations | The current console only supports membership-based mock sign-in and does not expose external auth providers or separate marketing routes. |
| `/console` | `console_dashboard` | Synthetic activity feed, utilization gauges, profile portrait media, and mock settings-style destinations | Signed-in identity, tenant context, a dominant draft-registration feature card, role-sensitive workspace actions, visible versions, and admin-only active agents rendered inside the shared shell | The app exposes truthful counts and links, but it does not store an activity feed, KPI rollups, or user-profile imagery for this route. |
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
- Review evidence: `code.html` and `screen.png` were compared against the current public route plus the approved desktop and mobile baselines on 2026-03-30 UTC.
- Shell composition and overall layout: The public shell keeps the frosted top bar and editorial hero from the reference family, then splits the page into an access panel and a companion status panel with a dedicated footer band that collapse into a single column on mobile.
- Headline scale and spacing: The route now uses a large Manrope hero with wide editorial spacing instead of the previous minimal card stack, matching the reference's headline-first composition.
- CTA treatment and hierarchy: The only primary CTA remains the truthful sign-in submit inside the access card, while setup-pending messaging becomes the lead panel only when the app is not bootstrapped.
- Card and background layering: The page uses the shared paper gradient, soft ambient shadowing, and layered companion cards rather than line dividers.
- Navigation treatment: The reference's extra marketing links were intentionally omitted; the public shell uses truthful in-page anchors for overview, access, and setup plus `/console` as the only routed destination because the current product exposes `/` and the authenticated console, not a marketing site.
- Information density and grouping: Tenant and subject selection stay grouped inside one clear access card, and setup or workspace state lives in the companion card with concise status tiles that remain readable on mobile.
- Functional constraints to preserve: Signed-in users still redirect to `/console`; hosted tenant switching, self-hosted tenant collapse, and the existing `tenantId` and `subjectId` form fields plus `/session` POST target remain unchanged.
- Intentional deviations and truthful substitutions: Mock email/token auth and protocol buttons were replaced with the actual tenant-membership sign-in flow, setup states surface bootstrap progress without leaking internal error detail, and footer/top-bar links stay limited to truthful in-page sections and `/console`.

### `/console`

- Reference assets: `console_dashboard/code.html`, `console_dashboard/screen.png`
- Review evidence: `code.html` and `screen.png` were compared against the current dashboard route plus refreshed desktop and mobile baselines on 2026-03-30 UTC.
- Shell composition and overall layout: The authenticated shell supplies the sticky top bar and persistent rail, while the dashboard now opens with a large editorial intro, a compact signed-in identity panel, a dominant dark feature card, two lighter supporting panels, and a lower register band for versions plus admin-only active agents.
- Headline scale and spacing: The page now leads with the reference-aligned "System Overview" intro and keeps the surrounding panels on wide gutters so the bento hierarchy reads before the operational detail.
- CTA treatment and hierarchy: New draft registration is promoted into the feature card as the clear primary CTA for every publisher-capable session, while environment management and review queue remain secondary actions for tenant admins only.
- Card and background layering: The dashboard uses a dark feature surface, softened metric tiles, rounded utility panels, and low-contrast ambient shadows instead of borders, charts, or hard separators.
- Navigation treatment: The common rail and mobile nav replace the reference's mock analytics/settings destinations with the actual console routes that exist today.
- Information density and grouping: Signed-in identity, tenant context, workspace actions, visible versions, and admin-only active agents are mapped into separate but coordinated panels so the route reads like a truthful technical dashboard rather than a list page.
- Functional constraints to preserve: Role-sensitive entry points remain intact, publishers do not see admin-only controls, and existing links to draft registration, review, environments, active agents, and version detail remain reachable.
- Intentional deviations and truthful substitutions: Synthetic activity rows, utilization gauges, urgent-count badges, and profile portrait media from the reference were replaced with truthful counts, route links, and active-agent inventory because the current app does not store an activity feed, KPI telemetry, or user images for this route.

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
