import type { LiepinBatchConfig, LiepinSafetyState, LiepinSafetyStatus } from "./types";

/**
 * 生成浏览器本地时区的日期键，午夜后自动切换每日配额。
 *
 * @param now 当前时间。
 * @returns YYYY-MM-DD 日期键。
 */
export function getLocalDayKey(now: Date): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * 读取或初始化当天安全状态；跨日时清空旧日计数，但保留尚未结束的长冷却。
 *
 * @param stored 扩展存储中的旧状态。
 * @param now 当前时间。
 * @returns 当天可用的规范化状态。
 */
export function normalizeLiepinSafetyState(
  stored: Partial<LiepinSafetyState> | undefined,
  now: Date = new Date(),
): LiepinSafetyState {
  const dayKey = getLocalDayKey(now);
  const storedCooldownUntil = typeof stored?.cooldownUntil === "string" ? stored.cooldownUntil : undefined;
  const storedCooldownTimestamp = storedCooldownUntil ? Date.parse(storedCooldownUntil) : Number.NaN;
  // 冷却是跨日期的绝对时间窗口，不能因为午夜重置每日计数而提前失效。
  const activeCooldownUntil = Number.isFinite(storedCooldownTimestamp) && storedCooldownTimestamp > now.getTime()
    ? storedCooldownUntil
    : undefined;
  if (stored?.dayKey !== dayKey) {
    return {
      dayKey,
      dailyDeliveries: 0,
      consecutiveDeliveries: 0,
      cooldownUntil: activeCooldownUntil,
      updatedAt: now.toISOString(),
    };
  }
  return {
    dayKey,
    dailyDeliveries: Number.isFinite(stored.dailyDeliveries)
      ? Math.max(0, Math.floor(stored.dailyDeliveries as number))
      : 0,
    consecutiveDeliveries: Number.isFinite(stored.consecutiveDeliveries)
      ? Math.max(0, Math.floor(stored.consecutiveDeliveries as number))
      : 0,
    cooldownUntil: activeCooldownUntil,
    updatedAt: typeof stored.updatedAt === "string" ? stored.updatedAt : now.toISOString(),
  };
}

/**
 * 将持久化计数映射为可展示和可执行的安全状态。
 *
 * @param stored 当前持久化状态。
 * @param config 顺序投递安全配置。
 * @param now 当前时间。
 * @returns 剩余额度、冷却秒数和阻断原因。
 */
export function getLiepinSafetyStatus(
  stored: Partial<LiepinSafetyState> | undefined,
  config: LiepinBatchConfig,
  now: Date = new Date(),
): LiepinSafetyStatus {
  const state = normalizeLiepinSafetyState(stored, now);
  const cooldownTimestamp = state.cooldownUntil ? Date.parse(state.cooldownUntil) : Number.NaN;
  const cooldownRemainingSeconds = Number.isFinite(cooldownTimestamp)
    ? Math.max(0, Math.ceil((cooldownTimestamp - now.getTime()) / 1_000))
    : 0;
  const remainingDailyDeliveries = Math.max(0, config.maxDailyDeliveries - state.dailyDeliveries);
  const blockedReason = cooldownRemainingSeconds > 0
    ? `账号安全冷却中，约 ${cooldownRemainingSeconds} 秒后可继续`
    : remainingDailyDeliveries === 0
      ? `今日已达到 ${config.maxDailyDeliveries} 个新投递上限`
      : undefined;
  return {
    ...state,
    remainingDailyDeliveries,
    cooldownRemainingSeconds,
    blockedReason,
  };
}

/**
 * 记录一次明确成功的新投递，并按阈值启动长冷却。
 *
 * @param stored 当前持久化状态。
 * @param config 顺序投递安全配置。
 * @param now 成功回执时间。
 * @returns 需要写回扩展存储的新状态。
 */
export function recordLiepinDeliverySuccess(
  stored: Partial<LiepinSafetyState> | undefined,
  config: LiepinBatchConfig,
  now: Date = new Date(),
): LiepinSafetyState {
  const state = normalizeLiepinSafetyState(stored, now);
  const consecutiveDeliveries = state.consecutiveDeliveries + 1;
  const triggerCooldown = consecutiveDeliveries >= config.cooldownEvery;
  return {
    dayKey: state.dayKey,
    dailyDeliveries: state.dailyDeliveries + 1,
    consecutiveDeliveries: triggerCooldown ? 0 : consecutiveDeliveries,
    cooldownUntil: triggerCooldown
      ? new Date(now.getTime() + config.cooldownSeconds * 1_000).toISOString()
      : state.cooldownUntil,
    updatedAt: now.toISOString(),
  };
}

/**
 * 判断可见平台提示是否属于必须熔断的安全或限流信号。
 *
 * @param text 弹窗或警告文本。
 * @returns 命中强风险短语时返回 true。
 */
export function containsLiepinRiskSignal(text: string): boolean {
  return /验证码|安全验证|完成验证|操作频繁|访问频繁|请求频繁|操作过于频繁|稍后再试|账号异常|风险控制|安全策略/.test(text);
}
