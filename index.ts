import { serve } from "bun";
import "dotenv/config";
import dns from "node:dns/promises";
import net from "node:net";
import packageJson from "./package.json";

const SERVICE_VERSION = packageJson.version || "1.2.0";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_BASE_URL =
  process.env.OPENAI_BASE_URL || "https://api.openai.com/v1/chat/completions";
const NO_ANSWER = process.env.NO_ANSWER || "不知道";
const SYSTEM_PROMPT =
  process.env.SYSTEM_PROMPT ||
  `Return exactly one JSON object with two string fields: "question" and "answer". Copy the user question exactly into "question". Put only the final answer into "answer". If the answer cannot be determined, set "answer" to "${NO_ANSWER}". For single-choice and judgement questions, answer with exactly one provided option. For multiple-choice questions, return all correct options joined by "#", preserving the original option text order from the user input. Do not output markdown, code fences, explanations, or extra keys.`;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const PORT = Number(process.env.PORT || 3000);
const DEBUG_REQUEST_DETAILS =
  process.env.DEBUG_REQUEST_DETAILS === "1" ||
  process.env.DEBUG_REQUEST_DETAILS === "true";
const MAX_CLIENT_REQUEST_BODY_BYTES = 16 * 1024 * 1024;
const SERVER_HARD_REQUEST_BODY_LIMIT_BYTES = MAX_CLIENT_REQUEST_BODY_BYTES * 2;
const UPSTREAM_TIMEOUT_MS = 60000;
const IMAGE_DOWNLOAD_TIMEOUT_MS = 10000;
const MAX_IMAGES_PER_REQUEST = 4;
const MAX_SINGLE_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_REDIRECT_HOPS = 3;
const CHAOXING_REFERER = "https://mooc1.chaoxing.com/";
const DEFAULT_IMAGE_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const IMAGE_URL_REGEX =
  /https?:\/\/[^\s"'<>()\[\]]+\.(?:png|jpg|jpeg|gif|webp|bmp|svg)(?:\?[^\s"'<>()\[\]]*)?/gi;
const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);
const ALLOWED_PORTS = new Set([80, 443, 8080, 8443]);
const ALLOWED_IMAGE_HOSTS_RAW = process.env.ALLOWED_IMAGE_HOSTS;
const ALLOWED_IMAGE_HOSTS = ALLOWED_IMAGE_HOSTS_RAW
  ? ALLOWED_IMAGE_HOSTS_RAW.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean)
  : undefined;

if (import.meta.main) {
  if (!OPENAI_API_KEY) {
    console.error("OPENAI_API_KEY is not set.");
    process.exit(1);
  }

  if (!OPENAI_MODEL) {
    console.error("OPENAI_MODEL is not set.");
    process.exit(1);
  }

  console.log(
    JSON.stringify({
      level: "INFO",
      event: "server_start",
      timestamp: new Date().toISOString(),
      port: PORT,
      model: OPENAI_MODEL,
      baseUrl: OPENAI_BASE_URL,
      noAnswerText: NO_ANSWER,
      systemPromptLength: SYSTEM_PROMPT.length,
      debugRequestDetails: DEBUG_REQUEST_DETAILS,
    })
  );
}

type LogLevel = "INFO" | "WARN" | "ERROR";
type UpstreamMode = "json" | "fallback";

type RepairFlags = {
  bomRemoved: boolean;
  codeFenceStripped: boolean;
  outerJsonExtracted: boolean;
};

type NormalizedDirectImagesResult = {
  valid: string[];
  receivedCount: number;
  invalidCount: number;
  countExceededCount: number;
  singleSizeExceededCount: number;
  budgetExceededCount: number;
  totalBytes: number;
};

type AnswerRequestInput = {
  question: string;
  options?: string[];
  type?: string;
  suggestionTitle?: string;
  suggestionOptions?: string[];
  directImages?: string[];
  directImagesMeta?: NormalizedDirectImagesResult;
};

type MessageContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

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
      fullErrorText?: string;
      shouldRetryFallback: boolean;
    };

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

function resolvePromptSources(input: AnswerRequestInput) {
  const promptQuestion = input.suggestionTitle || input.question;
  const promptOptions =
    input.suggestionOptions && input.suggestionOptions.length > 0
      ? input.suggestionOptions
      : input.options;
  return { promptQuestion, promptOptions };
}

function buildUpstreamQuestion(input: AnswerRequestInput) {
  const { promptQuestion, promptOptions } = resolvePromptSources(input);

  const parts = [`Question: ${promptQuestion}`];

  if (input.type) {
    parts.push(`Type: ${input.type}`);
  }

  if (promptOptions && promptOptions.length > 0) {
    parts.push(`Options:\n${promptOptions.join("\n")}`);
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

function extractImageUrls(text: string): string[] {
  const matches = text.match(IMAGE_URL_REGEX);
  if (!matches) {
    return [];
  }
  const cleaned = matches.map((item) => item.replace(/[;,.)"'<>\[\]]+$/, ""));
  return Array.from(new Set(cleaned));
}

function collectImageUrlsFromInput(input: AnswerRequestInput): string[] {
  const sources = [input.question];
  if (input.suggestionTitle) {
    sources.push(input.suggestionTitle);
  }
  if (input.options && input.options.length > 0) {
    sources.push(...input.options);
  }
  if (input.suggestionOptions && input.suggestionOptions.length > 0) {
    sources.push(...input.suggestionOptions);
  }
  const collected: string[] = [];
  for (const source of sources) {
    collected.push(...extractImageUrls(source));
  }
  return Array.from(new Set(collected));
}

function normalizeDirectImages(rawImages: unknown): NormalizedDirectImagesResult {
  if (!Array.isArray(rawImages)) {
    return {
      valid: [],
      receivedCount: 0,
      invalidCount: 0,
      countExceededCount: 0,
      singleSizeExceededCount: 0,
      budgetExceededCount: 0,
      totalBytes: 0,
    };
  }

  const valid: string[] = [];
  let invalidCount = 0;
  let countExceededCount = 0;
  let singleSizeExceededCount = 0;
  let budgetExceededCount = 0;
  let totalBytes = 0;

  for (const item of rawImages) {
    if (typeof item !== "string") {
      invalidCount += 1;
      continue;
    }
    const trimmed = item.trim();
    if (!trimmed.startsWith("data:image/") || !trimmed.includes(";base64,")) {
      invalidCount += 1;
      continue;
    }
    if (valid.length >= MAX_IMAGES_PER_REQUEST) {
      countExceededCount += 1;
      continue;
    }
    const base64Part = trimmed.split(";base64,")[1] || "";
    if (base64Part.length === 0) {
      invalidCount += 1;
      continue;
    }
    const estimatedBytes = Math.ceil((base64Part.length * 3) / 4);
    if (estimatedBytes > MAX_SINGLE_IMAGE_BYTES) {
      singleSizeExceededCount += 1;
      continue;
    }
    if (totalBytes + estimatedBytes > MAX_TOTAL_IMAGE_BYTES) {
      budgetExceededCount += 1;
      continue;
    }
    totalBytes += estimatedBytes;
    valid.push(trimmed);
  }

  return {
    valid,
    receivedCount: rawImages.length,
    invalidCount,
    countExceededCount,
    singleSizeExceededCount,
    budgetExceededCount,
    totalBytes,
  };
}

function getImageHeaders(url: string): Record<string, string> {
  const headers: Record<string, string> = {
    "User-Agent": DEFAULT_IMAGE_USER_AGENT,
    Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
  };
  if (url.includes("chaoxing.com")) {
    headers.Referer = CHAOXING_REFERER;
  }
  return headers;
}

function resolveMimeType(contentType: string): string {
  return contentType.split(";")[0].trim().toLowerCase();
}

function parseIPv6Words(ip: string): number[] | null {
  const cleanIp = ip.toLowerCase().replace(/^\[|\]$/g, "").trim();
  const embeddedIpv4Match = cleanIp.match(/^(.*):(\d+\.\d+\.\d+\.\d+)$/);

  let hexPart = cleanIp;
  let embeddedWords: number[] = [];

  if (embeddedIpv4Match) {
    let prefix = embeddedIpv4Match[1];
    if (prefix.endsWith(":")) {
      prefix += ":";
    }
    hexPart = prefix;

    const ipv4Parts = embeddedIpv4Match[2].split(".").map(Number);
    if (
      ipv4Parts.length !== 4 ||
      ipv4Parts.some((b) => isNaN(b) || b < 0 || b > 255)
    ) {
      return null;
    }
    embeddedWords = [
      (ipv4Parts[0] << 8) | ipv4Parts[1],
      (ipv4Parts[2] << 8) | ipv4Parts[3],
    ];
  }

  const expectedWords = 8 - embeddedWords.length;
  const halves = hexPart.split("::");
  if (halves.length > 2) return null;

  const parseHalf = (str: string): number[] => {
    if (!str) return [];
    return str.split(":").map((h) => {
      if (!/^[0-9a-f]{1,4}$/i.test(h)) return NaN;
      return parseInt(h, 16);
    });
  };

  const left = parseHalf(halves[0]);
  const right = halves.length === 2 ? parseHalf(halves[1]) : [];
  if (left.some(isNaN) || right.some(isNaN)) return null;

  if (halves.length === 1) {
    if (left.length !== expectedWords) return null;
    return [...left, ...embeddedWords];
  }

  const missing = expectedWords - (left.length + right.length);
  if (missing < 0) return null;
  return [...left, ...Array(missing).fill(0), ...right, ...embeddedWords];
}

function isPrivateOrReservedIPv4Bytes(
  b0: number,
  b1: number,
  b2: number,
  b3: number
): boolean {
  if (b0 === 0) return true;
  if (b0 === 10) return true;
  if (b0 === 100 && b1 >= 64 && b1 <= 127) return true;
  if (b0 === 127) return true;
  if (b0 === 169 && b1 === 254) return true;
  if (b0 === 172 && b1 >= 16 && b1 <= 31) return true;
  if (b0 === 192 && b1 === 0 && b2 === 0) return true;
  if (b0 === 192 && b1 === 0 && b2 === 2) return true;
  if (b0 === 192 && b1 === 168) return true;
  if (b0 === 198 && (b1 === 18 || b1 === 19)) return true;
  if (b0 === 198 && b1 === 51 && b2 === 100) return true;
  if (b0 === 203 && b1 === 0 && b2 === 113) return true;
  if (b0 >= 224) return true;
  return false;
}

function isPrivateOrReservedIp(ip: string): boolean {
  const cleanIp = ip.replace(/^\[|\]$/g, "").trim();

  const ipv4Parts = cleanIp.split(".").map(Number);
  if (
    ipv4Parts.length === 4 &&
    ipv4Parts.every((b) => !isNaN(b) && b >= 0 && b <= 255)
  ) {
    return isPrivateOrReservedIPv4Bytes(
      ipv4Parts[0],
      ipv4Parts[1],
      ipv4Parts[2],
      ipv4Parts[3]
    );
  }

  const words = parseIPv6Words(cleanIp);
  if (!words) {
    return true;
  }

  if (words.every((w) => w === 0)) return true;
  if (words.slice(0, 7).every((w) => w === 0) && words[7] === 1) return true;

  if (words.slice(0, 6).every((w) => w === 0)) {
    const b0 = (words[6] >> 8) & 0xff;
    const b1 = words[6] & 0xff;
    const b2 = (words[7] >> 8) & 0xff;
    const b3 = words[7] & 0xff;
    return isPrivateOrReservedIPv4Bytes(b0, b1, b2, b3);
  }

  if (words.slice(0, 5).every((w) => w === 0) && words[5] === 0xffff) {
    const b0 = (words[6] >> 8) & 0xff;
    const b1 = words[6] & 0xff;
    const b2 = (words[7] >> 8) & 0xff;
    const b3 = words[7] & 0xff;
    return isPrivateOrReservedIPv4Bytes(b0, b1, b2, b3);
  }

  if (words[0] === 0x2002) {
    const b0 = (words[1] >> 8) & 0xff;
    const b1 = words[1] & 0xff;
    const b2 = (words[2] >> 8) & 0xff;
    const b3 = words[2] & 0xff;
    return isPrivateOrReservedIPv4Bytes(b0, b1, b2, b3);
  }

  if (words[0] === 0x2001 && words[1] === 0) {
    return true;
  }

  if ((words[0] & 0xfe00) === 0xfc00) return true;
  if ((words[0] & 0xffc0) === 0xfe80) return true;
  if ((words[0] & 0xff00) === 0xff00) return true;
  if (words[0] === 0x2001 && words[1] === 0x0db8) return true;

  if (
    words[0] === 0x0064 &&
    words[1] === 0xff9b &&
    words.slice(2, 6).every((w) => w === 0)
  ) {
    const b0 = (words[6] >> 8) & 0xff;
    const b1 = words[6] & 0xff;
    const b2 = (words[7] >> 8) & 0xff;
    const b3 = words[7] & 0xff;
    return isPrivateOrReservedIPv4Bytes(b0, b1, b2, b3);
  }

  if (words[0] === 0x0100 && words.slice(1, 4).every((w) => w === 0)) return true;

  return false;
}

function matchesAllowedHost(hostname: string, pattern: string): boolean {
  if (pattern === "*") return true;
  if (pattern.startsWith("*.")) {
    const domainSuffix = pattern.slice(2);
    return hostname === domainSuffix || hostname.endsWith(`.${domainSuffix}`);
  }
  return hostname === pattern;
}

async function validateImageUrlSecurity(
  urlObj: URL
): Promise<{ safe: true } | { safe: false; reason: string }> {
  if (!ALLOWED_PROTOCOLS.has(urlObj.protocol)) {
    return { safe: false, reason: "disallowed_protocol" };
  }

  const port = urlObj.port
    ? Number(urlObj.port)
    : urlObj.protocol === "https:"
    ? 443
    : 80;

  if (!ALLOWED_PORTS.has(port)) {
    return { safe: false, reason: "disallowed_port" };
  }

  const rawHost = urlObj.hostname.toLowerCase();
  const cleanHost = rawHost.replace(/^\[|\]$/g, "");

  if (
    cleanHost === "localhost" ||
    cleanHost.endsWith(".localhost") ||
    cleanHost.endsWith(".local") ||
    cleanHost.endsWith(".internal") ||
    cleanHost.endsWith(".lan")
  ) {
    return { safe: false, reason: "private_host" };
  }

  if (ALLOWED_IMAGE_HOSTS && ALLOWED_IMAGE_HOSTS.length > 0) {
    const matched = ALLOWED_IMAGE_HOSTS.some((pattern) =>
      matchesAllowedHost(cleanHost, pattern)
    );
    if (!matched) {
      return { safe: false, reason: "host_not_in_allowlist" };
    }
  }

  if (net.isIP(cleanHost)) {
    if (isPrivateOrReservedIp(cleanHost)) {
      return { safe: false, reason: "private_ip_resolved" };
    }
    return { safe: true };
  }

  try {
    const lookups = await dns.lookup(cleanHost, { all: true });
    if (!lookups || lookups.length === 0) {
      return { safe: false, reason: "dns_lookup_empty" };
    }
    for (const record of lookups) {
      if (isPrivateOrReservedIp(record.address)) {
        return { safe: false, reason: "private_ip_resolved" };
      }
    }
  } catch (error: any) {
    return {
      safe: false,
      reason: `dns_lookup_failed: ${error?.message || "unknown"}`,
    };
  }

  return { safe: true };
}

type FetchImageResult =
  | { ok: true; dataUrl: string; byteLength: number }
  | { ok: false; reason: string; host: string };

async function readStreamWithLimit(
  body: ReadableStream<Uint8Array>,
  maxBytes: number
): Promise<{ ok: true; buffer: Buffer } | { ok: false; reason: string }> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let accumulated = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        accumulated += value.byteLength;
        if (accumulated > maxBytes) {
          await reader.cancel();
          return { ok: false, reason: `stream_size_exceeded_${accumulated}` };
        }
        chunks.push(value);
      }
    }

    return { ok: true, buffer: Buffer.concat(chunks) };
  } catch (error: any) {
    return { ok: false, reason: `stream_read_error: ${error?.message || "unknown"}` };
  }
}

async function fetchImageAsDataUrlSafe(
  initialUrl: string
): Promise<FetchImageResult> {
  let currentUrlString = initialUrl;
  let hops = 0;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), IMAGE_DOWNLOAD_TIMEOUT_MS);

  try {
    while (hops <= MAX_REDIRECT_HOPS) {
      let urlObj: URL;
      try {
        urlObj = new URL(currentUrlString);
      } catch {
        return { ok: false, reason: "invalid_url", host: "unknown" };
      }

      const securityCheck = await validateImageUrlSecurity(urlObj);
      if (!securityCheck.safe) {
        return { ok: false, reason: securityCheck.reason, host: urlObj.host };
      }

      const response = await fetch(urlObj.toString(), {
        headers: getImageHeaders(urlObj.toString()),
        signal: controller.signal,
        redirect: "manual",
      });

      if (response.status >= 300 && response.status < 400) {
        hops += 1;
        if (hops > MAX_REDIRECT_HOPS) {
          return { ok: false, reason: "too_many_redirects", host: urlObj.host };
        }
        const location = response.headers.get("location");
        if (!location) {
          return {
            ok: false,
            reason: "missing_redirect_location",
            host: urlObj.host,
          };
        }
        currentUrlString = new URL(location, urlObj).toString();
        continue;
      }

      if (!response.ok) {
        return {
          ok: false,
          reason: `http_status_${response.status}`,
          host: urlObj.host,
        };
      }

      const rawContentType = response.headers.get("content-type");
      if (!rawContentType || !rawContentType.toLowerCase().startsWith("image/")) {
        return {
          ok: false,
          reason: `invalid_content_type_${(rawContentType || "missing").slice(0, 40)}`,
          host: urlObj.host,
        };
      }

      const rawContentLength = response.headers.get("content-length");
      if (rawContentLength) {
        const declaredSize = Number(rawContentLength);
        if (!isNaN(declaredSize) && declaredSize > MAX_SINGLE_IMAGE_BYTES) {
          return {
            ok: false,
            reason: `content_length_exceeded_${declaredSize}`,
            host: urlObj.host,
          };
        }
      }

      if (!response.body) {
        return { ok: false, reason: "missing_response_body", host: urlObj.host };
      }

      const streamResult = await readStreamWithLimit(
        response.body,
        MAX_SINGLE_IMAGE_BYTES
      );

      if (!streamResult.ok) {
        return {
          ok: false,
          reason: streamResult.reason,
          host: urlObj.host,
        };
      }

      if (streamResult.buffer.byteLength === 0) {
        return { ok: false, reason: "empty_image_payload", host: urlObj.host };
      }

      const buffer = streamResult.buffer;
      const mimeType = resolveMimeType(rawContentType);
      const base64Data = buffer.toString("base64");
      return {
        ok: true,
        dataUrl: `data:${mimeType};base64,${base64Data}`,
        byteLength: buffer.byteLength,
      };
    }

    return { ok: false, reason: "redirect_exhausted", host: "unknown" };
  } catch (error: any) {
    return {
      ok: false,
      reason:
        error?.name === "AbortError"
          ? "timeout"
          : `fetch_error: ${error?.message || "unknown"}`,
      host: "unknown",
    };
  } finally {
    clearTimeout(timer);
  }
}

function previewUrlSafely(rawUrl: string): { host: string; path: string } {
  try {
    const url = new URL(rawUrl);
    return {
      host: url.host,
      path: previewText(url.pathname, 60),
    };
  } catch {
    return {
      host: "invalid",
      path: previewText(rawUrl, 60),
    };
  }
}

function buildUserMessageContent(
  prompt: string,
  imageDataUrls: string[]
): string | MessageContentPart[] {
  if (imageDataUrls.length === 0) {
    return prompt;
  }
  const parts: MessageContentPart[] = [{ type: "text", text: prompt }];
  for (const dataUrl of imageDataUrls) {
    parts.push({
      type: "image_url",
      image_url: { url: dataUrl },
    });
  }
  return parts;
}

function buildOpenAIRequestFromInput(
  input: AnswerRequestInput,
  imageDataUrls: string[],
  mode: UpstreamMode
) {
  let prompt = buildUpstreamQuestion(input);
  if (imageDataUrls.length > 0) {
    const { promptQuestion, promptOptions } = resolvePromptSources(input);
    const combinedText = [promptQuestion, ...(promptOptions || [])].join(" ");
    if (combinedText.includes("[图片")) {
      prompt = `${prompt}\n\nThe placeholders [图片1], [图片2], etc., refer to the attached images in the given order.`;
    }
  }
  const userContent = buildUserMessageContent(prompt, imageDataUrls);
  const body: Record<string, unknown> = {
    model: OPENAI_MODEL,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userContent },
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
  const answer =
    typeof response.answer === "string" && response.answer.trim().length > 0
      ? response.answer.trim()
      : NO_ANSWER;

  return {
    payload: { question: originalQuestion, answer },
    repairFlags,
  };
}

const IMAGE_UNSUPPORTED_HINTS = [
  "image_url",
  "image",
  "multimodal",
  "vision",
  "content' is not of type 'string'",
  "expected string",
  "too large",
  "payload too large",
  "request body too large",
  "context length exceeded",
  "maximum context length",
] as const;

const RETRY_ONLY_HINTS = [
  "response_format",
  "json_object",
  "unsupported",
  "not support",
  "invalid parameter",
  "invalid_request_error",
] as const;

const RETRY_FALLBACK_HINTS = [
  ...RETRY_ONLY_HINTS,
  ...IMAGE_UNSUPPORTED_HINTS,
] as const;

function shouldRetryWithFallbackMode(status: number, fullBodyText: string): boolean {
  if (status === 401 || status === 403) {
    return false;
  }
  if (status === 413) {
    return true;
  }
  if (status < 400 || status >= 500) {
    return false;
  }

  const normalized = fullBodyText.toLowerCase();
  return RETRY_FALLBACK_HINTS.some((hint) => normalized.includes(hint));
}

function isImageUnsupportedError(status: number, fullBodyText: string): boolean {
  if (status === 401 || status === 403) {
    return false;
  }
  if (status === 413) {
    return true;
  }
  if (status < 400 || status >= 500) {
    return false;
  }

  const normalized = fullBodyText.toLowerCase();
  return IMAGE_UNSUPPORTED_HINTS.some((hint) => normalized.includes(hint));
}

async function runUpstreamAttempt(
  input: AnswerRequestInput,
  imageDataUrls: string[],
  requestId: string,
  mode: UpstreamMode
): Promise<AttemptResult> {
  const body = buildOpenAIRequestFromInput(input, imageDataUrls, mode);
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
    imageCount: imageDataUrls.length,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  let response: Response;
  let responseText = "";

  try {
    response = await fetch(OPENAI_BASE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    responseText = await response.text();
  } catch (error: any) {
    const durationMs = Date.now() - startedAt;
    const isTimeout = error?.name === "AbortError";
    return {
      ok: false,
      mode,
      category: "transport_error",
      durationMs,
      details: isTimeout
        ? `upstream request timed out after ${UPSTREAM_TIMEOUT_MS}ms`
        : error?.message || "upstream transport error",
      shouldRetryFallback: false,
    };
  } finally {
    clearTimeout(timer);
  }

  const durationMs = Date.now() - startedAt;

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
      fullErrorText: responseText,
      shouldRetryFallback:
        mode === "json" && shouldRetryWithFallbackMode(response.status, responseText),
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
  let imageDataUrls: string[] = [];

  const hasDirectImages =
    (input.directImagesMeta?.receivedCount ?? 0) > 0 ||
    (input.directImages?.length ?? 0) > 0;

  if (hasDirectImages) {
    imageDataUrls = (input.directImages || []).slice(0, MAX_IMAGES_PER_REQUEST);
    const receivedCount =
      input.directImagesMeta?.receivedCount ?? (input.directImages?.length || 0);
    const validCount = imageDataUrls.length;
    const logLevel = receivedCount > 0 && validCount === 0 ? "WARN" : "INFO";

    log(logLevel, "direct_images_processed", {
      requestId,
      receivedCount,
      validCount,
      invalidCount: input.directImagesMeta?.invalidCount ?? 0,
      singleSizeExceededCount: input.directImagesMeta?.singleSizeExceededCount ?? 0,
      budgetExceededCount: input.directImagesMeta?.budgetExceededCount ?? 0,
      countExceededCount: input.directImagesMeta?.countExceededCount ?? 0,
      totalBytes: input.directImagesMeta?.totalBytes ?? 0,
    });
  } else {
    const detectedImageUrls = collectImageUrlsFromInput(input);
    if (detectedImageUrls.length > 0) {
      const targetUrls = detectedImageUrls.slice(0, MAX_IMAGES_PER_REQUEST);
      if (detectedImageUrls.length > MAX_IMAGES_PER_REQUEST) {
        log("WARN", "image_count_exceeded", {
          requestId,
          detectedCount: detectedImageUrls.length,
          allowedCount: MAX_IMAGES_PER_REQUEST,
        });
      }

      log("INFO", "image_processing_started", {
        requestId,
        count: targetUrls.length,
        targets: targetUrls.map(previewUrlSafely),
      });

      const results = await Promise.all(
        targetUrls.map((url) => fetchImageAsDataUrlSafe(url))
      );

      let accumulatedBytes = 0;
      for (let i = 0; i < results.length; i += 1) {
        const result = results[i];
        const targetUrl = targetUrls[i];
        const targetHost = (() => {
          try {
            return new URL(targetUrl).host;
          } catch {
            return "unknown";
          }
        })();

        if (result.ok) {
          if (accumulatedBytes + result.byteLength > MAX_TOTAL_IMAGE_BYTES) {
            log("WARN", "image_download_failed", {
              requestId,
              host: targetHost,
              reason: "total_image_budget_exceeded",
            });
            continue;
          }
          accumulatedBytes += result.byteLength;
          imageDataUrls.push(result.dataUrl);
        } else {
          log("WARN", "image_download_failed", {
            requestId,
            host: result.host || targetHost,
            reason: previewText(result.reason, 80),
          });
        }
      }

      log("INFO", "image_processing_completed", {
        requestId,
        detectedCount: detectedImageUrls.length,
        successCount: imageDataUrls.length,
        totalBytes: accumulatedBytes,
      });
    }
  }

  const firstAttempt = await runUpstreamAttempt(
    input,
    imageDataUrls,
    requestId,
    "json"
  );

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
    const rawErrorText = firstAttempt.fullErrorText || firstAttempt.details;
    const isImageIssue =
      imageDataUrls.length > 0 &&
      firstAttempt.status !== undefined &&
      isImageUnsupportedError(firstAttempt.status, rawErrorText);

    const fallbackImageUrls = isImageIssue ? [] : imageDataUrls;

    const secondAttempt = await runUpstreamAttempt(
      input,
      fallbackImageUrls,
      requestId,
      "fallback"
    );

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

async function handleClientRequest(req: Request): Promise<Response> {
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

  if (
    (url.pathname === "/" || url.pathname === "/answer") &&
    (req.method === "GET" || req.method === "HEAD")
  ) {
    const responseData = {
      message: "OCS AI Answer service is running.",
      version: SERVICE_VERSION,
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

  const declaredLength = Number(req.headers.get("content-length") || "0");
  if (!isNaN(declaredLength) && declaredLength > MAX_CLIENT_REQUEST_BODY_BYTES) {
    log("WARN", "request_body_too_large", {
      requestId,
      contentLength: declaredLength,
      limit: MAX_CLIENT_REQUEST_BODY_BYTES,
    });
    return jsonResponse({ error: "请求体过大" }, 413);
  }

  let requestBody = "";

  try {
    if (req.body) {
      const streamResult = await readStreamWithLimit(
        req.body,
        MAX_CLIENT_REQUEST_BODY_BYTES
      );
      if (!streamResult.ok) {
        if (streamResult.reason.startsWith("stream_size_exceeded")) {
          log("WARN", "request_body_too_large", {
            requestId,
            details: streamResult.reason,
            limit: MAX_CLIENT_REQUEST_BODY_BYTES,
          });
          return jsonResponse({ error: "请求体过大" }, 413);
        }
        log("ERROR", "request_body_read_failed", {
          requestId,
          details: streamResult.reason,
        });
        return jsonResponse({ error: "无法读取请求体" }, 400);
      }
      requestBody = streamResult.buffer.toString("utf8");
    }
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

  const body =
    questionData && typeof questionData === "object"
      ? (questionData as Record<string, unknown>)
      : undefined;

  const receivedKeys = body ? Object.keys(body) : [];
  const optionsValue = body?.options;
  const typeValue = body?.type;
  const suggestionTitleValue = body?.suggestion_title || body?.suggestionTitle;
  const suggestionOptionsValue = body?.suggestion_options || body?.suggestionOptions;
  const rawImages = body?.images;

  const directImagesResult = normalizeDirectImages(rawImages);
  const options = normalizeOptions(optionsValue);
  const suggestionOptions = normalizeOptions(suggestionOptionsValue);
  const questionType =
    typeof typeValue === "string" && typeValue.trim().length > 0
      ? typeValue.trim()
      : undefined;
  const suggestionTitle =
    typeof suggestionTitleValue === "string" && suggestionTitleValue.trim().length > 0
      ? suggestionTitleValue.trim()
      : undefined;

  const question =
    typeof body?.question === "string" ? (body.question as string).trim() : "";

  if (!question) {
    log("WARN", "request_question_missing", {
      requestId,
      receivedKeys,
      requestSummary: DEBUG_REQUEST_DETAILS
        ? {
            question: summarizeValue(body?.question),
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
        suggestionTitle,
        suggestionOptions,
        directImages: directImagesResult.valid,
        directImagesMeta: directImagesResult,
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
}

if (import.meta.main) {
  serve({
    hostname: "0.0.0.0",
    port: PORT,
    maxRequestBodySize: SERVER_HARD_REQUEST_BODY_LIMIT_BYTES,
    fetch: handleClientRequest,
  });
}

export {
  SERVICE_VERSION,
  NO_ANSWER,
  extractImageUrls,
  collectImageUrlsFromInput,
  normalizeDirectImages,
  resolveMimeType,
  getImageHeaders,
  fetchImageAsDataUrlSafe,
  validateImageUrlSecurity,
  parseIPv6Words,
  isPrivateOrReservedIp,
  previewUrlSafely,
  readStreamWithLimit,
  handleClientRequest,
  buildUserMessageContent,
  buildOpenAIRequestFromInput,
  buildUpstreamQuestion,
  normalizeOptions,
  parseAnswerPayload,
  sanitizeModelResponse,
  shouldRetryWithFallbackMode,
  isImageUnsupportedError,
  getAnswerFromUpstream,
};

