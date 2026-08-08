import type { LiepinBatchConfig, LiepinConfig, TaskState } from "./types";

/** AI 请求允许配置的最短超时时间。 */
export const MIN_AI_TIMEOUT_SECONDS = 10;

/** AI 请求允许配置的最长超时时间。 */
export const MAX_AI_TIMEOUT_SECONDS = 600;

/** 本机大模型首次加载可能较慢，因此默认等待两分钟。 */
export const DEFAULT_AI_TIMEOUT_SECONDS = 120;

/** 新安装与旧配置迁移使用的完整 AI 招呼语提示词模板。 */
export const DEFAULT_GREETING_PROMPT_TEMPLATE = `你是求职者的首次沟通文案助手。请根据以下真实信息，为当前岗位生成自然、具体、有针对性的中文招呼语。

求职者真实经历摘要：
{{resumeSummary}}

岗位名称：{{jobTitle}}
公司：{{companyName}}
地点：{{jobArea}}
薪资：{{jobSalary}}
学历要求：{{jobEducation}}
经验要求：{{jobExperience}}
公司行业：{{companyIndustry}}
公司规模：{{companyScale}}
招聘者：{{hrName}}
招聘者职位：{{hrTitle}}

突出一到两个最相关的真实匹配点，并以一个便于继续沟通的具体问题收尾。不得编造技能、年限、学历、项目或业绩。`;

/** 当前页顺序投递允许配置的最短随机间隔。 */
export const MIN_BATCH_INTERVAL_SECONDS = 5;

/** 当前页顺序投递允许配置的最长随机间隔。 */
export const MAX_BATCH_INTERVAL_SECONDS = 300;

/** 单岗位内部动作稳定等待允许配置为 0.5 至 10 秒。 */
export const MIN_ACTION_INTERVAL_SECONDS = 0.5;
export const MAX_ACTION_INTERVAL_SECONDS = 10;

/** 0.2.8 及以前的新安装默认岗位间隔，用于一次性识别旧配置迁移。 */
const LEGACY_DEFAULT_BATCH_INTERVAL = { minIntervalSeconds: 15, maxIntervalSeconds: 45 };

/** 单批岗位数允许的安全配置范围。 */
export const MIN_BATCH_SIZE = 1;
export const MAX_BATCH_SIZE = 20;

/** 本机单日新投递数允许的安全配置范围。 */
export const MIN_DAILY_DELIVERIES = 1;
export const MAX_DAILY_DELIVERIES = 50;

/** 连续成功后触发长冷却的计数范围。 */
export const MIN_COOLDOWN_EVERY = 3;
export const MAX_COOLDOWN_EVERY = 10;

/** 长冷却允许配置为 1 至 15 分钟。 */
export const MIN_COOLDOWN_SECONDS = 60;
export const MAX_COOLDOWN_SECONDS = 900;

/** 默认在两次岗位投递之间随机等待 5 至 15 秒，单岗位内部动作等待 1.5 至 3.5 秒。 */
export const DEFAULT_BATCH_INTERVAL: LiepinBatchConfig = {
  minIntervalSeconds: 5,
  maxIntervalSeconds: 15,
  minActionIntervalSeconds: 1.5,
  maxActionIntervalSeconds: 3.5,
  maxBatchSize: 10,
  maxDailyDeliveries: 30,
  cooldownEvery: 5,
  cooldownSeconds: 180,
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
): Pick<LiepinBatchConfig, "minIntervalSeconds" | "maxIntervalSeconds"> {
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
 * 规整单岗位内部动作的随机稳定等待，并保留一位小数配置精度。
 *
 * @param minValue 表单或存储提供的最短秒数。
 * @param maxValue 表单或存储提供的最长秒数。
 * @returns 可安全传给 Content Script 的动作等待区间。
 */
export function normalizeActionInterval(
  minValue: unknown,
  maxValue: unknown,
): Pick<LiepinBatchConfig, "minActionIntervalSeconds" | "maxActionIntervalSeconds"> {
  const normalizeValue = (value: unknown, fallback: number) => {
    if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
    const clamped = Math.min(MAX_ACTION_INTERVAL_SECONDS, Math.max(MIN_ACTION_INTERVAL_SECONDS, value));
    return Math.round(clamped * 10) / 10;
  };
  const normalizedMin = normalizeValue(minValue, DEFAULT_BATCH_INTERVAL.minActionIntervalSeconds);
  const normalizedMax = normalizeValue(maxValue, DEFAULT_BATCH_INTERVAL.maxActionIntervalSeconds);
  return {
    minActionIntervalSeconds: Math.min(normalizedMin, normalizedMax),
    maxActionIntervalSeconds: Math.max(normalizedMin, normalizedMax),
  };
}

/**
 * 规整顺序投递的数量和长冷却护栏，防止表单或旧存储绕过范围限制。
 *
 * @param value 待规整的批量配置。
 * @returns 包含随机间隔、数量配额和长冷却的完整配置。
 */
export function normalizeBatchConfig(value: Partial<LiepinBatchConfig> | undefined): LiepinBatchConfig {
  const normalizeInteger = (candidate: unknown, fallback: number, minimum: number, maximum: number) => {
    if (typeof candidate !== "number" || !Number.isFinite(candidate)) return fallback;
    return Math.min(maximum, Math.max(minimum, Math.round(candidate)));
  };
  const normalizedBatchInterval = normalizeBatchInterval(value?.minIntervalSeconds, value?.maxIntervalSeconds);
  const isLegacyWithoutActionInterval = typeof value?.minActionIntervalSeconds !== "number"
    && typeof value?.maxActionIntervalSeconds !== "number";
  const shouldMigrateLegacyDefault = isLegacyWithoutActionInterval
    && normalizedBatchInterval.minIntervalSeconds === LEGACY_DEFAULT_BATCH_INTERVAL.minIntervalSeconds
    && normalizedBatchInterval.maxIntervalSeconds === LEGACY_DEFAULT_BATCH_INTERVAL.maxIntervalSeconds;
  return {
    ...(shouldMigrateLegacyDefault
      ? {
          minIntervalSeconds: DEFAULT_BATCH_INTERVAL.minIntervalSeconds,
          maxIntervalSeconds: DEFAULT_BATCH_INTERVAL.maxIntervalSeconds,
        }
      : normalizedBatchInterval),
    ...normalizeActionInterval(value?.minActionIntervalSeconds, value?.maxActionIntervalSeconds),
    maxBatchSize: normalizeInteger(
      value?.maxBatchSize,
      DEFAULT_BATCH_INTERVAL.maxBatchSize,
      MIN_BATCH_SIZE,
      MAX_BATCH_SIZE,
    ),
    maxDailyDeliveries: normalizeInteger(
      value?.maxDailyDeliveries,
      DEFAULT_BATCH_INTERVAL.maxDailyDeliveries,
      MIN_DAILY_DELIVERIES,
      MAX_DAILY_DELIVERIES,
    ),
    cooldownEvery: normalizeInteger(
      value?.cooldownEvery,
      DEFAULT_BATCH_INTERVAL.cooldownEvery,
      MIN_COOLDOWN_EVERY,
      MAX_COOLDOWN_EVERY,
    ),
    cooldownSeconds: normalizeInteger(
      value?.cooldownSeconds,
      DEFAULT_BATCH_INTERVAL.cooldownSeconds,
      MIN_COOLDOWN_SECONDS,
      MAX_COOLDOWN_SECONDS,
    ),
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
  interval: Pick<LiepinBatchConfig, "minIntervalSeconds" | "maxIntervalSeconds">,
  random: () => number = Math.random,
): number {
  const normalized = normalizeBatchInterval(interval.minIntervalSeconds, interval.maxIntervalSeconds);
  const span = normalized.maxIntervalSeconds - normalized.minIntervalSeconds;
  const seconds = normalized.minIntervalSeconds + Math.floor(Math.min(0.999999999, Math.max(0, random())) * (span + 1));
  return seconds * 1_000;
}

/**
 * 生成单岗位两个页面动作之间的随机稳定等待毫秒数。
 *
 * @param interval 已规整或待规整的动作秒数区间。
 * @param random 随机数来源，测试时可注入固定值。
 * @returns 包含区间两端的整数毫秒数。
 */
export function randomActionDelayMilliseconds(
  interval: Pick<LiepinBatchConfig, "minActionIntervalSeconds" | "maxActionIntervalSeconds">,
  random: () => number = Math.random,
): number {
  const normalized = normalizeActionInterval(
    interval.minActionIntervalSeconds,
    interval.maxActionIntervalSeconds,
  );
  const minimum = Math.round(normalized.minActionIntervalSeconds * 1_000);
  const maximum = Math.round(normalized.maxActionIntervalSeconds * 1_000);
  const span = maximum - minimum;
  return minimum + Math.floor(Math.min(0.999999999, Math.max(0, random())) * (span + 1));
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
    promptTemplate: DEFAULT_GREETING_PROMPT_TEMPLATE,
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
