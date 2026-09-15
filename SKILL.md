---
name: codex-bridge
description: 观察与跟踪本机 Codex（Codex Desktop / codex-cli）的会话线程，并在用户明确授权下向某个线程投递一条消息。读取 ~/.codex/sessions/**/rollout-*.jsonl（明文 JSONL）汇总目标/轮次/最后发言/工具调用/令牌，区分主施工线程与 auto-review 审批子线程，重建父子线程树，按 mtime 盯梢变化，并用 --verify 独立核对"它声称做了"vs"文件真的变了"。投递走 codex queue（默认 dry-run，需 --yes）。适用于监督另一个 Codex agent、跨 agent 协作、多 agent 并行改同一仓库时判断冲突风险。Observe and track a local Codex session/thread: read its rollout JSONL, summarize goal/turns/last messages/tool calls/tokens, distinguish main threads from auto-review sub-threads, rebuild the parent/child thread tree, watch for changes, independently verify what actually changed on disk, and (only when explicitly authorized) deliver one message via `codex queue`. Do not use it to modify Codex session logs or to impersonate the human user.
---

# codex-bridge：观察/跟踪本机 Codex 会话

## Purpose

DSH 的 `send_message` 只覆盖自己的父子 agent；Codex 是**另一个运行时**，够不着。
但 Codex 自己提供了两条原生通道，本 skill 把它们包成可用动作：

| 方向 | 原生原语 | 本 skill 的命令 |
|---|---|---|
| **读**它做了什么 | `~/.codex/sessions/**/rollout-*.jsonl`（明文，非 zstd） | `list` / `threads` / `state` / `tail` / `watch` |
| 独立核对它动了什么 | 文件 mtime、端口、进程 | `state <id> --verify <目录>` |
| **写**给它一条消息（需授权） | `codex queue --thread <id> --message <text>` | `send`（默认 dry-run） |
| ⭐ **双向**：它也能回我 | 双方共写的 `_collab/` 信箱 + 我挂后台 `await` | `mail post/read/await` |

### ⭐ 为什么需要 `mail`：`send` 是**单向**的

`send` 只能把消息**塞进对方会话**（它以"用户身份"收到）—— 对方**没有地址可以回给我**。
那是"单方面交差"，不是合作。双向需要一个**双方都能读写的落点**：

- 我 → 它：写 `_collab/from-peer.md`，再 `codex queue` 敲一下（**queue 能唤醒它开新一轮**，已实测）；
- 它 → 我：它写 `_collab/to-peer.md`，我挂一个 **`mail await` 后台任务**等它 ——
  **任务结束时宿主会唤醒我**，于是"它主动找我"成立，**且不需要任何 auth 后门**。

对比 `dsh-peer-sessions` 那条路（读签名密钥、打 DSH 内部 `/api`、消息以"用户身份"进对方会话），
信箱方案**不碰凭据、不用内部件、纯文本可审计、可回放**。代价是**唤醒方向不对称**：
我能敲醒它，它只能靠我轮询/挂等待任务来"叫醒"我（而不是直接推）。


**为什么不走 MCP**：DSH 核心不支持 MCP 客户端；而 Codex 的 `codex mcp` 是"让 Codex 去连外部 MCP server"，方向相反。`codex queue` + 明文 rollout 已经够用。

## When to use

- 用户说「看一眼 Codex 在干嘛」「盯着它」「它做到哪了」「帮我跟一下那个 agent」。
- 多个 agent 并行改同一个仓库，要判断谁在动哪些文件、有无冲突风险。
- 要把复核意见留给对方（先 `send` dry-run 看正文，再由用户决定是否 `--yes`）。

## When not to use

- 对象是自己的**子代理** —— 直接用 `subagent` / `send_message`，不要绕道。
- 想修改或删除 Codex 的会话记录 —— **绝不允许**（会破坏其状态与可审计性）。
- 用户没让你投递，你却想"顺手通知它一下" —— 不要。**默认只读**。
- 只想看自己的会话。

## Workflow

1. **发现**：`list` 列出所有 rollout（线程 id / 类别 / 轮次 / 大小 / 最后活动）。
   ⚠️ 必须注意它已经帮你分好的两类：
   - `main(施工线程)` —— 真正在干活的
   - `review(审批子线程)` —— Codex 自己的 auto-review（`model: codex-auto-review`，回复是 `{"risk_level":...}` 风险裁定 JSON）
   **把审批线程的发言当成"它做了什么"是这类工具最常见的误报。**
2. **重建关系**：`threads` 用 `parent_thread_id` 把 rollout 串成树（施工线程 → 它的审批子线程）。
3. **取态**：`state <id|latest>` —— 目标、轮次、最后一条用户/助手消息、最近工具调用、令牌用量、最后活动距今多少秒。
4. ⭐ **独立验证**（本 skill 的核心价值）：`state <id> --verify <目录>`
   去查**它改过的东西**——比 rollout 里它自己的说法可信。典型：文件 mtime、`git status`、端口属主、跑它的门禁。
5. **盯梢**：`watch <id> [秒]` 每 5 秒查一次，有变化就打尾部事件。
6. **投递（仅授权）**：
   ```bash
   node scripts/codex-bridge.mjs send <id> --text "..."          # dry-run，先看正文
   node scripts/codex-bridge.mjs send <id> --file msg.txt --yes  # 真发
   ```
7. **回报**：明确区分「它声称」与「我验证」。

## Output format

```markdown
## Codex 线程概况
- 线程 id / 类别(施工|审批) / cwd / model / 轮次 / 最后活动距今

## 它这一轮实际做了什么（已核实文件确实写盘）
- 逐条：动作 → 落点文件 → 我的验证证据

## 我独立查出的问题
| 问题 | 证据 | 影响 | 建议 |

## 进度 / 风险
[✅] … [🔄] … [ ] … [⚠️] …
```

## Quality checks

- **区分「它说」和「我验」**：没亲自查过的一律标注为对方自述。
- **先看类别**：审批子线程的 `{"risk_level":...}` 不是施工进展。
- **"最后活动"是硬指标**：`state` 会打印距今多少秒；几百秒以上说明它可能停了或在等输入。
- **不要只看 rollout 里的"已完成"**：去跑它自己的门禁、看 mtime、看 `git status`。
- **报告要短**：用户要的是"跟上了什么、有没有坑"。

## Safety boundaries

- **只读** `~/.codex/sessions/**`：永不写入、追加、截断、重命名。
- **默认只读**，`send` 必须显式 `--yes` 才真发。
- **不冒充人类用户**：投递正文会被强制加上 `【来自同级 agent（监理），非人类用户】`。
- **不碰凭据**：不读 `~/.codex/auth.json`，不打印任何 token。
- **不打断对方**：不支持 `steer` 类插话；只允许排队投递一条消息。
- **不夸大**：`codex queue`、rollout 格式都是 Codex 内部件，跨版本可能变；失败如实报告。

## Limitations（先说清楚，别当它全能）

1. **rollout 是"事后"记录**：文件按会话滚动写入，读到的是已落盘的部分。
1.5. ⚠️ **`mtime` 不可信，活跃判定必须采样 `size`。**
   实测：Codex 持有 rollout 文件句柄持续追加时，**Windows 不在目录项上刷新 mtime** ——
   文件从 3.6MB 涨到 4.73MB，mtime 却停在首次写入那一刻。
   第一版据此报"空闲 54 分钟"，而它当时**正在干活** ⇒ 这是本类工具最危险的误判（把在干活的当空闲）。
   `state` 现在会做一次 0.9 秒的双采样给"活跃判定"，但**0.9 秒太短不足以断定空闲**
   （它在两次工具调用之间会思考很久）；**要确定就 `watch` 久一点**。
2. **`send` 的语义是"投一条用户消息"**：在对方的会话里它就是**用户身份**的一轮输入，不是带回执的 agent 消息。想拿回结论要自己回来 `state`/`tail` 看。
3. **`codex agents` 没被本 skill 使用**：它疑似 TUI（会挂住非交互调用），所以枚举一律走 rollout 文件。
4. **平台**：rollout 路径与解析是跨平台的；可执行文件查找在 Windows 用 `where.exe` + `%LOCALAPPDATA%\OpenAI\Codex\bin`，其他平台用 `which`，也可用 `CODEX_BIN` 显式指定。
5. **本 skill 不评估 Codex 的输出质量**：它给证据，判断留给人（或上层 agent）。

## Verification（本 skill 自证跑过什么）

在作者机器上（Windows 11 / codex-cli 0.154.0-alpha.6.2 / 11 个 rollout）实测：

| 命令 | 结果 |
|---|---|
| `list` / `threads` | ✅ 正确区分施工线程与审批子线程、重建父子树 |
| `state`（含 `--verify`） | ✅ 抓到目标、轮次、最后发言、工具调用；`--verify` 立刻发现"4 个不是我做的文件" |
| `tail` / `watch` | ✅ `watch` 12 秒正常等到底并报告"没有变化"；另一次 20 秒抓到 +7502 字节 |
| `send`（不加 `--yes`） | ✅ 输出 dry-run 正文与将要执行的命令行，**不投递** |
| `send --yes`（真发） | ✅ **已实测**：返回 `Queued message <id> for thread <id>`，且对方**确实开了新一轮**（rollout 轮次 4→5、用户消息 6→7，并能看到它在读被指定的文件） |

⇒ **读侧与写侧都已实测。** 但注意：写侧是"投一条**用户身份**的消息、**没有回执**"，
拿到 `Queued message` 只证明**进了队**，**不等于对方处理了** —— 要自己回来 `state`/`watch` 看轮次有没有涨。
