import { describe, expect, it } from "vitest";
import {
  DEFAULT_BATCH_INTERVAL,
  DEFAULT_LIEPIN_CONFIG,
  normalizeActionInterval,
  normalizeBatchConfig,
  normalizeBatchInterval,
  normalizeResumeReceiptTimeoutSeconds,
  randomActionDelayMilliseconds,
  randomBatchDelayMilliseconds,
} from "./defaults";

describe("顺序投递随机间隔", () => {
  it("默认启用合规兜底招呼语并关闭完整敏感日志", () => {
    expect(DEFAULT_LIEPIN_CONFIG.ai.useFallbackGreeting).toBe(true);
    expect(DEFAULT_LIEPIN_CONFIG.ai.fallbackGreeting.length).toBeGreaterThan(0);
    expect(DEFAULT_LIEPIN_CONFIG.ai.fallbackGreeting.length).toBeLessThanOrEqual(150);
    expect(DEFAULT_LIEPIN_CONFIG.ai.detailedLogging).toBe(false);
  });

  it("规整越界、倒置和缺失的间隔值", () => {
    expect(normalizeBatchInterval(80, 20)).toEqual({
      minIntervalSeconds: 20,
      maxIntervalSeconds: 80,
    });
    expect(normalizeBatchInterval(1, 900)).toEqual({
      minIntervalSeconds: 5,
      maxIntervalSeconds: 300,
    });
    expect(normalizeBatchInterval(undefined, undefined)).toEqual({
      minIntervalSeconds: DEFAULT_BATCH_INTERVAL.minIntervalSeconds,
      maxIntervalSeconds: DEFAULT_BATCH_INTERVAL.maxIntervalSeconds,
    });
  });

  it("在闭区间内生成随机等待毫秒数", () => {
    const interval = { minIntervalSeconds: 15, maxIntervalSeconds: 45 };
    expect(randomBatchDelayMilliseconds(interval, () => 0)).toBe(15_000);
    expect(randomBatchDelayMilliseconds(interval, () => 0.999999)).toBe(45_000);
  });

  it("规整并生成单岗位内部动作随机等待", () => {
    expect(normalizeActionInterval(8, 0.1)).toEqual({
      minActionIntervalSeconds: 0.5,
      maxActionIntervalSeconds: 8,
    });
    const interval = { minActionIntervalSeconds: 1.5, maxActionIntervalSeconds: 3.5 };
    expect(randomActionDelayMilliseconds(interval, () => 0)).toBe(1_500);
    expect(randomActionDelayMilliseconds(interval, () => 0.999999)).toBe(3_500);
  });

  it("把缺少动作配置的旧默认岗位间隔迁移为新默认值", () => {
    const migrated = normalizeBatchConfig({
      minIntervalSeconds: 15,
      maxIntervalSeconds: 45,
      maxBatchSize: 10,
      maxDailyDeliveries: 30,
      cooldownEvery: 5,
      cooldownSeconds: 180,
    });
    expect(migrated.minIntervalSeconds).toBe(5);
    expect(migrated.maxIntervalSeconds).toBe(15);
    expect(migrated.minActionIntervalSeconds).toBe(1.5);
    expect(migrated.maxActionIntervalSeconds).toBe(3.5);
  });

  it("规整批次、每日额度和长冷却护栏", () => {
    expect(normalizeBatchConfig({
      minIntervalSeconds: 20,
      maxIntervalSeconds: 40,
      minActionIntervalSeconds: 99,
      maxActionIntervalSeconds: 0,
      maxBatchSize: 99,
      maxDailyDeliveries: 0,
      cooldownEvery: 1,
      cooldownSeconds: 9_999,
    })).toEqual({
      minIntervalSeconds: 20,
      maxIntervalSeconds: 40,
      minActionIntervalSeconds: 0.5,
      maxActionIntervalSeconds: 10,
      resumeReceiptTimeoutSeconds: 30,
      maxBatchSize: 20,
      maxDailyDeliveries: 1,
      cooldownEvery: 3,
      cooldownSeconds: 900,
    });
  });

  it("规整简历回执等待时长并兼容旧配置", () => {
    expect(normalizeResumeReceiptTimeoutSeconds(undefined)).toBe(30);
    expect(normalizeResumeReceiptTimeoutSeconds(1)).toBe(10);
    expect(normalizeResumeReceiptTimeoutSeconds(999)).toBe(120);
    expect(normalizeResumeReceiptTimeoutSeconds(45.6)).toBe(46);
    expect(normalizeBatchConfig({}).resumeReceiptTimeoutSeconds).toBe(30);
  });
});
