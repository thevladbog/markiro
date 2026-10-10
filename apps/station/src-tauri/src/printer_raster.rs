//! Portable page decoder. No OS calls; untrusted IPC bytes are checked before allocation.
pub const MAX_BYTES: usize = 2 * 1024 * 1024;
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
pub fn decode(bytes: &[u8]) -> Result<Raster<'_>, ()> {
    if bytes.len() < 64 || bytes.len() > MAX_BYTES || &bytes[..8] != b"MKRMNO1\0" {
        return Err(());
    }
    let u = |i| u32::from_le_bytes(bytes[i..i + 4].try_into().unwrap());
    let f = |i| f64::from_le_bytes(bytes[i..i + 8].try_into().unwrap());
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
    if c.dpi_x != page.dpi
        || c.dpi_y != page.dpi
        || (c.width - page.width).abs() > 1
        || (c.height - page.height).abs() > 1
        || c.offset_x < 0
        || c.offset_y < 0
        || c.printable_width <= 0
        || c.printable_height <= 0
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
/// DIB rows require DWORD alignment. Palette retains 0=white, 1=black.
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
    fn shared_wire_vector() {
        use base64::Engine;
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../packages/domain/test/fixtures/mono-raster-v1.json"
        ))
        .unwrap();
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(fixture["base64"].as_str().unwrap())
            .unwrap();
        assert_eq!(bytes, vector());
        assert_eq!(decode(&bytes).unwrap().pixels[10], 64);
    }
    #[test]
    fn independent_page_and_dib() {
        let bytes = vector();
        let p = decode(&bytes).unwrap();
        assert_eq!(p.pixels[10], 0x40);
        let dib = dib_pixels(&p);
        assert_eq!(dib.len(), 960);
        assert_eq!(dib[12], 0x40);
        assert_eq!(dib.iter().filter(|b| **b != 0).count(), 1);
    }
    #[test]
    fn malformed_pages() {
        for len in [7, 63, 863, 865] {
            let mut b = vector();
            b.resize(len, 0);
            assert!(decode(&b).is_err());
        }
        for offset in [8, 12, 20, 40, 44, 56] {
            let mut b = vector();
            b[offset..offset + 4].copy_from_slice(&u32::MAX.to_le_bytes());
            assert!(decode(&b).is_err());
        }
    }
    #[test]
    fn geometry_protects_quiet_zone() {
        let bytes = vector();
        let p = decode(&bytes).unwrap();
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
        assert!(check_geometry(&p, c).is_ok());
        c.offset_x = 2;
        c.printable_width = 78;
        assert!(check_geometry(&p, c).is_err());
        c.offset_x = 1;
        c.printable_width = 79;
        assert!(check_geometry(&p, c).is_ok());
        c.dpi_y = 300;
        assert!(check_geometry(&p, c).is_err());
    }
}
