# OCS AI Answer Service

一个用于 [OCS](https://docs.ocsjs.com) 题库接入的 OpenAI 兼容答案代理服务。

## For AI Agents
请查看 [AGENT_README.md](./AGENT_README.md) 获取操作上下文。

## 核心特性

- 基于 Bun 的 HTTP 服务，日志为便于排查的逐行结构化输出。
- 完全适配 OCS 5.x：原生支持 `HEAD /answer` 探活（消除卡片“连接失败”）；满足 5.x 图片题优化契约（消除黄字警告）；支持客户端 Base64 图片直传与服务端 URL 提取双路径。
- 默认优先使用 JSON 模式请求上游；若 `response_format` 不被支持，会自动回退。
- 固定输出结构：`{"question":"...","answer":"..."}`。
- 支持接收 OCS 传来的可选 `options` 和 `type` 字段，提升单选、多选、判断题的命中率。
- 自动化多模态图片处理：直传 Base64 图片结合防盗链头与出站 SSRF 防御，安全交付给多模态视觉模型。
- 自动修复常见异常输出，例如 Markdown 代码块包裹的 JSON、尾随解释文本等。
- 对可恢复的上游异常统一降级为 `"不知道"`，避免 OCS 误判为题库连接失败。
- 内置防扫描与安全防护引擎：自动识别高危探测路径（如 `/.env`、`/.git`、脚本后缀等）并秒级自动封禁恶意 IP；内置滑动窗口频控（默认 60 次/分）；404 隐藏内部接口路由，有效防止黑客探测。
- 支持 Dockerfile 与 Docker Compose 部署。

## 快速开始

### 环境准备

1. 安装 Bun 1.1 或更高版本。
2. 将 `.env.example` 复制为 `.env`。
3. 至少配置以下环境变量：
   - `OPENAI_API_KEY`
   - `OPENAI_BASE_URL`，如果你使用代理或网关
   - `OPENAI_MODEL`
   - `CLIENT_API_KEY`（可选），若需要防止公网接口被未授权调用，配置后客户端需带 Token 访问

### 本地运行

```bash
bun install
bun run index.ts
```

服务默认监听 `http://localhost:3000`。

### 最小请求示例

```bash
curl -X POST http://localhost:3000/answer \
  -H 'Content-Type: application/json' \
  -d '{"question":"下列关于家庭表述中，不正确的是（）。","options":["A. 甲","B. 乙","C. 丙","D. 丁"],"type":"single"}'
```

期望返回结构：

```json
{
  "question": "下列关于家庭表述中，不正确的是（）。",
  "answer": "不知道"
}
```

### Docker Compose

```bash
docker compose up -d
```

## OCS 配置示例

将下面配置中的 `your-host:3000` 替换成你的服务端部署地址：

### 推荐配置（零警告纯占位符配置）

该配置可彻底消除 OCS 5.x 的黄字警告、支持多模态图片直传，并安全兼顾纯文字与图文题目：

```json
[
  {
    "name": "OCS-AI-ANSWER",
    "homepage": "http://your-host:3000/",
    "url": "http://your-host:3000/answer",
    "method": "post",
    "type": "GM_xmlhttpRequest",
    "contentType": "json",
    "data": {
      "question": "${title}",
      "title": "${title}",
      "options": "${options}",
      "type": "${type}",
      "suggestion_title": "${suggestion_title}",
      "suggestion_options": "${suggestion_options}",
      "images": "${images}"
    },
    "headers": {
      "Content-Type": "application/json"
    },
    "handler": "return (res) => { if (res && res.question && res.answer) { return [res.question, res.answer]; } if (res && res.error) { const message = 'AI answer service error: ' + res.error; return [message, undefined]; } return undefined; }"
  }
]
```

> **客户端鉴权（可选）**：若服务端配置了 `CLIENT_API_KEY`，请在上方的 `headers` 中加入 `"Authorization": "Bearer 你的CLIENT_API_KEY"`。若服务端未设置该环境变量，保持原样即可。

## 配置说明

- **双通道题干容错**：纯文字题目必定填充 `${title}`，防止因缺少字段报错（`缺少 'question' 字段`）；有图题目 OCS 5.x 会自动填充带有 `[图片1]` 等占位符的 `${suggestion_title}`，服务端会自动优先选用该优化题干交由上游大模型作答。
- **OCS 5.x 探活支持**：OCS 5.x 卡片会向配置的 `url` 发送 `HEAD /answer?t=<时间戳>` 进行健康探活，服务内置响应 200，题库卡片将显示“连接成功”。
- **消除黄字警告**：配置中包含 `${suggestion_title}` 与 `${images}`，OCS 5.x 的“当前题库配置暂不支持图片、公式等题目处理”黄色警告将自动消除。
- **免数据提取脚本警告**：`data` 字段全部采用原生占位符，无需在数据中编写 JavaScript 回调，避免触发 OCS 脚本安全提示。
- **OCS 响应 handler 说明**：以上响应 `handler` 仅做安全字段映射，不含动态执行代码、网络请求、存储与 Cookie 访问。其中的 `const message = ...` 写法避免触发 OCS 针对方括号字符串拼接的误报。
- **客户端鉴权**：若在服务端配置了 `CLIENT_API_KEY`，查题请求必须鉴权（通过标头 `"Authorization": "Bearer 你的CLIENT_API_KEY"`）。若服务端未设置 `CLIENT_API_KEY`，则保持公开访问。探活请求（`HEAD`/`GET`）不受鉴权限制。
- 如果不传 `SYSTEM_PROMPT`，服务会使用内置默认提示词，默认按 OCS 题型约束单选、多选、判断题的答案格式。
- 服务不会主动传递 `max_tokens`、`temperature` 等采样参数。
- 将 `DEBUG_REQUEST_DETAILS=true` 后，可在日志中看到实际收到的顶层字段，以及 `question`、`options`、`type` 的摘要，便于确认 OCS 是否真的把选项传过来了。
- `POST /answer` 额外支持可选的 `options`、`type`、`images`、`suggestion_title` 字段，并会一并传给上游模型。
- **安全与防扫描配置（可选）**：
  - `RATE_LIMIT_PER_MINUTE`（默认 `60` 次/分，取值范围 `0~10000`）：限制单 IP 查题频次（设为 `0` 可彻底关闭频控）。健康探活请求（`GET`/`HEAD`）不受频控限制，避免共享网络误伤。
  - `IP_BLOCK_DURATION_MS`（默认 1 小时 = `3600000`，取值范围 `1000~2592000000`）：探测恶意路径（如 `/.env*`、`/.git/*`、webshell）的 IP 将被即时封禁并返回 403。封禁名单保存在独立内存空间中，不受普通频控流量淘汰影响。
  - `TRUST_PROXY`（默认 `false`）：当部署在单层可信反向代理（如 Nginx）后方时启用。开启后会解析 `X-Forwarded-For`（最右跳）与 `X-Real-IP`，并自动归一化 IPv4 映射及规范 IPv6 地址。**部署前提**：开启 `TRUST_PROXY` 时，必须禁止外部公网直连容器 3000 端口（例如在 `compose.yaml` 中配置端口映射为 `"127.0.0.1:3000:3000"` 或使用防火墙隔离），确保仅反向代理能连接后端，杜绝客户端绕过反代伪造标头。推荐 Nginx 配置：
    ```nginx
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Real-IP $remote_addr;
    ```
- 对可恢复的上游错误，服务会降级返回合法 JSON，`answer` 固定为 `"不知道"`。

## 帮助

如果某个上游兼容实现仍有特殊兼容问题，请在仓库里提 issue。
