import { listRecentAttempts, saveDeliveryAttempt } from "./database";
import { DEFAULT_LIEPIN_CONFIG, createIdleTask } from "../shared/defaults";
import type {
  AppState,
  BackgroundRequest,
  DeliveryAttempt,
  ExtensionResponse,
  LiepinConfig,
  TaskState,
  TaskStatus,
} from "../shared/types";

const CONFIG_KEY = "liepinConfig";
const TASK_KEY = "liepinTask";
const WATCHDOG_ALARM = "liepin-task-watchdog";

let taskMutationQueue: Promise<void> = Promise.resolve();

/**
 * 串行执行任务状态读写，防止两个侧边栏消息同时从 idle 启动任务。
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

/**
 * 从扩展存储读取配置，缺失时使用安全默认值。
 *
 * @returns 猎聘配置。
 */
async function getConfig(): Promise<LiepinConfig> {
  const stored = await chrome.storage.local.get(CONFIG_KEY);
  return { ...DEFAULT_LIEPIN_CONFIG, ...(stored[CONFIG_KEY] as LiepinConfig | undefined) };
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
    case "OPEN_SIDE_PANEL": {
      const tabId = sender.tab?.id;
      if (tabId === undefined) {
        return { ok: false, error: "无法识别当前猎聘标签页" };
      }
      // 此消息由网页悬浮按钮的真实用户点击触发，立即打开对应标签页的侧边栏。
      await chrome.sidePanel.open({ tabId });
      return { ok: true, data: { opened: true } };
    }
    case "GET_APP_STATE": {
      const [config, task, attempts] = await Promise.all([
        getConfig(),
        getTask(),
        listRecentAttempts(),
      ]);
      const state: AppState = { config, task, attempts };
      return { ok: true, data: state };
    }
    case "SAVE_LIEPIN_CONFIG": {
      const config: LiepinConfig = {
        keywords: request.config.keywords.map((item) => item.trim()).filter(Boolean),
        cityCode: request.config.cityCode.trim(),
        salary: request.config.salary.trim(),
      };
      await chrome.storage.local.set({ [CONFIG_KEY]: config });
      return { ok: true, data: config };
    }
    case "START_LIEPIN_TASK": {
      return withTaskMutation(async () => {
        const current = await getTask();
        if (current.status === "running" || current.status === "stopping") {
          return { ok: false, error: "已有猎聘任务正在运行" };
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
        // 单岗位正常应在数秒内结束；一分钟后仍运行则视为消息链路失联。
        await chrome.alarms.create(WATCHDOG_ALARM, { delayInMinutes: 1 });
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
  }
}

chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

chrome.runtime.onStartup.addListener(() => {
  // 确保浏览器更新或配置恢复后，工具栏图标仍可直接打开侧边栏。
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

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
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== WATCHDOG_ALARM) return;
  void withTaskMutation(async () => {
    const task = await getTask();
    if (task.status === "running" || task.status === "stopping") {
      await saveTask({
        ...task,
        status: "interrupted",
        message: "任务超过一分钟未返回结果，已安全中止，请核对猎聘沟通记录",
      });
    }
  });
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
