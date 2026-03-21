# Design System Strategy: The Technical Curator

## 1. Overview & Creative North Star
The "Technical Curator" is the guiding philosophy of this design system. It moves beyond the sterile, "out-of-the-box" SaaS template to create a digital environment that feels like a high-end architectural portfolio. For a technical agent registry, we must convey absolute precision while maintaining a sophisticated, editorial breathing room.

**The Creative North Star:** *Architectural Precision meets Editorial Sophistication.* 
We break the "template" look through intentional asymmetry—using the generous spacing scale to create offset layouts—and by treating the UI as a series of layered, physical materials rather than flat digital boxes. The goal is a registry that feels like a curated gallery of high-performance intelligence.

---

## 2. Color & Materiality
This system relies on a monochromatic base with "Slate" and "Deep Blue" accents to ground the technical nature of the content.

### The "No-Line" Rule
**Standard 1px solid borders are strictly prohibited for sectioning.** 
Structural boundaries must be defined solely through background shifts. For example, a `surface-container-low` (#f0f4f7) sidebar sitting against a `surface` (#f7f9fb) main content area creates a cleaner, more premium distinction than a line ever could.

### Surface Hierarchy & Nesting
Treat the UI as a physical stack of fine paper and frosted glass. Use the hierarchy to define importance:
- **Base Layer:** `surface` (#f7f9fb)
- **Secondary Sections:** `surface-container-low` (#f0f4f7)
- **Primary Interaction Cards:** `surface-container-lowest` (#ffffff)
- **Search/Active Modals:** `surface-container-high` (#e1e9ee)

### The "Glass & Gradient" Rule
To escape the "flat" look, floating elements (like navigation bars or hovering agent cards) should utilize **Glassmorphism**. Apply `surface-container-lowest` at 80% opacity with a `backdrop-blur` of 12px. Main CTAs should avoid flat fills; instead, use a subtle linear gradient from `primary` (#565e74) to `primary-dim` (#4a5268) at a 135-degree angle to provide a "machined" metallic depth.

---

## 3. Typography: The Editorial Voice
We utilize two distinct sans-serifs to create a high-contrast hierarchy that feels both technical and premium.

*   **Display & Headlines (Manrope):** Use Manrope for all `display` and `headline` levels. Its geometric yet slightly warm proportions suggest modern engineering. Use `display-lg` (3.5rem) with tighter letter-spacing (-0.02em) for hero sections to create an authoritative, "Technical Curator" feel.
*   **Body & Labels (Inter):** Use Inter for all functional text. Inter’s high x-height ensures legibility in dense technical data.
*   **Hierarchy as Identity:** Always lead with a strong `headline-lg` in `on-surface` (#2a3439), followed by a generous `3` (1rem) spacing gap before `body-md` text. This "over-spacing" of headers is a signature move of high-end editorial design.

---

## 4. Elevation & Depth
In this system, depth is a function of light and layer, not artificial dropshadows.

*   **The Layering Principle:** Depth is achieved by stacking. A `surface-container-lowest` card placed on a `surface-container-low` background provides a natural, soft lift.
*   **Ambient Shadows:** For elements that truly float (Modals, Popovers), use a "Sunken Shadow": `0px 20px 40px rgba(42, 52, 57, 0.06)`. Note the color—it is a tinted version of `on-surface`, not pure black, ensuring the shadow feels like natural ambient light.
*   **The "Ghost Border" Fallback:** If a border is required for accessibility (e.g., input fields), use `outline-variant` (#a9b4b9) at **15% opacity**. A 100% opaque border is considered a "design failure" in this system.

---

## 5. Components & Precision

### Buttons
*   **Primary:** Gradient fill (`primary` to `primary-dim`), `rounded-md` (0.375rem), white text.
*   **Secondary:** No fill. `surface-container-high` background on hover. Use `label-md` for button text to maintain a crisp, technical look.
*   **Tertiary:** Text only, using `primary` color. No box.

### Input Fields & Search
*   **Style:** `surface-container-lowest` fill with a "Ghost Border." 
*   **Focus State:** Shift background to `surface-container-high` and transition the ghost border to 40% opacity. 
*   **Layout:** Labels should be `label-sm` in `on-surface-variant` (#566166), positioned 0.5rem above the input.

### Agent Cards & Registry Lists
*   **Card Structure:** Absolutely no dividers. Separate the agent "Header" from the "Stats" using a `3` (1rem) vertical space.
*   **Asymmetric Data:** Arrange technical specs (uptime, latency, model type) in a 3-column grid within the card, but offset the entire grid slightly to the right to create visual interest.
*   **Chips:** Use `surface-container-highest` (#d9e4ea) for the background with `on-surface-variant` text. Corner radius should be `full` (9999px) for a "pill" look that contrasts against the sharper `md` radius of containers.

### Technical Status Indicators
*   Instead of bright "Traffic Light" colors, use a subtle 4px pulse of `tertiary` (#5d5d78) next to the agent name to indicate "Live" status. This maintains the sleek palette while providing necessary feedback.

---

## 6. Do’s and Don’ts

### Do:
*   **Do** use asymmetrical margins. If a container has 2rem padding on the left, try 3.5rem on the right to create an editorial flow.
*   **Do** use `surface-container-lowest` for the most important interactive elements.
*   **Do** use `headline-sm` for section titles, but give them a massive `10` (3.5rem) top margin to let the design breathe.

### Don't:
*   **Don't** use dividers (`<hr>`). Use a `1.5` (0.5rem) background color shift or whitespace instead.
*   **Don't** use pure black (#000000) for text. Use `on-surface` (#2a3439) to maintain tonal softness.
*   **Don't** use high-intensity shadows. If the shadow is clearly visible at a glance, it is too dark.
*   **Don't** crowd the edges. The registry should feel like it has infinite room to expand.