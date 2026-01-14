# 环境权限
- 当前用户 `kangwsldebian` 拥有 **无密码 sudo 权限** (`sudo -n`)
- 可直接访问 Pelican 服务器卷：`/var/lib/pelican/volumes/`

# 本地开发工具优先级
- **Pelican 面板操作**（服务器启停/重启/kill/控制台命令）：必须优先用 `pelican-panel-kit`，避免直接用 docker 或手工 UI
- **IDEA MCP / 类型检查 / Problems**：必须优先用 `idea-mcp-typecheck` skill
- **日志排查**：必须优先用 `pz-log-triage` 或关键词过滤（`ERROR`/`Exceptitack trace`），避免整文件读取
  - 客户端：`/mnt/c/Users/Admin/ZomboidB42/console.txt`、`/mnt/c/Users/Admin/ZomboidB42/Logs/`
  - 服务端：`/var/lib/pelican/volumes/<UUID>/Zomboid-saves/server-console.txt`、`/var/lib/pelican/volumes/<UUID>/Zomboid-saves/Logs/`
- **自动化测试**：优先用 `pz-rcon-kit` 通过 RCON 执行测试命令
- **最新社区信息/issue/临时修复**：必须优先用 `grok-search-enhance`
- **精确定位代码/符号/引用关系**：优先用 Serena MCP；ACE 负责模糊检索，IDEA MCP 负责 Problems/类型检查

# Git 仓库规范
- 允许且鼓励对需要版本库自行创建 git 仓库并 commit
- **Workshop 小模组**：必须在每个 mod 子目录单独 `git init`（如 s/mods/<mod>/`），严禁在 `mods` 顶层建仓库

# 代码风格
- 精简高效、无冗余
- 注释与文档遵循**非必要不形成**原则
- **仅对需求做针对性改动**，严禁影响现有功能

# ACE-Tool 检索策略
- 禁止在过大根目录（如 `/home/kangwsldebian/`）直接搜索，避免超时
- 禁止基于假设回答，使用自然语言构建语义查询
- 必须获取相关类、函数、变量的完整定义与签名，若上下文不足则递归检索
