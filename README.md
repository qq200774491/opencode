# OpenCode 高级配置方案

这是一个高度定制化的 OpenCode AI 编程助手配置方案，集成了多个 AI 模型、MCP 服务器和自定义插件，专为提升开发效率而设计。

## 🌟 主要特性

- **多模型支持**：集成 Claude Opus 4.5、GPT-5.2、Gemini 3 系列等顶级 AI 模型
- **智能代理系统**：包含 Sisyphus（全能开发）、Oracle（推理专家）、Librarian（文档查询）等专业代理
- **MCP 服务器集成**：支持 ACE、IDEA、Pylance、Pelican、Grok 等多种 MCP 服务
- **自定义插件**：提供 Anthropic 认证代理、OpenAI 兼容层等增强功能

## 📦 项目结构

```
opencode/
├── opencode.json                           # 主配置文件
├── oh-my-opencode.json                     # Oh-My-OpenCode 插件配置
├── package.json                            # 依赖管理
├── opencode-anthropic-auth-proxy.mjs       # Anthropic 认证代理插件
├── opencode-openai-codexlike-shim.mjs      # OpenAI Codex 兼容层
├── opencode-openai-instructions-compat.mjs # OpenAI 指令兼容插件
├── AGENTS.md                               # 代理使用规范
└── CX_CHANNEL_COMPAT.md                    # 通道兼容性说明
```

## 🚀 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 配置文件位置

将此配置放置到以下路径之一：

- **Windows**: `C:\Users\<用户名>\.config\opencode\`
- **macOS/Linux**: `~/.config/opencode/`

### 3. 配置 API 端点

编辑 [opencode.json](opencode.json) 文件，配置你的 API 服务：

```json
{
  "provider": {
    "anthropic": {
      "options": {
        "baseURL": "http://127.0.0.1:23000/v1"  // 修改为你的 API 端点
      }
    },
    "google": {
      "options": {
        "baseURL": "http://your-api-endpoint/v1beta"  // 修改为你的 API 端点
      }
    }
  }
}
```

### 4. 启动 OpenCode

在 VS Code 中启动，配置会自动加载。

## 🤖 代理说明

### Sisyphus（默认代理）
- **模型**: Claude Opus 4.5
- **特点**: 全能开发代理，支持代码编辑、命令执行、网络查询
- **用途**: 日常开发、调试、重构等所有任务
- **思维模式**: 启用深度思考（32000 tokens 预算）

### Oracle（推理专家）
- **模型**: GPT-5.2
- **特点**: 超高推理能力，详细推理摘要
- **用途**: 复杂问题分析、算法设计、架构决策

### Librarian（文档查询）
- **模型**: Gemini 3 Flash
- **特点**: 快速文档检索和信息查询
- **用途**: 查找文档、API 参考、技术资料

### Explore（探索代理）
- **模型**: Claude Haiku 4.5
- **特点**: 轻量级、快速响应
- **用途**: 代码浏览、简单查询

## 🔧 插件功能

### 1. Anthropic 认证代理
自动处理 Anthropic API 的认证流程，支持自定义端点。

### 2. OpenAI Codex 兼容层
将 OpenAI 的 Codex 风格 API 调用转换为标准格式。

### 3. OpenAI 指令兼容
处理 OpenAI 特定的指令格式，确保跨平台兼容性。

### 4. Oh-My-OpenCode
增强的提示词管理和工具优先级协议：
- ACE 优先的上下文检索策略
- IDEA MCP 深度集成（Java/Lua 开发）
- 智能工具选择矩阵
- 严格的编辑协议（防止编辑失败）

## 🛠️ 工具优先级协议

### 上下文检索
1. **首选**: `mcp_ace-tool_search_context`（语义代码搜索）
2. **备选**: explore agent

### 类型检查
1. **首选**: `mcp_idea_get_file_problems`（Java/Lua）
2. **备选**: LSP diagnostics

### 符号定义
1. **首选**: `lsp_goto_definition`
2. **备选**: ACE 搜索

### 社区信息/Issue
1. **首选**: `mcp_grok-search_web_search`
2. **备选**: librarian agent

### 日志排查
1. **首选**: `pz-log-triage` skill
2. **备选**: grep with ERROR filter

## 📋 权限配置

默认配置为开放权限：

```json
{
  "permission": {
    "*": "allow",
    "bash": "allow",
    "edit": "allow",
    "read": "allow",
    "webfetch": "allow",
    "doom_loop": "allow",
    "external_directory": "allow"
  }
}
```

根据安全需求可调整权限级别。

## 🔐 安全建议

1. **API 密钥**: 不要在配置文件中硬编码 API 密钥
2. **本地端点**: 建议使用本地代理服务器管理 API 调用
3. **权限控制**: 生产环境建议限制 `bash` 和 `external_directory` 权限

## 📝 开发规范

参考 [AGENTS.md](AGENTS.md) 文件，包含：

- 环境权限说明
- 工具优先级
- Git 仓库规范
- 代码风格要求
- ACE-Tool 检索策略

## 🔄 更新日志

### 当前版本
- 集成 Claude Opus 4.5 作为主力模型
- 支持 GPT-5.2 超高推理模式
- Gemini 3 Flash/Pro 快速响应
- 完整的 MCP 服务器支持

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

## 📄 许可

请遵循 OpenCode 官方许可协议。

## 🔗 相关链接

- [OpenCode 官方文档](https://opencode.ai/)
- [Oh-My-OpenCode 插件](https://github.com/code-yeongyu/oh-my-opencode)
- [Claude API 文档](https://docs.anthropic.com/)
- [OpenAI API 文档](https://platform.openai.com/docs/)

---

**提示**: 此配置方案为高级用户设计，建议在理解各个组件功能后再进行定制化修改。
