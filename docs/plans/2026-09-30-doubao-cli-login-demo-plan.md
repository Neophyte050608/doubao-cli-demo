# 豆包 CLI 登录 Demo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建一个可通过 npm 安装、可被豆包 CLI Connector 调用，并能借助 `lark-hive-ai` Gateway 完成登录、状态检查、身份识别和本地登出的独立 Demo。

**Architecture:** CLI 使用 Native ESM JavaScript 和 Node.js 内置模块，通过 Gateway CLI Auth Contract v3 完成服务端代理 OAuth；本地仅保存 Gateway session，并用 AES-256-GCM 加密和原子替换。命令层只处理 argv、输出和退出码，HTTP、登录状态机、session 管理与浏览器启动分别放在独立模块中。

**Tech Stack:** Node.js >=22、Native ESM、内置 `fetch`、`node:test`、`node:crypto`、`node:fs/promises`、`node:child_process`、npm package/tarball。

**Spec:** `docs/specs/2026-09-30-doubao-cli-login-demo-design.md`

## Global Constraints

- 项目固定放在 `/Users/bytedance/bits/doubao-cli-login-demo`，不得修改 `/Users/bytedance/bits/lark-hive-ai/lark-hive-ai`。
- Node.js 版本下限为 22；生产代码使用 Native ESM JavaScript。
- 不引入 TypeScript、oclif、Express、Axios、数据库、Redis 或其他运行时依赖。
- CLI 只调用 `lark-hive-ai` Gateway `/api/cli/auth/**`，不得直连飞书 OpenAPI。
- 不接收、不保存、不打印飞书 App Secret、OAuth code、Cookie、access token 或原始敏感响应。
- 正式 host 只允许 HTTPS；HTTP 仅允许显式 loopback 地址及端口。
- 文本和 JSON 输出、退出码、HTTP Contract v3 headers 属于稳定接口。
- 行为变更使用 TDD：先运行失败测试，再写最小实现，再运行通过测试。
- 每个任务完成后保持新仓库可测试；任何验证结论必须来自当前会话新运行的命令。

## Review Focus

- Gateway 返回 HTTP 200 但 envelope `code != 0`、字段缺失或类型错误时，CLI 应返回脱敏的服务错误，不能继续登录或落盘。
- 恶意 `verificationUrl`（跨 origin、userinfo、非 `/api/cli/auth/` 路径）不得被打印或打开。
- session 已过期且 refresh/current 连续返回 401 时，应清除本地 session 并稳定报告 `Not logged in`，不能形成刷新循环。
- 登录收到信号时，cancel 请求超时或失败也必须结束进程，且不得写入 session。
- 加密文件/key 缺失组合、篡改或原子 rename 失败必须区分“未登录”和“存储损坏”，不得破坏上一个有效 session。

---

## 文件结构

```text
/Users/bytedance/bits/doubao-cli-login-demo/
├── .gitignore
├── README.md
├── package.json
├── bin/
│   └── doubao-login-demo.mjs
├── docs/
│   ├── doubao-connector.md
│   ├── plans/
│   │   └── 2026-09-30-doubao-cli-login-demo-plan.md
│   └── specs/
│       └── 2026-09-30-doubao-cli-login-demo-design.md
├── src/
│   ├── auth-client.mjs
│   ├── auth-session.mjs
│   ├── browser.mjs
│   ├── cli.mjs
│   ├── config.mjs
│   ├── errors.mjs
│   ├── login-flow.mjs
│   ├── output.mjs
│   └── session-store.mjs
└── test/
    ├── auth-client.test.mjs
    ├── auth-session.test.mjs
    ├── browser.test.mjs
    ├── cli.test.mjs
    ├── config.test.mjs
    ├── login-flow.test.mjs
    ├── package-smoke.test.mjs
    ├── session-store.test.mjs
    └── support/
        ├── fake-gateway.mjs
        └── run-cli.mjs
```

职责边界：

- `cli.mjs`：命令解析、调用 use case、选择 stdout/stderr 与 exit code。
- `auth-client.mjs`：Gateway HTTP Contract v3、timeout、envelope 和 DTO 校验。
- `login-flow.mjs`：start/open/poll/cancel 的阻塞登录生命周期。
- `auth-session.mjs`：current/refresh、身份读取、过期 session 和 401 处理。
- `session-store.mjs`：AES-256-GCM、文件权限、原子写与清理。
- `config.mjs`：host、目录与 package version 解析。
- `browser.mjs`：无 shell 的跨平台浏览器启动。
- `output.mjs`：稳定文本/JSON renderer，永不接触 token 字段。
- `errors.mjs`：受控错误分类和退出码常量。

### Task 1: 建立可安装 CLI shell、配置校验和稳定退出码

**Files:**
- Create: `.gitignore`
- Create: `package.json`
- Create: `bin/doubao-login-demo.mjs`
- Create: `src/errors.mjs`
- Create: `src/config.mjs`
- Create: `src/output.mjs`
- Create: `src/cli.mjs`
- Create: `test/config.test.mjs`
- Create: `test/cli.test.mjs`
- Create: `test/support/run-cli.mjs`

**Interfaces:**
- Produces: `EXIT_CODES = {OK: 0, NOT_LOGGED_IN: 1, OPERATIONAL: 2, AUTH: 3}`。
- Produces: `CliError(code, message, exitCode, options?)`，其中 `cause` 不参与用户输出。
- Produces: `normalizeHost(rawHost): string`；仅允许 HTTPS 或带显式端口的 loopback HTTP。
- Produces: `getDataDirectory({env, platform, homeDir}): string`。
- Produces: `runCli(argv, dependencies): Promise<number>`；所有命令均通过此入口返回退出码。

- [ ] **Step 1: 写 package/配置/CLI shell 的失败测试**

在 `test/config.test.mjs` 覆盖：

```js
assert.equal(normalizeHost('https://gateway.example.com/'), 'https://gateway.example.com')
assert.equal(normalizeHost('http://127.0.0.1:8080'), 'http://127.0.0.1:8080')
assert.throws(() => normalizeHost('http://gateway.example.com'), /HTTPS/)
assert.throws(() => normalizeHost('http://127.0.0.1'), /explicit port/)
assert.throws(() => normalizeHost('https://user:pass@gateway.example.com'), /credentials/)
```

在 `test/cli.test.mjs` 使用内存 stdout/stderr 覆盖：

```js
assert.equal((await invoke(['--version'])).code, 0)
assert.match((await invoke(['--version'])).stdout, /^0\.1\.0\n$/)
assert.match((await invoke(['--help'])).stdout, /auth login/)
assert.equal((await invoke(['unknown'])).code, 2)
assert.match((await invoke(['unknown'])).stderr, /Unknown command/)
assert.equal((await invoke([])).code, 2)
```

同时断言 help 不包含 `token` 示例、App Secret 或真实 host。

- [ ] **Step 2: 运行测试并确认因模块不存在而失败**

Run:

```bash
node --test test/config.test.mjs test/cli.test.mjs
```

Expected: FAIL，错误为 `ERR_MODULE_NOT_FOUND` 或缺少导出。

- [ ] **Step 3: 实现最小 package 与命令 shell**

`package.json` 固定核心字段：

```json
{
  "name": "doubao-login-demo",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "bin": {"doubao-login-demo": "./bin/doubao-login-demo.mjs"},
  "engines": {"node": ">=22"},
  "scripts": {"test": "node --test", "pack:dry-run": "npm pack --dry-run"},
  "files": ["bin/", "src/", "docs/doubao-connector.md", "README.md"]
}
```

`bin/doubao-login-demo.mjs` 只负责调用 `runCli(process.argv.slice(2), createRuntimeDependencies())` 并设置 `process.exitCode`。先实现离线 `--help`、`--version`、命令形状解析及占位依赖错误；后续任务注入真实 use case。禁止使用 `process.exit()` 处理普通错误。

- [ ] **Step 4: 运行 focused 测试并确认通过**

Run:

```bash
node --test test/config.test.mjs test/cli.test.mjs
```

Expected: PASS。

- [ ] **Step 5: 提交 CLI shell**

```bash
git add .gitignore package.json bin src/errors.mjs src/config.mjs src/output.mjs src/cli.mjs test/config.test.mjs test/cli.test.mjs test/support/run-cli.mjs
git commit -m "feat: add installable CLI shell"
```

### Task 2: 实现 Gateway Auth Contract v3 客户端

**Files:**
- Create: `src/auth-client.mjs`
- Create: `test/auth-client.test.mjs`
- Create: `test/support/fake-gateway.mjs`
- Modify: `src/errors.mjs`

**Interfaces:**
- Consumes: `normalizeHost(rawHost)`、`CliError`。
- Produces: `createAuthClient({fetchImpl, timeoutMs, version})`。
- Produces methods:

```js
start({host})
poll({host, loginSessionId})
cancel({host, loginSessionId})
refresh({host, accessToken})
current({host, accessToken})
```

- Produces: `AuthHttpError`，公开 `kind`、`status`、`serverCode`，但不公开 raw body 或 Authorization header。

- [ ] **Step 1: 写 HTTP contract 的失败测试**

使用本地 fake Gateway 或 mock `fetchImpl` 验证：

```js
assert.equal(request.url, 'https://gateway.example.com/api/cli/auth/start')
assert.equal(request.headers.get('X-Lark-Hive-CLI-Contract-Version'), '3')
assert.equal(request.headers.get('X-Lark-Hive-CLI-Version'), '0.1.0')
assert.deepEqual(JSON.parse(request.body), {host: 'https://gateway.example.com'})
```

分别覆盖 start/poll/cancel/refresh/current 的 method、body、Bearer header，以及以下失败输入：

- HTTP 500 且 body 含假 token，不得出现在 `error.message`
- HTTP 200 但 `{code: 70001, message: '...'}`
- HTTP 200 但无 `data`
- `data` 字段缺失或类型错误
- 非 JSON 响应
- `AbortError` timeout
- current/refresh 的 401 可通过 `error.status === 401` 判断

- [ ] **Step 2: 运行 auth client 测试并确认失败**

Run:

```bash
node --test test/auth-client.test.mjs
```

Expected: FAIL，`src/auth-client.mjs` 不存在。

- [ ] **Step 3: 实现请求、envelope 解包与 DTO 校验**

为每个 endpoint 使用固定 path，不允许 caller 拼接路径。所有请求使用 `AbortSignal.timeout(timeoutMs)`；解析 `{code, message, data}`，仅当 `code === 0` 且 `data` 满足对应 shape 时返回。错误消息限制为稳定文案，例如 `Gateway request failed`、`Gateway returned an invalid response`，服务端 code 仅作为非敏感结构字段保留。

DTO 校验必须验证：

```js
// start
{loginSessionId, verificationUrl, userCode, pollIntervalSeconds, expiresAt}
// authorized session / refresh
{accessToken, expiresAt, principalType: 'USER', userId, displayName, refreshable, refreshableUntil}
// current
{principalType: 'USER', userId, displayName, expiresAt, refreshable, refreshableUntil}
```

- [ ] **Step 4: 运行测试并确认通过**

Run:

```bash
node --test test/auth-client.test.mjs
```

Expected: PASS。

- [ ] **Step 5: 提交 Auth client**

```bash
git add src/auth-client.mjs src/errors.mjs test/auth-client.test.mjs test/support/fake-gateway.mjs
git commit -m "feat: add Gateway auth client"
```

### Task 3: 实现加密 session store 和跨平台数据目录

**Files:**
- Create: `src/session-store.mjs`
- Create: `test/session-store.test.mjs`
- Modify: `src/config.mjs`
- Modify: `src/errors.mjs`

**Interfaces:**
- Consumes: `getDataDirectory(...)`、`CliError`。
- Produces: `SessionStoreCorruptedError`。
- Produces: `createSessionStore({directory, fsImpl?})`，返回：

```js
read(): Promise<StoredSession | null>
write(session): Promise<void>
clear(): Promise<void>
paths: {sessionPath, keyPath}
```

- `StoredSession` 必须包含：`host`、`accessToken`、`expiresAt`、`principalType`、`userId`、`displayName`、`refreshable`、`refreshableUntil`。

- [ ] **Step 1: 写 session store 的失败测试**

测试使用 `mkdtemp()`，覆盖：

```js
await store.write(session)
assert.deepEqual(await store.read(), session)
assert.doesNotMatch(await readFile(store.paths.sessionPath, 'utf8'), /secret-access-token/)
assert.equal((await stat(store.paths.sessionPath)).mode & 0o777, 0o600)
assert.equal((await stat(store.paths.keyPath)).mode & 0o777, 0o600)
```

并覆盖：

- session 与 key 均不存在返回 `null`
- session 存在但 key 缺失为 `SessionStoreCorruptedError`
- key 存在但 session 缺失也为损坏，而不是未登录
- 篡改 ciphertext/tag 后读取失败
- 非 v3 session shape 读取失败
- `clear()` 同时删除两文件且重复执行成功
- rename 注入失败后，上一个有效 session 仍可读取且临时文件被清理
- Windows/macOS/Linux 数据目录选择符合设计

- [ ] **Step 2: 运行测试并确认失败**

Run:

```bash
node --test test/session-store.test.mjs test/config.test.mjs
```

Expected: FAIL，缺少 session store。

- [ ] **Step 3: 实现 AES-256-GCM 与原子替换**

密文 payload 固定为：

```json
{"version":1,"iv":"base64","tag":"base64","ciphertext":"base64"}
```

使用 32-byte 随机 key 和 12-byte IV；文件写入同目录唯一临时文件，`chmod(0o600)` 后 rename。只有“两文件均不存在”是未登录；不完整组合、JSON/字段/Base64/GCM/StoredSession 校验失败均抛受控损坏错误。

- [ ] **Step 4: 运行 focused 测试并确认通过**

Run:

```bash
node --test test/session-store.test.mjs test/config.test.mjs
```

Expected: PASS。

- [ ] **Step 5: 提交 session store**

```bash
git add src/session-store.mjs src/config.mjs src/errors.mjs test/session-store.test.mjs test/config.test.mjs
git commit -m "feat: persist encrypted CLI sessions"
```

### Task 4: 实现 current/refresh 身份状态机

**Files:**
- Create: `src/auth-session.mjs`
- Create: `test/auth-session.test.mjs`

**Interfaces:**
- Consumes: `authClient.current/refresh`、`sessionStore.read/write/clear`。
- Produces: `createAuthSession({authClient, sessionStore, now})`，返回：

```js
getIdentity(): Promise<{
  loggedIn: true,
  host: string,
  user: {displayName: string, userId: string},
  expiresAt: string,
  refreshable: boolean,
  refreshableUntil: string
} | {loggedIn: false}>
logout(): Promise<void>
```

- [ ] **Step 1: 写身份状态机失败测试**

覆盖：

1. 无 session → `{loggedIn:false}`，不发 HTTP 请求。
2. session 距过期超过 5 分钟 → current 一次成功。
3. session 已过期或 5 分钟内过期 → refresh、先保存新 session、再 current。
4. current 首次 401 → refresh 一次、保存、current 重试一次。
5. refresh 401 或第二次 current 401 → clear 后 `{loggedIn:false}`。
6. refresh/current 的网络错误 → 不清 session并抛 operational error。
7. 无效日期或缺失 displayName → 清理并抛存储/认证错误，不无限刷新。
8. 断言 access token 不存在于返回 identity、异常 message 或测试捕获的输出。

- [ ] **Step 2: 运行测试并确认失败**

Run:

```bash
node --test test/auth-session.test.mjs
```

Expected: FAIL，缺少 `src/auth-session.mjs`。

- [ ] **Step 3: 实现单次 refresh 状态机**

`getIdentity()` 最多执行一次 refresh 和两次 current。仅 401 表示凭证不可用；网络、5xx 或 malformed response 视为检查失败，不清除 session。新 session 写入字段来自 refresh 响应并保留原 host，不保存任何 refresh token。

- [ ] **Step 4: 运行测试并确认通过**

Run:

```bash
node --test test/auth-session.test.mjs
```

Expected: PASS。

- [ ] **Step 5: 提交身份状态机**

```bash
git add src/auth-session.mjs test/auth-session.test.mjs
git commit -m "feat: validate and refresh login sessions"
```

### Task 5: 实现安全浏览器启动和阻塞登录生命周期

**Files:**
- Create: `src/browser.mjs`
- Create: `src/login-flow.mjs`
- Create: `test/browser.test.mjs`
- Create: `test/login-flow.test.mjs`
- Modify: `src/config.mjs`

**Interfaces:**
- Consumes: `authClient.start/poll/cancel`、`sessionStore.write`、规范化 host。
- Produces: `openBrowser(url, {platform, spawnImpl}): Promise<void>`。
- Produces: `validateVerificationUrl({host, verificationUrl}): string`。
- Produces: `runLogin({host, authClient, sessionStore, openBrowser, sleep, now, onPending, signalSource}): Promise<Identity>`。
- `onPending({verificationUrl, userCode, loginSessionId})` 必须在浏览器启动和首次 poll 前调用。

- [ ] **Step 1: 写浏览器与 URL 安全失败测试**

覆盖平台命令：

```js
// macOS
['open', [url], {shell: false}]
// Windows
['explorer.exe', [url], {shell: false}]
// Linux
['xdg-open', [url], {shell: false}]
```

`validateVerificationUrl` 接受同 origin 的 `/api/cli/auth/authorize?...`，拒绝：

- 其他 origin
- HTTP downgrade
- URL username/password
- `/other/path`
- `javascript:` 或无效 URL

- [ ] **Step 2: 写登录状态机失败测试**

覆盖：

- pending → pending → authorized；验证顺序为 `onPending`、open、poll、write、success return
- browser open reject 后仍继续 poll
- poll interval 最小 1 秒、最大 30 秒，非法值拒绝
- `expiresAt` 无效或超过允许窗口时拒绝；到期前不无限等待
- denied/cancelled/expired/failed/consumed 各映射为 auth error exit `3`
- `SIGINT`/`SIGTERM` 触发 cancel，cancel reject/超时也不写 session
- 收到信号与 authorized 竞态时，只有先成功持久化的一方可产生登录成功
- pending 回调与错误中不出现 access token

- [ ] **Step 3: 运行 focused 测试并确认失败**

Run:

```bash
node --test test/browser.test.mjs test/login-flow.test.mjs
```

Expected: FAIL，模块不存在。

- [ ] **Step 4: 实现浏览器与登录生命周期**

浏览器子进程使用参数数组与 `{detached: true, stdio: 'ignore', shell: false}`，启动后 `unref()`；登录主进程本身必须由 polling promise 保持存活。信号处理器应幂等、设置 cancellation flag、以有限 timeout 调用 cancel，并在 finally 中解除监听。

授权成功的提交点是 `await sessionStore.write(...)` 完成；提交前信号取消不得输出成功，提交后不得再删除刚写入的 session。

- [ ] **Step 5: 运行 focused 测试并确认通过**

Run:

```bash
node --test test/browser.test.mjs test/login-flow.test.mjs
```

Expected: PASS。

- [ ] **Step 6: 提交登录生命周期**

```bash
git add src/browser.mjs src/login-flow.mjs src/config.mjs test/browser.test.mjs test/login-flow.test.mjs
git commit -m "feat: add blocking browser login flow"
```

### Task 6: 接通 login/status/whoami/logout 命令与稳定输出

**Files:**
- Modify: `src/cli.mjs`
- Modify: `src/output.mjs`
- Modify: `bin/doubao-login-demo.mjs`
- Modify: `test/cli.test.mjs`
- Modify: `test/support/run-cli.mjs`

**Interfaces:**
- Consumes: `createAuthClient`、`createSessionStore`、`createAuthSession`、`runLogin`、`openBrowser`。
- Produces commands:

```text
auth login --host <url>
auth status [--json]
auth logout [--json]
whoami [--json]
```

- [ ] **Step 1: 写命令级失败测试**

测试使用注入 fake dependencies，覆盖：

```js
const status = await invoke(['auth', 'status'])
assert.equal(status.code, 0)
assert.equal(status.stdout.split('\n')[0], 'Logged in')
assert.doesNotMatch(status.stdout + status.stderr, /secret-access-token/)
```

并覆盖：

- status 未登录：stdout 第一行 `Not logged in`、exit `1`
- status JSON 的稳定 shape；未登录严格输出 `{"loggedIn":false}`
- status 存储损坏/网络失败：stderr、exit `2`，stdout 不输出 `Not logged in`
- whoami 文本/JSON 成功及未登录/失败退出码
- login 缺失/非法 host：exit `2`
- login 先打印授权信息，成功最后打印 `Logged in as Alice`、exit `0`
- login terminal auth failure：exit `3`
- login operational failure：exit `2`
- logout 清理成功和幂等：`Logged out`、exit `0`
- `--json` 出现在不支持的位置、与未知 flag：exit `2`
- 所有输出不包含 fake access token、Authorization header 或 raw response body

- [ ] **Step 2: 运行 CLI 测试并确认失败**

Run:

```bash
node --test test/cli.test.mjs
```

Expected: FAIL，命令尚未接入真实 use case。

- [ ] **Step 3: 实现 runtime 装配和 renderer**

入口构建：

```js
const authClient = createAuthClient({fetchImpl: globalThis.fetch, timeoutMs: 10_000, version})
const sessionStore = createSessionStore({directory: getDataDirectory(...)})
const authSession = createAuthSession({authClient, sessionStore, now: () => new Date()})
```

status 文本第一行必须单独输出 `Logged in` 或 `Not logged in`。renderer 只接收筛选后的 identity，不接收原始 session，从类型/结构边界降低 token 泄漏风险。

- [ ] **Step 4: 运行命令测试并确认通过**

Run:

```bash
node --test test/cli.test.mjs
```

Expected: PASS。

- [ ] **Step 5: 运行当前全量测试**

Run:

```bash
npm test
```

Expected: PASS，0 failures。

- [ ] **Step 6: 提交命令集成**

```bash
git add src/cli.mjs src/output.mjs bin/doubao-login-demo.mjs test/cli.test.mjs test/support/run-cli.mjs
git commit -m "feat: expose login identity commands"
```

### Task 7: 编写豆包配置文档和 README

**Files:**
- Create: `README.md`
- Create: `docs/doubao-connector.md`
- Modify: `test/cli.test.mjs`

**Interfaces:**
- Consumes: 已实现的命令、输出与退出码。
- Produces: 可直接用于豆包 Connector 配置的安装、登录、状态、正则、退出和升级说明。

- [ ] **Step 1: 添加文档契约失败测试**

在 `test/cli.test.mjs` 或独立文档测试中读取文档并断言包含：

```text
doubao-login-demo --version
doubao-login-demo --help
doubao-login-demo auth login --host https://<gateway-public-host>
doubao-login-demo auth status
^Logged in$
doubao-login-demo auth logout
doubao-login-demo whoami
```

同时断言不包含 `FEISHU_APP_SECRET=`、示例 token、`/private/tmp/feishu-cli-demo` 或直连 `accounts.feishu.cn` token endpoint。

- [ ] **Step 2: 运行文档测试并确认失败**

Run:

```bash
node --test test/cli.test.mjs
```

Expected: FAIL，README/连接器文档不存在。

- [ ] **Step 3: 编写用户文档**

README 覆盖前置条件、本地开发、安装 tarball、命令、数据目录、安全边界和测试。`docs/doubao-connector.md` 提供豆包表单逐项值、状态正则、版本升级命令、Gateway 公网 HTTPS/飞书回调要求及“不含业务功能”的 Demo 声明。

安装示例使用本地 tarball 或内部 registry 占位域名，不提供无法执行的公开发布承诺，不在命令中携带 secret。

- [ ] **Step 4: 运行测试并确认通过**

Run:

```bash
npm test
```

Expected: PASS。

- [ ] **Step 5: 提交文档**

```bash
git add README.md docs/doubao-connector.md test/cli.test.mjs
git commit -m "docs: document Doubao connector setup"
```

### Task 8: 完成 tarball、PATH 和假 Gateway 端到端验证

**Files:**
- Create: `test/package-smoke.test.mjs`
- Modify: `test/support/fake-gateway.mjs`
- Modify: `package.json`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: npm package、CLI executable、全部命令和 fake Gateway。
- Produces: 可重复的安装包 smoke test 与本地完整登录闭环证据。

- [ ] **Step 1: 写 package smoke 失败测试**

测试通过 `npm pack --json --pack-destination <temp>` 生成 tarball，再用临时 npm prefix 安装，并从生成的 `bin/doubao-login-demo` 运行：

```text
--version
auth status
--help
```

验证 version/help exit `0`，干净 HOME 下 status 输出 `Not logged in` 且 exit `1`。检查 tarball file list 不包含 `.git`、测试、临时文件、session/key 或 `.env`。

- [ ] **Step 2: 添加假 Gateway 进程级闭环失败测试**

fake Gateway 顺序返回：

1. start → login metadata
2. poll → pending
3. poll → authorized session
4. current → Alice identity
5. refresh（需要时）→ replacement session

使用同一个临时 HOME 运行独立 CLI 子进程：

```text
auth login --host http://127.0.0.1:<port>
auth status
whoami --json
auth logout
auth status
```

断言退出码依次为 `0, 0, 0, 0, 1`，登录后的 status 第一行为 `Logged in`，whoami 为 Alice，登出后为 `Not logged in`，所有 stdout/stderr 均不含 fake token。

- [ ] **Step 3: 运行 smoke 测试并确认失败**

Run:

```bash
node --test test/package-smoke.test.mjs
```

Expected: FAIL，尚未实现打包/完整 fake Gateway smoke harness。

- [ ] **Step 4: 实现 package 与 E2E harness 的最小修正**

确保 bin 带 executable mode、tarball 只包含 `files` 白名单、package 安装后无需开发依赖。fake Gateway 必须只监听随机 loopback port，测试结束后可靠关闭。

- [ ] **Step 5: 运行全部自动化和打包检查**

Run:

```bash
npm test
npm pack --dry-run
```

Expected: 全部测试 PASS；dry-run file list 仅含预期分发文件。

- [ ] **Step 6: 手工运行已安装 tarball 的离线 smoke**

Run:

```bash
TMP_PREFIX="$(mktemp -d)"
npm pack --pack-destination "$TMP_PREFIX"
npm install --prefix "$TMP_PREFIX/install" "$TMP_PREFIX"/doubao-login-demo-*.tgz
"$TMP_PREFIX/install/node_modules/.bin/doubao-login-demo" --version
"$TMP_PREFIX/install/node_modules/.bin/doubao-login-demo" --help
```

Expected: 两个命令 exit `0`，version 为 `0.1.0`，help 包含四个核心命令。

- [ ] **Step 7: 检查敏感内容、工作树和 monorepo 未修改**

Run:

```bash
rg -n "FEISHU_APP_SECRET|client_secret|Bearer [A-Za-z0-9]|secret-access-token" . --glob '!docs/specs/**' --glob '!docs/plans/**' --glob '!test/**'
git status --short
git -C /Users/bytedance/bits/lark-hive-ai/lark-hive-ai status --short
```

Expected: 生产/分发文件无真实 secret 或 token；新仓库仅有预期待提交文件；monorepo 无输出。

- [ ] **Step 8: 提交 smoke tests 和最终修正**

```bash
git add .gitignore package.json test/package-smoke.test.mjs test/support/fake-gateway.mjs
git commit -m "test: verify packaged login lifecycle"
```

- [ ] **Step 9: 最终验证并记录未执行项**

Run:

```bash
npm test
npm pack --dry-run
git status --short
git log --oneline --decorate -10
git -C /Users/bytedance/bits/lark-hive-ai/lark-hive-ai status --short
```

Expected: 测试和 dry-run 通过；两个工作树干净；提交历史包含各任务提交。若没有真实公网 Gateway host，不运行真实飞书浏览器授权，并在交付说明中明确“本地假 Gateway 已验证，真实 Gateway 人工 smoke 未执行”。
