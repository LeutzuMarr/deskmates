# Deskmates style reference

The user supplied this reference (a description of Anthropic's warm, editorial design language) on 2026-09-19 and asked for the app to follow it. Part 1 records the reference's rules and values. Part 2 says how Deskmates applies them.

Brand boundary: Deskmates follows these design principles, colors and component shapes. It does **not** use Anthropic's names, logos, mascots or licensed fonts. The reference's own fonts are replaced by the open substitutes the reference itself names.

## Part 1. The reference

**Mood:** a scientific field journal on warm parchment. Surfaces are quiet ivory, headlines are editorial serif, and a single clay accent appears only when you must act. Components are flat: hairline borders and selective corner radii replace shadows. Sans type handles UI chrome; the serif carries the voice.

### Colors

| Name | Hex | Role |
|---|---|---|
| Slate Dark | `#141413` | Primary text, headings, hairline borders, the dark inversion surface. Near-black with warmth, never pure black |
| Ivory Medium | `#f0eee6` | Page canvas and large surfaces (the parchment) |
| Ivory Light | `#faf9f5` | Cards and elevated panels, one step brighter than the canvas |
| Cloud Medium | `#b0aea5` | Muted helper text, inactive navigation, secondary labels |
| Cloud Dark | `#87867f` | Outlined button borders, mid-contrast dividers |
| Stone | `#cccbc8` | Hairline borders and section dividers |
| Slate Medium | `#3d3d3a` | Borders on dark surfaces |
| Oat Warm | `#e3dacc` | Secondary warm surface for grouped panels |
| Manilla | `#f5e3c7` | Featured editorial cards |
| Clay | `#d97757` | The single chromatic accent: filled call-to-action buttons only |
| Clay Deep | `#c6613f` | Hover and pressed state for Clay |

### Type

| Role | Reference face | Open substitute we use | Use |
|---|---|---|---|
| Serif | the reference's custom serif | **Source Serif 4** (`@fontsource-variable/source-serif-4`, family `Source Serif 4 Variable`) | Editorial voice: display headings and body reading text. Weight 400 by default, 600 for emphasis. Sizes 14, 18, 20, 24, 68px. Line heights 1.10, 1.40, 1.43 |
| Sans | the reference's custom sans | **Inter** (`@fontsource-variable/inter`, family `Inter Variable`) | UI chrome: navigation, buttons, labels, badges. Weights 400–700. Sizes 12, 15, 16, 20, 24px. Tracking −0.02em at 12px, −0.005em at 15–16px |
| Mono | the reference's custom mono | **JetBrains Mono** (`@fontsource-variable/jetbrains-mono`) | Code and technical snippets, used sparingly |

Type scale: caption 12px/1.4 (−0.24px) · small body 16px · body 20px/1.4 · subheading 24px/1.3 · heading 61px/1.1 · display 68px/1.1.

### Space and shape

- 4px base unit. Scale: 4, 8, 12, 16, 24, 32, 76, 100. Compact density; 8px element gap; card padding 24–32px.
- Radii:
  - navigation, links and badges: 0;
  - cards: 24px;
  - filled buttons: 8px on the **bottom corners only**, top corners sharp (the signature);
  - outlined buttons: 12px.
- Elevation comes from surface tone (canvas → card → manilla) and 1px borders. There are no shadows.

### Components

- **Filled ivory button:** `#faf9f5` background, `#141413` text, bottom-only 8px radius, padding 12px 31px, no border, no shadow.
- **Clay filled button:** `#d97757` background, white text, the same shape. Reserved for the single most consequential action on a screen. Hover `#c6613f`.
- **Outlined button:** transparent, 1px `#87867f` border, 12px radius, padding 8px 16px.
- **Text link button:** transparent, `#141413`, no border, underline on hover.
- **Inline links:** inherit the text color with a persistent 1px underline, as in print.
- **Cards:** `#faf9f5`, 24px radius, optional 1px `#cccbc8` border, about 24px padding.
- **Featured card:** `#f5e3c7`, 24px radius, no border, generous padding.
- **Badges:** just weighted text in flow, not containers.

### Do

- Serif for reading text, sans for UI chrome.
- `#f0eee6` canvas and `#faf9f5` cards; `#f5e3c7` only for a featured card.
- Bottom-only 8px radius on filled buttons.
- Clay only for the one most consequential action on a screen.
- Persistent underlines on inline links.
- 24px radius on card-level surfaces.

### Don't

- No cool grays, blues, or anything outside the warm earth-tone family.
- No box shadows; elevation is surface tone and 1px borders only.
- No clay for decoration, icons or hover states.
- No sans for reading body text.
- No uniform pill radius on buttons.
- No pure white `#ffffff` surfaces.
- No gradients, glows or color washes; surfaces are flat solid fills.

## Part 2. How Deskmates applies it

This is a desktop app, not a marketing page, so sizes step down while the rules stay.

### Tokens

CSS variables live on `:root`. Light is the default. A dark variant built from the reference's own inversion colors follows the Windows setting. All of them are exposed to Tailwind through `@theme inline`.

| Token | Light | Dark | Use |
|---|---|---|---|
| `--canvas` | `#f0eee6` | `#1f1e1d` | Main area background |
| `--sidebar` | `#e3dacc` | `#141413` | Sidebar background |
| `--card` | `#faf9f5` | `#262624` | Composer, cards, dialogs, menus |
| `--oat` | `#e3dacc` | `#30302e` | User message bubble, selected rows, hover fills |
| `--manilla` | `#f5e3c7` | `#3a3226` | The Home greeting card and plan highlights |
| `--rule` | `#cccbc8` | `#3d3d3a` | Hairline borders and dividers |
| `--ink` | `#141413` | `#faf9f5` | Primary text |
| `--ink-muted` | `#87867f` | `#b0aea5` | Secondary text and the gray activity summaries (readable) |
| `--ink-faint` | `#b0aea5` | `#87867f` | Times, placeholders and inactive labels |
| `--clay` | `#d97757` | `#d97757` | Filled primary action only |
| `--clay-deep` | `#c6613f` | `#e08a6a` | Clay hover and pressed |
| `--brick` | `#a8412d` | `#e07a62` | Errors and denied actions (warm earth red) |
| `--olive` | `#5f7249` | `#9bb07f` | Finished steps and success marks (warm earth green) |

### Type in the app

- Interface: Inter 14px/1.45 with −0.005em tracking. Captions are 12px with −0.02em.
- Assistant replies: Source Serif 4 at 18px/1.5, weight 400 (600 for bold).
- User messages: Inter 15px.
- View titles: Source Serif 4 at 24px/1.3. The Home greeting: Source Serif 4 at 44px/1.1.
- Code, paths and commands: JetBrains Mono 13px.

### Where clay appears

Only on the one primary action of each surface:

- the composer's `Send` button;
- `Approve` on an approval card;
- `Add project` in its dialog;
- `Save default model`.

Clay also marks "you must act" states:

- the waiting-for-approval ring on a task in the sidebar;
- the Mate mascot's body, which is the app's brand mark.

Everything else is ink, oat and ivory.

### Corner concentricity (Apple Human Interface Guidelines), added 2026-09-19

The user asked for Apple's corner concentricity in both tabs (Work and Design). Where it conflicts with an older rule in this file, concentricity wins.

- **The rule:** when a rounded shape sits inside a rounded container, near one of its corners, the inner radius = the outer radius − the inset (the gap between their edges). The curves then share a center and look evenly spaced all the way around. Never go below 6px.
- **Outer radii:**
  - containers (composer, cards, dialogs, approval card, preview frame, properties panel): 24px;
  - pop-up menus and tooltips: 16px.
- **Concentric inner radii** (outer 24px):

  | Inset | Inner radius |
  |---|---|
  | 4px | 20px |
  | 8px | 16px |
  | 12px | 12px |
  | 16px | 8px |
  | 18px or more | 6px (the floor) |

- **Implementation:** CSS variables with `calc()`, so the relationship is written down and not guessed. Example: `--r-card: 24px; --inset: 8px; border-radius: max(6px, calc(var(--r-card) - var(--inset)))`.
- **Standalone controls** that aren't nested near a container corner (toolbar buttons, the tab switcher, chips): capsule shape (`border-radius: 999px`).
- **Filled buttons:** use concentric or capsule radii on all four corners. This replaces the older bottom-only 8px rule.
- **Selections:** a selection outline drawn around a rounded element uses that element's radius + the outline offset. It is the same idea, measured outward.

### Shapes

- Composer, cards, dialogs and the approval card: 24px radius with a 1px `--rule` border.
- Buttons: concentric or capsule radii per the section above. The reference's bottom-only 8px radius is retired.
- Outlined buttons: 1px `--ink-muted` border, with a concentric radius inside a container or a capsule when standalone.
- Sidebar rows: square (0 radius). Hover uses `--oat` in dark mode, or a slightly deeper tone in light mode.
- The user message bubble: 24px radius on `--oat`.
- Nowhere: shadows, gradients or glows. The "working" text pulses in opacity instead of shimmering.
- Focus ring: a 2px `--ink` outline at 2px offset (no blue).
