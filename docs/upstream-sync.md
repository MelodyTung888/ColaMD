# ColaMD Melody 上游核查与选择性移植

## 当前维护边界

- `main` 是 ColaMD Melody 唯一长期主线，不另设长期的“官方同步分支”或“向上游 PR 分支”。
- `origin` 指向 `MelodyTung888/ColaMD`，负责 Melody 版代码和经批准后的独立 Release。
- `upstream` 指向 `marswaveai/ColaMD`，只用于读取和比较。不得向 upstream push，也不得自动把 upstream 合并进 `main`。
- 只有 Melody 明确要求“检查官方更新”时，才获取上游最新引用并开始核查。
- 当前最后核查的官方基线为 `47e94ffba3588eab2d703107363d743880983e29`（短哈希 `47e94ff`）。

## 核查流程

1. 确认 Melody 版工作区干净或已妥善隔离现有改动。
2. 只读获取 `upstream` 最新引用，不切换或改写 `main`。
3. 从“最后核查基线”到上游最新提交，分别整理：功能、Bug 修复、安全、依赖/构建发布、文档，以及与 Melody 定制的潜在冲突。
4. 对每项给出“建议吸收 / 可忽略 / 需要实验”的判断、理由、影响文件和验证成本。
5. 等 Melody 逐项决定；未批准项不得进入 Melody 版。
6. 获批项在临时分支或隔离 worktree 中选择性移植，完成类型检查、构建和 macOS 实机回归后，再请求合入 `main`。
7. 记录新的已核查基线和取舍结论，避免下次重复分析。

## 禁止事项

- 不执行整包自动合并，不把“能合并”当作“应该合并”。
- 不因上游版本号更高就覆盖 Melody 的 `productName`、`appId`、发布仓库、签名、自动更新源或 macOS-only 边界。
- 不向上游提交 PR，不代表 Melody 对外发言。
- 未经 Melody 明确批准，不 push、不打 tag、不创建 Release。

## Melody 定制回归清单

- `ColaMD Melody` 与官方版可并行安装，Bundle ID 仍为 `com.melody.colamd`。
- 只产出 macOS arm64 的 `.dmg` / `.zip`。
- 文件夹原地多层展开；一个会话根；按展开状态懒加载与监听；无持久化 Workspace/Vault 和全量扫描。
- 右键新建、创建副本、移到废纸篓、PDF/HTML 目标文件导出均工作正常。
- 当前文件有未保存内容时，导出另一个文件不会切换或污染当前编辑状态。
- 编辑器纵向滚动条仍有易于鼠标拖动的命中宽度。
- `npm run typecheck`、`npm run build` 与 `git diff --check` 均通过。
