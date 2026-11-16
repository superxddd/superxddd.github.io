# 许达的技术博客

使用 Hugo 和 GitHub Pages 构建，访问地址：<https://superxddd.github.io/>。

## 写文章：直接放入 Markdown

把 `.md` 文件放进 `content/posts/`，提交并推送到 GitHub 的 `main` 分支即可。GitHub Actions 会自动构建并发布网站。普通 Markdown 可以直接使用，不需要填写任何额外信息：

```markdown
# PostgreSQL 学习笔记

这里开始写正文。

## 第一个小节

正文内容……
```

例如，将文件保存为 `content/posts/PostgreSQL学习笔记.md`。未指定标题时，网站使用**文件名**作为文章标题；正文里的 `#` 标题仍会显示在文章内容中。未指定日期时，优先使用该文件最近一次 Git 提交的日期；本地未提交的文件则使用文件修改时间。因此修改文章后，自动日期可能变化，如需固定日期请使用下面的可选信息。

### 直接在 GitHub 网页上写

1. 登录有仓库写入权限的 GitHub 账号，打开 [新建文章](https://github.com/superxddd/superxddd.github.io/new/main/content/posts)。
2. 输入以 `.md` 结尾的文件名，在编辑框中写 Markdown，也可以使用 GitHub 的预览功能。
3. 点击 **Commit changes**，将文件提交到 `main` 分支。发布进度可以在仓库的 [Actions 页面](https://github.com/superxddd/superxddd.github.io/actions)查看。

也可以打开 [文章目录](https://github.com/superxddd/superxddd.github.io/tree/main/content/posts)，选择 **Add file → Upload files** 上传已有的 `.md` 文件，然后提交到 `main`。编辑已有文章时，在 GitHub 上打开该文件并点击铅笔图标即可。

### 可选：标题、日期和分类

需要自定义标题、固定日期或添加分类和标签时，在文件开头添加以下信息；不需要时可以整个省略：

```markdown
---
title: "PostgreSQL 学习笔记"
date: 2026-11-16
categories: ["pg基础"]
tags: ["PostgreSQL", "学习笔记"]
draft: false
---

这里开始写正文。
```

将 `draft` 设为 `true` 可以暂时不发布。没有填写分类的文章会出现在归档的“其他”中。

### 图片

可以把图片上传到 `static/images/posts/`，然后在文章中使用网站路径引用，例如：

```markdown
![图片说明](/images/posts/example.png)
```

请同时提交图片和文章。仅引用自己电脑上的绝对路径，或者只上传 Markdown 而不上传图片，网站无法显示图片。

## 本地预览

安装 Hugo Extended 0.145.0 后，在仓库根目录运行（与 GitHub Actions 使用的版本一致）：

```bash
hugo server -D
```

打开 <http://localhost:1313/>。`-D` 会让本地预览包含草稿；正式发布时草稿不会显示。

## 仓库结构

- `content/posts/`：文章 Markdown。
- `static/images/posts/`：文章图片。
- `config.toml`：站点配置和导航菜单。
- `layouts/`：首页、文章页和归档等自定义模板。
- `assets/css/extended/`：按基础、首页、内容、其他页面和响应式样式拆分的自定义 CSS。
- `themes/PaperMod/`：当前使用的主题。
- `.github/workflows/hugo.yml`：GitHub Pages 自动发布流程。
