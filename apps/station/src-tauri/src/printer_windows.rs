//! Driver printing never sends a printer language through the RAW spooler.
use crate::printer_raster::{decode, Raster, MAX_BYTES};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Receipt {
    pub queue: String,
    pub job_id: u32,
    pub document_name: String,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Failure {
    pub code: &'static str,
    pub phase: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub receipt: Option<Receipt>,
}
impl Failure {
    fn before(code: &'static str) -> Self {
        Self {
            code,
            phase: "before_start",
            receipt: None,
        }
    }
}
#[derive(Serialize)]
#[serde(untagged)]
pub enum Outcome {
    Success { ok: bool, receipt: Receipt },
    Failed { ok: bool, error: Failure },
}
#[derive(Serialize)]
#[serde(untagged)]
pub enum Preflight {
    Success { ok: bool },
    Failed { ok: bool, error: Failure },
}
#[derive(Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum Observation {
    Present {
        #[serde(rename = "statusFlags")]
        status_flags: u32,
    },
    Absent,
    IdentityMismatch,
    Unavailable,
}
fn valid_name(s: &str) -> bool {
    !s.trim().is_empty() && s.len() <= 1024 && !s.contains('\0')
}
fn artifact(payload: &str) -> Result<Vec<u8>, Failure> {
    if payload.len() > 4 * MAX_BYTES.div_ceil(3) {
        return Err(Failure::before("invalid_artifact"));
    }
    let bytes = STANDARD
        .decode(payload)
        .map_err(|_| Failure::before("invalid_artifact"))?;
    decode(&bytes).map_err(|_| Failure::before("invalid_artifact"))?;
    Ok(bytes)
}
pub fn preflight(queue: String, payload_base64: String) -> Preflight {
    let result = (|| {
        let bytes = artifact(&payload_base64)?;
        let page = decode(&bytes).map_err(|_| Failure::before("invalid_artifact"))?;
        if !valid_name(&queue) {
            return Err(Failure::before("queue_unavailable"));
        }
        #[cfg(windows)]
        {
            native::Device::open(&queue, &page).map(|_| ())
        }
        #[cfg(not(windows))]
        {
            let _ = page;
            Err(Failure::before("unsupported_platform"))
        }
    })();
    match result {
        Ok(()) => Preflight::Success { ok: true },
        Err(error) => Preflight::Failed { ok: false, error },
    }
}
pub fn print(queue: String, payload_base64: String, document_name: String) -> Outcome {
    let result = (|| {
        let bytes = artifact(&payload_base64)?;
        let page = decode(&bytes).map_err(|_| Failure::before("invalid_artifact"))?;
        if !valid_name(&queue) {
            return Err(Failure::before("queue_unavailable"));
        }
        if !document_name
            .strip_prefix("Markiro:")
            .is_some_and(|s| uuid::Uuid::parse_str(s).is_ok())
        {
            return Err(Failure::before("invalid_artifact"));
        }
        #[cfg(windows)]
        {
            let mut device = native::Device::open(&queue, &page)?;
            submit(&mut device, &page, &queue, &document_name)
        }
        #[cfg(not(windows))]
        {
            let _ = page;
            Err(Failure::before("unsupported_platform"))
        }
    })();
    match result {
        Ok(receipt) => Outcome::Success { ok: true, receipt },
        Err(error) => Outcome::Failed { ok: false, error },
    }
}
pub fn observe(receipt: Receipt) -> Observation {
    if !valid_name(&receipt.queue) || !valid_name(&receipt.document_name) || receipt.job_id == 0 {
        return Observation::Unavailable;
    }
    #[cfg(windows)]
    {
        native::observe(&receipt)
    }
    #[cfg(not(windows))]
    {
        Observation::Unavailable
    }
}
#[cfg_attr(not(windows), allow(dead_code))]
trait WindowsPrintApi {
    fn begin(&mut self, name: &str) -> Result<u32, ()>;
    fn page(&mut self) -> Result<(), ()>;
    fn draw(&mut self, page: &Raster<'_>) -> Result<(), ()>;
    fn end_page(&mut self) -> Result<(), ()>;
    fn end(&mut self) -> Result<(), ()>;
    fn abort(&mut self);
}
#[cfg_attr(not(windows), allow(dead_code))]
fn submit(
    api: &mut impl WindowsPrintApi,
    page: &Raster<'_>,
    queue: &str,
    name: &str,
) -> Result<Receipt, Failure> {
    // A StartDoc error is ambiguous too: an RPC response can be lost after acceptance.
    let job_id = api.begin(name).map_err(|_| Failure {
        code: "driver_failure",
        phase: "delivery_unknown",
        receipt: None,
    })?;
    let receipt = Receipt {
        queue: queue.into(),
        job_id,
        document_name: name.into(),
    };
    if api
        .page()
        .and_then(|_| api.draw(page))
        .and_then(|_| api.end_page())
        .and_then(|_| api.end())
        .is_err()
    {
        api.abort();
        return Err(Failure {
            code: "driver_failure",
            phase: "delivery_unknown",
            receipt: Some(receipt),
        });
    }
    Ok(receipt)
}
#[cfg(windows)]
mod native {
    use super::*;
    use crate::printer_raster::{check_geometry, dib_pixels, Caps};
    use std::{
        mem::size_of,
        ptr::{null, null_mut},
    };
    use windows_sys::Win32::{
        Graphics::{Gdi::*, Printing::*},
        Storage::Xps::*,
    };
    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(Some(0)).collect()
    }
    struct Queue(PRINTER_HANDLE);
    impl Drop for Queue {
        fn drop(&mut self) {
            unsafe {
                ClosePrinter(self.0);
            }
        }
    }
    fn queue(name: &str) -> Result<Queue, Failure> {
        let mut h = PRINTER_HANDLE::default();
        if unsafe { OpenPrinterW(wide(name).as_ptr(), &mut h, null_mut()) } == 0 {
            return Err(Failure::before("queue_unavailable"));
        }
        Ok(Queue(h))
    }
    pub(super) struct Device {
        dc: HDC,
        caps: Caps,
    }
    impl Drop for Device {
        fn drop(&mut self) {
            unsafe {
                DeleteDC(self.dc);
            }
        }
    }
    impl Device {
        pub fn open(name: &str, p: &Raster<'_>) -> Result<Self, Failure> {
            unsafe {
                let q = queue(name)?;
                let name = wide(name);
                let needed =
                    DocumentPropertiesW(null_mut(), q.0, name.as_ptr(), null_mut(), null(), 0);
                if needed < size_of::<DEVMODEW>() as i32 || needed > 1024 * 1024 {
                    return Err(Failure::before("driver_failure"));
                }
                let mut buffer = vec![0u64; (needed as usize).div_ceil(8)];
                let dm = buffer.as_mut_ptr().cast::<DEVMODEW>();
                if DocumentPropertiesW(null_mut(), q.0, name.as_ptr(), dm, null(), DM_OUT_BUFFER)
                    != 1
                {
                    return Err(Failure::before("driver_failure"));
                }
                if ((*dm).dmSize as usize) < size_of::<DEVMODEW>()
                    || (*dm).dmSize as usize + (*dm).dmDriverExtra as usize > needed as usize
                {
                    return Err(Failure::before("driver_failure"));
                }
                (*dm).dmFields = ((*dm).dmFields & !DM_FORMNAME)
                    | DM_ORIENTATION
                    | DM_PAPERSIZE
                    | DM_PAPERWIDTH
                    | DM_PAPERLENGTH
                    | DM_COPIES
                    | DM_PRINTQUALITY
                    | DM_YRESOLUTION
                    | DM_SCALE;
                let v = &mut (*dm).Anonymous1.Anonymous1;
                v.dmOrientation = DMORIENT_PORTRAIT as i16;
                v.dmPaperSize = DMPAPER_USER as i16;
                v.dmPaperWidth = (p.width_mm * 10.).round() as i16;
                v.dmPaperLength = (p.height_mm * 10.).round() as i16;
                v.dmCopies = 1;
                v.dmScale = 100;
                v.dmPrintQuality = p.dpi as i16;
                (*dm).dmYResolution = p.dpi as i16;
                // Separate output buffer preserves the complete driver-private tail.
                let mut output = buffer.clone();
                let out = output.as_mut_ptr().cast::<DEVMODEW>();
                if DocumentPropertiesW(
                    null_mut(),
                    q.0,
                    name.as_ptr(),
                    out,
                    dm,
                    DM_IN_BUFFER | DM_OUT_BUFFER,
                ) != 1
                {
                    return Err(Failure::before("driver_failure"));
                }
                let v = (*out).Anonymous1.Anonymous1;
                if v.dmOrientation != DMORIENT_PORTRAIT as i16
                    || v.dmCopies != 1
                    || v.dmScale != 100
                {
                    return Err(Failure::before("geometry_mismatch"));
                }
                let dc = CreateDCW(wide("WINSPOOL").as_ptr(), name.as_ptr(), null(), out);
                if dc.is_null() {
                    return Err(Failure::before("driver_failure"));
                }
                let cap = |i| GetDeviceCaps(dc, i as i32);
                let caps = Caps {
                    dpi_x: cap(LOGPIXELSX),
                    dpi_y: cap(LOGPIXELSY),
                    width: cap(PHYSICALWIDTH),
                    height: cap(PHYSICALHEIGHT),
                    offset_x: cap(PHYSICALOFFSETX),
                    offset_y: cap(PHYSICALOFFSETY),
                    printable_width: cap(HORZRES),
                    printable_height: cap(VERTRES),
                };
                let device = Self { dc, caps };
                check_geometry(p, caps).map_err(|_| Failure::before("geometry_mismatch"))?;
                Ok(device)
            }
        }
    }
    impl WindowsPrintApi for Device {
        fn begin(&mut self, name: &str) -> Result<u32, ()> {
            let name = wide(name);
            let info = DOCINFOW {
                cbSize: size_of::<DOCINFOW>() as i32,
                lpszDocName: name.as_ptr(),
                lpszOutput: null(),
                lpszDatatype: null(),
                fwType: 0,
            };
            let id = unsafe { StartDocW(self.dc, &info) };
            if id > 0 {
                Ok(id as u32)
            } else {
                Err(())
            }
        }
        fn page(&mut self) -> Result<(), ()> {
            if unsafe { StartPage(self.dc) } > 0 {
                Ok(())
            } else {
                Err(())
            }
        }
        fn draw(&mut self, p: &Raster<'_>) -> Result<(), ()> {
            #[repr(C)]
            struct Info {
                header: BITMAPINFOHEADER,
                colors: [RGBQUAD; 2],
            }
            let info = Info {
                header: BITMAPINFOHEADER {
                    biSize: size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: p.width,
                    biHeight: -p.height,
                    biPlanes: 1,
                    biBitCount: 1,
                    biCompression: BI_RGB,
                    biClrUsed: 2,
                    ..Default::default()
                },
                colors: [
                    RGBQUAD {
                        rgbBlue: 255,
                        rgbGreen: 255,
                        rgbRed: 255,
                        rgbReserved: 0,
                    },
                    RGBQUAD::default(),
                ],
            };
            let data = dib_pixels(p);
            let c = self.caps;
            let w = (p.width - c.offset_x).min(c.printable_width);
            let h = (p.height - c.offset_y).min(c.printable_height);
            let drawn = unsafe {
                StretchDIBits(
                    self.dc,
                    0,
                    0,
                    w,
                    h,
                    c.offset_x,
                    c.offset_y,
                    w,
                    h,
                    data.as_ptr().cast(),
                    (&info as *const Info).cast(),
                    DIB_RGB_COLORS,
                    SRCCOPY,
                )
            };
            if drawn == h {
                Ok(())
            } else {
                Err(())
            }
        }
        fn end_page(&mut self) -> Result<(), ()> {
            if unsafe { EndPage(self.dc) } > 0 {
                Ok(())
            } else {
                Err(())
            }
        }
        fn end(&mut self) -> Result<(), ()> {
            if unsafe { EndDoc(self.dc) } > 0 {
                Ok(())
            } else {
                Err(())
            }
        }
        fn abort(&mut self) {
            unsafe {
                AbortDoc(self.dc);
            }
        }
    }
    pub fn observe(r: &Receipt) -> Observation {
        unsafe {
            let Ok(q) = queue(&r.queue) else {
                return Observation::Unavailable;
            };
            let mut needed = 0;
            let first = GetJobW(q.0, r.job_id, 1, null_mut(), 0, &mut needed);
            if first == 0 {
                let code = std::io::Error::last_os_error().raw_os_error();
                if matches!(code, Some(87) | Some(259)) {
                    return Observation::Absent;
                }
                if code != Some(122) {
                    return Observation::Unavailable;
                }
            }
            if needed < size_of::<JOB_INFO_1W>() as u32 || needed > 1024 * 1024 {
                return Observation::Unavailable;
            }
            let mut buffer = vec![0u64; (needed as usize).div_ceil(8)];
            let length = needed;
            if GetJobW(
                q.0,
                r.job_id,
                1,
                buffer.as_mut_ptr().cast(),
                length,
                &mut needed,
            ) == 0
            {
                return Observation::Unavailable;
            }
            let job = &*buffer.as_ptr().cast::<JOB_INFO_1W>();
            let start = job.pDocument as usize;
            let low = buffer.as_ptr() as usize;
            let high = low + length as usize;
            if start < low || start >= high || start % 2 != 0 {
                return Observation::Unavailable;
            }
            let chars = std::slice::from_raw_parts(job.pDocument, (high - start) / 2);
            let Some(end) = chars.iter().position(|c| *c == 0) else {
                return Observation::Unavailable;
            };
            if String::from_utf16_lossy(&chars[..end]) != r.document_name {
                return Observation::IdentityMismatch;
            }
            Observation::Present {
                status_flags: job.Status,
            }
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[derive(Default)]
    struct Fake {
        calls: Vec<&'static str>,
        fail: Option<&'static str>,
    }
    impl Fake {
        fn call(&mut self, n: &'static str) -> Result<(), ()> {
            self.calls.push(n);
            if self.fail == Some(n) {
                Err(())
            } else {
                Ok(())
            }
        }
    }
    impl WindowsPrintApi for Fake {
        fn begin(&mut self, _: &str) -> Result<u32, ()> {
            self.call("begin").map(|_| 42)
        }
        fn page(&mut self) -> Result<(), ()> {
            self.call("page")
        }
        fn draw(&mut self, _: &Raster<'_>) -> Result<(), ()> {
            self.call("draw")
        }
        fn end_page(&mut self) -> Result<(), ()> {
            self.call("end_page")
        }
        fn end(&mut self) -> Result<(), ()> {
            self.call("end")
        }
        fn abort(&mut self) {
            self.calls.push("abort");
        }
    }
    #[test]
    fn failures_after_begin_keep_identity_and_never_retry() {
        let p = Raster {
            dpi: 203,
            width: 80,
            height: 80,
            width_mm: 10.,
            height_mm: 10.,
            stride: 10,
            bounds: [0; 4],
            pixels: &[],
        };
        for step in ["page", "draw", "end_page", "end"] {
            let mut f = Fake {
                fail: Some(step),
                ..Default::default()
            };
            let e = submit(&mut f, &p, "Queue", "Markiro:test").unwrap_err();
            assert_eq!(e.phase, "delivery_unknown");
            assert_eq!(e.receipt.unwrap().job_id, 42);
            assert_eq!(f.calls.last(), Some(&"abort"));
            assert_eq!(f.calls.iter().filter(|s| **s == "begin").count(), 1);
        }
    }
    #[test]
    fn bounds_before_base64_decode() {
        assert!(artifact(&"A".repeat(4 * MAX_BYTES.div_ceil(3) + 1)).is_err());
        assert!(artifact("AAAA").is_err());
        assert!(!valid_name("a\0b"));
    }
}
