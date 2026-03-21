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
| `_TBD_` | `_TBD_` | `_TBD_` | `_TBD_` | Complete this row whenever a reference element cannot be implemented truthfully. |

## DESIGN.md Checklist

- No-Line Rule: do not use standard 1px dividers as primary page structure.
- Surface hierarchy: define regions through layered surfaces rather than visible borders.
- Glass treatment: use glassmorphism only for floating shells such as sticky navigation or elevated panels.
- CTA treatment: use gradient primary CTAs rather than flat primary fills.
- Typography: use Manrope for display and headline text.
- Typography: use Inter for body copy, labels, and dense technical text.
- Palette: stay within soft slate, deep blue, and toned-neutral surfaces.
- Layout rhythm: preserve generous whitespace and use asymmetry intentionally where it improves editorial flow.
- Card structure: prefer layered cards and surface shifts over hard separators.
- Shadows: avoid pure black text and hard black shadows; use tinted, low-contrast ambient shadows only when necessary.
- Shared shell: all authenticated routes must converge on one common top bar, navigation rail pattern, page padding rhythm, and control styling.
- Responsiveness and accessibility: preserve semantic headings, labels, buttons, keyboard operability, and intentional mobile hierarchy.

## Fidelity Review Ledger

Each route below must be reviewed against both the reference `code.html` and `screen.png` before the page is considered complete.

### `/`

- Reference assets: `sign_in_landing_page/code.html`, `sign_in_landing_page/screen.png`
- Shell composition and overall layout:
- Headline scale and spacing:
- CTA treatment and access-card hierarchy:
- Card and background layering:
- Navigation treatment:
- Information density and grouping:
- Functional constraints to preserve:
- Intentional deviations and truthful substitutions:

### `/console`

- Reference assets: `console_dashboard/code.html`, `console_dashboard/screen.png`
- Shell composition and overall layout:
- Headline scale and spacing:
- CTA treatment and dashboard hierarchy:
- Card and background layering:
- Navigation treatment:
- Information density and grouping:
- Functional constraints to preserve:
- Intentional deviations and truthful substitutions:

### `/tenants/:tenantId/environments`

- Reference assets: `environment_management/code.html`, `environment_management/screen.png`
- Shell composition and overall layout:
- Headline scale and spacing:
- CTA treatment and creation-panel hierarchy:
- Card and background layering:
- Navigation treatment:
- Information density and grouping:
- Functional constraints to preserve:
- Intentional deviations and truthful substitutions:

### `/tenants/:tenantId/drafts/new`

- Reference assets: `new_draft_registration/code.html`, `new_draft_registration/screen.png`
- Shell composition and overall layout:
- Headline scale and spacing:
- CTA treatment and action-footer placement:
- Card and background layering:
- Navigation treatment:
- Information density and grouping:
- Functional constraints to preserve:
- Intentional deviations and truthful substitutions:

### `/tenants/:tenantId/review`

- Reference assets: `review_queue/code.html`, `review_queue/screen.png`
- Shell composition and overall layout:
- Headline scale and spacing:
- CTA treatment and decision-action hierarchy:
- Card and background layering:
- Navigation treatment:
- Information density and grouping:
- Functional constraints to preserve:
- Intentional deviations and truthful substitutions:

### `/tenants/:tenantId/agents/:agentId`

- Reference assets: `active_agent_detail/code.html`, `active_agent_detail/screen.png`
- Shell composition and overall layout:
- Headline scale and spacing:
- CTA treatment and admin-action hierarchy:
- Card and background layering:
- Navigation treatment:
- Information density and grouping:
- Functional constraints to preserve:
- Intentional deviations and truthful substitutions:

### `/tenants/:tenantId/agents/:agentId/versions/:versionId`

- Reference assets: `version_detail/code.html`, `version_detail/screen.png`
- Shell composition and overall layout:
- Headline scale and spacing:
- CTA treatment and action-cluster hierarchy:
- Card and background layering:
- Navigation treatment:
- Information density and grouping:
- Functional constraints to preserve:
- Intentional deviations and truthful substitutions:

## Version Detail Deviation Table

The current version detail route has a dedicated `version_detail` reference. This table must be completed during implementation whenever the reference includes mock dossier content that needs a truthful replacement.

| Reference mock detail | Truthful implementation replacement | Reason for deviation |
| --- | --- | --- |
| `_TBD_` | `_TBD_` | Complete this row when the dedicated `version_detail` reference includes content or controls that the current product does not expose. |
