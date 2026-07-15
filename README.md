# Web Element Selector

一款强大的网页元素定位工具，用于快速生成 CSS 选择器和 XPath 表达式。

## 功能特性

### 核心功能

- **智能元素选择**：点击页面元素即可生成多种定位器
- **多级别定位器**：提供 Simple、Medium、Advanced 三个级别的定位器
- **CSS 优先**：优先生成 CSS 选择器，同时提供 XPath 备选
- **批量选择**：按住 Ctrl/Cmd + 点击可选择一组相似元素
- **一键复制**：点击定位器或复制按钮即可复制到剪贴板

### 元素类型支持

- ✅ 普通 HTML 元素
- ✅ SVG 元素及其子元素（path、rect、circle 等）
- ✅ 表单元素（input、button、checkbox 等）
- ✅ 链接、图片、表格、列表
- ✅ Shadow DOM（open 模式）
- ✅ 同域 iframe 内的元素

### SVG 元素优化

采用企业级 SVG 定位策略，涵盖图表、图标、流程图等多种 SVG 场景：

- **命名空间兼容**：XPath 全部使用 `*[local-name()='svg']` 写法，彻底避免 SVG 命名空间干扰
- **文本锚定法**：利用 `<text>` 标签作为"灯塔"，通过 `ancestor::g` 反向定位相关图形（图表/流程图场景）
- **Title 子元素定位**：CSS `:has(title)` + XPath 双重支持，利用 tooltip 文字稳定定位
- **祖先元素链策略**：优先使用 HTML 父元素/祖先元素的 class/id 来精确定位 SVG（图标按钮场景）
- **智能 class 过滤**：自动过滤随机生成的无意义 class（纯数字、十六进制哈希等）
- **路径中段匹配**：`d` 属性截取中间 20 字符进行 `contains` 匹配，抗噪性更强
- **Transform 属性**：利用 transform 矩阵特征定位固定布局元素
- **多层级定位器**：使用 1-3 层祖先元素组合提高定位精度
- **位置索引**：同类型多元素时使用 nth-child/position 区分

### 界面功能

- **Captured Elements 列表**：记录所有已选择的元素
- **可折叠面板**：点击标题栏可展开/收起捕获元素列表
- **列表编辑**：List 类型元素支持编辑 Text 字段
- **批量复制**：一键复制所有元素信息
- **Toast 提示**：复制成功后显示提示消息

## 安装方式

### 开发者模式安装

1. 打开 Chrome 浏览器，访问 `chrome://extensions/`
2. 开启右上角的「开发者模式」
3. 点击「加载已解压的扩展程序」
4. 选择本项目目录
5. 扩展安装完成，工具栏会出现扩展图标

## 使用方法

### 基本使用

1. 点击浏览器工具栏的扩展图标，打开侧边栏
2. 点击 **Start Pick** 按钮，进入元素选择模式
3. 鼠标悬停在页面元素上会显示高亮
4. 点击目标元素，定位器会自动生成并显示在列表中
5. 点击定位器文本或 Copy 按钮复制定位器

### 批量选择

1. 点击 **Start Pick** 进入选择模式
2. 按住 **Ctrl**（Windows）或 **Cmd**（Mac）键
3. 点击一组相似元素中的任意一个
4. 自动识别并选中所有相似元素

### 管理捕获的元素

- **查看定位器**：Captured Elements 列表中显示每个元素的最佳定位器
- **复制单个**：点击定位器文本或 Copy 按钮
- **复制全部**：点击 Copy All 按钮复制所有元素信息
- **删除元素**：点击 Delete 按钮删除单个元素
- **编辑列表**：List 类型元素点击 Edit 按钮编辑 Text
- **折叠列表**：点击 Captured Elements 标题栏展开/收起

## 技术实现

### 定位器生成策略

#### CSS 选择器生成优先级：

1. **ID 选择器**（最高优先级，稳定性高）
2. **data-testid / data-cy**（测试友好属性）
3. **aria-label**（无障碍属性）
4. **class 选择器**（有意义的 class 组合）
5. **属性选择器**（name、type、placeholder 等）
6. **父子关系**（父元素 + 子元素）
7. **位置索引**（nth-child、nth-of-type）

#### XPath 生成优先级：

1. **ID 属性**
2. **data-testid 属性**
3. **aria-label 属性**
4. **文本内容**（normalize-space）
5. **属性组合**
6. **轴定位**（父子、兄弟关系）

### SVG 元素定位（企业级策略）

SVG 元素采用七层定位策略，从最稳定到最兜底：

| 优先级 | 策略 | 适用场景 | 示例 |
|-------|------|---------|------|
| 1 | 直接唯一属性 | 有 id/data-testid/aria-label 的 SVG | `//*[@id="close-icon"]` |
| 2 | Title 子元素 | 带 tooltip 的 SVG（`:has(title)`） | `svg:has(> title)` |
| 3 | 文本锚定法 | 图表/流程图，用 text 反向找图形 | `//*[local-name()='text' and text()='营收']/ancestor::*[local-name()='g'][1]/*[local-name()='rect']` |
| 4 | HTML 祖先上下文 | 图标按钮，依赖父元素 class | `.tools-clear-icon svg` |
| 5 | Transform 属性 | 固定布局的元素 | `g[transform*="translate(100"]` |
| 6 | SVG 内部属性 | 基于 viewBox/stroke/fill 等 | `svg[viewBox="0 0 20 20"]` |
| 7 | 位置索引 | 最后兜底手段 | `(//svg)[2]` |

**核心设计原则**：
- **命名空间护身符**：所有 SVG XPath 使用 `*[local-name()='tag']` 写法，防止命名空间干扰
- **优先 contains 而非 =**：属性值用模糊匹配，应对前缀/空格变化
- **避免绝对路径**：绝不生成 `/html/body/div[2]/...` 这类脆弱路径
- **警惕 nth-child**：仅在无其他特征时使用索引定位

## 项目结构

```
webElementLocator/
├── icons/                  # 扩展图标
│   ├── icon16.png
│   ├── icon32.png
│   ├── icon48.png
│   └── icon128.png
├── background.js          # 后台服务 Worker
├── content.js             # 内容脚本（核心逻辑）
├── content.css            # 内容脚本样式
├── manifest.json          # 扩展配置
├── sidebar.html           # 侧边栏 HTML
├── sidebar.css            # 侧边栏样式
├── sidebar.js             # 侧边栏逻辑
└── lucide.js              # 图标库
```

## 已知限制

- **跨域 iframe**：由于浏览器安全限制，无法定位跨域 iframe 内的元素
- **Closed Shadow DOM**：无法访问 closed 模式的 Shadow DOM 内部元素
- **动态生成的随机 ID**：包含随机哈希的 ID 会被识别并过滤
- **SVG 元素**：部分高度相似的 SVG 可能需要依赖父元素定位

## 许可证

MIT License
