# 验证记录

所有结论都来自在本机（Windows 10 专业教育版 19045）实跑，不是推断。

## 一、宿主与隔离

- `CreateDesktopW("dshv-*")` 零提权可用。
- 桌面上的程序与用户桌面完全分离：整个测试期间 `GetForegroundWindow()` 始终是用户的 DSH Tauri 窗口。
- 锁屏期间不受影响，因为截图不读取活动桌面的屏幕 DC。

## 二、截图

| 做法 | 结果 |
| --- | --- |
| `GetDC(NULL)` + `BitBlt` 整屏 | **失败**，`ACCESS_DENIED (6)`；非输入桌面没有可读的屏幕 DC |
| `PrintWindow(hwnd, hdc, 2)` 逐窗口 | **成功**，记事本 607693/612010 非黑像素 |
| `PrintWindow(hwnd, hdc, 0)` 回退 | 部分 GPU 合成窗口 flag=2 失败时有效 |
| Z 序合成 | `EnumDesktopWindows` 返回顶层在前，按逆序绘制 |

`capture.rs` 因此只走逐窗口 `PrintWindow` + 合成，不做整屏抓取。

## 三、输入

`SendInput` 在非输入桌面返回 `ACCESS_DENIED (5)`，**恒不可用**，代码里没有这条路径。

改为向目标窗口投递消息，逐项实测（Chromium 测试页把收到的事件写进 `document.title`，用独立进程读回）：

| 操作 | 结果 | 关键点 |
| --- | --- | --- |
| 左键单击 | `clicks:4` | 必须投给 `Chrome_RenderWidgetHostHWND`，投给顶层窗口会错位 |
| 双击 | `dbl:1` | down/up/down/up，间隔 <500ms |
| 右键 | `ctx:1` | 用 `WM_RBUTTONDOWN/UP`，不是 `WM_LBUTTONDOWN` |
| 滚轮 | `wheel:-2` | `WM_MOUSEWHEEL` 的 lParam 是**屏幕**坐标 |
| 拖拽 | `drag:96` | down → 多次带 `MK_LBUTTON` 的 move → up |
| 英文输入 | `typed:"hi"` | 见下方"只能走 WM_CHAR" |
| 中文 / emoji | `中文`、`😀` | `WM_CHAR` 逐 UTF-16 码元，代理对分两次发 |
| `ctrl+a` | `keys:"a^"`（页面看到 ctrlKey） | `AttachThreadInput` + `SetKeyboardState` 注入修饰键状态 |

### 只能走 WM_CHAR

同一字符同时发 `WM_KEYDOWN` 和 `WM_CHAR` 会被插入两次（实测 `abcdeffgg`）。因此：

- 文本 → 只发 `WM_CHAR`；
- 命名键/组合键 → 只发 `WM_KEYDOWN`/`WM_KEYUP`，不补 `WM_CHAR`。

### 修饰键

Chromium 读的是自己 UI 线程的 `GetKeyboardState()`，投递消息不会更新它。做法：
`AttachThreadInput(自己, 目标 UI 线程)` → `SetKeyboardState` 置位 VK_CONTROL/VK_SHIFT/VK_MENU → 发键 → 复位 → 解绑。
实测页面拿到 `a+CTRL`，没有这一步时只看到 `a`。

### 文本读回

`SendMessageTimeoutW` 的**返回值只表示调用成功**，文本长度在 `lpdwResult` 里。早先误把返回值当长度，导致每次只读回 1 个字符。

## 四、进程启动

两个必须同时满足的细节，都踩过：

1. **`lpEnvironment` 不能传 NULL**。NULL 不是"继承"，而是给子进程一个空环境；Chromium 立即退出。
   必须自己序列化 `K=V\0...\0\0`。
2. 传 UTF-16 环境块必须带 **`CREATE_UNICODE_ENVIRONMENT`**，否则 `CreateProcessW` 返回
   `ERROR_INVALID_PARAMETER (87)`；且块内条目需按名称大小写不敏感排序。

另外：`STARTUPINFO.lpDesktop` 为 NULL 时继承的是**进程**桌面而不是线程桌面，所以必须显式传桌面名。

## 五、未解决：Chromium/Electron 系程序在 dshv 宿主下崩溃

现象：`dshv.exe` 启动 Edge/Chrome，进程约 1 秒内以退出码 21 结束，窗口为 0，`--enable-logging` 也来不及写日志。
记事本、资源管理器等 Win32 程序一切正常。

已排除（每一种都单独做过对照实验）：

| 假设 | 实验 | 结论 |
| --- | --- | --- |
| 隐藏桌面本身不行 | Python 在同样的隐藏桌面上启动 Edge | 正常出页，排除 |
| 环境块缺失/格式错 | 补全环境块 + `CREATE_UNICODE_ENVIRONMENT`；也试过最小环境 | 仍 21，排除 |
| 桌面由工作线程创建 | 改为主线程创建、工作线程 attach | 仍 21，排除 |
| 由已 attach 的线程发起创建 | 改为主线程（未 attach）带 `lpDesktop` 创建 | 仍 21，排除 |
| 命令行/参数问题 | 原生二进制直接启动（默认桌面）同一命令行 | 存活，排除 |
| 父进程是 Python | 让 Python 子进程代发 | 仍 21，但**同一脚本由 shell 直接跑却正常** |
| `STARTF_USESHOWWINDOW` | 去掉该标志 | 仍 21，排除 |

最后一行是关键差异：同一段 Python 代码，父进程是 shell 时 Edge 正常，父进程是 `dshv.exe` 时失败。

### 进一步对照（本轮新增）

用用户实际要用的 **DBX（`D:\Programs\DBX\dbx.exe`，Electron/Chromium 系）** 复现了同一现象：

| 宿主 | DBX 结果 |
| --- | --- |
| Python（同样抢建隐藏桌面、同样 `lpDesktop`、同样环境块） | **存活**，4 秒后仍 `STILL_ACTIVE`，并已建出 `Chrome_WidgetWin_0` 窗口 |
| `dshv.exe` | 约 1–2 秒后 `0xC0000409`（FAST_FAIL），窗口为 0 |

所以问题**不只 Chromium 浏览器**，而是所有 Chromium/Electron/WebView 系程序，且与"是不是浏览器"无关。

已按建议排查宿主属性（用 `GetProcessMitigationPolicy` / `IsProcessInJob` / `TokenIntegrityLevel` 实测）：

| 属性 | dshv.exe | python.exe |
| --- | --- | --- |
| `IsProcessInJob` | True | True |
| 令牌完整性 RID | 0x0101（Medium） | 0x0101（Medium） |
| 缓解策略 | 无差异报告 | 无差异报告 |

三者相同，因此 **Job / 完整性级别 / 缓解策略都不是差异来源**，此前的假设被证伪。

### 本轮顺带修掉的真 bug

给子进程设了独立的 NUL 标准句柄（`STARTF_USESTDHANDLES` + `CreateFileW("NUL")`）。
之前子进程会把内容写进 sidecar 的 JSON-RPC 管道，导致协议流出现空行/脏数据。

### 仍未定位

同一组 Win32 调用、同样的环境块、同样的桌面、同样的 Job 与令牌，只有宿主二进制不同，Chromium 系子进程就一个能活、一个立刻 FAST_FAIL。
剩下未比对的方向：**进程的 AppContainer/包身份**、**dshv.exe 的 PE 清单（DPI/兼容性/`uiAccess`）**、以及**父进程命令行长度与进程创建时的 `STARTUPINFO` 扩展属性**。

在定位前，Chromium/Electron 系程序（Edge、Chrome、DBX）暂时无法由本 sidecar 启动；Win32 程序不受影响。

## 六、验收脚本

`scripts/acceptance.py`：

```
PASS  9/17  — 9 项通过，8 项全部集中在 Chromium 用例上（即上面第五节）
```

记事本相关的 6 项与桌面生命周期全部通过；Chromium 的 9 项因上节原因失败。


## 七、绕路方案：结论（已废弃）

曾尝试让外部宿主把 Chromium 系程序送进隐藏桌面（Python 助手 + `SetThreadDesktop` +
`CreateProcessW(lpDesktop=桌面名)`）。实测：进程能起来、窗口能枚举，但**截不到像素**，
且助手进程的存活与宿主进程绑定（sidecar 退出后桌面内的进程树状态不可控）。

该方案未进入插件代码，相关脚本已删除。最终结论见第十三节：网页走 CDP，桌面走隐藏桌面。


## 八、绕路方案：实测结果（已废弃）

助手由宿主机（shell / node）启动，打开 sidecar 建好的桌面并 `SetThreadDesktop`，
再用 `CreateProcessW(lpDesktop=桌面名)` 启动目标程序。

### 1. 桌面先放占位进程（记事本）

| 轮次 | 助手返回 | DBX 主窗口 |
| --- | --- | --- |
| 1 | OK 3288 | ❌ 无 |
| 2 | OK 33892 | ❌ 无 |
| 3 | OK 25932 | ❌ 无 |

**0/3 通过。** 但进程本身是活的：诊断轮次里 DBX `exit=259`（存活），并建出了
`tray_icon_app` 窗口（`[128,128,1152,628]`）。也就是说 **进程起来了，主界面没有出现或不可捕获**。

### 2. Edge 走同一条链路

窗口列表里确实出现了页面窗口：

```
('Chrome_WidgetWin_1', 'HELLO 和另外 1 个页面 - 个人 - Microsoft Edge', [10, 10, 900, 600])
```

但截图拿不到像素：`desktop.screenshot(window=...)` 返回
`PrintWindow returned no pixels for that window`，整桌合成里该窗口是占位灰色块。

### 3. 为排除截图路径，改了一处

`capture.rs` 原来用 `GetDC(NULL)`（屏幕 DC）作为参考 DC，现在改为 `GetDC(hwnd)`（窗口 DC）。
改后 Edge 仍未捕获成功。

### 4. 结论

| 环节 | 状态 |
| --- | --- |
| 进程能启动（helper 模式） | ✅ Edge / DBX 都起得来，进程存活 |
| 能枚举到窗口 | ✅ 类名、标题、矩形都正确 |
| 能截到画面 | ❌ DirectComposition 窗口（Chromium/WebView2）为空白 |

该路线已放弃，脚本删除；不再作为交付物的一部分。


## 九、最后一次对照：空桌面 + Edge 单独运行（已废弃）

为了排除"被记事本遮挡导致 PrintWindow 失败"，用空桌面（无占位进程）经 helper 启动 Edge，
再单独截该窗口：

- 进程存活，窗口枚举正确：`Chrome_WidgetWin_1 'HELLO...' [10,10,900,600]`
- 截图：**整张纯色空白**（返回的像素全为 0，判定为不可捕获）

因此与遮挡无关。结论收敛为：**非输入桌面上没有 DWM 重定向表面，`PrintWindow` 拿不到
DirectComposition 窗口的内容**；而早期的 PoC 能截到，是因为当时窗口恰好走了 GDI/软件合成路径。

要真正打通，只能换捕获通道（`Windows.Graphics.Capture`，需实测隐藏桌面下是否可用），
或强制目标程序走软件合成（Chromium `--disable-gpu` 已证无效）。


## 十、WGC（Windows.Graphics.Capture）探针结果（已废弃）

探针已删除。记录保留，因为它解释了为什么本机无法走 WGC：

| 用例 | 结果 |
| --- | --- |
| 可见桌面上的记事本窗口 | ❌ `new_item_from_hwnd: 拒绝访问 (0x80070005)` |
| 隐藏桌面上的记事本窗口 | ❌ 同上 |
| 隐藏桌面上的 Edge 窗口 | ❌ 同上 |
| **主显示器**（`new_item_from_monitor`） | ❌ 同上 |

连主显示器都拒绝，说明不是"窗口没有 DWM 表面"，而是**本机对 WGC 的调用被直接拒绝**
（补 `RoInitialize(RO_INIT_MULTITHREADED)`、嵌带 `supportedOS` 的清单均无变化）。

因此本机无法验证"WGC 能否抓隐藏桌面窗口"这个前提。最终结论见第十三节。


## 十一、"Python 行、Rust 不行" 的追因

先把问题问准：不是"Python 行"，而是**由 shell 启动的 Python 行**。

| 谁启动 Edge/DBX | 结果 |
| --- | --- |
| shell → Python → Edge | ✅ 稳定出窗口 |
| dshv → Python → Edge | ❌ 同样失败（Python 本身 exit 0） |
| dshv → Edge | ❌ 退出码 21（偶尔存活但零窗口） |

所以毒在 **dshv 这个进程**里，并且**会被后代继承两代**。

已经排除的"可继承项"：

| 可继承项 | 排除方式 |
| --- | --- |
| 环境块 | 自建 UTF-16 块 + `CREATE_UNICODE_ENVIRONMENT`，用最小环境也失败 |
| 标准句柄 | 改成独立的 NUL 设备句柄，失败不变 |
| 控制台 | 用 `CREATE_NEW_CONSOLE` 启动 dshv，仍然失败（且结果在"21"和"存活但零窗口"之间摇摆） |
| 桌面创建线程 | 主线程创建 / 工作线程创建都试过 |
| 创建者线程是否 attach | 两种都试过 |
| Job / 完整性等级 / 缓解策略 | 实测与 Python 相同 |

### 目前最可疑的两点

1. **桌面从未被"激活"过**。成功的 Python 用例里，Python 进程本身长期驻留在该桌面上；
   dshv 的工作线程只 attach，不常驻、不泵消息。Chromium 类程序可能要求在
   有消息泵/初始化完成的桌面上创建。
2. **结果本身不稳定**：同一二进制、同一参数，Edge 有时退出码 21、有时存活但窗口数为 0。
   这种非确定性更像竞态（桌面初始化时序），而不是某个固定的进程属性。

### 决定性的下一个实验

让 dshv 的工作线程在 attach 之后**先泵一小段消息循环再启动目标程序**（模拟 Python 常驻的效果），
并对同一次启动重复 5 次统计成功率。若成功率从 0/5 变为 5/5，结论即成立，改法也就明确了。


## 十二、GUI 全家桶对照：问题只在 Chromium

同一套 sidecar、同一个隐藏桌面，分别启动四种技术栈的程序：

| 程序 | 技术栈 | 渲染 | 进程 | 窗口 | PrintWindow 截图 |
| --- | --- | --- | --- | --- | --- |
| 记事本 | Win32 / GDI | GDI | ✅ | ✅ | ✅ 1000×392 |
| **FigCraft** | **GPUI + wgpu** | **D3D12 / DXGI** | ✅ | ✅ 1440×864 | ✅ 1200×720，界面完整（见 `docs/evidence/09-figcraft.png`） |
| DBX | Tauri / WebView2 | Chromium + DComp | ✅ | ✅ 有时 | ❌ 空 |
| Edge | Chromium | Chromium + DComp | ❌ 退出码 21 / 无窗口 | ❌ | ❌ |

结论：

1. **不是"GUI 程序都不行"**：GPUI 用 wgpu 直接走 D3D12，启动与截图都完全正常。
2. **不是"GPU 合成都不行"**：FigCraft 的界面就是 GPU 渲染的，照样能截。
3. **只有 Chromium 系（Edge / Chrome / WebView2）出问题**，且是两种不同的故障：
   - 浏览器：进程起不来或起来后没有窗口（退出码 21）；
   - WebView2：窗口能起来，但抓不到像素。

### 为什么 GPUI 能截、Chromium 不能

Chromium 的窗口带 `WS_EX_NOREDIRECTIONBITMAP`，内容直接由 DirectComposition 提交，
窗口没有可供 `PrintWindow` 复制的重定向表面；GPUI/wgpu 走的是普通 swapchain，
窗口有表面，`PrintWindow` 能拿到。

已试过 `--disable-direct-composition`（Edge 命令行 + WebView2 的
`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`），两者仍然抓不到，说明该开关在这条路径上无效。

### 剩下可走的路

BGI 的第二种模式 `DwmGetDxSharedSurface`（`Fischless.GameCapture/DwmSharedSurface/SharedSurfaceCapture.cs`）
就是专门对付这类窗口的：向 DWM 要窗口的共享表面句柄，再用 D3D11 打开。它不需要 WGC，
是本机 WGC 被拒之后唯一还能试的通道。


## 十三、结论：网页走 CDP，桌面走隐藏桌面

`DwmGetDxSharedSurface` 的探针给出了最终解释：

| 窗口所在桌面 | `DwmGetDxSharedSurface` |
| --- | --- |
| 可见桌面（记事本） | ✅ `ok=true handle=0x400042c2` |
| 隐藏桌面（记事本 / FigCraft / DBX） | ❌ `ok=false handle=0` |

**DWM 不为非输入桌面维护合成表面**，所以任何依赖 DWM 的捕获（WGC、DwmGetDxSharedSurface、
缩略图）在隐藏桌面上都不可能成功；`PrintWindow` 只对"把像素画进自己窗口表面"的程序有效
（GDI、DXGI swapchain，如 FigCraft），对 DirectComposition 客户端（Chromium/WebView2）无效。

因此浏览器能力改走 **无头浏览器 + CDP**，与桌面、DWM 完全无关：

- 实测 `--headless=new --remote-debugging-port` 启动后 CDP 立即就绪（`Edg/155.0.4283.62`）；
- 插件里用 Node 22 自带的 `fetch` + `WebSocket` 直接说 CDP，无 Playwright/Puppeteer 依赖；
- 端到端实测：18 个工具注册成功，`browser_open → click ×2 → type("插件 中文") → eval → shot(900×600)`
  全部通过，页面状态为 `clicks=2, typed="插件 中文"`；`vdesk_open`（记事本）+ `vdesk_shot`
  （1249×490）同时可用。

DBX 这类 WebView2 桌面应用：`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9444`
实测**没有**打开 CDP 端口，因此既不能截屏也不能通过 CDP 驱动，需要独立会话或虚拟机才能支持。
