# dsh-vdesktop

DSH 插件 + 本地 sidecar：**把 GUI 程序跑进一个你看不见的 Windows 桌面**，Agent 在那个桌面上截图、点击、打字。
你同时用微信、切窗口、锁屏，都不会让它的截图变错，也不会被它抢走鼠标键盘。

每个会话都有自己的 **「虚拟桌面」标签页**（位于「轨迹」之后）：大画面、操作记录、以及你手动接管鼠标键盘的能力。

```
DSH (cordis 插件 index.js)
  │  vdesk_* / browser_* 工具，按会话归属
  ├── 每个会话一个 dshv.exe (Rust, 无运行时依赖)
  │        └── dshv-<session>:<desktop> 隐藏桌面
  └── client.js「虚拟桌面」会话标签页
        └── /vdesk/live?session=<id> 只推该会话的画面与日志
```

## 每个会话独立

- 会话 A 和会话 B 同时工作时，各自的桌面、浏览器、日志和画面互不可见。
- 桌面名称由插件自动加会话前缀，两个会话都能用 `task-1` 而不会撞车。
- 一个会话关闭后，它启动的 sidecar、浏览器与桌面进程会被回收。
- 监视器只接收 `?session=` 指定的数据，其他会话不会串到你的页面。

## 大屏与手动接管

标签页默认是**观看模式**，点击画面不会误操作目标程序。点「接管操作」后：

- 左键、双击、右键、拖拽、滚轮按画面缩放比例换算成真实坐标；
- 键盘文本、中文、方向键与 Ctrl 组合键发送到该会话的桌面或浏览器；
- 接管期间**只有这个会话**的 Agent 操作会被拒绝，其他会话照常；
- 点「交还 Agent」、关闭标签页、连接断开或会话结束时自动解除接管，不会永久卡住 Agent。

网页任务同样显示在同一标签页（画面来源切换为无头浏览器），不需要另开一个窗口。

## 为什么不是"截整个屏幕"

| 方案 | 用户用微信时 | 锁屏时 | 需要管理员 |
| --- | --- | --- | --- |
| 截物理屏幕 | 截图里全是微信 | 黑屏/失败 | 否 |
| 远程会话 / 虚拟机 | 不受影响 | 可用 | 是 |
| **隐藏 Win32 桌面（本插件）** | **不受影响** | **可用** | **否** |

隐藏桌面上的窗口不在任何显示器的合成结果里，所以：

- **截图只包含目标程序**。逐窗口 `PrintWindow` 后按 Z 序合成，不依赖"当前活动桌面"，也不需要 DWM 合成。
- **不动用户的输入**。不调用 `SendInput`（在非输入桌面上它必然 `ACCESS_DENIED`），而是向目标窗口投递消息。
- **锁屏继续跑**。进程在会话里，桌面不是输入桌面，锁屏切换的是 Winlogon 桌面，与本桌面无关。


## 已验证 / 未验证

实测环境：Windows 10 专业教育版 19045，DSH profile `tauri`。

已用 `scripts/acceptance.py` 在真实程序上跑通（证据图在 `docs/evidence/`）：

- [x] 创建隐藏桌面并在其中启动记事本，用户前台窗口不受影响
- [x] 整桌截图合成（1249×490，真实内容）
- [x] 输入中文 + emoji（`hello hidden desktop 中文😀`），并从控件读回
- [x] 命名键、组合键（`ctrl+a` 的 Ctrl 状态对目标线程可见）
- [x] 关闭桌面并结束其进程

按窗口投递输入的语义，已单独用 Chromium 页面验证通过（见 `docs/verification.md` 的记录）：
左键/双击/右键、拖拽、滚轮、英文与中文输入、Ctrl 组合键，**且用户前台窗口全程不变**。

**已知限制：**

- **Chromium / Electron / WebView 系桌面程序（Edge/Chrome/DBX）不能靠隐藏桌面**：Chromium 用
  `WS_EX_NOREDIRECTIONBITMAP` + DirectComposition，内容不在窗口表面里；而实测
  `DwmGetDxSharedSurface` 对隐藏桌面上的**任何**窗口都返回 false（DWM 不为非输入桌面维护表面），
  `Windows.Graphics.Capture` 在本机更是连主显示器都拒绝。所以这不再是实现问题，而是隐藏桌面的边界。
  **网页任务请用 `browser_*`（无头浏览器 + CDP）**，它不建窗口、不经过 DWM，锁屏也照常工作。

## 能力边界（实测）

| 目标 | 方案 | 状态 |
| --- | --- | --- |
| 网页（任意 URL、登录、抓数据） | `browser_*`：无头 Edge + CDP | ✅ 可用，锁屏/后台无关 |
| 自绘窗口程序（GPUI/FigCraft、WinForms、Qt、老式 Win32） | `vdesk_*`：隐藏桌面 + PrintWindow | ✅ 可用，截图与输入均验证 |
| Electron/WebView2 桌面应用（DBX） | 隐藏桌面截图 ❌；CDP 端口默认不开 ❌ | ❌ 需独立会话/虚拟机 |

## 构建

```powershell
cd sidecar
cargo build --release        # 产出 sidecar/target/release/dshv.exe
```

只依赖 `serde_json` 与 `png`；Win32 绑定是手写的 `extern "system"`，不需要 `windows-sys` 的 feature 组合。

## 安装到 DSH

### 桌面版（DeepSeek Harness 应用）

桌面版自带 CLI，位于应用目录的 `resources/runtime/cli/bin/dsh.cmd`。**注意**：桌面版内置
Node 不信任 GitHub 的证书链，直接用 Release URL 安装会报
`UNABLE_TO_VERIFY_LEAF_SIGNATURE`，因此请用本地文件安装：

```powershell
# 先下载 tgz（浏览器打开 Release 页面即可）
cd "D:\Programs\DeepSeek Harness\resources\runtime\cli\bin"
.\dsh.cmd plugin --profile desktop add "C:\path\to\dsh-vdesktop-0.2.2.tgz"

# 或者从源码目录安装
.\dsh.cmd plugin --profile desktop add "D:\developmentProjects\dsh-vdesktop"
```

然后确认 `%USERPROFILE%\.dsh\profiles\desktop\package.json` 的
`dsh.profile.bundles` 里有 `"dsh-vdesktop"`，再**完全退出并重启** DeepSeek Harness。

如果启动时出现 `web boot: 1 entry did not activate / dsh-vdesktop: failed`，说明插件版本
过旧（0.2.1 之前的激活逻辑会在 sidecar 缺失时抛错）。0.2.1 起该情况降级为工具错误，
不再阻止应用启动；注册标签页也包在 try/catch 中，失败只丢一个标签页而不是拖垮整个 web boot。

桌面版的“虚拟桌面”标签页在 0.2.2 之前一直显示“连接中 → 失败 → 重连”：桌面壳用
`dsh-app://app/` 自定义协议加载前端，`window.location.host` 是字符串 `app`，于是插件把
推流地址拼成了 `ws://app/vdesk/live`，而桌面壳只对 `ws://127.0.0.1/*` 附加 Cookie 与
Origin。0.2.2 起优先读取桌面壳注入的 `window.__DSH_TRANSPORT__.streamBaseUrl`，网页版
无该字段时回退到 `location.origin`，两种外壳都能连上。

### 从源码

1. 把本目录放进 profile 的依赖里（`link:` 指向仓库绝对路径），并在 `dsh.profile.bundles` 中加入 `dsh-vdesktop`；
2. `pnpm install`（或 `npm install`）；
3. 重启 DSH。

也可以直接用 `plugin_manager` 的 `install_bundle` 安装本目录。

> npm 包尚未发布：npm 账号启用了仅支持 Passkey 的 2FA，命令行发布需要 TOTP 验证码，因此当前以 Release 附件分发。

## 工具

| 工具 | 作用 |
| --- | --- |
| `vdesk_open` | 建桌面 + 启动程序，返回 pid 与首批窗口 |
| `vdesk_list` / `vdesk_close` | 列出 / 关闭桌面（并结束其进程） |
| `vdesk_windows` | 窗口列表（标题、类名、pid、矩形） |
| `vdesk_shot` | 截图落盘，返回 PNG 路径（整桌或单窗口） |
| `vdesk_click` | 单击/双击/右键（客户端坐标） |
| `vdesk_drag` | 按下 → 移动 → 抬起 |
| `vdesk_scroll` | 滚轮 |
| `vdesk_type` | 输入文本（支持中文、emoji） |
| `vdesk_key` | 按键与组合键 |
| `vdesk_read_text` | 读取窗口文本 |
| `vdesk_monitor` | 查看实时监视器状态（已推送/已抑制/捕获失败的帧数、最后一次捕获） |

### 实时监视器（WebSocket）

Host 半身通过 `/vdesk/live?session=<会话 id>`（WebSocket）向该会话的标签页推送：

- `snapshot`：当前接管状态、最近画面与操作记录；
- `journal`：工具调用流水（时间、✓/✗、工具名、耗时），每个会话最多 50 条；
- `frame`：桌面或网页画面变化的 PNG（base64）。只有**像素真的变了**才推，空闲桌面零开销；
- `takeover` / `release` / `input`：用户手动接管的进入、交还与输入；Host 校验同源与会话归属后才执行；
- `close`：用户在标签页点“关闭桌面”，Host 结束该会话的 sidecar 及其启动的所有程序。

客户端标签页只订阅自己会话的地址，不接收其他会话的数据。颜色全部取自 `--dsw-*` 主题令牌，跟随 设置 → 外观 自动切换深浅色。

### 生命周期：桌面何时被关闭

一个虚拟桌面会启动 `dshv.exe`（约 5 MB），并把它里面程序的生命周期一起接管。
默认情况下它不会一直占着资源，三条回收路径：

| 触发 | 说明 |
| --- | --- |
| **空闲超时**（默认 10 分钟） | 没有任何工具调用、接管或已连接查看者时自动关闭 |
| **标签页的“关闭桌面”按钮** | 你随时手动关闭；关掉后 Agent 下次操作会重新创建 |
| **会话销毁 / 应用退出** | `agent/disposed` 事件与插件卸载时清理 |

空闲计时会被这些情况推迟或暂停：任何 `vdesk_*` / `browser_*` 调用、用户接管期间、
以及标签页 WebSocket 仍连着（有人在看画面）。配置项 `idleTimeoutMs` 可调整，`0` 表示永不自动关闭：

```yaml
- id: dsh-vdesktop
  name: dsh-vdesktop
  config:
    idleTimeoutMs: 600000   # 10 分钟；0 关闭自动回收
```

### 浏览器（无头 + CDP）

| 工具 | 作用 |
| --- | --- |
| `browser_open` | 打开 URL，返回标题与最终地址 |
| `browser_shot` | 截图到 PNG（可指定视口宽高） |
| `browser_click` | 按 CSS 选择器或视口坐标点击 |
| `browser_type` | 输入文本（支持中文） |
| `browser_key` | 按键与组合键 |
| `browser_eval` | 执行 JS 并取返回值 |
| `browser_close` | 关闭无头浏览器 |

不依赖 Playwright/Puppeteer：Node 22 自带 `fetch` 与 `WebSocket`，直接说 CDP。

坐标统一用**目标窗口的客户区坐标**。整桌截图返回 `meta.windows`，可直接拿其中的 `rect` 换算。

## 排错

- `dshv.exe not found`：先 `cargo build --release`，或用配置项 `sidecarPath` 指定绝对路径。
- 窗口一直不出现：`vdesk_windows` 加 `all: true` 看隐藏窗口；`vdesk_open` 的返回值里 `alive` / `exitCode` 会告诉你是进程没起来还是窗口没建。
- 截图全黑：多为硬件合成的程序，`PrintWindow(flag=2)` 失败时会回退 `flag=0`，仍失败则该窗口不参与合成。

## 目录

```
index.js              Host 插件：工具面 + 按会话归属 + WebSocket 接入
session-runtime.js    每会话运行环境、桌面映射、日志/画面、接管锁
monitor-protocol.js   帧签名、坐标换算、日志裁剪、同源与会话校验
client.js             「虚拟桌面」会话标签页（大画面 + 日志 + 接管）
browser.js            无头浏览器 + CDP 客户端
cordis.patch.yml      bundle 补丁
sidecar/src/main.rs   RPC、桌面生命周期、进程启动
sidecar/src/window.rs 窗口枚举、命中测试
sidecar/src/capture.rs PrintWindow 抓帧、Z 序合成、PNG
sidecar/src/input.rs  鼠标/键盘投递、修饰键状态注入、读文本
sidecar/src/win32.rs  手写 Win32 绑定
test/                 协议、会话隔离、客户端与发布契约测试
scripts/acceptance.py 验收脚本（真实程序，断言可观察副作用）
scripts/test-monitor.mjs  监视器集成测试（真实 WebSocket + 真实桌面）
scripts/probe-signature.mjs  帧去重签名的回归测试
docs/verification.md  逐项验证记录与已知问题
```
