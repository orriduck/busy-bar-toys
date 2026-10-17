# Control surface spacing

The desktop and mobile interfaces use one spacing scale.
Tailwind owns the scale through `@theme { --spacing: 4px; }`.
Application CSS uses `--spacing(n)`. Components use utilities such as `gap-2`, `p-3`, and `px-4`.
See the [Tailwind theme documentation](https://tailwindcss.com/docs/theme).

Keep typography independent from spacing. The existing desktop font scale remains 90%.
Spacing does not shrink to 3.6px increments with that font scale.

## Spacing roles

| Role | Token | Size |
| --- | --- | --- |
| Adjacent text or a small indicator | `1` | 4px |
| Related controls, metadata cells, compact rows | `2` | 8px |
| Compact content, queue row padding | `3` | 12px |
| Card content, editor content, mobile workspace | `4` | 16px |
| Secondary section separation | `5` | 20px |
| Main section separation, desktop page gutter and workspace | `6` | 24px |
| Desktop sidebar-to-workspace separation | `8` | 32px |

Choose the role before choosing a number. Do not add another raw pixel or rem value to fix one screenshot.
Use normal flow, grid, or flex gap to align sections. Do not use a negative margin to pull descriptions or buttons into place.

## Audit decisions

- Services uses a 12px title-to-description gap and 24px after the description.
- Configuration hints and the mobile back button use normal document flow.
- Read-only information follows the editor heading with a positive gap.
- Metadata uses 8px gaps and 12px card content padding.
- The editor uses 16px padding. Its list pane uses 8px padding.
- Queue row padding is 12px. The icon and content are separated by 12px on desktop and 8px on narrow screens.
- Header, sidebar, preview dock, and mobile navigation use the same scale.
- The mobile navigation has five equal columns. Its selected background uses the same inset as the navigation content.
- The mobile workspace reserves space for the floating navigation and the safe area.
- Help tooltips cap their width at the viewport width minus `--spacing(6)`. Long help text wraps; the component positions the popup.
- Compact Button variants use integer spacing steps for padding and content gaps.

## Deliberate exceptions

The 4px rule applies to application layout spacing.
It does not change type sizes, line heights, border thicknesses, optical icon details, radii, or shadow blur.
Installed shadcn primitives retain their optical internal adjustments, including compact badge padding.
Device-shell percentages map the physical display. They are not layout spacing.
Safe-area values come from the operating system. Grid fractions and viewport-based positioning remain fluid.

The keyboard skip link uses a transform calculated from its own height and a spacing token.
Queue removal reads the actual row gap during animation. Its temporary negative margin cancels that measured gap as the row collapses.
Neither behavior uses a fixed negative offset to align ordinary content.

## Verification

Use local mock data for layout and interaction checks.
Check Display, Services, Configuration, and Device at 320, 390, 768, 1024, and 1440px.

- Measure padding and gaps after CSS compilation. The main application layout must use 4px multiples.
- Check long names, IDs, expanded metadata, and registration fields for overflow.
- Check both themes, reduced motion, keyboard and pointer group changes, and read-only computers.
- Confirm equal navigation button spacing and clearance above the mobile navigation.
- Confirm touch inputs retain the 16px font-size floor and manual zoom remains available.
- Confirm queue arrivals, exits, and Hold rotation still use server state.

These are browser layout checks. They do not prove device frame rate or physical display behavior.
