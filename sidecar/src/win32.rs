//! Minimal Win32 bindings (hand-declared so the build needs no windows-sys feature juggling).
//! Only the entry points this sidecar actually uses are declared.

#![allow(non_snake_case, non_camel_case_types, dead_code)]

use std::ffi::c_void;

pub type BOOL = i32;
pub type DWORD = u32;
pub type UINT = u32;
pub type LONG = i32;
pub type WORD = u16;
pub type WPARAM = usize;
pub type LPARAM = isize;
pub type LRESULT = isize;
pub type HANDLE = *mut c_void;
pub type HWND = HANDLE;
pub type HDC = HANDLE;
pub type HBITMAP = HANDLE;
pub type HGDIOBJ = HANDLE;
pub type HDESK = HANDLE;
pub type HINSTANCE = HANDLE;
pub type HMODULE = HANDLE;

pub const NULL_HANDLE: HANDLE = std::ptr::null_mut();

// ---------------------------------------------------------------- constants
pub const DESKTOP_ALL_ACCESS: DWORD = 0x01FF;
pub const DESKTOP_READOBJECTS: DWORD = 0x0001;
pub const DESKTOP_ENUMERATE: DWORD = 0x0040;

pub const STARTF_USESHOWWINDOW: DWORD = 0x0000_0001;
pub const SW_SHOWNORMAL: WORD = 1;
pub const CREATE_UNICODE_ENVIRONMENT: DWORD = 0x0000_0400;

pub const SRCCOPY: DWORD = 0x00CC_0020;
pub const BI_RGB: DWORD = 0;
pub const DIB_RGB_COLORS: UINT = 0;

pub const GW_HWNDNEXT: UINT = 2;

// window messages
pub const WM_KEYDOWN: UINT = 0x0100;
pub const WM_KEYUP: UINT = 0x0101;
pub const WM_CHAR: UINT = 0x0102;
pub const WM_SYSKEYDOWN: UINT = 0x0104;
pub const WM_SYSKEYUP: UINT = 0x0105;
pub const WM_MOUSEMOVE: UINT = 0x0200;
pub const WM_LBUTTONDOWN: UINT = 0x0201;
pub const WM_LBUTTONUP: UINT = 0x0202;
pub const WM_RBUTTONDOWN: UINT = 0x0204;
pub const WM_RBUTTONUP: UINT = 0x0205;
pub const WM_MBUTTONDOWN: UINT = 0x0207;
pub const WM_MBUTTONUP: UINT = 0x0208;
pub const WM_MOUSEWHEEL: UINT = 0x020A;
pub const WM_MOUSEHWHEEL: UINT = 0x020E;
pub const WM_SETTEXT: UINT = 0x000C;
pub const WM_GETTEXT: UINT = 0x000D;
pub const WM_GETTEXTLENGTH: UINT = 0x000E;
pub const WM_CLOSE: UINT = 0x0010;
pub const WM_ACTIVATE: UINT = 0x0006;
pub const WM_SETFOCUS: UINT = 0x0007;
pub const WM_NCHITTEST: UINT = 0x0084;
pub const WM_SYSCOMMAND: UINT = 0x0112;
pub const WM_GETMINMAXINFO: UINT = 0x0024;

pub const SC_MINIMIZE: WPARAM = 0xF020;
pub const SC_MAXIMIZE: WPARAM = 0xF030;
pub const SC_RESTORE: WPARAM = 0xF120;

pub const MK_LBUTTON: WPARAM = 0x0001;
pub const MK_RBUTTON: WPARAM = 0x0002;
pub const MK_MBUTTON: WPARAM = 0x0010;

pub const HTMINBUTTON: LRESULT = 8;
pub const HTMAXBUTTON: LRESULT = 9;
pub const HTCLOSE: LRESULT = 20;
pub const HTCAPTION: LRESULT = 2;
pub const HTCLIENT: LRESULT = 1;

// virtual keys
pub const VK_SHIFT: u16 = 0x10;
pub const VK_CONTROL: u16 = 0x11;
pub const VK_MENU: u16 = 0x12; // Alt
pub const VK_LWIN: u16 = 0x5B;
pub const VK_RWIN: u16 = 0x5C;
pub const VK_LSHIFT: u16 = 0xA0;
pub const VK_RSHIFT: u16 = 0xA1;
pub const VK_LCONTROL: u16 = 0xA2;
pub const VK_RCONTROL: u16 = 0xA3;
pub const VK_LMENU: u16 = 0xA4;
pub const VK_RMENU: u16 = 0xA5;

pub const SW_HIDE: i32 = 0;
pub const SW_SHOW: i32 = 5;

// ---------------------------------------------------------------- structs
#[repr(C)]
pub struct STARTUPINFOW {
    pub cb: DWORD,
    pub lpReserved: *mut u16,
    pub lpDesktop: *mut u16,
    pub lpTitle: *mut u16,
    pub dwX: DWORD,
    pub dwY: DWORD,
    pub dwXSize: DWORD,
    pub dwYSize: DWORD,
    pub dwXCountChars: DWORD,
    pub dwYCountChars: DWORD,
    pub dwFillAttribute: DWORD,
    pub dwFlags: DWORD,
    pub wShowWindow: WORD,
    pub cbReserved2: WORD,
    pub lpReserved2: *mut u8,
    pub hStdInput: HANDLE,
    pub hStdOutput: HANDLE,
    pub hStdError: HANDLE,
}

impl Default for STARTUPINFOW {
    fn default() -> Self {
        unsafe { std::mem::zeroed() }
    }
}

#[repr(C)]
pub struct PROCESS_INFORMATION {
    pub hProcess: HANDLE,
    pub hThread: HANDLE,
    pub dwProcessId: DWORD,
    pub dwThreadId: DWORD,
}

impl Default for PROCESS_INFORMATION {
    fn default() -> Self {
        unsafe { std::mem::zeroed() }
    }
}

#[repr(C)]
#[derive(Default, Clone, Copy, Debug)]
pub struct RECT {
    pub left: LONG,
    pub top: LONG,
    pub right: LONG,
    pub bottom: LONG,
}

#[repr(C)]
#[derive(Default, Clone, Copy, Debug)]
pub struct POINT {
    pub x: LONG,
    pub y: LONG,
}

#[repr(C)]
#[derive(Default)]
pub struct BITMAPINFOHEADER {
    pub biSize: DWORD,
    pub biWidth: LONG,
    pub biHeight: LONG,
    pub biPlanes: WORD,
    pub biBitCount: WORD,
    pub biCompression: DWORD,
    pub biSizeImage: DWORD,
    pub biXPelsPerMeter: LONG,
    pub biYPelsPerMeter: LONG,
    pub biClrUsed: DWORD,
    pub biClrImportant: DWORD,
}

#[repr(C)]
#[derive(Default)]
pub struct BITMAPINFO {
    pub bmiHeader: BITMAPINFOHEADER,
    pub bmiColors: [DWORD; 1],
}

pub type WNDENUMPROC = unsafe extern "system" fn(HWND, LPARAM) -> BOOL;

// ---------------------------------------------------------------- kernel32
#[link(name = "kernel32")]
extern "system" {
    pub fn CreateProcessW(
        lpApplicationName: *const u16,
        lpCommandLine: *mut u16,
        lpProcessAttributes: *mut c_void,
        lpThreadAttributes: *mut c_void,
        bInheritHandles: BOOL,
        dwCreationFlags: DWORD,
        lpEnvironment: *const c_void,
        lpCurrentDirectory: *const u16,
        lpStartupInfo: *mut STARTUPINFOW,
        lpProcessInformation: *mut PROCESS_INFORMATION,
    ) -> BOOL;


    pub fn CreateFileW(
        lpFileName: *const u16,
        dwDesiredAccess: DWORD,
        dwShareMode: DWORD,
        lpSecurityAttributes: *mut c_void,
        dwCreationDisposition: DWORD,
        dwFlagsAndAttributes: DWORD,
        hTemplateFile: HANDLE,
    ) -> HANDLE;
    pub fn GetLastError() -> DWORD;
    pub fn TerminateProcess(hProcess: HANDLE, uExitCode: UINT) -> BOOL;
    pub fn CloseHandle(hObject: HANDLE) -> BOOL;
    pub fn GetCurrentThreadId() -> DWORD;
    pub fn ProcessIdToSessionId(dwProcessId: DWORD, pSessionId: *mut DWORD) -> BOOL;
    pub fn OpenProcess(dwDesiredAccess: DWORD, bInheritHandle: BOOL, dwProcessId: DWORD) -> HANDLE;
    pub fn QueryFullProcessImageNameW(
        hProcess: HANDLE,
        dwFlags: DWORD,
        lpExeName: *mut u16,
        lpdwSize: *mut DWORD,
    ) -> BOOL;
    pub fn GetExitCodeProcess(hProcess: HANDLE, lpExitCode: *mut DWORD) -> BOOL;
    pub fn Sleep(dwMilliseconds: DWORD);
}

// ---------------------------------------------------------------- user32
#[link(name = "user32")]
extern "system" {
    pub fn CreateDesktopW(
        lpszDesktop: *const u16,
        lpszDevice: *const u16,
        pDevmode: *mut c_void,
        dwFlags: DWORD,
        dwDesiredAccess: DWORD,
        lpsa: *mut c_void,
    ) -> HDESK;

    pub fn OpenDesktopW(
        lpszDesktop: *const u16,
        dwFlags: DWORD,
        fInherit: BOOL,
        dwDesiredAccess: DWORD,
    ) -> HDESK;

    pub fn CloseDesktop(hDesktop: HDESK) -> BOOL;
    pub fn SetThreadDesktop(hDesktop: HDESK) -> BOOL;
    pub fn GetThreadDesktop(dwThreadId: DWORD) -> HDESK;
    pub fn GetProcessWindowStation() -> HANDLE;

    pub fn EnumDesktopsW(hwinsta: HANDLE, lpEnumFunc: *mut c_void, lParam: LPARAM) -> BOOL;
    pub fn EnumDesktopWindows(hDesktop: HDESK, lpfn: WNDENUMPROC, lParam: LPARAM) -> BOOL;

    pub fn GetTopWindow(hWnd: HWND) -> HWND;
    pub fn GetWindow(hWnd: HWND, uCmd: UINT) -> HWND;

    pub fn IsWindow(hWnd: HWND) -> BOOL;
    pub fn IsWindowVisible(hWnd: HWND) -> BOOL;
    pub fn IsIconic(hWnd: HWND) -> BOOL;
    pub fn IsZoomed(hWnd: HWND) -> BOOL;
    pub fn IsWindowEnabled(hWnd: HWND) -> BOOL;

    pub fn GetWindowTextLengthW(hWnd: HWND) -> i32;
    pub fn GetWindowTextW(hWnd: HWND, lpString: *mut u16, nMaxCount: i32) -> i32;
    pub fn GetClassNameW(hWnd: HWND, lpClassName: *mut u16, nMaxCount: i32) -> i32;
    pub fn SetWindowTextW(hWnd: HWND, lpString: *const u16) -> BOOL;

    pub fn GetWindowRect(hWnd: HWND, lpRect: *mut RECT) -> BOOL;
    pub fn GetClientRect(hWnd: HWND, lpRect: *mut RECT) -> BOOL;
    pub fn ClientToScreen(hWnd: HWND, lpPoint: *mut POINT) -> BOOL;
    pub fn ScreenToClient(hWnd: HWND, lpPoint: *mut POINT) -> BOOL;

    pub fn GetWindowLongPtrW(hWnd: HWND, nIndex: i32) -> isize;

    pub fn PostMessageW(hWnd: HWND, Msg: UINT, wParam: WPARAM, lParam: LPARAM) -> BOOL;
    pub fn SendMessageTimeoutW(
        hWnd: HWND,
        Msg: UINT,
        wParam: WPARAM,
        lParam: LPARAM,
        fuFlags: UINT,
        uTimeout: UINT,
        lpdwResult: *mut usize,
    ) -> LRESULT;

    pub fn SetForegroundWindow(hWnd: HWND) -> BOOL;
    pub fn GetForegroundWindow() -> HWND;
    pub fn BringWindowToTop(hWnd: HWND) -> BOOL;
    pub fn SetActiveWindow(hWnd: HWND) -> HWND;
    pub fn SetFocus(hWnd: HWND) -> HWND;
    pub fn GetFocus() -> HWND;
    pub fn AttachThreadInput(idAttach: DWORD, idAttachTo: DWORD, fAttach: BOOL) -> BOOL;
    pub fn GetWindowThreadProcessId(hWnd: HWND, lpdwProcessId: *mut DWORD) -> DWORD;
    pub fn GetKeyboardState(lpKeyState: *mut u8) -> BOOL;
    pub fn SetKeyboardState(lpKeyState: *const u8) -> BOOL;

    pub fn GetDC(hWnd: HWND) -> HDC;
    pub fn ReleaseDC(hWnd: HWND, hDC: HDC) -> i32;
    pub fn PrintWindow(hwnd: HWND, hdcBlt: HDC, nFlags: UINT) -> BOOL;
    pub fn GetSystemMetrics(nIndex: i32) -> i32;
    pub fn EnumWindows(lpEnumFunc: WNDENUMPROC, lParam: LPARAM) -> BOOL;
    pub fn EnumChildWindows(hWndParent: HWND, lpEnumFunc: WNDENUMPROC, lParam: LPARAM) -> BOOL;
    pub fn SystemParametersInfoW(uiAction: UINT, uiParam: UINT, pvParam: *mut c_void, fWinIni: UINT) -> BOOL;
    pub fn ShowWindow(hWnd: HWND, nCmdShow: i32) -> BOOL;
    pub fn SetWindowPos(
        hWnd: HWND,
        hWndInsertAfter: HWND,
        X: i32,
        Y: i32,
        cx: i32,
        cy: i32,
        uFlags: UINT,
    ) -> BOOL;
    pub fn MapWindowPoints(hWndFrom: HWND, hWndTo: HWND, lpPoints: *mut POINT, cPoints: UINT) -> i32;
    pub fn RealChildWindowFromPoint(hWndParent: HWND, pt: POINT) -> HWND;
    pub fn WindowFromPoint(pt: POINT) -> HWND;
    pub fn ChildWindowFromPointEx(hWndParent: HWND, pt: POINT, uFlags: UINT) -> HWND;
    pub fn GetParent(hWnd: HWND) -> HWND;
    pub fn GetAncestor(hWnd: HWND, gaFlags: UINT) -> HWND;
}

pub const GA_ROOT: UINT = 2;
pub const CWP_ALL: UINT = 0;
pub const SM_CXSCREEN: i32 = 0;
pub const SM_CYSCREEN: i32 = 1;

// ---------------------------------------------------------------- gdi32
#[link(name = "gdi32")]
extern "system" {
    pub fn CreateCompatibleDC(hdc: HDC) -> HDC;
    pub fn CreateCompatibleBitmap(hdc: HDC, cx: i32, cy: i32) -> HBITMAP;
    pub fn CreateDIBSection(
        hdc: HDC,
        pbmi: *const BITMAPINFO,
        usage: UINT,
        ppvBits: *mut *mut c_void,
        hSection: HANDLE,
        offset: DWORD,
    ) -> HBITMAP;
    pub fn SelectObject(hdc: HDC, h: HGDIOBJ) -> HGDIOBJ;
    pub fn DeleteObject(h: HGDIOBJ) -> BOOL;
    pub fn DeleteDC(hdc: HDC) -> BOOL;
    pub fn BitBlt(
        hdcDest: HDC,
        x: i32,
        y: i32,
        cx: i32,
        cy: i32,
        hdcSrc: HDC,
        x1: i32,
        y1: i32,
        rop: DWORD,
    ) -> BOOL;
    pub fn GetDIBits(
        hdc: HDC,
        hbm: HBITMAP,
        start: UINT,
        cLines: UINT,
        lpvBits: *mut c_void,
        lpbmi: *mut BITMAPINFO,
        usage: UINT,
    ) -> i32;
    pub fn PatBlt(hdc: HDC, x: i32, y: i32, w: i32, h: i32, rop: DWORD) -> BOOL;
}

pub const BLACKNESS: DWORD = 0x0000_0042;

// ---------------------------------------------------------------- user32 extras
#[link(name = "user32")]
extern "system" {
    pub fn GetWindowLongW(hWnd: HWND, nIndex: i32) -> i32;
    pub fn GetDesktopWindow() -> HWND;
    pub fn OpenInputDesktop(dwFlags: DWORD, fInherit: BOOL, dwDesiredAccess: DWORD) -> HDESK;
    pub fn GetUserObjectInformationW(
        hObj: HANDLE,
        nIndex: i32,
        pvInfo: *mut c_void,
        nLength: DWORD,
        lpnLengthNeeded: *mut DWORD,
    ) -> BOOL;
}

pub const UOI_NAME: i32 = 2;
pub const GWL_STYLE: i32 = -16;
pub const GWL_EXSTYLE: i32 = -20;
pub const WS_VISIBLE: i32 = 0x1000_0000;
pub const WS_CHILD: i32 = 0x4000_0000;
pub const WS_EX_TOOLWINDOW: i32 = 0x0000_0080;

/// Last Win32 error, for diagnostics.
pub fn last_error() -> DWORD {
    unsafe { GetLastError() }
}

/// Convert a Rust string to a NUL-terminated UTF-16 buffer.
pub fn wide(s: &str) -> Vec<u16> {
    let mut v: Vec<u16> = s.encode_utf16().collect();
    v.push(0);
    v
}

/// Read a Win32 wide string from a buffer filled by `GetWindowTextW` & co.
pub fn from_wide_buf(buf: &[u16], len: usize) -> String {
    let end = buf.iter().take(len).position(|&c| c == 0).unwrap_or(len);
    String::from_utf16_lossy(&buf[..end])
}
