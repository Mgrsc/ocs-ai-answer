import { serve } from "bun";
import "dotenv/config";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_BASE_URL =
  process.env.OPENAI_BASE_URL || "https://api.openai.com/v1/chat/completions";
const SYSTEM_PROMPT =
  process.env.SYSTEM_PROMPT ||
  'Return exactly one JSON object with two string fields: "question" and "answer". Copy the user question exactly into "question". Put only the final answer into "answer". If the answer cannot be determined, set "answer" to "无法找到答案". For single-choice and judgement questions, answer with exactly one provided option. For multiple-choice questions, return all correct options joined by "#", preserving the original option text order from the user input. Do not output markdown, code fences, explanations, or extra keys.';
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const PORT = Number(process.env.PORT || 3000);
const DEBUG_REQUEST_DETAILS =
  process.env.DEBUG_REQUEST_DETAILS === "1" ||
  process.env.DEBUG_REQUEST_DETAILS === "true";
const NO_ANSWER = "无法找到答案";

if (!OPENAI_API_KEY) {
  console.error("OPENAI_API_KEY is not set.");
  process.exit(1);
}

if (!OPENAI_MODEL) {
  console.error("OPENAI_MODEL is not set.");
  process.exit(1);
}

type LogLevel = "INFO" | "WARN" | "ERROR";
type UpstreamMode = "json" | "fallback";

type RepairFlags = {
  bomRemoved: boolean;
  codeFenceStripped: boolean;
  outerJsonExtracted: boolean;
};

type AnswerRequestInput = {
  question: string;
  options?: string[];
  type?: string;
};

type ExtractedContent = {
  rawText?: string;
  finishReason?: string;
  contentType: "string" | "parts" | "text" | "missing";
};

type AttemptResult =
  | {
      ok: true;
      mode: UpstreamMode;
      payload: { question: string; answer: string };
      finishReason?: string;
      repairFlags: RepairFlags;
      rawPreview: string;
      status: number;
      durationMs: number;
    }
  | {
      ok: false;
      mode: UpstreamMode;
      category:
        | "transport_error"
        | "upstream_http_error"
        | "empty_content"
        | "invalid_json"
        | "invalid_payload";
      finishReason?: string;
      repairFlags?: RepairFlags;
      rawPreview?: string;
      status?: number;
      durationMs: number;
      details: string;
      shouldRetryFallback: boolean;
    };

console.log(
  JSON.stringify({
    level: "INFO",
    event: "server_start",
    timestamp: new Date().toISOString(),
    port: PORT,
    model: OPENAI_MODEL,
    baseUrl: OPENAI_BASE_URL,
    systemPromptLength: SYSTEM_PROMPT.length,
    debugRequestDetails: DEBUG_REQUEST_DETAILS,
  })
);

function getTimestamp() {
  return new Date().toISOString();
}

function log(level: LogLevel, event: string, details: Record<string, unknown> = {}) {
  console.log(
    JSON.stringify({
      level,
      event,
      timestamp: getTimestamp(),
      ...details,
    })
  );
}

function getCorsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS, PUT, DELETE",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With",
    "Access-Control-Max-Age": "86400",
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...getCorsHeaders(),
    },
  });
}

function createFallbackPayload(question: string) {
  return {
    question,
    answer: NO_ANSWER,
  };
}

function getClientIp(req: Request) {
  return (
    req.headers.get("x-forwarded-for") ||
    req.headers.get("x-real-ip") ||
    "Unknown"
  );
}

function previewText(value: string, maxLength = 160) {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength)}...`;
}

function summarizeValue(value: unknown) {
  if (typeof value === "string") {
    return {
      type: "string",
      length: value.length,
      preview: previewText(value, 240),
    };
  }

  if (Array.isArray(value)) {
    const joinedPreview = value
      .map((item) => (typeof item === "string" ? item : JSON.stringify(item)))
      .join(" | ");
    return {
      type: "array",
      length: value.length,
      preview: previewText(joinedPreview, 240),
    };
  }

  if (value && typeof value === "object") {
    return {
      type: "object",
      keys: Object.keys(value as Record<string, unknown>),
      preview: previewText(JSON.stringify(value), 240),
    };
  }

  return {
    type: value === null ? "null" : typeof value,
    preview: String(value),
  };
}

function normalizeOptions(value: unknown) {
  if (typeof value === "string") {
    return value
      .split(/\r?\n/)
      .map((item) => item.trim())
      .filter(Boolean);
  }

  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean);
  }

  return undefined;
}

function buildUpstreamQuestion(input: AnswerRequestInput) {
  const parts = [`Question: ${input.question}`];

  if (input.type) {
    parts.push(`Type: ${input.type}`);
  }

  if (input.options && input.options.length > 0) {
    parts.push(`Options:\n${input.options.join("\n")}`);
  }

  if (input.type === "multiple") {
    parts.push(
      [
        "This is a multiple-choice question.",
        'Return every correct option in the "answer" field.',
        'Join multiple correct options with "#" and do not use commas, spaces, or explanations.',
        'Use the original option text exactly as provided.',
      ].join(" ")
    );
  } else if (input.type === "single") {
    parts.push(
      [
        "This is a single-choice question.",
        'Return exactly one option in the "answer" field.',
        'Use the original option text exactly as provided.',
      ].join(" ")
    );
  } else if (input.type === "judgement") {
    parts.push(
      [
        "This is a judgement question.",
        'Return exactly one provided option in the "answer" field, usually one of 对 or 错.',
      ].join(" ")
    );
  } else if (input.type === "completion") {
    parts.push(
      'This is a completion question. Return only the missing content in the "answer" field.'
    );
  } else {
    parts.push('Return only the best direct answer in the "answer" field.');
  }

  return parts.join("\n\n");
}

function buildOpenAIRequestFromInput(input: AnswerRequestInput, mode: UpstreamMode) {
  const prompt = buildUpstreamQuestion(input);
  const body: Record<string, unknown> = {
    model: OPENAI_MODEL,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: prompt },
    ],
  };

  if (mode === "json") {
    body.response_format = { type: "json_object" };
  }

  return body;
}

function stripCodeFences(value: string) {
  const trimmed = value.trim();
  if (!trimmed.startsWith("```")) {
    return { text: trimmed, changed: false };
  }

  const match = trimmed.match(/^```[a-zA-Z0-9_-]*\s*([\s\S]*?)\s*```$/);
  if (!match) {
    return { text: trimmed, changed: false };
  }

  return { text: match[1].trim(), changed: true };
}

function extractFirstJsonObject(value: string) {
  const startIndex = value.indexOf("{");
  if (startIndex === -1) {
    return undefined;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = startIndex; index < value.length; index += 1) {
    const char = value[index];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (inString) {
      continue;
    }

    if (char === "{") {
      depth += 1;
      continue;
    }

    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return value.slice(startIndex, index + 1);
      }
    }
  }

  return undefined;
}

function sanitizeModelResponse(rawText: string) {
  const repairFlags: RepairFlags = {
    bomRemoved: false,
    codeFenceStripped: false,
    outerJsonExtracted: false,
  };

  let sanitized = rawText.trim();

  if (sanitized.charCodeAt(0) === 0xfeff) {
    sanitized = sanitized.slice(1);
    repairFlags.bomRemoved = true;
  }

  const fenceResult = stripCodeFences(sanitized);
  sanitized = fenceResult.text;
  repairFlags.codeFenceStripped = fenceResult.changed;

  const extractedJson = extractFirstJsonObject(sanitized);
  if (extractedJson && extractedJson !== sanitized) {
    sanitized = extractedJson.trim();
    repairFlags.outerJsonExtracted = true;
  }

  return {
    sanitized,
    repairFlags,
  };
}

function extractMessageText(content: unknown) {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return undefined;
  }

  const parts = content
    .map((part) => {
      if (typeof part === "string") {
        return part;
      }

      if (part && typeof part === "object") {
        const candidate = (part as Record<string, unknown>).text;
        if (typeof candidate === "string") {
          return candidate;
        }
      }

      return "";
    })
    .filter(Boolean);

  return parts.length > 0 ? parts.join("") : undefined;
}

function extractUpstreamContent(openaiData: any): ExtractedContent {
  const choice = openaiData?.choices?.[0];
  const messageContent = choice?.message?.content;

  if (typeof messageContent === "string") {
    return {
      rawText: messageContent,
      finishReason: choice?.finish_reason,
      contentType: "string",
    };
  }

  const partsText = extractMessageText(messageContent);
  if (partsText) {
    return {
      rawText: partsText,
      finishReason: choice?.finish_reason,
      contentType: "parts",
    };
  }

  if (typeof choice?.text === "string") {
    return {
      rawText: choice.text,
      finishReason: choice?.finish_reason,
      contentType: "text",
    };
  }

  return {
    finishReason: choice?.finish_reason,
    contentType: "missing",
  };
}

function parseAnswerPayload(rawText: string, originalQuestion: string) {
  const { sanitized, repairFlags } = sanitizeModelResponse(rawText);
  const parsed = JSON.parse(sanitized);

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("response is not a JSON object");
  }

  const response = parsed as Record<string, unknown>;
  const question =
    typeof response.question === "string" && response.question.trim().length > 0
      ? response.question.trim()
      : originalQuestion;
  const answer =
    typeof response.answer === "string" && response.answer.trim().length > 0
      ? response.answer.trim()
      : NO_ANSWER;

  return {
    payload: { question, answer },
    repairFlags,
  };
}

function shouldRetryWithoutJsonMode(status: number, bodyText: string) {
  if (status < 400 || status >= 500) {
    return false;
  }

  const normalized = bodyText.toLowerCase();
  return (
    normalized.includes("response_format") ||
    normalized.includes("json_object") ||
    normalized.includes("unsupported") ||
    normalized.includes("not support") ||
    normalized.includes("invalid parameter") ||
    normalized.includes("invalid_request_error")
  );
}

async function runUpstreamAttempt(
  input: AnswerRequestInput,
  requestId: string,
  mode: UpstreamMode
): Promise<AttemptResult> {
  const body = buildOpenAIRequestFromInput(input, mode);
  const startedAt = Date.now();

  log("INFO", "upstream_request_started", {
    requestId,
    mode,
    model: OPENAI_MODEL,
    questionLength: input.question.length,
    questionPreview: previewText(input.question, 120),
    hasOptions: Boolean(input.options && input.options.length > 0),
    optionsCount: input.options?.length || 0,
    questionType: input.type || null,
  });

  let response: Response;

  try {
    response = await fetch(OPENAI_BASE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify(body),
    });
  } catch (error: any) {
    const durationMs = Date.now() - startedAt;
    return {
      ok: false,
      mode,
      category: "transport_error",
      durationMs,
      details: error?.message || "upstream transport error",
      shouldRetryFallback: false,
    };
  }

  const durationMs = Date.now() - startedAt;
  const responseText = await response.text();

  log("INFO", "upstream_response_received", {
    requestId,
    mode,
    status: response.status,
    durationMs,
    bodyLength: responseText.length,
  });

  if (!response.ok) {
    return {
      ok: false,
      mode,
      category: "upstream_http_error",
      status: response.status,
      durationMs,
      details: previewText(responseText, 240),
      shouldRetryFallback:
        mode === "json" && shouldRetryWithoutJsonMode(response.status, responseText),
      rawPreview: previewText(responseText, 240),
    };
  }

  let openaiData: any;

  try {
    openaiData = JSON.parse(responseText);
  } catch (error: any) {
    return {
      ok: false,
      mode,
      category: "invalid_json",
      status: response.status,
      durationMs,
      details: `upstream payload is not valid JSON: ${error?.message || "unknown error"}`,
      shouldRetryFallback: mode === "json",
      rawPreview: previewText(responseText, 240),
    };
  }

  const extracted = extractUpstreamContent(openaiData);

  log("INFO", "upstream_content_extracted", {
    requestId,
    mode,
    finishReason: extracted.finishReason || "unknown",
    contentType: extracted.contentType,
    usage: openaiData?.usage,
  });

  if (!extracted.rawText) {
    return {
      ok: false,
      mode,
      category: "empty_content",
      finishReason: extracted.finishReason,
      status: response.status,
      durationMs,
      details: "upstream returned no text content",
      shouldRetryFallback: mode === "json",
    };
  }

  try {
    const { payload, repairFlags } = parseAnswerPayload(extracted.rawText, input.question);
    return {
      ok: true,
      mode,
      payload,
      finishReason: extracted.finishReason,
      repairFlags,
      rawPreview: previewText(extracted.rawText, 240),
      status: response.status,
      durationMs,
    };
  } catch (error: any) {
    return {
      ok: false,
      mode,
      category: "invalid_payload",
      finishReason: extracted.finishReason,
      repairFlags: sanitizeModelResponse(extracted.rawText).repairFlags,
      rawPreview: previewText(extracted.rawText, 240),
      status: response.status,
      durationMs,
      details: error?.message || "failed to parse model response",
      shouldRetryFallback: mode === "json",
    };
  }
}

async function getAnswerFromUpstream(input: AnswerRequestInput, requestId: string) {
  const firstAttempt = await runUpstreamAttempt(input, requestId, "json");

  if (firstAttempt.ok) {
    return {
      payload: firstAttempt.payload,
      mode: firstAttempt.mode,
      degraded: false,
    };
  }

  log("WARN", "upstream_attempt_failed", {
    requestId,
    mode: firstAttempt.mode,
    category: firstAttempt.category,
    finishReason: firstAttempt.finishReason || "unknown",
    status: firstAttempt.status || null,
    durationMs: firstAttempt.durationMs,
    rawPreview: firstAttempt.rawPreview || null,
    repairFlags: firstAttempt.repairFlags || null,
    details: firstAttempt.details,
    retryingFallback: firstAttempt.shouldRetryFallback,
  });

  if (firstAttempt.shouldRetryFallback) {
    const secondAttempt = await runUpstreamAttempt(input, requestId, "fallback");

    if (secondAttempt.ok) {
      return {
        payload: secondAttempt.payload,
        mode: secondAttempt.mode,
        degraded: false,
      };
    }

    log("ERROR", "upstream_attempt_failed", {
      requestId,
      mode: secondAttempt.mode,
      category: secondAttempt.category,
      finishReason: secondAttempt.finishReason || "unknown",
      status: secondAttempt.status || null,
      durationMs: secondAttempt.durationMs,
      rawPreview: secondAttempt.rawPreview || null,
      repairFlags: secondAttempt.repairFlags || null,
      details: secondAttempt.details,
      retryingFallback: false,
    });
  }

  return {
    payload: createFallbackPayload(input.question),
    mode: "fallback" as UpstreamMode,
    degraded: true,
  };
}

serve({
  hostname: "0.0.0.0",
  port: PORT,
  async fetch(req: Request) {
    const url = new URL(req.url);
    const requestId = crypto.randomUUID();
    const clientIp = getClientIp(req);

    log("INFO", "request_received", {
      requestId,
      method: req.method,
      path: url.pathname,
      clientIp,
      userAgent: previewText(req.headers.get("User-Agent") || "Unknown", 120),
    });

    if (req.method === "OPTIONS") {
      return new Response(null, {
        status: 200,
        headers: getCorsHeaders(),
      });
    }

    if (url.pathname === "/" && (req.method === "GET" || req.method === "HEAD")) {
      const responseData = {
        message: "OCS AI Answer service is running.",
        version: "1.1.0",
        endpoints: ["/answer"],
        status: "running",
        modelInUse: OPENAI_MODEL,
      };

      return new Response(req.method === "HEAD" ? null : JSON.stringify(responseData), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          ...getCorsHeaders(),
        },
      });
    }

    if (url.pathname !== "/answer" || req.method !== "POST") {
      return jsonResponse(
        {
          message: "API path not found",
          availablePaths: ["/", "/answer"],
          method: req.method,
          path: url.pathname,
        },
        404
      );
    }

    let requestBody = "";

    try {
      requestBody = await req.text();
    } catch (error: any) {
      log("ERROR", "request_body_read_failed", {
        requestId,
        details: error?.message || "failed to read body",
      });
      return jsonResponse({ error: "无法读取请求体" }, 400);
    }

    let questionData: any;

    try {
      questionData = JSON.parse(requestBody);
    } catch (error: any) {
      log("WARN", "request_body_invalid_json", {
        requestId,
        bodyPreview: previewText(requestBody, 240),
        details: error?.message || "invalid JSON body",
      });
      return jsonResponse({ error: "JSON 格式错误" }, 400);
    }

    const receivedKeys =
      questionData && typeof questionData === "object" ? Object.keys(questionData) : [];
    const optionsValue =
      questionData && typeof questionData === "object"
        ? (questionData as Record<string, unknown>).options
        : undefined;
    const typeValue =
      questionData && typeof questionData === "object"
        ? (questionData as Record<string, unknown>).type
        : undefined;
    const options = normalizeOptions(optionsValue);
    const questionType =
      typeof typeValue === "string" && typeValue.trim().length > 0
        ? typeValue.trim()
        : undefined;

    const question =
      typeof questionData?.question === "string" ? questionData.question.trim() : "";

    if (!question) {
      log("WARN", "request_question_missing", {
        requestId,
        receivedKeys,
        requestSummary: DEBUG_REQUEST_DETAILS
          ? {
              question: summarizeValue(
                questionData && typeof questionData === "object"
                  ? (questionData as Record<string, unknown>).question
                  : undefined
              ),
              options: summarizeValue(optionsValue),
              type: summarizeValue(typeValue),
              bodyPreview: previewText(requestBody, 400),
            }
          : undefined,
      });
      return jsonResponse({ error: "缺少 'question' 字段" }, 400);
    }

    log("INFO", "answer_request_validated", {
      requestId,
      receivedKeys,
      questionLength: question.length,
      questionPreview: previewText(question, 120),
      hasOptions: optionsValue !== undefined && optionsValue !== null,
      optionsSummary:
        optionsValue !== undefined ? summarizeValue(optionsValue) : undefined,
      typeSummary: typeValue !== undefined ? summarizeValue(typeValue) : undefined,
      requestBodyPreview: DEBUG_REQUEST_DETAILS ? previewText(requestBody, 400) : undefined,
    });

    try {
      const result = await getAnswerFromUpstream(
        {
          question,
          options,
          type: questionType,
        },
        requestId
      );

      log(result.degraded ? "WARN" : "INFO", "answer_response_ready", {
        requestId,
        mode: result.mode,
        degraded: result.degraded,
        answerPreview: previewText(result.payload.answer, 120),
      });

      return jsonResponse(result.payload, 200);
    } catch (error: any) {
      log("ERROR", "answer_request_failed", {
        requestId,
        details: error?.message || "unexpected internal error",
      });
      return jsonResponse(createFallbackPayload(question), 200);
    }
  },
});
