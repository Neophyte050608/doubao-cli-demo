# 豆包 CLI Connector 配置

本文说明如何把 `doubao-login-demo` 作为一个最小登录型 CLI 接入豆包。它只验证“登录后能识别我是谁”，不包含任何业务命令。

## 1. Gateway 准备

准备一个当前终端与浏览器均可访问的 `lark-hive-ai` Gateway：

```text
https://<gateway-public-host>
```

正式接入必须使用公网 HTTPS 地址。Gateway 负责飞书 OAuth、回调、session 签发和身份查询；CLI 不直连飞书 OAuth，也不持有飞书应用密钥。请先在 Gateway 和飞书应用侧配置好匹配的 OAuth 回调地址。

## 2. 安装 CLI

在源码目录构建 tarball 并安装：

```bash
npm test
npm pack
npm install --global ./doubao-login-demo-0.1.0.tgz
```

验证安装：

```bash
doubao-login-demo --version
doubao-login-demo --help
```

## 3. Connector 表单值

将豆包 CLI Connector 的对应字段配置为：

| 字段 | 建议值 |
| --- | --- |
| CLI 名称 | `doubao-login-demo` |
| 可执行文件 | `doubao-login-demo` |
| 版本命令 | `doubao-login-demo --version` |
| 帮助命令 | `doubao-login-demo --help` |
| 登录命令 | `doubao-login-demo auth login --host https://<gateway-public-host>` |
| 登录状态命令 | `doubao-login-demo auth status` |
| 已登录匹配正则 | `^Logged in$` |
| 退出登录命令 | `doubao-login-demo auth logout` |
| 当前用户命令 | `doubao-login-demo whoami` |

`auth status` 在已登录时首行严格输出 `Logged in`，因此状态正则应启用逐行匹配。未登录时输出 `Not logged in`，退出码为 `1`。

如果 Connector 支持 JSON，可使用：

```bash
doubao-login-demo auth status --json
doubao-login-demo whoami --json
doubao-login-demo auth logout --json
```

稳定输出示例：

```json
{"loggedIn":true,"user":{"displayName":"Alice","userId":"ou_1"},"host":"https://gateway.example.com"}
```

## 4. 首次登录与身份验证

执行登录：

```bash
doubao-login-demo auth login --host https://<gateway-public-host>
```

CLI 会显示验证地址和一次性用户码、尝试拉起浏览器，并阻塞等待结果。登录成功后检查：

```bash
doubao-login-demo auth status
doubao-login-demo whoami
```

预期 `whoami` 显示用户名称、用户 ID 和 Gateway host。

## 5. 退出登录

```bash
doubao-login-demo auth logout
```

退出只清理本机加密 session。再次执行 `auth status` 应输出 `Not logged in` 并返回退出码 `1`。

## 6. 升级

拿到新版本 tarball 后执行：

```bash
npm install --global ./doubao-login-demo-<version>.tgz
```

然后重新验证：

```bash
doubao-login-demo --version
doubao-login-demo auth status
```

## 7. 安全说明

- 不要把 access token、Cookie、Authorization header 或 OAuth code 填入 Connector 配置；
- 不要把飞书应用密钥传给 CLI；
- session 仅保存在本机平台配置目录，并以 AES-256-GCM 加密；
- Connector 应通过 Gateway public contract 集成，不应绕过 Gateway；
- 日志和问题反馈中不要粘贴本地 session/key 文件或 Gateway 原始响应。
