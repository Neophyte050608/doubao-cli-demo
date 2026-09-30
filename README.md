# doubao-login-demo

一个最小化的豆包 CLI Connector 登录 Demo。它只演示以下闭环：

1. 通过 `lark-hive-ai` Gateway 发起浏览器登录；
2. 在本机加密保存 Gateway session；
3. 查询登录状态并识别当前用户；
4. 清除本地登录。

本 Demo 不包含日报、任务或其他业务功能，也不直接调用飞书 OAuth/OpenAPI。

## 前置条件

- Node.js 22 或更高版本；
- 可供当前电脑访问的 `lark-hive-ai` Gateway；
- 正式环境 Gateway 必须提供公网 HTTPS 地址，并已正确配置飞书 OAuth 回调；
- 本地测试仅允许带显式端口的 `127.0.0.1` 或 `[::1]` HTTP 地址。

## 安装

从源码生成并安装本地 tarball：

```bash
npm test
npm pack
npm install --global ./doubao-login-demo-0.1.0.tgz
```

也可以在项目目录中直接运行：

```bash
node ./bin/doubao-login-demo.mjs --help
```

## 命令

```bash
doubao-login-demo --version
doubao-login-demo --help
doubao-login-demo auth login --host https://<gateway-public-host>
doubao-login-demo auth status
doubao-login-demo auth status --json
doubao-login-demo whoami
doubao-login-demo whoami --json
doubao-login-demo auth logout
doubao-login-demo auth logout --json
```

登录流程会打印 Gateway 验证地址和一次性用户码，并尝试打开浏览器。CLI 会阻塞轮询，直到成功、拒绝、取消、失败或过期。

已登录时，`auth status` 的第一行固定为：

```text
Logged in
```

豆包 Connector 可使用以下整行正则判断登录成功：

```regex
^Logged in$
```

未登录时输出 `Not logged in` 并返回退出码 `1`。

## 退出码

| 退出码 | 含义 |
| --- | --- |
| `0` | 命令成功 |
| `1` | 当前未登录 |
| `2` | 参数、网络、Gateway 或本地存储错误 |
| `3` | 登录被拒绝、取消、失败或过期 |

## 本地数据

session 默认保存在平台配置目录：

- macOS/Linux：`${XDG_CONFIG_HOME:-~/.config}/doubao-login-demo/`
- Windows：`%APPDATA%\\doubao-login-demo\\`

`session.json.enc` 使用 AES-256-GCM 加密，密钥保存在同目录的 `session.key`；POSIX 平台文件权限为 `0600`。执行 `auth logout` 会同时删除二者。

## 安全边界

- CLI 只调用 Gateway 的 `/api/cli/auth/**` contract v3；
- CLI 不需要也不接受飞书应用密钥；
- CLI 不输出 access token、Authorization header、Cookie、OAuth code 或 Gateway 原始响应；
- 正式 host 只接受 HTTPS，且必须仅包含 origin；
- Gateway 返回的浏览器验证地址必须同源，且路径位于 `/api/cli/auth/` 下。

## 开发与验证

```bash
npm test
npm pack --dry-run
```

豆包侧的逐项配置见 [`docs/doubao-connector.md`](docs/doubao-connector.md)。
