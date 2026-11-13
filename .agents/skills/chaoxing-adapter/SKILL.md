---
name: chaoxing-adapter
description: 超星学习通（Chaoxing）全功能适配器技能。涵盖 DES 登录、D1 Cookie 缓存复用、全类型签到、课程课件资料 RAG 下载提取、双轨 AI 批量客观题+主观题作答及草稿暂存。
---

# `chaoxing-adapter` 学习通全链路操作指南

本模块从已验证的 `chaoxing-signin` 工程提纯升级而来，位于 `packages/adapters/chaoxing/` 与 `edge/src/chaoxing.ts`。

## 0. 协议原生架构（Protocol-First）

- **极低资源开销（< 30MB RAM）**：超星学习通的所有在读课程扫描、作业题目与选项抽取（`fetch` + `jsdom` 解析）、课件资料下载（PPT/PDF/DOCX/TXT/MD）与 RAG 文本提取、通知公告以及签到打卡，**全部通过轻量原生 HTTP 接口完成**，在几秒内即可极速完成全量拉取。
- **何时需要无头 Chromium 浏览器？** 只有在进行视频课件刷课（学习通对视频播放有切屏失焦探测与行为心跳审计）时，才按需拉起 Chromium 浏览器。日常扫描、资料下载与作业提取完全无需启动庞大的浏览器进程，保护云主机 1GB 内存不爆开。

## 1. 常用 CLI 指令速查

在项目根目录下（确保 `.env` 已配置 `CHAOXING_PHONE` 和 `CHAOXING_PASSWORD`）：

1. **全量扫描在读课程、待交作业与课件数量**：
   ```bash
   pnpm afk scan
   ```
2. **批量下载全部在读课程的课件参考资料（自动提取 `.extracted.txt` 供 RAG 检索）**：
   ```bash
   pnpm afk materials
   ```
3. **结合课程资料 + 双轨模型自动解答待做作业（默认安全暂存草稿 `pyFlag=1`）**：
   ```bash
   pnpm afk solve
   ```
4. **自动解答并直接正式提交（`pyFlag=3`）**：
   ```bash
   pnpm afk solve --auto-submit
   ```

## 2. 双轨答题与资料 RAG 工作原理

1. **资料上下文提取（RAG）**：
   - 自动拉取课程下的资料列表（PPT/PDF/DOCX/TXT/MD），提取可读文本片段。
   - 针对每道作业题干提取核心学科关键词，在课程资料库中进行相关性打分检索（`searchCourseMaterialsContext`）。
2. **D1 题库缓存优先**：
   - 计算题目唯一指纹 `sha256(type + normalizedTitle + normalizedOptions)`，若命中缓存直接 0 Token 秒回。
3. **Medium 批量客观题 JSON + XHigh 专项主观/编程题**：
   - 单选、多选、判断、填空题一次性打包发给 `AFK_FLASH_MODEL`（默认 `gemini-4-hydrogen-medium`），返回结构化 JSON 映射。
   - 简答、论述、编程题单独路由给 `AFK_PRO_MODEL`（默认 `gemini-4-hydrogen-xhigh`），并在 `downloads/courses/<课程名>/homeworks/` 下生成完整的 UTC+8 Markdown 报告。
