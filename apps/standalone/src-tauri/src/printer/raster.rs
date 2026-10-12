//! The `mono-raster-v1` page of driver printing (plan ДРВ), ported from the
//! cloud station's `printer_raster.rs` (#696): the webview's
//! `encodeMonoRaster` (`@markiro/domain`) writes it, this module reads it.
//! No OS calls: untrusted IPC bytes are checked before anything is allocated
//! for them, and every check runs on every OS.
//!
//! Layout (little-endian): magic `MKRMNO1\0`; dpi (203 or 300), width and
//! height in dots, row stride in bytes (`ceil(width / 8)`); width and height
//! in millimetres (`f64`, 10–300, the dots being `round(mm × dpi / 25.4)`);
//! the pixel length, a zero word, and the required bounds `[left, top,
//! right, bottom]` in dots; then the rows, top-down, MSB first, 1 = black. A
//! black dot outside the bounds or past the width refuses the page.

/// The largest page this module reads (the domain's `MONO_RASTER_MAX_BYTES`).
pub const MAX_BYTES: usize = 2 * 1024 * 1024;

/// A checked page; `pixels` borrows the caller's bytes.
#[derive(Debug)]
pub struct Raster<'a> {
    pub dpi: i32,
    pub width: i32,
    pub height: i32,
    pub width_mm: f64,
    pub height_mm: f64,
    pub stride: usize,
    pub bounds: [i32; 4],
    pub pixels: &'a [u8],
}

/// Reads a page, or refuses it whole.
#[allow(clippy::result_unit_err)]
pub fn decode(bytes: &[u8]) -> Result<Raster<'_>, ()> {
    if bytes.len() < 64 || bytes.len() > MAX_BYTES || &bytes[..8] != b"MKRMNO1\0" {
        return Err(());
    }
    let u = |i: usize| u32::from_le_bytes([bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]]);
    let f = |i: usize| {
        let mut word = [0u8; 8];
        word.copy_from_slice(&bytes[i..i + 8]);
        f64::from_le_bytes(word)
    };
    let dpi = u(8);
    let (w, h, stride) = (u(12), u(16), u(20));
    let (wm, hm) = (f(24), f(32));
    if ![203, 300].contains(&dpi)
        || ![wm, hm]
            .iter()
            .all(|n| n.is_finite() && (10.0..=300.0).contains(n))
        || w != (wm * dpi as f64 / 25.4).round() as u32
        || h != (hm * dpi as f64 / 25.4).round() as u32
        || stride != w.div_ceil(8)
        || u(44) != 0
    {
        return Err(());
    }
    let length = (stride as usize).checked_mul(h as usize).ok_or(())?;
    if length.checked_add(64) != Some(bytes.len()) || u(40) as usize != length {
        return Err(());
    }
    let b = [u(48), u(52), u(56), u(60)];
    if b[0] > b[2] || b[1] > b[3] || b[2] > w || b[3] > h {
        return Err(());
    }
    let pixels = &bytes[64..];
    for y in 0..h {
        for x in 0..stride * 8 {
            if pixels[(y * stride + x / 8) as usize] & (0x80 >> (x % 8)) != 0
                && (x >= w || x < b[0] || x >= b[2] || y < b[1] || y >= b[3])
            {
                return Err(());
            }
        }
    }
    Ok(Raster {
        dpi: dpi as i32,
        width: w as i32,
        height: h as i32,
        width_mm: wm,
        height_mm: hm,
        stride: stride as usize,
        bounds: b.map(|n| n as i32),
        pixels,
    })
}

/// What the driver's device context reports (`GetDeviceCaps`), in dots.
#[derive(Clone, Copy, Debug)]
pub struct Caps {
    pub dpi_x: i32,
    pub dpi_y: i32,
    pub width: i32,
    pub height: i32,
    pub offset_x: i32,
    pub offset_y: i32,
    pub printable_width: i32,
    pub printable_height: i32,
}

/// The driver prints the page 1:1: the same resolution on both axes, the
/// paper within one dot of the page, the printable origin inside the page, and
/// the page's required bounds (its barcodes' quiet zones) inside the printable
/// area.
#[allow(clippy::result_unit_err)]
pub fn check_geometry(page: &Raster<'_>, c: Caps) -> Result<(), ()> {
    let [l, t, r, b] = page.bounds;
    if ![c.width, c.height, c.printable_width, c.printable_height]
        .iter()
        .all(|n| (1..=10000).contains(n))
        || ![c.offset_x, c.offset_y]
            .iter()
            .all(|n| (0..=10000).contains(n))
    {
        return Err(());
    }
    // The blit is `min(page - origin, printable)` dots wide: the origin inside
    // the page keeps it positive (a negative width would mirror the page).
    if c.offset_x >= page.width
        || c.offset_y >= page.height
        || c.dpi_x != page.dpi
        || c.dpi_y != page.dpi
        || (c.width - page.width).abs() > 1
        || (c.height - page.height).abs() > 1
        || c.offset_x
            .checked_add(c.printable_width)
            .filter(|n| *n <= c.width + 1)
            .is_none()
        || c.offset_y
            .checked_add(c.printable_height)
            .filter(|n| *n <= c.height + 1)
            .is_none()
        || (r > l
            && b > t
            && (l < c.offset_x
                || t < c.offset_y
                || r > c.offset_x + c.printable_width
                || b > c.offset_y + c.printable_height))
    {
        return Err(());
    }
    Ok(())
}

/// The page's rows as a DIB wants them: DWORD-aligned, palette 0 = white,
/// 1 = black.
pub fn dib_pixels(page: &Raster<'_>) -> Vec<u8> {
    let stride = (page.width as usize).div_ceil(32) * 4;
    let mut data = vec![0; stride * page.height as usize];
    for y in 0..page.height as usize {
        data[y * stride..y * stride + page.stride]
            .copy_from_slice(&page.pixels[y * page.stride..(y + 1) * page.stride]);
    }
    data
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The shared vector: a 10 mm square at 203 dpi with one black dot at (1, 1).
    fn vector() -> Vec<u8> {
        let mut b = vec![0; 864];
        b[..8].copy_from_slice(b"MKRMNO1\0");
        for (i, n) in [
            (8, 203u32),
            (12, 80),
            (16, 80),
            (20, 10),
            (40, 800),
            (48, 1),
            (52, 1),
            (56, 2),
            (60, 2),
        ] {
            b[i..i + 4].copy_from_slice(&n.to_le_bytes());
        }
        b[24..32].copy_from_slice(&10f64.to_le_bytes());
        b[32..40].copy_from_slice(&10f64.to_le_bytes());
        b[74] = 0x40;
        b
    }

    #[test]
    fn the_domain_writes_the_vector_this_module_reads() {
        use base64::Engine;
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../../packages/domain/test/fixtures/mono-raster-v1.json"
        ))
        .unwrap();
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(fixture["base64"].as_str().unwrap())
            .unwrap();
        assert_eq!(bytes, vector());
        assert_eq!(decode(&bytes).unwrap().pixels[10], 0x40);
    }

    #[test]
    fn a_page_becomes_dword_aligned_dib_rows() {
        let bytes = vector();
        let page = decode(&bytes).unwrap();
        let dib = dib_pixels(&page);
        assert_eq!(dib.len(), 960);
        assert_eq!(dib[12], 0x40);
        assert_eq!(dib.iter().filter(|b| **b != 0).count(), 1);
    }

    #[test]
    fn a_malformed_page_is_refused_whole() {
        for len in [7, 63, 863, 865] {
            let mut b = vector();
            b.resize(len, 0);
            assert!(decode(&b).is_err(), "length {len}");
        }
        for offset in [8, 12, 20, 40, 44, 56] {
            let mut b = vector();
            b[offset..offset + 4].copy_from_slice(&u32::MAX.to_le_bytes());
            assert!(decode(&b).is_err(), "word at {offset}");
        }
        // A black dot outside the required bounds.
        let mut b = vector();
        b[64] = 0x80;
        assert!(decode(&b).is_err());
    }

    #[test]
    fn the_driver_must_hold_the_page_one_to_one() {
        let bytes = vector();
        let page = decode(&bytes).unwrap();
        let mut c = Caps {
            dpi_x: 203,
            dpi_y: 203,
            width: 80,
            height: 80,
            offset_x: 0,
            offset_y: 0,
            printable_width: 80,
            printable_height: 80,
        };
        assert!(check_geometry(&page, c).is_ok());
        // The printable area starts past the required bounds' left edge.
        c.offset_x = 2;
        c.printable_width = 78;
        assert!(check_geometry(&page, c).is_err());
        c.offset_x = 1;
        c.printable_width = 79;
        assert!(check_geometry(&page, c).is_ok());
        c.dpi_y = 300;
        assert!(check_geometry(&page, c).is_err());
    }

    /// Writes a page with arbitrary header words: `dots` are the black
    /// pixels, set by (x, y) in the pixel rows after the 64-byte header.
    fn build(
        dpi: u32,
        (wm, hm): (f64, f64),
        (w, h, stride): (u32, u32, u32),
        bounds: [u32; 4],
        dots: &[(u32, u32)],
    ) -> Vec<u8> {
        let length = (stride * h) as usize;
        let mut b = vec![0; 64 + length];
        b[..8].copy_from_slice(b"MKRMNO1\0");
        for (i, n) in [
            (8, dpi),
            (12, w),
            (16, h),
            (20, stride),
            (40, length as u32),
            (48, bounds[0]),
            (52, bounds[1]),
            (56, bounds[2]),
            (60, bounds[3]),
        ] {
            b[i..i + 4].copy_from_slice(&n.to_le_bytes());
        }
        b[24..32].copy_from_slice(&wm.to_le_bytes());
        b[32..40].copy_from_slice(&hm.to_le_bytes());
        for (x, y) in dots {
            b[64 + (y * stride + x / 8) as usize] |= 0x80 >> (x % 8);
        }
        b
    }

    fn mm_dots(mm: f64, dpi: u32) -> u32 {
        (mm * dpi as f64 / 25.4).round() as u32
    }

    /// A 10 x 10 mm page at 203 dpi (80 x 80 dots) with the given bounds and dots.
    fn square(bounds: [u32; 4], dots: &[(u32, u32)]) -> Vec<u8> {
        build(203, (10., 10.), (80, 80, 10), bounds, dots)
    }

    #[test]
    fn a_page_reads_back_every_header_field() {
        let bytes = vector();
        let page = decode(&bytes).unwrap();
        assert_eq!(
            (page.dpi, page.width, page.height, page.stride),
            (203, 80, 80, 10)
        );
        assert_eq!((page.width_mm, page.height_mm), (10., 10.));
        assert_eq!(page.bounds, [1, 1, 2, 2]);
        assert_eq!(page.pixels.len(), 800);
        let dense = build(300, (10., 10.), (118, 118, 15), [0, 0, 118, 118], &[]);
        assert_eq!(decode(&dense).unwrap().dpi, 300);
    }

    #[test]
    fn a_truncated_header_is_refused_without_reading_past_it() {
        let full = vector();
        for len in 0..64 {
            assert!(decode(&full[..len]).is_err(), "length {len}");
        }
    }

    #[test]
    fn the_magic_and_the_resolution_are_checked() {
        for at in [0, 7] {
            let mut b = vector();
            b[at] ^= 1;
            assert!(decode(&b).is_err(), "magic byte {at}");
        }
        // 204 dpi is self-consistent (10 mm is 80 dots) and still refused.
        assert_eq!(mm_dots(10., 204), 80);
        assert!(decode(&build(204, (10., 10.), (80, 80, 10), [0; 4], &[])).is_err());
        assert!(decode(&build(203, (10., 10.), (80, 80, 10), [0; 4], &[])).is_ok());
        assert!(decode(&build(300, (10., 10.), (118, 118, 15), [0; 4], &[])).is_ok());
    }

    #[test]
    fn the_size_in_millimetres_is_bounded_and_matches_the_dots() {
        let page = |wm: f64, hm: f64| {
            let (w, h) = (mm_dots(wm, 203), mm_dots(hm, 203));
            decode(&build(203, (wm, hm), (w, h, w.div_ceil(8)), [0; 4], &[])).is_ok()
        };
        assert!(page(10., 10.));
        assert!(page(300., 300.));
        assert!(!page(9.99, 10.));
        assert!(!page(10., 9.99));
        assert!(!page(300.01, 10.));
        assert!(!page(10., 300.01));
        // The dots must be the millimetres' dots, each axis on its own.
        assert!(decode(&build(203, (10., 10.), (81, 80, 11), [0; 4], &[])).is_err());
        assert!(decode(&build(203, (10., 10.), (80, 81, 10), [0; 4], &[])).is_err());
        // The stride must be ceil(width / 8).
        assert!(decode(&build(203, (10., 10.), (80, 80, 11), [0; 4], &[])).is_err());
        // A width that is not a multiple of eight has its own stride.
        assert_eq!(mm_dots(10.1, 203), 81);
        assert!(decode(&build(203, (10.1, 10.), (81, 80, 11), [0; 4], &[])).is_ok());
    }

    #[test]
    fn the_required_bounds_must_lie_inside_the_page() {
        assert!(decode(&square([0, 0, 80, 80], &[])).is_ok());
        assert!(decode(&square([2, 2, 2, 2], &[])).is_ok());
        assert!(
            decode(&square([3, 1, 2, 2], &[])).is_err(),
            "left past right"
        );
        assert!(
            decode(&square([1, 3, 2, 2], &[])).is_err(),
            "top past bottom"
        );
        assert!(
            decode(&square([1, 1, 81, 2], &[])).is_err(),
            "right past width"
        );
        assert!(
            decode(&square([1, 1, 2, 81], &[])).is_err(),
            "bottom past height"
        );
    }

    #[test]
    fn a_black_dot_outside_the_bounds_refuses_the_page() {
        let bounds = [1, 1, 3, 3];
        for (x, y) in [(1, 1), (2, 1), (1, 2), (2, 2)] {
            assert!(decode(&square(bounds, &[(x, y)])).is_ok(), "({x}, {y})");
        }
        for (x, y) in [(0, 1), (3, 1), (1, 0), (1, 3), (0, 0), (3, 3)] {
            assert!(decode(&square(bounds, &[(x, y)])).is_err(), "({x}, {y})");
        }
    }

    #[test]
    fn a_black_dot_in_the_row_padding_refuses_the_page() {
        let page = |dots: &[(u32, u32)]| {
            decode(&build(203, (10.1, 10.), (81, 80, 11), [0, 0, 81, 80], dots)).is_ok()
        };
        assert!(page(&[(80, 0)]));
        assert!(!page(&[(81, 0)]));
        assert!(!page(&[(87, 79)]));
    }

    #[test]
    fn a_dib_row_is_padded_to_a_double_word() {
        let bytes = build(
            203,
            (10.1, 10.),
            (81, 80, 11),
            [0, 0, 81, 80],
            &[(0, 1), (80, 1)],
        );
        let page = decode(&bytes).unwrap();
        let dib = dib_pixels(&page);
        assert_eq!(dib.len(), 12 * 80);
        assert_eq!((dib[12], dib[22], dib[23]), (0x80, 0x80, 0));
        assert_eq!(dib.iter().filter(|b| **b != 0).count(), 2);
    }

    #[test]
    fn the_geometry_is_held_to_the_dot() {
        let bytes = vector();
        let page = decode(&bytes).unwrap();
        let base = Caps {
            dpi_x: 203,
            dpi_y: 203,
            width: 80,
            height: 80,
            offset_x: 0,
            offset_y: 0,
            printable_width: 80,
            printable_height: 80,
        };
        let ok = |c: Caps| check_geometry(&page, c).is_ok();
        assert!(ok(base));
        assert!(!ok(Caps { dpi_x: 300, ..base }));
        assert!(!ok(Caps { dpi_y: 300, ..base }));
        // The paper may differ from the page by one dot, not two.
        for (width, height) in [(79, 80), (81, 80), (80, 79), (80, 81)] {
            assert!(
                ok(Caps {
                    width,
                    height,
                    ..base
                }),
                "{width} x {height}"
            );
        }
        for (width, height) in [(78, 80), (82, 80), (80, 78), (80, 82)] {
            assert!(
                !ok(Caps {
                    width,
                    height,
                    ..base
                }),
                "{width} x {height}"
            );
        }
        // The printable area must end within one dot past the paper.
        assert!(ok(Caps {
            printable_width: 81,
            ..base
        }));
        assert!(ok(Caps {
            printable_height: 81,
            ..base
        }));
        assert!(!ok(Caps {
            printable_width: 82,
            ..base
        }));
        assert!(!ok(Caps {
            printable_height: 82,
            ..base
        }));
        // ... and cover the required bounds [1, 1, 2, 2] on every side.
        let inside = Caps {
            offset_x: 1,
            offset_y: 1,
            printable_width: 79,
            printable_height: 79,
            ..base
        };
        assert!(ok(inside));
        assert!(!ok(Caps {
            offset_x: 2,
            ..inside
        }));
        assert!(!ok(Caps {
            offset_y: 2,
            ..inside
        }));
        assert!(!ok(Caps {
            printable_width: 1,
            ..base
        }));
        assert!(!ok(Caps {
            printable_height: 1,
            ..base
        }));
        assert!(ok(Caps {
            printable_width: 2,
            printable_height: 2,
            ..base
        }));
    }

    #[test]
    fn a_page_without_required_bounds_skips_the_area_check_but_not_the_ranges() {
        let bytes = square([0; 4], &[]);
        let page = decode(&bytes).unwrap();
        let base = Caps {
            dpi_x: 203,
            dpi_y: 203,
            width: 80,
            height: 80,
            offset_x: 5,
            offset_y: 5,
            printable_width: 70,
            printable_height: 70,
        };
        assert!(check_geometry(&page, base).is_ok());
        // Empty on one axis is empty: nothing is required of the area.
        for bounds in [[0, 0, 0, 80], [0, 0, 80, 0]] {
            let bytes = square(bounds, &[]);
            let page = decode(&bytes).unwrap();
            assert!(check_geometry(&page, base).is_ok(), "{bounds:?}");
        }
        for bad in [
            Caps {
                printable_width: 0,
                ..base
            },
            Caps {
                printable_height: 0,
                ..base
            },
            Caps {
                offset_x: -1,
                ..base
            },
            Caps {
                offset_y: -1,
                ..base
            },
        ] {
            assert!(check_geometry(&page, bad).is_err(), "{bad:?}");
        }
        assert!(check_geometry(
            &page,
            Caps {
                offset_x: 0,
                offset_y: 0,
                ..base
            }
        )
        .is_ok());
    }

    #[test]
    fn the_printable_origin_lies_inside_the_page_so_the_blit_has_a_size() {
        // No required bounds, one dot of printable area: only the origin keeps the
        // blit (page width - origin) positive.
        let bytes = square([0; 4], &[]);
        let page = decode(&bytes).unwrap();
        let base = Caps {
            dpi_x: 203,
            dpi_y: 203,
            width: 80,
            height: 80,
            offset_x: 79,
            offset_y: 79,
            printable_width: 1,
            printable_height: 1,
        };
        assert!(check_geometry(&page, base).is_ok());
        for bad in [
            Caps {
                offset_x: 80,
                ..base
            },
            Caps {
                offset_y: 80,
                ..base
            },
            Caps {
                offset_x: 81,
                width: 81,
                ..base
            },
        ] {
            assert!(check_geometry(&page, bad).is_err(), "{bad:?}");
        }
    }
}
