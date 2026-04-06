# OCS AI Answer Service

An OpenAI-compatible answer proxy for [OCS](https://docs.ocsjs.com) question-bank integration.

## For AI Agents
See [AGENT_README.md](./AGENT_README.md) for operational context.

## Core Features

- Bun-native HTTP service with line-oriented structured logs.
- JSON-first upstream requests with automatic fallback when `response_format` is unsupported.
- Stable output contract: `{"question":"...","answer":"..."}`.
- Optional `options` and `type` request fields can be forwarded from OCS to improve single-choice, multiple-choice, and judgement accuracy.
- Response repair for common malformed outputs such as fenced JSON and trailing prose.
- Graceful degradation to `"无法找到答案"` instead of surfacing opaque upstream formatting failures to OCS.
- Dockerfile and Docker Compose deployment support.

## Quickstart

### Prerequisites

1. Install Bun 1.1 or later.
2. Copy `.env.example` to `.env`.
3. Set at least:
   - `OPENAI_API_KEY`
   - `OPENAI_BASE_URL` if you use a proxy or gateway
   - `OPENAI_MODEL`

### Run locally

```bash
bun install
bun run index.ts
```

The service listens on `http://localhost:3000`.

### Minimal request

```bash
curl -X POST http://localhost:3000/answer \
  -H 'Content-Type: application/json' \
  -d '{"question":"下列关于家庭表述中，不正确的是（）。","options":["A. 甲","B. 乙","C. 丙","D. 丁"],"type":"single"}'
```

Expected shape:

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

## OCS Configuration Example

Replace the host in `homepage` and `url` with your deployment address:

```json
[
  {
    "name": "OCS-AI-ANSWER",
    "homepage": "http://your-host:3000/",
    "url": "http://your-host:3000/answer",
    "method": "post",
    "type": "GM_xmlhttpRequest",
    "contentType": "json",
    "data": { "question": "${title}", "options": "${options}", "type": "${type}" },
    "headers": { "Content-Type": "application/json" },
    "handler": "return (res) => { if (res && res.question && res.answer) { return [res.question, res.answer]; } if (res && res.error) { return ['AI answer service error: ' + res.error, undefined]; } return undefined; }"
  }
]
```

## Configuration Notes

- `SYSTEM_PROMPT` should stay short and contract-focused.
- The service does not send `max_tokens`, `temperature`, or similar sampling controls.
- Set `DEBUG_REQUEST_DETAILS=true` to log incoming request keys plus summarized `question`, `options`, and `type` values when checking what OCS actually sent.
- `POST /answer` accepts optional `options` and `type` fields and injects them into the upstream prompt.
- Recoverable upstream failures degrade to a valid answer payload with `"无法找到答案"`.

## Help

Open an issue in the repository if you need a new compatibility path for a specific upstream provider.
