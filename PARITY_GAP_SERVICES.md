# opurom-debug service extension parity gaps (PARITY_GAP_SERVICES)

Scope: the 68 `ext.flutter.*` service extensions registered by Flutter 3.50
(`flutter-golden @ ab2912035e`, engine
`371f77202a73e8dff57a8b3bff75bca55c090aee`).
Enum definitions:
`packages/flutter/lib/src/{foundation,rendering,services,scheduler,widgets}/service_extensions.dart`
and `packages/flutter/lib/src/widgets/widget_inspector.dart:847` (the `inspector.` prefix).

Categories:
- **A** - implementable purely in opurom-debug (protocol/data plane, no runtime object tree dependency).
- **B** - requires cross-repo work; owning repo is marked.
- **C** - not applicable / N/A, with reason.

Currently implemented (this repo): `reassemble` <-> `hotReload`/`hotRestart` (injected triggers),
`trackRebuildDirtyWidgets` <-> `opurom/rebuild` (+`opurom/rebuildStats`),
`repaintRainbow` <-> `opurom/dirtyRegion` (+`opurom/dirtyRegions` data plane),
`timeDilation` <-> `opurom/timeDilation`, frame timeline <-> `opurom/frame(s)` (per
`engine/src/flutter/flow/frame_timings.h:35-42` and DevTools
`flutter_frame_model.dart:117-138`).

## A - Implementable purely in this repo

| # | Extension | Flutter source | Target semantics | Status |
|---|---|---|---|---|
| A1 | `ext.flutter.didSendFirstFrameEvent` | widgets/service_extensions.dart:62; widgets/binding.dart:719-730 | Returns a **string** `'true'`/`'false'` (Flutter explicitly requires a non-boolean value; DevTools/IntelliJ/flutter tool depend on it) | Implemented as `opurom/firstFrame` |
| A2 | `ext.flutter.didSendFirstFrameRasterizedEvent` | widgets/service_extensions.dart:72; widgets/binding.dart:731-740 | Same as above; rasterization-complete flag | Implemented as the `rasterized` field of `opurom/firstFrame` |
| A3 | `ext.flutter.inspector.isWidgetTreeReady` | widgets/service_extensions.dart:228; widget_inspector.dart:1444 | Whether the first frame has been rendered and the inspector tree is ready to show | Implemented as `treeReady` of `opurom/firstFrame` |
| A4 | `ext.flutter.timeDilation` | scheduler/service_extensions.dart:26 | Animation slow-down factor | Implemented as `opurom/timeDilation` |
| A5 | `ext.flutter.inspector.structuredErrors` | widgets/service_extensions.dart:144 | Structured errors (with widget creation chain) | Implemented as `opurom/error` (kind/stack fields) |
| A6 | `ext.flutter.debugDumpLayerTree` | rendering/service_extensions.dart:79; rendering/binding.dart:134-138 | Layer tree data (`{'data': ...}`) | Partial: `opurom/layers` is a display-list record, not Flutter layer-tree semantics |
| A7 | `ext.flutter.debugDumpApp` | widgets/service_extensions.dart:33 | Application tree dump | Partial: cli `inspect --tree` is the compile-time IR tree |
| A8 | `ext.flutter.profileWidgetBuilds` | widgets/service_extensions.dart:93; foundation/binding.dart:800-808 | build-count toggle | Implemented: `opurom/rebuild {enabled:bool}` returns the string toggle and gates counting |
| A8b | `ext.flutter.profileUserWidgetBuilds` | widgets/service_extensions.dart:104 | Build events for user widgets only | C: no user/framework widget classification; IR nodes carry no such distinction |
| A9 | `ext.flutter.debugDumpSemanticsTree*` | rendering/service_extensions.dart:130,139 | Semantics tree dump | Partial: render a11y sidecar has no service plane |
| A10 | `ext.flutter.inspector.getProperties` / `getChildren` / `getRootWidget*` | widgets/service_extensions.dart:341,353,388,404,416,430 | Tree and property queries | Not advised: depends on a runtime object tree (red line 2); expose a separate data plane keyed by IR node id |
| A11 | `ext.flutter.inspector.dispose*` / `setSelectionById` / `getSelected*` | widgets/service_extensions.dart:203,214,239,317,456,472 | Object handles and selection state | Not advised: the object-handle model conflicts with the IR id model |
| A12 | `ext.flutter.inspector.screenshot` | widgets/service_extensions.dart:496 | Screenshot service | Not advised: requires render-host cooperation; not a protocol-plane feature |

## B - Requires cross-repo work

| # | Extension | Flutter source | Owner |
|---|---|---|---|
| B1 | `debugPaint` / `debugPaintBaselinesEnabled` / `repaintRainbow` (pixel side) | rendering/service_extensions.dart:47,58,70; rendering/debug.dart:36,39,67,330-335 | render (painting) + web (DOM/canvas) |
| B2 | `debugDisableClipLayers` / `debugDisablePhysicalShapeLayers` / `debugDisableOpacityLayers` | rendering/service_extensions.dart:90,101,112; rendering/binding.dart:140-180 | render |
| B3 | `debugDumpRenderTree` (constraints/sizes) | rendering/service_extensions.dart:121; rendering/binding.dart:184-188 | render (layout data plane) |
| B4 | `profileRenderObjectPaints` / `profileRenderObjectLayouts` | rendering/service_extensions.dart:150,161 | render (per-node timing) |
| B5 | `showPerformanceOverlay` | widgets/service_extensions.dart:53 | render + web (on-screen overlay) |
| B6 | `profilePlatformChannels` | services/service_extensions.dart:29 | core (channel protocol P2) + server |
| B7 | `evict` (clear image cache) | services/service_extensions.dart:42 | render (image cache_stats is already in `image.rs`) |
| B8 | `invertOversizedImages` | rendering/service_extensions.dart:35 | render |
| B9 | `debugAllowBanner` | widgets/service_extensions.dart:116 | web (debug banner) |
| B10 | `accessibilityEvaluations` / `ext.flutter.accessibility.*` | widgets/service_extensions.dart:125,550-596; widgets/accessibility_inspector.dart:54-67 | render (a11y semantics tree) + platform (platform bridge) |
| B11 | `ext.flutter.inspector.trackRepaintWidgets` / `trackRebuildDirtyWidgets` (pixel side) | widgets/service_extensions.dart:166,192 | render (repaint/rebuild instrumentation) |
| B12 | `ext.flutter.inspector.getLayoutExplorerNode` / `setFlex*` (layout editing) | widgets/service_extensions.dart:506,516,526,539 | render (writable constraints) |
| B13 | `ext.flutter.inspector.show` / `setPubRootDirectories` etc. | widgets/service_extensions.dart:155,257,273,289,305 | web (project root resolution; on our side the project root makes pub root unnecessary) |
| B14 | `ext.flutter.inspector.screenshot` / `widgetLocationIdMap` / `getParentChain` | widgets/service_extensions.dart:496,180,329 | render + web |
| B15 | `ext.flutter.debugDumpFocusTree` | widgets/service_extensions.dart:42 | render (focus tree) |
| B16 | `ext.flutter.fastReassemble` | widgets/service_extensions.dart:81 | core (reassemble semantics) |
| B17 | `exit` (terminate application) | foundation/service_extensions.dart:37 | cli (dev server process) |
| B18 | `connectedVmServiceUri` / `activeDevToolsServerAddress` | foundation/service_extensions.dart:48,59 | cli (no VM Service; needs equivalent session discovery) |
| B19 | `platformOverride` / `brightnessOverride` | foundation/service_extensions.dart:71,82 | render (runtime override), web |
| B20 | Real frame timeline capture (build/raster/vsync) | engine/src/flutter/flow/frame_timings.h:35-42 | core + render (currently injected by the host; raster/shader passed as null) |

## C - Not applicable / N/A

| # | Extension | Reason |
|---|---|---|
| C1 | Widget creation chain part of `ext.flutter.inspector.structuredErrors` | No runtime object tree (red line 2); error plane is expressed as kind/stack |
| C2 | `ext.flutter.inspector.dispose*` family | Object-handle model does not apply; IR node ids have no lifecycle |
| C3 | `ext.flutter.inspector.setFlex*` | Mutating layout at runtime violates IR as the single source of truth; changing layout means changing IR |
| C4 | `ext.flutter.inspector.show` | Flutter-specific select-to-highlight interaction; needs a live drawing channel (B1/B14) |
| C5 | `ext.flutter.inspector.setPubRootDirectories` / `add` / `remove` | Dart pub concept does not apply; our project root is determined by project files |
| C6 | `ext.flutter.inspector.getDetailsSubtree` / `getSelectedWidget` and other object-id queries | Object-id semantics do not apply |
| C7 | `ext.flutter.inspector.screenshot` (protocol side) | Needs host rendering cooperation; belongs to B14; no empty stub on the protocol side |
| C8 | `ext.flutter.debugAllowBanner` (native app) | Only meaningful as a web/debug banner; not relevant to native |
| C9 | `ext.flutter.invertOversizedImages` | Only debugs image decode cost; a render implementation detail |
| C10 | `ext.flutter.connectedVmServiceUri` / `activeDevToolsServerAddress` | No VM Service architecture; equivalent is cli dev server session discovery (B18) |
| C11 | `ext.flutter.inspector.isWidgetCreationTracked` | No runtime object creation tracking |
| C12 | `ext.flutter.inspector.trackRepaintWidgets` (object level) | Same as C2; pixel-side data plane is B11 |

## Execution order

1. A1-A3 (first-frame semantics, string rather than boolean) -> `opurom/firstFrame`.
2. A5 (structured error plane) -> `opurom/error`.
3. A6/A7/A9 (complete the tree data plane) -> land after agreeing the shape with cli/web.
4. B items advance by render/cli/core ownership; no empty stubs in this repo.
