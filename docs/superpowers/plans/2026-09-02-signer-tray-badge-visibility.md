# Signer Tray Badge Visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every Signer state badge immediately visible in the Windows notification area without changing the agent state machine, tooltips, or notification policy.

**Architecture:** Keep tray-state selection and raster composition in `apps/signer/src-tauri/src/tray.rs`. Replace the source-image-oriented badge sizing with one deterministic geometry derived from the icon's minimum dimension, then paint a dark outer contour, a light inner contour, and the semantic colour core. Existing `TrayController` state updates continue to call `badged_icon`; no new runtime dependency or asset is introduced.

**Tech Stack:** Rust, Tauri 2 tray icons, in-memory RGBA raster painting, Cargo unit tests

**Spec:** `docs/superpowers/specs/2026-09-02-signer-tray-and-integration-journal-design.md`

## Global Constraints

- Keep the badge in the lower-right corner.
- At a 16x16 rendered size, target a 7-8 pixel outer diameter and a 5-6 pixel colour-core diameter.
- Preserve the existing grey, green, amber, red, and blue state mapping.
- Preserve existing tooltip strings, outage grace period, notification deduplication, and update/signing pulse timing.
- Keep all raster work local and offline; do not add image, animation, or network dependencies.
- Host Cargo tests do not prove Windows notification-area rendering.

## File Structure

- Modify `apps/signer/src-tauri/src/tray.rs`: define badge geometry, compose the three badge layers, retain state mapping, and extend unit coverage.
- No other production file should change unless the existing formatter requires it.

---

### Task 1: Scale-Proof Tray Badge

**Files:**

- Modify: `apps/signer/src-tauri/src/tray.rs:43-105`
- Test: `apps/signer/src-tauri/src/tray.rs:270-340`

**Interfaces:**

- Consumes: `tauri::image::Image`, `TrayVisualState`, and the existing `paint_circle` raster primitive.
- Produces: `fn badge_geometry(width: u32, height: u32) -> BadgeGeometry` and the existing `fn badged_icon(...) -> Image<'static>` with a larger dual-contour badge.

- [ ] **Step 1: Write failing geometry and contour tests**

Add a private value type and tests that describe the intended 128x128 source geometry before implementing it:

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct BadgeGeometry {
    center_x: i32,
    center_y: i32,
    outer_radius: u32,
    inner_radius: u32,
    core_radius: u32,
}

#[test]
fn badge_geometry_scales_to_a_visible_sixteen_pixel_badge() {
    let geometry = badge_geometry(128, 128);

    assert_eq!(geometry.outer_radius * 16 / 128, 3);
    assert_eq!(geometry.core_radius * 16 / 128, 2);
    assert!(geometry.outer_radius > geometry.inner_radius);
    assert!(geometry.inner_radius > geometry.core_radius);
    assert!(geometry.center_x + geometry.outer_radius as i32 <= 127);
    assert!(geometry.center_y + geometry.outer_radius as i32 <= 127);
}

#[test]
fn badge_paints_dark_light_and_semantic_layers() {
    let base = vec![7; 128 * 128 * 4];
    let geometry = badge_geometry(128, 128);
    let painted = paint_badge(&base, 128, 128, [34, 197, 94, 255], geometry.core_radius);

    assert_pixel(&painted, 128, geometry.center_x, geometry.center_y, [34, 197, 94, 255]);
    assert_pixel(
        &painted,
        128,
        geometry.center_x + geometry.core_radius as i32 + 1,
        geometry.center_y,
        [248, 250, 252, 255],
    );
    assert_pixel(
        &painted,
        128,
        geometry.center_x + geometry.inner_radius as i32 + 1,
        geometry.center_y,
        [20, 22, 27, 255],
    );
    assert_pixel(&painted, 128, 0, 0, [7, 7, 7, 7]);
}
```

Add this test helper inside `#[cfg(test)] mod tests`:

```rust
fn assert_pixel(rgba: &[u8], width: u32, x: i32, y: i32, expected: [u8; 4]) {
    let offset = (((y as u32 * width) + x as u32) * 4) as usize;
    assert_eq!(&rgba[offset..offset + 4], &expected);
}
```

- [ ] **Step 2: Run the focused Cargo test and confirm failure**

Run:

```bash
cargo test --manifest-path apps/signer/Cargo.toml --workspace tray::tests::badge_geometry_scales_to_a_visible_sixteen_pixel_badge
```

Expected: FAIL because `BadgeGeometry` and `badge_geometry` do not exist.

- [ ] **Step 3: Implement deterministic badge geometry and three-layer painting**

Add geometry derived from the minimum icon dimension. These ratios produce a
7-pixel outer diameter and a 5-pixel colour core after a 128x128 icon is
scaled to 16x16:

```rust
fn badge_geometry(width: u32, height: u32) -> BadgeGeometry {
    let minimum = width.min(height);
    let outer_radius = (minimum.saturating_mul(7) / 32).max(4);
    let inner_radius = (minimum.saturating_mul(3) / 16).max(3);
    let core_radius = (minimum.saturating_mul(5) / 32).max(2);
    let edge_inset = (minimum / 64).max(1);

    BadgeGeometry {
        center_x: width.saturating_sub(outer_radius + edge_inset) as i32,
        center_y: height.saturating_sub(outer_radius + edge_inset) as i32,
        outer_radius,
        inner_radius: inner_radius.min(outer_radius.saturating_sub(1)),
        core_radius: core_radius.min(inner_radius.saturating_sub(1)),
    }
}
```

Change `paint_badge` so it computes `BadgeGeometry` once and paints, in order:

```rust
paint_circle(..., geometry.outer_radius, [20, 22, 27, 255]);
paint_circle(..., geometry.inner_radius, [248, 250, 252, 255]);
paint_circle(..., core_radius.min(geometry.inner_radius.saturating_sub(1)), color);
```

Keep `paint_badge`'s invalid-buffer guard. Change `badged_icon` to use
`geometry.core_radius`; for `Active && pulse_on`, add `(minimum / 64).max(1)`
to the core radius and keep it below `inner_radius`. Preserve the current
state colours exactly.

- [ ] **Step 4: Run all tray unit tests**

Run:

```bash
cargo test --manifest-path apps/signer/Cargo.toml --workspace tray::tests
```

Expected: PASS, including state mapping, badge area, geometry, contour, pulse,
and notification-gate tests.

- [ ] **Step 5: Run Signer package gates**

Run:

```bash
pnpm --filter @markiro/signer test
pnpm --filter @markiro/signer typecheck
pnpm --filter @markiro/signer lint
pnpm --filter @markiro/signer build
cargo test --manifest-path apps/signer/Cargo.toml --workspace
git diff --check
```

Expected: every command exits 0. Report explicitly that these checks do not
exercise Windows tray scaling.

- [ ] **Step 6: Commit the tray change**

```bash
git add apps/signer/src-tauri/src/tray.rs
git commit -m "fix(signer): make tray status badge visible"
```

Expected: one scoped commit containing only the Rust tray implementation and
tests.

- [ ] **Step 7: Perform the external Windows acceptance check before release**

Install the packaged Signer on Windows and inspect grey, green, amber, red,
and blue states at 100%, 125%, and 150% display scaling. Confirm the colour
core is visible in both light and dark taskbar themes, the badge is not
clipped, and the tooltip still names each state. Record this separately from
the automated checks; do not claim it from host Cargo output.
