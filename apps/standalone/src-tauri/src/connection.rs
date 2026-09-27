//! The link to the paired host (stage 1 spec §5.2). A background task keeps
//! `GET /v1/changes/stream` open with the device key and the pinned
//! certificate, reconnects after a pause that grows from 1 to 30 s, and tells
//! the webview how the link is (`standalone://host-status`) and which
//! revision the host reached (`standalone://host-revision`). The webview syncs
//! reference data on every revision; it never opens the stream itself.

use std::convert::Infallible;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tokio::sync::watch;

use crate::device::HostLink;
use crate::host_client::{HostResponse, RequestError, StreamClient, StreamOpen};

pub const STATUS_EVENT: &str = "standalone://host-status";
pub const REVISION_EVENT: &str = "standalone://host-revision";
const STREAM_PATH: &str = "/v1/changes/stream";
/// An event longer than this is not from a Markiro host.
const MAX_EVENT_BYTES: usize = 64 * 1024;

/// How the link is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LinkState {
    /// The stream is open and the host has spoken on it.
    Online,
    /// Opening the stream.
    Connecting,
    /// No stream: waiting to reconnect, or not paired.
    Offline,
}

/// Why the last attempt failed, as a stable code the webview maps to text.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LinkError {
    /// No connection, a TLS failure other than the pin, or no answer in time.
    Unreachable,
    /// The host presented a certificate other than the pinned one.
    CertificateMismatch,
    /// The host no longer accepts this device's key.
    KeyRejected,
    /// The host refused the stream with another error.
    StreamRefused,
    /// The stream closed, went silent or carried something unreadable.
    StreamEnded,
}

/// `standalone://host-status` and the answer of `connection_status`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostStatus {
    pub state: LinkState,
    /// When the host last sent anything on the stream, in milliseconds since
    /// the Unix epoch; `None` before the first contact and while unpaired. A
    /// heartbeat advances this without publishing a new status (no new
    /// `seq`), so `connection_status` can report a newer `lastContactAt`
    /// than the last event the webview received; an event's own
    /// `lastContactAt` is always the value current when that event was
    /// published, never read again afterward.
    pub last_contact_at: Option<u64>,
    /// Why the last attempt failed; `None` while online and while unpaired.
    pub last_error: Option<LinkError>,
    /// Grows by one with every published status, so the webview can order a
    /// `connection_status` answer against events that raced it.
    pub seq: u64,
}

impl Default for HostStatus {
    fn default() -> Self {
        Self {
            state: LinkState::Offline,
            last_contact_at: None,
            last_error: None,
            seq: 0,
        }
    }
}

/// `standalone://host-revision`: the host has committed revision `rev`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct HostRevision {
    pub rev: i64,
}

/// Where the task reports: the app emits Tauri events, tests record them.
pub trait LinkEvents: Send + Sync + 'static {
    fn status(&self, status: &HostStatus);
    fn revision(&self, revision: HostRevision);
}

/// Tauri state: the latest status, for `connection_status`.
#[derive(Debug, Clone, Default)]
pub struct ConnectionState(Arc<Mutex<HostStatus>>);

impl ConnectionState {
    pub fn snapshot(&self) -> HostStatus {
        self.0.lock().expect("status lock").clone()
    }

    /// Record contact with the host without publishing a status: a heartbeat
    /// (or any stream data) advances `last_contact_at` on its own, so
    /// `connection_status` can report it before the next status that bumps
    /// `seq`.
    fn touch(&self) {
        self.0.lock().expect("status lock").last_contact_at = Some(now_ms());
    }

    fn publish(&self, events: &dyn LinkEvents, state: LinkState, last_error: Option<LinkError>) {
        self.publish_with(events, |current| {
            current.state = state;
            current.last_error = last_error;
        });
    }

    /// Apply `update` and publish the result in one critical section, so a
    /// `connection_status` racing the update never sees a status with some
    /// fields already changed and others still old (as a status built from
    /// two separate lock acquisitions could).
    fn publish_with(&self, events: &dyn LinkEvents, update: impl FnOnce(&mut HostStatus)) {
        let status = {
            let mut current = self.0.lock().expect("status lock");
            update(&mut current);
            current.seq += 1;
            current.clone()
        };
        events.status(&status);
    }

    /// Offline with nothing to report: the device is not paired.
    fn unpaired(&self, events: &dyn LinkEvents) {
        self.publish_with(events, |current| {
            current.state = LinkState::Offline;
            current.last_error = None;
            current.last_contact_at = None;
        });
    }
}

/// Pauses between attempts: `initial`, doubling up to `max`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Backoff {
    pub initial: Duration,
    pub max: Duration,
}

impl Default for Backoff {
    fn default() -> Self {
        Self {
            initial: Duration::from_secs(1),
            max: Duration::from_secs(30),
        }
    }
}

impl Backoff {
    fn after(self, pause: Duration) -> Duration {
        pause.saturating_mul(2).min(self.max)
    }
}

/// The pause `hold` should sleep for now and carry into its next iteration,
/// given the pause carried from the previous one and whether the session
/// that just ended had come online. A session that came online resets to
/// `initial`, no matter how far the pause had grown; otherwise it keeps
/// doubling from wherever it left off.
fn next_pause(backoff: Backoff, pause: Duration, came_online: bool) -> (Duration, Duration) {
    let sleep_now = if came_online { backoff.initial } else { pause };
    (sleep_now, backoff.after(sleep_now))
}

/// Follow the pairing: hold the stream while paired, stay offline and try
/// nothing while not. Returns once the `DeviceState` behind `link` is gone.
pub async fn supervise(
    mut link: watch::Receiver<Option<Arc<HostLink>>>,
    events: Arc<dyn LinkEvents>,
    state: ConnectionState,
    backoff: Backoff,
) {
    loop {
        let current = link.borrow_and_update().clone();
        let changed = match current {
            None => {
                state.unpaired(&*events);
                link.changed().await
            }
            Some(current) => tokio::select! {
                never = hold(&current, &*events, &state, backoff) => match never {},
                changed = link.changed() => changed,
            },
        };
        if changed.is_err() {
            return;
        }
    }
}

/// Keep the stream to one host open, reconnecting forever. A pairing change
/// drops this future, which closes the connection.
async fn hold(
    link: &HostLink,
    events: &dyn LinkEvents,
    state: &ConnectionState,
    backoff: Backoff,
) -> Infallible {
    let mut pause = backoff.initial;
    let mut last_error = None;
    // A quick forget-and-re-pair can coalesce the transient `unpaired`
    // status in the watch channel (only the latest value survives), so this
    // link's first status clears the previous host's contact time itself
    // rather than relying on having observed that transient status.
    let mut fresh_link = true;
    loop {
        state.publish_with(events, |current| {
            current.state = LinkState::Connecting;
            current.last_error = last_error;
            if fresh_link {
                current.last_contact_at = None;
            }
        });
        fresh_link = false;
        let (error, came_online) = follow(link, events, state).await;
        last_error = Some(error);
        state.publish(events, LinkState::Offline, last_error);
        let (sleep_now, next) = next_pause(backoff, pause, came_online);
        tokio::time::sleep(sleep_now).await;
        pause = next;
    }
}

/// One connection: open the stream and pass its events on until it ends.
/// Returns why it ended and whether the host had spoken on it.
async fn follow(
    link: &HostLink,
    events: &dyn LinkEvents,
    state: &ConnectionState,
) -> (LinkError, bool) {
    let client = match StreamClient::new(&link.address, &link.fingerprint) {
        Ok(client) => client,
        Err(error) => return (request_error(error), false),
    };
    let mut stream = match client.open(STREAM_PATH, link.key()).await {
        Ok(StreamOpen::Open(stream)) => stream,
        Ok(StreamOpen::Refused(response)) => return (refusal(&response), false),
        Err(error) => return (request_error(error), false),
    };
    let mut parser = SseParser::default();
    let mut online = false;
    loop {
        let bytes = match stream.chunk().await {
            Ok(Some(bytes)) => bytes,
            Ok(None) | Err(_) => return (LinkError::StreamEnded, online),
        };
        state.touch();
        let Ok(items) = parser.push(&bytes) else {
            return (LinkError::StreamEnded, online);
        };
        for item in items {
            if !online {
                online = true;
                state.publish(events, LinkState::Online, None);
            }
            if let SseItem::Revision(rev) = item {
                events.revision(HostRevision { rev });
            }
        }
    }
}

fn request_error(error: RequestError) -> LinkError {
    match error {
        RequestError::CertificateMismatch => LinkError::CertificateMismatch,
        _ => LinkError::Unreachable,
    }
}

/// A refused stream: a rejected device key needs a new pairing; any other
/// refusal is the host's to explain in its own log.
fn refusal(response: &HostResponse) -> LinkError {
    let credential = response
        .body
        .as_ref()
        .and_then(|body| body["error"]["details"]["credential"].as_str());
    if response.status == 401 && credential == Some(markiro_proto::credentials::DEVICE) {
        LinkError::KeyRejected
    } else {
        LinkError::StreamRefused
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| {
            u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX)
        })
}

/// What one server-sent event carried.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SseItem {
    /// `event: rev` with `data: {"rev": N}`.
    Revision(i64),
    /// A comment (the heartbeat) or an event this build does not read.
    Other,
}

/// An event grew past the limit without ending.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EventTooLong;

/// Splits a `text/event-stream` into events: blocks of lines that end with a
/// blank line, with LF or CRLF line ends.
#[derive(Debug, Default)]
pub struct SseParser {
    buffer: Vec<u8>,
}

impl SseParser {
    /// Feed the next bytes; returns the events they completed.
    pub fn push(&mut self, bytes: &[u8]) -> Result<Vec<SseItem>, EventTooLong> {
        self.buffer
            .extend(bytes.iter().copied().filter(|&byte| byte != b'\r'));
        let mut items = Vec::new();
        while let Some(end) = self.buffer.windows(2).position(|pair| pair == b"\n\n") {
            let block: Vec<u8> = self.buffer.drain(..end + 2).collect();
            items.push(parse_event(&block[..end]));
        }
        if self.buffer.len() > MAX_EVENT_BYTES {
            return Err(EventTooLong);
        }
        Ok(items)
    }
}

/// One event block: `event:` names it, `data:` lines carry it, lines that
/// start with `:` are comments.
fn parse_event(block: &[u8]) -> SseItem {
    let text = String::from_utf8_lossy(block);
    let mut name = None;
    let mut data = String::new();
    for line in text.split('\n') {
        if line.starts_with(':') {
            continue;
        }
        let (field, value) = match line.split_once(':') {
            Some((field, value)) => (field, value.strip_prefix(' ').unwrap_or(value)),
            None => (line, ""),
        };
        match field {
            "event" => name = Some(value),
            "data" => {
                if !data.is_empty() {
                    data.push('\n');
                }
                data.push_str(value);
            }
            _ => {}
        }
    }
    match (name, serde_json::from_str::<HostRevision>(&data)) {
        (Some("rev"), Ok(revision)) => SseItem::Revision(revision.rev),
        _ => SseItem::Other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const REV_7: &[u8] = b"event: rev\ndata: {\"rev\":7}\n\n";

    #[test]
    fn a_revision_event_is_read_whole_or_in_pieces() {
        let mut parser = SseParser::default();
        assert_eq!(parser.push(REV_7), Ok(vec![SseItem::Revision(7)]));
        for split in 1..REV_7.len() {
            let mut parser = SseParser::default();
            let mut items = parser.push(&REV_7[..split]).unwrap();
            items.extend(parser.push(&REV_7[split..]).unwrap());
            assert_eq!(items, vec![SseItem::Revision(7)], "split at {split}");
        }
    }

    #[test]
    fn heartbeats_crlf_and_several_events_in_one_chunk() {
        let mut parser = SseParser::default();
        let chunk =
            b":\n\nevent: rev\r\ndata: {\"rev\":1}\r\n\r\nevent: rev\ndata: {\"rev\":2}\n\n";
        assert_eq!(
            parser.push(chunk),
            Ok(vec![
                SseItem::Other,
                SseItem::Revision(1),
                SseItem::Revision(2)
            ])
        );
    }

    #[test]
    fn unknown_or_unreadable_events_are_other() {
        let mut parser = SseParser::default();
        assert_eq!(
            parser.push(b"event: hello\ndata: {}\n\n"),
            Ok(vec![SseItem::Other])
        );
        assert_eq!(
            parser.push(b"event: rev\ndata: not json\n\n"),
            Ok(vec![SseItem::Other])
        );
        assert_eq!(
            parser.push(b"data: {\"rev\":3}\n\n"),
            Ok(vec![SseItem::Other])
        );
    }

    #[test]
    fn an_endless_event_is_refused() {
        let mut parser = SseParser::default();
        assert_eq!(
            parser.push(&vec![b'x'; MAX_EVENT_BYTES + 1]),
            Err(EventTooLong)
        );
    }

    #[test]
    fn pauses_double_up_to_the_limit() {
        let backoff = Backoff::default();
        let mut pause = backoff.initial;
        let mut seconds = vec![pause.as_secs()];
        for _ in 0..6 {
            pause = backoff.after(pause);
            seconds.push(pause.as_secs());
        }
        assert_eq!(seconds, [1, 2, 4, 8, 16, 30, 30]);
    }

    #[test]
    fn next_pause_grows_when_the_link_never_came_online() {
        let backoff = Backoff::default();
        let mut pause = backoff.initial;
        let mut seconds = vec![pause.as_secs()];
        for _ in 0..6 {
            let (sleep_now, next) = next_pause(backoff, pause, false);
            assert_eq!(
                sleep_now, pause,
                "sleeps the carried-over pause, not the grown one"
            );
            pause = next;
            seconds.push(pause.as_secs());
        }
        assert_eq!(seconds, [1, 2, 4, 8, 16, 30, 30]);
    }

    #[test]
    fn next_pause_resets_to_initial_after_a_session_that_came_online() {
        let backoff = Backoff::default();
        // However far the pause had grown, a session that came online
        // resets it, and doubling starts over from `initial` again.
        let (sleep_now, next) = next_pause(backoff, backoff.max, true);
        assert_eq!(sleep_now, backoff.initial);
        assert_eq!(next, backoff.after(backoff.initial));
    }

    #[test]
    fn a_rejected_device_key_is_told_apart_from_other_refusals() {
        let refused = |status: u16, body: serde_json::Value| {
            refusal(&HostResponse {
                status,
                body: Some(body),
            })
        };
        assert_eq!(
            refused(
                401,
                json!({ "error": { "code": "unauthorized", "message": "", "details": { "credential": "device" } } })
            ),
            LinkError::KeyRejected
        );
        // A rejected office session, not the device key: no reason to send
        // this device back to re-pairing.
        assert_eq!(
            refused(
                401,
                json!({ "error": { "code": "unauthorized", "message": "", "details": { "credential": "session" } } })
            ),
            LinkError::StreamRefused
        );
        assert_eq!(
            refused(
                400,
                json!({ "error": { "code": "protocol_unsupported", "message": "" } })
            ),
            LinkError::StreamRefused
        );
        assert_eq!(
            refusal(&HostResponse {
                status: 500,
                body: None
            }),
            LinkError::StreamRefused
        );
    }

    /// Every wire string plan 1c3 relies on: its `errors.link.*` i18n keys
    /// and its zod enum for `state`/`lastError` are built from these exact
    /// values.
    #[test]
    fn every_link_state_and_error_serializes_to_its_wire_string() {
        let states = [
            (LinkState::Online, "online"),
            (LinkState::Connecting, "connecting"),
            (LinkState::Offline, "offline"),
        ];
        for (state, wire) in states {
            assert_eq!(serde_json::to_value(state).unwrap(), json!(wire));
        }
        let errors = [
            (LinkError::Unreachable, "unreachable"),
            (LinkError::CertificateMismatch, "certificate_mismatch"),
            (LinkError::KeyRejected, "key_rejected"),
            (LinkError::StreamRefused, "stream_refused"),
            (LinkError::StreamEnded, "stream_ended"),
        ];
        for (error, wire) in errors {
            assert_eq!(serde_json::to_value(error).unwrap(), json!(wire));
        }
    }

    #[test]
    fn statuses_and_revisions_serialize_to_the_webview_shape() {
        let status = HostStatus {
            state: LinkState::Offline,
            last_contact_at: Some(1_700_000_000_000),
            last_error: Some(LinkError::CertificateMismatch),
            seq: 4,
        };
        assert_eq!(
            serde_json::to_value(&status).unwrap(),
            json!({ "state": "offline", "lastContactAt": 1_700_000_000_000u64, "lastError": "certificate_mismatch", "seq": 4 })
        );
        assert_eq!(
            serde_json::to_value(HostRevision { rev: 12 }).unwrap(),
            json!({ "rev": 12 })
        );
    }
}
