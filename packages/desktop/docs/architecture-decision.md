# 架构决策草案：Qt/C++ 宿主 + Web 富文本渲染（B1 → B2 渐进迁移）

状态：草案（Draft）

## 背景与现状

当前 GUI 为 Electron 43 + React 19，三层结构：

| 层 | 技术 | 规模（行） |
| --- | --- | --- |
| renderer | React 19 自定义组件 | 8,167 |
| Electron main | 后端进程池、会话目录、设置、回收站 | 1,543 |
| preload | contextBridge API 面 | 95 |
| pi-gui-adapter | JSONL RPC、事件归一化、进程管理 | 1,903 |
| agent-protocol | 纯 TypeScript 类型 | 580 |
| 测试 | vitest / jsdom | 3,226 |

关键约束：

- 后端 `pi.exe --mode rpc` 为 JSONL-over-stdio 语言无关协议，**迁移全程不动**。
- 会话持久化（JSONL 文件）与 `agent-protocol` 语义原样保留。
- 当前打包仅 Windows（Squirrel / win32-x64）。
- OS 集成面很小：仅 `shell.trashItem`（→ `IFileOperation`）与 `shell.openExternal`（→ `ShellExecuteW`）。
- 渲染层已实现完整流式性能优化：`message_delta` 按动画帧合并、`tool_updated` 25Hz latest-wins 节流、仅最后一条消息重渲染、`message_completed` 权威覆盖、历史渐进挂载。这些语义是迁移的**规格而非负担**，C++ 侧必须逐条保留。

## 决策

采用 **Qt 6 + C++ 作为应用宿主，WebView2 作为富文本文档渲染面** 的混合架构，分两个可独立交付的阶段：

- **Phase 1（B1）**：C++ 宿主接管 runtime/host ownership（进程管理、RPC、会话、设置、文件系统），WebView2 承载**完整现有 React 渲染层**，Electron 完全退出。目的不是性能最大化，而是完成 ownership 转移，风险最低。
- **Phase 2（B2）**：Qt 化 sidebar / topbar / composer / settings 等应用外壳，WebView2 只保留消息内容区，建立真正的性能隔离与 native UI 边界。
- **Phase 3**：按收益渐进收编简单 UI，见"native 化顺序"。

明确否决的方案：

- 一步到位全 Qt 重写：KaTeX/GFM/代码高亮无 native 等价物，渲染一致性风险过高。
- Qt + Electron 双框架共存：同时保留两套桌面应用框架，复杂度与资源消耗反而上升。

## Phase 0：Architecture / performance spike

Qt native 窗口内验证以下项，通过后再进入 B1：

- WebView2 嵌入（见"宿主集成"）
- `pi.exe --mode rpc` JSONL 往返
- postMessage bridge
- 中文 IME 输入与组合框定位
- 焦点切换（Qt ↔ WebView）、Tab traversal、accelerator 路由、焦点恢复
- DPI 缩放与动态 resize
- 主题同步（tokens.css ↔ Qt palette）
- 长流式生成基准（与当前 Electron 版 A/B 对照）

## 宿主集成（Windows）

WebView2 的父 HWND 由我们自己的 Qt widget 提供，直接创建，不用 `QWindow::fromWinId` + `createWindowContainer` 包装 foreign window：

```text
QWidget ChatHost
      │ winId() → HWND
      ▼
CreateCoreWebView2Controller(hwnd)
      │
      ▼
WebView2 child HWND
```

实现要点：

- widget 需 `Qt::WA_NativeWindow`
- resize 事件中调用 `put_Bounds`
- 宿主移动时调用 `NotifyParentWindowPositionChanged`
- WebView2 的 focus/move-focus API 是 host integration 的一部分，用于焦点桥接

**定位**：Qt native HWND 与 WebView2 是两个独立的 input/focus domain。IME、焦点、DPI 等集成问题**必须在 spike 中验证**，不预判为硬伤，也不默认无问题。

**WebView2 Runtime 分发**：Windows 11 通常可依赖系统 Evergreen WebView2 Runtime；Windows 10 覆盖率也很高，但安装程序仍应检测 Runtime，并准备 Evergreen Bootstrapper fallback。应用本身无需捆绑一份完整 Chromium。Fixed Version（随包分发运行时）仅作为最后兜底，不走默认路径——它会大幅缩小体积收益。

## 状态模型（Phase 2 起）

**第一原则：C++ 是应用状态的唯一 authoritative owner；WebView 是 renderer，不是第二个业务 store。**

```text
                   C++ App Model
                  authoritative
                       │
          ┌────────────┼────────────┐
          │            │            │
       Qt UI         RPC          WebView
          │                         │
          │                      projection
          │                         │
          └──── commands ──────────┘
```

Web 层保留的只是 renderer-local projection/cache：

- DOM、React component state
- 当前可见消息
- streaming buffer
- tool rendering state
- layout / cache

会话切换为单向替换而非双向同步：

```text
Qt ── command ──▶ C++ SessionController ── authoritative switch ──▶ generation = 42
                                                                      │
Web ◀── replaceSession(snapshot, generation = 42)
```

事件携带 `sessionId / generation / sequence`，Web 只接受 `event.generation == currentGeneration` 的事件。

该模型与现有代码一脉相承：store.ts 已定位为"pure renderer state transitions"，`message_completed` 对 delta 的权威覆盖是同一哲学；`backend-manager` 的 switch generation 与事件隔离语义直接上移为 Native↔Web bridge 协议，现有测试逐条移植为桥协议契约测试。B2 不是引入新约束，是把已有纪律升格为协议。

## native 化顺序（Phase 3）

**按整条 message 分类，绝不按 message 内部 block 交错拆分。** 块级交错会引入跨渲染器高度计算、selection、copy、滚动锚定、文本搜索、hover、动态 resize 等无解复杂度。

```text
Phase 3a

tool call / tool result shell（折叠、状态、图标）/ status / usage
approval UI / interaction UI
        → Qt
（tool result 正文按内容整块处理：rich 内容整块留 Web，纯文本才进 Qt）

assistant / user 文档正文
        → 整块 Web
```

```text
Phase 3b（仅在测量有收益时进行）

纯文本 message → Qt
rich message（Markdown / 表格 / 公式 / 代码）→ 整条 Web
```

长期归属：

- Qt：主窗口、Sidebar、Session 列表、Composer、设置、OAuth、Workspace、进程管理、RPC、会话、文件系统、虚拟滚动
- Web：Markdown、GFM、代码高亮、KaTeX
- KaTeX：在可预见的迁移阶段没有 native 化必要（ROI 极低）

代码块不优先 native 化：Qt 无内置语法高亮引擎，需引入 KSyntaxHighlighting 或 tree-sitter-highlight 并重做语言徽章、复制按钮等，收益低于成本。

## 许可与分发

- 在决定 Qt Widgets / Qt WebEngine 模块组合前，完成 module-level license audit：
  - 使用的具体模块是 LGPL 还是 GPL-only（GPL-only 模块如 Qt Charts、Virtual Keyboard 直接排除）
  - 是否修改 Qt 本身
  - 用户替换 / 重新链接 LGPL library 的权利（重链接义务）
  - license notice / source availability
  - Qt WebEngine 自带 Chromium 等第三方组件的 license obligations
- 仓库本身 MIT 不会自动消除 Qt 及其第三方依赖的分发义务。
- Windows 当前路线（Widgets + WebView2）许可风险最低；仅在必须支持 macOS/Linux 时再评估 Qt WebEngine（自带 Chromium，体积收益基本归零，许可面更大）。

## 估算与不确定性

- 规划量级（非可信工程估时）：B1 约 1.5–2 人月；B2 追加约 2 人月；Phase 3a 约 1 人月。
- 已完成的耦合测量：`AppState` 共 24 个 slice、hooks 24 个 bridge 操作，但 renderer 中仅 8 个组件直接 import store/hooks，且已沿 B2 边界自然分离（Sidebar/TopBar/SettingsPanel/OAuthLoginDialog 消费全局 slice；ChatView/ConversationTurn/MessageItem 消费会话 slice；其余组件经 App.tsx 组合根 props 下发）。store 拆分成本集中在三处：`AppState` 顶层切片、`useAgentBridge` 事件归约接线、跨两侧的 session/model 变更操作。
- 真正的不确定性已从"能不能做"转移到"拆 store 到底有多疼"；兜底手段是将现有 store/hooks 测试逐条移植为桥协议契约测试。

## 迁移总览

```text
Phase 0  spike：Qt 窗口 + WebView2 + pi.exe RPC + IME/焦点/DPI/主题 + 长流基准
Phase 1  B1：C++ 移植 adapter(1.9k) + main 暖池/会话目录(1.5k)，
          WebView2 承载完整 React 渲染层 → Electron 退出，发布第一个 C++ 版本
Phase 2  B2：Qt 化 sidebar/composer/settings + store 拆分 + generation bridge
Phase 3  native 化收编：3a tool/status/usage/approval → Qt；3b 按测量决定纯文本 message
```

最终形态：

```text
┌──────────────────────────────────────────┐
│                Qt / C++                  │
│                                          │
│ Sidebar     TopBar       Settings        │
│                                          │
│           Application Model              │
│                  │                       │
│              RpcClient                   │
│                  │                       │
│                pi.exe                    │
│                                          │
│ ┌──────────────────────────────────────┐ │
│ │              ChatView               │ │
│ │                                      │ │
│ │ Native structural UI                │ │
│ │         +                            │ │
│ │ one WebView2 rich-document surface  │ │
│ └──────────────────────────────────────┘ │
│                                          │
│                Composer                  │
└──────────────────────────────────────────┘
```

## 边界原则

混合可以，但边界是 **Native Application + Web Rich-Text Renderer**，而不是两个完整桌面框架同时运行。B1 的目的不是性能最大化，而是先完成 runtime/host ownership 转移；B2 才建立真正的性能隔离和 native UI 边界。
