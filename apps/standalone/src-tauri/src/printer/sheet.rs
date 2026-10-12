//! A4 sheets through the Windows driver (plan А4, after the cloud station's
//! `printer_sheet.rs`, #702): the checks the driver path makes before it
//! draws, pure so that they run on any host. A sheet is a `mono-raster-v1`
//! page at 300 dpi of exactly A4 in either orientation; the device page must
//! be A4 in the same orientation at 300, 600 or 1200 dpi, the same on both
//! axes; the sheet is drawn 1:1, 2:1 or 4:1, never fitted, and its required
//! area (the content and the SSCC's quiet zones) must lie inside the
//! device's printable area with a 0.5 mm guard. Anything else is refused
//! before the job starts (`geometry_mismatch`): nothing reached the printer.

use super::raster::{Caps, Raster};

/// `DEVMODE.dmPaperSize` of A4 (`DMPAPER_A4`), `dmOrientation` and `dmDuplex`
/// values, written here so that the host tests can read them; the Windows
/// module asserts at compile time that they are `windows-sys`'s.
pub const DMPAPER_A4: i16 = 9;
pub const DMORIENT_PORTRAIT: i16 = 1;
pub const DMORIENT_LANDSCAPE: i16 = 2;
pub const DMDUP_SIMPLEX: i16 = 1;

/// The orientation of an A4 page.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Orientation {
    Portrait,
    Landscape,
}

impl Orientation {
    /// The value of `DEVMODE.dmOrientation`.
    pub fn devmode(self) -> i16 {
        match self {
            Orientation::Portrait => DMORIENT_PORTRAIT,
            Orientation::Landscape => DMORIENT_LANDSCAPE,
        }
    }
}

/// What the checks read of a sheet's `mono-raster-v1` header.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SheetRaster {
    pub dpi: i32,
    pub width_mm: f64,
    pub height_mm: f64,
    /// Width and height in dots.
    pub width: i32,
    pub height: i32,
    /// The required area in dots: left, top, right, bottom (right and bottom exclusive).
    pub bounds: [i32; 4],
}

impl From<&Raster<'_>> for SheetRaster {
    fn from(page: &Raster<'_>) -> Self {
        Self {
            dpi: page.dpi,
            width_mm: page.width_mm,
            height_mm: page.height_mm,
            width: page.width,
            height: page.height,
            bounds: page.bounds,
        }
    }
}

/// A printer device's page as GDI reports it (`GetDeviceCaps`: `LOGPIXELSX`,
/// `LOGPIXELSY`, `PHYSICALWIDTH`, `PHYSICALHEIGHT`, `PHYSICALOFFSETX`,
/// `PHYSICALOFFSETY`, `HORZRES`, `VERTRES`), in device pixels.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DeviceCaps {
    pub dpi_x: i32,
    pub dpi_y: i32,
    pub width: i32,
    pub height: i32,
    pub offset_x: i32,
    pub offset_y: i32,
    pub printable_width: i32,
    pub printable_height: i32,
}

impl From<Caps> for DeviceCaps {
    fn from(c: Caps) -> Self {
        Self {
            dpi_x: c.dpi_x,
            dpi_y: c.dpi_y,
            width: c.width,
            height: c.height,
            offset_x: c.offset_x,
            offset_y: c.offset_y,
            printable_width: c.printable_width,
            printable_height: c.printable_height,
        }
    }
}

/// Where and how large the sheet is drawn on the device's printable area.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DrawPlan {
    /// Device dots per sheet dot: 1, 2 or 4.
    pub scale: i32,
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

/// Why a sheet is not printed; both mean nothing was sent.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SheetError {
    /// Not a 300 dpi A4 sheet.
    NotA4,
    /// The device page or its printable area does not hold the sheet.
    GeometryMismatch,
}

impl SheetError {
    /// The failure code the driver path reports (the codes of plan ДРВ).
    pub fn code(self) -> &'static str {
        match self {
            SheetError::NotA4 => "invalid_artifact",
            SheetError::GeometryMismatch => "geometry_mismatch",
        }
    }
}

fn sheet_dots(mm: f64) -> i32 {
    (mm * 300.0 / 25.4).round() as i32
}

/// The orientation of a 300 dpi A4 sheet, or [`SheetError::NotA4`].
pub fn sheet_orientation(raster: &SheetRaster) -> Result<Orientation, SheetError> {
    let near = |a: f64, b: f64| (a - b).abs() <= 0.01;
    if raster.dpi != 300 {
        return Err(SheetError::NotA4);
    }
    let orientation = if near(raster.width_mm, 210.0) && near(raster.height_mm, 297.0) {
        Orientation::Portrait
    } else if near(raster.width_mm, 297.0) && near(raster.height_mm, 210.0) {
        Orientation::Landscape
    } else {
        return Err(SheetError::NotA4);
    };
    if raster.width != sheet_dots(raster.width_mm) || raster.height != sheet_dots(raster.height_mm)
    {
        return Err(SheetError::NotA4);
    }
    Ok(orientation)
}

/// How the sheet is drawn on a device page, or why it is not.
pub fn sheet_draw_plan(raster: &SheetRaster, caps: DeviceCaps) -> Result<DrawPlan, SheetError> {
    let orientation = sheet_orientation(raster)?;
    let c = caps;
    if !matches!(c.dpi_x, 300 | 600 | 1200)
        || c.dpi_y != c.dpi_x
        || c.width <= 0
        || c.height <= 0
        || c.offset_x < 0
        || c.offset_y < 0
        || c.printable_width <= 0
        || c.printable_height <= 0
        || i64::from(c.offset_x) + i64::from(c.printable_width) > i64::from(c.width)
        || i64::from(c.offset_y) + i64::from(c.printable_height) > i64::from(c.height)
    {
        return Err(SheetError::GeometryMismatch);
    }
    let mm = |px: i32| f64::from(px) * 25.4 / f64::from(c.dpi_x);
    let (width_mm, height_mm) = match orientation {
        Orientation::Portrait => (210.0, 297.0),
        Orientation::Landscape => (297.0, 210.0),
    };
    if (mm(c.width) - width_mm).abs() > 0.5 || (mm(c.height) - height_mm).abs() > 0.5 {
        return Err(SheetError::GeometryMismatch);
    }
    let scale = c.dpi_x / 300;
    let guard = (0.5 * f64::from(c.dpi_x) / 25.4).ceil() as i64;
    let [left, top, right, bottom] = raster.bounds.map(|px| i64::from(px) * i64::from(scale));
    // The page is exactly A4 (3508 dots at most) and the scale at most 4, so
    // nothing here can overflow; an empty required area is no sheet, and one
    // that leaves the page cannot lie inside the printable area less the guard.
    if right <= left
        || bottom <= top
        || left < i64::from(c.offset_x) + guard
        || top < i64::from(c.offset_y) + guard
        || right > i64::from(c.offset_x) + i64::from(c.printable_width) - guard
        || bottom > i64::from(c.offset_y) + i64::from(c.printable_height) - guard
    {
        return Err(SheetError::GeometryMismatch);
    }
    Ok(DrawPlan {
        scale,
        x: -c.offset_x,
        y: -c.offset_y,
        width: raster.width * scale,
        height: raster.height * scale,
    })
}

/// A blank `mono-raster-v1` page of `width_mm` x `height_mm` at `dpi` with the
/// given required area (tests only).
#[cfg(test)]
pub(crate) fn blank_page_bytes(
    dpi: u32,
    (width_mm, height_mm): (f64, f64),
    bounds: [u32; 4],
) -> Vec<u8> {
    let width = (width_mm * f64::from(dpi) / 25.4).round() as u32;
    let height = (height_mm * f64::from(dpi) / 25.4).round() as u32;
    let stride = width.div_ceil(8);
    let length = stride * height;
    let mut b = vec![0u8; 64 + length as usize];
    b[..8].copy_from_slice(b"MKRMNO1\0");
    for (i, n) in [
        (8, dpi),
        (12, width),
        (16, height),
        (20, stride),
        (40, length),
        (48, bounds[0]),
        (52, bounds[1]),
        (56, bounds[2]),
        (60, bounds[3]),
    ] {
        b[i..i + 4].copy_from_slice(&n.to_le_bytes());
    }
    b[24..32].copy_from_slice(&width_mm.to_le_bytes());
    b[32..40].copy_from_slice(&height_mm.to_le_bytes());
    b
}

/// A blank 300 dpi A4 page in `orientation` (tests only).
#[cfg(test)]
pub(crate) fn a4_page_bytes(orientation: Orientation, bounds: [u32; 4]) -> Vec<u8> {
    let size = match orientation {
        Orientation::Portrait => (210.0, 297.0),
        Orientation::Landscape => (297.0, 210.0),
    };
    blank_page_bytes(300, size, bounds)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A portrait sheet whose required area keeps 10 mm margins (118 dots).
    fn portrait() -> SheetRaster {
        SheetRaster {
            dpi: 300,
            width_mm: 210.0,
            height_mm: 297.0,
            width: 2480,
            height: 3508,
            bounds: [118, 118, 2480 - 118, 3508 - 118],
        }
    }

    /// A 600 dpi A4 page in `orientation` with 100 px (4.2 mm) unprintable edges.
    fn laser(orientation: Orientation) -> DeviceCaps {
        let (width, height) = match orientation {
            Orientation::Portrait => (4960, 7016),
            Orientation::Landscape => (7016, 4960),
        };
        DeviceCaps {
            dpi_x: 600,
            dpi_y: 600,
            width,
            height,
            offset_x: 100,
            offset_y: 100,
            printable_width: width - 200,
            printable_height: height - 200,
        }
    }

    #[test]
    fn a_portrait_sheet_is_drawn_two_to_one_on_a_600_dpi_laser() {
        assert_eq!(sheet_orientation(&portrait()), Ok(Orientation::Portrait));
        assert_eq!(
            sheet_draw_plan(&portrait(), laser(Orientation::Portrait)),
            Ok(DrawPlan {
                scale: 2,
                x: -100,
                y: -100,
                width: 4960,
                height: 7016
            })
        );
    }

    #[test]
    fn a_landscape_sheet_needs_a_landscape_page() {
        let landscape = SheetRaster {
            width_mm: 297.0,
            height_mm: 210.0,
            width: 3508,
            height: 2480,
            bounds: [118, 118, 3508 - 118, 2480 - 118],
            ..portrait()
        };
        assert_eq!(sheet_orientation(&landscape), Ok(Orientation::Landscape));
        assert!(sheet_draw_plan(&landscape, laser(Orientation::Landscape)).is_ok());
        assert_eq!(
            sheet_draw_plan(&landscape, laser(Orientation::Portrait)),
            Err(SheetError::GeometryMismatch)
        );
    }

    #[test]
    fn content_in_the_unprintable_edge_is_refused_before_sending() {
        // 2 mm margins: 24 sheet dots, 48 device dots, inside the 100 px edge.
        let tight = SheetRaster {
            bounds: [24, 24, 2480 - 24, 3508 - 24],
            ..portrait()
        };
        assert_eq!(
            sheet_draw_plan(&tight, laser(Orientation::Portrait)),
            Err(SheetError::GeometryMismatch)
        );
    }

    #[test]
    fn letter_paper_unequal_axes_and_odd_resolutions_are_refused() {
        let letter = DeviceCaps {
            width: 5100,
            height: 6600,
            ..laser(Orientation::Portrait)
        };
        assert_eq!(
            sheet_draw_plan(&portrait(), letter),
            Err(SheetError::GeometryMismatch)
        );
        let unequal = DeviceCaps {
            dpi_y: 300,
            ..laser(Orientation::Portrait)
        };
        assert_eq!(
            sheet_draw_plan(&portrait(), unequal),
            Err(SheetError::GeometryMismatch)
        );
        let odd = DeviceCaps {
            dpi_x: 203,
            dpi_y: 203,
            ..laser(Orientation::Portrait)
        };
        assert_eq!(
            sheet_draw_plan(&portrait(), odd),
            Err(SheetError::GeometryMismatch)
        );
    }

    #[test]
    fn a_label_raster_is_not_a_sheet() {
        let label = SheetRaster {
            dpi: 203,
            width_mm: 58.0,
            height_mm: 40.0,
            width: 463,
            height: 320,
            bounds: [0, 0, 463, 320],
        };
        assert_eq!(sheet_orientation(&label), Err(SheetError::NotA4));
        assert_eq!(SheetError::NotA4.code(), "invalid_artifact");
    }

    /// An A4 portrait device at `dpi` with the given unprintable edges.
    fn device(dpi: i32, edge_x: i32, edge_y: i32) -> DeviceCaps {
        let width = (210.0 * f64::from(dpi) / 25.4).round() as i32;
        let height = (297.0 * f64::from(dpi) / 25.4).round() as i32;
        DeviceCaps {
            dpi_x: dpi,
            dpi_y: dpi,
            width,
            height,
            offset_x: edge_x,
            offset_y: edge_y,
            printable_width: width - 2 * edge_x,
            printable_height: height - 2 * edge_y,
        }
    }

    fn with_bounds(bounds: [i32; 4]) -> SheetRaster {
        SheetRaster {
            bounds,
            ..portrait()
        }
    }

    #[test]
    fn the_dots_of_a_sheet_and_its_resolution_must_be_a4_at_300_dpi() {
        for dpi in [203, 299, 301, 600] {
            let sheet = SheetRaster { dpi, ..portrait() };
            assert_eq!(sheet_orientation(&sheet), Err(SheetError::NotA4), "{dpi}");
        }
        for (width, height) in [(2481, 3508), (2479, 3508), (2480, 3507), (2480, 3509)] {
            let sheet = SheetRaster {
                width,
                height,
                ..portrait()
            };
            assert_eq!(sheet_orientation(&sheet), Err(SheetError::NotA4));
        }
        // 210 x 210 and 297 x 297 are no A4 in either orientation.
        let square = SheetRaster {
            width_mm: 210.0,
            height_mm: 210.0,
            width: 2480,
            height: 2480,
            ..portrait()
        };
        assert_eq!(sheet_orientation(&square), Err(SheetError::NotA4));
        let tall = SheetRaster {
            width_mm: 297.0,
            height_mm: 297.0,
            width: 3508,
            height: 3508,
            ..portrait()
        };
        assert_eq!(sheet_orientation(&tall), Err(SheetError::NotA4));
    }

    #[test]
    fn the_millimetres_of_a_sheet_are_a4_within_a_hundredth() {
        for (width_mm, height_mm, ok) in [
            (210.009, 297.0, true),
            (210.0, 297.009, true),
            (209.991, 297.0, true),
            (210.02, 297.0, false),
            (210.0, 297.02, false),
            (209.98, 297.0, false),
            (210.0, 296.98, false),
        ] {
            let sheet = SheetRaster {
                width_mm,
                height_mm,
                ..portrait()
            };
            assert_eq!(
                sheet_orientation(&sheet).is_ok(),
                ok,
                "{width_mm}x{height_mm}"
            );
        }
        let landscape = SheetRaster {
            width_mm: 297.02,
            height_mm: 210.0,
            width: 3508,
            height: 2480,
            ..portrait()
        };
        assert_eq!(sheet_orientation(&landscape), Err(SheetError::NotA4));
        let landscape = SheetRaster {
            width_mm: 297.0,
            height_mm: 210.02,
            ..landscape
        };
        assert_eq!(sheet_orientation(&landscape), Err(SheetError::NotA4));
    }

    #[test]
    fn a_sheet_is_drawn_whole_number_times_at_300_600_and_1200_dpi() {
        for (dpi, scale) in [(300, 1), (600, 2), (1200, 4)] {
            let plan = sheet_draw_plan(&portrait(), device(dpi, 20, 30)).unwrap();
            assert_eq!(
                plan,
                DrawPlan {
                    scale,
                    x: -20,
                    y: -30,
                    width: 2480 * scale,
                    height: 3508 * scale,
                },
                "{dpi}"
            );
        }
        for dpi in [150, 203, 299, 301, 400, 1201, 2400] {
            assert_eq!(
                sheet_draw_plan(&portrait(), device(dpi, 0, 0)),
                Err(SheetError::GeometryMismatch),
                "{dpi}"
            );
        }
    }

    #[test]
    fn the_origin_is_the_papers_corner_whatever_the_unprintable_edges_are() {
        let plan = sheet_draw_plan(&portrait(), device(300, 0, 0)).unwrap();
        assert_eq!((plan.x, plan.y), (0, 0));
        let plan = sheet_draw_plan(&portrait(), device(600, 100, 80)).unwrap();
        assert_eq!((plan.x, plan.y), (-100, -80));
    }

    #[test]
    fn a_landscape_sheet_is_drawn_with_its_own_dots() {
        let landscape = SheetRaster {
            width_mm: 297.0,
            height_mm: 210.0,
            width: 3508,
            height: 2480,
            bounds: [118, 118, 3508 - 118, 2480 - 118],
            ..portrait()
        };
        assert_eq!(
            sheet_draw_plan(&landscape, laser(Orientation::Landscape)),
            Ok(DrawPlan {
                scale: 2,
                x: -100,
                y: -100,
                width: 7016,
                height: 4960,
            })
        );
    }

    #[test]
    fn the_device_page_is_a4_within_half_a_millimetre_on_each_axis() {
        // 600 dpi: 210 mm is 4960.6 dots and 297 mm is 7015.7; half a
        // millimetre is 11.8 dots either way.
        for (width, height, ok) in [
            (4949, 7016, true),
            (4948, 7016, false),
            (4972, 7016, true),
            (4973, 7016, false),
            (4960, 7004, true),
            (4960, 7003, false),
            (4960, 7027, true),
            (4960, 7028, false),
        ] {
            let caps = DeviceCaps {
                width,
                height,
                printable_width: width - 200,
                printable_height: height - 200,
                ..laser(Orientation::Portrait)
            };
            assert_eq!(
                sheet_draw_plan(&portrait(), caps).is_ok(),
                ok,
                "{width}x{height}"
            );
        }
    }

    #[test]
    fn a_device_that_reports_nonsense_is_refused() {
        let base = laser(Orientation::Portrait);
        let broken = [
            DeviceCaps { width: 0, ..base },
            DeviceCaps { height: 0, ..base },
            DeviceCaps {
                width: -4960,
                ..base
            },
            DeviceCaps {
                height: -7016,
                ..base
            },
            DeviceCaps {
                offset_x: -1,
                ..base
            },
            DeviceCaps {
                offset_y: -1,
                ..base
            },
            DeviceCaps {
                printable_width: 0,
                ..base
            },
            DeviceCaps {
                printable_height: 0,
                ..base
            },
            DeviceCaps {
                printable_width: -1,
                ..base
            },
            DeviceCaps {
                printable_height: -1,
                ..base
            },
            // The printable area runs past the page.
            DeviceCaps {
                printable_width: base.width - base.offset_x + 1,
                ..base
            },
            DeviceCaps {
                printable_height: base.height - base.offset_y + 1,
                ..base
            },
            DeviceCaps {
                dpi_y: 1200,
                ..base
            },
            DeviceCaps { dpi_y: 300, ..base },
        ];
        for (i, caps) in broken.into_iter().enumerate() {
            assert_eq!(
                sheet_draw_plan(&portrait(), caps),
                Err(SheetError::GeometryMismatch),
                "{i}"
            );
        }
        // The same page with the printable area ending exactly on the page edge.
        let exact = DeviceCaps {
            printable_width: base.width - base.offset_x,
            printable_height: base.height - base.offset_y,
            ..base
        };
        assert!(sheet_draw_plan(&with_bounds([118, 118, 2480 - 118, 3508 - 118]), exact).is_ok());
    }

    #[test]
    fn the_required_area_keeps_half_a_millimetre_from_every_edge_of_the_printable_area() {
        // 600 dpi, 100 dot edges: the guard is ceil(0.5 mm) = 12 dots, so the
        // area may start at 112 dots (56 sheet dots) and end at 4848 / 6904.
        let caps = laser(Orientation::Portrait);
        let ok = |bounds| sheet_draw_plan(&with_bounds(bounds), caps).is_ok();
        assert!(ok([56, 56, 2424, 3452]));
        assert!(!ok([55, 56, 2424, 3452]), "left");
        assert!(!ok([56, 55, 2424, 3452]), "top");
        assert!(!ok([56, 56, 2425, 3452]), "right");
        assert!(!ok([56, 56, 2424, 3453]), "bottom");
    }

    #[test]
    fn the_guard_follows_the_resolution() {
        // 300 dpi: ceil(5.9) = 6 dots; 1200 dpi: ceil(23.6) = 24 dots.
        let from_left_and_top = |dpi: i32, edge: i32, l: i32| {
            let bounds = [l, l, 2480 - 60, 3508 - 60];
            sheet_draw_plan(&with_bounds(bounds), device(dpi, edge, edge)).is_ok()
        };
        assert!(from_left_and_top(300, 20, 26));
        assert!(!from_left_and_top(300, 20, 25));
        // 1200 dpi: the edge is 80 dots, a sheet dot is 4 device dots.
        assert!(from_left_and_top(1200, 80, 26));
        assert!(!from_left_and_top(1200, 80, 25));
        // 600 dpi with an odd edge: the guard is 12 dots (11.8 rounded up), so
        // the area starts at 101 + 12 = 113 dots, i.e. at sheet dot 57.
        assert!(from_left_and_top(600, 101, 57));
        assert!(!from_left_and_top(600, 101, 56));
    }

    #[test]
    fn an_empty_or_leaving_required_area_is_no_sheet() {
        let caps = laser(Orientation::Portrait);
        for (i, bounds) in [
            [0, 0, 0, 0],
            [118, 118, 118, 3000],
            [118, 118, 2000, 118],
            [200, 118, 100, 3000],
            [118, 200, 2000, 100],
            [-1, 118, 2000, 3000],
            [118, -1, 2000, 3000],
            [118, 118, 2481, 3000],
            [118, 118, 2000, 3509],
        ]
        .into_iter()
        .enumerate()
        {
            assert_eq!(
                sheet_draw_plan(&with_bounds(bounds), caps),
                Err(SheetError::GeometryMismatch),
                "{i}"
            );
        }
    }

    #[test]
    fn a_page_that_is_not_a4_is_refused_before_the_device_is_read() {
        let label = SheetRaster {
            dpi: 203,
            width_mm: 58.0,
            height_mm: 40.0,
            width: 463,
            height: 320,
            bounds: [0, 0, 463, 320],
        };
        // A device that is itself nonsense still answers NotA4 first.
        let nonsense = DeviceCaps {
            width: 0,
            ..laser(Orientation::Portrait)
        };
        assert_eq!(sheet_draw_plan(&label, nonsense), Err(SheetError::NotA4));
    }

    #[test]
    fn the_failure_codes_are_the_driver_paths() {
        assert_eq!(SheetError::NotA4.code(), "invalid_artifact");
        assert_eq!(SheetError::GeometryMismatch.code(), "geometry_mismatch");
    }

    #[test]
    fn the_devmode_values_are_the_windows_ones() {
        // wingdi.h: DMPAPER_A4 9, DMORIENT_PORTRAIT 1, DMORIENT_LANDSCAPE 2, DMDUP_SIMPLEX 1.
        assert_eq!(DMPAPER_A4, 9);
        assert_eq!(Orientation::Portrait.devmode(), 1);
        assert_eq!(Orientation::Landscape.devmode(), 2);
        assert_eq!(DMDUP_SIMPLEX, 1);
    }

    #[test]
    fn the_checked_page_and_the_driver_caps_become_sheet_inputs_field_by_field() {
        let bytes = a4_page_bytes(Orientation::Landscape, [1, 2, 3000, 2000]);
        let page = super::super::raster::decode(&bytes).unwrap();
        assert_eq!(
            SheetRaster::from(&page),
            SheetRaster {
                dpi: 300,
                width_mm: 297.0,
                height_mm: 210.0,
                width: 3508,
                height: 2480,
                bounds: [1, 2, 3000, 2000],
            }
        );
        assert_eq!(
            DeviceCaps::from(Caps {
                dpi_x: 1,
                dpi_y: 2,
                width: 3,
                height: 4,
                offset_x: 5,
                offset_y: 6,
                printable_width: 7,
                printable_height: 8,
            }),
            DeviceCaps {
                dpi_x: 1,
                dpi_y: 2,
                width: 3,
                height: 4,
                offset_x: 5,
                offset_y: 6,
                printable_width: 7,
                printable_height: 8,
            }
        );
    }

    #[test]
    fn an_a4_page_at_300_dpi_is_inside_the_raster_limit() {
        for orientation in [Orientation::Portrait, Orientation::Landscape] {
            let bytes = a4_page_bytes(orientation, [118, 118, 2000, 2000]);
            assert!(
                bytes.len() <= super::super::raster::MAX_BYTES,
                "{}",
                bytes.len()
            );
            let page = super::super::raster::decode(&bytes).unwrap();
            assert_eq!(
                sheet_orientation(&SheetRaster::from(&page)),
                Ok(orientation)
            );
        }
        // 1 087 480 pixel bytes and the 64 byte header.
        assert_eq!(
            a4_page_bytes(Orientation::Portrait, [0; 4]).len(),
            64 + 310 * 3508
        );
    }
}
