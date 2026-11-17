# opurom-debug 服务扩展对标差距清单 (PARITY_GAP_SERVICES)

范围：Flutter 3.50 框架注册的 68 项 `ext.flutter.*` 服务扩展
（`flutter-golden @ ab2912035e`，engine `371f77202a73e8dff57a8b3bff75bca55c090aee`）。
枚举定义：`packages/flutter/lib/src/{foundation,rendering,services,scheduler,widgets}/service_extensions.dart`
与 `packages/flutter/lib/src/widgets/widget_inspector.dart:847`（`inspector.` 前缀）。

分类：
- **A** — 纯 opurom-debug 仓可实现（协议面/数据面，不依赖运行时对象树）。
- **B** — 需跨仓，标归属仓。
- **C** — 不适用 / N/A，附原因。

当前已实现（本仓）：`reassemble`↔`hotReload`/`hotRestart`（注入触发器）、
`trackRebuildDirtyWidgets`↔`opurom/rebuild`(+`opurom/rebuildStats`)、
`repaintRainbow`↔`opurom/dirtyRegion`(+`opurom/dirtyRegions` 数据面)、
`timeDilation`↔`opurom/timeDilation`、帧时间线↔`opurom/frame(s)`（依
`engine/src/flutter/flow/frame_timings.h:35-42` 与 DevTools
`flutter_frame_model.dart:117-138`）。

## A — 纯本仓可实现

| # | 扩展 | Flutter 出处 | 目标语义 | 状态 |
|---|---|---|---|---|
| A1 | `ext.flutter.didSendFirstFrameEvent` | widgets/service_extensions.dart:62；widgets/binding.dart:719-730 | 返回**字符串** `'true'`/`'false'`（Flutter 明确要求非 boolean，DevTools/IntelliJ/flutter tool 依赖） | 已实现 `opurom/firstFrame` |
| A2 | `ext.flutter.didSendFirstFrameRasterizedEvent` | widgets/service_extensions.dart:72；widgets/binding.dart:731-740 | 同上，光栅完成标志 | 已实现 `opurom/firstFrame` 的 `rasterized` |
| A3 | `ext.flutter.inspector.isWidgetTreeReady` | widgets/service_extensions.dart:228；widget_inspector.dart:1444 | 是否已渲染首帧、适合展示检视树 | 已实现 `opurom/firstFrame` 的 `treeReady` |
| A4 | `ext.flutter.timeDilation` | scheduler/service_extensions.dart:26 | 动画慢放倍率 | 已实现 `opurom/timeDilation` |
| A5 | `ext.flutter.inspector.structuredErrors` | widgets/service_extensions.dart:144 | 结构化错误（带 widget 创建链） | 已实现 `opurom/error`（kind/stack 字段） |
| A6 | `ext.flutter.debugDumpLayerTree` | rendering/service_extensions.dart:79；rendering/binding.dart:134-138 | 层树数据（`{'data': ...}`） | 部分：`opurom/layers` 为显示列表记录，非 Flutter 层树语义 |
| A7 | `ext.flutter.debugDumpApp` | widgets/service_extensions.dart:33 | 应用树 dump | 部分：cli `inspect --tree` 为编译期 IR 树 |
| A8 | `ext.flutter.profileWidgetBuilds` | widgets/service_extensions.dart:93；foundation/binding.dart:800-808 | build 计数开关 | 已实现：`opurom/rebuild {enabled:bool}` 返回字符串开关并门控计数 |
| A8b | `ext.flutter.profileUserWidgetBuilds` | widgets/service_extensions.dart:104 | 仅用户 widget 的 build 事件 | C：无“用户/框架 widget”分类，IR 节点无此区分 |
| A9 | `ext.flutter.debugDumpSemanticsTree*` | rendering/service_extensions.dart:130,139 | 语义树 dump | 部分：render a11y sidecar 无服务面 |
| A10 | `ext.flutter.inspector.getProperties` / `getChildren` / `getRootWidget*` | widgets/service_extensions.dart:341,353,388,404,416,430 | 树与属性查询 | 不建议：依赖运行时对象树（红线 2），按 IR 节点 id 另设数据面 |
| A11 | `ext.flutter.inspector.dispose*` / `setSelectionById` / `getSelected*` | widgets/service_extensions.dart:203,214,239,317,456,472 | 对象句柄与选中态 | 不建议：对象句柄模型与 IR id 模型冲突 |
| A12 | `ext.flutter.inspector.screenshot` | widgets/service_extensions.dart:496 | 截图服务 | 不建议：需渲染宿主配合，非协议面 |

## B — 需跨仓

| # | 扩展 | Flutter 出处 | 归属 |
|---|---|---|---|
| B1 | `debugPaint` / `debugPaintBaselinesEnabled` / `repaintRainbow`（像素侧） | rendering/service_extensions.dart:47,58,70；rendering/debug.dart:36,39,67,330-335 | render（绘制）+ web（DOM/canvas） |
| B2 | `debugDisableClipLayers` / `debugDisablePhysicalShapeLayers` / `debugDisableOpacityLayers` | rendering/service_extensions.dart:90,101,112；rendering/binding.dart:140-180 | render |
| B3 | `debugDumpRenderTree`（约束/尺寸） | rendering/service_extensions.dart:121；rendering/binding.dart:184-188 | render（布局数据面） |
| B4 | `profileRenderObjectPaints` / `profileRenderObjectLayouts` | rendering/service_extensions.dart:150,161 | render（逐节点耗时） |
| B5 | `showPerformanceOverlay` | widgets/service_extensions.dart:53 | render + web（屏上叠加层） |
| B6 | `profilePlatformChannels` | services/service_extensions.dart:29 | core（通道协议 P2）+ server |
| B7 | `evict`（清图像缓存） | services/service_extensions.dart:42 | render（image cache_stats 已在 `image.rs`） |
| B8 | `invertOversizedImages` | rendering/service_extensions.dart:35 | render |
| B9 | `debugAllowBanner` | widgets/service_extensions.dart:116 | web（debug 角标） |
| B10 | `accessibilityEvaluations` / `ext.flutter.accessibility.*` | widgets/service_extensions.dart:125,550-596；widgets/accessibility_inspector.dart:54-67 | render（a11y 语义树）+ platform（平台桥） |
| B11 | `ext.flutter.inspector.trackRepaintWidgets` / `trackRebuildDirtyWidgets`（像素侧） | widgets/service_extensions.dart:166,192 | render（重绘/重建埋点） |
| B12 | `ext.flutter.inspector.getLayoutExplorerNode` / `setFlex*`（布局编辑） | widgets/service_extensions.dart:506,516,526,539 | render（约束可写） |
| B13 | `ext.flutter.inspector.show` / `setPubRootDirectories` 等 | widgets/service_extensions.dart:155,257,273,289,305 | web（项目根解析，我方按项目根无需 pub root） |
| B14 | `ext.flutter.inspector.screenshot` / `widgetLocationIdMap` / `getParentChain` | widgets/service_extensions.dart:496,180,329 | render + web |
| B15 | `ext.flutter.debugDumpFocusTree` | widgets/service_extensions.dart:42 | render（焦点树） |
| B16 | `ext.flutter.fastReassemble` | widgets/service_extensions.dart:81 | core（重组语义） |
| B17 | `exit`（终止应用） | foundation/service_extensions.dart:37 | cli（dev server 进程） |
| B18 | `connectedVmServiceUri` / `activeDevToolsServerAddress` | foundation/service_extensions.dart:48,59 | cli（无 VM Service，需等价会话发现） |
| B19 | `platformOverride` / `brightnessOverride` | foundation/service_extensions.dart:71,82 | render（运行时覆盖），web |
| B20 | 帧时间线真实采集（build/raster/vsync） | engine/src/flutter/flow/frame_timings.h:35-42 | core + render（当前由宿主注入，raster/shader 传 null） |

## C — 不适用 / N/A

| # | 扩展 | 原因 |
|---|---|---|
| C1 | `ext.flutter.inspector.structuredErrors` 的 widget 创建链部分 | 无运行时对象树（红线 2）；错误面按 kind/stack 表达 |
| C2 | `ext.flutter.inspector.dispose*` 系列 | 对象句柄模型不适用；IR 节点 id 无生命周期 |
| C3 | `ext.flutter.inspector.setFlex*` | 运行时改布局违反 IR 唯一真相；改布局=改 IR |
| C4 | `ext.flutter.inspector.show` | Flutter 特有的“选中即高亮”交互，需运行中绘制通道（B1/B14） |
| C5 | `ext.flutter.inspector.setPubRootDirectories` / `add` / `remove` | Dart pub 概念不适用；我方项目根由工程文件决定 |
| C6 | `ext.flutter.inspector.getDetailsSubtree` / `getSelectedWidget` 等需对象 id 的查询 | 对象 id 语义不适用 |
| C7 | `ext.flutter.inspector.screenshot`（协议面） | 需宿主渲染配合，属 B14；纯协议侧不做空壳 |
| C8 | `ext.flutter.debugAllowBanner`（原生应用） | 仅 web/debug 角标有意义，native 不涉及 |
| C9 | `ext.flutter.invertOversizedImages` | 仅为调试图片解码开销，属 render 实现细节 |
| C10 | `ext.flutter.connectedVmServiceUri` / `activeDevToolsServerAddress` | 无 VM Service 架构；等价为 cli dev server 会话发现（B18） |
| C11 | `ext.flutter.inspector.isWidgetCreationTracked` | 无运行时对象创建跟踪 |
| C12 | `ext.flutter.inspector.trackRepaintWidgets`（对象级） | 同 C2；像素侧数据面见 B11 |

## 执行顺序

1. A1–A3（first-frame 语义，字符串而非 boolean）→ `opurom/firstFrame`。
2. A5（结构化错误面）→ `opurom/error`。
3. A6/A7/A9（树数据面补齐）→ 与 cli/web 协商形态后落。
4. B 类按 render/cli/core 归属分别推进，不在本仓铺空壳。
