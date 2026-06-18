# codex-accounts

本地多账号管理与切换工具，面向 **Codex / ChatGPT / OpenAI API**。
一条命令在多个账号间切换，切换后 Codex CLI、VS Code 扩展、Codex App 自动读到新账号。

> **使用边界**：本工具仅用于管理你**本人拥有或已获明确授权**的账号。它**不**绕过身份认证、速率/套餐限制或风控，不共享/出售/批量滥用账号，不上传任何凭证到第三方服务器。非公开用量接口默认关闭，需你手动开启并确认风险。

---

## 目录
1. [它能做什么](#1-它能做什么)
2. [环境要求](#2-环境要求)
3. [安装](#3-安装)
4. [快速上手（5 分钟）](#4-快速上手5-分钟)
5. [命令参考](#5-命令参考)
6. [数据存在哪 / CODEX_HOME](#6-数据存在哪--codex_home)
7. [编译原生版（可选）](#7-编译原生版可选)
8. [安全特性](#8-安全特性)
9. [常见问题排查](#9-常见问题排查)
10. [卸载](#10-卸载)

---

## 1. 它能做什么

- 把多个 Codex/ChatGPT 账号的认证文件（`auth.json`）保存为独立快照。
- 用 `list` 查看所有账号（邮箱、别名、套餐、当前状态、用量）。
- 用 `switch` 一键切换当前生效账号，**原子替换** `~/.codex/auth.json`。
- 全程保护凭证：文件权限 `0600`、防路径穿越、跨进程锁、日志脱敏。

---

## 2. 环境要求

| 项 | 要求 |
|---|---|
| Node.js | **≥ 18**（推荐 20/22）。检查：`node --version` |
| 操作系统 | Linux / macOS / Windows，x64 或 ARM64 |
| 官方 Codex CLI | 仅 `login` 子命令需要（用于调用官方登录）。`import/list/switch` 不需要 |
| Zig（可选） | 仅在你想编译原生二进制时需要，0.14 |

> 不装 Zig 也能用：启动层会自动回退到纯 JS 引擎。

---

## 3. 安装

### 方式 A：从本目录直接用（最快）
```bash
cd codex-accounts
npm test           # 可选：跑 17 项安全测试，确认环境 OK
node bin/codex-accounts.js help
```
之后所有命令都是 `node bin/codex-accounts.js <命令>`。

### 方式 B：装成全局命令 `codex-accounts`（推荐日常用）
```bash
cd codex-accounts
npm link           # 创建全局软链
codex-accounts help
```
之后可直接用 `codex-accounts <命令>`，不用再写 `node bin/...`。
> 取消：在本目录执行 `npm unlink -g @you/codex-accounts`。

### 方式 C：从 npm 安装（当你已发布到 registry 后）
```bash
npm install -g @you/codex-accounts
codex-accounts help
```

> 本文后续示例统一用 `codex-accounts`。若你用方式 A，把它换成 `node bin/codex-accounts.js` 即可。

---

## 4. 快速上手（5 分钟）

下面用一个**临时目录**演示，不会动到你真实的 `~/.codex`：

```bash
# 1) 隔离到临时工作目录
export CODEX_HOME="$(mktemp -d)/.codex"

# 2) 准备一个示例认证文件（真实使用时换成你导出的 auth.json）
cat > /tmp/demo-auth.json <<'JSON'
{
  "tokens": {
    "id_token": "x", "access_token": "x", "refresh_token": "r"
  },
  "account_id": "demo-001",
  "email": "me@example.com"
}
JSON

# 3) 导入并起别名
codex-accounts import /tmp/demo-auth.json --alias demo

# 4) 查看账号列表
codex-accounts list

# 5) 切换到它
codex-accounts switch demo

# 6) 确认当前账号
codex-accounts whoami
```

真实使用时的典型流程：

```bash
# 把你不同账号的 auth.json 分别导入
codex-accounts import ~/Downloads/work-auth.json     --alias work
codex-accounts import ~/Downloads/personal-auth.json --alias personal

codex-accounts list          # 看序号/邮箱/别名
codex-accounts switch work   # 切到 work
# —— 重启 Codex CLI / VS Code 扩展 / Codex App 后生效 ——
codex-accounts switch 2      # 也可以用列表里的序号切换
```

> **切换后务必重启** Codex CLI / VS Code 扩展 / Codex App，它们才会重新读取 `auth.json`。

---

## 5. 命令参考

```
codex-accounts serve   [--port 4577] [--no-open]   # 本地 WebUI，点一下切换
codex-accounts login   [--device] [--alias 名称] [--codex-bin 路径]
codex-accounts list
codex-accounts switch <序号|邮箱|别名|accountId>
codex-accounts import  <文件|目录...> [--alias 名称]
codex-accounts whoami
codex-accounts inspect <选择符>      # 打印脱敏后的认证内容（不含明文 Token）
codex-accounts help
```

### serve — 本地 WebUI（最方便，点一下切换）
```bash
node bin/codex-accounts.js serve        # 启动后自动打开浏览器
node bin/codex-accounts.js serve --port 4600 --no-open
```
打开后是一个账号卡片列表，显示邮箱、套餐、5h/周用量，点「切换」即可。安全设计：**只监听 127.0.0.1**（局域网/外网都访问不到）、每次启动生成随机会话令牌（其它网页因同源策略读不到，无法伪造切换请求）、校验 Host 头防 DNS 重绑定、界面只显示账号信息不含明文 Token。切换走的是和命令行一样的加锁+原子+自动备份逻辑。按 Ctrl+C 停止。

**切换后自动重启 Codex App**：WebUI 顶部勾选「切换后自动重启 Codex App」即可；命令行用 `switch <账号> --restart`。仅 macOS，重启的是 Codex 桌面 App（quit + 重新打开）。若你的 App 名不是 `Codex`，设环境变量 `CODEX_APP_NAME="你的App名"`。

### 菜单栏小程序（macOS，SwiftBar/xbar）
不想开网页，可以常驻在菜单栏，点一下就切：

1. 安装 [SwiftBar](https://swiftbar.app)（推荐）或 [xbar](https://xbarapp.com)。
2. 编辑 `menubar/codex-accounts.10s.sh`，把里面的 `TOOL_DIR` 改成你存放本工具的实际路径。
3. 把该脚本放进 SwiftBar/xbar 的插件目录，并 `chmod +x codex-accounts.10s.sh`。
4. 刷新后菜单栏出现 🤖，下拉里当前账号带绿色 ✓，点其它账号即切换并自动重启 Codex。

文件名里的 `.10s.` 表示每 10 秒刷新一次用量，可改成 `.1m.`（1 分钟）。

### login — 直接走官方登录导入账号（推荐）
不用先手动找 `auth.json`，直接调用**官方 `codex login`** 完成登录并把账号收进来：
```bash
codex-accounts login --alias work          # 浏览器登录
codex-accounts login --device --alias work # 设备码登录（无浏览器环境）
```
工作原理：在 `accounts/.login-tmp/` 建一个隔离的临时 `CODEX_HOME` → 以它为环境调官方 `codex login`（数组参数、不拼 Shell，**不会动你当前账号**）→ 登录成功后读取临时目录生成的 `auth.json` → 校验身份 → 原子存成快照并更新注册表 → 删除临时目录。登录完它**不会自动切过去**，需要再 `switch`。

前提：本机已安装官方 Codex CLI 且在 PATH 中。若 `codex` 不在 PATH，用 `--codex-bin /路径/codex` 指定，或设环境变量 `CODEX_CLI_PATH`。

### import — 导入账号
```bash
codex-accounts import ./auth.json --alias work     # 单个文件 + 别名
codex-accounts import ./a.json ./b.json            # 多个文件
codex-accounts import ./auths/                      # 目录内所有 *.json
```
支持：标准 Codex `auth.json`、单个 JSON、JSON 数组、目录批量、CLIProxyAPI 兼容格式。
导入时会校验文件大小（≤ 256 KiB）、JSON 结构、JWT 的签发方/受众/过期时间，并标记 token 是否通过结构校验。

### list — 列出账号
显示：序号、邮箱、别名、套餐、是否当前、5 小时窗口使用率、周期使用率、下次重置、数据时间。

**用量数据来源（纯本地，不联网）**：当前账号的 5h/周用量从 Codex 自己的本地日志 `~/.codex/sessions/.../rollout-*.jsonl` 解析最新一条真实速率快照（`usage_source: rollout`），并按 `resets_at` 纠正——窗口已过重置时间则显示 0%（标「已重置」）。由于 rollout 日志不记录账号归属，**非当前账号**只能显示其上次缓存值（`usage_source: cached`）并标注「更新于 X 前」。全程不发任何网络请求、不读取 Token。

### switch — 切换当前账号
```bash
codex-accounts switch 1                 # 按序号
codex-accounts switch work              # 按别名
codex-accounts switch me@example.com    # 按邮箱
```
原子替换 `auth.json`，备份上一账号，更新注册表。整个过程在跨进程锁内，多个切换并发也不会损坏文件。

### whoami — 查看当前/上一个账号
```bash
codex-accounts whoami
```

### inspect — 安全查看认证内容
```bash
codex-accounts inspect work
```
所有 Token / API Key 只显示 `sha256:…` 指纹，**绝不打印明文**，可安全粘贴到工单里排查。

---

## 6. 数据存在哪 / CODEX_HOME

默认工作目录是 `~/.codex`，用环境变量 `CODEX_HOME` 可改：

```bash
export CODEX_HOME="$HOME/.codex"        # 默认
export CODEX_HOME="/path/to/other"      # 自定义
```

目录结构：
```
$CODEX_HOME/                     (0700)
├── auth.json                    (0600)  当前生效账号
└── accounts/                    (0700)
    ├── registry.json            (0600)  账号索引
    ├── <账号键>.json            (0600)  每账号独立快照
    ├── .auth.previous.json      (0600)  上一账号备份
    └── .registry.lock                   跨进程锁
```

---

## 7. 编译原生版（可选）

不编译也能用（JS 回退）。想要原生二进制：

```bash
# 需先安装 Zig 0.14
cd zig
zig build -Doptimize=ReleaseSafe      # 编译当前平台
zig build test                        # 运行单元测试

# 交叉编译其他平台，例如：
zig build -Dtarget=aarch64-macos  -Doptimize=ReleaseSafe
zig build -Dtarget=x86_64-windows -Doptimize=ReleaseSafe
```

把产物放到 `native/<平台>-<架构>/codex-accounts[.exe]`，例如 `native/darwin-arm64/codex-accounts`。
之后启动层会**自动优先**用原生二进制，否则回退 JS。

> 说明：Zig 源码按 0.14 习惯编写，不同 Zig 版本的标准库 API 可能有细微差异，请固定工具链版本。

---

## 8. 安全特性

| 防护 | 说明 |
|---|---|
| 文件权限 | Unix 敏感文件 `0600`、目录 `0700`；Windows 用 `icacls` 设仅当前用户 ACL |
| 防路径穿越 | 账号键经安全编码，禁止 `/`、`\`、`..`、保留名；所有写路径校验不越出 `CODEX_HOME` |
| 防符号链接攻击 | 导入/切换前拒绝符号链接，并解析真实路径校验 |
| 原子写 | 同目录临时文件 + fsync + rename，崩溃也不会留半截文件 |
| 跨进程锁 | 防两个切换并发损坏 `auth.json`/注册表（已通过 1200 次并发压测） |
| JWT 校验 | 校验签发方/受众/过期，不仅凭 Base64 解码就信任；拒 `alg=none` |
| 日志脱敏 | Token / API Key 只输出指纹，绝不进日志或终端 |
| 凭证不外泄 | Access Token 只发往预设并校验过的官方 HTTPS 域名；非公开接口默认关闭 |

完整威胁模型、风险分级与修复见 `codex-accounts-security-design.md`。

---

## 9. 常见问题排查

**`command not found: codex-accounts`**
你没用 `npm link`。要么先 `cd codex-accounts && npm link`，要么直接用 `node bin/codex-accounts.js …`。

**切换后 Codex 还是旧账号**
切换只改 `auth.json`，需**重启** Codex CLI / VS Code 扩展 / Codex App 才会重新读取。

**`no account matches selector`**
用 `codex-accounts list` 看准确的序号/邮箱/别名再切。

**`snapshot ... has unsafe perms`**
某个快照被改成了组/他人可读。这是安全保护在拦截。修复：`chmod 600 $CODEX_HOME/accounts/<键>.json`。

**`auth file too large` / `not valid JSON`**
导入的不是合法的 `auth.json`（单文件上限 256 KiB）。确认文件来源和格式。

**`login` 报找不到 codex**
`login` 会调用官方 `codex` CLI，需先安装官方 Codex CLI 并在 PATH 中。

---

## 10. 卸载

```bash
# 若用过 npm link
cd codex-accounts && npm unlink -g @you/codex-accounts

# 若全局安装
npm uninstall -g @you/codex-accounts

# 删除本地数据（会移除所有已保存账号，谨慎）
rm -rf "$CODEX_HOME/accounts"   # 或整个 ~/.codex
```

---

*本工具的纯 JS 引擎已在沙箱通过 17 项安全测试 + 1200 次并发切换压测。Zig 原生层为目标架构，需在你本机用 Zig 工具链编译验证。*
