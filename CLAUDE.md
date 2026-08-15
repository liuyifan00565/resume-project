# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**智种计** is a WeChat Mini Program for agricultural seed counting and quality analysis. It combines computer vision (via external YOLO API), AI chat assistants, and statistical data tools.

## Development Environment

This project is developed using **WeChat Developer Tools** (微信开发者工具). There is no local dev server — the mini program runs inside the WeChat DevTools simulator.

**TypeScript compilation** (for the `miniprogram/` directory):
```bash
tsc
```

**Cloud function deployment**: Done via WeChat DevTools UI or WeChat CLI. Each cloud function under `cloudfunctions/` has its own `package.json` and must have dependencies installed before deployment:
```bash
cd cloudfunctions/<function-name>
npm install
```

## Project Structure

```
miniprogram/        # WeChat Mini Program frontend (WXML/WXSS/JS/TS)
  pages/            # App pages
  utils/            # Shared utilities (xlsx.full.min.js, etc.)
cloudfunctions/     # Backend cloud functions (Node.js, deployed to WeChat Cloud)
typings/            # TypeScript type definitions for WeChat API
project.config.json # Mini program config (App ID, cloud root, etc.)
```

## Architecture

### Frontend (miniprogram/)

Pages are defined in `app.json`. Key pages:
- **index** — Seed counting: uploads images to `https://yolo.kzehealth.com/api/seedcount`, handles touch gesture scaling/translation, manual point correction
- **calculator** — Expression calculator with complex math evaluation
- **ai** — Multi-modal AI assistant (chat with image/document support)
- **describe** — Hub for data analysis tools:
  - `describe_tag` — Label generation
  - `describe_report` — TXT/Excel report export
  - `describe_sampling` — Statistical confidence analysis
  - `describe_correction` — Quality control / error correction
- **history** / **logs** — History and logging views

Tab bar: 种子计数 → 计算器 → AI助手 → 我的

Data persistence uses `wx.getStorageSync` / `wx.setStorageSync`.

### Backend (cloudfunctions/)

Four cloud functions deployed to WeChat Cloud (env: `cloud1-5g91jejo54a9c31f`):

| Function | Purpose | AI Provider |
|---|---|---|
| `doubaoChat` | AI chat (Doubao/ByteDance) | Doubao API |
| `vision_diagnose` | Image analysis | Baidu QianFan API |
| `aiAgent` | Multi-modal agent, document analysis | Alibaba DashScope (Qwen), `openai` SDK v4 |
| `agent-zhizhongji-*` | CloudBase AI agent | OpenAI SDK v6 via `@cloudbase/node-sdk` |

Cloud functions are invoked from frontend via `wx.cloud.callFunction({ name: '...' })`.

### Key Integrations
- **Seed counting**: External REST API at `https://yolo.kzehealth.com/api/seedcount`
- **AI models**: Qwen (DashScope), Doubao (ByteDance), Baidu QianFan
- **File storage**: `wx.cloud.uploadFile` / `wx.cloud.downloadFile`
- **Spreadsheet**: `miniprogram/utils/xlsx.full.min.js` (SheetJS) for Excel export

## WeChat Mini Program Conventions

- Pages consist of 4 files: `.wxml` (markup), `.wxss` (styles), `.js`/`.ts` (logic), `.json` (page config)
- `app.js` initializes `wx.cloud` and sets the cloud environment
- `app.json` defines global config: pages list, tab bar, window style
- `wx.navigateTo` / `wx.switchTab` for navigation
- Event data passed between pages via `wx.setStorageSync` or URL query params
