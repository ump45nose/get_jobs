import type { LiepinAiConfig, LiepinJobSnapshot } from "../shared/types";
import { normalizeAiTimeoutSeconds } from "../shared/defaults";

/** OpenAI 兼容 Chat Completions 的最小响应结构。 */
interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }>;
    };
  }>;
}

/** OpenAI 兼容接口需要的最小消息结构。 */
interface ChatMessage {
  role: "system" | "user";
  content: string;
}

/** 允许测试替换的 fetch 签名。 */
type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** 猎聘聊天输入允许的招呼语字符上限。 */
export const GREETING_CHARACTER_LIMIT = 150;

/** 自动发送采用的最大句子数，避免模型输出长段落。 */
export const GREETING_SENTENCE_LIMIT = 3;

/** 用户可自定义业务提示词，但平台发送边界始终由高优先级消息约束。 */
const GREETING_SAFETY_PROMPT =
  "只输出最终中文招呼语纯文本，不要标题、列表、Markdown、引号或解释。输出不得超过150个字符且最多3句话；不能满足时输出“需人工判断”。";

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
  } else if (path) {
    // 兼容 /v1、智谱 /api/paas/v4 等已经包含版本号的 Base URL。
    url.pathname = `${path}/chat/completions`;
  } else {
    url.pathname = "/v1/chat/completions";
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
 * 渲染用户自定义提示词中的白名单岗位变量。
 *
 * @param template 用户保存的完整业务提示词模板。
 * @param config 当前 AI 配置和真实简历摘要。
 * @param job 当前岗位快照。
 * @returns 已注入当前岗位事实的提示词。
 */
export function renderGreetingPrompt(
  template: string,
  config: LiepinAiConfig,
  job: LiepinJobSnapshot,
): string {
  const normalizedTemplate = template.trim();
  if (!normalizedTemplate) {
    throw new Error("请先填写 AI 招呼语提示词模板");
  }
  if (/\{\{\s*resumeSummary\s*\}\}/u.test(normalizedTemplate) && !config.resumeSummary.trim()) {
    throw new Error("当前提示词使用了简历摘要变量，请先填写个人简历摘要");
  }

  const variables: Record<string, string> = {
    resumeSummary: config.resumeSummary.trim(),
    jobTitle: job.jobTitle || "未提供",
    companyName: job.compName || "未提供",
    jobArea: job.jobArea || "未提供",
    jobSalary: job.jobSalaryText || "未提供",
    jobEducation: job.jobEduReq || "未提供",
    jobExperience: job.jobExpReq || "未提供",
    companyIndustry: job.compIndustry || "未提供",
    companyScale: job.compScale || "未提供",
    hrName: job.hrName || "未提供",
    hrTitle: job.hrTitle || "未提供",
  };
  const unknownVariables = new Set<string>();
  const rendered = normalizedTemplate.replace(/\{\{\s*([A-Za-z][A-Za-z0-9]*)\s*\}\}/gu, (_match, name: string) => {
    if (!(name in variables)) {
      unknownVariables.add(name);
      return `{{${name}}}`;
    }
    return variables[name];
  });
  if (unknownVariables.size) {
    throw new Error(`提示词包含未知变量：${Array.from(unknownVariables).join("、")}`);
  }
  return rendered;
}

/**
 * 统一清理模型可能返回的外层引号、代码块和多余空白。
 *
 * @param value 模型原始文本。
 * @returns 适合进一步校验的单段纯文本。
 */
function normalizeGreetingDraft(value: string): string {
  return value
    .replace(/^```(?:text|markdown)?\s*/iu, "")
    .replace(/\s*```$/u, "")
    .replace(/^(?:招呼语|输出)\s*[：:]\s*/u, "")
    .replace(/^(?:["“”']+)|(?:["“”']+)$/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

/**
 * 按 Unicode 码点统计招呼语字符数，避免代理对 emoji 等字符重复计数。
 *
 * @param value 待统计文本。
 * @returns 字符数量。
 */
export function countGreetingCharacters(value: string): number {
  return Array.from(value).length;
}

/**
 * 统计中文与英文结束标点分隔的句子数。
 *
 * @param value 已规整的招呼语。
 * @returns 非空句子数量。
 */
function countGreetingSentences(value: string): number {
  return value.split(/[。！？!?]+/u).filter((part) => part.trim()).length;
}

/**
 * 校验 AI 草稿，避免空文本、拒答或过长内容被发送到招聘者。
 *
 * @param value 待发送草稿。
 * @returns 可安全进入预览流程的规整文本。
 */
export function validateGreetingDraft(value: string): string {
  const normalized = normalizeGreetingDraft(value);
  if (!normalized || normalized.includes("需人工判断")) {
    throw new Error("AI 未生成可用招呼语，请补充个人简历摘要后重试");
  }
  if (countGreetingCharacters(normalized) > GREETING_CHARACTER_LIMIT) {
    throw new Error("AI 招呼语超过 150 字，已阻止发送");
  }
  if (countGreetingSentences(normalized) > GREETING_SENTENCE_LIMIT) {
    throw new Error("AI 招呼语超过 3 句话，已阻止发送");
  }
  return normalized;
}

/**
 * 判断模型草稿是否只因长度或句数需要自动压缩。
 *
 * @param value 已生成的模型草稿。
 * @returns 超过平台长度或句数边界时返回 true。
 */
function needsGreetingCompression(value: string): boolean {
  const normalized = normalizeGreetingDraft(value);
  if (!normalized || normalized.includes("需人工判断")) {
    validateGreetingDraft(normalized);
  }
  return countGreetingCharacters(normalized) > GREETING_CHARACTER_LIMIT
    || countGreetingSentences(normalized) > GREETING_SENTENCE_LIMIT;
}

/**
 * 对二次压缩仍超限的模型文本做仅删除尾部的保守收口。
 *
 * @param value 模型生成或压缩后的文本。
 * @returns 必定满足 150 字和 3 句限制的草稿。
 */
export function constrainGreetingDraft(value: string): string {
  const normalized = normalizeGreetingDraft(value);
  if (!normalized || normalized.includes("需人工判断")) {
    return validateGreetingDraft(normalized);
  }
  const sentenceParts = normalized.match(/[^。！？!?]+[。！？!?]?/gu) ?? [normalized];
  let constrained = sentenceParts.slice(0, GREETING_SENTENCE_LIMIT).join("").trim();
  if (countGreetingCharacters(constrained) > GREETING_CHARACTER_LIMIT) {
    // 预留一个结束标点，截断只删除尾部，不改写或新增候选人事实。
    constrained = Array.from(constrained)
      .slice(0, GREETING_CHARACTER_LIMIT - 1)
      .join("")
      .replace(/[，、；：,;:\s]+$/u, "")
      .trim();
    if (!/[。！？!?]$/u.test(constrained)) constrained += "。";
  }
  return validateGreetingDraft(constrained);
}

/**
 * 执行一次带独立超时的 OpenAI 兼容 Chat Completions 请求。
 *
 * @param endpoint 完整 Chat Completions 地址。
 * @param model 模型名称。
 * @param apiKey 本机保存的 API Key。
 * @param messages 本次请求的消息。
 * @param timeoutSeconds 单次请求超时秒数。
 * @param fetcher 可替换的网络请求实现。
 * @returns 模型返回的纯文本。
 */
async function requestChatCompletion(
  endpoint: string,
  model: string,
  apiKey: string,
  messages: ChatMessage[],
  timeoutSeconds: number,
  fetcher: FetchLike,
): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutSeconds * 1_000);
  try {
    const response = await fetcher(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey.trim()}`,
      },
      body: JSON.stringify({
        model: model.trim(),
        temperature: 0.2,
        max_tokens: 256,
        stream: false,
        messages,
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`AI 接口返回 HTTP ${response.status}`);
    }
    return extractGreetingText((await response.json()) as ChatCompletionResponse);
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error(`AI 生成超过 ${timeoutSeconds} 秒，已取消本次请求`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
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

  const endpoint = buildChatCompletionsUrl(config.baseUrl);
  const timeoutSeconds = normalizeAiTimeoutSeconds(config.timeoutSeconds);
  const renderedPrompt = renderGreetingPrompt(config.promptTemplate, config, job);
  const firstDraft = await requestChatCompletion(
    endpoint,
    config.model,
    apiKey,
    [
      { role: "system", content: GREETING_SAFETY_PROMPT },
      { role: "user", content: renderedPrompt },
    ],
    timeoutSeconds,
    fetcher,
  );
  if (!needsGreetingCompression(firstDraft)) {
    return validateGreetingDraft(firstDraft);
  }

  try {
    // 首次输出超限时让模型保留事实和语气做一次短化，不让用户反复手工重试。
    const compressedDraft = await requestChatCompletion(
      endpoint,
      config.model,
      apiKey,
      [
        { role: "system", content: GREETING_SAFETY_PROMPT },
        {
          role: "user",
          content: `将下面招呼语压缩到 120 个字符以内、最多 3 句话。只能删减和改写已有内容，不得新增任何经历或数字。只输出压缩后的正文：\n${normalizeGreetingDraft(firstDraft)}`,
        },
      ],
      timeoutSeconds,
      fetcher,
    );
    return constrainGreetingDraft(compressedDraft);
  } catch {
    // 压缩接口失败时保留首次生成结果并只删除尾部，避免可用草稿因第二次请求失败而丢失。
    return constrainGreetingDraft(firstDraft);
  }
}
