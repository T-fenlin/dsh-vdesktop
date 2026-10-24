//! Capture: per-window `PrintWindow` into a 32-bit DIB, then Z-order composition.
//!
//! Composition (not one big screen BitBlt) is deliberate: `GetDC(NULL)`/`BitBlt` from a
//! non-input desktop returns ACCESS_DENIED, while `PrintWindow` keeps working, and
//! `PrintWindow` alone is unaffected by whatever the user is doing on their own desktop
//! or by session lock.

use crate::win32::*;
use crate::window::{self, WindowInfo};
use std::ffi::c_void;

pub struct Canvas {
    pub width: i32,
    pub height: i32,
    /// BGRA, top-down rows (y = 0 is the top edge).
    pub pixels: Vec<u8>,
}

impl Canvas {
    pub fn new(width: i32, height: i32) -> Self {
        Self { width, height, pixels: vec![0; (width * height * 4) as usize] }
    }

    /// Copy a top-down BGRA image into this canvas at (x, y).
    pub fn blit_bgra(&mut self, src: &[u8], sw: i32, sh: i32, x: i32, y: i32) {
        if sw <= 0 || sh <= 0 {
            return;
        }
        let cw = self.width;
        let ch = self.height;
        for sy in 0..sh {
            let dy = y + sy;
            if dy < 0 || dy >= ch {
                continue;
            }
            for sx in 0..sw {
                let dx = x + sx;
                if dx < 0 || dx >= cw {
                    continue;
                }
                let si = ((sy as usize) * (sw as usize) + sx as usize) * 4;
                let di = ((dy as usize) * (cw as usize) + dx as usize) * 4;
                if si + 3 >= src.len() || di + 3 >= self.pixels.len() {
                    continue;
                }
                self.pixels[di..di + 4].copy_from_slice(&src[si..si + 4]);
            }
        }
    }

    /// Convert BGRA to RGBA, preserving top-down row order.
    pub fn to_rgba(&self) -> Vec<u8> {
        let mut out = vec![0u8; self.pixels.len()];
        for (src, dst) in self.pixels.chunks_exact(4).zip(out.chunks_exact_mut(4)) {
            dst[0] = src[2];
            dst[1] = src[1];
            dst[2] = src[0];
            dst[3] = 255;
        }
        out
    }

    /// Downscale in place-ish (nearest neighbour) to fit within max dimensions.
    pub fn scaled(&self, max_w: i32, max_h: i32) -> Canvas {
        if self.width <= max_w && self.height <= max_h {
            return Canvas { width: self.width, height: self.height, pixels: self.pixels.clone() };
        }
        let scale = f64::min(
            max_w as f64 / self.width as f64,
            max_h as f64 / self.height as f64,
        );
        let nw = ((self.width as f64) * scale).round().max(1.0) as i32;
        let nh = ((self.height as f64) * scale).round().max(1.0) as i32;
        let mut out = Canvas::new(nw, nh);
        for y in 0..nh {
            for x in 0..nw {
                let sx = ((x as f64) / scale) as i32;
                let sy = ((y as f64) / scale) as i32;
                let si = ((sy.clamp(0, self.height - 1) as usize) * (self.width as usize)
                    + sx.clamp(0, self.width - 1) as usize) * 4;
                let di = ((y as usize) * (nw as usize) + x as usize) * 4;
                out.pixels[di..di + 4].copy_from_slice(&self.pixels[si..si + 4]);
            }
        }
        out
    }
}

/// PrintWindow one window into a fresh bottom-up BGRA buffer.
pub fn capture_window(hwnd: HWND, w: i32, h: i32) -> Option<Vec<u8>> {
    if w <= 0 || h <= 0 || w > 16_384 || h > 16_384 {
        return None;
    }
    unsafe {
        // Use the window's own DC as the reference. A screen DC (GetDC(NULL)) works for
        // plain GDI windows but returns nothing for DirectComposition-backed ones
        // (Chromium/WebView2), which is why Edge and DBX captured as empty placeholders.
        let screen = GetDC(hwnd);
        if screen.is_null() {
            return None;
        }
        let mdc = CreateCompatibleDC(screen);
        let mut bi = BITMAPINFO::default();
        bi.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
        bi.bmiHeader.biWidth = w;
        bi.bmiHeader.biHeight = -h; // top-down, we flip later through Canvas
        bi.bmiHeader.biPlanes = 1;
        bi.bmiHeader.biBitCount = 32;
        bi.bmiHeader.biCompression = BI_RGB;
        let mut bits: *mut c_void = std::ptr::null_mut();
        let bmp = CreateDIBSection(screen, &bi, DIB_RGB_COLORS, &mut bits, NULL_HANDLE, 0);
        if bmp.is_null() || bits.is_null() {
            DeleteDC(mdc);
            ReleaseDC(hwnd, screen);
            return None;
        }
        let old = SelectObject(mdc, bmp);
        let mut ok = PrintWindow(hwnd, mdc, 2) != 0;
        if !ok {
            // Some GPU-composited windows only fill with flag 0.
            ok = PrintWindow(hwnd, mdc, 0) != 0;
        }
        let len = (w * h * 4) as usize;
        let slice = std::slice::from_raw_parts(bits as *const u8, len);
        let all_zero = ok && slice.iter().all(|&b| b == 0);
        let data = if ok && !all_zero { Some(slice.to_vec()) } else { None };
        SelectObject(mdc, old);
        DeleteObject(bmp);
        DeleteDC(mdc);
        ReleaseDC(hwnd, screen);
        data
    }
}

/// Compose the whole desktop: background + every visible window in Z order.
pub fn compose(hdesk: HDESK, max_w: i32, max_h: i32) -> (Canvas, Vec<WindowInfo>) {
    let wins = window::visible_windows(hdesk);
    let mut vx = i32::MAX;
    let mut vy = i32::MAX;
    let mut vr = i32::MIN;
    let mut vb = i32::MIN;
    for w in &wins {
        vx = vx.min(w.rect.left);
        vy = vy.min(w.rect.top);
        vr = vr.max(w.rect.right);
        vb = vb.max(w.rect.bottom);
    }
    if wins.is_empty() || vr <= vx || vb <= vy {
        let mut c = Canvas::new(1, 1);
        c.pixels.fill(0xFF);
        return (c, wins);
    }
    let cw = vr - vx;
    let ch = vb - vy;
    let mut canvas = Canvas::new(cw, ch);
    // neutral desktop background
    for px in canvas.pixels.chunks_mut(4) {
        px[0] = 0x1E;
        px[1] = 0x1E;
        px[2] = 0x1E;
        px[3] = 0xFF;
    }
    // Z order: first enumerated is topmost, so paint back-to-front.
    for w in wins.iter().rev() {
        let ww = w.rect.right - w.rect.left;
        let wh = w.rect.bottom - w.rect.top;
        if let Some(bits) = capture_window(w.hwnd as HWND, ww, wh) {
            canvas.blit_bgra(&bits, ww, wh, w.rect.left - vx, w.rect.top - vy);
        } else {
            // mark uncapturable window with a hatched placeholder so the agent can tell
            fill_rect(&mut canvas, w.rect.left - vx, w.rect.top - vy, ww, wh, [0x30, 0x30, 0x30, 0xFF]);
        }
    }
    let scaled = canvas.scaled(max_w, max_h);
    (scaled, wins)
}

fn fill_rect(c: &mut Canvas, x: i32, y: i32, w: i32, h: i32, rgba: [u8; 4]) {
    for yy in y..y + h {
        if yy < 0 || yy >= c.height {
            continue;
        }
        for xx in x..x + w {
            if xx < 0 || xx >= c.width {
                continue;
            }
            let i = ((yy as usize) * (c.width as usize) + xx as usize) * 4;
            c.pixels[i..i + 4].copy_from_slice(&rgba);
        }
    }
}

/// Encode top-down RGBA into PNG bytes.
pub fn encode_png(rgba: &[u8], w: u32, h: u32) -> Result<Vec<u8>, String> {
    let mut out: Vec<u8> = Vec::new();
    {
        let mut enc = png::Encoder::new(&mut out, w, h);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        enc.set_compression(png::Compression::Fast);
        let mut writer = enc.write_header().map_err(|e| e.to_string())?;
        writer.write_image_data(rgba).map_err(|e| e.to_string())?;
    }
    Ok(out)
}
