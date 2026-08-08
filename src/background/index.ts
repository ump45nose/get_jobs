import {
  listRecentAttempts,
  listRecentZhilianAttempts,
  saveDeliveryAttempt,
  saveZhilianDeliveryAttempt,
} from "./database";
import { generateGreetingDraftWithFallback } from "./ai";
import {
  DEFAULT_LIEPIN_CONFIG,
  createIdleTask,
  normalizeAiTimeoutSeconds,
  normalizeBatchConfig,
  normalizeZhilianConfig,
} from "../shared/defaults";
import {
  getLiepinSafetyStatus as buildLiepinSafetyStatus,
  recordLiepinDeliverySuccess,
} from "../shared/liepin-safety";
import type {
  AppState,
  AiDiagnosticLog,
  BackgroundRequest,
  ContentRequest,
  DeliveryAttempt,
  ExtensionResponse,
  LiepinConfig,
  LiepinSafetyState,
  LiepinSafetyStatus,
  TaskState,
  TaskStatus,
  ZhilianAppState,
  ZhilianConfig,
  ZhilianDeliveryAttempt,
  ZhilianExternalOutcome,
  ZhilianTaskState,
} from "../shared/types";

const CONFIG_KEY = "liepinConfig";
const AI_SECRET_KEY = "liepinAiSecret";
const AI_DIAGNOSTICS_KEY = "liepinAiDiagnostics";
const TASK_KEY = "liepinTask";
const SAFETY_KEY = "liepinSafety";
const WATCHDOG_ALARM = "liepin-task-watchdog";
const ZHILIAN_TASK_KEY = "zhilianTask";
const ZHILIAN_CONFIG_KEY = "zhilianConfig";
const ZHILIAN_SAFETY_KEY = "zhilianSafety";
const ZHILIAN_WATCHDOG_ALARM = "zhilian-task-watchdog";
/** 动作间隔最高可配置 10 秒，完整页面闭环最长允许三分钟后再判定失联。 */
const WATCHDOG_DELAY_MINUTES = 3;
/** 诊断日志只保留最近 20 次 POST，避免扩展本地存储无限增长。 */
const MAX_AI_DIAGNOSTICS = 20;

let taskMutationQueue: Promise<void> = Promise.resolve();
let diagnosticMutationQueue: Promise<void> = Promise.resolve();

/**
 * 串行执行任务状态读写，防止两个助手实例同时从 idle 启动任务。
 *
 * @param operation 单次原子业务操作。
 * @returns 操作结果。
 */
function withTaskMutation<T>(operation: () => Promise<T>): Promise<T> {
  const result = taskMutationQueue.then(operation, operation);
  taskMutationQueue = result.then(() => undefined, () => undefined);
  return result;
}

/**
 * 清除当前单任务看门狗。
 *
 * @returns 清除完成时返回。
 */
async function clearWatchdog(): Promise<void> {
  await chrome.alarms.clear(WATCHDOG_ALARM);
}

/** 清除智联单岗位任务看门狗。 */
async function clearZhilianWatchdog(): Promise<void> {
  await chrome.alarms.clear(ZHILIAN_WATCHDOG_ALARM);
}

/** 读取并规整智联独立配置。 */
async function getZhilianConfig(): Promise<ZhilianConfig> {
  const stored = await chrome.storage.local.get(ZHILIAN_CONFIG_KEY);
  return normalizeZhilianConfig(stored[ZHILIAN_CONFIG_KEY] as Partial<ZhilianConfig> | undefined);
}

/** 读取智联独立每日配额与长冷却状态。 */
async function getZhilianSafetyStatus(config: ZhilianConfig): Promise<LiepinSafetyStatus> {
  const stored = await chrome.storage.local.get(ZHILIAN_SAFETY_KEY);
  const safety = stored[ZHILIAN_SAFETY_KEY] as Partial<LiepinSafetyState> | undefined;
  return buildLiepinSafetyStatus(safety, config.batch);
}

/** 仅在智联明确成功时增加本平台额度并计算下一次长冷却。 */
async function recordSuccessfulZhilianDelivery(config: ZhilianConfig): Promise<LiepinSafetyState> {
  const stored = await chrome.storage.local.get(ZHILIAN_SAFETY_KEY);
  const safety = stored[ZHILIAN_SAFETY_KEY] as Partial<LiepinSafetyState> | undefined;
  const next = recordLiepinDeliverySuccess(safety, config.batch);
  await chrome.storage.local.set({ [ZHILIAN_SAFETY_KEY]: next });
  return next;
}

/**
 * 从扩展存储读取配置，缺失时使用安全默认值。
 *
 * @returns 猎聘配置。
 */
async function getConfig(): Promise<LiepinConfig> {
  const stored = await chrome.storage.local.get(CONFIG_KEY);
  const saved = stored[CONFIG_KEY] as Partial<LiepinConfig> | undefined;
  const savedAi = saved?.ai && typeof saved.ai === "object" ? saved.ai : undefined;
  const savedBatch = saved?.batch && typeof saved.batch === "object" ? saved.batch : undefined;
  return {
    keywords: Array.isArray(saved?.keywords)
      ? saved.keywords.filter((item): item is string => typeof item === "string")
      : DEFAULT_LIEPIN_CONFIG.keywords,
    cityCode: typeof saved?.cityCode === "string" ? saved.cityCode : DEFAULT_LIEPIN_CONFIG.cityCode,
    salary: typeof saved?.salary === "string" ? saved.salary : DEFAULT_LIEPIN_CONFIG.salary,
    ai: {
      baseUrl: typeof savedAi?.baseUrl === "string" ? savedAi.baseUrl : DEFAULT_LIEPIN_CONFIG.ai.baseUrl,
      model: typeof savedAi?.model === "string" ? savedAi.model : DEFAULT_LIEPIN_CONFIG.ai.model,
      timeoutSeconds: normalizeAiTimeoutSeconds(savedAi?.timeoutSeconds),
      resumeSummary: typeof savedAi?.resumeSummary === "string"
        ? savedAi.resumeSummary
        : DEFAULT_LIEPIN_CONFIG.ai.resumeSummary,
      promptTemplate: typeof savedAi?.promptTemplate === "string"
        ? savedAi.promptTemplate
        : DEFAULT_LIEPIN_CONFIG.ai.promptTemplate,
      useFallbackGreeting: typeof savedAi?.useFallbackGreeting === "boolean"
        ? savedAi.useFallbackGreeting
        : DEFAULT_LIEPIN_CONFIG.ai.useFallbackGreeting,
      fallbackGreeting: typeof savedAi?.fallbackGreeting === "string"
        ? savedAi.fallbackGreeting
        : DEFAULT_LIEPIN_CONFIG.ai.fallbackGreeting,
      detailedLogging: typeof savedAi?.detailedLogging === "boolean"
        ? savedAi.detailedLogging
        : DEFAULT_LIEPIN_CONFIG.ai.detailedLogging,
      previewBeforeSend: typeof savedAi?.previewBeforeSend === "boolean"
        ? savedAi.previewBeforeSend
        : DEFAULT_LIEPIN_CONFIG.ai.previewBeforeSend,
      sendResume: typeof savedAi?.sendResume === "boolean"
        ? savedAi.sendResume
        : DEFAULT_LIEPIN_CONFIG.ai.sendResume,
    },
    batch: normalizeBatchConfig(savedBatch),
  };
}

/**
 * 读取当前配置下的持久化账号安全状态。
 *
 * @param config 已规范化的猎聘配置。
 * @returns 包含每日剩余额度和冷却时间的状态。
 */
async function getSafetyStatus(config: LiepinConfig): Promise<LiepinSafetyStatus> {
  const stored = await chrome.storage.local.get(SAFETY_KEY);
  const safety = stored[SAFETY_KEY] as Partial<LiepinSafetyState> | undefined;
  return buildLiepinSafetyStatus(safety, config.batch);
}

/**
 * 记录一次明确成功的新投递，`already-contacted` 不消耗额度。
 *
 * @param config 当前猎聘配置。
 * @returns 写入后的安全状态。
 */
async function recordSuccessfulDelivery(config: LiepinConfig): Promise<LiepinSafetyState> {
  const stored = await chrome.storage.local.get(SAFETY_KEY);
  const safety = stored[SAFETY_KEY] as Partial<LiepinSafetyState> | undefined;
  const next = recordLiepinDeliverySuccess(safety, config.batch);
  await chrome.storage.local.set({ [SAFETY_KEY]: next });
  return next;
}

/**
 * 读取仅供扩展可信页面使用的 AI 接口密钥。
 *
 * @returns 已保存密钥，未配置时返回空字符串。
 */
async function getAiApiKey(): Promise<string> {
  const stored = await chrome.storage.local.get(AI_SECRET_KEY);
  return typeof stored[AI_SECRET_KEY] === "string" ? stored[AI_SECRET_KEY] : "";
}

/**
 * 读取最近 AI POST 诊断；记录中从不包含真实 Authorization。
 *
 * @returns 按时间倒序排列的诊断记录。
 */
async function getAiDiagnostics(): Promise<AiDiagnosticLog[]> {
  const stored = await chrome.storage.local.get(AI_DIAGNOSTICS_KEY);
  const logs = stored[AI_DIAGNOSTICS_KEY];
  return Array.isArray(logs) ? (logs as AiDiagnosticLog[]) : [];
}

/**
 * 串行追加一条脱敏 AI 请求诊断并限制保留数量。
 *
 * @param diagnostic 单次 POST 请求诊断。
 * @returns 写入完成时返回。
 */
function recordAiDiagnostic(diagnostic: AiDiagnosticLog): Promise<void> {
  const operation = diagnosticMutationQueue.then(async () => {
    const current = await getAiDiagnostics();
    await chrome.storage.local.set({
      [AI_DIAGNOSTICS_KEY]: [diagnostic, ...current].slice(0, MAX_AI_DIAGNOSTICS),
    });
  });
  diagnosticMutationQueue = operation.catch(() => undefined);
  return operation;
}

/**
 * 限制本地扩展存储只向可信扩展页面开放，阻止 Content Script 直接读取密钥。
 *
 * @returns 设置完成时返回。
 */
async function protectLocalStorage(): Promise<void> {
  await chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
}

/**
 * 从扩展存储读取持久化任务状态。
 *
 * @returns 当前任务状态。
 */
async function getTask(): Promise<TaskState> {
  const stored = await chrome.storage.local.get(TASK_KEY);
  return (stored[TASK_KEY] as TaskState | undefined) ?? createIdleTask();
}

/**
 * 保存任务状态并自动刷新更新时间。
 *
 * @param task 目标任务状态。
 * @returns 保存后的完整状态。
 */
async function saveTask(task: TaskState): Promise<TaskState> {
  const next = { ...task, updatedAt: new Date().toISOString() };
  await chrome.storage.local.set({ [TASK_KEY]: next });
  return next;
}

/** 创建智联空闲任务状态。 */
function createIdleZhilianTask(message = "尚未开始智联投递"): ZhilianTaskState {
  return {
    platform: "zhilian",
    status: "idle",
    updatedAt: new Date().toISOString(),
    message,
  };
}

/** 读取智联独立任务状态。 */
async function getZhilianTask(): Promise<ZhilianTaskState> {
  const stored = await chrome.storage.local.get(ZHILIAN_TASK_KEY);
  return (stored[ZHILIAN_TASK_KEY] as ZhilianTaskState | undefined) ?? createIdleZhilianTask();
}

/** 保存智联任务状态并刷新更新时间。 */
async function saveZhilianTask(task: ZhilianTaskState): Promise<ZhilianTaskState> {
  const next = { ...task, updatedAt: new Date().toISOString() };
  await chrome.storage.local.set({ [ZHILIAN_TASK_KEY]: next });
  return next;
}

/** 将智联申请结果映射为任务最终状态。 */
function zhilianOutcomeToStatus(outcome: ZhilianDeliveryAttempt["outcome"]): TaskStatus {
  if (outcome === "delivered" || outcome === "already-applied") return "success";
  if (outcome === "cancelled") return "cancelled";
  if (outcome === "blocked") return "blocked";
  return "failed";
}

/** 判断标签页是否属于智联招聘域名。 */
function isZhilianUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    return /(^|\.)zhaopin\.com$/i.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** 查询本次新开的唯一智联标签页，并让其继续等待明确申请回执。 */
async function continueZhilianExternalApplication(
  sender: chrome.runtime.MessageSender,
  knownTabIds: number[],
  taskId: string,
  config: ZhilianConfig,
): Promise<ZhilianExternalOutcome> {
  const sourceTabId = sender.tab?.id;
  if (sourceTabId === undefined) return { outcome: "unknown" };
  const tabs = await chrome.tabs.query({});
  const candidates = tabs.filter((tab) =>
    tab.id !== undefined
    && tab.id !== sourceTabId
    && tab.openerTabId === sourceTabId
    && isZhilianUrl(tab.url)
    && !knownTabIds.includes(tab.id!),
  );
  if (candidates.length === 0) return { outcome: "unknown" };
  if (candidates.length !== 1) {
    return { outcome: "failed", evidence: "检测到多个新智联标签页，无法安全归因本次申请" };
  }
  const tab = candidates[0];
  try {
    const response = await chrome.tabs.sendMessage(tab.id!, {
      type: "COMPLETE_ZHILIAN_APPLICATION",
      taskId,
      config,
    } satisfies ContentRequest) as ExtensionResponse<ZhilianExternalOutcome>;
    if (!response.ok) return { outcome: "failed", evidence: response.error || "智联结果页处理失败" };
    return { ...(response.data ?? { outcome: "unknown" as const }), tabId: tab.id };
  } catch {
    // 新标签页 Content Script 仍在加载时由列表页继续短轮询，不做自动重试点击。
    return { outcome: "unknown" };
  }
}

/** 关闭本次列表页明确打开且已确认成功的结果标签页。 */
async function closeZhilianExternalSuccessTab(
  sender: chrome.runtime.MessageSender,
  tabId: number,
): Promise<void> {
  const sourceTabId = sender.tab?.id;
  if (sourceTabId === undefined) throw new Error("无法确认智联来源标签页，未关闭结果页");
  const tab = await chrome.tabs.get(tabId);
  if (tab.openerTabId !== sourceTabId || !isZhilianUrl(tab.url)) {
    throw new Error("结果标签页不属于本次智联任务，已拒绝关闭");
  }
  await chrome.tabs.remove(tabId);
}

/** 列出当前智联列表页已经打开的结果标签，供点击前建立基线。 */
async function listZhilianExternalTabIds(sender: chrome.runtime.MessageSender): Promise<number[]> {
  const sourceTabId = sender.tab?.id;
  if (sourceTabId === undefined) return [];
  const tabs = await chrome.tabs.query({});
  return tabs
    .filter((tab) => tab.id !== undefined && tab.openerTabId === sourceTabId && isZhilianUrl(tab.url))
    .map((tab) => tab.id!);
}

/**
 * 将业务结果映射为最终任务状态。
 *
 * @param outcome 投递业务结果。
 * @returns 可展示的任务状态。
 */
function outcomeToStatus(outcome: DeliveryAttempt["outcome"]): TaskStatus {
  if (outcome === "delivered" || outcome === "already-contacted") return "success";
  if (outcome === "cancelled") return "cancelled";
  if (outcome === "blocked") return "blocked";
  return "failed";
}

/**
 * 处理所有发送给 Service Worker 的业务消息。
 *
 * @param request 消息请求。
 * @param sender Chrome 提供的发送方上下文。
 * @returns 统一消息响应。
 */
async function handleRequest(
  request: BackgroundRequest,
  sender: chrome.runtime.MessageSender,
): Promise<ExtensionResponse<unknown>> {
  switch (request.type) {
    case "GET_APP_STATE": {
      const [config, apiKey, task, attempts] = await Promise.all([
        getConfig(),
        getAiApiKey(),
        getTask(),
        listRecentAttempts(),
      ]);
      const safety = await getSafetyStatus(config);
      const state: AppState = { config, aiApiKeyConfigured: Boolean(apiKey), task, attempts, safety };
      return { ok: true, data: state };
    }
    case "GET_ZHILIAN_APP_STATE": {
      const [config, task, attempts] = await Promise.all([
        getZhilianConfig(),
        getZhilianTask(),
        listRecentZhilianAttempts(),
      ]);
      const safety = await getZhilianSafetyStatus(config);
      const state: ZhilianAppState = { config, task, attempts, safety };
      return { ok: true, data: state };
    }
    case "GET_ZHILIAN_SAFETY_STATUS": {
      const config = await getZhilianConfig();
      return { ok: true, data: await getZhilianSafetyStatus(config) };
    }
    case "SAVE_ZHILIAN_CONFIG": {
      const config = normalizeZhilianConfig(request.config);
      await chrome.storage.local.set({ [ZHILIAN_CONFIG_KEY]: config });
      return { ok: true, data: config };
    }
    case "GET_LIEPIN_SAFETY_STATUS": {
      const config = await getConfig();
      return { ok: true, data: await getSafetyStatus(config) };
    }
    case "SAVE_LIEPIN_CONFIG": {
      const config: LiepinConfig = {
        keywords: request.config.keywords.map((item) => item.trim()).filter(Boolean),
        cityCode: request.config.cityCode.trim(),
        salary: request.config.salary.trim(),
        ai: {
          baseUrl: request.config.ai.baseUrl.trim(),
          model: request.config.ai.model.trim(),
          timeoutSeconds: normalizeAiTimeoutSeconds(request.config.ai.timeoutSeconds),
          resumeSummary: request.config.ai.resumeSummary.trim(),
          // 提示词内部换行属于用户模板的一部分，只清理首尾空白。
          promptTemplate: request.config.ai.promptTemplate.trim(),
          useFallbackGreeting: typeof request.config.ai.useFallbackGreeting === "boolean"
            ? request.config.ai.useFallbackGreeting
            : DEFAULT_LIEPIN_CONFIG.ai.useFallbackGreeting,
          fallbackGreeting: request.config.ai.fallbackGreeting.trim(),
          detailedLogging: typeof request.config.ai.detailedLogging === "boolean"
            ? request.config.ai.detailedLogging
            : DEFAULT_LIEPIN_CONFIG.ai.detailedLogging,
          previewBeforeSend: typeof request.config.ai.previewBeforeSend === "boolean"
            ? request.config.ai.previewBeforeSend
            : DEFAULT_LIEPIN_CONFIG.ai.previewBeforeSend,
          sendResume: typeof request.config.ai.sendResume === "boolean"
            ? request.config.ai.sendResume
            : DEFAULT_LIEPIN_CONFIG.ai.sendResume,
        },
        batch: normalizeBatchConfig(request.config.batch),
      };
      const values: Record<string, unknown> = { [CONFIG_KEY]: config };
      if (request.apiKey?.trim()) {
        values[AI_SECRET_KEY] = request.apiKey.trim();
      }
      await chrome.storage.local.set(values);
      // 重新读取密钥状态，避免助手界面只根据输入框内容乐观显示“已保存”。
      const aiApiKeyConfigured = Boolean(await getAiApiKey());
      return { ok: true, data: { config, aiApiKeyConfigured } };
    }
    case "CLEAR_LIEPIN_AI_KEY": {
      await chrome.storage.local.remove(AI_SECRET_KEY);
      return { ok: true, data: { cleared: true } };
    }
    case "GET_LIEPIN_AI_DIAGNOSTICS": {
      return { ok: true, data: await getAiDiagnostics() };
    }
    case "CLEAR_LIEPIN_AI_DIAGNOSTICS": {
      await chrome.storage.local.remove(AI_DIAGNOSTICS_KEY);
      return { ok: true, data: { cleared: true } };
    }
    case "GENERATE_LIEPIN_GREETING": {
      const [config, apiKey] = await Promise.all([getConfig(), getAiApiKey()]);
      const draft = await generateGreetingDraftWithFallback(
        config.ai,
        apiKey,
        request.job,
        fetch,
        recordAiDiagnostic,
      );
      return { ok: true, data: draft };
    }
    case "START_LIEPIN_TASK": {
      return withTaskMutation(async () => {
        const current = await getTask();
        if (current.status === "running" || current.status === "stopping") {
          return { ok: false, error: "已有猎聘任务正在运行" };
        }
        const zhilianTask = await getZhilianTask();
        if (zhilianTask.status === "running") {
          return { ok: false, error: "已有智联任务正在运行，请完成后再开始猎聘任务" };
        }
        const config = await getConfig();
        const safety = await getSafetyStatus(config);
        if (safety.blockedReason) {
          return { ok: false, error: safety.blockedReason };
        }
        const now = new Date().toISOString();
        const task = await saveTask({
          platform: "liepin",
          status: "running",
          taskId: crypto.randomUUID(),
          tabId: request.tabId,
          cardKey: request.job.cardKey,
          jobId: request.job.jobId,
          startedAt: now,
          updatedAt: now,
          message: `正在投递：${request.job.jobTitle}`,
        });
        // 随机动作等待和平台回执轮询均计入任务时间，超过三分钟才视为消息链路失联。
        await chrome.alarms.create(WATCHDOG_ALARM, { delayInMinutes: WATCHDOG_DELAY_MINUTES });
        return { ok: true, data: task };
      });
    }
    case "REQUEST_LIEPIN_STOP": {
      return withTaskMutation(async () => {
        const current = await getTask();
        if (current.taskId !== request.taskId || current.status !== "running") {
          return { ok: true, data: current };
        }
        const task = await saveTask({ ...current, status: "stopping", message: "正在停止任务…" });
        return { ok: true, data: task };
      });
    }
    case "FINALIZE_LIEPIN_STOP": {
      return withTaskMutation(async () => {
        const current = await getTask();
        if (current.taskId !== request.taskId || current.status !== "stopping") {
          return { ok: true, data: current };
        }
        const task = await saveTask({ ...current, status: "cancelled", message: "任务已停止" });
        await clearWatchdog();
        return { ok: true, data: task };
      });
    }
    case "FAIL_LIEPIN_TASK": {
      return withTaskMutation(async () => {
        const current = await getTask();
        // 同时校验任务身份和活动状态，避免旧页面异常覆盖新的投递结果。
        if (
          current.taskId !== request.taskId ||
          (current.status !== "running" && current.status !== "stopping")
        ) {
          return { ok: true, data: current };
        }
        const task = await saveTask({ ...current, status: "failed", message: request.message });
        await clearWatchdog();
        return { ok: true, data: task };
      });
    }
    case "RECORD_LIEPIN_ATTEMPT": {
      const attempt: DeliveryAttempt = {
        ...request.result,
        taskId: request.taskId,
        platform: "liepin",
        createdAt: new Date().toISOString(),
      };
      await saveDeliveryAttempt(attempt);
      return withTaskMutation(async () => {
        const current = await getTask();
        // 迟到结果保留到历史记录，但绝不能覆盖另一个正在运行的任务。
        if (
          current.taskId !== request.taskId ||
          (current.status !== "running" && current.status !== "stopping")
        ) {
          return { ok: true, data: current };
        }
        if (attempt.outcome === "delivered") {
          // 只有当前活动任务的首次明确成功回执才增加额度，迟到或重复消息不会重复计数。
          await recordSuccessfulDelivery(await getConfig());
        }
        const task = await saveTask({
          ...current,
          status: outcomeToStatus(attempt.outcome),
          message: attempt.message,
        });
        await clearWatchdog();
        return { ok: true, data: task };
      });
    }
    case "CONTENT_READY": {
      return withTaskMutation(async () => {
        const current = await getTask();
        // 页面重新加载后不自动重复点击，要求用户先核对平台状态。
        if (current.status === "running" && current.tabId === sender.tab?.id) {
          const task = await saveTask({
            ...current,
            status: "interrupted",
            message: "猎聘页面已刷新，任务为避免重复投递而中止，请先核对沟通记录",
          });
          await clearWatchdog();
          return { ok: true, data: task };
        }
        return { ok: true, data: current };
      });
    }
    case "START_ZHILIAN_TASK": {
      return withTaskMutation(async () => {
        const current = await getZhilianTask();
        if (current.status === "running" || current.status === "stopping") {
          return { ok: false, error: "已有智联任务正在运行" };
        }
        const liepinTask = await getTask();
        if (liepinTask.status === "running" || liepinTask.status === "stopping") {
          return { ok: false, error: "已有猎聘任务正在运行，请完成后再开始智联任务" };
        }
        const config = await getZhilianConfig();
        const safety = await getZhilianSafetyStatus(config);
        if (safety.blockedReason) return { ok: false, error: safety.blockedReason };
        const now = new Date().toISOString();
        const task = await saveZhilianTask({
          platform: "zhilian",
          status: "running",
          taskId: crypto.randomUUID(),
          tabId: request.tabId,
          cardKey: request.job.cardKey,
          jobId: request.job.jobId,
          startedAt: now,
          updatedAt: now,
          message: `正在申请：${request.job.jobTitle}`,
        });
        // 动作等待与结果页轮询均计入任务时间，沿用三分钟失联窗口。
        await chrome.alarms.create(ZHILIAN_WATCHDOG_ALARM, { delayInMinutes: WATCHDOG_DELAY_MINUTES });
        return { ok: true, data: task };
      });
    }
    case "FAIL_ZHILIAN_TASK": {
      return withTaskMutation(async () => {
        const current = await getZhilianTask();
        if (current.taskId !== request.taskId || current.status !== "running") {
          return { ok: true, data: current };
        }
        const task = await saveZhilianTask({ ...current, status: "failed", message: request.message });
        await clearZhilianWatchdog();
        return { ok: true, data: task };
      });
    }
    case "CANCEL_ZHILIAN_TASK": {
      return withTaskMutation(async () => {
        const current = await getZhilianTask();
        if (current.taskId !== request.taskId || current.status !== "running") {
          return { ok: true, data: current };
        }
        // 同时通知本次列表页及其结果子标签，避免停止后子页继续提交简历。
        if (current.tabId !== undefined && current.taskId) {
          const tabs = await chrome.tabs.query({});
          const targets = tabs.filter((tab) => tab.id === current.tabId || tab.openerTabId === current.tabId);
          await Promise.all(targets.map((tab) => tab.id === undefined
            ? Promise.resolve()
            : chrome.tabs.sendMessage(tab.id, {
                type: "STOP_ZHILIAN_TASK",
                taskId: current.taskId!,
              } satisfies ContentRequest).catch(() => undefined)));
        }
        const task = await saveZhilianTask({ ...current, status: "cancelled", message: "智联任务已停止" });
        await clearZhilianWatchdog();
        return { ok: true, data: task };
      });
    }
    case "RECORD_ZHILIAN_ATTEMPT": {
      const attempt: ZhilianDeliveryAttempt = {
        ...request.result,
        taskId: request.taskId,
        platform: "zhilian",
        createdAt: new Date().toISOString(),
      };
      await saveZhilianDeliveryAttempt(attempt);
      return withTaskMutation(async () => {
        const current = await getZhilianTask();
        if (current.taskId !== request.taskId || current.status !== "running") {
          return { ok: true, data: current };
        }
        if (attempt.outcome === "delivered") {
          await recordSuccessfulZhilianDelivery(await getZhilianConfig());
        }
        const task = await saveZhilianTask({
          ...current,
          status: zhilianOutcomeToStatus(attempt.outcome),
          message: attempt.message,
        });
        await clearZhilianWatchdog();
        return { ok: true, data: task };
      });
    }
    case "CONTINUE_ZHILIAN_EXTERNAL_APPLICATION": {
      return {
        ok: true,
        data: await continueZhilianExternalApplication(
          sender,
          request.knownTabIds,
          request.taskId,
          request.config,
        ),
      };
    }
    case "CLOSE_ZHILIAN_EXTERNAL_SUCCESS_TAB": {
      await closeZhilianExternalSuccessTab(sender, request.tabId);
      return { ok: true, data: { closed: true } };
    }
    case "LIST_ZHILIAN_EXTERNAL_TABS": {
      return { ok: true, data: await listZhilianExternalTabIds(sender) };
    }
    case "ZHILIAN_CONTENT_READY": {
      return withTaskMutation(async () => {
        const current = await getZhilianTask();
        if (current.status === "running" && current.tabId === sender.tab?.id) {
          const task = await saveZhilianTask({
            ...current,
            status: "interrupted",
            message: "智联页面已刷新，任务为避免重复投递而中止，请先核对投递记录",
          });
          await clearZhilianWatchdog();
          return { ok: true, data: task };
        }
        return { ok: true, data: current };
      });
    }
  }
}

chrome.runtime.onInstalled.addListener(() => {
  void protectLocalStorage().catch(() => undefined);
});

chrome.runtime.onStartup.addListener(() => {
  void protectLocalStorage().catch(() => undefined);
});

// Service Worker 被浏览器重新唤醒时也立即收紧存储访问级别。
void protectLocalStorage().catch(() => undefined);

chrome.runtime.onStartup.addListener(() => {
  // 浏览器重启后无法确认旧点击是否到达平台，统一进入需人工核对状态。
  void getTask().then(async (task) => {
    if (task.status === "running" || task.status === "stopping") {
      await saveTask({
        ...task,
        status: "interrupted",
        message: "浏览器曾在任务执行期间退出，请先核对猎聘沟通记录",
      });
    }
  });
  void getZhilianTask().then(async (task) => {
    if (task.status === "running" || task.status === "stopping") {
      await saveZhilianTask({
        ...task,
        status: "interrupted",
        message: "浏览器曾在智联任务执行期间退出，请先核对投递记录",
      });
    }
  });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ZHILIAN_WATCHDOG_ALARM) {
    void withTaskMutation(async () => {
      const task = await getZhilianTask();
      if (task.status === "running" || task.status === "stopping") {
        await saveZhilianTask({
          ...task,
          status: "interrupted",
          message: "智联任务超过三分钟未返回结果，已安全中止，请核对投递记录",
        });
      }
    });
    return;
  }
  if (alarm.name !== WATCHDOG_ALARM) return;
  void withTaskMutation(async () => {
    const task = await getTask();
    if (task.status === "running" || task.status === "stopping") {
      await saveTask({
        ...task,
        status: "interrupted",
        message: "任务超过三分钟未返回结果，已安全中止，请核对猎聘沟通记录",
      });
    }
  });
});

chrome.action.onClicked.addListener((tab) => {
  if (tab.id === undefined) return;
  // 两个平台使用相同的抽屉切换协议，由当前域名对应的 Content Script 响应。
  void chrome.tabs
    .sendMessage(tab.id, { type: "TOGGLE_EMBEDDED_PANEL" } satisfies ContentRequest)
    .catch(() => undefined);
});

chrome.runtime.onMessage.addListener((request: BackgroundRequest, sender, sendResponse) => {
  void handleRequest(request, sender)
    .then(sendResponse)
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      sendResponse({ ok: false, error: message } satisfies ExtensionResponse<unknown>);
    });
  return true;
});
