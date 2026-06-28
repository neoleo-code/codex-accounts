# codex-accounts 使用说明（速查）

本地多账号管理与切换工具。仅用于管理**你本人拥有或已获授权**的 Codex / ChatGPT / OpenAI 账号。

> 下文统一用 `codex-accounts <命令>`。若未做 `npm link`，把它替换为 `node bin/codex-accounts.js <命令>`。

---

## 一、命令总览

| 命令 | 作用 |
|---|---|
| `login` | 调用**官方** `codex login` 在隔离目录登录，成功后导入账号 |
| `import <file\|dir...>` | 从已有 `auth.json`（或目录下所有 `.json`）导入账号 |
| `list` / `ls` | 列出全部账号：邮箱、别名、套餐、当前状态、用量 |
| `switch <选择器>` / `use` | 切换当前生效账号，原子替换 `~/.codex/auth.json` |
| `whoami` | 显示当前 / 上一个账号 |
| `inspect <选择器>` | 打印**脱敏后**的账号 auth（不含明文密钥） |
| `serve` / `web` / `ui` | 启动本地 WebUI（仅 127.0.0.1） |
| `menubar` | 输出 SwiftBar/xbar 菜单栏格式（一般由插件脚本调用） |
| `help` | 帮助 |

**选择器**（`switch` / `inspect` 通用）可为：序号（1 起）、邮箱、别名、account_key、account_id。

---

## 二、常用流程

```bash
# 1. 添加账号（二选一）
codex-accounts login --alias work          # 走官方登录，新开浏览器/设备码
codex-accounts import ~/Downloads/auth.json --alias work   # 导入已有凭证

# 2. 查看
codex-accounts list

# 3. 切换（加 --restart 自动重启 macOS Codex App）
codex-accounts switch work --restart
codex-accounts switch 2                     # 也可按序号

# 4. 确认
codex-accounts whoami
```

切换后若未加 `--restart`，需手动重启 Codex CLI / VS Code 扩展 / Codex App 才能生效。

---

## 三、各命令参数

### login
```bash
codex-accounts login [--device] [--alias <名字>] [--codex-bin <路径>]
```
- `--device` / `--device-auth`：用设备码登录（无浏览器环境）。
- `--alias`：给账号起别名，方便切换。
- `--codex-bin`：官方 codex 不在 PATH 时指定其路径（等价环境变量 `CODEX_CLI_PATH`）。

### import
```bash
codex-accounts import <file|dir ...> [--alias <名字>]
```
- 支持多个文件或目录；传目录时导入其中所有 `.json`。
- 单文件大小上限 256KB，拒绝符号链接。

### switch / use
```bash
codex-accounts switch <选择器> [--restart]
```
- `--restart`：切换后自动退出并重启 macOS 的 Codex App（仅 macOS）。
- 每次切换会先把当前 `auth.json` 备份到 `accounts/` 下。

### inspect
```bash
codex-accounts inspect <选择器>
```
输出经过脱敏：token / api_key 等只显示 `sha256:…(长度)` 指纹，不泄露明文。

### serve / web / ui
```bash
codex-accounts serve [--port <端口>] [--no-open]
```
- 默认端口 `4577`，默认自动打开浏览器；`--no-open` 不打开。
- `--port` 仅接受 1–65535 的整数；非法值会告警并回退 4577。
- 仅监听 `127.0.0.1`，每次运行生成随机会话令牌（防 CSRF），校验 Host（防 DNS 重绑定）。`Ctrl+C` 停止。

---

## 四、菜单栏（SwiftBar / xbar，macOS）

1. 安装 [SwiftBar](https://swiftbar.app) 或 [xbar](https://xbarapp.com)。
2. 编辑 `menubar/codex-accounts.10s.sh` 中的 `TOOL_DIR` 指向本工具目录。
3. 把该脚本拷进插件目录并 `chmod +x`，刷新后菜单栏出现 🤖。
4. 点击某个账号即可切换（自动重启 Codex App）。

> 文件名里的 `.10s.` 表示每 10 秒刷新一次。改为 `.30s.` 或 `.1m.` 可降低刷新频率、减少占用。

---

## 五、环境变量

| 变量 | 作用 | 默认 |
|---|---|---|
| `CODEX_HOME` | 工作目录（账号、快照、注册表所在） | `~/.codex` |
| `CODEX_CLI_PATH` | 官方 codex 二进制路径（`login` 用） | 从 PATH 找 `codex` |
| `CODEX_APP_NAME` | `--restart` 要重启的 App 名 | `Codex` |

用临时目录试用、不影响真实 `~/.codex`：
```bash
export CODEX_HOME="$(mktemp -d)"
codex-accounts import ./some-auth.json --alias test
codex-accounts list
```

---

## 六、安全须知

- 所有凭证文件权限强制 `0600`，目录 `0700`；信任前会校验权限，发现可被同组/他人读取或为符号链接时拒绝切换。
- 所有写入均为原子替换 + 跨进程锁，避免并发 `switch` 写坏 `auth.json`。
- 日志/`inspect` 输出对密钥脱敏；本工具不上传任何凭证到第三方。
- 仅管理你拥有或获授权的账号，不绕过认证、限额或风控。
