//! Window enumeration, capture (per-window PrintWindow + Z-order composition), PNG encoding.

use crate::win32::*;

/// One visible top-level window on a desktop.
#[derive(Clone, Debug)]
pub struct WindowInfo {
    pub hwnd: usize,
    pub title: String,
    pub class: String,
    pub pid: u32,
    pub rect: RECT,
    pub minimized: bool,
    pub visible: bool,
}

fn title_of(hwnd: HWND) -> String {
    let len = unsafe { GetWindowTextLengthW(hwnd) };
    if len <= 0 {
        return String::new();
    }
    let mut buf = vec![0u16; len as usize + 1];
    let n = unsafe { GetWindowTextW(hwnd, buf.as_mut_ptr(), buf.len() as i32) };
    if n <= 0 {
        return String::new();
    }
    from_wide_buf(&buf, n as usize)
}

pub fn class_of(hwnd: HWND) -> String {
    let mut buf = vec![0u16; 256];
    let n = unsafe { GetClassNameW(hwnd, buf.as_mut_ptr(), buf.len() as i32) };
    if n <= 0 {
        return String::new();
    }
    from_wide_buf(&buf, n as usize)
}

pub fn rect_of(hwnd: HWND) -> RECT {
    let mut r = RECT::default();
    unsafe { GetWindowRect(hwnd, &mut r) };
    r
}

pub fn info_of(hwnd: HWND) -> WindowInfo {
    let mut pid: u32 = 0;
    unsafe { GetWindowThreadProcessId(hwnd, &mut pid) };
    WindowInfo {
        hwnd: hwnd as usize,
        title: title_of(hwnd),
        class: class_of(hwnd),
        pid,
        rect: rect_of(hwnd),
        minimized: unsafe { IsIconic(hwnd) != 0 },
        visible: unsafe { IsWindowVisible(hwnd) != 0 },
    }
}

/// Classes that never represent an app window.
fn is_system_class(class: &str) -> bool {
    matches!(
        class,
        "IME"
            | "MSCTFIME UI"
            | "Default IME"
            | "CicLoaderWndClass"
            | "crashpad_SessionEndWatcher"
            | "Base_PowerMessageWindow"
            | "WorkerW"
            | "UAC Input Indicator"
            | "UAC_InputIndicatorOverlay"
            | "TaskListThumbnailWnd"
            | "DummyDWMListenerWindow"
            | "ApplicationFrameWindow_hidden"
            | "UAC_InputIndicatorOverlayWnd"
            | "ForegroundStaging"
            | "Shell_TrayWnd"
            | "Progman"
            | "Windows.UI.Core.CoreWindow"
    )
}

/// Every top-level window of the desktop in Z order, top first.
pub fn enumerate(hdesk: HDESK) -> Vec<WindowInfo> {
    let mut out: Vec<WindowInfo> = Vec::new();
    unsafe extern "system" fn cb(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let sink = &mut *(lparam as *mut Vec<WindowInfo>);
        sink.push(info_of(hwnd));
        1
    }
    unsafe {
        EnumDesktopWindows(hdesk, cb, &mut out as *mut _ as LPARAM);
    }
    out
}

/// Windows worth showing/compositing: visible, not minimized, real apps.
///
/// Tool windows and owner-less overlays are filtered by class here; anything with no
/// title AND no child window is also dropped, because input aimed at such a window is
/// silently swallowed (this is how a stray `UAC_InputIndicatorOverlayWnd` stole typed
/// characters in an early build).
pub fn visible_windows(hdesk: HDESK) -> Vec<WindowInfo> {
    enumerate(hdesk)
        .into_iter()
        .filter(|w| {
            if !w.visible || w.minimized {
                return false;
            }
            if is_system_class(&w.class) {
                return false;
            }
            if w.rect.right - w.rect.left <= 1 || w.rect.bottom - w.rect.top <= 1 {
                return false;
            }
            true
        })
        .collect()
}

/// Deepest child window at a screen point, plus the point in that window's client coordinates.
///
/// Walks down the child chain with `ChildWindowFromPointEx(..., CWP_ALL)`, which also
/// returns invisible/disabled children on purpose: text editors and Chromium's render
/// widget must be hit even when `IsWindowVisible` is false for them.
pub fn hit_test(top: HWND, screen_pt: POINT) -> (HWND, POINT) {
    let mut cur = top;
    // Point in `cur`'s client coordinates.
    let mut pt = screen_pt;
    unsafe {
        ScreenToClient(cur, &mut pt);
    }
    for _ in 0..24 {
        let child = unsafe { ChildWindowFromPointEx(cur, pt, CWP_ALL) };
        if child.is_null() || child == cur {
            break;
        }
        // Convert cur-client -> child-client
        let mut screen = pt;
        unsafe { ClientToScreen(cur, &mut screen) };
        let mut cp = screen;
        unsafe { ScreenToClient(child, &mut cp) };
        cur = child;
        pt = cp;
    }
    (cur, pt)
}

/// All descendant windows (depth-first) of `top`.
pub fn children(top: HWND) -> Vec<HWND> {
    let mut out: Vec<HWND> = Vec::new();
    unsafe extern "system" fn cb(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let sink = &mut *(lparam as *mut Vec<HWND>);
        sink.push(hwnd);
        1
    }
    unsafe {
        EnumChildWindows(top, cb, &mut out as *mut _ as LPARAM);
    }
    out
}


