import type { LiepinConfig, TaskState } from "./types";

/** AI 请求允许配置的最短超时时间。 */
export const MIN_AI_TIMEOUT_SECONDS = 10;

/** AI 请求允许配置的最长超时时间。 */
export const MAX_AI_TIMEOUT_SECONDS = 600;

/** 本机大模型首次加载可能较慢，因此默认等待两分钟。 */
export const DEFAULT_AI_TIMEOUT_SECONDS = 120;

/**
 * 将未知 AI 超时值规整到安全范围内。
 *
 * @param value 存储或表单提供的超时秒数。
 * @returns 10 至 600 秒之间的整数；无效值使用默认值。
 */
export function normalizeAiTimeoutSeconds(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_AI_TIMEOUT_SECONDS;
  return Math.min(MAX_AI_TIMEOUT_SECONDS, Math.max(MIN_AI_TIMEOUT_SECONDS, Math.round(value)));
}

/** 新安装插件使用的猎聘配置。 */
export const DEFAULT_LIEPIN_CONFIG: LiepinConfig = {
  keywords: [],
  cityCode: "",
  salary: "",
  ai: {
    baseUrl: "https://api.openai.com/v1",
    model: "",
    timeoutSeconds: DEFAULT_AI_TIMEOUT_SECONDS,
    resumeSummary: "",
    previewBeforeSend: true,
    sendResume: true,
  },
};

/**
 * 创建新的空闲任务状态。
 *
 * @param message 展示给用户的初始消息。
 * @returns 可直接持久化的任务状态。
 */
export function createIdleTask(message = "尚未开始投递"): TaskState {
  return {
    platform: "liepin",
    status: "idle",
    updatedAt: new Date().toISOString(),
    message,
  };
}
