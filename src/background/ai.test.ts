import { describe, expect, it, vi } from "vitest";
import {
  buildChatCompletionsUrl,
  constrainGreetingDraft,
  countGreetingCharacters,
  extractGreetingText,
  generateGreetingDraft,
  renderGreetingPrompt,
  validateGreetingDraft,
} from "./ai";
import type { LiepinAiConfig, LiepinJobSnapshot } from "../shared/types";
import { normalizeAiTimeoutSeconds } from "../shared/defaults";

const CONFIG: LiepinAiConfig = {
  baseUrl: "https://api.example.com/v1",
  model: "test-model",
  timeoutSeconds: 120,
  resumeSummary: "5 年 Java 与 AI 应用经验，负责 Agent 和 RAG 项目落地。",
  promptTemplate: "请结合 {{resumeSummary}} 应聘 {{companyName}} 的 {{jobTitle}}，语气直接。",
  previewBeforeSend: true,
  sendResume: true,
};

const JOB: LiepinJobSnapshot = {
  cardKey: "job-1",
  fingerprint: "1",
  jobTitle: "AI 应用开发工程师",
  compName: "示例科技",
};

describe("AI 招呼语", () => {
  it("将超时配置限制在 10 至 600 秒并为旧配置提供默认值", () => {
    expect(normalizeAiTimeoutSeconds(undefined)).toBe(120);
    expect(normalizeAiTimeoutSeconds(3)).toBe(10);
    expect(normalizeAiTimeoutSeconds(900)).toBe(600);
  });

  it("规范化 OpenAI 兼容地址并限制不安全协议", () => {
    expect(buildChatCompletionsUrl("https://api.example.com/v1")).toBe(
      "https://api.example.com/v1/chat/completions",
    );
    expect(buildChatCompletionsUrl("http://127.0.0.1:3001/v1")).toBe(
      "http://127.0.0.1:3001/v1/chat/completions",
    );
    expect(buildChatCompletionsUrl("https://open.bigmodel.cn/api/paas/v4")).toBe(
      "https://open.bigmodel.cn/api/paas/v4/chat/completions",
    );
    expect(buildChatCompletionsUrl("https://api.example.com")).toBe(
      "https://api.example.com/v1/chat/completions",
    );
    expect(() => buildChatCompletionsUrl("http://api.example.com/v1")).toThrow("仅允许 HTTPS");
    expect(() => buildChatCompletionsUrl("https://user:pass@api.example.com/v1")).toThrow("用户名或密码");
  });

  it("兼容字符串和文本分段响应", () => {
    expect(extractGreetingText({ choices: [{ message: { content: "  您好  " } }] })).toBe("您好");
    expect(extractGreetingText({
      choices: [{ message: { content: [{ type: "text", text: "您好" }, { type: "text", text: "！" }] } }],
    })).toBe("您好！");
  });

  it("准确区分空草稿、人工判断和超长内容", () => {
    expect(() => validateGreetingDraft("需人工判断")).toThrow("当前提示词");
    expect(() => validateGreetingDraft(" ")).toThrow("空招呼语");
    expect(() => validateGreetingDraft("a".repeat(151))).toThrow("150 字");
  });

  it("渲染完全自定义的白名单变量并拒绝拼错的变量", () => {
    expect(renderGreetingPrompt(CONFIG.promptTemplate, CONFIG, JOB)).toBe(
      "请结合 5 年 Java 与 AI 应用经验，负责 Agent 和 RAG 项目落地。 应聘 示例科技 的 AI 应用开发工程师，语气直接。",
    );
    expect(() => renderGreetingPrompt("岗位：{{jobTitel}}", CONFIG, JOB)).toThrow("jobTitel");
    expect(() => renderGreetingPrompt("经历：{{resumeSummary}}", { ...CONFIG, resumeSummary: "" }, JOB)).toThrow("简历摘要");
  });

  it("对二次生成仍超限的文本执行保守收口", () => {
    const constrained = constrainGreetingDraft(`第一句。第二句。第三句。${"长".repeat(180)}。`);
    expect(countGreetingCharacters(constrained)).toBeLessThanOrEqual(150);
    expect(constrained.split(/[。！？!?]+/u).filter(Boolean)).toHaveLength(3);
    expect(validateGreetingDraft(constrained)).toBe(constrained);
  });

  it("生成草稿时只返回通过校验的模型文本", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _request?: RequestInit) => new Response(JSON.stringify({
      choices: [{ message: { content: "您好，我有 Agent 和 RAG 落地经验，与岗位方向匹配，方便进一步沟通吗？" } }],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));

    const draft = await generateGreetingDraft(CONFIG, "secret", JOB, fetcher);
    expect(draft).toContain("Agent");
    expect(fetcher).toHaveBeenCalledOnce();
    const [, request] = fetcher.mock.calls[0];
    expect(request?.headers).toMatchObject({ Authorization: "Bearer secret" });
    const body = JSON.parse(String(request?.body)) as { messages: Array<{ role: string; content: string }> };
    expect(body.messages[1]?.content).toContain("示例科技");
    expect(body.messages[1]?.content).toContain("语气直接");
    expect(body).not.toHaveProperty("max_tokens");
  });

  it("首次生成超限时自动调用模型压缩后返回合规草稿", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { content: "长".repeat(180) } }],
      }), { status: 200, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { content: "您好，我有相关项目经验，希望进一步了解岗位重点，方便沟通吗？" } }],
      }), { status: 200, headers: { "Content-Type": "application/json" } }));

    const draft = await generateGreetingDraft(CONFIG, "secret", JOB, fetcher);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(validateGreetingDraft(draft)).toBe(draft);
    const [, repairRequest] = fetcher.mock.calls[1];
    expect(String(repairRequest?.body)).toContain("压缩到 120 个字符以内");
  });

  it("压缩请求失败时回退到首次草稿的保守截断", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { content: "长".repeat(180) } }],
      }), { status: 200, headers: { "Content-Type": "application/json" } }))
      .mockRejectedValueOnce(new Error("repair failed"));

    const draft = await generateGreetingDraft(CONFIG, "secret", JOB, fetcher);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(countGreetingCharacters(draft)).toBeLessThanOrEqual(150);
    expect(validateGreetingDraft(draft)).toBe(draft);
  });

  it("按照配置的秒数取消超时请求", async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn((_input: RequestInfo | URL, request?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        request?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      }));
      const result = expect(generateGreetingDraft(
        { ...CONFIG, timeoutSeconds: 10 },
        "secret",
        JOB,
        fetcher,
      )).rejects.toThrow("超过 10 秒");

      await vi.advanceTimersByTimeAsync(10_000);
      await result;
    } finally {
      vi.useRealTimers();
    }
  });
});
