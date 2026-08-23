import { describe, expect, it } from "vitest";
import { DEFAULT_BATCH_INTERVAL } from "./defaults";
import {
  containsLiepinRiskSignal,
  getLiepinSafetyStatus,
  normalizeLiepinSafetyState,
  recordLiepinDeliverySuccess,
} from "./liepin-safety";

describe("猎聘投递账号安全状态", () => {
  const now = new Date("2026-08-08T02:00:00.000Z");

  it("跨本地日期后重置计数但保留未结束冷却", () => {
    const state = normalizeLiepinSafetyState({
      dayKey: "2000-01-01",
      dailyDeliveries: 20,
      consecutiveDeliveries: 4,
      cooldownUntil: "2099-01-01T00:00:00.000Z",
      updatedAt: "2000-01-01T00:00:00.000Z",
    }, now);

    expect(state.dailyDeliveries).toBe(0);
    expect(state.consecutiveDeliveries).toBe(0);
    expect(state.cooldownUntil).toBe("2099-01-01T00:00:00.000Z");
  });

  it("清理已经结束的冷却时间", () => {
    const state = normalizeLiepinSafetyState({
      dayKey: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`,
      dailyDeliveries: 2,
      consecutiveDeliveries: 1,
      cooldownUntil: "2000-01-01T00:00:00.000Z",
      updatedAt: "2000-01-01T00:00:00.000Z",
    }, now);

    expect(state.cooldownUntil).toBeUndefined();
  });

  it("达到连续成功阈值后启动持久化长冷却", () => {
    const before = {
      dayKey: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`,
      dailyDeliveries: 4,
      consecutiveDeliveries: DEFAULT_BATCH_INTERVAL.cooldownEvery - 1,
      updatedAt: now.toISOString(),
    };
    const recorded = recordLiepinDeliverySuccess(before, DEFAULT_BATCH_INTERVAL, now);
    const status = getLiepinSafetyStatus(recorded, DEFAULT_BATCH_INTERVAL, now);

    expect(recorded.dailyDeliveries).toBe(5);
    expect(recorded.consecutiveDeliveries).toBe(0);
    expect(status.cooldownRemainingSeconds).toBe(DEFAULT_BATCH_INTERVAL.cooldownSeconds);
    expect(status.blockedReason).toContain("安全冷却");
  });

  it("每日额度耗尽后阻止继续启动", () => {
    const dayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const status = getLiepinSafetyStatus({
      dayKey,
      dailyDeliveries: DEFAULT_BATCH_INTERVAL.maxDailyDeliveries,
      consecutiveDeliveries: 0,
      updatedAt: now.toISOString(),
    }, DEFAULT_BATCH_INTERVAL, now);

    expect(status.remainingDailyDeliveries).toBe(0);
    expect(status.blockedReason).toContain("今日已达到");
  });

  it("只把明确安全和限流提示视为熔断信号", () => {
    expect(containsLiepinRiskSignal("您的操作过于频繁，请稍后再试")).toBe(true);
    expect(containsLiepinRiskSignal("账号异常，请完成安全验证")).toBe(true);
    expect(containsLiepinRiskSignal("招聘方回复可能比较慢")).toBe(false);
  });
});
