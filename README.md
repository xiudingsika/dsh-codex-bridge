# dsh-codex-bridge

给 [DeepSeek Harness](https://github.com/deepseek-ai)（DSH）用的一个 skill：**观察、跟踪本机的 Codex 会话，并在明确授权下给它投一条消息。**

解决的具体问题：DSH 的 `send_message` 只覆盖自己的父子 agent，而同机跑着的 **Codex（Codex Desktop / codex-cli）是另一个运行时**，够不着。于是"监督另一个 agent"就变成了靠人转述。

Codex 自己其实提供了两条原生通道，这个 skill 把它们包成可用动作：

| 方向 | 原生原语 | 命令 |
|---|---|---|
| **读**它做了什么 | `~/.codex/sessions/**/rollout-*.jsonl`（**明文 JSONL**） | `list` / `threads` / `state` / `tail` / `watch` |
| **独立核对**它动了什么 | 文件 mtime / 端口 / 进程 | `state <id> --verify <目录>` |
| **写**给它一条消息（需授权） | `codex queue --thread <id> --message <text>` | `send`（默认 dry-run） |

**为什么不走 MCP**：DSH 核心不含 MCP 客户端；而 Codex 的 `codex mcp` 是"让 Codex 去连外部 MCP server"，方向正好相反。

## 安装

把这个目录复制到 DSH 的 skills 目录：

```bash
git clone <this-repo> ~/.dsh/skills/codex-bridge
# 或者手工拷：cp -r dsh-codex-bridge ~/.dsh/skills/
```

DSH 会从 `~/.dsh/skills/*/SKILL.md` 加载（YAML frontmatter：`name` + `description`）。

## 用法

```bash
cd ~/.dsh/skills/codex-bridge

node scripts/codex-bridge.mjs list                    # 所有 Codex 线程
node scripts/codex-bridge.mjs threads                 # 父子线程树
node scripts/codex-bridge.mjs state latest            # 概况
node scripts/codex-bridge.mjs state <id> --verify .   # ★ 独立核对它改了什么
node scripts/codex-bridge.mjs tail <id> 20            # 最近事件
node scripts/codex-bridge.mjs watch <id> 60           # 盯一分钟

node scripts/codex-bridge.mjs send <id> --text "..."          # dry-run
node scripts/codex-bridge.mjs send <id> --file msg.txt --yes  # 真发
```

找不到 `codex` 可执行文件时用 `CODEX_BIN` 指定：

```bash
CODEX_BIN=/path/to/codex node scripts/codex-bridge.mjs list
```

## 两个设计要点

1. **区分施工线程与审批子线程。** Codex 会为自己拉起 `codex-auto-review` 子线程，它的"发言"是 `{"risk_level":...}` 风险裁定 JSON。把审批员的碎语当成"它做了什么"，是这类工具最常见的误报——所以 `list` 直接就分成 `main` / `review` 两类。
2. **盯"它改了什么"，而不是"它说它改了什么"。** `--verify <目录>` 用文件 mtime 和线程最后活动时间对照，直接把"声称"和"事实"并排放。这是这个 skill 存在的意义。

## 安全边界

- **只读** `~/.codex/sessions/**`：永不写入、追加、截断、重命名。
- **默认只读**；`send` 不加 `--yes` 只打印正文与将要执行的命令行。
- **不冒充人类用户**：投递正文会被强制加上 `【来自同级 agent（监理），非人类用户】`。
- **不碰凭据**：不读 `~/.codex/auth.json`，不打印任何 token。
- **不打断对方**：不支持 steer 类插话，只排队投一条消息。

## 验证状态（诚实说明）

在一台 Windows 11 机器上（codex-cli 0.154.0-alpha.6.2，11 个 rollout）实测：

| 命令 | 状态 |
|---|---|
| `list` / `threads` / `state`（含 `--verify`）/ `tail` / `watch` / `help` | ✅ 已实测 |
| `send`（dry-run，不加 `--yes`） | ✅ 已实测：只打印，不投递 |
| `send --yes`（真发） | ✅ **已实测**：返回 `Queued message <id> for thread <id>`，且对方确实开了新一轮 |

⚠️ 但 `Queued message` 只证明**进了队**，不等于对方处理了 —— 要自己回来 `state` / `watch` 看轮次有没有涨。

⚠️ 另一个实测坑：**`mtime` 不可信**。Codex 持有 rollout 文件句柄持续追加时，Windows 不刷新 mtime
（实测文件从 3.6MB 涨到 4.73MB 而 mtime 不动），所以**活跃判定要采样 `size`**，别用 mtime ——
否则会把正在干活的对方误判成空闲。

## 已知限制

1. rollout 是**事后**记录，按会话滚动写入；读到的是已落盘部分。
2. `send` 的语义是"在对方会话里投一条**用户身份**的消息"，**没有回执**。想要结论得自己回来 `state` / `tail`。
3. 枚举一律走 rollout 文件，没用 `codex agents`（它疑似 TUI，会挂住非交互调用）。
4. `codex queue` 与 rollout 格式都是 Codex 内部件，**跨版本可能变，失败请如实报告**。

## License

MIT
