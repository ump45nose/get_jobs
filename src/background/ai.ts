import type {
  AiDiagnosticLog,
  GreetingDraft,
  LiepinAiConfig,
  LiepinJobSnapshot,
} from "../shared/types";
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

/** 后台用于持久化单次 AI 请求诊断的回调。 */
type DiagnosticReporter = (diagnostic: AiDiagnosticLog) => void | Promise<void>;

/** 猎聘聊天输入允许的招呼语字符上限。 */
export const GREETING_CHARACTER_LIMIT = 150;

/** 自动发送采用的最大句子数，避免模型输出长段落。 */
export const GREETING_SENTENCE_LIMIT = 3;

/** 用户可自定义业务提示词，但平台发送边界始终由高优先级消息约束。 */
const GREETING_SAFETY_PROMPT =
  "只输出最终中文招呼语纯文本，不要标题、列表、Markdown、JSON、引号或解释。输出不得超过150个字符且最多3句话；信息不足时仅使用已提供事实做保守表达，不得输出拒答、占位符或“需人工判断”。";

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
  const withoutFences = value
    .trim()
    .replace(/^```(?:json|text|markdown)?\s*/iu, "")
    .replace(/\s*```$/u, "")
    // 部分推理模型会把思考内容放在 content 的 think 标签中，只保留标签外的最终正文。
    .replace(/<think>[\s\S]*?<\/think>/giu, "")
    .trim();
  const unwrapped = unwrapStructuredGreeting(withoutFences);
  return unwrapped
    .replace(/^(?:招呼语|输出)\s*[：:]\s*/u, "")
    .replace(/^(?:["“”']+)|(?:["“”']+)$/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

/**
 * 从模型偶发返回的 JSON 包装中提取招呼正文。
 *
 * @param value 去除代码块后的模型文本。
 * @returns 找到已知正文字段时返回字段内容，否则保留原文交给后续校验。
 */
function unwrapStructuredGreeting(value: string): string {
  if (!value.startsWith("{") && !value.startsWith("[") && !value.startsWith('"')) return value;
  try {
    const parsed = JSON.parse(value) as unknown;
    const keys = ["greeting", "greetingText", "text", "content", "message", "answer"];
    const visit = (node: unknown, depth: number): string | undefined => {
      if (typeof node === "string") return node;
      if (!node || typeof node !== "object" || depth > 3) return undefined;
      if (Array.isArray(node)) {
        for (const item of node) {
          const found = visit(item, depth + 1);
          if (found) return found;
        }
        return undefined;
      }
      const record = node as Record<string, unknown>;
      for (const key of keys) {
        if (key in record) {
          const found = visit(record[key], depth + 1);
          if (found) return found;
        }
      }
      return undefined;
    };
    return visit(parsed, 0) ?? value;
  } catch {
    // 非法 JSON 不做猜测性修复，避免把模型解释文字误当作发送正文。
    return value;
  }
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
  if (!normalized) {
    throw new Error("AI 接口返回了空招呼语；请检查模型是否正常输出最终正文，或改用非推理模式后重试");
  }
  if (normalized.includes("需人工判断")) {
    throw new Error("AI 根据当前提示词返回“需人工判断”；请调整提示词要求或补充其实际需要的信息");
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
  phase: AiDiagnosticLog["phase"],
  detailedLogging: boolean,
  onDiagnostic?: DiagnosticReporter,
): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutSeconds * 1_000);
  const startedAt = Date.now();
  const requestBody = JSON.stringify({
    model: model.trim(),
    temperature: 0.2,
    stream: false,
    messages,
  });

  /** 即使上游错误或响应意外回显密钥，诊断持久化前也必须二次脱敏。 */
  const sanitizeDiagnosticText = (value: string): string => {
    const secret = apiKey.trim();
    return (secret ? value.split(secret).join("[REDACTED]") : value).slice(0, 20_000);
  };

  /** 写入日志失败不能反向阻断可用的 AI 草稿。 */
  const report = async (
    outcome: AiDiagnosticLog["outcome"],
    response?: Response,
    responseBody?: string,
    error?: string,
  ) => {
    if (!onDiagnostic) return;
    const diagnostic: AiDiagnosticLog = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      createdAt: new Date().toISOString(),
      phase,
      endpoint,
      model: model.trim(),
      timeoutSeconds,
      durationMs: Date.now() - startedAt,
      detailed: detailedLogging,
      request: {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "[REDACTED]",
        },
        messageCharacters: messages.map((message) => ({
          role: message.role,
          characters: Array.from(message.content).length,
        })),
        ...(detailedLogging ? { body: sanitizeDiagnosticText(requestBody) } : {}),
      },
      ...(response ? {
        response: {
          status: response.status,
          statusText: response.statusText,
          contentType: response.headers.get("Content-Type") ?? "",
          ...(detailedLogging && responseBody !== undefined
            ? { body: sanitizeDiagnosticText(responseBody) }
            : {}),
        },
      } : {}),
      outcome,
      ...(error ? { error: sanitizeDiagnosticText(error) } : {}),
    };
    try {
      await onDiagnostic(diagnostic);
    } catch {
      // 诊断属于辅助能力，存储异常不得改变生成与发送结果。
    }
  };

  try {
    let response: Response;
    try {
      response = await fetcher(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey.trim()}`,
        },
        body: requestBody,
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        const message = `AI 生成超过 ${timeoutSeconds} 秒，已取消本次请求`;
        await report("timeout", undefined, undefined, message);
        throw new Error(message);
      }
      const message = error instanceof Error ? error.message : String(error);
      await report("network-error", undefined, undefined, message);
      throw error;
    }

    let responseBody: string;
    try {
      responseBody = await response.text();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await report("invalid-response", response, undefined, `读取 AI 响应正文失败：${message}`);
      throw new Error(`读取 AI 响应正文失败：${message}`);
    }
    if (!response.ok) {
      const message = `AI 接口返回 HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`;
      await report("http-error", response, responseBody, message);
      throw new Error(message);
    }

    let parsed: ChatCompletionResponse;
    try {
      parsed = JSON.parse(responseBody) as ChatCompletionResponse;
    } catch {
      const message = "AI 接口返回了无法解析的 JSON";
      await report("invalid-response", response, responseBody, message);
      throw new Error(message);
    }
    const text = extractGreetingText(parsed);
    if (!text) {
      await report("invalid-response", response, responseBody, "响应中未找到最终正文 content");
      return "";
    }
    await report("success", response, responseBody);
    return text;
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
  onDiagnostic?: DiagnosticReporter,
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
    "generate",
    config.detailedLogging,
    onDiagnostic,
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
      "compress",
      config.detailedLogging,
      onDiagnostic,
    );
    return constrainGreetingDraft(compressedDraft);
  } catch {
    // 压缩接口失败时保留首次生成结果并只删除尾部，避免可用草稿因第二次请求失败而丢失。
    return constrainGreetingDraft(firstDraft);
  }
}

/**
 * 生成 AI 草稿，并仅在页面发送前的生成失败阶段使用用户配置的固定兜底文本。
 *
 * @param config AI 与兜底配置。
 * @param apiKey 本机保存的接口密钥。
 * @param job 当前岗位快照。
 * @param fetcher 可替换的网络请求实现。
 * @param onDiagnostic 单次 POST 请求诊断回调。
 * @returns 标注文本来源的可发送草稿。
 */
export async function generateGreetingDraftWithFallback(
  config: LiepinAiConfig,
  apiKey: string,
  job: LiepinJobSnapshot,
  fetcher: FetchLike = fetch,
  onDiagnostic?: DiagnosticReporter,
): Promise<GreetingDraft> {
  try {
    const text = await generateGreetingDraft(config, apiKey, job, fetcher, onDiagnostic);
    return { text, source: "ai" };
  } catch (error) {
    if (!config.useFallbackGreeting) throw error;
    const fallback = validateGreetingDraft(config.fallbackGreeting);
    const reason = error instanceof Error ? error.message : String(error);
    return {
      text: fallback,
      source: "fallback",
      warning: `AI 草稿不可用，已改用兜底招呼语（原因：${reason}）`,
    };
  }
}
