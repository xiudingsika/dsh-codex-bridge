// codex-bridge —— 观察/跟踪本机 Codex（Desktop / codex-cli）的会话，并在明确授权下投递消息。
//
// 为什么不用 MCP：DSH 核心不支持 MCP（dsh/lib 里没有 mcp 支持），而 Codex 自身提供
// `codex queue`（给已存在会话投消息）与明文 rollout，两条原生通道已经够用。
//
// 只读命令：list / state / tail / threads / watch / verify
// 有副作用命令：send（默认 dry-run，必须 --yes 才真发）
//
// 用法：
//   node codex-bridge.mjs list
//   node codex-bridge.mjs threads
//   node codex-bridge.mjs state latest
//   node codex-bridge.mjs state <threadId|前缀>  --verify "C:\path\to\repo"
//   node codex-bridge.mjs tail <id> 20
//   node codex-bridge.mjs watch <id> 60
//   node codex-bridge.mjs send <id> --text "..."            # dry-run
//   node codex-bridge.mjs send <id> --file msg.txt --yes    # 真发
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const SESS = path.join(os.homedir(), '.codex', 'sessions');
const EXE_CANDIDATES = [
  path.join(process.env.LOCALAPPDATA || '', 'OpenAI', 'Codex', 'bin'),
];
const SELF_MARK = '【来自同级 agent（监理），非人类用户】';

function findCodexExe() {
  // 1) 显式覆盖（最可移植，也便于测试指向别的安装）
  if (process.env.CODEX_BIN && fs.existsSync(process.env.CODEX_BIN)) return process.env.CODEX_BIN;
  // 2) PATH：Windows 用 where.exe，macOS/Linux 用 which
  for (const finder of ['where.exe', 'which']) {
    const w = spawnSync(finder, ['codex'], { encoding: 'utf8' });
    if (w.status === 0) {
      const p = String(w.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean)[0];
      if (p && fs.existsSync(p)) return p;
    }
  }
  // 3) Windows 桌面版的默认落点：%LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe
  for (const root of EXE_CANDIDATES) {
    if (!root || !fs.existsSync(root)) continue;
    for (const d of fs.readdirSync(root)) {
      const p = path.join(root, d, 'codex.exe');
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

function listRollouts() {
  const out = [];
  if (!fs.existsSync(SESS)) return out;
  (function walk(d, depth) {
    if (depth > 5) return;
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.name.endsWith('.jsonl')) {
        let st; try { st = fs.statSync(p); } catch { continue; }
        out.push({ file: p, name: e.name, size: st.size, mtime: st.mtimeMs });
      }
    }
  })(SESS, 0);
  return out.sort((a, b) => b.mtime - a.mtime);
}

function parseRollout(file, { maxLines = Infinity } = {}) {
  const raw = fs.readFileSync(file, 'utf8');
  const lines = raw.split('\n');
  const rows = [];
  for (let i = 0; i < lines.length && i < maxLines; i += 1) {
    const t = lines[i].trim();
    if (!t) continue;
    try { rows.push(JSON.parse(t)); } catch { /* 跳过坏行，不猜 */ }
  }
  return rows;
}

function textOf(content) {
  if (!Array.isArray(content)) return '';
  return content.map((c) => (c && typeof c.text === 'string' ? c.text : '')).filter(Boolean).join('\n');
}

/** 把一坨原始行汇总成"这个 Codex 线程在干什么"。 */
function summarize(rows, meta) {
  let sm = null, turns = 0, tokens = 0, reasoning = 0;
  const users = [], agents = [], tools = [];
  let settings = null;
  for (const r of rows) {
    if (r.type === 'session_meta' && !sm) sm = r.payload || {};
    if (r.type === 'turn_context' && !settings) settings = r.payload || {};
    const p = r.payload || {};
    if (r.type === 'event_msg' && p.type === 'task_started') turns += 1;
    if (r.type === 'event_msg' && p.type === 'user_message' && typeof p.message === 'string') users.push(p.message);
    if (r.type === 'event_msg' && p.type === 'agent_message' && typeof p.message === 'string') agents.push(p.message);
    // ⚠️ 主施工线程的发言**不走 event_msg**，而是 response_item|message|{role}——
    //    只读 event_msg 的话，"目标/最后发言"会全是空（我第一版就是这样，监理报告里
    //    出现"目标(没抓到)"是危险信号：会让人以为它什么都没说）。
    if (r.type === 'response_item' && p.type === 'message') {
      const txt = textOf(p.content);
      if (txt) {
        if (p.role === 'user') users.push(txt);
        else if (p.role === 'assistant') agents.push(txt);
      }
    }
    if (r.type === 'event_msg' && p.type === 'thread_settings_applied' && p.thread_settings) settings = { ...settings, ...p.thread_settings };
    if (r.type === 'token_usage_record' && p.total_token_usage) tokens = p.total_token_usage;
    if (r.type === 'response_item' && p.type === 'custom_tool_call') tools.push({ name: p.name || '?', input: String(p.input || '') });
    if (r.type === 'response_item' && p.type === 'reasoning') reasoning += 1;
  }
  const isNoise = (s) => !s || s.startsWith('<') || s.includes('environment_context')
    || s.includes('whose request action you are assessing');
  const realUsers = users.filter((s) => !isNoise(s));
  const model = (settings && settings.model) || (sm && sm.model) || '';
  const reviewish = /auto-review/i.test(String(model))
    || agents.slice(-3).some((m) => /"risk_level"\s*:/.test(m));
  return {
    threadId: (sm && sm.id) || (meta && meta.name.replace(/^rollout-/, '').replace(/\.jsonl$/, '')),
    sessionId: (sm && sm.session_id) || '',
    parentThreadId: (sm && sm.parent_thread_id) || '',
    cwd: (sm && sm.cwd) || (settings && settings.cwd) || '',
    originator: (sm && sm.originator) || '',
    cliVersion: (sm && sm.cli_version) || '',
    model,
    // ⚠️ 必须区分主施工线程与 auto-review 审批子线程：后者的"发言"是风险裁定 JSON，
    //    不是它做了什么。混在一起会把审批员的碎语报成施工进展。
    kind: reviewish ? 'review(审批子线程)' : 'main(施工线程)',
    turns,
    title: (realUsers[0] || '').replace(/\s+/g, ' ').slice(0, 120),
    lastUser: (realUsers[realUsers.length - 1] || '').replace(/\s+/g, ' ').slice(0, 300),
    lastAgent: (agents[agents.length - 1] || '').replace(/\s+/g, ' ').slice(0, 400),
    toolCalls: tools.length,
    lastTools: tools.slice(-6).map((t) => t.name + '  ' + t.input.replace(/\s+/g, ' ').slice(0, 110)),
    reasoningItems: reasoning,
    tokens,
    userCount: realUsers.length,
    agentCount: agents.length
  };
}

/** 独立验证：不看它怎么说，看它**动了什么**。 */
function verifyDir(dir, sinceMs) {
  const hits = [];
  const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '__pycache__', '.next']);
  (function walk(d, depth) {
    if (depth > 4 || hits.length > 200) return;
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (SKIP.has(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p, depth + 1); continue; }
      let st; try { st = fs.statSync(p); } catch { continue; }
      if (st.mtimeMs > sinceMs) hits.push({ rel: path.relative(dir, p), mtime: st.mtimeMs, size: st.size });
    }
  })(dir, 0);
  return hits.sort((a, b) => b.mtime - a.mtime).slice(0, 40);
}

// ── 命令实现 ───────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const cmd = argv[0] || 'help';
const arg = (name, def = null) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const has = (name) => argv.includes(name);
const rollouts = listRollouts();
const pick = (which) => {
  if (!which || which === 'latest') return rollouts[0] || null;
  const q = String(which);
  return rollouts.find((r) => r.name.includes(q)) || rollouts.find((r) => r.name.startsWith(q)) || null;
};
const fmtT = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);

if (cmd === 'help' || has('--help')) {
  console.log(`codex-bridge —— 观察/跟踪本机 Codex 会话\n
只读：
  list                          列出所有 rollout（线程 id / 类别 / 轮次 / 最后活动）
  threads                       按父子关系把 rollout 串起来（主线程 ↔ 审批子线程）
  state <id|latest> [--verify DIR]   汇总一个线程：目标/进度/最后发言/工具调用/令牌
  tail <id|latest> [n]          最近 n 条事件（默认 15）
  watch <id|latest> [秒]        盯住变化，变了就打尾部事件（默认 60 秒）
有副作用（默认 dry-run）：
  send <id|latest> --text "..." [--yes]
  send <id|latest> --file msg.txt [--yes]

codex 可执行文件：` + (findCodexExe() || '（没找到）'));
  process.exit(0);
}

if (cmd === 'list') {
  console.log('rollout 共 ' + rollouts.length + ' 个（按最近活动排序）\n');
  console.log('  ' + '线程 id'.padEnd(38) + '类别'.padEnd(20) + '轮'.padStart(4) + '  大小      最后活动');
  for (const r of rollouts) {
    const rows = parseRollout(r.file, { maxLines: 400 });
    const s = summarize(rows, r);
    console.log('  ' + String(s.threadId).padEnd(38) + s.kind.padEnd(20) + String(s.turns).padStart(4)
      + '  ' + String((r.size / 1024).toFixed(0) + 'KB').padStart(7) + '  ' + fmtT(r.mtime));
    if (s.title) console.log('      ' + s.title.slice(0, 100));
  }
  process.exit(0);
}

if (cmd === 'threads') {
  const items = rollouts.map((r) => ({ r, s: summarize(parseRollout(r.file, { maxLines: 400 }), r) }));
  const byId = new Map(items.map((x) => [x.s.threadId, x]));
  const roots = items.filter((x) => !x.s.parentThreadId || !byId.has(x.s.parentThreadId));
  const kids = (id) => items.filter((x) => x.s.parentThreadId === id);
  console.log('Codex 线程树（parent_thread_id 指回父线程）\n');
  for (const root of roots) {
    console.log(`  ▶ ${root.s.threadId}  [${root.s.kind}]  cwd=${root.s.cwd}  轮次=${root.s.turns}  ${fmtT(root.r.mtime)}`);
    if (root.s.title) console.log('      ' + root.s.title.slice(0, 100));
    for (const k of kids(root.s.threadId)) {
      console.log(`      └─ ${k.s.threadId}  [${k.s.kind}]  轮次=${k.s.turns}  ${fmtT(k.r.mtime)}`);
    }
  }
  process.exit(0);
}

if (cmd === 'state') {
  const r = pick(arg(undefined) || argv[1]);
  if (!r) { console.error('找不到该 rollout'); process.exit(2); }
  const rows = parseRollout(r.file);
  const s = summarize(rows, r);
  console.log('=== Codex 线程状态 ===');
  console.log('  线程 id      ' + s.threadId);
  console.log('  session id   ' + s.sessionId + (s.parentThreadId ? '   parent=' + s.parentThreadId : ''));
  console.log('  类别         ' + s.kind + (s.model ? '   model=' + s.model : ''));
  console.log('  工作目录     ' + s.cwd);
  console.log('  originator   ' + s.originator + '   cli=' + s.cliVersion);
  console.log('  轮次         ' + s.turns + '   用户消息=' + s.userCount + '   助手消息=' + s.agentCount);
  console.log('  工具调用     ' + s.toolCalls + '   reasoning=' + s.reasoningItems);
  if (s.tokens) console.log('  令牌         total=' + (s.tokens.total_tokens ?? '?') + '  input=' + (s.tokens.input_tokens ?? '?') + '  cached=' + (s.tokens.cached_input_tokens ?? '?') + '  output=' + (s.tokens.output_tokens ?? '?'));
  console.log('  最后活动     ' + fmtT(r.mtime) + '   （现在 - 最后活动 = ' + Math.round((Date.now() - r.mtime) / 1000) + ' 秒）');
  console.log('\n  目标（首条真实用户消息）');
  console.log('    ' + (s.title || '(没抓到)'));
  console.log('\n  最后一条用户消息');
  console.log('    ' + (s.lastUser || '(无)'));
  console.log('\n  最后一条助手消息');
  console.log('    ' + (s.lastAgent || '(无)'));
  console.log('\n  最近的工具调用');
  for (const t of s.lastTools) console.log('    · ' + t);

  // ── 活跃判定：**必须采样 size，不能看 mtime** ──────────────────────────────
  // 实测坑（2026-09-16）：Codex 一直持有 rollout 文件句柄并追加写入，
  // 而 Windows **不在目录项上刷新 mtime** —— 文件从 3.6MB 涨到 4.73MB，
  // mtime 却一直是首次写入那一刻。第一版据此报"空闲 54 分钟"，
  // 实际它正在干活 ⇒ **会把在干活的当成空闲**，这是监理最危险的一种误判。
  // size 是立即可见的，所以用两次采样之间的增量来判定。
  const sizeA = (() => { try { return fs.statSync(r.file).size; } catch { return 0; } })();
  await new Promise((res) => setTimeout(res, 900));
  const sizeB = (() => { try { return fs.statSync(r.file).size; } catch { return 0; } })();
  const grew = sizeB - sizeA;
  console.log('  活跃判定     ' + (grew > 0
    ? '★ **正在写入**（0.9 秒内 +' + grew + ' 字节）'
    : '0.9 秒内无写入（可能空闲，也可能在思考/等模型返回；要看更久用 watch）'));
  console.log('  ⚠️ mtime 不可信：rollout 由 Codex 持有，Windows 常不刷新它 —— 上面那行才是判据');

  const dir = arg('--verify');
  if (dir) {
    console.log('\n=== 独立验证：它到底动了什么（mtime > 最后活动）===');
    console.log('  目录 ' + dir);
    const hits = verifyDir(dir, r.mtime - 1000);
    if (!hits.length) console.log('    （没有比该线程最后活动更新的文件）');
    for (const h of hits) console.log('    · ' + fmtT(h.mtime) + '  ' + String(h.size).padStart(8) + 'B  ' + h.rel);
  } else {
    console.log('\n  ⚠️ 加 --verify <目录> 可核对"它声称做了"vs"文件真的变了"（本 skill 的核心价值）');
  }
  process.exit(0);
}

if (cmd === 'tail') {
  const r = pick(argv[1]);
  if (!r) { console.error('找不到该 rollout'); process.exit(2); }
  const n = Math.max(1, Number(argv[2]) || 15);
  const rows = parseRollout(r.file);
  const ev = [];
  for (const x of rows) {
    const p = x.payload || {};
    if (x.type === 'event_msg' && p.type === 'user_message') ev.push('USER   ' + String(p.message).replace(/\s+/g, ' ').slice(0, 200));
    else if (x.type === 'event_msg' && p.type === 'agent_message') ev.push('AGENT  ' + String(p.message).replace(/\s+/g, ' ').slice(0, 200));
    else if (x.type === 'response_item' && p.type === 'custom_tool_call') ev.push('TOOL   ' + p.name + '  ' + String(p.input).replace(/\s+/g, ' ').slice(0, 160));
    else if (x.type === 'event_msg' && p.type === 'task_complete') ev.push('DONE   turn=' + String(p.turn_id).slice(0, 8));
    else if (x.type === 'turn_context') ev.push('TURN   ' + String(p.turn_id).slice(0, 8) + '  cwd=' + p.cwd);
  }
  console.log('最近 ' + n + ' 条事件（' + r.name + '）\n');
  for (const e of ev.slice(-n)) console.log('  ' + e);
  process.exit(0);
}

if (cmd === 'watch') {
  const r = pick(argv[1]);
  if (!r) { console.error('找不到该 rollout'); process.exit(2); }
  const secs = Math.max(5, Number(argv[2]) || 60);
  let lastSize = r.size, lastMtime = r.mtime;
  console.log('盯 ' + r.name + ' 共 ' + secs + ' 秒（每 5 秒查一次）');
  const t0 = Date.now();
  const timer = setInterval(() => {
    let st; try { st = fs.statSync(r.file); } catch { return; }
    if (st.size !== lastSize || st.mtimeMs !== lastMtime) {
      console.log('\n[' + new Date().toISOString().slice(11, 19) + '] 有变化：' + (st.size - lastSize) + ' 字节');
      lastSize = st.size; lastMtime = st.mtimeMs;
      const rows = parseRollout(r.file);
      const ev = [];
      for (const x of rows) {
        const p = x.payload || {};
        if (x.type === 'event_msg' && p.type === 'agent_message') ev.push('AGENT  ' + String(p.message).replace(/\s+/g, ' ').slice(0, 200));
        else if (x.type === 'response_item' && p.type === 'custom_tool_call') ev.push('TOOL   ' + p.name + '  ' + String(p.input).replace(/\s+/g, ' ').slice(0, 160));
      }
      for (const e of ev.slice(-5)) console.log('  ' + e);
    }
    if (Date.now() - t0 > secs * 1000) {
      clearInterval(timer);
      console.log('\n盯梢结束（' + secs + ' 秒内' + (lastSize === r.size ? '没有' : '有') + '变化）');
      process.exit(0);
    }
  }, 5000);
}

if (cmd === 'send') {
  const r = pick(argv[1]);
  if (!r) { console.error('找不到该 rollout'); process.exit(2); }
  const s = summarize(parseRollout(r.file, { maxLines: 200 }), r);
  const file = arg('--file');
  let text = arg('--text', '');
  if (file) { try { text = fs.readFileSync(file, 'utf8'); } catch (e) { console.error('读不到 ' + file); process.exit(2); } }
  if (!text.trim()) { console.error('要么 --text，要么 --file'); process.exit(2); }

  // 护栏一：必须自报来源（消息在对方会话里是"用户身份"，不说清会污染它的指令层级）
  const body = text.includes('同级 agent') ? text : SELF_MARK + '\n' + text;
  // 护栏二：默认 dry-run
  const exe = findCodexExe();
  console.log('=== send（' + (has('--yes') ? '真发' : 'DRY-RUN') + '）===');
  console.log('  目标线程  ' + s.threadId + '   [' + s.kind + ']  ' + fmtT(r.mtime) + '（' + Math.round((Date.now() - r.mtime) / 1000) + ' 秒前活动）');
  console.log('  正文 ' + body.length + ' 字符：');
  console.log('  ---');
  for (const line of body.split('\n').slice(0, 20)) console.log('  | ' + line);
  console.log('  ---');
  if (!exe) { console.error('  ❌ 找不到 codex 可执行文件，无法投递'); process.exit(2); }
  console.log('  将要执行： codex queue --thread ' + s.threadId + ' --message <上面的正文>');
  if (!has('--yes')) { console.log('\n（DRY-RUN：确认无误后加 --yes 才真发）'); process.exit(0); }
  const res = spawnSync(exe, ['queue', '--thread', s.threadId, '--message', body], { encoding: 'utf8' });
  console.log('  exit=' + res.status);
  if (res.stdout) console.log('  stdout: ' + String(res.stdout).trim().slice(0, 600));
  if (res.stderr) console.log('  stderr: ' + String(res.stderr).trim().slice(0, 600));
  process.exit(res.status === 0 ? 0 : 1);
}

// ⚠️ 末尾这条兜底必须在 watch 之后仍然成立：watch 分支是靠 setInterval 活着的，
//    它**没有**同步的 process.exit()（要等盯梢结束才退）。如果这里无条件报错退出，
//    就会立刻杀掉定时器 —— 我第一版就是这样，`watch` 打了一行"盯 …"然后立刻
//    "未知命令：watch" 退出。所以先判"是不是已知命令"。
const KNOWN = new Set(['help', 'list', 'threads', 'state', 'tail', 'watch', 'send']);
if (!KNOWN.has(cmd)) {
  console.error('未知命令：' + cmd + '（试 help）');
  process.exit(2);
}
