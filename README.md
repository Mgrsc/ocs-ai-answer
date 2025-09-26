# OCS AI Answer Service

代理 OpenAI 兼容的对话模型，用于[OCS 网课助手](https://docs.ocsjs.com)的题库。

## ✨ 核心特性

-   **Bun 原生 HTTP 服务**：性能优异，日志详细。
-   **固定 JSON 返回**：输出 `{"question":"...","answer":"..."}`，无需额外适配。
-   **部署便捷**：支持 Dockerfile、Docker Compose 部署，并自带 GitHub Actions 自动化构建与推送 GHCR 镜像。
-   **默认开启 CORS**：方便浏览器直接调用。

## 🚀 快速上手

### 📦 环境准备

1.  安装 [Bun](https://bun.sh/) ≥ 1.1。
2.  复制 `.env.example` 到 `.env`，并配置以下关键环境变量：
    -   `OPENAI_API_KEY` (必填): OpenAI 或兼容服务的密钥。
    -   `OPENAI_BASE_URL` (选填): 自建或代理网关地址。
    -   `OPENAI_MODEL` (选填): 可用模型，如 `gpt-4o-mini`。
    -   `SYSTEM_PROMPT` (选填): 用于约束模型输出 JSON 格式。
    -   `PORT` (选填): 服务端口，默认 `3000`。

### 🏃 本地运行

```bash
bun install
bun run index.ts
```

服务将监听 `http://localhost:3000`。向 `/answer` 发送 `{"question":"..."}` 的 POST 请求即可获取答案。

### 🐳 Docker Compose 部署

确保 `.env` 配置无误后，执行：

```bash
docker compose up -d
```

### 🔗 OCS 题库插件配置示例

将以下 JSON 配置加入你的 OCS 题库客户端，替换 `homepage` 和 `url` 中的 IP 为实际部署地址：

```json
[
  {
    "name": "OCS-AI-ANSWER",
    "homepage": "http://你的服务IP:3000/",
    "url": "http://你的服务IP:3000/answer",
    "method": "post",
    "type": "GM_xmlhttpRequest",
    "contentType": "json",
    "data": { "question": "${title}" },
    "headers": { "Content-Type": "application/json" },
    "handler": "return (res) => { if (res && res.question && res.answer) { return [res.question, res.answer]; } else if (res && res.error) { return ['AI题库错误: ' + res.error, undefined]; } return undefined; }"
  }
]
```

## 🛡️ 安全提示

-   确保 `.env` 文件和敏感日志未被提交到版本控制。
-   定期检查并轮换 API Key，防止滥用。
-   根据需求调整 `SYSTEM_PROMPT`，保持对模型输出的控制。

## 📄 开源许可

本项目采用 [MIT License](LICENSE)。欢迎使用、修改和分发。
