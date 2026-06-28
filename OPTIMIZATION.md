# codex-accounts 优化方案

针对**代码质量 / 架构**与**性能 / 资源占用**两个方向。基于对 `src/` 全部 16 个模块、`bin/`、`test/run.js` 与菜单栏脚本的通读。安全语义（锁、原子写、路径越界防护、JWT 校验、权限）保持不变。

测试基线：`node test/run.js` → 17 项全通过；冷启动 ~40ms / RSS ~50MB（纯 JS 回退路径）。

---

## 1. 架构层

### 1.1 双引擎分支重复（最高价值）
`engine.js`（本工具的对象格式）与 `codex-format.js`（真实 Codex 数组格式）是两套并行实现。调用方 `cli.js` 与 `web.js` 在 `list / whoami / switch / import` 各处反复写 `useCodex ? codex.x(p) : engine.x(p)` 三元分支，且两端对返回值的归一化逻辑各写一遍。

问题：分支散落在多个调用点，新增命令时容易漏掉一侧；`switch` 输出在 cli 里 codex 路径用 `account_key`、engine 路径用 `key`，字段名不一致。

方案：新增 `src/accounts.js` 门面，把引擎选择和返回值归一化收敛到一处。调用方只依赖门面，不再各自分支。**已实施**（见下方 §4）。

### 1.2 `deriveIdentity` 两份实现
`auth-file.js` 与 `codex-format.js` 各有一个 `deriveIdentity`，字段优先级和返回结构不同，容易让人误以为是同一函数。建议中期合并为单一身份推导模块，两种格式只在「key 如何拼装」上分叉。本次未动（涉及 import/login 关键路径，需单独评审）。

### 1.3 `resolve` 选择器逻辑重复
`registry.js` 与 `codex-format.js` 各实现一份「index | email | alias | id」解析。逻辑一致但数据结构不同（对象 vs 数组）。可抽出一个纯函数 `matchSelector(selector, fields)` 复用。本次未动，列为后续。

### 1.4 `cli.run()` 返回类型混杂
返回值在 `0 / 2 / Promise` 间切换，`bin` 端靠 `typeof ret.then` 判断。能工作但不直观。建议统一返回 `{ code, keepAlive }`。低优先级。

---

## 2. 性能 / 资源

### 2.1 菜单栏 10s 轮询 → rollout 日志全量读取（已优化）
`menubar` 命令每 10s 被 SwiftBar 拉起一次（每次冷启 node ~40ms / 50MB）。它调用 `codex-format.list` → `usage-local.latestSnapshot`，后者对最近 12 个 `rollout-*.jsonl` 逐个 `readFileSync(file,'utf8').split('\n')`，把**整份**会话日志读进内存并切成数组。活跃会话日志可达数 MB，每 10s 重复一次。

方案：只读文件**尾部窗口**（默认 512KB）再切行——速率限制事件总是追加在活跃会话末尾，尾读即可命中最新快照，同时把内存占用从「文件大小」降到常数上限。**已实施**。

补充建议（部署侧，未改文件）：把菜单栏脚本由 `.10s.` 改为 `.30s.` 或 `.1m.`，刷新频率对账号用量信息足够，CPU 唤醒减少 3–6 倍。

### 2.2 `findRateLimits` 全递归
对每个候选行做全对象递归查找 `rate_limits`。已有 `line.indexOf('rate_limits') === -1` 预过滤短路，绝大多数行被跳过，开销可接受。配合 §2.1 的尾读，候选行数大幅下降，无需进一步改。

### 2.3 启动期 require
`cli.js` 顶部 eager require 了 `engine / codex / redact`，而 `web / login / restart` 已按需 lazy require。当前冷启 40ms 无瓶颈，维持现状即可，不为微优化牺牲可读性。

---

## 3. 健壮性

### 3.1 `--port` 无校验（已修复）
`serve` 把 `parseInt(rest[i+1],10)` 直接传给 `server.listen`。若用户写 `--port abc`，得到 `NaN` 并进入异常路径。已加整数 / 区间校验，非法值回退默认 4577 并告警。

### 3.2 WebUI 500 回显内部错误信息
`web.js` 在 `/api/switch` 失败时把 `e.message` 原样返回。仅监听 127.0.0.1、且不含密钥，风险低，保留以便本地排错。仅记录，不改。

---

## 4. 本次已落地的改动

| 文件 | 改动 | 类型 |
|---|---|---|
| `src/accounts.js`（新增） | 引擎选择 + 返回值归一化门面 | 架构去重 |
| `src/cli.js` | `serve/switch/list/whoami/login/import/inspect` 改用门面；`--port` 整数校验 | 架构 + 健壮性 |
| `src/web.js` | `listAccounts/whoami/doSwitch` 改用门面 | 架构去重 |
| `src/usage-local.js` | rollout 日志改尾部窗口读取（512KB 上限） | 性能 |

附带统一：`switch` 命令 JSON 输出两种格式均用 `account_key` 字段（此前 engine 路径为 `key`）。菜单栏脚本只读 `list` 输出，不受影响。

验证：改动后 `node test/run.js` 仍 17 项全通过，`bin` 端到端冒烟测试通过。

---

## 5. 后续建议（未实施，需单独评审）

1. 合并两份 `deriveIdentity`，抽出共享身份推导（触及 import/login，需安全评审）。
2. 抽出 `matchSelector` 纯函数，消除 `resolve` 重复。
3. 为 `web.js` 的 `/api` 路径补单元测试（当前测试覆盖 engine 与 bin，未覆盖 HTTP 层）。
4. 菜单栏脚本刷新间隔下调到 30s–1m。
