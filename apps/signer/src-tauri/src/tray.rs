use std::sync::Mutex;

use signer_core::runtime::{AgentPhase, AgentStatus};
use tauri::image::Image;
use tauri::tray::TrayIcon;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TrayVisualState {
    Unpaired,
    Healthy,
    Reconnecting,
    Unavailable,
    Active,
}

fn visual_for(phase: AgentPhase, update_active: bool) -> TrayVisualState {
    if update_active {
        return TrayVisualState::Active;
    }
    match phase {
        AgentPhase::Unpaired => TrayVisualState::Unpaired,
        AgentPhase::Idle => TrayVisualState::Healthy,
        AgentPhase::Reconnecting => TrayVisualState::Reconnecting,
        AgentPhase::Unavailable | AgentPhase::Degraded => TrayVisualState::Unavailable,
        AgentPhase::Working => TrayVisualState::Active,
    }
}

fn tooltip_for(phase: AgentPhase, update_active: bool) -> &'static str {
    if update_active {
        return "Markiro Подписант — обновляется";
    }
    match phase {
        AgentPhase::Unpaired => "Markiro Подписант — не привязан",
        AgentPhase::Idle => "Markiro Подписант — готов",
        AgentPhase::Reconnecting => "Markiro Подписант — переподключается",
        AgentPhase::Unavailable => "Markiro Подписант — нет связи",
        AgentPhase::Working => "Markiro Подписант — подписывает",
        AgentPhase::Degraded => "Markiro Подписант — требуется внимание",
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct BadgeGeometry {
    center_x: i32,
    center_y: i32,
    outer_radius: u32,
    inner_radius: u32,
    core_radius: u32,
}

fn badge_geometry(width: u32, height: u32) -> BadgeGeometry {
    let minimum = width.min(height);
    let outer_radius = (minimum.saturating_mul(7) / 32).max(4);
    let inner_radius = (minimum.saturating_mul(3) / 16).max(3);
    let core_radius = (minimum.saturating_mul(5) / 32).max(2);
    let edge_inset = (minimum / 64).max(1);

    BadgeGeometry {
        center_x: width.saturating_sub(outer_radius + edge_inset) as i32,
        center_y: height.saturating_sub(outer_radius + edge_inset) as i32,
        outer_radius,
        inner_radius: inner_radius.min(outer_radius.saturating_sub(1)),
        core_radius: core_radius.min(inner_radius.saturating_sub(1)),
    }
}

fn paint_badge(base: &[u8], width: u32, height: u32, color: [u8; 4], radius: u32) -> Vec<u8> {
    let mut rgba = base.to_vec();
    if rgba.len() != width.saturating_mul(height).saturating_mul(4) as usize {
        return rgba;
    }
    let geometry = badge_geometry(width, height);

    paint_circle(
        &mut rgba,
        width,
        height,
        geometry.center_x,
        geometry.center_y,
        geometry.outer_radius,
        [20, 22, 27, 255],
    );
    paint_circle(
        &mut rgba,
        width,
        height,
        geometry.center_x,
        geometry.center_y,
        geometry.inner_radius,
        [248, 250, 252, 255],
    );
    paint_circle(
        &mut rgba,
        width,
        height,
        geometry.center_x,
        geometry.center_y,
        radius.min(geometry.inner_radius.saturating_sub(1)),
        color,
    );
    rgba
}

#[allow(clippy::too_many_arguments)]
fn paint_circle(
    rgba: &mut [u8],
    width: u32,
    height: u32,
    center_x: i32,
    center_y: i32,
    radius: u32,
    color: [u8; 4],
) {
    let radius = radius as i32;
    let radius_squared = radius * radius;
    for y in (center_y - radius).max(0)..=(center_y + radius).min(height as i32 - 1) {
        for x in (center_x - radius).max(0)..=(center_x + radius).min(width as i32 - 1) {
            let dx = x - center_x;
            let dy = y - center_y;
            if dx * dx + dy * dy > radius_squared {
                continue;
            }
            let offset = ((y as u32 * width + x as u32) * 4) as usize;
            rgba[offset..offset + 4].copy_from_slice(&color);
        }
    }
}

fn badged_icon(base: &Image<'static>, state: TrayVisualState, pulse_on: bool) -> Image<'static> {
    let minimum = base.width().min(base.height());
    let geometry = badge_geometry(base.width(), base.height());
    let pulse_radius = geometry
        .core_radius
        .saturating_add((minimum / 64).max(1))
        .min(geometry.inner_radius.saturating_sub(1));
    let (color, radius) = match state {
        TrayVisualState::Unpaired => ([148, 163, 184, 255], geometry.core_radius),
        TrayVisualState::Healthy => ([34, 197, 94, 255], geometry.core_radius),
        TrayVisualState::Reconnecting => ([245, 158, 11, 255], geometry.core_radius),
        TrayVisualState::Unavailable => ([239, 68, 68, 255], geometry.core_radius),
        TrayVisualState::Active if pulse_on => ([96, 165, 250, 255], pulse_radius),
        TrayVisualState::Active => ([59, 130, 246, 255], geometry.core_radius),
    };
    Image::new_owned(
        paint_badge(base.rgba(), base.width(), base.height(), color, radius),
        base.width(),
        base.height(),
    )
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum NotificationKind {
    Unavailable,
    Recovered,
    Degraded(String),
}

#[derive(Debug, Default)]
struct NotificationGate {
    outage_alerted: bool,
    degraded_alerted: bool,
}

impl NotificationGate {
    fn observe(&mut self, phase: AgentPhase, last_error: Option<&str>) -> Option<NotificationKind> {
        match phase {
            AgentPhase::Unavailable if !self.outage_alerted => {
                self.outage_alerted = true;
                self.degraded_alerted = false;
                Some(NotificationKind::Unavailable)
            }
            AgentPhase::Unavailable => None,
            AgentPhase::Reconnecting => {
                self.degraded_alerted = false;
                None
            }
            AgentPhase::Idle | AgentPhase::Working if self.outage_alerted => {
                self.outage_alerted = false;
                self.degraded_alerted = false;
                Some(NotificationKind::Recovered)
            }
            AgentPhase::Idle | AgentPhase::Working => {
                self.degraded_alerted = false;
                None
            }
            AgentPhase::Unpaired => {
                self.outage_alerted = false;
                self.degraded_alerted = false;
                None
            }
            AgentPhase::Degraded => {
                let detail = last_error?;
                if self.degraded_alerted {
                    return None;
                }
                self.degraded_alerted = true;
                Some(NotificationKind::Degraded(detail.to_string()))
            }
        }
    }
}

#[derive(Debug, Clone, Copy)]
struct TrayState {
    phase: AgentPhase,
    update_active: bool,
    pulse_on: bool,
}

pub struct TrayController {
    tray: TrayIcon,
    base_icon: Image<'static>,
    state: Mutex<TrayState>,
    notifications: Mutex<NotificationGate>,
}

impl TrayController {
    pub fn new(tray: TrayIcon, base_icon: Image<'static>, phase: AgentPhase) -> Self {
        let controller = Self {
            tray,
            base_icon,
            state: Mutex::new(TrayState {
                phase,
                update_active: false,
                pulse_on: false,
            }),
            notifications: Mutex::new(NotificationGate::default()),
        };
        controller.apply();
        controller
    }

    pub fn update_status(&self, app: &tauri::AppHandle, status: &AgentStatus) {
        if let Ok(mut state) = self.state.lock() {
            state.phase = status.phase;
            if visual_for(state.phase, state.update_active) != TrayVisualState::Active {
                state.pulse_on = false;
            }
        }
        self.apply();

        let notification = self
            .notifications
            .lock()
            .ok()
            .and_then(|mut gate| gate.observe(status.phase, status.last_error.as_deref()));
        if let Some(notification) = notification {
            show_notification(app, notification);
        }
    }

    pub fn set_update_active(&self, active: bool) {
        if let Ok(mut state) = self.state.lock() {
            state.update_active = active;
            state.pulse_on = false;
        }
        self.apply();
    }

    pub fn tick(&self) {
        let active = if let Ok(mut state) = self.state.lock() {
            if visual_for(state.phase, state.update_active) != TrayVisualState::Active {
                false
            } else {
                state.pulse_on = !state.pulse_on;
                true
            }
        } else {
            false
        };
        if active {
            self.apply();
        }
    }

    fn apply(&self) {
        let Ok(state) = self.state.lock().map(|state| *state) else {
            return;
        };
        let visual = visual_for(state.phase, state.update_active);
        let _ = self
            .tray
            .set_icon(Some(badged_icon(&self.base_icon, visual, state.pulse_on)));
        let _ = self
            .tray
            .set_tooltip(Some(tooltip_for(state.phase, state.update_active)));
    }
}

fn show_notification(app: &tauri::AppHandle, notification: NotificationKind) {
    use tauri_plugin_notification::NotificationExt as _;

    let body = match notification {
        NotificationKind::Unavailable => {
            "Нет связи с Markiro более 5 минут. Агент продолжает переподключаться.".to_string()
        }
        NotificationKind::Recovered => "Связь с Markiro восстановлена.".to_string(),
        NotificationKind::Degraded(detail) => detail,
    };
    let _ = app
        .notification()
        .builder()
        .title("Markiro Подписант")
        .body(body)
        .show();
}

#[cfg(test)]
mod tests {
    use super::*;
    use signer_core::runtime::AgentPhase;

    fn assert_pixel(rgba: &[u8], width: u32, x: i32, y: i32, expected: [u8; 4]) {
        let offset = (((y as u32 * width) + x as u32) * 4) as usize;
        assert_eq!(&rgba[offset..offset + 4], &expected);
    }

    #[test]
    fn maps_agent_and_update_activity_to_operator_states() {
        assert_eq!(
            visual_for(AgentPhase::Unpaired, false),
            TrayVisualState::Unpaired
        );
        assert_eq!(
            visual_for(AgentPhase::Idle, false),
            TrayVisualState::Healthy
        );
        assert_eq!(
            visual_for(AgentPhase::Reconnecting, false),
            TrayVisualState::Reconnecting
        );
        assert_eq!(
            visual_for(AgentPhase::Unavailable, false),
            TrayVisualState::Unavailable
        );
        assert_eq!(
            visual_for(AgentPhase::Degraded, false),
            TrayVisualState::Unavailable
        );
        assert_eq!(
            visual_for(AgentPhase::Working, false),
            TrayVisualState::Active
        );
        assert_eq!(visual_for(AgentPhase::Idle, true), TrayVisualState::Active);
    }

    #[test]
    fn badge_painting_changes_only_the_lower_right_badge_area() {
        let base = vec![7; 32 * 32 * 4];
        let painted = paint_badge(&base, 32, 32, [34, 197, 94, 255], 4);

        assert_eq!(&painted[0..4], &[7, 7, 7, 7]);
        let center = ((26 * 32 + 26) * 4) as usize;
        assert_eq!(&painted[center..center + 4], &[34, 197, 94, 255]);
    }

    #[test]
    fn badge_geometry_scales_to_a_visible_sixteen_pixel_badge() {
        let geometry = badge_geometry(128, 128);

        assert_eq!(geometry.outer_radius * 16 / 128, 3);
        assert_eq!(geometry.core_radius * 16 / 128, 2);
        assert!(geometry.outer_radius > geometry.inner_radius);
        assert!(geometry.inner_radius > geometry.core_radius);
        assert!(geometry.center_x + geometry.outer_radius as i32 <= 127);
        assert!(geometry.center_y + geometry.outer_radius as i32 <= 127);
    }

    #[test]
    fn badge_paints_dark_light_and_semantic_layers() {
        let base = vec![7; 128 * 128 * 4];
        let geometry = badge_geometry(128, 128);
        let painted = paint_badge(
            &base,
            128,
            128,
            [34, 197, 94, 255],
            geometry.core_radius,
        );

        assert_pixel(
            &painted,
            128,
            geometry.center_x,
            geometry.center_y,
            [34, 197, 94, 255],
        );
        assert_pixel(
            &painted,
            128,
            geometry.center_x + geometry.core_radius as i32 + 1,
            geometry.center_y,
            [248, 250, 252, 255],
        );
        assert_pixel(
            &painted,
            128,
            geometry.center_x + geometry.inner_radius as i32 + 1,
            geometry.center_y,
            [20, 22, 27, 255],
        );
        assert_pixel(&painted, 128, 0, 0, [7, 7, 7, 7]);
    }

    #[test]
    fn notification_gate_alerts_once_after_grace_and_once_on_recovery() {
        let mut gate = NotificationGate::default();

        assert_eq!(gate.observe(AgentPhase::Reconnecting, None), None);
        assert_eq!(
            gate.observe(AgentPhase::Unavailable, Some("network failure")),
            Some(NotificationKind::Unavailable)
        );
        assert_eq!(
            gate.observe(AgentPhase::Unavailable, Some("network failure")),
            None
        );
        assert_eq!(
            gate.observe(AgentPhase::Idle, None),
            Some(NotificationKind::Recovered)
        );
        assert_eq!(gate.observe(AgentPhase::Idle, None), None);
    }

    #[test]
    fn notification_gate_deduplicates_actionable_errors() {
        let mut gate = NotificationGate::default();

        assert_eq!(
            gate.observe(AgentPhase::Degraded, Some("certificate missing")),
            Some(NotificationKind::Degraded("certificate missing".into()))
        );
        assert_eq!(
            gate.observe(AgentPhase::Degraded, Some("certificate missing")),
            None
        );
        assert_eq!(
            gate.observe(AgentPhase::Degraded, Some("another error")),
            None,
            "changing details while degraded must not create a notification stream"
        );
        assert_eq!(gate.observe(AgentPhase::Idle, None), None);
        assert_eq!(
            gate.observe(AgentPhase::Degraded, Some("certificate missing")),
            Some(NotificationKind::Degraded("certificate missing".into()))
        );
    }
}
