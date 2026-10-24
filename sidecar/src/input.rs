//! Input delivery into a window on a non-input desktop.
//!
//! Ground truth established by the prototype matrix (see docs/verification.md):
//!   * `SendInput` always fails with ACCESS_DENIED(5) on a non-input desktop, so it is
//!     never used.
//!   * Mouse messages must target the deepest child (Chromium: Chrome_RenderWidgetHostHWND).
//!   * `WM_MOUSEWHEEL` takes SCREEN coordinates in lParam, mouse buttons take CLIENT ones.
//!   * Sending WM_KEYDOWN and WM_CHAR for the same character inserts it twice; printable
//!     text therefore goes through WM_CHAR only.
//!   * Modifier state (Ctrl/Shift/Alt) is invisible to the target unless we AttachThreadInput
//!     to its UI thread and SetKeyboardState the VK_* keys.

use crate::win32::*;
use crate::window;
use std::ffi::c_void;

/// sdt: marker so we can kill long SendMessageTimeout waits if a target hangs.
const SMTO_ABORTIFHUNG: UINT = 0x0002;
const SMTO_BLOCK: UINT = 0x0001;

fn client_lparam(x: i32, y: i32) -> LPARAM {
    (((y & 0xFFFF) << 16) | (x & 0xFFFF)) as LPARAM
}

pub fn move_mouse(hwnd: HWND, x: i32, y: i32, buttons: WPARAM) {
    unsafe { PostMessageW(hwnd, WM_MOUSEMOVE, buttons, client_lparam(x, y)) };
}

pub fn button(hwnd: HWND, x: i32, y: i32, which: &str, down: bool) {
    let (msg, mk) = match (which, down) {
        ("left", true) => (WM_LBUTTONDOWN, MK_LBUTTON),
        ("left", false) => (WM_LBUTTONUP, 0),
        ("right", true) => (WM_RBUTTONDOWN, MK_RBUTTON),
        ("right", false) => (WM_RBUTTONUP, 0),
        ("middle", true) => (WM_MBUTTONDOWN, MK_MBUTTON),
        ("middle", false) => (WM_MBUTTONUP, 0),
        _ => return,
    };
    unsafe { PostMessageW(hwnd, msg, mk, client_lparam(x, y)) };
}

/// Wheel scrolling. `screen` must be the SCREEN point of the target window.
pub fn wheel(hwnd: HWND, screen_x: i32, screen_y: i32, delta: i32) {
    let wp = ((delta as i64 & 0xFFFF) << 16) as WPARAM;
    let lp = (((screen_y & 0xFFFF) << 16) | (screen_x & 0xFFFF)) as LPARAM;
    unsafe {
        PostMessageW(hwnd, WM_MOUSEWHEEL, wp, lp);
    }
}

/// Type printable text: WM_CHAR per UTF-16 code unit (surrogate pairs pass through as two units).
///
/// Uses SendMessageTimeout with SMTO_ABORTIFHUNG rather than PostMessage. PostMessage
/// queues each character as an independent message and a busy/hung target silently drops
/// or reorders them (observed: 8 chars typed, 1 char landed), whereas the synchronous
/// form guarantees every character was consumed before the next is posted.
pub fn type_text(hwnd: HWND, text: &str) {
    for unit in text.encode_utf16() {
        unsafe {
            SendMessageTimeoutW(
                hwnd,
                WM_CHAR,
                unit as WPARAM,
                1,
                0x0002 /* SMTO_ABORTIFHUNG */,
                200,
                std::ptr::null_mut(),
            );
        }
    }
}

/// Press a named key ("enter", "tab", "esc", "backspace", "delete", "up", "f5", "a", "1").
pub fn press_key(hwnd: HWND, name: &str) -> Result<(), String> {
    let (vk, ch) = key_lookup(name).ok_or_else(|| format!("unknown key: {name}"))?;
    let lp_down: LPARAM = 1;
    let lp_up: LPARAM = 0xC000_0001u32 as i32 as LPARAM;
    unsafe {
        if (vk as u32) == 0x0D || (vk as u32) == 0x09 {
            PostMessageW(hwnd, WM_KEYDOWN, vk as WPARAM, lp_down);
            PostMessageW(hwnd, WM_CHAR, ch as WPARAM, 1);
            PostMessageW(hwnd, WM_KEYUP, vk as WPARAM, lp_up);
        } else {
            PostMessageW(hwnd, WM_KEYDOWN, vk as WPARAM, lp_down);
            PostMessageW(hwnd, WM_KEYUP, vk as WPARAM, lp_up);
        }
    }
    Ok(())
}

fn key_lookup(name: &str) -> Option<(u16, u16)> {
    let n = name.to_ascii_lowercase();
    let named: Vec<(&str, u16, u16)> = vec![
        ("enter", 0x0D, 0x0D),
        ("return", 0x0D, 0x0D),
        ("tab", 0x09, 0x09),
        ("esc", 0x1B, 0x1B),
        ("escape", 0x1B, 0x1B),
        ("backspace", 0x08, 0x08),
        ("delete", 0x2E, 0x2E),
        ("del", 0x2E, 0x2E),
        ("insert", 0x2D, 0x2D),
        ("home", 0x24, 0x24),
        ("end", 0x23, 0x23),
        ("pageup", 0x21, 0x21),
        ("pagedown", 0x22, 0x22),
        ("left", 0x25, 0x25),
        ("up", 0x26, 0x26),
        ("right", 0x27, 0x27),
        ("down", 0x28, 0x28),
        ("space", 0x20, 0x20),
        ("f1", 0x70, 0), ("f2", 0x71, 0), ("f3", 0x72, 0), ("f4", 0x73, 0),
        ("f5", 0x74, 0), ("f6", 0x75, 0), ("f7", 0x76, 0), ("f8", 0x77, 0),
        ("f9", 0x78, 0), ("f10", 0x79, 0), ("f11", 0x7A, 0), ("f12", 0x7B, 0),
    ];
    for (k, vk, ch) in named {
        if n == k {
            return Some((vk, ch));
        }
    }
    let mut cs = n.chars();
    if let (Some(c), None) = (cs.next(), cs.next()) {
        let up = c.to_ascii_uppercase();
        return Some((up as u16, c as u16));
    }
    None
}

fn vk_of(name: &str) -> Option<u16> {
    match name.to_ascii_lowercase().as_str() {
        "ctrl" | "control" => Some(VK_CONTROL),
        "shift" => Some(VK_SHIFT),
        "alt" | "menu" => Some(VK_MENU),
        "win" | "meta" | "super" => Some(VK_LWIN),
        other => key_lookup(other).map(|(vk, _)| vk),
    }
}

/// Force modifier key state into the target's UI thread's keyboard table, run `body`,
/// then restore. This is the only route that makes Ctrl/Shift/Alt observable by the
/// target on a non-input desktop.
pub fn with_modifiers<R>(hwnd: HWND, mods: &[&str], body: impl FnOnce() -> R) -> Result<R, String> {
    let mut vks = Vec::new();
    for m in mods {
        match vk_of(m) {
            Some(vk) => vks.push(vk),
            None => return Err(format!("unknown modifier: {m}")),
        }
    }
    if vks.is_empty() {
        return Ok(body());
    }
    unsafe {
        let target_tid = GetWindowThreadProcessId(hwnd, std::ptr::null_mut());
        let my_tid = GetCurrentThreadId();
        let attached = target_tid != 0 && target_tid != my_tid && AttachThreadInput(my_tid, target_tid, 1) != 0;
        // Save and set state
        let mut st = [0u8; 256];
        GetKeyboardState(st.as_mut_ptr());
        let saved = st;
        for &vk in &vks {
            st[vk as usize] = 0x80;
            match vk {
                VK_CONTROL => st[VK_LCONTROL as usize] = 0x80,
                VK_SHIFT => st[VK_LSHIFT as usize] = 0x80,
                VK_MENU => st[VK_LMENU as usize] = 0x80,
                _ => {}
            }
        }
        SetKeyboardState(st.as_ptr());
        // Modifier key-down messages so the target's message loop sees them too.
        for &vk in &vks {
            PostMessageW(hwnd, WM_KEYDOWN, vk as WPARAM, 1);
        }
        let r = body();
        for &vk in &vks {
            PostMessageW(hwnd, WM_KEYUP, vk as WPARAM, 0xC000_0001u32 as i32 as LPARAM);
        }
        // restore original key state
        SetKeyboardState(saved.as_ptr());
        if attached {
            AttachThreadInput(my_tid, target_tid, 0);
        }
        Ok(r)
    }
}

/// Key combo such as "ctrl+a", "ctrl+shift+s", "alt+f4".
pub fn hotkey(hwnd: HWND, combo: &str) -> Result<(), String> {
    let parts: Vec<&str> = combo.split('+').map(|s| s.trim()).filter(|s| !s.is_empty()).collect();
    if parts.is_empty() {
        return Err("empty key combo".into());
    }
    let (mods, key) = parts.split_at(parts.len() - 1);
    let key = key[0];
    let (vk, ch) = key_lookup(key).ok_or_else(|| format!("unknown key: {key}"))?;
    with_modifiers(hwnd, mods, || unsafe {
        PostMessageW(hwnd, WM_KEYDOWN, vk as WPARAM, 1);
        if ch != 0 && mods.is_empty() {
            PostMessageW(hwnd, WM_CHAR, ch as WPARAM, 1);
        }
        PostMessageW(hwnd, WM_KEYUP, vk as WPARAM, 0xC000_0001u32 as i32 as LPARAM);
    })?;
    Ok(())
}

/// Click a window at client coordinates, hitting the deepest child first.
pub fn click(
    top: HWND,
    client_x: i32,
    client_y: i32,
    which: &str,
    count: u32,
    settle_ms: u32,
) -> Result<usize, String> {
    let mut pt = POINT { x: client_x, y: client_y };
    unsafe { ClientToScreen(top, &mut pt) };
    let (target, local) = window::hit_test(top, pt);
    unsafe {
        PostMessageW(target, WM_MOUSEMOVE, 0, client_lparam(local.x, local.y));
    }
    for i in 0..count {
        button(target, local.x, local.y, which, true);
        std::thread::sleep(std::time::Duration::from_millis(if which == "left" { 30 } else { 40 }));
        button(target, local.x, local.y, which, false);
        if count > 1 && i + 1 < count {
            std::thread::sleep(std::time::Duration::from_millis(60));
        }
    }
    if settle_ms > 0 {
        std::thread::sleep(std::time::Duration::from_millis(settle_ms as u64));
    }
    Ok(target as usize)
}

/// Drag inside a window: press, interpolate moves, release.
pub fn drag(
    top: HWND,
    from_x: i32,
    from_y: i32,
    to_x: i32,
    to_y: i32,
    which: &str,
    settle_ms: u32,
) -> Result<usize, String> {
    let mut p1 = POINT { x: from_x, y: from_y };
    let mut p2 = POINT { x: to_x, y: to_y };
    unsafe {
        ClientToScreen(top, &mut p1);
        ClientToScreen(top, &mut p2);
    }
    let (target, start) = window::hit_test(top, p1);
    let mut end = p2;
    unsafe { ScreenToClient(target, &mut end) };
    let mk = if which == "left" { MK_LBUTTON } else { MK_RBUTTON };
    unsafe { PostMessageW(target, WM_MOUSEMOVE, 0, client_lparam(start.x, start.y)) };
    button(target, start.x, start.y, which, true);
    let steps = 12;
    for i in 1..=steps {
        let x = start.x + (end.x - start.x) * i / steps;
        let y = start.y + (end.y - start.y) * i / steps;
        std::thread::sleep(std::time::Duration::from_millis(16));
        unsafe { PostMessageW(target, WM_MOUSEMOVE, mk, client_lparam(x, y)) };
    }
    button(target, end.x, end.y, which, false);
    if settle_ms > 0 {
        std::thread::sleep(std::time::Duration::from_millis(settle_ms as u64));
    }
    Ok(target as usize)
}

/// Read the text of a window (prefers a child Edit control).
///
/// Note: `SendMessageTimeoutW`'s return value only says whether the call succeeded; the
/// actual LRESULT (the text length for WM_GETTEXTLENGTH) arrives through `lpdwResult`.
/// Reading the return value as a length truncates every result to one character.
pub fn read_text(top: HWND) -> String {
    let mut targets: Vec<HWND> = Vec::new();
    for k in window::children(top) {
        let c = window::class_of(k);
        if c == "Edit" || c.starts_with("RichEdit") || c == "Scintilla" {
            targets.push(k);
        }
    }
    // Only fall back to the top-level window when it hosts no editor control: a plain
    // GetWindowText on it yields the title, which would otherwise win the length contest.
    if targets.is_empty() {
        targets.push(top);
    }
    let mut best = String::new();
    for t in targets {
        let mut len_out: usize = 0;
        let ok = unsafe {
            SendMessageTimeoutW(
                t,
                WM_GETTEXTLENGTH,
                0,
                0,
                SMTO_ABORTIFHUNG | SMTO_BLOCK,
                500,
                &mut len_out,
            )
        };
        if ok == 0 || len_out > 8_000_000 {
            continue;
        }
        let cap = len_out + 2;
        let mut buf = vec![0u16; cap];
        let mut got: usize = 0;
        let ok = unsafe {
            SendMessageTimeoutW(
                t,
                WM_GETTEXT,
                cap as WPARAM,
                buf.as_mut_ptr() as LPARAM,
                SMTO_ABORTIFHUNG | SMTO_BLOCK,
                500,
                &mut got,
            )
        };
        if ok == 0 || got == 0 {
            continue;
        }
        let s = from_wide_buf(&buf, got.min(cap));
        if s.chars().count() > best.chars().count() {
            best = s;
        }
    }
    best
}

/// Put text into a window wholesale (best effort, windows that host an Edit child).
pub fn set_text(top: HWND, text: &str) -> bool {
    unsafe extern "system" fn cb_child(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let out = &mut *(lparam as *mut Vec<HWND>);
        out.push(hwnd);
        1
    }
    let mut kids: Vec<HWND> = Vec::new();
    unsafe { EnumChildWindows(top, cb_child, &mut kids as *mut _ as LPARAM) };
    let w = wide(text);
    for k in kids {
        let mut cls = vec![0u16; 128];
        let n = unsafe { GetClassNameW(k, cls.as_mut_ptr(), cls.len() as i32) };
        let c = from_wide_buf(&cls, n.max(0) as usize);
        if c == "Edit" || c.starts_with("RichEdit") {
            let mut res: usize = 0;
            let ok = unsafe {
                SendMessageTimeoutW(k, WM_SETTEXT, 0, w.as_ptr() as LPARAM, SMTO_ABORTIFHUNG, 1000, &mut res)
            };
            return ok != 0;
        }
    }
    let mut res: usize = 0;
    let ok = unsafe { SendMessageTimeoutW(top, WM_SETTEXT, 0, w.as_ptr() as LPARAM, SMTO_ABORTIFHUNG, 1000, &mut res) };
    ok != 0
}

/// Window management actions by client-area point (minimize / maximize / close buttons).
pub fn window_action(top: HWND, action: &str) -> bool {
    let cmd = match action {
        "close" => WM_CLOSE,
        "minimize" => WM_SYSCOMMAND,
        "maximize" | "restore" => WM_SYSCOMMAND,
        _ => return false,
    };
    let wp = match action {
        "minimize" => SC_MINIMIZE,
        "maximize" => SC_MAXIMIZE,
        "restore" => SC_RESTORE,
        _ => 0,
    };
    unsafe { PostMessageW(top, cmd, wp as WPARAM, 0) != 0 }
}

pub fn _unused(_: *mut c_void) {}
