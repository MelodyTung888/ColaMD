# ColaMD Melody

这是 Melody 独立维护的 macOS Apple Silicon 版本。`main` 是唯一长期主线；官方 `marswaveai/ColaMD` 只作为只读上游，在 Melody 明确要求核查时比较，并在她逐项批准后选择性移植。不得自动合并、自动同步或向上游提交 PR。详细流程见 [docs/upstream-sync.md](docs/upstream-sync.md)。

## 产品定位

**Markdown as Database 的原生编辑器与模板渲染平台。**

### 解决的核心问题

HTML 难改——结构、样式、内容全混在一起，人改麻烦，Agent 改也要理解整个文件。

解法：把内容从 HTML 里剥离出来，放进 markdown。HTML 变成纯模板，markdown 变成数据库。改内容只改 markdown，完全不碰 HTML。

### 战略方向

- **内容层**：`.md` 文件，字段固定，人和 Agent 都能轻松编辑
- **模板层**：各种 HTML 模板（PPT、游戏化界面、博客、简历、产品落地页……）
- **ColaMD Melody**：连接两者的工具，也是这个生态的入口

一份 markdown，多种渲染形态。未来第三方可以基于同一份 markdown 做自己的模板。

### 核心理念：Markdown as Database

Markdown 不只是文档，而是**结构化内容的数据源**。

- **Markdown = 数据**：用固定字段（frontmatter + 约定的 section 结构）承载内容，Agent 只需按字段改内容
- **HTML 模板 = 视图**：模板负责样式、动效、交互，不关心内容
- **解耦**：换模板就是换皮，换内容不影响模板
- **简单约定优先**：宁可让 markdown 字段固定一些，也不要让模板去猜语义

## 设计哲学

### 如非必要，勿增实体

这是 ColaMD 的第一原则。每增加一个 UI 元素、一个功能、一行代码，都要问：这是绝对必要的吗？默认答案是否。

- 不要工具栏（用户会用快捷键和 Markdown 语法）
- 不要强制常驻侧边栏（打开文件时显示单根层级文件树，可用 ⌘⇧B 隐藏）
- 不要状态栏
- 界面只有：标题栏（拖拽用）+ 编辑器 + 文件列表面板
- 追求极致的简单，一个功能做到极致

### 核心功能优先级

1. **文件热更新**（核心卖点）— 外部 Agent 修改 .md 时自动刷新，实时看到 Agent 的工作
2. **所见即所得** — 输入 Markdown 即刻渲染为富文本
3. **层级文件树** — 单击文件夹原地展开/收起；使用单一、会话级根目录，按展开状态懒加载和监听；支持右键新建、移到废纸篓、创建文件副本和导出目标文件
4. **主题系统** — CSS 主题，可导入自定义主题
5. **导出** — PDF、HTML

### UI 视觉与交互规范

- **图标统一使用线性 SVG**：功能图标不使用 Unicode 字符、Emoji 或系统字体图标代替。
- **线条统一**：默认 `stroke-width: 1.3`，使用 `stroke-linecap="round"` 和 `stroke-linejoin="round"`；同一组图标的尺寸、视口和视觉重量保持一致。
- **同类控件统一**：文件、文件夹、返回上级等图标应使用同一套线性图标语言，不允许单独引入粗细或风格不同的符号。
- **图标必须可理解**：每个图标按钮都要有 hover 文字说明，同时设置 `title` 和 `aria-label`；说明文字使用简洁、自然的中文。
- **优先复用样式**：图标尺寸、间距、颜色和 hover 状态统一放在共享 CSS 中，避免在业务代码里写零散样式。
- **克制可见元素**：遵循“如非必要，勿增实体”，只在确有功能价值时增加图标、按钮或提示。

### 发布约定

- 每个大版本更新后：在 `resources/demo/changelog.md` **追加**本版更新内容，并更新对应的演示文件（Help 菜单 → 新功能演示，⌘⇧D）
- 演示目录是**可玩的 changelog**：changelog.md 记录更新历史，同目录的演示文件让用户上手玩，而不是只读文字
- 演示页已接入菜单，打包时随 extraResources 发布
- 只构建 macOS arm64；产品名为 `ColaMD Melody`，Bundle ID 为 `com.melody.colamd`，Release 与更新源只指向 `MelodyTung888/ColaMD`
- 发布前必须通过 `npm run check`、签名、Notarization 和安装后实机验证；仅有构建产物不等于已发布
- Release workflow 只引用 GitHub Secrets `CSC_LINK`、`CSC_KEY_PASSWORD`、`APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID`；仓库和文档不得保存它们的值。Secrets 未配置时 workflow 应明确失败，不得降级发布未签名包
- 未经 Melody 明确批准，不得 push、打 tag、创建 GitHub Release 或代表她对外发布

### 文件树边界

- 每个窗口同一时间只有一个树根；树根和展开状态仅属于当前应用会话，不落盘为 Workspace/Vault。
- 窗口尚无根时，以首次打开文件所在目录作为会话根；打开根内深层文件不改变树根。用户主动选择新根，或从系统打开根外文件时，才替换当前根；不维护多根集合。
- 初始化只读取根目录的直接子项；展开文件夹时才读取并监听该文件夹，收起后停止不必要的深层监听。
- 单击文件夹只展开/收起，不再把侧栏导航成该文件夹的单层列表；打开深层文件后保持当前树结构并高亮目标。
- 目录变化只刷新受影响的已加载分支，不递归扫描整个磁盘。
- 文件系统写操作只在主进程执行。新建不得覆盖同名项；删除使用 macOS 废纸篓；文件副本使用不冲突的同目录名称。
- 右键导出必须以被点击的 Markdown 文件为目标；不得在后台切换或污染当前文档、未保存状态、滚动位置与树状态。

### 不做的事情

- 不做持久化 Workspace/Vault、多根工作区或启动时全量递归扫描
- 不做知识库管理
- 不做云同步、协作编辑
- 不做笔记组织和标签系统
- 不加不必要的 UI 元素（工具栏、状态栏等）
- Melody 版不构建、不发布、不承诺支持 Windows、Linux 或 Intel Mac

## 技术栈

- Electron（macOS Apple Silicon 桌面应用）
- Milkdown（基于 ProseMirror 的 WYSIWYG Markdown 框架）
- TypeScript 严格模式
- electron-vite（构建）
- electron-builder（打包）

## 项目结构

```
src/
├── main/           # Electron 主进程
│   └── index.ts    # 窗口管理、文件 I/O、菜单、文件监听
├── preload/        # 安全 IPC 桥接
│   └── index.ts
└── renderer/       # 渲染进程
    ├── index.html
    ├── main.ts     # 入口，连接编辑器和 IPC
    ├── editor/     # Milkdown 编辑器核心
    ├── themes/     # CSS 主题 + 主题管理器
    └── env.d.ts
```

## 开发规范

- TypeScript 严格模式
- 编辑器核心与 UI 解耦
- 主题 CSS 与编辑器逻辑完全分离
- 代码简洁，不过度设计
- 每个新功能先问：这是必要的吗？
- UI、图标、间距和交互规范详见 [design.md](design.md)，所有参与者提交界面改动前都应检查贡献清单。
- 本地验收至少运行 `npm run typecheck`、`npm run build` 和 `git diff --check`；`npm run check` 汇总前两项。
