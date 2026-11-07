---
id: cohere-ui-paradigm
version: 2.0.0
status: normative
applies_to: '[data-ui-theme="cohere"]'
reads_this_before:
  - any edit under src/app/social-downloader/_theme/cohere/**
  - any edit guarded by isCohereTheme / theme.uiTheme === "cohere"
  - any new component, dialog or control that will render in the Cohere theme
sources_of_truth:
  tokens: src/app/social-downloader/_theme/cohere/tokens.js
  skin: src/app/social-downloader/_theme/cohere/cohere.css
  controls: src/app/social-downloader/_theme/cohere/controls.js
  shell: src/app/social-downloader/_theme/cohere/cohere-sidebar.js
  reference: design-md/cohere/DESIGN.md  # 品牌营销站视觉，仅供参考，不作为应用 UI 规则
foundations:
  visual: Apple Human Interface Guidelines（材质、层级、克制）
  system: Adobe Spectrum 2（灰阶、形态、token 体系）
  interaction: Adobe React Aria Components（RAC）
non_negotiables:
  - Cohere 的任何样式、token、组件都不得影响 default 主题。
  - 每个面板都是"半透明渐变 + 高斯光斑 + backdrop blur"的玻璃层，禁止纯色不透明大板。
  - 光斑只能低饱和、大半径；禁止平台品牌色、禁止高饱和糖果色铺底。
  - 交互状态只由 RAC 的 data-* 属性驱动，不用 JS 手写 hover/active。
  - 左右两栏必须等高、同顶、同底；任何控件不得挤占某一栏的高度。
---

# Cohere 应用 UI 范式 v2

本文件是 LinkMigo **Cohere 主题**的唯一权威规范。默认主题（`data-ui-theme="default"`）不受本文件约束，
也不得因为本文件改动而发生变化。

规范优先级：`本文件` > `cohere.css / tokens.js 现状` > `design-md/cohere/DESIGN.md`。
当实现与本文冲突时，先改实现；确需例外，必须在 PR/提交说明里写明理由并更新本文。

---

## 1. 设计立场

Cohere 主题不是一个"营销页皮肤"，而是一套**桌面级应用界面**：

| 来源 | 取什么 | 不取什么 |
|---|---|---|
| Apple HIG | 材质（material）分层、毛玻璃、hairline 分隔、克制的动效、聚焦环、留白节奏 | 大圆角卡片堆叠、阴影炫技 |
| Adobe Spectrum 2 | 一套灰阶、语义化 token、统一形态（圆角/间距/字号） | 高饱和品牌色大面积铺底、复杂插画 |
| React Aria Components | 键盘、焦点、按压、禁用语义 | 用 div + onClick 拼控件 |

三条判断标准，任何设计决策都可以拿它们检验：

1. **这层表面为什么存在？** 每一层背景/边框都要能回答"它区隔了什么"。答不出来就删掉。
2. **同一屏有且只有一个最强的元素。** 主操作只有一处（搜索按钮），其余降级为 quiet / ghost。
3. **状态变化靠材质与描边，不靠颜色堆叠。** 悬停/选中/聚焦用 fill、hairline、ring 表达。

---

## 2. Token 体系（强制）

所有颜色、圆角、阴影、动效必须来自 `cohere.css` 的 CSS 变量，或 `tokens.js` 里供共享 builder 读取的键。
**禁止在 Cohere 分支里写十六进制字面色值**（`#fff`、`rgba(0,0,0,.1)` 等），除非该值本身就是 token 定义。

### 2.1 灰阶（Spectrum 2）

`--c-gray-25 … --c-gray-1000`，只用于定义语义变量，业务样式**不要直接引用灰阶**。

### 2.2 语义变量

| 变量 | 用途 | Light | Dark |
|---|---|---|---|
| `--c-label-1` | 主文本、标题 | `#1d1d1f` | `#f5f5f7` |
| `--c-label-2` | 次要文本、说明 | `#6e6e73` | `#a1a1a6` |
| `--c-label-3` | 元信息、辅助标签 | `#8e8e93` | `#8e8e93` |
| `--c-label-4` | 占位符、禁用文本 | `#a1a1a6` | `#7c7c80` |
| `--c-fill-1…4` | 控件底色、chip、选中底 | `rgba(120,120,128,.08→.22)` | `.16→.42` |
| `--c-hairline` | 结构分隔线（窗口、栏） | `rgba(0,0,0,.10)` | `rgba(255,255,255,.12)` |
| `--c-hairline-soft` | 弱分隔（行、卡） | `rgba(0,0,0,.07)` | `rgba(255,255,255,.08)` |
| `--c-accent` | 唯一功能色：焦点环、选区、链接 | `#1473e6` | `#378ef0` |
| `--c-ink` / `--c-on-ink` | 主操作填充/文字（黑底白字，暗色反转） | `#1d1d1f` / `#fff` | `#f5f5f7` / `#1d1d1f` |
| `--c-positive` | 状态点（就绪） | `#1f9d55` | `#32d74b` |
| `--c-negative` | 错误 | `#c9252d` | `#ff6961` |

### 2.3 材质（玻璃）

每个表面由三层叠加而成，缺一不可：

1. **底色** `--c-{surface}-bg`：半透明灰，不透明度 ≤ 0.34（light）/ 0.58（dark）。
2. **渐变** `--c-{surface}-grad`：168~172deg 的极浅明暗过渡，让面板有"受光"方向。
3. **磨砂** `backdrop-filter: var(--c-blur)` + 窗口级噪点（`.c-window::after`）。

| 变量 | 表面 | 透明度上限 |
|---|---|---|
| `--c-canvas` | 应用画布（窗口之外） | 不透明 |
| `--c-window-bg` / `--c-window-grad` | 窗口底 | 0.26 / 0.44 |
| `--c-sidebar-bg` / `--c-sidebar-grad` | 侧栏（比主面板略暗，"内凹"） | 0.20 / 0.30 |
| `--c-pane-bg` / `--c-pane-grad` | 主面板（比侧栏亮，"浮起"） | 0.24 / 0.40 |
| `--c-field-bg` / `--c-field-grad` | 输入框 | 0.30 / 0.60 |
| `--c-card-bg` / `--c-card-grad` | 内容卡片 | 0.46 / 0.64 |

侧栏必须比主面板**暗**，主面板必须比侧栏**亮**。反了就等于没有层级。

### 2.4 光斑与噪点

- `.c-aurora` 是窗口内的一层高斯光斑（蓝 / 紫 / 青 / 粉四个方向），负责给玻璃"上色"。
  单色 alpha ≤ `0.46`（light）/ `0.26`（dark），`filter: blur(52-58px)`，禁止锐利边缘。
- 光斑必须铺到主面板中部（`58% 52%` 附近至少一个），否则面板中央会重新变回白板。
- `.c-window::after` 是磨砂颗粒（SVG fractalNoise），light `0.10`、dark `0.11`，`mix-blend-mode: soft-light`。
  超过 0.14 会显脏，禁止调高。
- 光斑与噪点都属于**材质**，不是装饰：它们必须被面板的 `backdrop-filter` 糊开，不能直接画在文字下面。

### 2.4 形态

| 变量 | 值 | 用于 |
|---|---|---|
| `--c-radius-xs` | 6px | 分段控件内部滑块、小徽标 |
| `--c-radius-sm` | 8px | 按钮、chip 组 |
| `--c-radius-md` | 10px | 输入框 |
| `--c-radius-lg` | 12px | 卡片、空状态图标 |
| `--c-radius-window` | 18px | 应用窗口 |
| `999px` | pill | 只给标签/chip，不给按钮 |

**禁止**使用 Tailwind 的 `rounded-[2rem]`、`rounded-[1.75rem]` 这类一次性圆角。旧代码里出现的，
在 Cohere 分支中必须替换为 `.c-card`（12px）或以上 token。

### 2.5 阴影与动效

| token | 规则 |
|---|---|
| `--c-shadow-1` | 卡片：极紧的 1px + 0.5px 描边，不要扩散大阴影 |
| `--c-shadow-2` | 浮层（菜单、popover） |
| `--c-shadow-window` | 窗口：一层投影 + 一层 0.5px 环 + 顶部内高光 |
| `--c-dur` / `--c-ease` | 200ms / `cubic-bezier(.32,.72,0,1)`，属性变化只用颜色与位移，不用 scale 弹跳 |

---

## 3. 布局契约（强制）

```
┌────────────── .c-root（画布，≥1024 时 padding 20px）──────────────┐
│ ┌──────────────────────── .c-window ────────────────────────────┐ │
│ │ ┌── .c-sidebar ──┐ │ ┌────────── .c-pane ──────────────────┐ │ │
│ │ │ eyebrow/status │ │ │ .c-pane-head（52px，hairline 下边）  │ │ │
│ │ │ title          │ │ ├─────────────────────────────────────┤ │ │
│ │ │ subtitle       │ │ │ 空状态 / 加载 / 错误 / 结果区       │ │ │
│ │ │ field          │ │ │                                     │ │ │
│ │ │ primary action │ │ │                                     │ │ │
│ │ │ chips          │ │ │                                     │ │ │
│ │ │ (spacer)       │ │ │                                     │ │ │
│ │ │ foot(prefs)    │ │ │                                     │ │ │
│ │ └────────────────┘ │ └─────────────────────────────────────┘ │ │
│ └───────────────────────────────────────────────────────────────┘ │
└───────────────────────────────────────────────────────────────────┘
```

硬性规则：

1. **一个窗口，两个面板。** 不额外套卡片，不出现"面板中再有带边框面板"的双层框。
2. **两栏等高、同顶。** `grid-template-rows: minmax(0, 1fr)`，任一侧都不得加 `pt-*` 去给浮动控件让位。
3. **偏好控件属于侧栏 foot，不浮动在页面右上角。** 这是 v1 的核心缺陷：右上角浮层把主面板压矮 56px。
4. 结构分隔只有三种线：窗口外框、侧栏右/下边框、`c-pane-head` 下边线。再加边框就是噪音。
5. `≥1024px` 侧栏宽 `minmax(18.5rem, 21rem)`；`<1024px` 单列堆叠，窗口可纵向滚动，主面板最小高度 `56svh`。
6. 空状态、加载态、结果区都填满 `c-pane`；内容不贴着面板边缘，内边距由 `.c-pane-head` 与内容容器各自负责。

---

## 4. 组件契约

### 4.1 React Aria Components 映射

| 语义 | RAC 组件 | Cohere 类名 | 备注 |
|---|---|---|---|
| 文字按钮 | `Button` | `.c-btn` + `--primary` / `--quiet` / `--ghost` | 一律传 `type`；表单提交传 `type="submit"` |
| 分段控件 | `ToggleButtonGroup` + `ToggleButton` | `.c-seg` / `.c-seg-item` | `selectionMode="single"` + `disallowEmptySelection` |
| 可选 chip | `ToggleButton` | `.c-chip` | 平台筛选 |
| 输入框内小按钮 | `Button` | `.c-field-clear` | 清除输入 |
| 文本输入 | 原生 `textarea rows=1` + `.c-field` 容器 | `.c-field` / `.c-input` | 容器负责焦点环；输入框本身无边框；随内容增高（22→92px），长链接触发换行而非横向滚动 |
| 对话框 | `Dialog` + `Modal`（**迁移中**） | `.c-dialog` | 新对话框必须用 RAC，不要复制旧遮罩实现 |

已迁移：侧栏、偏好、chip、清除按钮。未迁移：帖子详情、下载选项、小红书登录、评论等旧对话框
（它们目前依赖 `coherePostChrome()` 提供的单色 chrome）。**改这些对话框时优先迁移到 RAC。**

### 4.2 按钮尺寸与层级

| 变体 | 高度 | 字号/字重 | 用途 |
|---|---|---|---|
| `--primary` + `--lg` | 42px | 13.5 / 550 | 一屏唯一主操作（搜索） |
| `--primary` | 36px | 13 / 550 | 结果区内主操作（下载选中） |
| `--quiet` | 36px | 13 / 550 | 次级操作（登录、重置） |
| `--ghost` | 32px | 13 / 500 | 弱操作（重置、行内动作） |

同一屏最多一个 `--primary`；超过一个就降级。

### 4.3 分段控件

- 高度 28px 胶囊容器的变体：`padding: 2px` + 24px 滑块。
- 选中滑块 Light 用 `#fff`，Dark 用 `rgba(255,255,255,.18)`；**不要**用主色填充。
- 文字 11.5px / 550，未选中 `--c-label-2`，选中 `--c-label-1`。

### 4.4 状态（由 RAC 输出，禁止自造）

| 属性 | 表达 |
|---|---|
| `data-hovered` | 填充加深一级（fill-1 → fill-2），文字升一级 |
| `data-pressed` | `transform: scale(.982)`（`prefers-reduced-motion` 下取消） |
| `data-focus-visible` | `box-shadow: 0 0 0 3px var(--c-focus-ring)`；**只用键盘聚焦时出现** |
| `data-selected` | chip 反相为 `--c-ink` 底；分段滑块加 1px 阴影 |
| `data-disabled` | 填充降为 `--c-fill-2`，文字 `--c-label-4`，无阴影、无位移 |

### 4.5 空状态

结构固定：`44px` 图标块（fill-1 + hairline，**不加渐变、不加阴影**，避免上下出现假高光）→ 15px/600 标题 → 13px 说明（`max-width: 36ch`）。
不放大插画、不加按钮、不加营销文案。

---

## 5. 实现契约

### 5.1 文件落点

```
src/app/social-downloader/_theme/cohere/
  tokens.js         # 共享 builder 读取的表面 token（light/dark）
  cohere.css        # 唯一允许的 Cohere 样式层，全部以 [data-ui-theme="cohere"] 开头
  controls.js       # RAC 原语：CohereButton / CohereSegmented / CohereChip / CohereFieldButton
  cohere-sidebar.js # 侧栏（含偏好 foot）
```

页面组件（`social-downloader-client.js`）只在**分叉点**出现 Cohere 分支，且必须满足：

```jsx
// 允许：结构性分叉，默认分支保持原样
{isCohereTheme ? <CohereSidebar … /> : <div className="…旧样式…">…</div>}

// 允许：共享组件内部按主题切换类名
className={theme.uiTheme === "cohere" ? "c-card" : "rounded-[1.2rem] backdrop-blur-xl"}

// 禁止：把 Cohere 的类名混进默认主题的类名列表
className={`rounded-full ${isCohereTheme ? "c-btn" : ""}`}  // ❌
```

### 5.2 隔离规则

1. `cohere.css` 的**每一条规则**都必须以 `.lm-page[data-ui-theme="cohere"]` 开头。无例外。
2. 不得修改 `colorModeTokens`、`buttonThemes`、`darkPlatformThemeOverrides` 等默认主题的数据。
3. 共享样式构造函数（`buildPrimaryButtonStyle` 等）只允许在 `theme.uiTheme === "cohere"` 分支内改变行为。
4. `!important` 仅用于"旧内联样式桥接"，集中在 `cohere.css` 第 5 节，新增一条都要在注释里写明被桥接的组件。
5. 新增依赖需在本文档记录用途；目前唯一新增依赖是 `react-aria-components`。

### 5.3 新增一个控件

1. 先判断能否用 RAC 现成组件表达语义（按钮？切换？选择？对话框？）。
2. 在 `controls.js` 里封装，导出带 `Cohere` 前缀的组件。
3. 在 `cohere.css` 的「4. Controls」区添加类名，只使用 token 变量。
4. 用 `data-hovered / data-pressed / data-selected / data-focus-visible / data-disabled` 写状态。
5. 在 1440 / 390 两个宽度、light / dark 两种模式下各看一次。

---

## 6. 验收清单

提交任何 Cohere UI 改动前逐条确认：

- [ ] 1440×900：左右两栏 `getBoundingClientRect()` 的 `y` 与 `height` 完全一致。
- [ ] 页面右上角没有任何浮动控件；偏好控件在侧栏 foot。
- [ ] 截图内只存在三种分隔线（窗口框、栏分隔、pane head），没有"框中框"。
- [ ] 所有圆角 ∈ {6, 8, 10, 12, 18, pill}，没有 `rounded-[1.75rem]` 之类。
- [ ] Light / Dark 都检查：文本对比度 ≥ 4.5:1（正文），禁用态可辨识但明显弱于可用态。
- [ ] 390×844：单列堆叠可滚动，主面板不被压扁，按钮不被裁切。
- [ ] 键盘 Tab：焦点环可见且只在键盘操作时出现；Enter/Space 可触发按钮与切换。
- [ ] 切换 `THEME=default` 后，默认主题视觉与改动前一致（对比截图）。
- [ ] 空状态 / 加载 / 错误 / 结果 / 模态 五种状态至少各看一次。

---

## 7. 已知取舍

| 项 | 现状 | 后续 |
|---|---|---|
| 对话框 | 旧遮罩 + 单色 chrome，未用 RAC `Dialog` | 逐个迁移，优先级：帖子详情 > 下载选项 > 登录 |
| 结果区工具条 | 仍是共享按钮类名 + token 配色 | 可抽成 `CohereToolbar`，统一 36px 高 |
| 骨架屏 | 使用 `.c-card--solid` + 中性 shimmer | 可加 `--c-skeleton-*` token |
| 字体 | 系统 UI 栈（SF / PingFang / Segoe） | 若品牌需要，再评估变量字体 |
