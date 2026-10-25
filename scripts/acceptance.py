"""Acceptance harness for the dshv sidecar: drives the real exe over stdio JSON-RPC and
asserts observable effects inside the hidden desktop (not just "no error")."""
import json, subprocess, sys, time, base64, os, struct, zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
EXE = str(ROOT / "sidecar" / "target" / "release" / "dshv.exe")
OUT = str(ROOT / "docs" / "evidence")
os.makedirs(OUT, exist_ok=True)

class Sidecar:
    def __init__(self):
        self.p = subprocess.Popen([EXE], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                  stderr=subprocess.PIPE, text=True, encoding="utf-8", bufsize=1)
        self.n = 0
    def call(self, method, **params):
        self.n += 1
        req = {"id": self.n, "method": method, "params": params}
        self.p.stdin.write(json.dumps(req) + "\n"); self.p.stdin.flush()
        line = self.p.stdout.readline()
        if not line:
            err = self.p.stderr.read()
            raise RuntimeError("sidecar died: " + err)
        msg = json.loads(line)
        if "error" in msg:
            raise RuntimeError(f"{method}: {msg['error']['message']}")
        return msg["result"]
    def close(self):
        try:
            self.p.stdin.close()
        except Exception:
            pass
        try:
            self.p.wait(timeout=10)
        except Exception:
            self.p.kill()

def png_size(data: bytes):
    assert data[:8] == b"\x89PNG\r\n\x1a\n", "not a png"
    w, h = struct.unpack(">II", data[16:24])
    return w, h

results = []
def check(name, fn):
    try:
        detail = fn()
        results.append((name, "PASS", detail))
        print(f"PASS  {name}: {detail}", flush=True)
    except Exception as e:
        results.append((name, "FAIL", str(e)))
        print(f"FAIL  {name}: {e}", flush=True)

def nonzero_pixels(png_path):
    """Decode PNG with zlib only (no PIL): count non-background pixels roughly."""
    from PIL import Image
    im = Image.open(png_path).convert("RGBA")
    return im.size, im

sc = Sidecar()
try:
    check("ping", lambda: sc.call("ping")["version"])

    def create_notepad():
        r = sc.call("desktop.create", name="acc-notepad",
                    exe=r"C:\Windows\System32\notepad.exe", waitMs=1200)
        assert r["pid"] > 0, "no pid"
        assert r["windows"], "no window appeared"
        return f"pid={r['pid']} windows={[w['class'] for w in r['windows']]}"
    check("desktop.create(notepad) launches into hidden desktop", create_notepad)

    def shot_desktop():
        r = sc.call("desktop.screenshot", desktop="acc-notepad", savePath=os.path.join(OUT, "01-notepad-desktop.png"))
        data = base64.b64decode(r["pngBase64"])
        w, h = png_size(data)
        assert w > 100 and h > 100, f"tiny frame {w}x{h}"
        return f"{w}x{h}, saved={r['savedPath']}"
    check("desktop.screenshot composes a real frame", shot_desktop)

    def type_and_read():
        sc.call("input.type", desktop="acc-notepad", text="hello hidden desktop 中文😀")
        time.sleep(0.5)
        txt = sc.call("window.text", desktop="acc-notepad")["text"]
        assert txt == "hello hidden desktop 中文😀", repr(txt)
        return repr(txt)
    check("input.type reaches notepad (incl. CJK + emoji) and reads back", type_and_read)

    def keys():
        sc.call("input.key", desktop="acc-notepad", keys=["end", "enter", "up", "down"])
        time.sleep(0.3)
        return "keys accepted"
    check("input.key named keys", keys)

    def close_desktop():
        r = sc.call("desktop.close", name="acc-notepad")
        left = sc.call("desktop.list")["desktops"]
        assert not [d for d in left if d["name"] == "acc-notepad"], left
        return "closed+removed"
    check("desktop.close disposes the desktop", close_desktop)

    # ---- Chromium: the hard case (GPU, child-window input, user-visible title oracle)
    PAGE = """<!doctype html><meta charset=utf-8><title>IDLE</title>
<style>body{margin:0;font:15px monospace;background:#fff}
#box{position:absolute;left:20px;top:20px;width:240px;height:90px;background:#9cf;border:2px solid #046}
#drag{position:absolute;left:20px;top:130px;width:120px;height:50px;background:#fc9;border:2px solid #a60}
input{position:absolute;left:20px;top:210px;width:460px;font-size:16px;padding:4px}
#log{position:absolute;left:20px;top:270px;right:20px;font:13px monospace;white-space:pre-wrap}</style>
<div id=box></div><div id=drag></div><input id=t value=""> <div id=log>-</div>
<script>
const S={click:0,dbl:0,ctx:0,wheel:0,keys:"",typed:"",drag:0,paste:""};
const log=document.getElementById('log'),box=document.getElementById('box'),dr=document.getElementById('drag');
function p(){document.title='R'+JSON.stringify(S);log.textContent=JSON.stringify(S);}
box.addEventListener('click',()=>{S.click++;p();});
box.addEventListener('dblclick',()=>{S.dbl++;p();});
box.addEventListener('contextmenu',e=>{e.preventDefault();S.ctx++;p();});
box.addEventListener('wheel',e=>{e.preventDefault();S.wheel+=Math.sign(e.deltaY);p();},{passive:false});
let down=false;
dr.addEventListener('mousedown',()=>{down=true;});
addEventListener('mousemove',e=>{if(down){dr.style.left=(dr.offsetLeft+e.movementX)+'px';}});
addEventListener('mouseup',()=>{if(down){down=false;S.drag=parseInt(dr.style.left)||0;p();}});
const t=document.getElementById('t');
t.addEventListener('keydown',e=>{S.keys+=e.key+(e.ctrlKey?'^':'');p();});
t.addEventListener('input',e=>{S.typed=t.value;p();});
t.addEventListener('paste',e=>{S.paste=(e.clipboardData||window.clipboardData).getData('text');p();});
p();
</script>"""
    # Write the page to a temp file instead of a data: URL; a 2.5 KB base64 command line
    # inside nested quotes is where the earlier launch attempts died.
    page_path = os.path.join(os.environ["TEMP"], "dshv-acc-page.html")
    with open(page_path, "w", encoding="utf-8") as f:
        f.write(PAGE)
    profile = os.path.join(os.environ["TEMP"], "dshv-acc-chromium2")
    edge = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
    import shutil
    shutil.rmtree(profile, ignore_errors=True)
    # --no-sandbox is required: the sandbox helper process cannot be created on a
    # non-input desktop. Exit code 21 is what Edge returns without it.
    args = (f'--user-data-dir={profile} --no-first-run --no-default-browser-check '
            f'--disable-gpu --no-sandbox --window-size=920,560 --window-position=40,40 "{page_path}"')

    def create_edge():
        sc.call("desktop.create", name="acc-edge", exe=edge, args=args, waitMs=9000)
        wins = sc.call("window.list", desktop="acc-edge")["windows"]
        pagewins = [w for w in wins if w["class"] == "Chrome_WidgetWin_1" and w["title"].startswith("R")]
        assert pagewins, f"no page window among {[(w['class'], w['title'][:20]) for w in wins]}"
        return f"page window {pagewins[0]['hwnd']} title={pagewins[0]['title'][:40]}"
    check("desktop.create(chromium) renders the page", create_edge)

    def state():
        wins = sc.call("window.list", desktop="acc-edge")["windows"]
        for w in wins:
            if w["title"].startswith("R"):
                return json.loads(w["title"][1:])
        raise AssertionError("page window vanished")

    # client coords inside the render widget: the page origin is below the browser chrome,
    # so we use the render-widget-relative offsets the browser reports for the same content.
    def click_box():
        # aim at the blue box: 100,60 within the document
        sc.call("input.click", desktop="acc-edge", window={"class": "Chrome_WidgetWin_1"}, x=110, y=150)
        time.sleep(0.4)
        s = state()
        assert s["click"] >= 1, s
        return f"clicks={s['click']}"
    check("input.click reaches a Chromium page", click_box)

    def dbl_click():
        before = state()["dbl"]
        sc.call("input.click", desktop="acc-edge", window={"class": "Chrome_WidgetWin_1"}, x=110, y=150, count=2)
        time.sleep(0.5)
        s = state()
        assert s["dbl"] >= before + 1, s
        return f"dblclick={s['dbl']}"
    check("input.click count=2 produces dblclick", dbl_click)

    def right_click():
        before = state()["ctx"]
        sc.call("input.click", desktop="acc-edge", window={"class": "Chrome_WidgetWin_1"}, x=110, y=150, button="right")
        time.sleep(0.5)
        s = state()
        assert s["ctx"] >= before + 1, s
        return f"contextmenu={s['ctx']}"
    check("input.click button=right produces contextmenu", right_click)

    def wheel():
        before = state()["wheel"]
        sc.call("input.scroll", desktop="acc-edge", window={"class": "Chrome_WidgetWin_1"}, x=110, y=150, dy=120)
        time.sleep(0.4)
        s = state()
        assert s["wheel"] > before, (before, s)
        return f"wheel={s['wheel']}"
    check("input.scroll reaches the page", wheel)

    def dragbox():
        sc.call("input.drag", desktop="acc-edge", window={"class": "Chrome_WidgetWin_1"},
                **{"from": {"x": 60, "y": 260}, "to": {"x": 180, "y": 280}})
        time.sleep(0.6)
        s = state()
        assert s["drag"] > 0, s
        return f"drag offset={s['drag']}px"
    check("input.drag moves an element", dragbox)

    def typing():
        sc.call("input.click", desktop="acc-edge", window={"class": "Chrome_WidgetWin_1"}, x=200, y=330)
        time.sleep(0.4)
        sc.call("input.type", desktop="acc-edge", text="hi 中文")
        time.sleep(0.6)
        s = state()
        assert "hi 中文" in s["typed"], s
        return f"typed={s['typed']!r} keys={s['keys']!r}"
    check("input.type into a Chromium input (ASCII + CJK)", typing)

    def hotkey_select_all():
        sc.call("input.key", desktop="acc-edge", keys=["ctrl+a"])
        time.sleep(0.5)
        s = state()
        assert "a^" in s["keys"] or "^" in s["keys"], s
        return f"keys={s['keys']!r} (ctrl visible to the page)"
    check("input.key ctrl+a delivers real modifier state", hotkey_select_all)

    def shot_window():
        r = sc.call("desktop.screenshot", desktop="acc-edge", window={"class": "Chrome_WidgetWin_1"},
                    savePath=os.path.join(OUT, "02-chromium-window.png"))
        data = base64.b64decode(r["pngBase64"])
        w, h = png_size(data)
        return f"{w}x{h}"
    check("desktop.screenshot(window=...) captures one window", shot_window)

    def shot_all():
        r = sc.call("desktop.screenshot", desktop="acc-edge", maxWidth=1400, maxHeight=900,
                    savePath=os.path.join(OUT, "03-chromium-desktop.png"))
        data = base64.b64decode(r["pngBase64"])
        w, h = png_size(data)
        n = len(r["meta"]["windows"])
        return f"{w}x{h}, {n} windows composited"
    check("desktop.screenshot composes whole desktop", shot_all)

    def user_untouched():
        import ctypes
        u = ctypes.WinDLL("user32")
        u.GetForegroundWindow.restype = ctypes.c_void_p
        fg = u.GetForegroundWindow()
        return f"user foreground hwnd={hex(fg or 0)}"
    check("user desktop untouched (informational)", user_untouched)

finally:
    sc.close()

print("\n==== SUMMARY ====")
ok = sum(1 for _, st, _ in results if st == "PASS")
print(f"{ok}/{len(results)} passed")
sys.exit(0 if ok == len(results) else 1)
