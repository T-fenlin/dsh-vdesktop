# 0.2.3 验证记录（会话内虚拟桌面）

验证环境：Windows 10 专业教育版 19045，Node v24.22.0，DSH profile `desktop`。
所有结论来自本机实际运行；未执行的项明确标为未验证。

## 零、0.2.3 新增

1. **空闲回收**：`Config.idleTimeoutMs`，默认 600000（10 分钟），`0` 关闭。计时在每次
   `vdesk_*` / `browser_*` 调用、接管开始/结束、订阅/退订时重置；**有查看者连接或用户
   正在接管时不回收**，只是顺延。定时器 `unref()`，不会拖住进程退出。
2. **关闭按钮**：标签页头部“关闭桌面”，经会话 WebSocket 发 `{type:'close'}`，Host 仅对
   该会话的 runtime 执行 `disposeSession`。客户端用 `closedByUser` 标记阻止 `onclose`
   自动重连，否则桌面会被立刻重建。
3. **布局修复**：`[data-vd-page]` 由 `height:100%` 改为 `position:absolute; inset:0`。
   宿主 `_tabHostBody` 不设高度，百分比高度解析为内容高度，导致页面随操作记录增高
   （实测 762px 容器里页面长到 1342px）。
4. **语法门禁**：测试新增 `node --check client.js`。此前 CSS 模板字符串里的反引号曾提前
   闭合字符串，导致 `dsh-vdesktop: import failed`，而纯文本断言测不出来。

测试 **39 项**（原 32）：新增 6 条空闲回收用例（超时回收、活动推迟、查看者阻止、接管阻止、
`0` 禁用、销毁取消定时器）与 1 条语法解析用例，全部通过。

### 实测：隐藏桌面下的 Chromium 系应用

| 程序 | 类型 | 你的桌面 | 虚拟桌面 |
| --- | --- | --- | --- |
| 记事本 | 原生 Win32 | ✅ | ✅ |
| Zed | 原生 GPUI | ✅ | ✅ 截图 6084 色，正常 |
| QQ (QQNT) | Electron | ✅ `alive pid=18740` | ❌ `0x80000003` |
| OpenIDEA | Tauri/WebView2 | 未测 | ❌ `0xC0000409` |
| DeepSeek Harness | Electron | ✅ | ❌ `exit 9` |

给 QQ 追加 `--disable-gpu --disable-software-rasterizer --in-process-gpu
--disable-gpu-compositing --use-angle=swiftshader` 后退出码不变，说明失败不在 GPU 合成路径。

**替代路径已验证**：用无头浏览器打开应用的 Web 前端可正常显示。DSH 的
`http://127.0.0.1:<port>/?token=...` 完整可用（DOM 82528 字符、16991 种颜色）；
OpenIDEA 的 `dist/` 经 `vite preview` 托管后欢迎页完整渲染（10992 字符），但
`__TAURI_INTERNALS__` 为 `undefined`，文件/命令类操作不可用。

## 零之一、0.2.2 修复内容（桌面版标签页连不上）

现象：网页版的“虚拟桌面”标签页正常，桌面版一直停在“连接中 → 失败 → 重连”，画面永不出现。

根因：桌面壳用 `dsh-app://app/` 自定义协议加载前端，该协议下 `window.location.host`
是字面量字符串 `app`，`location.origin` 是不透明来源。旧代码按 `location.host` 拼推流地址，
得到 `ws://app/vdesk/live`——没有任何进程监听该主机。桌面壳的
`webRequest.onBeforeSendHeaders` 只重写 `ws://127.0.0.1/*`（补 Host cookie、把 Origin
改成 `dsh-app://app`、校验二者一致），所以 `ws://app/...` 既不被重写也必然连接失败。

修复：`client.js` 新增 `hostOrigin()`，优先取桌面壳注入的
`window.__DSH_TRANSPORT__.streamBaseUrl`（壳在 `boot` IPC 里以 `new URL(hostUrl).origin`
提供），再回退到 `location.origin`；`liveUrl()` 用 `new URL(path, base)` 组合并把协议映射为
`ws:`/`wss:`。网页版没有 `__DSH_TRANSPORT__`，行为与之前一致。

验证：单测 5 种场景全部通过——网页 bundle、桌面壳（`dsh-app://` + streamBaseUrl）、
桌面壳缺失 transport 的降级、https 走 wss、transport 非法值回退。网页版实测标签页仍为
“已连接”且有画面（无退化）。桌面版需替换 0.2.2 包并重启后实测。

## 零之一、0.2.1 修复内容

桌面版启动时出现 `web boot: 1 entry did not activate / dsh-vdesktop: failed`，整个前端
启动被单个插件拖垮。两处改动：

1. `client.js` 的模块导出从 `inject: ['slots']` 改为 `inject: ['slots', 'uiConversation']`，
   让插件在 `dsh-client-ui-conversation` 声明 `conversation.view` 之后再进入 `apply()`，
   注册回调因此走同步路径，异常可被捕获而不是变成无人处理的异步 effect 错误。
2. 注册标签页的 `slots.inject(...)` 包进 `try/catch`，失败时用 `console.error` 打出真实
   错误（会被桌面崩溃日志的 renderer console 段捕获），最多丢一个标签页，不再阻止启动。

验证：改动后连续启动十余次，`%APPDATA%\@deepseek-ai\dsh-desktop\logs\crash-*-web-boot.log`
无新增；宿主进程稳定运行 27 分钟无重启。用 stub 服务模拟模块加载，`apply()` 不抛异常、
成功注册 1 个 `conversation.view`（id `virtual-desktop`、order 20、session 作用域）、
locale 中英文各 20 条、effect 正常执行。测试 32 项全部通过。

## 一、自动化测试

`npm test`（`node --test`）共 32 项，全部通过：

- 协议：帧签名能区分“长度与尾部相同”的不同画面；坐标缩放与边界钳制；日志字段白名单；会话归属；升级 URL 解析；跨源拒绝。
- 会话隔离：两个会话各自的运行环境、桌面名称前缀、日志、画面互不可见；无会话调用被拒绝；销毁时关闭 sidecar 与浏览器。
- 接管：未接管时 UI 输入被拒绝；接管后输入映射到正确桌面；未知操作被拒绝；接管期间该会话 Agent 工具被拒绝，另一个会话不受影响；交还后恢复。
- 客户端契约：注册 `conversation.view` 且不再出现 `shell.overlay`；只使用 `--dsw-*` 主题令牌；接管输入走会话 WebSocket；不导入 Harness Client 包。
- 发布契约：版本 `0.2.3`、非私有、仓库地址正确、运行时文件与 sidecar 在 `files` 中、测试与证据目录不发布。

## 二、真实 WebSocket 集成测试

`node scripts/test-monitor.mjs` 全部通过：

- 两个会话各建一条真实 WebSocket，各自只收到自己的快照、日志与画面。
- 记事本隐藏桌面：创建成功，1 个窗口；截图 1249×490，约 30 KB base64。
- 失败调用被记录为 `ok:false` 并带错误文本。
- 无会话的工具调用被拒绝。
- 画面未变化时不再推送。
- 晚连接的页面能收到最近画面与日志快照。
- 接管后本会话 Agent 被拒绝，另一会话照常；交还后恢复。
- 跨源（`https://evil.example`）连接被拒绝。

## 三、真实程序验收

`PYTHONIOENCODING=utf-8 python scripts/acceptance.py`：**8/17 通过**。

通过项（记事本 + 桌面生命周期）：

- `ping` 正常；
- 隐藏桌面启动记事本，窗口枚举正确；
- 整桌截图合成真实画面（1249×490）；
- 输入中文与 emoji（`hello hidden desktop 中文😀`）并读回一致；
- 命名键可用；
- 关闭桌面后进程与桌面都被回收；
- 用户前台窗口全程未被影响。

未通过项（9 项，全部是既有 Chromium 桌面限制）：

- 隐藏桌面启动 Chromium 页面无窗口；
- 因此依赖页面窗口的点击、双击、右键、滚轮、拖拽、输入、组合键与单窗口截图均无法进行。

这与 `docs/verification.md` 既有结论一致：DWM 不为非输入桌面维护合成表面，Chromium/WebView2 桌面程序不可捕获。**网页任务应使用 `browser_*`（无头 CDP）**，它不走该路径。

## 四、插件安装与注册

- `plugin_manager install_bundle` 报告 `already-installed`（profile 中已是本目录的 `link:`）。
- 启用后 `application: applied`，`dsh-vdesktop` 行 `fiberPhase: active`。
- `conversation.view` 的 occupants 中出现 `virtual-desktop`（order 20，位于 `trajectory` 之后）。
- `shell.overlay` 中原 `dsh-vdesktop-monitor` 已消失。
- Host 工具清单包含 12 个 `vdesk_*` 与 7 个 `browser_*`。

## 五、未完成的视觉验证

当前会话没有已认证的宿主页面控制：无头浏览器打开 `http://127.0.0.1:49402` 返回
`dsh web authentication required; reopen the URL printed by dsh web.`，因此**未对标签页的实际
渲染、深浅色外观与鼠标键盘接管做像素级验证**。已完成的替代证据是：客户端模块已加载（旧浮窗消失）、
槽位注册可见、契约测试与真实 WebSocket 集成测试通过。请在已登录的 DSH 页面打开任意会话的
「虚拟桌面」标签页确认视觉与操作手感。

## 六、桌面版启动失败的修复（2026-10-25）

现象：桌面版 DSH 启动弹窗 `web boot: 1 entry did not activate / dsh-vdesktop: failed`，
应用无法启动。诊断日志见 `%APPDATA%\@deepseek-ai\dsh-desktop\logs\crash-*-web-boot.log`，
同一插件在不同次启动中分别停在 `loading` 与 `failed`。

根因（两处，都在 `apply()` 里同步失败）：

1. `const exe = resolveSidecar(cfg.sidecarPath)` 在激活阶段就解析 `dshv.exe`。桌面版可能
   在链接目录尚未就绪时加载该模块，`existsSync` 为假，直接抛出，Loader 记为激活失败。
2. `ctx.inject(['webServer'], ...)` 把整个插件挂在一个桌面版并不总是提供的服务上；
   该服务不出现时 fiber 长期 pending，启动器同样判定为未激活。

修复：

- `resolveSidecar` 改为延迟解析：只在第一次真正调用工具时执行，失败作为工具错误返回，
  不再影响插件激活。
- 监视器改为可选：`webServer` 不存在或没有 `registerUpgrade` 时记录警告并跳过实时视图，
  19 个工具照常注册。
- 导出 `resolveSidecar` 以便直接测试。

验证：

- `npm test`：32 项全部通过（新增 4 项启动韧性测试：缺 sidecar 不抛错、缺 webServer 不抛错、
  sidecar 缺失报清晰错误、19 个工具仍全部注册）。
- 在桌面版 Electron Node 中加载插件：输出 `[dsh-vdesktop] ready, sidecar=(auto)` 与 `APPLY OK`。
- 重新安装后 `dsh-vdesktop` 行 `fiberPhase: active`，`virtual-desktop` 标签页仍注册在
  `conversation.view` 的 occupants 中。
- 重新启用后未产生新的 `crash-*-web-boot.log`。

## 七、已知限制

- 仅 Windows x64；sidecar 为预编译 `dshv.exe`。
- Chromium / Electron / WebView2 桌面窗口仍不可截图（见上）。
- 接管输入只作用于当前会话；系统级快捷键（如 Alt+Tab）不会转发。
- npm 未发布：账号 2FA 仅支持 Passkey，npm CLI 发布需要 TOTP 六位码。当前通过
  GitHub Release 的 tgz 分发。
- 桌面版 Electron 内置 Node 不信任 GitHub 证书链（`UNABLE_TO_VERIFY_LEAF_SIGNATURE`），
  从 Release URL 安装会失败；请改用本地 tgz 或本地目录安装。
