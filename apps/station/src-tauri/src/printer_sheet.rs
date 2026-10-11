//! A4 geometry is taken from the configured driver DC, never fitted to paper.
use crate::printer_raster::{Caps, Raster};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Orientation {
    Portrait,
    Landscape,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WindowsPaperMode {
    A4Sheet,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct WindowsPageOptions {
    pub mode: WindowsPaperMode,
    pub orientation: Orientation,
}
impl WindowsPageOptions {
    pub fn a4(orientation: Orientation) -> Self {
        Self {
            mode: WindowsPaperMode::A4Sheet,
            orientation,
        }
    }
    pub fn dimensions(self) -> (f64, f64) {
        match self.orientation {
            Orientation::Portrait => (210., 297.),
            Orientation::Landscape => (297., 210.),
        }
    }
}
#[derive(Debug, Serialize)]
pub struct Bounds {
    pub left: f64,
    pub top: f64,
    pub right: f64,
    pub bottom: f64,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowsPageGeometry {
    pub width_mm: f64,
    pub height_mm: f64,
    pub printable_bounds_mm: Bounds,
    pub guard_mm: f64,
    pub device_dpi_x: i32,
    pub device_dpi_y: i32,
    pub fingerprint: String,
}
#[derive(Debug)]
pub struct DrawPlan {
    pub scale: i32,
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}
pub fn sheet_geometry(
    queue: &str,
    options: WindowsPageOptions,
    c: Caps,
) -> Result<WindowsPageGeometry, ()> {
    if queue.trim().is_empty()
        || queue.len() > 1024
        || queue.contains('\0')
        || !matches!(c.dpi_x, 300 | 600 | 1200)
        || c.dpi_y != c.dpi_x
        || c.width <= 0
        || c.height <= 0
        || c.width > 16384
        || c.height > 16384
        || c.offset_x < 0
        || c.offset_y < 0
        || c.printable_width <= 0
        || c.printable_height <= 0
        || i64::from(c.offset_x) + i64::from(c.printable_width) > i64::from(c.width)
        || i64::from(c.offset_y) + i64::from(c.printable_height) > i64::from(c.height)
    {
        return Err(());
    }
    let mm = |px: i32| f64::from(px) * 25.4 / f64::from(c.dpi_x);
    let (width, height) = options.dimensions();
    if (mm(c.width) - width).abs() > 0.5 || (mm(c.height) - height).abs() > 0.5 {
        return Err(());
    }
    // Opaque, versioned identity includes queue and every effective integer cap.
    let fingerprint = format!(
        "a4-v1:{}:{:?}:{}:{}:{}:{}:{}:{}:{}:{}",
        STANDARD.encode(queue),
        options.orientation,
        c.dpi_x,
        c.dpi_y,
        c.width,
        c.height,
        c.offset_x,
        c.offset_y,
        c.printable_width,
        c.printable_height
    );
    Ok(WindowsPageGeometry {
        width_mm: width,
        height_mm: height,
        printable_bounds_mm: Bounds {
            left: mm(c.offset_x),
            top: mm(c.offset_y),
            right: mm(c.offset_x + c.printable_width).min(width),
            bottom: mm(c.offset_y + c.printable_height).min(height),
        },
        guard_mm: 0.5,
        device_dpi_x: c.dpi_x,
        device_dpi_y: c.dpi_y,
        fingerprint,
    })
}
pub fn sheet_draw_plan(
    p: &Raster<'_>,
    queue: &str,
    options: WindowsPageOptions,
    c: Caps,
    expected: &str,
) -> Result<DrawPlan, ()> {
    let geometry = sheet_geometry(queue, options, c)?;
    let (w, h) = options.dimensions();
    if geometry.fingerprint != expected
        || p.dpi != 300
        || (p.width_mm - w).abs() > 0.01
        || (p.height_mm - h).abs() > 0.01
        || p.width != (w * 300. / 25.4).round() as i32
        || p.height != (h * 300. / 25.4).round() as i32
    {
        return Err(());
    }
    let scale = c.dpi_x / 300;
    let guard = (0.5 * f64::from(c.dpi_x) / 25.4).ceil() as i64;
    let b = p.bounds.map(|px| i64::from(px) * i64::from(scale));
    if b[0] < i64::from(c.offset_x) + guard
        || b[1] < i64::from(c.offset_y) + guard
        || b[2] > i64::from(c.offset_x + c.printable_width) - guard
        || b[3] > i64::from(c.offset_y + c.printable_height) - guard
    {
        return Err(());
    }
    Ok(DrawPlan {
        scale,
        x: -c.offset_x,
        y: -c.offset_y,
        width: p.width * scale,
        height: p.height * scale,
    })
}
