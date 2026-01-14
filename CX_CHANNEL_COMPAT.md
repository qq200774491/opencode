# OpenCode 通过 CX 渠道“伪装检测”的处理记录

> 2026-01-13：88code 对 `instructions` 做**严格逐字校验**（多一个空格/少一个字都 400）。因此最终仍需启用 `opencode-openai-instructions-compat.mjs` 做“完美拟造”；同时保留 `opencode-openai-codexlike-shim.mjs` 处理无状态续聊（`item_reference`/`rs_*`/孤儿 tool output 等）。

## 目标

让 `opencode run -m openai/gpt-5.2 "ping"` 在「CX 专用渠道」/兼容网关环境中通过检测并可正常返回。

## 现象与根因（测试阶段：88code）

当 OpenCode 经由本地转发（`http://127.0.0.1:23111/openai/v1` → 88code）请求 OpenAI Responses API 时，出现两类 400：

1. `instructions` 校验失败：上游要求 `instructions` 必须是 *Codex CLI GPT-5.2* 的 **base_instructions** 原文，否则返回 `Instructions are not valid` / `Instructions are required`。
2. `max_output_tokens` 不支持：请求 JSON 顶层包含 `max_output_tokens` 时，上游返回 `Unsupported parameter: max_output_tokens`。

核心结论：**必须“完美拟造” Codex CLI 的 `instructions`，并对不兼容字段做“减法”。**

## 做法（让测试通过的最小闭环）

### 1) “完美拟造”：注入 Codex CLI 的 base_instructions

新增/维护 OpenCode 插件：`/home/kangwsldebian/.config/opencode/opencode-openai-instructions-compat.mjs`。

它做了两件事：

- 从本机 Codex CLI 二进制中提取 GPT-5.2 的 `base_instructions` 字符串（作为唯一权威来源）。
- 在 OpenCode 的 `chat.params` hook 中，把 OpenAI provider 的 `output.options.instructions` 统一设置为该 `base_instructions`（实现“伪装”）。

> 现在此插件对 **所有 OpenAI 请求** 都启用伪装（不再只针对 88code）。

### 2) “做减法”：剥离上游不支持字段（仅用于测试链路）

测试阶段通过 mitmproxy 在转发层对 `POST /openai/v1/responses` 的 JSON body 做清洗，删除 `max_output_tokens`（并可选删除 `max_tokens/maxOutputTokens` 变体），从而避免上游 400。

该步骤用于证明根因与验证可行性；现在已将运行链路恢复到 cch，不再依赖该转发。

### 3) “贴近 Codex CLI”：规避 rs_* item 引用链路（修复 `Item with id 'rs_...' not found`）

现象：OpenCode 在部分续聊/压缩/恢复场景会把历史 Response Item 的 `id`（例如 `rs_...`）带回 `input`，在 CX/CCH 网关侧经常触发：

- `Item with id 'rs_...' not found. Items are not persisted when store is set to false...`

Codex CLI 的默认行为（非 Azure Responses endpoint）是：

- `store` 默认不启用持久化；
- 不会在 `input` 里序列化历史 item 的 `id`（除 Azure + store 特例外）。

因此新增 OpenCode 插件：`/home/kangwsldebian/.config/opencode/opencode-openai-codexlike-shim.mjs`，仅作用于 OpenAI provider：

- 强制 `store: false`；
- 删除 `previous_response_id`（避免依赖上游持久化与跨网关引用失效）；
- 从 `input` 里剥离所有 `item_reference` 块，并删除会导致引用的 item `id`（保留 `call_*` 用于 tool 输出配对，避免 `rs_*` 引用）；若出现“tool 输出引用不到 tool call”（`No tool call found... call_id=call_*`），会将孤儿 tool output 降级为普通 **assistant message**（保留输出文本，但不再走严格 tool 配对）以避免 400；
- 补齐 `conversation_id/session_id` 请求头（更贴近 Codex CLI）。

## 现已恢复的运行态（非抓包/非转发）

- OpenAI provider `baseURL` 已恢复为：`http://127.0.0.1:23000/v1`（cch）。
- `opencode.json` 已重新启用插件：`./opencode-openai-instructions-compat.mjs`（全量伪装）。
- `opencode.json` 已启用：`./opencode-openai-codexlike-shim.mjs`（规避 rs_* 引用）。
- OpenCode 实际使用的凭据文件为：`~/.local/share/opencode/auth.json`（`opencode auth list` 可确认）。其中 OpenAI key 已更新为你指定的 key。

## 如何再次进入抓包/对照测试模式（可选）

1. 临时把 OpenAI `baseURL` 改为本地转发地址（例如 `http://127.0.0.1:23111/openai/v1`）。
2. 启动 mitmdump/mitmproxy 进行捕获或改写。
3. 用 `opencode run -m openai/gpt-5.2 "ping"` 验证请求字段与返回码。
4. 验证完成后把 `baseURL` 还原回 `http://127.0.0.1:23000/v1` 并停止转发。
