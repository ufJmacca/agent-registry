# Fidelity Comparison Record

This record links each in-scope route to its approved design-reference evidence and the committed Playwright baselines used for final sign-off.

## `/`

- Reference screen.png: [sign_in_landing_page/screen.png](./sign_in_landing_page/screen.png)
- Reference code.html: [sign_in_landing_page/code.html](./sign_in_landing_page/code.html)
- Approved desktop baseline: [sign-in-landing-desktop.png](../tests/visual/__screenshots__/sign-in-landing-desktop.png)
- Approved mobile baseline: [sign-in-landing-mobile.png](../tests/visual/__screenshots__/sign-in-landing-mobile.png)
- Side-by-side comparison summary: The public shell, centered hero, access card, setup companion, and footer rhythm match the reference composition across the approved desktop and mobile baselines while preserving the truthful membership sign-in flow.

#### Residual Delta Ledger

| Residual delta | Status | Disposition |
| --- | --- | --- |
| Frosted public shell, hero hierarchy, and access-versus-companion card split | resolved | The approved desktop and mobile baselines show the shared public shell and editorial layout locked to the implemented route. |
| Mock SSO, biometrics, and marketing navigation shown in the reference | approved truthful deviation | Those controls remain omitted because the current console only supports tenant and subject selection plus the real `/session` sign-in POST. |

## `/console`

- Reference screen.png: [console_dashboard/screen.png](./console_dashboard/screen.png)
- Reference code.html: [console_dashboard/code.html](./console_dashboard/code.html)
- Approved desktop baseline: [console-dashboard-desktop.png](../tests/visual/__screenshots__/console-dashboard-desktop.png)
- Approved mobile baseline: [console-dashboard-mobile.png](../tests/visual/__screenshots__/console-dashboard-mobile.png)
- Side-by-side comparison summary: The approved baselines capture the reference-aligned bento hierarchy, dominant feature card, supporting utility panels, and lower record band while keeping only real workspace actions, version links, and active-agent inventory.

#### Residual Delta Ledger

| Residual delta | Status | Disposition |
| --- | --- | --- |
| Authenticated shell, feature-first dashboard hierarchy, and route-aware action grouping | resolved | The approved desktop and mobile baselines now track the same shell, card density, and CTA emphasis asserted in the implemented dashboard route. |
| Mock analytics feed, utilization gauges, and portrait media from the reference | approved truthful deviation | Those dashboard-only artifacts stay absent because the product does not expose a truthful activity feed, KPI rollups, or user media on `/console`. |

## `/tenants/:tenantId/environments`

- Reference screen.png: [environment_management/screen.png](./environment_management/screen.png)
- Reference code.html: [environment_management/code.html](./environment_management/code.html)
- Approved desktop baseline: [environment-management-desktop.png](../tests/visual/__screenshots__/environment-management-desktop.png)
- Approved mobile baseline: [environment-management-mobile.png](../tests/visual/__screenshots__/environment-management-mobile.png)
- Side-by-side comparison summary: The inventory-dominant layout, editorial page intro, and secondary creation rail now match the environment-management reference in the approved baselines while preserving the real environment list and unchanged add-environment POST flow.

#### Residual Delta Ledger

| Residual delta | Status | Disposition |
| --- | --- | --- |
| Inventory-primary panel proportions, creation-secondary rail, and shared authenticated shell treatment | resolved | The committed baselines show the extracted environment page renderer holding the intended layout at both sign-off viewports. |
| Mock KPI strips, export utilities, and operations menus from the reference | approved truthful deviation | Those controls remain omitted because the implemented route truthfully supports listing and creating environments only. |

## `/tenants/:tenantId/drafts/new`

- Reference screen.png: [new_draft_registration/screen.png](./new_draft_registration/screen.png)
- Reference code.html: [new_draft_registration/code.html](./new_draft_registration/code.html)
- Approved desktop baseline: [new-draft-registration-desktop.png](../tests/visual/__screenshots__/new-draft-registration-desktop.png)
- Approved mobile baseline: [new-draft-registration-mobile.png](../tests/visual/__screenshots__/new-draft-registration-mobile.png)
- Side-by-side comparison summary: The approved desktop and mobile baselines show the curated form workflow, grouped metadata and contract panels, publication subpanels, and deliberate action footer from the reference while keeping the real multipart field set unchanged.

#### Residual Delta Ledger

| Residual delta | Status | Disposition |
| --- | --- | --- |
| Long-form editorial layout, grouped technical sections, and action-footer hierarchy | resolved | The final baselines capture the same structured form rhythm that the implemented route now composes from shared primitives. |
| Mock model pickers, autosave hints, and alternate footer actions | approved truthful deviation | Those workflow affordances remain omitted because the current route only creates a draft and defers later submission to version detail. |

## `/tenants/:tenantId/review`

- Reference screen.png: [review_queue/screen.png](./review_queue/screen.png)
- Reference code.html: [review_queue/code.html](./review_queue/code.html)
- Approved desktop baseline: [review-queue-desktop.png](../tests/visual/__screenshots__/review-queue-desktop.png)
- Approved mobile baseline: [review-queue-mobile.png](../tests/visual/__screenshots__/review-queue-mobile.png)
- Side-by-side comparison summary: The queue baselines now reflect the review-reference density, decision-first action grouping, and curated horizontal review objects while keeping only the truthful pending-version facts and approve or reject workflows.

#### Residual Delta Ledger

| Residual delta | Status | Disposition |
| --- | --- | --- |
| Dense review-object composition, immediate decision actions, and shell consistency with the rest of the console | resolved | The approved baselines show the route holding the intended queue rhythm at desktop and mobile widths. |
| Mock search, filters, history tabs, and diff tooling | approved truthful deviation | Those controls remain absent because the current server-rendered review queue only supports pending decisions and links to version detail. |

## `/tenants/:tenantId/agents/:agentId`

- Reference screen.png: [active_agent_detail/screen.png](./active_agent_detail/screen.png)
- Reference code.html: [active_agent_detail/code.html](./active_agent_detail/code.html)
- Approved desktop baseline: [active-agent-detail-desktop.png](../tests/visual/__screenshots__/active-agent-detail-desktop.png)
- Approved mobile baseline: [active-agent-detail-mobile.png](../tests/visual/__screenshots__/active-agent-detail-mobile.png)
- Side-by-side comparison summary: The approved baselines capture the dossier hero, staggered publication cards, side-panel rhythm, and version-history treatment from the active-agent reference while preserving truthful overlay state and admin controls.

#### Residual Delta Ledger

| Residual delta | Status | Disposition |
| --- | --- | --- |
| Dossier hero proportions, publication-card layering, and side-panel composition | resolved | The extracted agent-detail renderer now matches the signed-off desktop and mobile baselines for the supported publication and overlay workflows. |
| Mock deploy, analytics, and synthetic KPI controls | approved truthful deviation | Those operational controls stay omitted because the route only exposes real overlay mutations, publication facts, and version navigation. |

## `/tenants/:tenantId/agents/:agentId/versions/:versionId`

- Reference screen.png: [version_detail/screen.png](./version_detail/screen.png)
- Reference code.html: [version_detail/code.html](./version_detail/code.html)
- Approved desktop baseline: [version-detail-desktop.png](../tests/visual/__screenshots__/version-detail-desktop.png)
- Approved mobile baseline: [version-detail-mobile.png](../tests/visual/__screenshots__/version-detail-mobile.png)
- Side-by-side comparison summary: The approved baselines and supporting mobile proof captures show the dossier left-column stack, review-state sidebar, manifest treatment, publication details, telemetry, and health sections aligned to the version-detail reference while preserving the real lifecycle and manifest data.

#### Residual Delta Ledger

| Residual delta | Status | Disposition |
| --- | --- | --- |
| Dossier shell, review-state sidebar, manifest treatment, and long-payload containment on mobile | resolved | The approved desktop and mobile baselines plus the version-detail mobile proof captures confirm the implemented dossier layout and overflow handling. |
| Mock KPI cards, review badges, copy-JSON tooling, and fictional side metadata | approved truthful deviation | Those reference-only elements remain omitted because the product does not store the synthetic metrics or utilities they imply. |
