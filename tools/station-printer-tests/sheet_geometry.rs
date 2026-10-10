use crate::printer_raster::{Caps, Raster};
use crate::printer_sheet::{sheet_draw_plan, sheet_geometry, Orientation, WindowsPageOptions};
fn options(landscape: bool) -> WindowsPageOptions {
    WindowsPageOptions::a4(if landscape {
        Orientation::Landscape
    } else {
        Orientation::Portrait
    })
}
#[test]
fn borderless_rounded_a4_caps_never_report_printable_mm_outside_logical_page() {
    let c = Caps {
        dpi_x: 300,
        dpi_y: 300,
        width: 2480,
        height: 3508,
        offset_x: 0,
        offset_y: 0,
        printable_width: 2480,
        printable_height: 3508,
    };
    let geometry = sheet_geometry("Borderless", options(false), c).unwrap();
    assert!(geometry.printable_bounds_mm.right <= geometry.width_mm);
    assert!(geometry.printable_bounds_mm.bottom <= geometry.height_mm);
}
fn caps(dpi: i32, landscape: bool) -> Caps {
    let (w, h) = if landscape {
        (297., 210.)
    } else {
        (210., 297.)
    };
    let px = |mm: f64| (mm * f64::from(dpi) / 25.4).round() as i32;
    Caps {
        dpi_x: dpi,
        dpi_y: dpi,
        width: px(w),
        height: px(h),
        offset_x: px(3.),
        offset_y: px(7.),
        printable_width: px(w) - px(3.) - px(5.),
        printable_height: px(h) - px(7.) - px(4.),
    }
}
fn page(landscape: bool) -> Raster<'static> {
    let (w, h) = if landscape {
        (297., 210.)
    } else {
        (210., 297.)
    };
    let width = (w * 300.0f64 / 25.4).round() as i32;
    let height = (h * 300.0f64 / 25.4).round() as i32;
    Raster {
        dpi: 300,
        width,
        height,
        width_mm: w,
        height_mm: h,
        stride: (width as usize).div_ceil(8),
        bounds: [120, 130, width - 120, height - 130],
        pixels: &[],
    }
}
#[test]
fn a4_uses_real_asymmetric_bounds_and_integer_scaling_without_fitting() {
    for landscape in [false, true] {
        for dpi in [300, 600, 1200] {
            let c = caps(dpi, landscape);
            let geometry = sheet_geometry("Queue", options(landscape), c).unwrap();
            assert_eq!(geometry.device_dpi_x, dpi);
            assert_eq!(geometry.guard_mm, 0.5);
            assert!((geometry.printable_bounds_mm.left - 3.).abs() < 0.1);
            assert!((geometry.printable_bounds_mm.top - 7.).abs() < 0.1);
            let p = page(landscape);
            let plan =
                sheet_draw_plan(&p, "Queue", options(landscape), c, &geometry.fingerprint).unwrap();
            assert_eq!(plan.scale, dpi / 300);
            assert_eq!(plan.x, -c.offset_x);
            assert_eq!(plan.y, -c.offset_y);
            assert_eq!(plan.width, p.width * plan.scale);
            assert_eq!(plan.height, p.height * plan.scale);
        }
    }
}
#[test]
fn rejects_letter_wrong_orientation_anisotropic_or_noninteger_dpi_and_bad_caps() {
    let c = caps(600, false);
    for bad in [
        Caps {
            width: 5100,
            height: 6600,
            ..c
        },
        Caps { dpi_y: 300, ..c },
        Caps {
            dpi_x: 203,
            dpi_y: 203,
            ..c
        },
        Caps {
            dpi_x: 900,
            dpi_y: 900,
            ..c
        },
        Caps { width: 16385, ..c },
        Caps { offset_x: -1, ..c },
        Caps {
            printable_width: c.width + 1,
            ..c
        },
    ] {
        assert!(sheet_geometry("Queue", options(false), bad).is_err());
    }
    assert!(sheet_geometry("Queue", options(true), c).is_err());
}
#[test]
fn changed_geometry_and_quiet_zone_guard_are_refused_before_drawing() {
    let c = caps(600, false);
    let original = sheet_geometry("Queue", options(false), c).unwrap();
    let p = page(false);
    assert!(sheet_draw_plan(
        &p,
        "Queue",
        options(false),
        Caps {
            offset_x: c.offset_x + 1,
            printable_width: c.printable_width - 1,
            ..c
        },
        &original.fingerprint
    )
    .is_err());
    assert!(sheet_draw_plan(&p, "Other queue", options(false), c, &original.fingerprint).is_err());
    let near = Raster {
        bounds: [
            c.offset_x / 2,
            c.offset_y / 2,
            p.width - 120,
            p.height - 130,
        ],
        ..p
    };
    assert!(sheet_draw_plan(&near, "Queue", options(false), c, &original.fingerprint).is_err());
}
#[test]
fn sheet_mode_requires_fixed_source_300_and_explicit_a4_options() {
    let c = caps(600, false);
    let geometry = sheet_geometry("Queue", options(false), c).unwrap();
    let p = page(false);
    assert!(sheet_draw_plan(
        &Raster { dpi: 203, ..p },
        "Queue",
        options(false),
        c,
        &geometry.fingerprint
    )
    .is_err());
    assert!(serde_json::from_str::<WindowsPageOptions>(
        r#"{"mode":"raw","orientation":"portrait"}"#
    )
    .is_err());
    assert!(serde_json::from_str::<WindowsPageOptions>(
        r#"{"mode":"a4_sheet","orientation":"portrait","copies":2}"#
    )
    .is_err());
}
