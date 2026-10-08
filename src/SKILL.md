---
name: doubao-cli-tools
description: 通过 doubao-cli-demo 检查登录状态并查询当前飞书身份。用户询问“我是谁”“当前登录账号”“当前飞书用户”“open_id/openId”“union_id/unionId”，或要求验证 CLI Connector 登录与 whoami 链路时使用。仅处理身份查询，不处理通讯录、消息、文档或其他业务能力。
---

# 豆包 CLI 身份工具

## 约束
- 仅使用 `auth status`、`auth login`、`whoami --json`；只有用户明确要求退出时才执行 `auth logout`。
- 不索取、展示或转发 App Secret、飞书 token、后端 sessionToken、登录 session ID、Cookie 或原始认证响应。
- `auth status` 只检查本地会话，最终身份以实时 `whoami --json` 为准。

## 执行流程
1. 执行 `doubao-cli-demo auth status`。
2. 已登录则执行 `doubao-cli-demo whoami --json`。
3. 未登录则执行 `doubao-cli-demo auth login`，等待用户完成飞书授权，再次检查状态并调用 `whoami --json`。
4. 只解析 `name`、`openId`、`unionId`，技术标识默认脱敏。
5. `whoami` 返回未登录时重新登录，不用本地缓存冒充实时结果。

## 错误处理
- `BACKEND_UNREACHABLE`：检查后端服务与 `DOUBAO_CLI_DEMO_BACKEND_URL`。
- 授权拒绝、取消或超时：如实告知，不自动反复发起登录。
- 本地会话损坏：执行 `auth logout` 清理后重新登录。
- 其他错误只返回稳定摘要，不输出堆栈、授权码或上游原始响应。