# 0.2.0 验证记录（会话内虚拟桌面）

验证环境：Windows 10 专业教育版 19045，Node v24.22.0，DSH profile `desktop`。
所有结论来自本机实际运行；未执行的项明确标为未验证。

## 一、自动化测试

`npm test`（`node --test`）共 28 项，全部通过：

- 协议：帧签名能区分“长度与尾部相同”的不同画面；坐标缩放与边界钳制；日志字段白名单；会话归属；升级 URL 解析；跨源拒绝。
- 会话隔离：两个会话各自的运行环境、桌面名称前缀、日志、画面互不可见；无会话调用被拒绝；销毁时关闭 sidecar 与浏览器。
- 接管：未接管时 UI 输入被拒绝；接管后输入映射到正确桌面；未知操作被拒绝；接管期间该会话 Agent 工具被拒绝，另一个会话不受影响；交还后恢复。
- 客户端契约：注册 `conversation.view` 且不再出现 `shell.overlay`；只使用 `--dsw-*` 主题令牌；接管输入走会话 WebSocket；不导入 Harness Client 包。
- 发布契约：版本 `0.2.0`、非私有、仓库地址正确、运行时文件与 sidecar 在 `files` 中、测试与证据目录不发布。

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

## 六、已知限制

- 仅 Windows x64；sidecar 为预编译 `dshv.exe`。
- Chromium / Electron / WebView2 桌面窗口仍不可截图（见上）。
- 接管输入只作用于当前会话；系统级快捷键（如 Alt+Tab）不会转发。
- npm 发布需要已登录的 npm 账号；本机当前 `npm whoami` 返回 `ENEEDAUTH`。
