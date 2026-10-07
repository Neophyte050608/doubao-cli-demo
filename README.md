# doubao-login-demo

一个用于豆包企业 CLI Connector 集成验证的完整、独立飞书登录 Demo。

它具备企业连接器需要的基本 CLI 生命周期：

```bash
doubao-login-demo --version
doubao-login-demo --help
doubao-login-demo auth login
doubao-login-demo auth status
doubao-login-demo auth status --json
doubao-login-demo whoami
doubao-login-demo whoami --json
doubao-login-demo auth logout
```

Demo 使用飞书开发者后台的企业自建应用完成 OAuth 登录，但不依赖 `lark-hive-ai`、Gateway、core-api、数据库、Redis 或其他常驻服务，也不包含业务功能。

## 1. 工作方式

```text
豆包/终端执行 CLI
  → CLI 在当前机器临时监听 127.0.0.1:8787
  → 打开飞书 OAuth 授权页面
  → 飞书浏览器回调当前机器
  → CLI 使用 App ID + App Secret 换取 user_access_token
  → 查询当前用户的 name 和 open_id
  → 以应用身份取得 tenant_access_token
  → 按 open_id 查询通讯录 user_id（employeeId）
  → 加密保存身份状态，立即丢弃两个 access token
```

本地回调服务只在 `auth login` 执行期间运行，成功、拒绝、失败或五分钟超时后自动关闭。因此，本机或同一台云电脑测试不需要部署远程服务器。

## 2. 飞书开发者后台

创建企业自建应用，并配置重定向 URL：

```text
http://127.0.0.1:8787/callback
```

该值必须与 `FEISHU_REDIRECT_URI` 完全一致，包括协议、IP、端口和路径。

按企业方案在权限管理中开通并发布：

```text
contact:user.employee_id:readonly（应用身份，通讯录全部成员）
```

这是应用身份权限，不会被写进浏览器 OAuth 的 `scope` 参数。Demo 先通过用户 OAuth 确认登录者的 `name` 和 `open_id`，再以应用身份调用通讯录接口，将该 `open_id` 解析为响应中的 `user_id`，并在 CLI 输出中命名为 `employeeId`。Demo 不请求 `component:user_profile` 或 `offline_access`。

完成权限配置后，需要创建并发布应用版本，并确保测试账号处于应用可用范围内。

## 3. 安装

要求 Node.js 22 或更高版本。

从 GitHub `v0.1.0` 安装：

```bash
npm install --global https://github.com/Neophyte050608/doubao-cli-login-demo.git#v0.1.0
```

验证：

```bash
doubao-login-demo --version
doubao-login-demo --help
```

也可以在源码目录直接运行：

```bash
node ./src/cli.mjs --help
```

## 4. 配置应用凭证

CLI 从运行环境读取：

```bash
export FEISHU_APP_ID='cli_xxx'
export FEISHU_APP_SECRET='替换为新密钥'
export FEISHU_REDIRECT_URI='http://127.0.0.1:8787/callback'
```

`FEISHU_REDIRECT_URI` 可以省略，默认就是上述本机回调地址。

代码不会自动读取 `.env`。不要把真实 App Secret 写入源码、GitHub、普通文档或截图。曾经粘贴到聊天中的 Secret 应先在开发者后台重置。

## 5. 登录和身份查询

登录：

```bash
doubao-login-demo auth login
```

登录成功：

```text
Logged in as 示例用户
```

检查连接器登录状态：

```bash
doubao-login-demo auth status
```

已登录时首行固定输出：

```text
Logged in
```

未登录时输出：

```text
Not logged in
```

并返回退出码 `1`。

查询当前身份：

```bash
doubao-login-demo whoami
doubao-login-demo whoami --json
```

JSON 示例：

```json
{"name":"示例用户","openId":"ou_xxx","employeeId":"employee_xxx"}
```

当前 Demo 能识别最近完成飞书 OAuth 的用户姓名、`open_id` 和通讯录响应中的 `user_id`（输出为 `employeeId`）。它不查询部门、手机号或邮箱。

退出登录：

```bash
doubao-login-demo auth logout
```

该命令删除本机加密 session 和密钥。

## 6. 豆包企业 CLI Connector 配置

| 配置项 | 值 |
| --- | --- |
| CLI 名称 | `doubao-login-demo` |
| 可执行文件 | `doubao-login-demo` |
| 版本命令 | `doubao-login-demo --version` |
| 帮助命令 | `doubao-login-demo --help` |
| 登录命令 | `doubao-login-demo auth login` |
| 登录状态命令 | `doubao-login-demo auth status` |
| 已登录匹配正则 | `^Logged in$` |
| 退出登录命令 | `doubao-login-demo auth logout` |
| 当前用户命令 | `doubao-login-demo whoami --json` |

Connector 运行 CLI 时必须能读取 `FEISHU_APP_ID`、`FEISHU_APP_SECRET` 和可选的 `FEISHU_REDIRECT_URI`。安装 npm 包本身不会注入这些值。

## 7. 本地状态与安全边界

默认保存位置：

- macOS/Linux：`${XDG_CONFIG_HOME:-~/.config}/doubao-login-demo/`
- Windows：`%APPDATA%\\doubao-login-demo\\`

文件：

- `session.json.enc`：AES-256-GCM 加密后的用户身份状态；
- `session.key`：本机随机密钥。

POSIX 系统中两个文件权限均为 `0600`。本 Demo 只保存 `name`、`openId`、`employeeId` 和登录时间，不保存飞书 `user_access_token`、`tenant_access_token` 或 `refresh_token`；`auth status` 表示本机已完成过登录并保存身份，不代表远程 token 仍然有效。由于 Demo 没有业务请求，这已足够用于连接器登录与身份识别演示。

## 8. 本机、内网、公网和云电脑

| 场景 | 是否需要远程服务 | 说明 |
| --- | --- | --- |
| 本地电脑运行 CLI 和浏览器 | 不需要 | 回调到本机 `127.0.0.1` |
| 同一台云电脑运行 CLI 和浏览器 | 不需要 | 回调到云电脑自身 |
| 内网电脑可访问飞书公网 | 不需要 | 内网仅影响出网策略 |
| CLI 在远程机器、浏览器在本机 | 需要端口转发或其他回调方案 | 两边的 `127.0.0.1` 不是同一台机器 |
| 豆包在用户电脑执行 CLI | 不需要 | 适合当前 Demo |
| 豆包在云端容器执行，浏览器在用户电脑 | 当前方案不适用 | 需要公网 HTTPS 回调服务或平台回调转发 |

## 9. 退出码

| 退出码 | 含义 |
| --- | --- |
| `0` | 命令成功 |
| `1` | 当前未登录 |
| `2` | 参数、配置、本地存储或网络错误 |
| `3` | 授权拒绝、失败、超时或取消 |

## 10. 开发验证

项目没有第三方运行时依赖：

```bash
npm test
npm run pack:dry-run
```

飞书接口：

- `GET https://accounts.feishu.cn/open-apis/authen/v1/authorize`
- `POST https://accounts.feishu.cn/oauth/v3/token`
- `GET https://open.feishu.cn/open-apis/authen/v1/user_info`
- `POST https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal`
- `GET https://open.feishu.cn/open-apis/contact/v3/users/{open_id}`
