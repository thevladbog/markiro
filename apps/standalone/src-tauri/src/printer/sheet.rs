//! A4 sheets through the Windows driver (plan А4, after the cloud station's
//! `printer_sheet.rs`, #702): the checks the driver path makes before it
//! draws, pure so that they run on any host. A sheet is a `mono-raster-v1`
//! page at 300 dpi of exactly A4 in either orientation; the device page must
//! be A4 (or Letter) in the same orientation at a multiple of 300 dpi, the
//! same on both axes; the sheet is drawn at a whole-number scale, and its
//! required area (the content and the SSCC's quiet zones) must lie inside the
//! device's printable area with a 0.5 mm guard: a sheet that does not is moved
//! the few millimetres it takes, or drawn uniformly smaller (to 90 % at the
//! least), and says so. Anything else is refused before the job starts
//! (`geometry_mismatch`) with the measured numbers: nothing reached the printer.

use super::raster::{Caps, Raster};
use serde::Serialize;

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
    /// Device dots per sheet dot at full size: 1 for 300 dpi, 2 for 600, 4 for 1200.
    pub scale: i32,
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
    /// The part of the full size the sheet is drawn at, in thousandths: 1000 draws it whole
    /// (the whole-number scale), less shrinks it uniformly so that its required area fits the
    /// printable area (`MIN_FIT_PERMILLE` at the least).
    pub fit_permille: u32,
    /// How far the sheet was moved from the paper's corner to bring its required area inside
    /// the printable area, in device dots: right and down (`shift_x`, `shift_y`).
    pub shift_x: i32,
    pub shift_y: i32,
}

/// What a plan did to the sheet, for the person at the printer: the sheet was moved a few
/// millimetres or drawn a little smaller to fit this driver's printable area. `None` when
/// it was drawn whole and where it was made.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Adjusted {
    /// The size the sheet was drawn at, in percent of its own (100 when it was only moved).
    pub percent: u32,
    pub shift_x_mm: f64,
    pub shift_y_mm: f64,
}

impl DrawPlan {
    /// What this plan changed, at the device's resolution (`dpi`).
    pub fn adjusted(&self, dpi: i32) -> Option<Adjusted> {
        let mm = |dots: i32| (f64::from(dots) * 25.4 / f64::from(dpi) * 10.0).round() / 10.0;
        let (shift_x_mm, shift_y_mm) = (mm(self.shift_x), mm(self.shift_y));
        if self.fit_permille >= 1000 && shift_x_mm == 0.0 && shift_y_mm == 0.0 {
            return None;
        }
        Some(Adjusted {
            percent: self.fit_permille.div_ceil(10).min(100),
            shift_x_mm,
            shift_y_mm,
        })
    }
}

/// The smallest part of its size a sheet is drawn at to fit a printable area (thousandths):
/// a sheet that would have to shrink further is refused, since its barcodes would no longer be
/// the ones that were checked.
pub const MIN_FIT_PERMILLE: u32 = 900;

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

/// A refusal with the numbers behind it: what the driver reported against what the sheet
/// needs, in millimetres, as one line the operator can copy to whoever helps (the
/// «Копия диагностики» of the setup).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Refusal {
    pub error: SheetError,
    pub diagnostic: String,
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

/// How far a driver's paper may differ from the paper's nominal size, millimetres: drivers
/// round their forms (4961 dots at 600 dpi, a form of 209.9 mm).
const PAPER_TOLERANCE_MM: f64 = 1.5;

/// Whether the device's page is A4 or Letter in the sheet's orientation, within the
/// driver's rounding. A Letter page is no A4, but it is a paper a sheet is drawn on, smaller,
/// as an office printer set to Letter does; anything else (A5, A3, a label) is not.
fn paper_is_a4_or_letter(width_mm: f64, height_mm: f64, orientation: Orientation) -> bool {
    let (a4, letter) = match orientation {
        Orientation::Portrait => ((210.0, 297.0), (215.9, 279.4)),
        Orientation::Landscape => ((297.0, 210.0), (279.4, 215.9)),
    };
    let near = |size: (f64, f64)| {
        (width_mm - size.0).abs() <= PAPER_TOLERANCE_MM
            && (height_mm - size.1).abs() <= PAPER_TOLERANCE_MM
    };
    near(a4) || near(letter)
}

/// The whole-number scale of a 300 dpi sheet on a device of `dpi`: any multiple of 300 up to
/// 4800, from the resolution alone. Any other resolution is refused, never drawn at
/// `dpi / 300` by integer division (360 or 450 dpi would print the sheet at 83 % or 67 %
/// without a word).
fn whole_scale(dpi: i32) -> Option<i32> {
    (dpi > 0 && dpi % 300 == 0 && dpi <= 4800).then_some(dpi / 300)
}

/// How the sheet is drawn on a device page, or why it is not.
///
/// The page must be A4 (or Letter) in the sheet's orientation. The sheet is drawn whole-number
/// times larger. Real printers leave edges unprintable (an inkjet's bottom edge is often a
/// centimetre or more), so when the sheet's required area (its content and the SSCC's quiet
/// zones, 10 mm from the paper's edge as made) does not lie inside the printable area less a
/// 0.5 mm guard, the sheet is MOVED by the few millimetres it takes, and only when the area is
/// larger than the printable area itself drawn uniformly SMALLER (down to
/// [`MIN_FIT_PERMILLE`]); beyond that the sheet is refused before the job starts. The plan says
/// which it did (`DrawPlan::adjusted`), and a refusal carries the measured numbers.
pub fn sheet_draw_plan(raster: &SheetRaster, caps: DeviceCaps) -> Result<DrawPlan, Refusal> {
    let orientation = sheet_orientation(raster).map_err(|error| Refusal {
        error,
        diagnostic: format!(
            "reason=not_a4 sheet_dpi={} sheet_mm={}x{}",
            raster.dpi, raster.width_mm, raster.height_mm
        ),
    })?;
    let c = caps;
    let measured = format!(
        "dpi={}x{} page_dots={}x{} offset_dots={},{} printable_dots={}x{}",
        c.dpi_x,
        c.dpi_y,
        c.width,
        c.height,
        c.offset_x,
        c.offset_y,
        c.printable_width,
        c.printable_height
    );
    let refuse = |reason: &str, extra: String| Refusal {
        error: SheetError::GeometryMismatch,
        diagnostic: format!("reason={reason} {measured} {extra}")
            .trim_end()
            .to_owned(),
    };
    let Some(scale) = whole_scale(c.dpi_x) else {
        return Err(refuse("dpi_not_a_multiple_of_300", String::new()));
    };
    if c.dpi_y != c.dpi_x
        || c.width <= 0
        || c.height <= 0
        || c.offset_x < 0
        || c.offset_y < 0
        || c.printable_width <= 0
        || c.printable_height <= 0
        || i64::from(c.offset_x) + i64::from(c.printable_width) > i64::from(c.width)
        || i64::from(c.offset_y) + i64::from(c.printable_height) > i64::from(c.height)
    {
        return Err(refuse("device_caps_unusable", String::new()));
    }
    let mm = |px: i32| f64::from(px) * 25.4 / f64::from(c.dpi_x);
    let one = |value: f64| (value * 10.0).round() / 10.0;
    let paper = format!(
        "page_mm={}x{} printable_mm={}x{} offset_mm={},{}",
        one(mm(c.width)),
        one(mm(c.height)),
        one(mm(c.printable_width)),
        one(mm(c.printable_height)),
        one(mm(c.offset_x)),
        one(mm(c.offset_y))
    );
    if !paper_is_a4_or_letter(mm(c.width), mm(c.height), orientation) {
        return Err(refuse("paper_not_a4_or_letter", paper));
    }
    let [left, top, right, bottom] = raster.bounds.map(i64::from);
    // The page is exactly A4 (3508 dots at most) and the scale at most 16, so nothing here can
    // overflow; an empty required area, or one that leaves the sheet, is no sheet.
    if right <= left
        || bottom <= top
        || left < 0
        || top < 0
        || right > i64::from(raster.width)
        || bottom > i64::from(raster.height)
    {
        return Err(refuse("required_area_unusable", paper));
    }
    let guard = (0.5 * f64::from(c.dpi_x) / 25.4).ceil() as i64;
    let scale64 = i64::from(scale);
    let (inner_left, inner_top) = (i64::from(c.offset_x) + guard, i64::from(c.offset_y) + guard);
    let inner_right = i64::from(c.offset_x) + i64::from(c.printable_width) - guard;
    let inner_bottom = i64::from(c.offset_y) + i64::from(c.printable_height) - guard;
    let (available_width, available_height) = (inner_right - inner_left, inner_bottom - inner_top);
    let (needed_width, needed_height) = ((right - left) * scale64, (bottom - top) * scale64);
    let needs = format!(
        "needs_mm={}x{} guard_mm=0.5",
        one(mm(needed_width as i32)),
        one(mm(needed_height as i32))
    );
    if available_width <= 0 || available_height <= 0 {
        return Err(refuse("printable_too_small", format!("{paper} {needs}")));
    }
    // The part of its size the sheet is drawn at: whole when its required area fits.
    let fit = (available_width * 1000 / needed_width)
        .min(available_height * 1000 / needed_height)
        .min(1000) as u32;
    if fit < MIN_FIT_PERMILLE {
        return Err(refuse(
            "printable_too_small",
            format!("{paper} {needs} fit_permille={fit}"),
        ));
    }
    let fit64 = i64::from(fit);
    // The required area where the scaled sheet puts it (the sheet's corner at the paper's).
    let placed = |value: i64| value * scale64 * fit64 / 1000;
    let (placed_left, placed_top) = (placed(left), placed(top));
    let (placed_right, placed_bottom) = (placed(right), placed(bottom));
    // Moved the least that brings it inside: right or down when it starts in the unprintable
    // edge, left or up when it ends in the far one (it cannot do both: it is not wider).
    let shift = |low: i64, high: i64, inner_low: i64, inner_high: i64| {
        if low < inner_low {
            inner_low - low
        } else if high > inner_high {
            inner_high - high
        } else {
            0
        }
    };
    let shift_x = shift(placed_left, placed_right, inner_left, inner_right);
    let shift_y = shift(placed_top, placed_bottom, inner_top, inner_bottom);
    Ok(DrawPlan {
        scale,
        x: (shift_x - i64::from(c.offset_x)) as i32,
        y: (shift_y - i64::from(c.offset_y)) as i32,
        width: (i64::from(raster.width) * scale64 * fit64 / 1000) as i32,
        height: (i64::from(raster.height) * scale64 * fit64 / 1000) as i32,
        fit_permille: fit,
        shift_x: shift_x as i32,
        shift_y: shift_y as i32,
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

    /// `sheet_draw_plan` with only the kind of its refusal.
    fn plan(raster: &SheetRaster, caps: DeviceCaps) -> Result<DrawPlan, SheetError> {
        sheet_draw_plan(raster, caps).map_err(|refusal| refusal.error)
    }

    /// Where the sheet's required area really lands on the paper, in device dots from the
    /// paper's corner: the plan's own move and shrink applied to the sheet's bounds.
    fn landed(raster: &SheetRaster, caps: DeviceCaps, plan: &DrawPlan) -> [i64; 4] {
        let scale = i64::from(plan.scale) * i64::from(plan.fit_permille);
        let [l, t, r, b] = raster.bounds.map(|dot| i64::from(dot) * scale / 1000);
        let (dx, dy) = (
            i64::from(plan.x) + i64::from(caps.offset_x),
            i64::from(plan.y) + i64::from(caps.offset_y),
        );
        [l + dx, t + dy, r + dx, b + dy]
    }

    /// The printable area less the guard, in device dots from the paper's corner.
    fn inner(caps: DeviceCaps) -> [i64; 4] {
        let guard = (0.5 * f64::from(caps.dpi_x) / 25.4).ceil() as i64;
        [
            i64::from(caps.offset_x) + guard,
            i64::from(caps.offset_y) + guard,
            i64::from(caps.offset_x) + i64::from(caps.printable_width) - guard,
            i64::from(caps.offset_y) + i64::from(caps.printable_height) - guard,
        ]
    }

    /// The plan holds the required area inside the printable area less the guard.
    fn assert_inside(raster: &SheetRaster, caps: DeviceCaps, plan: &DrawPlan) {
        let [l, t, r, b] = landed(raster, caps, plan);
        let [il, it, ir, ib] = inner(caps);
        assert!(
            l >= il - 1 && t >= it - 1 && r <= ir + 1 && b <= ib + 1,
            "{:?} not inside {:?} ({plan:?})",
            [l, t, r, b],
            [il, it, ir, ib]
        );
    }

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
            plan(&portrait(), laser(Orientation::Portrait)),
            Ok(DrawPlan {
                scale: 2,
                x: -100,
                y: -100,
                width: 4960,
                height: 7016,
                fit_permille: 1000,
                shift_x: 0,
                shift_y: 0,
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
        assert!(plan(&landscape, laser(Orientation::Landscape)).is_ok());
        assert_eq!(
            plan(&landscape, laser(Orientation::Portrait)),
            Err(SheetError::GeometryMismatch)
        );
    }

    #[test]
    fn content_in_the_unprintable_edge_is_drawn_smaller_to_fit_and_a_hopeless_edge_is_refused() {
        // 2 mm margins: 24 sheet dots, 48 device dots, inside the 100 px edge. The required
        // area is wider than the printable area less the guard, so the sheet shrinks by the
        // difference (97.3 %) and is moved inside.
        let tight = SheetRaster {
            bounds: [24, 24, 2480 - 24, 3508 - 24],
            ..portrait()
        };
        let caps = laser(Orientation::Portrait);
        let drawn = plan(&tight, caps).unwrap();
        assert_eq!(drawn.fit_permille, 973);
        assert_inside(&tight, caps, &drawn);
        assert_eq!(drawn.adjusted(600).map(|a| a.percent), Some(98));
        // A printer that leaves 25 mm unprintable on every side would take the sheet below 90 %:
        // refused, with the numbers.
        let hopeless = DeviceCaps {
            offset_x: 600,
            offset_y: 600,
            printable_width: 4960 - 1200,
            printable_height: 7016 - 1200,
            ..caps
        };
        let refusal = sheet_draw_plan(&portrait(), hopeless).unwrap_err();
        assert_eq!(refusal.error, SheetError::GeometryMismatch);
        assert!(refusal.diagnostic.starts_with("reason=printable_too_small"));
        assert!(refusal.diagnostic.contains("page_mm=210x297"));
        assert!(refusal.diagnostic.contains("printable_mm=159.2x246.2"));
    }

    /// The numbers of an HP inkjet's driver page: 600 dpi A4 (4961 x 7016 dots), 3.3 mm
    /// unprintable at the sides and the top and 12.7 mm at the bottom.
    fn inkjet() -> DeviceCaps {
        DeviceCaps {
            dpi_x: 600,
            dpi_y: 600,
            width: 4961,
            height: 7016,
            offset_x: 78,
            offset_y: 78,
            printable_width: 4961 - 2 * 78,
            printable_height: 7016 - 78 - 300,
        }
    }

    #[test]
    fn a_sheet_with_ten_millimetre_margins_is_moved_up_on_an_inkjet_with_a_wide_bottom_edge() {
        // The sheet's content ends 10 mm from the paper's edge, 2.7 mm into the 12.7 mm
        // bottom edge the driver cannot print: it used to be refused («лист не помещается в
        // область печати»), and now moves up by the 3.2 mm it takes (2.7 mm and the guard).
        let caps = inkjet();
        let drawn = plan(&portrait(), caps).unwrap();
        assert_eq!(
            drawn,
            DrawPlan {
                scale: 2,
                x: -78,
                y: -78 - 76,
                width: 4960,
                height: 7016,
                fit_permille: 1000,
                shift_x: 0,
                shift_y: -76,
            }
        );
        assert_inside(&portrait(), caps, &drawn);
        assert_eq!(
            drawn.adjusted(600),
            Some(Adjusted {
                percent: 100,
                shift_x_mm: 0.0,
                shift_y_mm: -3.2,
            })
        );
        // The same inkjet with 6 mm hardware margins all round holds the 10 mm margins as made.
        let wide = DeviceCaps {
            offset_x: 142,
            offset_y: 142,
            printable_width: 4961 - 284,
            printable_height: 7016 - 284,
            ..caps
        };
        let drawn = plan(&portrait(), wide).unwrap();
        assert_eq!(
            (drawn.shift_x, drawn.shift_y, drawn.fit_permille),
            (0, 0, 1000)
        );
        assert_eq!(drawn.adjusted(600), None);
        // And a 3 mm margin printer needs no move at all.
        let near = DeviceCaps {
            offset_x: 71,
            offset_y: 71,
            printable_width: 4961 - 142,
            printable_height: 7016 - 142,
            ..caps
        };
        assert_eq!(plan(&portrait(), near).unwrap().adjusted(600), None);
    }

    #[test]
    fn the_refusal_names_what_the_driver_reported_in_millimetres() {
        let refusal = sheet_draw_plan(
            &portrait(),
            DeviceCaps {
                dpi_x: 360,
                dpi_y: 360,
                ..inkjet()
            },
        )
        .unwrap_err();
        assert!(refusal
            .diagnostic
            .starts_with("reason=dpi_not_a_multiple_of_300"));
        assert!(refusal.diagnostic.contains("dpi=360x360"));
        let a5 = DeviceCaps {
            width: 3500,
            height: 4961,
            printable_width: 3400,
            printable_height: 4800,
            ..inkjet()
        };
        let refusal = sheet_draw_plan(&portrait(), a5).unwrap_err();
        assert!(refusal
            .diagnostic
            .starts_with("reason=paper_not_a4_or_letter"));
        assert!(refusal.diagnostic.contains("page_mm=148.2x210"));
    }

    #[test]
    fn letter_paper_unequal_axes_and_odd_resolutions_are_refused() {
        // Letter paper (215.9 x 279.4 mm) is a page a sheet is drawn on, smaller (97.4 %); an A5
        // page is no paper for it.
        let letter = DeviceCaps {
            width: 5100,
            height: 6600,
            printable_width: 4900,
            printable_height: 6400,
            ..laser(Orientation::Portrait)
        };
        let drawn = plan(&portrait(), letter).unwrap();
        assert_eq!(drawn.fit_permille, 974);
        assert_inside(&portrait(), letter, &drawn);
        let a5 = DeviceCaps {
            width: 3508,
            height: 4960,
            printable_width: 3308,
            printable_height: 4760,
            ..laser(Orientation::Portrait)
        };
        assert_eq!(plan(&portrait(), a5), Err(SheetError::GeometryMismatch));
        let unequal = DeviceCaps {
            dpi_y: 300,
            ..laser(Orientation::Portrait)
        };
        assert_eq!(
            plan(&portrait(), unequal),
            Err(SheetError::GeometryMismatch)
        );
        let odd = DeviceCaps {
            dpi_x: 203,
            dpi_y: 203,
            ..laser(Orientation::Portrait)
        };
        assert_eq!(plan(&portrait(), odd), Err(SheetError::GeometryMismatch));
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
            let drawn = plan(&portrait(), device(dpi, 20, 30)).unwrap();
            assert_eq!(
                drawn,
                DrawPlan {
                    scale,
                    x: -20,
                    y: -30,
                    width: 2480 * scale,
                    height: 3508 * scale,
                    fit_permille: 1000,
                    shift_x: 0,
                    shift_y: 0,
                },
                "{dpi}"
            );
        }
        // Any multiple of 300 up to 4800 is a whole-number scale (an inkjet's 2400 or 4800 dpi).
        for (dpi, scale) in [(900, 3), (1800, 6), (2400, 8), (4800, 16)] {
            assert_eq!(
                plan(&portrait(), device(dpi, 0, 0)).map(|p| p.scale),
                Ok(scale),
                "{dpi}"
            );
        }
        // Resolutions that are no multiple of 300 (or past 4800) are refused: none is scaled
        // by integer division.
        for dpi in [150, 203, 299, 301, 360, 400, 450, 720, 1201, 1440, 5100] {
            assert_eq!(
                plan(&portrait(), device(dpi, 0, 0)),
                Err(SheetError::GeometryMismatch),
                "{dpi}"
            );
        }
    }

    #[test]
    fn the_origin_is_the_papers_corner_whatever_the_unprintable_edges_are() {
        let drawn = plan(&portrait(), device(300, 0, 0)).unwrap();
        assert_eq!((drawn.x, drawn.y), (0, 0));
        let drawn = plan(&portrait(), device(600, 100, 80)).unwrap();
        assert_eq!((drawn.x, drawn.y), (-100, -80));
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
            plan(&landscape, laser(Orientation::Landscape)),
            Ok(DrawPlan {
                scale: 2,
                x: -100,
                y: -100,
                width: 7016,
                height: 4960,
                fit_permille: 1000,
                shift_x: 0,
                shift_y: 0,
            })
        );
    }

    #[test]
    fn the_device_page_is_a4_within_a_millimetre_and_a_half_on_each_axis() {
        // 600 dpi: 210 mm is 4960.6 dots and 297 mm is 7015.7; a millimetre and a half (the
        // rounding of a driver's form) is 35.4 dots either way.
        for (width, height, ok) in [
            (4926, 7016, true),
            (4925, 7016, false),
            (4996, 7016, true),
            (4997, 7016, false),
            (4960, 6981, true),
            (4960, 6980, false),
            (4960, 7051, true),
            (4960, 7052, false),
        ] {
            let caps = DeviceCaps {
                width,
                height,
                printable_width: width - 200,
                printable_height: height - 200,
                ..laser(Orientation::Portrait)
            };
            assert_eq!(plan(&portrait(), caps).is_ok(), ok, "{width}x{height}");
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
                plan(&portrait(), caps),
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
        assert!(plan(&with_bounds([118, 118, 2480 - 118, 3508 - 118]), exact).is_ok());
    }

    #[test]
    fn the_required_area_lands_half_a_millimetre_inside_every_edge_of_the_printable_area() {
        // 600 dpi, 100 dot edges: the guard is ceil(0.5 mm) = 12 dots, so the area may start at
        // 112 dots (56 sheet dots) and end at 4848 / 6904: inside it, the sheet stays where it
        // was made; one dot past an edge, it moves the dot or two it takes.
        let caps = laser(Orientation::Portrait);
        let drawn = |bounds| plan(&with_bounds(bounds), caps).unwrap();
        let exact = drawn([56, 56, 2424, 3452]);
        assert_eq!(
            (exact.shift_x, exact.shift_y, exact.fit_permille),
            (0, 0, 1000)
        );
        let left = drawn([55, 56, 2423, 3452]);
        assert_eq!((left.shift_x, left.shift_y), (2, 0), "left");
        let top = drawn([56, 55, 2424, 3451]);
        assert_eq!((top.shift_x, top.shift_y), (0, 2), "top");
        let right = drawn([57, 56, 2425, 3452]);
        assert_eq!((right.shift_x, right.shift_y), (-2, 0), "right");
        let bottom = drawn([56, 57, 2424, 3453]);
        assert_eq!((bottom.shift_x, bottom.shift_y), (0, -2), "bottom");
        for bounds in [
            [55, 56, 2423, 3452],
            [57, 56, 2425, 3452],
            [56, 57, 2424, 3453],
        ] {
            let raster = with_bounds(bounds);
            assert_inside(&raster, caps, &drawn_of(&raster, caps));
        }
    }

    fn drawn_of(raster: &SheetRaster, caps: DeviceCaps) -> DrawPlan {
        plan(raster, caps).unwrap()
    }

    #[test]
    fn the_guard_follows_the_resolution() {
        // 300 dpi: ceil(5.9) = 6 dots; 1200 dpi: ceil(23.6) = 24 dots.
        let moves_from_left = |dpi: i32, edge: i32, l: i32| {
            let raster = with_bounds([l, l, 2480 - 60, 3508 - 60]);
            plan(&raster, device(dpi, edge, edge)).unwrap().shift_x
        };
        assert_eq!(moves_from_left(300, 20, 26), 0);
        assert_eq!(moves_from_left(300, 20, 25), 1);
        // 1200 dpi: the edge is 80 dots, a sheet dot is 4 device dots.
        assert_eq!(moves_from_left(1200, 80, 26), 0);
        assert_eq!(moves_from_left(1200, 80, 25), 4);
        // 600 dpi with an odd edge: the guard is 12 dots (11.8 rounded up), so the area
        // starts at 101 + 12 = 113 dots, i.e. at sheet dot 56.5: sheet dot 57 stays.
        assert_eq!(moves_from_left(600, 101, 57), 0);
        assert_eq!(moves_from_left(600, 101, 56), 1);
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
                plan(&with_bounds(bounds), caps),
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
        assert_eq!(plan(&label, nonsense), Err(SheetError::NotA4));
        let refusal = sheet_draw_plan(&label, nonsense).unwrap_err();
        assert!(refusal.diagnostic.starts_with("reason=not_a4 "));
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
