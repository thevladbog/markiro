//! The same source files as the Tauri shell. No fake Windows API declarations.
#[path = "../../apps/station/src-tauri/src/printer_raster.rs"]
pub mod printer_raster;
#[path = "../../apps/station/src-tauri/src/printer_sheet.rs"]
pub mod printer_sheet;
#[path = "../../apps/station/src-tauri/src/printer_windows.rs"]
pub mod printer_windows;
#[cfg(test)]
mod sheet_geometry;
