//! The installer as a response body and the range a request asks for (spec
//! §10.11.3). The file is read 64 KiB at a time on a blocking thread and
//! handed over a channel of one piece, never whole in memory; when the
//! client takes nothing for the stall limit the reader gives up, the body
//! ends before its `Content-Length`, and the connection is cut. `Range` and
//! `If-Range` are parsed here: one `bytes=N-` or `bytes=N-M`, nothing else.

use std::io::Read;
use std::time::Duration;

use axum::body::{Body, Bytes};

/// What one read takes from the file.
pub const CHUNK: usize = 64 * 1024;
/// How long the client may take nothing before the download is cut.
pub const STALL_LIMIT: Duration = Duration::from_secs(60);
/// How long an upload may take nothing from the client before it is dropped.
pub const UPLOAD_IDLE_LIMIT: Duration = Duration::from_secs(60);

/// `len` bytes of `file` from where it stands, in pieces of [`CHUNK`].
/// `guard` lives as long as the reader (a download's slot).
pub fn file_body<G: Send + 'static>(
    file: std::fs::File,
    len: u64,
    stall: Duration,
    guard: G,
) -> Body {
    let (sender, receiver) = tokio::sync::mpsc::channel::<Result<Bytes, std::io::Error>>(1);
    tokio::spawn(async move {
        let _guard = guard;
        let mut file = file;
        let mut left = len;
        while left > 0 {
            let want = usize::try_from(left.min(CHUNK as u64)).unwrap_or(CHUNK);
            let read = tokio::task::spawn_blocking(move || {
                let mut buffer = vec![0u8; want];
                let read = file.read(&mut buffer)?;
                buffer.truncate(read);
                Ok::<_, std::io::Error>((file, buffer))
            })
            .await;
            let (back, buffer) = match read {
                Ok(Ok((back, buffer))) if !buffer.is_empty() => (back, buffer),
                _ => {
                    // The error waits no longer than a chunk does: a client that
                    // takes nothing must not keep the slot through it.
                    let _ = tokio::time::timeout(
                        stall,
                        sender.send(Err(std::io::Error::other(
                            "the installer could not be read",
                        ))),
                    )
                    .await;
                    return;
                }
            };
            file = back;
            left -= buffer.len() as u64;
            match tokio::time::timeout(stall, sender.send(Ok(Bytes::from(buffer)))).await {
                Ok(Ok(())) => {}
                // The client went away, or took nothing for `stall`.
                _ => return,
            }
        }
    });
    Body::from_stream(futures_util::stream::unfold(
        receiver,
        |mut receiver| async move { receiver.recv().await.map(|item| (item, receiver)) },
    ))
}

/// The part of the file a request asks for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Span {
    Whole,
    /// `start..=end`, both inside the file.
    Part {
        start: u64,
        end: u64,
    },
}

/// A range the file of that size does not have: `416`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Unsatisfiable;

/// The span of a file of `size` bytes (`size` > 0) that `range` asks for. An
/// `If-Range` naming another ETag than `etag` asks for the whole file: the
/// package changed, and a device must not resume an old one.
pub fn requested_span(
    range: Option<&str>,
    if_range: Option<&str>,
    etag: &str,
    size: u64,
) -> Result<Span, Unsatisfiable> {
    let Some(range) = range else {
        return Ok(Span::Whole);
    };
    if if_range.is_some_and(|tag| tag.trim() != etag) {
        return Ok(Span::Whole);
    }
    let spec = range.trim().strip_prefix("bytes=").ok_or(Unsatisfiable)?;
    let (first, last) = spec.split_once('-').ok_or(Unsatisfiable)?;
    let digits = |text: &str| !text.is_empty() && text.bytes().all(|byte| byte.is_ascii_digit());
    if spec.contains(',') || !digits(first) {
        return Err(Unsatisfiable);
    }
    let start: u64 = first.parse().map_err(|_| Unsatisfiable)?;
    let end = if last.is_empty() {
        size - 1
    } else if digits(last) {
        last.parse::<u64>()
            .map_err(|_| Unsatisfiable)?
            .min(size - 1)
    } else {
        return Err(Unsatisfiable);
    };
    if start >= size || start > end {
        return Err(Unsatisfiable);
    }
    Ok(Span::Part { start, end })
}

#[cfg(test)]
mod tests {
    use http_body_util::BodyExt;

    use super::*;

    const TAG: &str = "\"ab\"";

    #[test]
    fn one_open_or_closed_range_is_read_and_anything_else_is_unsatisfiable() {
        let span = |range: &str| requested_span(Some(range), None, TAG, 1000);
        assert_eq!(requested_span(None, None, TAG, 1000), Ok(Span::Whole));
        assert_eq!(
            span("bytes=10-"),
            Ok(Span::Part {
                start: 10,
                end: 999
            })
        );
        assert_eq!(span("bytes=10-19"), Ok(Span::Part { start: 10, end: 19 }));
        assert_eq!(span("bytes=0-5000"), Ok(Span::Part { start: 0, end: 999 }));
        for bad in [
            "bytes=1000-",
            "bytes=5-1",
            "bytes=0-1,4-5",
            "bytes=-10",
            "x=0-1",
            "bytes=a-",
        ] {
            assert_eq!(span(bad), Err(Unsatisfiable), "{bad}");
        }
        assert_eq!(
            requested_span(Some("bytes=10-"), Some("\"cd\""), TAG, 1000),
            Ok(Span::Whole)
        );
        assert_eq!(
            requested_span(Some("bytes=10-"), Some(TAG), TAG, 1000),
            Ok(Span::Part {
                start: 10,
                end: 999
            })
        );
    }

    struct Dropped(Option<tokio::sync::oneshot::Sender<()>>);

    impl Drop for Dropped {
        fn drop(&mut self) {
            if let Some(sender) = self.0.take() {
                let _ = sender.send(());
            }
        }
    }

    #[tokio::test]
    async fn a_client_that_takes_nothing_for_the_stall_limit_gets_a_short_body() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("installer");
        std::fs::write(&path, vec![7u8; CHUNK * 4]).unwrap();
        let (sender, mut dropped) = tokio::sync::oneshot::channel();
        let mut body = file_body(
            std::fs::File::open(&path).unwrap(),
            (CHUNK * 4) as u64,
            Duration::from_millis(50),
            Dropped(Some(sender)),
        );
        let first = body.frame().await.unwrap().unwrap().into_data().unwrap();
        assert_eq!(first.len(), CHUNK);
        tokio::time::sleep(Duration::from_millis(300)).await;
        let mut rest = 0;
        while let Some(frame) = body.frame().await {
            rest += frame.unwrap().into_data().unwrap().len();
        }
        assert!(CHUNK + rest < CHUNK * 4, "the reader gave up: {rest}");
        assert!(dropped.try_recv().is_ok(), "the slot went with the reader");
    }

    #[tokio::test]
    async fn a_read_error_does_not_hold_the_slot_beyond_the_stall_limit() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("installer");
        // Shorter than the length asked: the second read ends the file.
        std::fs::write(&path, vec![7u8; CHUNK]).unwrap();
        let (sender, mut dropped) = tokio::sync::oneshot::channel();
        let _body = file_body(
            std::fs::File::open(&path).unwrap(),
            (CHUNK * 2) as u64,
            Duration::from_millis(50),
            Dropped(Some(sender)),
        );
        tokio::time::sleep(Duration::from_millis(400)).await;
        assert!(dropped.try_recv().is_ok(), "the error send gave up");
    }

    #[tokio::test]
    async fn a_client_that_reads_gets_every_byte_in_pieces() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("installer");
        let bytes: Vec<u8> = (0..CHUNK * 3 + 17).map(|n| (n % 251) as u8).collect();
        std::fs::write(&path, &bytes).unwrap();
        let body = file_body(
            std::fs::File::open(&path).unwrap(),
            bytes.len() as u64,
            STALL_LIMIT,
            (),
        );
        assert_eq!(body.collect().await.unwrap().to_bytes().to_vec(), bytes);
    }
}
