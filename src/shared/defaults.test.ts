import { describe, expect, it } from "vitest";
import {
  DEFAULT_BATCH_INTERVAL,
  normalizeBatchConfig,
  normalizeBatchInterval,
  randomBatchDelayMilliseconds,
} from "./defaults";

describe("顺序投递随机间隔", () => {
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

  it("规整批次、每日额度和长冷却护栏", () => {
    expect(normalizeBatchConfig({
      minIntervalSeconds: 20,
      maxIntervalSeconds: 40,
      maxBatchSize: 99,
      maxDailyDeliveries: 0,
      cooldownEvery: 1,
      cooldownSeconds: 9_999,
    })).toEqual({
      minIntervalSeconds: 20,
      maxIntervalSeconds: 40,
      maxBatchSize: 20,
      maxDailyDeliveries: 1,
      cooldownEvery: 3,
      cooldownSeconds: 900,
    });
  });
});
