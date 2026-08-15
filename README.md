# 智种计 · 种子计数与质量分析小程序

> 面向农业育种场景的微信小程序，集成计算机视觉（YOLO）、多模态 AI 问答、统计分析与数据导出。

---

## 一、体验入口

| 方式 | 说明 |
|------|------|
| **微信扫码** | 下方二维码（小程序已发布，需微信真机扫描）|
| **录屏演示** | 见 `docs/demo/` 目录（脱敏截图，敏感信息已遮挡）|
| **本地运行** | 用微信开发者工具导入本项目，点击"预览"生成临时码 |

> 注：小程序 AppID 及云环境 ID 已在 `project.config.json` 中，但 API Key（百度千帆、阿里云 DashScope、Anthropic）未上传至仓库；本地运行时云函数调用会因缺少 Key 而失败，前端逻辑（图片压缩、手势缩放、RPN 计算器）可正常体验。

---

## 二、项目结构

```
zhizhongji/
├── miniprogram/                # 小程序前端（WXML / WXSS / JS / TS）
│   ├── app.js / app.json       # 全局初始化、页面注册、底部 TabBar
│   ├── pages/
│   │   ├── index/              # ★ 种子计数（YOLO + 质量检测核心页）
│   │   ├── ai/                 # ★ 多模态 AI 问答（文件/图片分析、文档生成）
│   │   ├── calculator/         # ★ 农业计算器（RPN 表达式 + 种子用量公式）
│   │   ├── describe/           # 我的（账号入口 + 数据汇总）
│   │   ├── describe_tag/       # 标签生成（样本序号自动递增）
│   │   ├── describe_report/    # 报告导出（TXT / Excel）
│   │   ├── describe_sampling/  # 置信度统计分析
│   │   ├── describe_correction/# 质量纠错
│   │   ├── describe_measure/   # 株高测量记录
│   │   ├── describe_weight/    # 籽粒称重
│   │   ├── history/            # 历史记录列表
│   │   └── seed_history/       # 计数历史（含质检等级）
│   └── utils/
│       ├── describe-account.js # 用户鉴权 + 分用户 Storage
│       ├── seed-history.js     # 计数历史 CRUD（最多 500 条）
│       ├── util.ts             # 时间格式化工具
│       └── xlsx.full.min.js    # SheetJS（Excel 导出）
│
├── cloudfunctions/             # 后端云函数（部署至微信云开发）
│   ├── vision_diagnose/        # ★ 种子质量检测（百度千帆 ERNIE-4.5-VL）
│   ├── aiAgent/                # ★ 多模态助手（阿里 DashScope Qwen + 文档生成）
│   ├── doubaoChat/             # 通用对话（百度千帆 qianfan-sug-8k）
│   └── agent-zhizhongji-*/    # CloudBase AI Agent（调用 Qwen-VL）
│
├── server/
│   └── agent_server/
│       └── app.py              # ★ LangGraph 推理服务（FastAPI）
│
├── typings/                    # 微信 API TypeScript 类型定义
├── project.config.json         # AppID、云环境 ID
└── tsconfig.json               # TS 编译配置
```

---

## 三、核心功能 & 关键文件说明

### 3.1 种子计数页（`pages/index/index.js` · 1031 行）

**完整流程：**

```
用户选图
  → 本地压缩（Canvas 缩到 800px，JPEG 0.85）→ 400KB→80KB
  → 上传至 YOLO API（https://yolo.kzehealth.com/api/seedcount）
  → 解析检测坐标（兼容多种字段名：cx/center_x/x）→ 归一化到 0-1
  → 蓝色圆点叠加显示在原图上
  → 用户可手动点击添加/撤销红点（手动补漏）
  → 点击"质检" → 生成编号图或拼图 → 调用 vision_diagnose 云函数
  → ERNIE 返回缺陷编号列表 → 映射回 YOLO 坐标 → 标注有色圆点
  → 计算通过率 → 评出一/二/三级
```

**设计亮点：**
- 压缩后复用同一 `smallFilePath` 供质检使用，避免二次上传（[index.js:235](miniprogram/pages/index/index.js#L235)）
- YOLO 响应加 `return_image=0` 参数，跳过服务端绘图，响应体积减少 80%（[index.js:294](miniprogram/pages/index/index.js#L294)）
- 质检采用"编号图"策略：Canvas 将 YOLO 检测点绘制为带序号的标签，ERNIE 直接读编号，避免让 VLM 估算坐标（[index.js:576](miniprogram/pages/index/index.js#L576)）

---

### 3.2 质量检测云函数（`cloudfunctions/vision_diagnose/index.js`）

调用百度千帆 `ernie-4.5-turbo-vl`，System Prompt 严格约束输出格式：

```javascript
// 核心 Prompt 片段（脱敏展示）
`你是专业的种子质量检测员。
- 以图中占多数的种子种类为基准品种
- 杂粒：颜色/形状/大小明显不同的其他品种种子
- 缺陷粒：霉变、破损、虫蛀等物理损伤
- 以 JSON 返回，不得使用 Markdown，不得编造画面中不存在的信息
- 格式：{"defect_details":[{"label":"杂粒","count":3,"indices":[1,5,7],...}]}`
```

---

### 3.3 多模态 AI 助手（`pages/ai/index.js` · 1727 行 + `cloudfunctions/aiAgent/`）

| 能力 | 实现 |
|------|------|
| 图片分析 | 上传至云存储 → `qwen-vl-max` |
| 文档解析 | DOCX/XLSX/PDF 本地提取文本 → `qwen-max`；扫描版 PDF 回退 DashScope fileid API |
| Word 生成 | 云函数 `docx` 包 → 上传至云存储 → 消息中返回下载链接 |
| PDF 生成 | `pdfkit` + 内嵌 NotoSansSC CJK 字体（[aiAgent/index.js:224](cloudfunctions/aiAgent/index.js#L224)）|
| 多轮对话 | 本地 Storage（主）+ 云数据库（副，异步同步，上限 50 条会话）|
| 意图路由 | 正则匹配"生成标签/称重/计算器…"直接跳转，不调用 AI（[ai/index.js:1680](miniprogram/pages/ai/index.js#L1680)）|
| 打字机效果 | 30ms/字符逐字显示（[ai/index.js:57](miniprogram/pages/ai/index.js#L57)）|

**LangGraph 服务**（`server/agent_server/app.py`）：
FastAPI + LangGraph 三节点状态机（router → fetch_data → analyze），集成 `claude-sonnet-4-6`，支持多轮会话，通过 `session_id`（用户 openid）维护上下文。

---

### 3.4 农业计算器（`pages/calculator/index.js` · 416 行）

- **表达式引擎**：Tokenize → Shunting-Yard（中缀转 RPN）→ 栈求值，支持 `%`、优先级、括号
- **种子用量公式**：`用量(g) = 目标株数 ÷ 发芽率% × 千粒重(g) ÷ 1000`

---

## 四、AI 协作说明

本项目在开发过程中使用 **Claude Code（claude-sonnet-4-6）** 进行 AI 辅助编程，主要协作方式如下：

### 4.1 协作范围

| 模块 | AI 参与情况 |
|------|-------------|
| YOLO 坐标兼容解析（[index.js:313-341](miniprogram/pages/index/index.js#L313)）| AI 协助设计多字段名兼容逻辑，覆盖 5+ 种 API 响应格式 |
| 质检编号图策略 | AI 提出"让 ERNIE 读编号而非估坐标"的替代方案，精准度显著提升 |
| PDF 中文字体方案 | AI 给出 pdfkit + NotoSansSC woff2 内嵌方案，解决云函数环境无系统字体的问题 |
| LangGraph 状态机结构 | AI 协助设计三节点路由逻辑及数据拼接格式 |
| 缺陷标记坐标映射（[index.js:877-918](miniprogram/pages/index/index.js#L877)）| AI 协助调试三种 positions/indices/seed_indices 的兜底分支 |

### 4.2 协作方式

- **方式**：在 Claude Code CLI 内交互式编写，人工 Review 后采纳或修改
- **人工把关**：所有涉及 API Key 处理、用户数据存储、质检评级规则均由人工复核
- **未使用 AI 的部分**：微信小程序页面布局（WXML/WXSS）、云函数部署配置、业务需求定义

---

## 五、测试样例

### 样例 1：YOLO 种子计数（模拟请求 / 脱敏响应）

**请求**（小程序端 `wx.uploadFile`）：
```
POST https://yolo.kzehealth.com/api/seedcount
Content-Type: multipart/form-data
File: seeds_compressed.jpg (约 76KB)
formData: { return_image: "0" }
```

**响应**（脱敏，字段名已按实际格式还原）：
```json
{
  "count": 247,
  "detections": [
    { "center_x": 123.4, "center_y": 88.2 },
    { "center_x": 201.7, "center_y": 154.6 },
    "...(共 247 条)"
  ],
  "image_width": 800,
  "image_height": 600
}
```

**前端处理结果**：
```
归一化坐标数量: 247
蓝色检测点叠加显示于原图
totalCount = 247（YOLO）+ 3（用户手动补漏）= 250
```

---

### 样例 2：种子质量检测（`vision_diagnose` 云函数调用）

**前端发起**（[index.js:827](miniprogram/pages/index/index.js#L827)）：
```javascript
wx.cloud.callFunction({
  name: 'vision_diagnose',
  data: {
    imageBase64: '<base64_编号图_约120KB>',
    question: '请分析图中各编号种子，找出杂粒和缺陷粒，以JSON格式返回'
  }
})
```

**ERNIE 4.5-turbo-VL 返回**（脱敏）：
```json
{
  "defect_details": [
    { "label": "杂粒", "count": 3, "indices": [12, 45, 89], "color": "#EF4444" },
    { "label": "霉变粒", "count": 2, "indices": [23, 67], "color": "#F59E0B" }
  ],
  "total_count": 247,
  "normal_count": 242,
  "pass_rate_pct": 98.0,
  "quality_grade": "一级"
}
```

**最终展示**：
- 红色圆点标注 3 颗杂粒坐标（从 YOLO 检测数组按 index 反查）
- 橙色圆点标注 2 颗霉变粒
- 底部质检面板：**通过率 98.0% · 一级**

---

## 六、真实排错记录

### Bug：质检后缺陷标记点全部偏移到图片左上角

**现象**（2026 年某次迭代）：
质检完成后，ERNIE 返回的缺陷 `positions` 坐标能正常解析，但标注圆点全部集中在图片左上角附近，与实际缺陷种子位置严重不符。

**排查过程**：

1. **首先怀疑坐标系问题**：打印 `defectMarkers`，发现 x/y 值均在 `0.01~0.05` 范围，而正常 YOLO 坐标归一化后约 `0.1~0.9`。
   
2. **检查 ERNIE 响应**：发现 ERNIE 返回的是 `positions: [{x: 0.03, y: 0.02}, ...]`，值域确实接近 0。
   
3. **定位根因**：当时代码直接用 `d.positions[i].x * imgW` 换算像素，但 ERNIE 输出的是相对于"编号图缩略图"（约 400×400）的绝对坐标，而 `imgW/imgH` 是原图尺寸（800×1200）。缩略图坐标未经还原就直接乘以原图尺寸，导致数值严重偏小。

4. **另一个隐患**：部分测试图 ERNIE 返回了像素绝对坐标（如 `x: 312, y: 208`），另一些返回了归一化坐标（`x: 0.39, y: 0.26`），需要动态判断。

**修复方案**（[index.js:906-917](miniprogram/pages/index/index.js#L906)）：
```javascript
// 动态判断 positions 是绝对像素还是归一化坐标
const anyLarge = d.positions.some(p => Number(p.x) > 2 || Number(p.y) > 2);
const maxX = anyLarge ? Math.max(...d.positions.map(p => Number(p.x))) : 1;
const maxY = anyLarge ? Math.max(...d.positions.map(p => Number(p.y))) : 1;
d.positions.forEach(pos => {
  const nx = anyLarge ? Number(pos.x) / (maxX * 1.05) : Number(pos.x);
  const ny = anyLarge ? Number(pos.y) / (maxY * 1.05) : Number(pos.y);
  defectMarkers.push({ x: nx * imgW, y: ny * imgH, color, label });
});
```

**更好的根本方案**：放弃依赖 `positions` 坐标，改为优先使用 ERNIE 返回的 `indices`（种子编号），从原始 YOLO 检测数组反查精确坐标。编号图策略使 ERNIE 只需识别数字，完全规避坐标系歧义（[index.js:898-904](miniprogram/pages/index/index.js#L898)）。

**经验教训**：多模态模型的坐标输出格式不稳定（绝对像素 vs 归一化），优先设计成"让模型输出离散编号，再由程序映射坐标"的解耦架构，健壮性更高。

---

## 七、技术栈一览

| 层次 | 技术 |
|------|------|
| 前端 | 微信小程序（WXML/WXSS/JS/TS）、Canvas 2D、SheetJS |
| 后端云函数 | Node.js，微信云开发（部署/存储/数据库） |
| 推理服务 | Python FastAPI + LangGraph + LangChain |
| AI 模型 | ERNIE 4.5-turbo-VL（百度千帆）、Qwen-VL-Max / Qwen-Max（阿里 DashScope）、Claude Sonnet 4.6（Anthropic）|
| 计算机视觉 | YOLO（自托管 REST API）|
| 数据存储 | wx.Storage（本地）、微信云数据库（同步）|
| 文档生成 | docx（Word）、pdfkit + NotoSansSC（PDF）|

---

## 八、敏感信息说明

以下内容已从代码仓库中移除或脱敏：
- 各 AI 平台 API Key（百度千帆、阿里 DashScope、Anthropic）
- 微信云开发环境 ID（`cloud1-*`，仅保留在 `project.config.json` 中用于本地开发）
- 用户 openid 及测试数据
- YOLO 服务器地址（脱敏替换为 `https://yolo.kzehealth.com`，实际服务正常运行）

如需运行完整功能，请在对应云函数中配置自己的 API Key，或联系作者获取测试密钥。

---

*最后更新：2026-05-20*
