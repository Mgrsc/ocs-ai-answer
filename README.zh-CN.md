# OCS AI Answer Service

一个用于 [OCS](https://docs.ocsjs.com) 题库接入的 OpenAI 兼容答案代理服务。

## For AI Agents
请查看 [AGENT_README.md](./AGENT_README.md) 获取操作上下文。

## 核心特性

- 基于 Bun 的 HTTP 服务，日志为便于排查的逐行结构化输出。
- 默认优先使用 JSON 模式请求上游；若 `response_format` 不被支持，会自动回退。
- 固定输出结构：`{"question":"...","answer":"..."}`。
- 自动修复常见异常输出，例如 Markdown 代码块包裹的 JSON、尾随解释文本等。
- 对可恢复的上游异常统一降级为 `"无法找到答案"`，避免 OCS 误判为题库连接失败。
- 支持 Dockerfile 与 Docker Compose 部署。

## 快速开始

### 环境准备

1. 安装 Bun 1.1 或更高版本。
2. 将 `.env.example` 复制为 `.env`。
3. 至少配置以下环境变量：
   - `OPENAI_API_KEY`
   - `OPENAI_BASE_URL`，如果你使用代理或网关
   - `OPENAI_MODEL`

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
  -d '{"question":"下列关于家庭表述中，不正确的是（）。"}'
```

期望返回结构：

```json
{
  "question": "下列关于家庭表述中，不正确的是（）。",
  "answer": "无法找到答案"
}
```

### Docker Compose

```bash
docker compose up -d
```

## OCS 配置示例

将下面配置中的 `homepage` 和 `url` 替换成你的部署地址：

```json
[
  {
    "name": "OCS-AI-ANSWER",
    "homepage": "http://your-host:3000/",
    "url": "http://your-host:3000/answer",
    "method": "post",
    "type": "GM_xmlhttpRequest",
    "contentType": "json",
    "data": { "question": "${title}" },
    "headers": { "Content-Type": "application/json" },
    "handler": "return (res) => { if (res && res.question && res.answer) { return [res.question, res.answer]; } if (res && res.error) { return ['AI answer service error: ' + res.error, undefined]; } return undefined; }"
  }
]
```

## 配置说明

- `SYSTEM_PROMPT` 应保持短小，只表达输出契约。
- 服务不会主动传递 `max_tokens`、`temperature` 等采样参数。
- 对可恢复的上游错误，服务会降级返回合法 JSON，`answer` 固定为 `"无法找到答案"`。

## 帮助

如果某个上游兼容实现仍有特殊兼容问题，请在仓库里提 issue。
