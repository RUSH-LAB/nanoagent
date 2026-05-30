# Mochi Lab Web Editor — 产品规格

## 核心诉求

将 Mochi Lab 从 "VS Code 编辑 → git push → Vercel 部署" 的工作流，
升级为 **浏览器内直接编辑、即时保存、AI 辅助写作** 的体验。

## 设计原则

1. **Markdown 是唯一的内容格式** — 可移植、AI 友好、与 Docusaurus 兼容
2. **所见即所得优先** — 像 Notion/Typora 一样编辑，而不是写代码
3. **AI 是一等公民** — 不是附加功能，而是编辑体验的核心

## MVP (v0.1)

### 编辑器页面 `/editor`

- 左侧文件树：浏览 `content/` 下所有 `.md`/`.mdx` 文件
- 中间编辑区：TipTap 所见即所得编辑器
  - 工具栏：标题、加粗、斜体、代码、链接、列表、引用
  - `Cmd+S` 保存
  - 源码/预览切换（查看原始 Markdown）
- 新建文件、创建文件夹

### 技术栈

- **编辑层**: TipTap (ProseMirror) + tiptap-markdown
- **存储层**: Express API 读写本地文件系统（已有 `server.js`）
- **渲染层**: Docusaurus 页面，使用 `BrowserOnly` 避免 SSR 问题

### 架构

```
Docusaurus App
├── /editor                 ← 新增编辑器页面
│   ├── FileTree            ← 文件浏览器侧边栏
│   └── TipTapEditor        ← 富文本编辑器
│
├── server.js               ← 已有，读写 content/ 目录
│   ├── GET  /api/files     ← 列出文件树
│   ├── GET  /api/file      ← 读取文件
│   ├── PUT  /api/file      ← 更新文件
│   └── POST /api/file      ← 新增：创建文件
│
└── content/                ← Markdown 内容（源真相）
    ├── books/
    └── posts/
```

## v0.2 — AI 辅助写作

- **Slash commands** (`/`): 呼出 AI 菜单
  - `/continue` — AI 续写当前段落
  - `/rewrite` — 改写选中文本
  - `/summarize` — 总结选中内容
  - `/translate` — 翻译（中↔英）
- **Inline 补全**: 写作时 Tab 接受 AI 建议
- **自动链接**: 基于已有笔记推荐内部链接

## v0.3 — 云端编辑

- 通过 GitHub API 直接读写仓库，无需本地运行
- 保存即提交（自动 commit message）
- 在线部署（保存后自动触发 Vercel 构建）

## v0.4 — 知识引擎集成

- 写作时自动引用 Mochi Lab 搜索引擎的结果
- 结构化数据提取（从笔记生成知识图谱）
- 跨文档语义搜索
