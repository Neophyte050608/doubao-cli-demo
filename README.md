# doubao-cli-demo

一个用于豆包企业 CLI Connector 集成验证的飞书登录 Demo，采用贴近真实业务的 **CLI + 后端** 两段式架构。

- **CLI**（分发给用户）：驱动登录、保存后端下发的会话、调用后端业务接口。它**不持有** App Secret，也不直接访问飞书。
- **后端**（你自己部署，持有 App Secret）：承接飞书 OAuth 回调、用 App Secret 换取用户身份、下发会话、提供唯一的业务接口 `GET /api/me`（返回“我是谁”）。

登录链路对齐 `lark-hive-ai` 的 `lark-hive-cli`：`auth start -> poll -> (cancel)` 的会话式握手。Demo 使用飞书开发者后台的企业自建应用完成 OAuth，但不依赖 `lark-hive-ai`、Gateway、core-api、数据库或 Redis，也没有多余的业务功能。

```bash
doubao-cli-demo --version
doubao-cli-demo --help
doubao-cli-demo auth login
doubao-cli-demo auth login --no-wait
doubao-cli-demo auth poll <login-session-id>
doubao-cli-demo auth status [--json]
doubao-cli-demo whoami [--json]
doubao-cli-demo auth logout [--json]
```

## 1. 工作方式

```text
CLI                         后端 (持有 App Secret)              飞书
 │ auth login
 │ 1. POST /auth/start ───────────▶ 生成 state，返回授权 URL + loginSessionId
 │ 2. 打开浏览器授权 ───────────────────────────────────────▶ 飞书授权页
 │                        3. 浏览器回调 ◀──────────────────────┘
 │                           GET /auth/callback?code&state
 │                           后端用 App Secret 换 token、取 user_info
 │                           生成 session_token
 │ 4. 轮询 POST /auth/poll ───────▶ 授权完成后返回 {sessionToken, user}
 │    CLI 加密保存 session_token
 │
 │ whoami → GET /api/me ──────────▶ 用 session_token 返回 {name, openId, unionId}
```

关键点：**App Secret 只在后端**；CLI 只认识后端地址。`auth status` 是本地检查（是否持有会话），`whoami` 是**实时调用后端 `/api/me`**，用来证明“带着会话去调业务接口”这条链路真实可用。

与 `lark-hive-cli` 一致，`auth login` 默认阻塞等待授权（内部按后端下发的 `pollIntervalSeconds` 轮询，到 `expiresAt` 超时；`Ctrl+C` 会取消后端的登录会话）。也支持拆成两步：

```bash
doubao-cli-demo auth login --no-wait   # 只开始登录并打印 login-session-id，不等待
doubao-cli-demo auth poll <login-session-id>   # 单次检查该会话；授权完成即落地登录
```

## 2. 职责与凭证边界

| 项 | 位置 | 说明 |
| --- | --- | --- |
| `FEISHU_APP_ID` | 后端 | 公开信息 |
| `FEISHU_APP_SECRET` | **仅后端** | 机密，绝不进入 CLI 或分发物 |
| OAuth 回调 `/auth/callback` | 后端 | 飞书需能回调到它 |
| 换 token / 取 user_info | 后端 | 使用 App Secret |
| 业务接口 `/api/me` | 后端 | 唯一业务功能：识别调用者 |
| 打开浏览器、保存会话、`whoami` | CLI | 客户端职责 |

## 3. 飞书开发者后台

创建企业自建应用，并把重定向 URL 配成**后端**的回调地址：

```text
本地开发：http://127.0.0.1:8787/auth/callback
生产环境：https://<你的后端域名>/auth/callback
```

该值必须与后端的 `FEISHU_REDIRECT_URI` 完全一致（协议、域名/IP、端口、路径）。

Demo 只通过用户 OAuth 读取登录者自身的基本信息（`name`、`open_id`、`union_id`），由 `authen/v1/user_info` 直接返回，**不需要**通讯录（`contact:*`）权限，也不需要应用身份（tenant_access_token）。把测试账号加入应用可用范围并创建发布版本即可。

## 4. 安装与部署（CLI 与后端是两个独立单元）

要求 Node.js 22 或更高版本。CLI 和后端分开部署，和 `lark-hive-cli` 对接网关的模式一致：**CLI 装在用户机器上，后端单独跑在一台可被回调访问到的机器上。**

### 4.1 安装 CLI（用户机器 / 豆包连接器环境）

全局安装只会得到纯 CLI（分发物只包含 `src/`，不含后端代码），暴露一个 `doubao-cli-demo` 命令：

```bash
npm install --global https://github.com/Neophyte050608/doubao-cli-demo.git
doubao-cli-demo --version      # 版本检查
doubao-cli-demo --help
```

CLI 只需要一个环境变量指向后端：

```bash
export DOUBAO_CLI_DEMO_BACKEND_URL='http://<后端地址>:8787'
```

### 4.2 部署后端（持有 App Secret 的机器，例如开发机）

后端不随 CLI 分发，需从源码运行：

```bash
git clone https://github.com/Neophyte050608/doubao-cli-demo.git
cd doubao-cli-demo
cp .env.example .env           # 填入 App ID / Secret / 回调地址
npm run server                 # 等价于 node ./server/server.mjs
```

常驻运行（开发机上）可用 `nohup` 或 `pm2`：

```bash
nohup node ./server/server.mjs > server.log 2>&1 &
# 或： pm2 start server/server.mjs --name doubao-cli-demo-backend
```

### 4.3 内网穿透（配置到豆包企业连接器的关键）

要把这个 demo 配到豆包企业连接器用于测试，CLI 可能在**豆包连接器环境**里执行，而授权浏览器在你本地——此时后端必须有一个**浏览器可达的公网地址**。用内网穿透把开发机的 `8787` 暴露出去（任选其一）：

```bash
# ngrok
ngrok http 8787
# cloudflared
cloudflared tunnel --url http://127.0.0.1:8787
```

拿到公网 HTTPS 地址（如 `https://xxxx.ngrok-free.app`）后，三处必须完全一致：

1. 后端 `.env` 的 `FEISHU_REDIRECT_URI=https://xxxx.ngrok-free.app/auth/callback`
2. 飞书开发者后台的「重定向 URL」填同一个值
3. CLI 的 `DOUBAO_CLI_DEMO_BACKEND_URL=https://xxxx.ngrok-free.app`

> 纯本机验证（CLI、后端、浏览器都在同一台机器）不需要穿透，直接用 `http://127.0.0.1:8787` 即可。

### 4.4 从源码直接跑（本机开发调试）

```bash
node ./src/cli.mjs --help      # CLI
npm run server                 # 后端
```

## 5. 配置

CLI 和后端用各自的环境变量，分别配在各自运行的机器上。两端都会在启动时自动从**当前工作目录**加载 `.env`（不会覆盖已 `export` 的同名变量）。

**后端机器**（持有凭证，复制 `.env.example` 填写）：

```bash
FEISHU_APP_ID='cli_xxx'
FEISHU_APP_SECRET='替换为新密钥'
# 本机验证用 127.0.0.1；经内网穿透/公网时填穿透后的 https 地址
FEISHU_REDIRECT_URI='http://127.0.0.1:8787/auth/callback'
PORT=8787
```

**CLI 机器**（只需要知道后端在哪）：

```bash
DOUBAO_CLI_DEMO_BACKEND_URL='http://127.0.0.1:8787'
```

> 全局安装后在任意目录执行 CLI 时，若该目录没有 `.env`，用 `export DOUBAO_CLI_DEMO_BACKEND_URL=...` 指定后端地址即可。

不要把真实 App Secret 写入源码、GitHub、普通文档或截图。App Secret 只存在于**后端机器**，绝不进入 CLI 分发物。`.env` 已在 `.gitignore` 中；曾经粘贴到聊天里的 Secret 应先在开发者后台重置。

## 6. 运行

**第一步，起后端**（持有凭证的那端）：

```bash
npm run server
# Doubao CLI demo backend listening on http://127.0.0.1:8787
# Feishu redirect URI: http://127.0.0.1:8787/auth/callback
```

**第二步，用 CLI 登录并查身份**：

```bash
doubao-cli-demo auth login     # 浏览器授权，成功后：Logged in as 示例用户
doubao-cli-demo auth status    # 本地检查，已登录首行固定 "Logged in"
doubao-cli-demo whoami --json  # 实时调用后端 /api/me
```

`whoami --json` 输出示例：

```json
{"name":"示例用户","openId":"ou_xxx","unionId":"on_xxx"}
```

`open_id` 是用户在本应用内的唯一标识，`union_id` 是用户在同一开发者名下所有应用间一致的标识。退出登录：

```bash
doubao-cli-demo auth logout
```

## 7. 后端 HTTP 契约

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `POST` | `/auth/start` | 开始登录，返回 `loginSessionId`、`verificationUrl`、`pollIntervalSeconds`、`expiresAt` |
| `GET` | `/auth/callback` | 飞书回调；后端换取身份并生成会话 |
| `POST` | `/auth/poll` | 轮询登录结果（body `{loginSessionId}`）；`authorized` 时返回 `{sessionToken, user}` |
| `POST` | `/auth/cancel` | 取消一个待处理的登录会话（body `{loginSessionId}`） |
| `GET` | `/api/me` | 业务接口，`Authorization: Bearer <sessionToken>` → `{name, openId, unionId}` |
| `GET` | `/healthz` | 健康检查 |

`/auth/poll` 的 `status` 取值：`pending`、`authorized`、`denied`、`failed`、`expired`。授权成功的登录会话是**一次性**的（取走后再 poll 返回 `expired`）。会话存在后端内存中（demo 简化；重启即失效），真实系统可换成持久化存储。

## 8. 豆包企业 CLI Connector 配置

| 配置项 | 值 |
| --- | --- |
| CLI 名称 | `doubao-cli-demo` |
| 可执行文件 | `doubao-cli-demo` |
| 安装命令 | `npm install --global https://github.com/Neophyte050608/doubao-cli-demo.git` |
| 版本检查命令 | `doubao-cli-demo --version` |
| 帮助命令 | `doubao-cli-demo --help` |
| 授权（登录）命令 | `doubao-cli-demo auth login` |
| 授权状态命令 | `doubao-cli-demo auth status` |
| 已登录匹配正则 | `^Logged in$` |
| 取消授权（退出）命令 | `doubao-cli-demo auth logout` |
| 当前用户命令 | `doubao-cli-demo whoami --json` |

Connector 运行 CLI 时必须能读取 `DOUBAO_CLI_DEMO_BACKEND_URL`（后端地址）。App Secret 等飞书凭证只需配置在**后端**运行环境，不要注入到 CLI。

## 9. 本机、内网、公网和云电脑

后端承接飞书回调，所以“浏览器能否访问到后端的回调地址”决定了部署方式：

| 场景 | 后端部署 | 说明 |
| --- | --- | --- |
| 本机运行 CLI + 后端 + 浏览器 | 本机 `127.0.0.1:8787` | 浏览器回调到本机后端 |
| 同一台云电脑运行三者 | 云电脑本地后端 | 回调到云电脑自身 |
| 内网机器，能出网访问飞书 | 内网后端 + 浏览器同网 | 浏览器需能访问后端回调地址 |
| 豆包在云端执行 CLI，用户在本地浏览器授权 | **公网 HTTPS 后端** | 回调地址必须是浏览器可达的公网 URL |
| 多用户 / 正式环境 | 公网 HTTPS 后端 | 推荐，`FEISHU_REDIRECT_URI` 配公网域名 |

CLI 可以在任意机器，只要它能访问 `DOUBAO_CLI_DEMO_BACKEND_URL`；浏览器只要能访问后端的 `/auth/callback`。

## 10. 本地状态与安全边界

CLI 默认保存位置：

- macOS/Linux：`${XDG_CONFIG_HOME:-~/.config}/doubao-cli-demo/`
- Windows：`%APPDATA%\doubao-cli-demo\`

文件：

- `session.json.enc`：AES-256-GCM 加密后的会话（含后端下发的 `sessionToken` 与缓存身份）；
- `session.key`：本机随机密钥（POSIX 权限 `0600`）。

CLI 不保存飞书 `user_access_token` / `refresh_token`（它根本拿不到）。`auth status` 表示本机持有后端会话；`whoami` 会实时向后端校验该会话。

## 11. 退出码

| 退出码 | 含义 |
| --- | --- |
| `0` | 命令成功 |
| `1` | 当前未登录（或会话已失效、`auth poll` 仍为 pending） |
| `2` | 参数、配置、本地存储或后端通信错误 |
| `3` | 授权被拒绝、失败、取消或超时 |

## 12. 开发验证

项目没有第三方运行时依赖：

```bash
npm test
npm run pack:dry-run
```

调试：设置 `DOUBAO_CLI_DEMO_DEBUG=1` 后，后端在换取身份失败时会在日志中附带飞书返回的 HTTP 状态、`code` 和 `msg`。

后端访问的飞书接口：

- `GET  https://accounts.feishu.cn/open-apis/authen/v1/authorize`
- `POST https://accounts.feishu.cn/oauth/v3/token`
- `GET  https://open.feishu.cn/open-apis/authen/v1/user_info`
