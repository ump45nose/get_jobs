import { describe, expect, it, vi } from "vitest";
import {
  buildChatCompletionsUrl,
  extractGreetingText,
  generateGreetingDraft,
  validateGreetingDraft,
} from "./ai";
import type { LiepinAiConfig, LiepinJobSnapshot } from "../shared/types";

const CONFIG: LiepinAiConfig = {
  baseUrl: "https://api.example.com/v1",
  model: "test-model",
  resumeSummary: "5 年 Java 与 AI 应用经验，负责 Agent 和 RAG 项目落地。",
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
  it("规范化 OpenAI 兼容地址并限制不安全协议", () => {
    expect(buildChatCompletionsUrl("https://api.example.com/v1")).toBe(
      "https://api.example.com/v1/chat/completions",
    );
    expect(buildChatCompletionsUrl("http://127.0.0.1:8000/v1")).toBe(
      "http://127.0.0.1:8000/v1/chat/completions",
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

  it("拒绝空草稿、人工判断和超长内容", () => {
    expect(() => validateGreetingDraft("需人工判断")).toThrow();
    expect(() => validateGreetingDraft(" ")).toThrow();
    expect(() => validateGreetingDraft("a".repeat(151))).toThrow("150 字");
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
  });
});
