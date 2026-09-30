# 豆包 CLI 登录 Demo 设计

## 1. 目标

构建一个独立、轻量、可安装的 CLI Demo，用于验证豆包 CLI Connector 的登录闭环：用户通过浏览器完成飞书授权，CLI 在授权成功后持久化本地 session，并能稳定判断登录状态及识别当前用户。

Demo 不实现日报、任务或其他业务查询，也不修改 `lark-hive-ai` 仓库。它复用现有 `lark-hive-ai` Gateway 暴露的 CLI Auth Contract，不直连飞书 OpenAPI，不持有或分发飞书 `App Secret`。

## 2. 项目位置与技术约束

- 永久目录：`/Users/bytedance/bits/doubao-cli-login-demo`
- 独立项目，不放在 `/private/tmp`，不放进 `lark-hive-ai` monorepo
- Node.js 22 或更高版本
- Native ESM JavaScript
- 优先使用 Node.js 内置模块
- 不使用 TypeScript、oclif、Express、Axios、数据库或 Redis
- 使用 Node.js 内置 `node:test` 编写自动化测试
- npm 包名与可执行命令暂定为 `doubao-login-demo`

## 3. 后端依赖与安全边界

CLI 只调用用户指定的 `lark-hive-ai` Gateway host：

- `POST /api/cli/auth/start`
- `POST /api/cli/auth/poll`
- `POST /api/cli/auth/cancel`
- `POST /api/cli/auth/refresh`
- `GET /api/cli/auth/current`

所有请求携带：

```text
X-Lark-Hive-CLI-Contract-Version: 3
X-Lark-Hive-CLI-Version: <package version>
```

Gateway/Core API 负责：

- 保存飞书应用凭证
- 构造飞书授权地址
- 交换 OAuth code
- 保存服务端 refresh credential
- 签发和刷新 CLI access token
- 返回当前登录用户身份

CLI 永远不接收或读取飞书 `App Secret`，也不调用飞书 token endpoint。日志、帮助、示例和错误输出不得包含 access token、授权码、Cookie 或原始敏感响应。

## 4. 命令契约

### 4.1 通用命令

```bash
doubao-login-demo --version
doubao-login-demo --help
```

- `--version` 输出单行版本号后退出 `0`。
- `--help` 离线输出命令和参数说明后退出 `0`。
- 未知命令或无效参数输出到 stderr，退出 `2`。

### 4.2 登录

```bash
doubao-login-demo auth login --host https://gateway.example.com
```

`--host` 在首次登录时必填。CLI 将：

1. 规范化并校验 host，仅接受 `https://`；测试和本地开发显式允许 `http://127.0.0.1:<port>` 或 `http://[::1]:<port>`。
2. 调用 `/api/cli/auth/start` 创建登录会话。
3. 在 stdout 输出授权地址、用户码和稳定的等待提示，不输出 token。
4. 尝试使用平台浏览器打开 `verificationUrl`；失败时继续运行，允许用户手动打开已输出的地址。
5. 按服务端 `pollIntervalSeconds` 阻塞轮询 `/api/cli/auth/poll`。
6. 遇到 `authorized` 时先原子持久化 session，再输出 `Logged in as <displayName>` 并退出 `0`。
7. 遇到 `denied`、`cancelled`、`expired`、`failed` 或 `consumed` 时输出稳定脱敏错误并退出 `3`。
8. 收到 `SIGINT` 或 `SIGTERM` 时尽力调用 `/api/cli/auth/cancel`，不写 session，并按信号退出。
9. 网络或服务异常退出 `2`。

登录命令在获得可验证终态前保持进程存活，满足豆包暂停对话、等待用户授权后继续执行的要求。

### 4.3 登录状态

```bash
doubao-login-demo auth status
doubao-login-demo auth status --json
```

状态命令读取 session 中绑定的 host，并调用 `/api/cli/auth/current` 验证身份。access token 即将过期、已过期或 `/current` 返回未授权时，先调用 `/api/cli/auth/refresh`，保存新 session 后再验证一次。

文本输出稳定契约：

- 已登录：首行严格为 `Logged in`，随后可输出 `Name:`、`User ID:`、`Host:`；退出 `0`。
- 未登录或凭证已不可刷新：首行严格为 `Not logged in`；退出 `1`。
- 本地 session 损坏、网络失败或服务异常：错误写 stderr；退出 `2`，不得误报为未登录。

豆包登录状态匹配正则：

```regex
^Logged in$
```

豆包应按 stdout 第一行匹配。

JSON 输出使用稳定字段：

```json
{
  "loggedIn": true,
  "user": {
    "displayName": "示例用户",
    "userId": "ou_xxx"
  },
  "host": "https://gateway.example.com"
}
```

未登录输出 `{"loggedIn":false}`，不包含 token。

### 4.4 当前用户

```bash
doubao-login-demo whoami
doubao-login-demo whoami --json
```

复用与 `auth status` 相同的远端验证和自动刷新逻辑。成功时输出 `displayName`、`userId` 和 host；未登录退出 `1`，检查失败退出 `2`。该命令是 Demo 的唯一实际能力，用于证明登录后能够识别当前用户。

### 4.5 退出登录

```bash
doubao-login-demo auth logout
```

删除本地加密 session 文件及本地加密 key。重复执行保持幂等，成功输出 `Logged out` 并退出 `0`。现有后端没有 CLI token revoke endpoint，因此本 Demo 的 logout 明确定义为本地登出；不会伪称已远端撤销 token。

## 5. 本地存储

默认数据目录遵循平台约定：

- macOS/Linux：`${XDG_CONFIG_HOME:-~/.config}/doubao-login-demo`
- Windows：`%APPDATA%\\doubao-login-demo`

包含：

- `session.json.enc`：AES-256-GCM 加密后的 session
- `session.key`：32-byte 随机 key 的 Base64 编码

写入规则：

- 目录和文件尽可能限制为当前用户访问，POSIX 文件 mode 为 `0600`
- 先写同目录临时文件，再 rename 原子替换
- session 与 key 任一损坏均返回受控错误，不降级为 `Not logged in`
- logout 同时删除 session 与 key
- session 数据包含 host、access token、过期时间、用户 ID、显示名和服务端提供的 refreshable metadata；不包含飞书 refresh token

该方案适用于登录集成 Demo。它不把同目录 key 文件描述成操作系统 Keychain 等级的安全存储。

## 6. 模块划分

```text
bin/doubao-login-demo.mjs       npm 可执行入口
src/cli.mjs                     argv 路由、输出分派、exit code
src/auth-client.mjs             Gateway Auth Contract HTTP client
src/auth-session.mjs            登录完成、current/refresh 状态机
src/session-store.mjs           加密、原子持久化、清理
src/browser.mjs                 macOS/Linux/Windows 浏览器启动
src/config.mjs                  host 与数据目录校验
src/errors.mjs                  稳定错误类型和退出码映射
src/output.mjs                  text/JSON 脱敏输出
test/*.test.mjs                 单元及进程级测试
docs/doubao-connector.md        豆包侧安装与命令配置
```

command 层不直接实现 HTTP、加密或轮询细节；各核心模块通过显式依赖注入便于使用内置测试工具验证。

## 7. HTTP 与响应处理

- 使用 Node.js 内置 `fetch`
- 所有请求设置有限超时
- 只接受预期的 JSON envelope 和字段类型
- 对非 2xx、无效 JSON、超时和连接失败统一转成脱敏错误
- 不把响应 header/body 原样打印到 stderr
- `Authorization: Bearer <token>` 仅在内存中组装
- `verificationUrl` 必须与配置 host 同源且路径位于 `/api/cli/auth/` 下，避免服务端异常响应诱导打开任意站点
- `pollIntervalSeconds` 与 `expiresAt` 由客户端做合理边界校验，避免零间隔忙轮询或无限等待

## 8. 发行和豆包配置

项目提供标准 npm tarball：

```bash
npm pack
npm install -g ./doubao-login-demo-<version>.tgz
```

正式接入豆包时填写：

- 安装命令：使用内部 npm registry 的固定包名/版本或可访问 tarball
- 登录命令：`doubao-login-demo auth login --host https://<gateway-public-host>`
- 状态命令：`doubao-login-demo auth status`
- 已登录匹配：按 stdout 第一行匹配 `^Logged in$`
- 退出命令：`doubao-login-demo auth logout`
- 版本命令：`doubao-login-demo --version`

安装命令和命令参数不得包含 secret 或 token。正式 Gateway 必须使用公网 HTTPS，并正确配置飞书回调地址。

## 9. 测试与验收

自动化测试至少覆盖：

- root help/version、未知命令、参数错误和 exit code
- host 校验及 loopback 开发例外
- Auth Contract URL、headers、request body 和响应校验
- 阻塞登录的 pending → authorized、先落盘后成功输出
- denied/cancelled/expired/failed/consumed 终态
- 超时、网络错误、恶意或错误源 `verificationUrl`
- 浏览器启动失败不终止登录
- SIGINT/SIGTERM 尽力 cancel 且不落盘
- status 的登录、未登录、损坏存储、刷新成功、刷新失败
- whoami 不输出 access token
- logout 同时清理密文和 key，且幂等
- 加密存储往返、篡改检测、原子写失败恢复
- macOS/Linux/Windows 浏览器命令参数不使用 shell
- stdout/stderr 不出现 token 或原始敏感响应
- 安装 tarball 后从 PATH 执行 help/version/status 的 smoke test

完成前运行：

```bash
npm test
npm pack --dry-run
```

另运行一个本地假 Gateway 的进程级登录/状态/logout 闭环。真实 Gateway 的人工 smoke test 需要可用公网 host 和浏览器授权；若环境未提供，则明确列为未执行，不能宣称真实环境已验证。

## 10. 非目标

- 不实现日报、任务或其他业务命令
- 不复制 `lark-hive-ai` 的完整 oclif CLI
- 不修改 Gateway/Core API contract
- 不直连飞书 OAuth/token/user-info API
- 不内置飞书 App ID/App Secret
- 不实现远端 token revoke
- 不宣称 Demo 等同于完整业务 Connector
