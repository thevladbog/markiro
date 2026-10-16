//! What the host accepts as an office user's photo (plan АВА). The host
//! decodes nothing: it reads the type from the first bytes, never from a
//! word of the client, and the sides from the picture's own header, so a
//! decompression bomb (a small file that unpacks into gigabytes) is refused
//! before anything could unpack it. The office crops the picture to a square
//! and the host holds it to that.
//!
//! Refused here: a type that is not JPEG, PNG or WebP (an SVG, which is
//! code, included), an animated PNG or WebP, a JPEG that is not baseline or
//! progressive Huffman with one or three 8-bit components (what every
//! webview draws), a side outside 128..=4096 dots, a picture that is not
//! square, and one whose header is cut or contradicts itself.

use axum::http::StatusCode;
use markiro_proto::avatar::{MAX_BYTES, MAX_SIDE, MIN_SIDE};
use markiro_proto::codes;

use crate::error::ApiError;
use crate::validate::{png_sides, webp_sides};

/// The base64 of [`MAX_BYTES`]: 4 × ceil(2 097 152 / 3).
pub const MAX_BASE64: usize = 2_796_204;

/// The request body of a picture of [`MAX_BYTES`] with its JSON around it;
/// the router's default limit (2 MiB) is below the base64 of such a picture,
/// so the route has this limit of its own (`server.rs`). A body above it
/// never reaches the handler.
pub const MAX_BODY_BYTES: usize = MAX_BASE64 + 1024;

/// What the host read from a picture.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Picture {
    pub media_type: &'static str,
    pub width: u32,
    pub height: u32,
}

fn refuse(status: StatusCode, code: &str, message: &str) -> ApiError {
    ApiError::new(status, code, message)
}

fn unsupported(message: &str) -> ApiError {
    refuse(
        StatusCode::UNSUPPORTED_MEDIA_TYPE,
        codes::AVATAR_UNSUPPORTED_TYPE,
        message,
    )
}

fn corrupt() -> ApiError {
    refuse(
        StatusCode::UNPROCESSABLE_ENTITY,
        codes::AVATAR_CORRUPT,
        "the picture's header is cut or inconsistent",
    )
}

/// The picture inside the request's `dataBase64`: its bytes and what the
/// host read of them.
pub fn from_base64(data_base64: &str) -> Result<(Vec<u8>, Picture), ApiError> {
    use base64::{engine::general_purpose::STANDARD, Engine};
    // Before decoding, so an oversized body costs no allocation.
    if data_base64.len() > MAX_BASE64 {
        return Err(too_large());
    }
    let bytes = STANDARD
        .decode(data_base64)
        .map_err(|_| ApiError::validation("dataBase64", "standard base64 is required"))?;
    let picture = inspect(&bytes)?;
    Ok((bytes, picture))
}

pub fn too_large() -> ApiError {
    refuse(
        StatusCode::PAYLOAD_TOO_LARGE,
        codes::AVATAR_TOO_LARGE,
        "a photo is at most 2 MiB",
    )
}

/// Reads the type and the sides of `bytes` and holds them to the limits.
pub fn inspect(bytes: &[u8]) -> Result<Picture, ApiError> {
    if bytes.len() > MAX_BYTES {
        return Err(too_large());
    }
    let (media_type, (width, height)) = if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        ("image/jpeg", jpeg_sides(bytes)?)
    } else if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) {
        ("image/png", png_header(bytes)?)
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        ("image/webp", webp_header(bytes)?)
    } else {
        return Err(unsupported("a JPEG, PNG or WebP picture is required"));
    };
    if width == 0 || height == 0 {
        return Err(corrupt());
    }
    if width < MIN_SIDE || height < MIN_SIDE {
        return Err(refuse(
            StatusCode::UNPROCESSABLE_ENTITY,
            codes::AVATAR_TOO_SMALL,
            "a photo is at least 128 × 128 dots",
        ));
    }
    if width > MAX_SIDE || height > MAX_SIDE {
        return Err(refuse(
            StatusCode::UNPROCESSABLE_ENTITY,
            codes::AVATAR_DIMENSIONS_TOO_LARGE,
            "a photo is at most 4096 × 4096 dots",
        ));
    }
    if width != height {
        return Err(refuse(
            StatusCode::UNPROCESSABLE_ENTITY,
            codes::AVATAR_NOT_SQUARE,
            "a photo is square: the office crops it before it uploads",
        ));
    }
    Ok(Picture {
        media_type,
        width,
        height,
    })
}

/// The sides of the first start-of-frame segment of a JPEG. The markers are
/// walked by their lengths, each inside the bytes, and the walk ends at the
/// frame, the scan or the end of the data.
fn jpeg_sides(bytes: &[u8]) -> Result<(u32, u32), ApiError> {
    let mut at = 2;
    loop {
        // Fill bytes (any number of 0xFF) precede a marker.
        if *bytes.get(at).ok_or_else(corrupt)? != 0xFF {
            return Err(corrupt());
        }
        while bytes.get(at) == Some(&0xFF) {
            at += 1;
        }
        let marker = *bytes.get(at).ok_or_else(corrupt)?;
        at += 1;
        match marker {
            // Stand-alone markers have no length: a second SOI, TEM, RSTn.
            0x00 | 0x01 | 0xD0..=0xD8 => continue,
            // The end of the image or the scan before any frame.
            0xD9 | 0xDA => return Err(corrupt()),
            _ => {}
        }
        let length = bytes
            .get(at..at + 2)
            .map(|pair| usize::from(u16::from_be_bytes([pair[0], pair[1]])))
            .ok_or_else(corrupt)?;
        if length < 2 || at + length > bytes.len() {
            return Err(corrupt());
        }
        let segment = &bytes[at + 2..at + length];
        match marker {
            // Baseline, extended sequential and progressive, all Huffman.
            0xC0..=0xC2 => {
                if segment.len() < 6 {
                    return Err(corrupt());
                }
                let (precision, components) = (segment[0], segment[5]);
                if precision != 8 || !matches!(components, 1 | 3) {
                    return Err(unsupported("an 8-bit grey or colour JPEG is required"));
                }
                if segment.len() < 6 + 3 * usize::from(components) {
                    return Err(corrupt());
                }
                let height = u32::from(u16::from_be_bytes([segment[1], segment[2]]));
                let width = u32::from(u16::from_be_bytes([segment[3], segment[4]]));
                return Ok((width, height));
            }
            // Lossless, differential and arithmetic frames; not DHT (C4),
            // JPG (C8) nor DAC (CC), which are tables.
            0xC3 | 0xC5..=0xC7 | 0xC9..=0xCB | 0xCD..=0xCF => {
                return Err(unsupported("a baseline or progressive JPEG is required"));
            }
            _ => at += length,
        }
    }
}

/// The sides of a PNG whose first chunk is a well-formed IHDR, and whose
/// chunks up to the first IDAT carry no animation control (`acTL`).
fn png_header(bytes: &[u8]) -> Result<(u32, u32), ApiError> {
    let sides = png_sides(bytes).ok_or_else(corrupt)?;
    // The chunks after the signature, each inside the bytes.
    let mut at = 8;
    loop {
        let head = bytes.get(at..at + 8).ok_or_else(corrupt)?;
        let length = usize::try_from(u32::from_be_bytes([head[0], head[1], head[2], head[3]]))
            .map_err(|_| corrupt())?;
        let kind = &head[4..8];
        match kind {
            b"acTL" | b"fcTL" | b"fdAT" => {
                return Err(unsupported("an animated PNG is not a photo"));
            }
            b"IDAT" => return Ok(sides),
            b"IEND" => return Err(corrupt()),
            _ => {}
        }
        // The data and the checksum that follow, inside the bytes.
        at = length
            .checked_add(12)
            .and_then(|step| at.checked_add(step))
            .filter(|end| *end <= bytes.len())
            .ok_or_else(corrupt)?;
    }
}

/// The sides of a WebP, whose RIFF length fits the bytes and which is not
/// animated (the extended header's flag, or an animation chunk).
fn webp_header(bytes: &[u8]) -> Result<(u32, u32), ApiError> {
    let riff = usize::try_from(u32::from_le_bytes([bytes[4], bytes[5], bytes[6], bytes[7]]))
        .map_err(|_| corrupt())?;
    if riff < 4 || riff + 8 > bytes.len() {
        return Err(corrupt());
    }
    let sides = webp_sides(bytes).ok_or_else(corrupt)?;
    if &bytes[12..16] == b"VP8X" {
        if bytes.get(20).ok_or_else(corrupt)? & 0x02 != 0 {
            return Err(unsupported("an animated WebP is not a photo"));
        }
        // An animation chunk behind a header that does not say so.
        let end = riff + 8;
        let mut at = 12;
        while at + 8 <= end {
            let kind = &bytes[at..at + 4];
            if kind == b"ANIM" || kind == b"ANMF" {
                return Err(unsupported("an animated WebP is not a photo"));
            }
            let size = usize::try_from(u32::from_le_bytes([
                bytes[at + 4],
                bytes[at + 5],
                bytes[at + 6],
                bytes[at + 7],
            ]))
            .map_err(|_| corrupt())?;
            // Chunks are padded to an even length.
            at = at.saturating_add(8 + size + (size & 1));
        }
        // The canvas is the extended header's word; the bitstream's own
        // header must say the same, or a small canvas could carry a picture
        // the size limit never saw.
        if image_sides(bytes, riff + 8)? != sides {
            return Err(corrupt());
        }
    }
    Ok(sides)
}

/// The sides the first bitstream chunk (`VP8 ` or `VP8L`) of an extended
/// WebP declares, behind whatever the header lists first (`ICCP`, `ALPH`,
/// `EXIF`, `XMP `); `corrupt` when there is none inside the RIFF.
fn image_sides(bytes: &[u8], end: usize) -> Result<(u32, u32), ApiError> {
    let mut at = 30;
    while at + 8 <= end {
        let kind = &bytes[at..at + 4];
        let size = usize::try_from(u32::from_le_bytes([
            bytes[at + 4],
            bytes[at + 5],
            bytes[at + 6],
            bytes[at + 7],
        ]))
        .map_err(|_| corrupt())?;
        let data = bytes.get(at + 8..).ok_or_else(corrupt)?;
        match kind {
            b"VP8 " => {
                let frame = data.get(..10).ok_or_else(corrupt)?;
                if frame[3..6] != [0x9D, 0x01, 0x2A] {
                    return Err(corrupt());
                }
                let width = u16::from_le_bytes([frame[6], frame[7]]) & 0x3FFF;
                let height = u16::from_le_bytes([frame[8], frame[9]]) & 0x3FFF;
                return Ok((u32::from(width), u32::from(height)));
            }
            b"VP8L" => {
                let head = data.get(..5).ok_or_else(corrupt)?;
                if head[0] != 0x2F {
                    return Err(corrupt());
                }
                let bits = u32::from_le_bytes([head[1], head[2], head[3], head[4]]);
                return Ok(((bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1));
            }
            _ => at = at.saturating_add(8 + size + (size & 1)),
        }
    }
    Err(corrupt())
}
