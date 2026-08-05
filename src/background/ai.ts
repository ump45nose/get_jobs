import type { LiepinAiConfig, LiepinJobSnapshot } from "../shared/types";

/** OpenAI 兼容 Chat Completions 的最小响应结构。 */
interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }>;
    };
  }>;
}

/** 允许测试替换的 fetch 签名。 */
type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/**
 * 把用户配置的 Base URL 规范化为 Chat Completions 地址。
 *
 * @param baseUrl 用户输入的 OpenAI 兼容接口地址。
 * @returns 可直接请求的完整地址。
 */
export function buildChatCompletionsUrl(baseUrl: string): string {
  const url = new URL(baseUrl.trim());
  if (url.username || url.password) {
    throw new Error("AI 接口地址不得包含用户名或密码");
  }
  const isLocalhost = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocalhost)) {
    throw new Error("AI 接口仅允许 HTTPS，或本机 localhost/127.0.0.1 HTTP 地址");
  }

  const path = url.pathname.replace(/\/+$/, "");
  if (path.endsWith("/chat/completions")) {
    url.pathname = path;
  } else if (path.endsWith("/v1")) {
    url.pathname = `${path}/chat/completions`;
  } else {
    url.pathname = `${path}/v1/chat/completions`.replace(/\/+/g, "/");
  }
  url.search = "";
  url.hash = "";
  return url.toString();
}

/**
 * 从 OpenAI 兼容响应中提取文本内容。
 *
 * @param response 模型响应 JSON。
 * @returns 规整后的草稿文本。
 */
export function extractGreetingText(response: ChatCompletionResponse): string {
  const content = response.choices?.[0]?.message?.content;
  if (typeof content === "string") {
    return content.trim();
  }
  if (Array.isArray(content)) {
    return content.map((part) => part.text ?? "").join("").trim();
  }
  return "";
}

/**
 * 校验 AI 草稿，避免空文本、拒答或过长内容被发送到招聘者。
 *
 * @param value 待发送草稿。
 * @returns 可安全进入预览流程的规整文本。
 */
export function validateGreetingDraft(value: string): string {
  const normalized = value.replace(/^(["“”']+)|(["“”']+)$/g, "").replace(/\s+/g, " ").trim();
  if (!normalized || normalized.includes("需人工判断")) {
    throw new Error("AI 未生成可用招呼语，请补充个人简历摘要后重试");
  }
  if (normalized.length > 150) {
    throw new Error("AI 招呼语超过 150 字，已阻止发送");
  }
  const sentenceCount = normalized.split(/[。！？!?]+/).filter(Boolean).length;
  if (sentenceCount > 3) {
    throw new Error("AI 招呼语超过 3 句话，已阻止发送");
  }
  return normalized;
}

/**
 * 根据岗位快照和用户提供的简历摘要生成个性化招呼草稿。
 *
 * @param config AI 接口和用户画像配置。
 * @param apiKey 本机保存的接口密钥。
 * @param job 当前用户选中的岗位。
 * @param fetcher 可替换的网络请求实现。
 * @returns 通过安全校验的招呼草稿。
 */
export async function generateGreetingDraft(
  config: LiepinAiConfig,
  apiKey: string,
  job: LiepinJobSnapshot,
  fetcher: FetchLike = fetch,
): Promise<string> {
  if (!config.model.trim() || !apiKey.trim()) {
    throw new Error("请先配置 AI 模型和 API Key");
  }
  if (!config.resumeSummary.trim()) {
    throw new Error("请先填写用于生成招呼语的个人简历摘要");
  }

  const endpoint = buildChatCompletionsUrl(config.baseUrl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetcher(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey.trim()}`,
      },
      body: JSON.stringify({
        model: config.model.trim(),
        temperature: 0.2,
        stream: false,
        messages: [
          {
            role: "system",
            content:
              "你是求职沟通助手。只能使用用户提供的真实经历，不得编造技能、年限、学历或业绩。生成自然、具体、礼貌的中文招呼语，最多150字、最多3句话；信息不足时只输出“需人工判断”。不要使用Markdown。",
          },
          {
            role: "user",
            content: [
              `岗位：${job.jobTitle}`,
              `公司：${job.compName || "未提供"}`,
              `地点：${job.jobArea || "未提供"}`,
              `薪资：${job.jobSalaryText || "未提供"}`,
              `招聘者：${job.hrName || "未提供"}`,
              `我的真实经历摘要：${config.resumeSummary.trim()}`,
              "请突出一到两个最相关的匹配点，并以便于继续沟通或发送简历的问句收尾。",
            ].join("\n"),
          },
        ],
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`AI 接口返回 HTTP ${response.status}`);
    }
    const data = (await response.json()) as ChatCompletionResponse;
    return validateGreetingDraft(extractGreetingText(data));
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error("AI 生成超过 30 秒，已取消本次请求");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
