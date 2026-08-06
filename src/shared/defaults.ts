import type { LiepinBatchConfig, LiepinConfig, TaskState } from "./types";

/** AI 请求允许配置的最短超时时间。 */
export const MIN_AI_TIMEOUT_SECONDS = 10;

/** AI 请求允许配置的最长超时时间。 */
export const MAX_AI_TIMEOUT_SECONDS = 600;

/** 本机大模型首次加载可能较慢，因此默认等待两分钟。 */
export const DEFAULT_AI_TIMEOUT_SECONDS = 120;

/** 当前页顺序投递允许配置的最短随机间隔。 */
export const MIN_BATCH_INTERVAL_SECONDS = 5;

/** 当前页顺序投递允许配置的最长随机间隔。 */
export const MAX_BATCH_INTERVAL_SECONDS = 300;

/** 默认在两次岗位投递之间随机等待 15 至 45 秒。 */
export const DEFAULT_BATCH_INTERVAL: LiepinBatchConfig = {
  minIntervalSeconds: 15,
  maxIntervalSeconds: 45,
};

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

/**
 * 将批量投递间隔规整到安全范围，并确保最小值不大于最大值。
 *
 * @param minValue 表单或存储提供的最短秒数。
 * @param maxValue 表单或存储提供的最长秒数。
 * @returns 可直接保存和执行的随机间隔配置。
 */
export function normalizeBatchInterval(
  minValue: unknown,
  maxValue: unknown,
): LiepinBatchConfig {
  const normalizeValue = (value: unknown, fallback: number) => {
    if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
    return Math.min(MAX_BATCH_INTERVAL_SECONDS, Math.max(MIN_BATCH_INTERVAL_SECONDS, Math.round(value)));
  };
  const normalizedMin = normalizeValue(minValue, DEFAULT_BATCH_INTERVAL.minIntervalSeconds);
  const normalizedMax = normalizeValue(maxValue, DEFAULT_BATCH_INTERVAL.maxIntervalSeconds);
  return {
    minIntervalSeconds: Math.min(normalizedMin, normalizedMax),
    maxIntervalSeconds: Math.max(normalizedMin, normalizedMax),
  };
}

/**
 * 生成两次岗位投递之间的随机等待毫秒数。
 *
 * @param interval 已规整的秒数区间。
 * @param random 随机数来源，测试时可注入固定值。
 * @returns 包含区间两端的整数毫秒数。
 */
export function randomBatchDelayMilliseconds(
  interval: LiepinBatchConfig,
  random: () => number = Math.random,
): number {
  const normalized = normalizeBatchInterval(interval.minIntervalSeconds, interval.maxIntervalSeconds);
  const span = normalized.maxIntervalSeconds - normalized.minIntervalSeconds;
  const seconds = normalized.minIntervalSeconds + Math.floor(Math.min(0.999999999, Math.max(0, random())) * (span + 1));
  return seconds * 1_000;
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
  batch: DEFAULT_BATCH_INTERVAL,
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
