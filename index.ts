import { serve } from "bun";
import "dotenv/config";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1/chat/completions";
const SYSTEM_PROMPT = process.env.SYSTEM_PROMPT || "你是一个通用的AI助手。";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-3.5-turbo-0125";
const PORT = process.env.PORT || 3000;

if (!OPENAI_API_KEY) {
  console.error("❌ Error: OPENAI_API_KEY is not set in .env file.");
  process.exit(1);
}
if (!OPENAI_MODEL) {
  console.error("❌ Error: OPENAI_MODEL is not set in .env file.");
  process.exit(1);
}

console.log(`🚀 AI Question Bank server running on http://localhost:${PORT}`);
console.log(`🌐 Server also accessible via http://192.168.1.11:${PORT}`);
console.log(`📡 OpenAI Base URL: ${OPENAI_BASE_URL}`);
console.log(`🤖 OpenAI Model: ${OPENAI_MODEL}`);
console.log(`🔧 System Prompt: ${SYSTEM_PROMPT.substring(0, 100)}...`);
console.log("=".repeat(80));

function getTimestamp() {
  return new Date().toISOString();
}

function logRequestDetails(req: Request, clientIP: string) {
  console.log(`📥 [${getTimestamp()}] 收到请求:`);
  console.log(`   方法: ${req.method}`);
  console.log(`   URL: ${req.url}`);
  console.log(`   客户端IP: ${clientIP}`);
  console.log(`   User-Agent: ${req.headers.get('User-Agent') || 'Unknown'}`);
  console.log(`   Content-Type: ${req.headers.get('Content-Type') || 'Unknown'}`);
  console.log(`   Origin: ${req.headers.get('Origin') || 'None'}`);
  console.log(`   Referer: ${req.headers.get('Referer') || 'None'}`);
}

function getCorsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS, PUT, DELETE",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With",
    "Access-Control-Max-Age": "86400"
  };
}

serve({
  hostname: "0.0.0.0",
  port: PORT,
  async fetch(req: Request) {
    const url = new URL(req.url);
    const clientIP = req.headers.get('x-forwarded-for') || 
                     req.headers.get('x-real-ip') || 
                     'Unknown';

    logRequestDetails(req, clientIP);

    if (req.method === "OPTIONS") {
      console.log(`✅ [${getTimestamp()}] 处理 OPTIONS 预检请求`);
      return new Response(null, {
        status: 200,
        headers: getCorsHeaders()
      });
    }

    if (url.pathname === "/" && (req.method === "GET" || req.method === "HEAD")) {
      console.log(`🏠 [${getTimestamp()}] 处理根路径请求 (${req.method})`);
      
      const responseData = { 
        message: "Bun OpenAI AI 题库服务器运行正常",
        version: "1.0.0",
        endpoints: ["/answer"],
        status: "running",
        model_in_use: OPENAI_MODEL
      };
      
      return new Response(
        req.method === "HEAD" ? null : JSON.stringify(responseData),
        { 
          status: 200, 
          headers: { 
            "Content-Type": "application/json",
            ...getCorsHeaders()
          }
        }
      );
    }

    if (url.pathname === "/answer" && req.method === "POST") {
      try {
        console.log(`🤖 [${getTimestamp()}] 开始处理答案请求`);
        
        let requestBody;
        try {
          requestBody = await req.text();
          console.log(`📋 [${getTimestamp()}] 请求体 (raw): ${requestBody}`);
        } catch (bodyError: any) {
          console.error(`❌ [${getTimestamp()}] 无法读取请求体:`, bodyError.message);
          return new Response(
            JSON.stringify({ error: "无法读取请求体", details: bodyError.message }),
            { 
              status: 400, 
              headers: { 
                "Content-Type": "application/json",
                ...getCorsHeaders()
              }
            }
          );
        }

        let questionData;
        try {
          questionData = JSON.parse(requestBody);
          console.log(`🔍 [${getTimestamp()}] 解析后的请求数据:`, questionData);
        } catch (jsonError: any) {
          console.error(`❌ [${getTimestamp()}] JSON 解析失败:`, jsonError.message);
          return new Response(
            JSON.stringify({ error: "JSON 格式错误", details: jsonError.message }),
            { 
              status: 400, 
              headers: { 
                "Content-Type": "application/json",
                ...getCorsHeaders()
              }
            }
          );
        }

        const { question } = questionData;

        if (!question) {
          console.error(`❌ [${getTimestamp()}] 缺少 'question' 字段`);
          return new Response(
            JSON.stringify({ error: "缺少 'question' 字段" }),
            { 
              status: 400, 
              headers: { 
                "Content-Type": "application/json",
                ...getCorsHeaders()
              }
            }
          );
        }

        console.log(`💬 [${getTimestamp()}] 处理问题: "${question}"`);

        const openaiRequestBody = {
          model: OPENAI_MODEL,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: question },
          ],
          response_format: { type: "json_object" },
          temperature: 0.7,
          max_tokens: 500,
        };

        console.log(`🔄 [${getTimestamp()}] 发送到 OpenAI:`, {
          url: OPENAI_BASE_URL,
          model: openaiRequestBody.model,
          messageCount: openaiRequestBody.messages.length,
          question: question.substring(0, 100) + (question.length > 100 ? "..." : "")
        });

        let openaiResponse;
        const fetchStartTime = Date.now();
        
        try {
          openaiResponse = await fetch(OPENAI_BASE_URL, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${OPENAI_API_KEY}`,
            },
            body: JSON.stringify(openaiRequestBody),
          });
          
          const fetchDuration = Date.now() - fetchStartTime;
          console.log(`⏱️ [${getTimestamp()}] OpenAI 请求耗时: ${fetchDuration}ms`);
          console.log(`📡 [${getTimestamp()}] OpenAI 响应状态: ${openaiResponse.status} ${openaiResponse.statusText}`);
          
        } catch (fetchError: any) {
          console.error(`❌ [${getTimestamp()}] OpenAI API 请求失败:`, {
            message: fetchError.message,
            cause: fetchError.cause,
            stack: fetchError.stack
          });
          
          return new Response(
            JSON.stringify({
              error: "OpenAI API 请求失败",
              details: fetchError.message,
              type: "FETCH_ERROR"
            }),
            { 
              status: 500, 
              headers: { 
                "Content-Type": "application/json",
                ...getCorsHeaders()
              }
            }
          );
        }

        if (!openaiResponse.ok) {
          let errorText;
          try {
            errorText = await openaiResponse.text();
            console.error(`❌ [${getTimestamp()}] OpenAI API 错误响应:`, {
              status: openaiResponse.status,
              statusText: openaiResponse.statusText,
              headers: Object.fromEntries(openaiResponse.headers),
              body: errorText
            });
          } catch (readError: any) {
            console.error(`❌ [${getTimestamp()}] 无法读取 OpenAI 错误响应:`, readError.message);
            errorText = "无法读取错误详情";
          }
          
          return new Response(
            JSON.stringify({
              error: "OpenAI API 返回错误",
              statusCode: openaiResponse.status,
              statusText: openaiResponse.statusText,
              details: errorText,
              type: "OPENAI_ERROR"
            }),
            { 
              status: 500, 
              headers: { 
                "Content-Type": "application/json",
                ...getCorsHeaders()
              }
            }
          );
        }

        let openaiData;
        try {
          openaiData = await openaiResponse.json();
          console.log(`📄 [${getTimestamp()}] OpenAI 响应数据:`, {
            choices: openaiData.choices?.length || 0,
            usage: openaiData.usage,
            model: openaiData.model
          });
        } catch (parseError: any) {
          console.error(`❌ [${getTimestamp()}] OpenAI 响应 JSON 解析失败:`, parseError.message);
          return new Response(
            JSON.stringify({
              error: "OpenAI 响应解析失败",
              details: parseError.message,
              type: "PARSE_ERROR"
            }),
            { 
              status: 500, 
              headers: { 
                "Content-Type": "application/json",
                ...getCorsHeaders()
              }
            }
          );
        }

        const rawResponse = openaiData.choices?.[0]?.message?.content;

        if (!rawResponse) {
          console.error(`❌ [${getTimestamp()}] OpenAI 响应中没有内容:`, openaiData);
          return new Response(
            JSON.stringify({ 
              error: "OpenAI 响应中没有内容",
              openai_response: openaiData,
              type: "NO_CONTENT"
            }),
            { 
              status: 500, 
              headers: { 
                "Content-Type": "application/json",
                ...getCorsHeaders()
              }
            }
          );
        }

        console.log(`🎯 [${getTimestamp()}] OpenAI 原始回复: ${rawResponse}`);

        let aiResponse;
        try {
          aiResponse = JSON.parse(rawResponse);
          console.log(`✨ [${getTimestamp()}] 解析后的 AI 响应:`, aiResponse);
        } catch (jsonError: any) {
          console.error(`❌ [${getTimestamp()}] AI 响应 JSON 解析失败:`, {
            error: jsonError.message,
            rawResponse: rawResponse
          });
          return new Response(
            JSON.stringify({
              error: "AI 回复格式错误",
              raw_response: rawResponse,
              parse_error: jsonError.message,
              type: "AI_RESPONSE_FORMAT_ERROR"
            }),
            { 
              status: 500, 
              headers: { 
                "Content-Type": "application/json",
                ...getCorsHeaders()
              }
            }
          );
        }

        if (aiResponse.question && aiResponse.answer) {
          console.log(`✅ [${getTimestamp()}] 成功处理请求，返回答案`);
          return new Response(JSON.stringify(aiResponse), {
            status: 200,
            headers: { 
              "Content-Type": "application/json",
              ...getCorsHeaders()
            }
          });
        } else {
          console.error(`❌ [${getTimestamp()}] AI 响应缺少必要字段:`, {
            hasQuestion: !!aiResponse.question,
            hasAnswer: !!aiResponse.answer,
            response: aiResponse
          });
          return new Response(
            JSON.stringify({
              error: "AI 响应格式不完整",
              expected: ["question", "answer"],
              received: Object.keys(aiResponse),
              ai_response: aiResponse,
              type: "INCOMPLETE_RESPONSE"
            }),
            { 
              status: 500, 
              headers: { 
                "Content-Type": "application/json",
                ...getCorsHeaders()
              }
            }
          );
        }

      } catch (error: any) {
        console.error(`❌ [${getTimestamp()}] 服务器内部错误:`, {
          message: error.message,
          stack: error.stack,
          name: error.name,
          cause: error.cause
        });
        
        return new Response(
          JSON.stringify({
            error: "服务器内部错误",
            details: error.message,
            type: "INTERNAL_ERROR"
          }),
          { 
            status: 500, 
            headers: { 
              "Content-Type": "application/json",
              ...getCorsHeaders()
            }
          }
        );
      }
    }

    console.log(`❓ [${getTimestamp()}] 未知路径: ${url.pathname}`);
    return new Response(
      JSON.stringify({ 
        message: "API 路径不存在",
        available_paths: ["/", "/answer"],
        method: req.method,
        path: url.pathname
      }),
      { 
        status: 404, 
        headers: { 
          "Content-Type": "application/json",
          ...getCorsHeaders()
        }
      }
    );
  },
});

console.log(`🎉 服务器启动成功！访问 http://localhost:${PORT} 查看状态`);
