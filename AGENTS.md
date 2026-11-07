# AGENTS.md

面向所有 AI 编码工具的仓库级约定（ChatGPT / Codex、Claude Code、opencode、DeepSeek harness、WorkBuddy、Cursor 等）。
**动手前先读完本文件；涉及界面样式时，再读对应的规范文件。**

## 1. 项目速览

- LinkMigo：社媒公开资源解析/下载工具。Next.js 16 App Router + React 19 + Tailwind CSS v4，纯 JavaScript（无 TypeScript）。
- 入口页：`src/app/page.js`、`src/app/social-downloader/page.js` → `src/app/social-downloader/_components/social-downloader-client.js`（单文件客户端组件，承载全部交互状态）。
- 解析逻辑：`src/lib/social-downloader/*`（按平台拆分）。
- API 路由：`src/app/api/v1/**`。
- 全局样式：`src/app/globals.css`；主题皮肤：`src/app/social-downloader/_theme/<theme>/`。

## 2. 运行与自检

```bash
npm install
npm run dev                     # 默认主题，http://localhost:3000
THEME=cohere npm run dev        # Cohere 主题
npm run build                   # 生产构建（提交前至少跑一次）
```

主题由环境变量决定：`LINKMIGO_THEME` 或 `THEME`，只接受 `default` / `cohere`（见 `src/lib/app-config.js`）。
没有第三个主题，也不要在客户端动态切主题名——主题是不可变的服务端输入。

## 3. 界面样式：先读规范

| 主题 | 权威规范 | 落地文件 |
|---|---|---|
| `default` | 无独立规范；保持现有视觉不变 | `social-downloader-client.js` 内的 `colorModeTokens` / `buttonThemes` |
| `cohere` | **`design-md/cohere/UI-PARADIGM.md`（强制）** | `src/app/social-downloader/_theme/cohere/**` |

`design-md/cohere/DESIGN.md` 是 Cohere 品牌营销站的视觉采集，只作参考，**不约束应用 UI**。
两套规范冲突时，以 `UI-PARADIGM.md` 为准。

### 3.1 主题隔离（最重要的一条）

- Cohere 的样式、token、组件**只能**作用在 `[data-ui-theme="cohere"]` 上，不得改变默认主题的任何像素。
- 默认主题的数据表（`colorModeTokens`、`buttonThemes`、`darkPlatformThemeOverrides`）禁止为 Cohere 修改。
- 共享组件里允许出现 `theme.uiTheme === "cohere" ? … : …` 的二选一分支；**不允许**把 Cohere 类名拼进默认分支。
- `cohere.css` 中每条规则都必须以 `.lm-page[data-ui-theme="cohere"]` 开头。

### 3.2 Cohere 主题硬性要求（摘要，细则见 UI-PARADIGM.md）

1. 视觉基线：Apple HIG（材质分层、hairline、克制动效）+ Adobe Spectrum 2（灰阶、统一形态、token 体系）。
2. 交互基线：Adobe **React Aria Components**。按钮/切换/分段/chip 从 `_theme/cohere/controls.js` 取，不要用 `div` + `onClick` 手搓。
3. 布局：一个窗口 + 左右两栏（侧栏 / 主面板），两栏**必须等高同顶**；偏好控件在侧栏 foot，不许浮动在右上角挤占面板高度。
4. 颜色与材质：灰阶打底 + 一个功能蓝（焦点/选区）；每个面板必须是「半透明渐变 + 高斯光斑 + backdrop blur」的玻璃层，禁止纯色不透明大板、禁止平台品牌色铺底、禁止裸十六进制色值（除 token 定义处）。
5. 圆角只取 `--c-radius-*`（6/8/10/12/18）或 pill；禁止 `rounded-[1.75rem]` 这类一次性值。
6. 交互状态用 RAC 的 `data-hovered / data-pressed / data-selected / data-focus-visible / data-disabled`，不要手写 hover class。
7. 改完在 1440×900 与 390×844、light 与 dark 四种组合下各看一眼，并跑一遍 `THEME=default` 确认默认主题没变。

## 4. 代码约定

- 文案：中英双语文案集中在 `copyByLanguage`，新增文案必须同时补 `zh` 与 `en`。
- 状态：页面级交互状态集中在 `social-downloader-client.js`；新增子组件优先做成纯展示 + 回调，避免第二处状态源。
- 请求：客户端一律走 `apiUrl()` 拼接，错误用 `getApiError()` 归一化。
- 依赖：能不新增就不新增；确需新增时在 `design-md/cohere/UI-PARADIGM.md` 的「实现契约」里补一行说明（当前唯一新增：`react-aria-components`）。
- 日志：客户端行为用 `logClientAction()`，不要在渲染期调用。

## 5. 不要做的事

- 不要改 `docker-compose.yml`、`dist/`、`scripts/docker-*` 里的发布流程来"顺便"验证 UI。
- 不要为通过界面验收而改动解析/下载的服务端逻辑。
- 不要引入 UI 框架（MUI/Antd/shadcn 等）或 CSS-in-JS；Tailwind + 原生 CSS 变量已够用。
- 不要在没有需求的情况下"顺手美化"默认主题。
- 不要删除 `.workbuddy/` 目录（项目数据）。

## 6. 变更自查

1. `npm run build` 通过。
2. `THEME=cohere` 与默认主题各截一张图对比。
3. 若改了 `_theme/cohere/**` 或 `isCohereTheme` 分支，逐条勾掉 `UI-PARADIGM.md` §6 的验收清单。
