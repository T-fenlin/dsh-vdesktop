//! Sidecar: owns virtual desktops, launches apps into them, captures, and injects input.
//!
//! Protocol: line-delimited JSON over stdio.
//!   request  {"id":1,"method":"desktop.create","params":{...}}
//!   response {"id":1,"result":{...}}  |  {"id":1,"error":{"code":int,"message":str}}
//!
//! Every desktop lives on its own worker thread. That is not a style choice: a thread may
//! only change its desktop while it owns no windows and has no message queue, so desktop
//! creation, process launch, input and capture for one desktop all run on that thread.

mod capture;
mod input;
mod win32;
mod window;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::ffi::c_void;
use std::io::{BufRead, Write};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use win32::*;

// ------------------------------------------------------------------ protocol

#[derive(Deserialize)]
struct Request {
    #[serde(default)]
    id: u64,
    method: String,
    #[serde(default)]
    params: Value,
}

#[derive(Serialize)]
struct RpcError {
    code: i64,
    message: String,
}

fn emit(value: Value) {
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{value}");
    let _ = out.flush();
}

fn reply_ok(id: u64, result: Value) {
    emit(json!({ "id": id, "result": result }));
}

fn reply_err(id: u64, code: i64, message: impl Into<String>) {
    emit(json!({ "id": id, "error": RpcError { code, message: message.into() } }));
}

// ------------------------------------------------------------------ desktop workers

type Job = Box<dyn FnOnce() + Send>;

#[derive(Clone)]
struct WorkerCtx {
    /// Desktop name; CreateProcessW needs it explicitly because a NULL lpDesktop means
    /// "inherit the calling PROCESS's desktop", not the calling thread's.
    name: String,
    hdesk: HDESK,
}

#[derive(Clone)]
struct DesktopHandle {
    name: String,
    tx: Sender<Job>,
    created: Instant,
    /// (pid, raw process handle) so we can query liveness and terminate on close.
    pids: Arc<Mutex<Vec<(u32, usize)>>>,
}

impl DesktopHandle {
    /// Run one closure on this desktop's worker thread and wait for its result.
    fn run_with_ctx<T, F>(&self, f: F) -> Result<T, String>
    where
        T: Send + 'static,
        F: FnOnce(&WorkerCtx) -> Result<T, String> + Send + 'static,
    {
        let (tx, rx) = channel::<Result<T, String>>();
        let sender: Sender<Result<T, String>> = tx;
        let name = self.name.clone();
        let job: Job = Box::new(move || {
            let ctx = CURRENT.with(|c| c.borrow().clone());
            let out = match ctx {
                Some(ctx) => f(&ctx),
                None => Err(format!("worker for desktop '{name}' lost its context")),
            };
            let _ = sender.send(out);
        });
        self.tx.send(job).map_err(|_| "desktop worker is gone".to_string())?;
        rx.recv_timeout(Duration::from_secs(120))
            .map_err(|_| "desktop worker timed out".to_string())?
    }
}

struct App {
    desktops: Mutex<HashMap<String, DesktopHandle>>,
}

impl App {
    fn get(&self, name: &str) -> Result<DesktopHandle, String> {
        self.desktops
            .lock()
            .unwrap()
            .get(name)
            .cloned()
            .ok_or_else(|| format!("no desktop named '{name}' (create one with desktop.create)"))
    }
}

thread_local! {
    /// Present only on a desktop worker thread.
    static CURRENT: std::cell::RefCell<Option<WorkerCtx>> = const { std::cell::RefCell::new(None) };
}

/// Create the desktop on the CALLING thread, then spawn a worker that attaches to it.
///
/// Creating the desktop inside the worker thread instead is the obvious shape and works
/// for Notepad, but Chromium (Edge/Chrome) then behaves badly. Creating on the caller's
/// thread and attaching in the worker keeps every windowing constraint intact (a thread
/// may only change its desktop while it owns no windows and has no message queue) and is
/// the arrangement every real launcher uses.
fn create_worker(name: &str) -> Result<Sender<Job>, String> {
    let wname = wide(name);
    let hdesk = unsafe {
        CreateDesktopW(
            wname.as_ptr(),
            std::ptr::null(),
            std::ptr::null_mut(),
            0,
            DESKTOP_ALL_ACCESS,
            std::ptr::null_mut(),
        )
    };
    if hdesk.is_null() {
        return Err(format!("CreateDesktopW failed (winerror={})", last_error()));
    }
    let (tx, rx) = channel::<Job>();
    let (ready_tx, ready_rx) = channel::<Result<(), String>>();
    let owned = name.to_string();
    // An HDESK is a raw pointer; only this one worker ever touches it.
    let hdesk_raw = hdesk as usize;
    std::thread::Builder::new()
        .name(format!("dshv-{owned}"))
        .spawn(move || {
            let hdesk = hdesk_raw as HDESK;
            if unsafe { SetThreadDesktop(hdesk) } == 0 {
                let err = last_error();
                unsafe { CloseDesktop(hdesk) };
                let _ = ready_tx.send(Err(format!("SetThreadDesktop failed (winerror={err})")));
                return;
            }
            CURRENT.with(|c| *c.borrow_mut() = Some(WorkerCtx { name: owned.clone(), hdesk }));
            let _ = ready_tx.send(Ok(()));
            while let Ok(job) = rx.recv() {
                job();
            }
            CURRENT.with(|c| *c.borrow_mut() = None);
            unsafe {
                CloseDesktop(hdesk);
            }
        })
        .map_err(|e| {
            unsafe { CloseDesktop(hdesk_raw as HDESK) };
            e.to_string()
        })?;
    ready_rx
        .recv_timeout(Duration::from_secs(20))
        .map_err(|_| "desktop worker startup timed out".to_string())??;
    Ok(tx)
}

// ------------------------------------------------------------------ process launch

/// Serialize the current environment into the NUL-separated, double-NUL-terminated block
/// CreateProcessW expects.
///
/// This matters more than it looks: passing NULL for lpEnvironment makes the child start
/// with an EMPTY environment, and Chromium then exits with code 21 immediately. The block
/// must also be sorted case-insensitively by name and paired with
/// CREATE_UNICODE_ENVIRONMENT, or CreateProcessW fails with ERROR_INVALID_PARAMETER.
fn build_env_block() -> Vec<u16> {
    let mut pairs: Vec<(String, String)> = std::env::vars_os()
        .map(|(k, v)| (k.to_string_lossy().into_owned(), v.to_string_lossy().into_owned()))
        .filter(|(k, v)| !k.is_empty() && !k.contains('=') && !k.contains('\0') && !v.contains('\0'))
        .collect();
    pairs.sort_by(|a, b| a.0.to_lowercase().cmp(&b.0.to_lowercase()));
    let mut block: Vec<u16> = Vec::new();
    for (k, v) in pairs {
        block.extend(k.encode_utf16());
        block.push('=' as u16);
        block.extend(v.encode_utf16());
        block.push(0);
    }
    block.push(0);
    block
}

/// Launch a process onto `desktop`; returns (pid, tid, raw process handle).
fn launch(
    exe: &str,
    args: &str,
    cwd: Option<&str>,
    desktop: Option<&str>,
) -> Result<(u32, u32, usize), String> {
    let mut cmdline = format!("\"{exe}\"");
    if !args.is_empty() {
        cmdline.push(' ');
        cmdline.push_str(args);
    }
    let mut cmd = wide(&cmdline);
    let cwd_w = cwd.map(wide);
    let mut desk_w = desktop.map(wide);
    let env_block = build_env_block();
    let mut si = STARTUPINFOW::default();
    si.cb = std::mem::size_of::<STARTUPINFOW>() as u32;
    si.lpDesktop = desk_w
        .as_mut()
        .map(|v| v.as_mut_ptr())
        .unwrap_or(std::ptr::null_mut());
    // Give the child its own NUL device as std handles. Without this the child inherits
    // nothing usable, and worse: a child that writes to "stdout" can end up writing into
    // this sidecar's JSON-RPC pipe and corrupt the protocol stream. Chromium-family and
    // Electron-family apps also abort early when their standard handles are bogus.
    let nul = open_nul();
    if !nul.is_null() {
        si.dwFlags |= 0x0000_0100; // STARTF_USESTDHANDLES
        si.hStdInput = nul;
        si.hStdOutput = nul;
        si.hStdError = nul;
    }
    let mut pi = PROCESS_INFORMATION::default();
    let ok = unsafe {
        CreateProcessW(
            std::ptr::null(),
            cmd.as_mut_ptr(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            // Only inheritance of the three standard handles above is requested.
            if nul.is_null() { 0 } else { 1 },
            // A UTF-16 environment block requires this flag; without it CreateProcessW
            // treats the block as ANSI and fails with ERROR_INVALID_PARAMETER (87).
            CREATE_UNICODE_ENVIRONMENT,
            env_block.as_ptr() as *const c_void,
            cwd_w.as_ref().map(|v| v.as_ptr()).unwrap_or(std::ptr::null()),
            &mut si,
            &mut pi,
        )
    };
    if ok == 0 {
        return Err(format!(
            "CreateProcess failed for '{exe}' (winerror={})",
            last_error()
        ));
    }
    // Keep the process handle open so callers can still query liveness.
    let hproc = pi.hProcess as usize;
    unsafe {
        CloseHandle(pi.hThread);
        if !nul.is_null() {
            CloseHandle(nul);
        }
    }
    Ok((pi.dwProcessId, pi.dwThreadId, hproc))
}

/// Open the NUL device for the child's standard handles.
fn open_nul() -> HANDLE {
    let name = wide("NUL");
    unsafe {
        CreateFileW(
            name.as_ptr(),
            0x8000_0000 | 0x4000_0000, // GENERIC_READ | GENERIC_WRITE
            0x0000_0003,               // FILE_SHARE_READ | FILE_SHARE_WRITE
            std::ptr::null_mut(),
            3, // OPEN_EXISTING
            0,
            std::ptr::null_mut(),
        )
    }
}

fn kill_pid(pid: u32) {
    unsafe {
        // PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION
        let h = OpenProcess(0x0001 | 0x1000, 0, pid);
        if !h.is_null() {
            TerminateProcess(h, 1);
            CloseHandle(h);
        }
    }
}

// ------------------------------------------------------------------ helpers

fn need<'a>(p: &'a Value, key: &str) -> Result<&'a Value, String> {
    p.get(key).ok_or_else(|| format!("missing parameter: {key}"))
}

fn need_str<'a>(p: &'a Value, key: &str) -> Result<&'a str, String> {
    need(p, key)?.as_str().ok_or_else(|| format!("{key} must be a string"))
}

fn opt_i32(p: &Value, key: &str, dflt: i32) -> i32 {
    p.get(key).and_then(|v| v.as_i64()).map(|v| v as i32).unwrap_or(dflt)
}

fn opt_u32(p: &Value, key: &str, dflt: u32) -> u32 {
    p.get(key).and_then(|v| v.as_i64()).map(|v| v as u32).unwrap_or(dflt)
}

fn opt_str<'a>(p: &'a Value, key: &str) -> Option<&'a str> {
    p.get(key).and_then(|v| v.as_str())
}

fn window_json(w: &window::WindowInfo) -> Value {
    json!({
        "hwnd": format!("{:#x}", w.hwnd),
        "title": w.title,
        "class": w.class,
        "pid": w.pid,
        "rect": [w.rect.left, w.rect.top, w.rect.right - w.rect.left, w.rect.bottom - w.rect.top],
        "minimized": w.minimized,
    })
}

fn parse_hwnd(s: &str) -> Option<HWND> {
    let hex = s.strip_prefix("0x")?;
    usize::from_str_radix(hex, 16).ok().map(|v| v as HWND)
}

/// Resolve a window selector: `"0x1234"`, `{"hwnd":..}`, `{"pid":..}`, `{"title":..}`,
/// `{"class":..}` (object keys are optional and ANDed). `null` picks the front-most app
/// window.
fn resolve_window(hdesk: HDESK, sel: &Value) -> Result<HWND, String> {
    if let Some(s) = sel.as_str() {
        if let Some(v) = parse_hwnd(s) {
            return Ok(v);
        }
    }
    let wins = window::visible_windows(hdesk);
    if let Some(o) = sel.as_object() {
        if let Some(h) = o.get("hwnd").and_then(|v| v.as_str()).and_then(parse_hwnd) {
            return Ok(h);
        }
        let want_pid = o.get("pid").and_then(|v| v.as_u64()).map(|v| v as u32);
        let want_title = o.get("title").and_then(|v| v.as_str());
        let want_class = o.get("class").and_then(|v| v.as_str());
        for w in &wins {
            let pid_ok = want_pid.map(|p| p == w.pid).unwrap_or(true);
            let title_ok = want_title.map(|t| w.title == t || w.title.contains(t)).unwrap_or(true);
            let class_ok = want_class.map(|c| w.class == c || w.class.contains(c)).unwrap_or(true);
            if pid_ok && title_ok && class_ok {
                return Ok(w.hwnd as HWND);
            }
        }
        return Err("no window matched the selector".to_string());
    }
    wins.first()
        .map(|w| w.hwnd as HWND)
        .ok_or_else(|| "desktop has no visible window".to_string())
}

/// Pick the control that should receive typed characters.
///
/// Whitelists classic edit classes and Chromium's render widget, and only falls back to a
/// point-based hit test when neither exists. A point-based pick is unreliable for windows
/// whose client area has no real child at the sampled pixel.
fn text_target(top: HWND) -> HWND {
    const PREFERRED: [&str; 6] = [
        "Edit",
        "RichEdit20W",
        "RichEdit50W",
        "Scintilla",
        "Chrome_RenderWidgetHostHWND",
        "MozillaWindowClass",
    ];
    let kids = window::children(top);
    for want in PREFERRED {
        for &k in &kids {
            if window::class_of(k) == want {
                return k;
            }
        }
    }
    for &k in &kids {
        let c = window::class_of(k);
        if c.starts_with("Edit") || c.starts_with("RichEdit") {
            return k;
        }
    }
    // No known control child: the window itself handles typing (Notepad's single-area
    // editor is the classic case).
    if kids.is_empty() {
        return top;
    }
    let mut pt = POINT { x: 0, y: 0 };
    unsafe {
        let mut r = RECT::default();
        GetClientRect(top, &mut r);
        pt.x = (r.right - r.left) / 2;
        pt.y = (r.bottom - r.top) / 2;
        ClientToScreen(top, &mut pt);
    }
    let (t, _) = window::hit_test(top, pt);
    if t.is_null() || t == top {
        top
    } else {
        t
    }
}

fn base64_encode(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    for chunk in data.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { T[n as usize & 63] as char } else { '=' });
    }
    out
}

fn process_state(hproc: usize) -> (bool, i64) {
    if hproc == 0 {
        return (false, -1);
    }
    unsafe {
        let mut code: u32 = 0;
        let ok = GetExitCodeProcess(hproc as HANDLE, &mut code);
        (ok != 0 && code == 259, code as i64) // 259 == STILL_ACTIVE
    }
}

// ------------------------------------------------------------------ methods

fn dispatch(app: &App, method: &str, params: Value) -> Result<Value, String> {
    match method {
        "ping" => Ok(json!({ "ok": true, "version": env!("CARGO_PKG_VERSION") })),

        "desktop.list" => {
            let list: Vec<Value> = app
                .desktops
                .lock()
                .unwrap()
                .values()
                .map(|d| {
                    json!({
                        "name": d.name,
                        "ageMs": d.created.elapsed().as_millis(),
                        "pids": d.pids.lock().unwrap().len(),
                    })
                })
                .collect();
            Ok(json!({ "desktops": list }))
        }

        "desktop.create" => {
            let name = need_str(&params, "name")?.to_string();
            if app.desktops.lock().unwrap().contains_key(&name) {
                return Err(format!("desktop '{name}' already exists"));
            }
            let exe = need_str(&params, "exe")?.to_string();
            let args = opt_str(&params, "args").unwrap_or("").to_string();
            let cwd = opt_str(&params, "cwd").map(|s| s.to_string());
            let pids = Arc::new(Mutex::new(Vec::<(u32, usize)>::new()));
            let tx = create_worker(&name)?;
            let handle = DesktopHandle {
                name: name.clone(),
                tx,
                created: Instant::now(),
                pids: pids.clone(),
            };

            let exe2 = exe.clone();
            let args2 = args.clone();
            let cwd2 = cwd.clone();
            // An empty `exe` creates a bare desktop. The plugin uses this for apps that
            // must be started by an external helper host (see docs/verification.md).
            let (pid, tid, hproc) = if exe.trim().is_empty() {
                (0u32, 0u32, 0usize)
            } else {
                let (p, t, h) = handle
                    .run_with_ctx(move |ctx| launch(&exe2, &args2, cwd2.as_deref(), Some(&ctx.name)))?;
                pids.lock().unwrap().push((p, h));
                (p, t, h)
            };

            // Give the app a moment to create its first window, then report what appeared.
            std::thread::sleep(Duration::from_millis(opt_u32(&params, "waitMs", 900) as u64));
            let found = handle.run_with_ctx(move |ctx| {
                Ok(window::visible_windows(ctx.hdesk)
                    .iter()
                    .map(window_json)
                    .collect::<Vec<Value>>())
            })?;
            let (alive, exit_code) = process_state(hproc);
            app.desktops.lock().unwrap().insert(name.clone(), handle);
            Ok(json!({
                "desktop": name,
                "pid": pid,
                "tid": tid,
                "exe": exe,
                "args": args,
                "alive": alive,
                "exitCode": exit_code,
                "windows": found,
            }))
        }

        "desktop.close" => {
            let name = need_str(&params, "name")?.to_string();
            let handle = app
                .desktops
                .lock()
                .unwrap()
                .remove(&name)
                .ok_or_else(|| format!("no desktop named '{name}'"))?;
            let pids = handle.pids.lock().unwrap().clone();
            for (p, _h) in pids {
                kill_pid(p);
            }
            drop(handle);
            Ok(json!({ "closed": name }))
        }

        "desktop.sweep" => {
            let live = app.desktops.lock().unwrap().len();
            Ok(json!({ "live": live }))
        }

        "window.list" => {
            let name = need_str(&params, "desktop")?;
            let all = params.get("all").and_then(|v| v.as_bool()).unwrap_or(false);
            let h = app.get(name)?;
            let wins = h.run_with_ctx(move |ctx| {
                Ok(if all {
                    window::enumerate(ctx.hdesk)
                } else {
                    window::visible_windows(ctx.hdesk)
                })
            })?;
            Ok(json!({ "windows": wins.iter().map(window_json).collect::<Vec<_>>() }))
        }

        "window.children" => {
            let name = need_str(&params, "desktop")?;
            let target = params.get("window").cloned();
            let h = app.get(name)?;
            let kids = h.run_with_ctx(move |ctx| {
                let top = match &target {
                    Some(sel) if !sel.is_null() => resolve_window(ctx.hdesk, sel)?,
                    _ => resolve_window(ctx.hdesk, &Value::Null)?,
                };
                Ok(window::children(top)
                    .into_iter()
                    .map(|k| {
                        let r = window::rect_of(k);
                        json!({
                            "hwnd": format!("{:#x}", k as usize),
                            "class": window::class_of(k),
                            "visible": unsafe { IsWindowVisible(k) } != 0,
                            "rect": [r.left, r.top, r.right - r.left, r.bottom - r.top],
                        })
                    })
                    .collect::<Vec<Value>>())
            })?;
            Ok(json!({ "children": kids }))
        }

        "desktop.screenshot" => {
            let name = need_str(&params, "desktop")?;
            let max_w = opt_i32(&params, "maxWidth", 1600);
            let max_h = opt_i32(&params, "maxHeight", 1000);
            let target = params.get("window").cloned();
            let h = app.get(name)?;
            let (png_bytes, w, hgt, meta) = h.run_with_ctx(move |ctx| match target {
                Some(sel) if !sel.is_null() => {
                    let hwnd = resolve_window(ctx.hdesk, &sel)?;
                    let r = window::rect_of(hwnd);
                    let ww = r.right - r.left;
                    let hh = r.bottom - r.top;
                    let bits = capture::capture_window(hwnd, ww, hh)
                        .ok_or_else(|| "PrintWindow returned no pixels for that window".to_string())?;
                    let mut c = capture::Canvas::new(ww, hh);
                    c.blit_bgra(&bits, ww, hh, 0, 0);
                    let c = c.scaled(max_w, max_h);
                    let rgba = c.to_rgba();
                    let png = capture::encode_png(&rgba, c.width as u32, c.height as u32)?;
                    Ok((png, c.width, c.height, json!({ "rect": [r.left, r.top, ww, hh] })))
                }
                _ => {
                    let (c, wins) = capture::compose(ctx.hdesk, max_w, max_h);
                    let rgba = c.to_rgba();
                    let png = capture::encode_png(&rgba, c.width as u32, c.height as u32)?;
                    Ok((
                        png,
                        c.width,
                        c.height,
                        json!({ "windows": wins.iter().map(window_json).collect::<Vec<_>>() }),
                    ))
                }
            })?;
            let saved = match opt_str(&params, "savePath") {
                Some(p) => match std::fs::write(p, &png_bytes) {
                    Ok(_) => Some(p.to_string()),
                    Err(e) => return Err(format!("could not write {p}: {e}")),
                },
                None => None,
            };
            Ok(json!({
                "pngBase64": base64_encode(&png_bytes),
                "width": w,
                "height": hgt,
                "meta": meta,
                "savedPath": saved,
            }))
        }

        "input.click" => {
            let name = need_str(&params, "desktop")?;
            let x = opt_i32(&params, "x", 0);
            let y = opt_i32(&params, "y", 0);
            let which = opt_str(&params, "button").unwrap_or("left").to_string();
            let count = opt_u32(&params, "count", 1).max(1);
            let settle = opt_u32(&params, "settleMs", 120);
            let target = params.get("window").cloned();
            let h = app.get(name)?;
            let hex = h.run_with_ctx(move |ctx| {
                let top = match &target {
                    Some(sel) if !sel.is_null() => resolve_window(ctx.hdesk, sel)?,
                    _ => resolve_window(ctx.hdesk, &Value::Null)?,
                };
                let hwnd = input::click(top, x, y, &which, count, settle)?;
                Ok(format!("{:#x}", hwnd as usize))
            })?;
            Ok(json!({ "deliveredTo": hex }))
        }

        "input.move" => {
            let name = need_str(&params, "desktop")?;
            let x = opt_i32(&params, "x", 0);
            let y = opt_i32(&params, "y", 0);
            let target = params.get("window").cloned();
            let h = app.get(name)?;
            let hex = h.run_with_ctx(move |ctx| {
                let top = match &target {
                    Some(sel) if !sel.is_null() => resolve_window(ctx.hdesk, sel)?,
                    _ => resolve_window(ctx.hdesk, &Value::Null)?,
                };
                let mut pt = POINT { x, y };
                unsafe { ClientToScreen(top, &mut pt) };
                let (t, local) = window::hit_test(top, pt);
                input::move_mouse(t, local.x, local.y, 0);
                Ok(format!("{:#x}", t as usize))
            })?;
            Ok(json!({ "deliveredTo": hex }))
        }

        "input.drag" => {
            let name = need_str(&params, "desktop")?;
            let f = need(&params, "from")?;
            let t = need(&params, "to")?;
            let (fx, fy) = (opt_i32(f, "x", 0), opt_i32(f, "y", 0));
            let (tx_, ty) = (opt_i32(t, "x", 0), opt_i32(t, "y", 0));
            let which = opt_str(&params, "button").unwrap_or("left").to_string();
            let settle = opt_u32(&params, "settleMs", 150);
            let target = params.get("window").cloned();
            let h = app.get(name)?;
            let hex = h.run_with_ctx(move |ctx| {
                let top = match &target {
                    Some(sel) if !sel.is_null() => resolve_window(ctx.hdesk, sel)?,
                    _ => resolve_window(ctx.hdesk, &Value::Null)?,
                };
                let hwnd = input::drag(top, fx, fy, tx_, ty, &which, settle)?;
                Ok(format!("{:#x}", hwnd as usize))
            })?;
            Ok(json!({ "deliveredTo": hex }))
        }

        "input.scroll" => {
            let name = need_str(&params, "desktop")?;
            let x = opt_i32(&params, "x", 0);
            let y = opt_i32(&params, "y", 0);
            let dy = opt_i32(&params, "dy", 120);
            let target = params.get("window").cloned();
            let h = app.get(name)?;
            let hex = h.run_with_ctx(move |ctx| {
                let top = match &target {
                    Some(sel) if !sel.is_null() => resolve_window(ctx.hdesk, sel)?,
                    _ => resolve_window(ctx.hdesk, &Value::Null)?,
                };
                let mut pt = POINT { x, y };
                unsafe { ClientToScreen(top, &mut pt) };
                let (t, _) = window::hit_test(top, pt);
                input::wheel(t, pt.x, pt.y, dy);
                Ok(format!("{:#x}", t as usize))
            })?;
            Ok(json!({ "deliveredTo": hex }))
        }

        "input.type" => {
            let name = need_str(&params, "desktop")?;
            let text = need_str(&params, "text")?.to_string();
            let target = params.get("window").cloned();
            let h = app.get(name)?;
            let chars = text.chars().count();
            let hex = h.run_with_ctx(move |ctx| {
                let top = match &target {
                    Some(sel) if !sel.is_null() => resolve_window(ctx.hdesk, sel)?,
                    _ => resolve_window(ctx.hdesk, &Value::Null)?,
                };
                let target_hwnd = text_target(top);
                input::type_text(target_hwnd, &text);
                Ok(format!("{:#x}", target_hwnd as usize))
            })?;
            Ok(json!({ "deliveredTo": hex, "chars": chars }))
        }

        "input.key" => {
            let name = need_str(&params, "desktop")?;
            let keys: Vec<String> = need(&params, "keys")?
                .as_array()
                .ok_or_else(|| "keys must be an array of strings".to_string())?
                .iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect();
            let target = params.get("window").cloned();
            let h = app.get(name)?;
            let hex = h.run_with_ctx(move |ctx| {
                let top = match &target {
                    Some(sel) if !sel.is_null() => resolve_window(ctx.hdesk, sel)?,
                    _ => resolve_window(ctx.hdesk, &Value::Null)?,
                };
                for k in &keys {
                    if k.contains('+') {
                        input::hotkey(top, k)?;
                    } else {
                        input::press_key(top, k)?;
                    }
                    std::thread::sleep(Duration::from_millis(40));
                }
                Ok(format!("{:#x}", top as usize))
            })?;
            Ok(json!({ "deliveredTo": hex }))
        }

        "input.setText" => {
            let name = need_str(&params, "desktop")?;
            let text = need_str(&params, "text")?.to_string();
            let target = params.get("window").cloned();
            let h = app.get(name)?;
            let ok = h.run_with_ctx(move |ctx| {
                let top = match &target {
                    Some(sel) if !sel.is_null() => resolve_window(ctx.hdesk, sel)?,
                    _ => resolve_window(ctx.hdesk, &Value::Null)?,
                };
                Ok(input::set_text(top, &text))
            })?;
            Ok(json!({ "ok": ok }))
        }

        "window.text" => {
            let name = need_str(&params, "desktop")?;
            let target = params.get("window").cloned();
            let h = app.get(name)?;
            let text = h.run_with_ctx(move |ctx| {
                let top = match &target {
                    Some(sel) if !sel.is_null() => resolve_window(ctx.hdesk, sel)?,
                    _ => resolve_window(ctx.hdesk, &Value::Null)?,
                };
                Ok(input::read_text(top))
            })?;
            Ok(json!({ "text": text }))
        }

        "window.action" => {
            let name = need_str(&params, "desktop")?;
            let action = need_str(&params, "action")?.to_string();
            let target = params.get("window").cloned();
            let h = app.get(name)?;
            let ok = h.run_with_ctx(move |ctx| {
                let top = match &target {
                    Some(sel) if !sel.is_null() => resolve_window(ctx.hdesk, sel)?,
                    _ => resolve_window(ctx.hdesk, &Value::Null)?,
                };
                Ok(input::window_action(top, &action))
            })?;
            Ok(json!({ "ok": ok }))
        }

        other => Err(format!("unknown method: {other}")),
    }
}

/// Selftest: create a desktop, launch `exe` into it, poll windows. No RPC loop involved.
fn selftest() {
    let args: Vec<String> = std::env::args().collect();
    let exe = args.get(2).cloned().unwrap_or_else(|| "notepad.exe".into());
    let rest: Vec<String> = args.iter().skip(3).cloned().collect();
    let name = format!("selftest-{}", std::process::id());
    let wname = wide(&name);
    let hdesk = unsafe {
        CreateDesktopW(
            wname.as_ptr(),
            std::ptr::null(),
            std::ptr::null_mut(),
            0,
            DESKTOP_ALL_ACCESS,
            std::ptr::null_mut(),
        )
    };
    if hdesk.is_null() {
        eprintln!("[selftest] CreateDesktopW failed: {}", last_error());
        return;
    }
    // Plain mode: no worker thread, no channels — just create and launch on this thread.
    let launched = launch(&exe, &rest.join(" "), None, Some(&name));
    let (pid, _tid, hp) = match launched {
        Ok(v) => v,
        Err(e) => {
            eprintln!("[selftest] {e}");
            return;
        }
    };
    for i in 1..=8u32 {
        std::thread::sleep(Duration::from_secs(1));
        let list: Vec<String> = window::visible_windows(hdesk)
            .into_iter()
            .map(|w| format!("{}:{}", w.class, w.title))
            .collect();
        let (alive, code) = process_state(hp);
        eprintln!("[selftest] t{}s pid={pid} alive={alive} exit={code} wins={list:?}", i);
        if !alive || list.iter().any(|w| w.starts_with("Chrome_WidgetWin_1")) {
            break;
        }
    }
    std::process::exit(0);
}

fn main() {
    if std::env::args().nth(1).as_deref() == Some("--selftest") {
        selftest();
    }
    let app = App { desktops: Mutex::new(HashMap::new()) };
    let stdin = std::io::stdin();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let req: Request = match serde_json::from_str(trimmed) {
            Ok(r) => r,
            Err(e) => {
                reply_err(0, -32700, format!("bad json: {e}"));
                continue;
            }
        };
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            dispatch(&app, &req.method, req.params)
        }));
        match result {
            Ok(Ok(v)) => reply_ok(req.id, v),
            Ok(Err(e)) => reply_err(req.id, -32000, e),
            Err(_) => reply_err(req.id, -32603, "internal panic in sidecar"),
        }
    }
    // EOF: terminate every desktop's processes so nothing is orphaned.
    let handles: Vec<DesktopHandle> = app.desktops.lock().unwrap().values().cloned().collect();
    for h in handles {
        let pids = h.pids.lock().unwrap().clone();
        for (p, _h) in pids {
            kill_pid(p);
        }
    }
}
