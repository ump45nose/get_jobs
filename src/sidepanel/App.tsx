import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_LIEPIN_CONFIG,
  DEFAULT_GREETING_PROMPT_TEMPLATE,
  createIdleTask,
  normalizeBatchConfig,
  randomBatchDelayMilliseconds,
} from "../shared/defaults";
import { getLiepinSafetyStatus } from "../shared/liepin-safety";
import type {
  AppState,
  AiDiagnosticLog,
  BackgroundRequest,
  ContentRequest,
  DeliveryAttempt,
  DeliveryResult,
  ExtensionResponse,
  GreetingDraft,
  LiepinBatchConfig,
  LiepinConfig,
  LiepinJobSnapshot,
  LiepinPageContext,
  LiepinSafetyStatus,
  SavedLiepinConfig,
  TaskState,
} from "../shared/types";

/** 助手界面中等待用户预览或编辑的 AI 草稿。 */
interface PendingGreetingDraft {
  tabId: number;
  job: LiepinJobSnapshot;
  text: string;
  sendResume: boolean;
  actionInterval: LiepinDeliveryTiming;
}

/** 发送给内容脚本的单岗位动作等待与简历回执等待配置。 */
type LiepinDeliveryTiming = Pick<
  LiepinBatchConfig,
  "minActionIntervalSeconds" | "maxActionIntervalSeconds" | "resumeReceiptTimeoutSeconds"
>;

/** 草稿生成流程独立于持久化投递任务的界面状态。 */
type DraftActivity = "idle" | "saving" | "generating" | "ready" | "error";

/** 当前页顺序投递在助手界面中的临时运行状态。 */
interface BatchProgress {
  status: "confirming" | "running" | "waiting" | "stopping" | "completed" | "cancelled" | "failed";
  total: number;
  completed: number;
  currentJob?: string;
  nextDelaySeconds?: number;
  message: string;
}

const EMPTY_CONTEXT: LiepinPageContext = {
  supported: false,
  loggedIn: null,
  url: "",
  jobs: [],
};

/** 尚未从后台加载时展示的本机账号安全状态。 */
const EMPTY_SAFETY = getLiepinSafetyStatus(undefined, DEFAULT_LIEPIN_CONFIG.batch);

/**
 * 向 Service Worker 发送带类型的业务消息。
 *
 * @param request 后台消息。
 * @returns 后台响应数据。
 */
async function sendBackground<T>(request: BackgroundRequest): Promise<T> {
  const response = (await chrome.runtime.sendMessage(request)) as ExtensionResponse<T>;
  if (!response.ok) throw new Error(response.error || "后台操作失败");
  return response.data as T;
}

/**
 * 获取当前窗口的活动标签页。
 *
 * @returns 找不到活动标签页时抛出错误。
 */
async function getActiveTab(): Promise<chrome.tabs.Tab> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("无法获取当前标签页");
  return tab;
}

/**
 * 向当前猎聘标签页的 Content Script 发送消息。
 *
 * @param request 页面消息。
 * @param tabId 可选的固定目标标签页；投递任务必须传入。
 * @returns 页面响应数据。
 */
async function sendContent<T>(request: ContentRequest, tabId?: number): Promise<T> {
  const targetTabId = tabId ?? (await getActiveTab()).id;
  if (!targetTabId) throw new Error("无法识别目标猎聘标签页");
  const response = (await chrome.tabs.sendMessage(targetTabId, request)) as ExtensionResponse<T>;
  if (!response.ok) throw new Error(response.error || "猎聘页面操作失败");
  return response.data as T;
}

/**
 * 把 AI Base URL 转换为 Chrome 可选主机权限模式。
 *
 * @param baseUrl 用户输入的 AI 接口地址。
 * @returns 仅包含协议和主机的权限模式。
 */
function toAiOriginPattern(baseUrl: string): string {
  const url = new URL(baseUrl.trim());
  if (url.username || url.password) {
    throw new Error("AI 接口地址不得包含用户名或密码");
  }
  const isLocalhost = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocalhost)) {
    throw new Error("AI 接口仅允许 HTTPS，或本机 localhost/127.0.0.1 HTTP 地址");
  }
  return `${url.protocol}//${url.hostname}/*`;
}

/**
 * 在用户保存配置的手势中申请实际 AI 接口域名权限。
 *
 * @param baseUrl 用户输入的 AI 接口地址。
 * @returns 用户允许访问时完成。
 */
async function ensureAiHostPermission(baseUrl: string): Promise<void> {
  const origin = toAiOriginPattern(baseUrl);
  const granted = await chrome.permissions.request({ origins: [origin] });
  if (!granted) {
    throw new Error("未授予 AI 接口域名访问权限，配置未保存");
  }
}

/**
 * 检查明确不可能工作的模型与服务商组合。
 *
 * @param baseUrl 用户输入的 AI 接口地址。
 * @param model 用户输入的模型名称。
 * @returns 可操作的修正提示；组合正常时返回空值。
 */
function getAiProviderIssue(baseUrl: string, model: string): string | null {
  try {
    const url = new URL(baseUrl.trim());
    const normalizedModel = model.trim().toLowerCase();
    if (url.hostname === "api.openai.com" && normalizedModel.startsWith("glm")) {
      return "GLM 模型不能使用 OpenAI 官方 Base URL；请改用你的本机代理地址，或智谱 https://open.bigmodel.cn/api/paas/v4";
    }
  } catch {
    // URL 格式错误由保存时的权限解析统一给出，避免输入过程中重复闪烁错误。
  }
  return null;
}

/**
 * 将任务状态映射为中文标签。
 *
 * @param status 任务状态。
 * @returns 中文状态。
 */
function statusLabel(status: TaskState["status"]): string {
  const labels: Record<TaskState["status"], string> = {
    idle: "空闲",
    running: "执行中",
    stopping: "停止中",
    success: "已完成",
    cancelled: "已取消",
    blocked: "需处理",
    failed: "失败",
    interrupted: "已中止",
  };
  return labels[status];
}

/**
 * 将投递结果映射为简洁中文。
 *
 * @param outcome 业务结果。
 * @returns 中文结果。
 */
function outcomeLabel(outcome: DeliveryAttempt["outcome"]): string {
  const labels: Record<DeliveryAttempt["outcome"], string> = {
    delivered: "新投递成功",
    "already-contacted": "此前已联系",
    cancelled: "已取消",
    blocked: "需处理",
    failed: "失败",
  };
  return labels[outcome];
}

/**
 * 将独立阶段状态映射为中文，便于用户判断是否需要人工核对。
 *
 * @param status 阶段状态。
 * @returns 中文状态标签。
 */
function stepStatusLabel(status: NonNullable<DeliveryAttempt["steps"]>["communication"]["status"]): string {
  const labels = {
    success: "成功",
    failed: "失败",
    skipped: "跳过",
    unknown: "待核对",
  } as const;
  return labels[status];
}

/** 将投递日志阶段映射为面板中的中文标签。 */
function deliveryLogPhaseLabel(phase: NonNullable<DeliveryAttempt["logs"]>[number]["phase"]): string {
  const labels = {
    task: "任务",
    communication: "沟通",
    greeting: "招呼",
    resume: "简历",
  } as const;
  return labels[phase];
}

/** 将脱敏日志详情格式化为单行文本，便于快速复制和人工比对。 */
function deliveryLogDetailsText(
  details: NonNullable<DeliveryAttempt["logs"]>[number]["details"],
): string {
  if (!details) return "";
  return Object.entries(details)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(" · ");
}

/** 猎聘插件页内抽屉主界面。 */
export function App() {
  const [config, setConfig] = useState<LiepinConfig>(DEFAULT_LIEPIN_CONFIG);
  const [keywordsText, setKeywordsText] = useState("");
  const [task, setTask] = useState<TaskState>(createIdleTask());
  const [context, setContext] = useState<LiepinPageContext>(EMPTY_CONTEXT);
  const [attempts, setAttempts] = useState<DeliveryAttempt[]>([]);
  const [apiKey, setApiKey] = useState("");
  const [aiApiKeyConfigured, setAiApiKeyConfigured] = useState(false);
  const [pendingDraft, setPendingDraft] = useState<PendingGreetingDraft | null>(null);
  const [draftActivity, setDraftActivity] = useState<DraftActivity>("idle");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [batchProgress, setBatchProgress] = useState<BatchProgress | null>(null);
  const [safety, setSafety] = useState<LiepinSafetyStatus>(EMPTY_SAFETY);
  const [aiDiagnostics, setAiDiagnostics] = useState<AiDiagnosticLog[]>([]);
  const batchStopRequested = useRef(false);
  const activeExecution = useRef<{ taskId: string; tabId: number } | null>(null);

  const taskBusy = task.status === "running" || task.status === "stopping";
  const batchActive = batchProgress?.status === "running"
    || batchProgress?.status === "waiting"
    || batchProgress?.status === "stopping";
  const knownContactedJobs = useMemo(
    () => context.jobs.filter((job) => job.buttonText?.includes("继续聊")),
    [context.jobs],
  );
  const batchCandidates = useMemo(
    () => context.jobs.filter((job) => !job.buttonText?.includes("继续聊")),
    [context.jobs],
  );
  const normalizedBatchConfig = useMemo(() => normalizeBatchConfig(config.batch), [config.batch]);
  const pendingApiKey = Boolean(apiKey.trim());
  const aiProviderIssue = useMemo(
    () => getAiProviderIssue(config.ai.baseUrl, config.ai.model),
    [config.ai.baseUrl, config.ai.model],
  );
  const headerStatus = useMemo(() => {
    if (taskBusy) return { label: statusLabel(task.status), className: task.status };
    if (draftActivity === "saving") return { label: "保存中", className: "generating" };
    if (draftActivity === "generating") return { label: "生成中", className: "generating" };
    if (draftActivity === "ready") return { label: "待确认", className: "ready" };
    if (draftActivity === "error") return { label: "草稿失败", className: "failed" };
    if (task.status === "idle") return { label: statusLabel(task.status), className: task.status };
    return { label: `上次${statusLabel(task.status)}`, className: "previous" };
  }, [draftActivity, task.status, taskBusy]);
  const loginLabel = useMemo(() => {
    if (!context.supported) return "请打开猎聘搜索页";
    if (context.loggedIn === true) return "已登录";
    if (context.loggedIn === false) return "未登录";
    return "登录状态待确认";
  }, [context]);

  /** 从持久化后台加载配置、任务和历史记录。 */
  const loadAppState = useCallback(async () => {
    const state = await sendBackground<AppState>({ type: "GET_APP_STATE" });
    setConfig(state.config);
    setAiApiKeyConfigured(state.aiApiKeyConfigured);
    setKeywordsText(state.config.keywords.join("\n"));
    setTask(state.task);
    setAttempts(state.attempts);
    setSafety(state.safety);
  }, []);

  /** 从后台加载最近的脱敏 AI POST 请求诊断。 */
  const loadAiDiagnostics = useCallback(async () => {
    const diagnostics = await sendBackground<AiDiagnosticLog[]>({ type: "GET_LIEPIN_AI_DIAGNOSTICS" });
    setAiDiagnostics(diagnostics);
  }, []);

  /** 从后台刷新持久化每日额度和长冷却状态。 */
  const refreshSafetyStatus = useCallback(async () => {
    const next = await sendBackground<LiepinSafetyStatus>({ type: "GET_LIEPIN_SAFETY_STATUS" });
    setSafety(next);
    return next;
  }, []);

  /** 重新识别当前标签页中的猎聘岗位卡片。 */
  const inspectPage = useCallback(async () => {
    try {
      const pageContext = await sendContent<LiepinPageContext>({ type: "INSPECT_LIEPIN" });
      setContext(pageContext);
      setNotice(pageContext.jobs.length ? `识别到 ${pageContext.jobs.length} 个岗位` : "当前页面尚未识别到岗位卡片");
    } catch (error) {
      setContext(EMPTY_CONTEXT);
      setNotice(error instanceof Error ? `${error.message}；请刷新猎聘页面后重试` : String(error));
    }
  }, []);

  useEffect(() => {
    void loadAppState().catch((error: unknown) => setNotice(error instanceof Error ? error.message : String(error)));
    void loadAiDiagnostics().catch(() => undefined);
    void inspectPage();

    /** 扩展存储变化时同步后台任务和安全状态，避免多个助手实例展示过期额度。 */
    const onStorageChanged = (changes: Record<string, chrome.storage.StorageChange>) => {
      const nextTask = changes.liepinTask?.newValue as TaskState | undefined;
      if (nextTask) setTask(nextTask);
      if (changes.liepinSafety) {
        void refreshSafetyStatus().catch((error: unknown) => {
          setNotice(error instanceof Error ? error.message : String(error));
        });
      }
      if (changes.liepinAiDiagnostics) void loadAiDiagnostics().catch(() => undefined);
    };
    chrome.storage.onChanged.addListener(onStorageChanged);
    return () => chrome.storage.onChanged.removeListener(onStorageChanged);
  }, [inspectPage, loadAiDiagnostics, loadAppState, refreshSafetyStatus]);

  /** 从当前表单状态构建待保存配置，确保生成按钮使用尚未手动保存的最新输入。 */
  function buildCurrentConfig(): LiepinConfig {
    return {
      ...config,
      keywords: keywordsText.split(/[\n,，]+/).map((item) => item.trim()).filter(Boolean),
    };
  }

  /**
   * 持久化当前表单并使用后台回读结果确认 Key 状态。
   *
   * @param requireAiCredentials 是否要求本次保存后可立即生成 AI 草稿。
   * @returns 后台规范化后的配置和真实密钥状态。
   */
  async function persistCurrentConfig(requireAiCredentials: boolean): Promise<SavedLiepinConfig> {
    const next = buildCurrentConfig();
    const nextApiKey = apiKey.trim();
    if (requireAiCredentials && !next.ai.model.trim()) {
      throw new Error("请先填写 AI 模型名称");
    }
    if (requireAiCredentials && !next.ai.promptTemplate.trim()) {
      throw new Error("请先填写 AI 招呼语提示词模板");
    }
    if (next.ai.useFallbackGreeting && !next.ai.fallbackGreeting.trim()) {
      throw new Error("已启用兜底招呼语，请填写兜底文本或关闭兜底");
    }
    if (requireAiCredentials && !nextApiKey && !aiApiKeyConfigured) {
      throw new Error("请先填写 API Key；点击生成草稿时会自动保存到本机扩展存储");
    }
    const providerIssue = getAiProviderIssue(next.ai.baseUrl, next.ai.model);
    if (next.ai.model.trim() && providerIssue) {
      throw new Error(providerIssue);
    }
    if (next.ai.model.trim() || nextApiKey || aiApiKeyConfigured) {
      await ensureAiHostPermission(next.ai.baseUrl);
    }
    const saved = await sendBackground<SavedLiepinConfig>({
      type: "SAVE_LIEPIN_CONFIG",
      config: next,
      apiKey: nextApiKey || undefined,
    });
    setConfig(saved.config);
    setKeywordsText(saved.config.keywords.join("\n"));
    setAiApiKeyConfigured(saved.aiApiKeyConfigured);
    if (nextApiKey && !saved.aiApiKeyConfigured) {
      throw new Error("API Key 未能写入本机扩展存储，请重新加载扩展后重试");
    }
    if (nextApiKey) setApiKey("");
    return saved;
  }

  /** 保存猎聘检索条件与当前 AI 配置。 */
  async function saveConfig() {
    setBusy(true);
    try {
      await persistCurrentConfig(false);
      setNotice("猎聘与 AI 配置已保存");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  /** 从 AI 区域独立保存接口、模型、密钥、简历摘要和完整提示词。 */
  async function saveAiConfig() {
    setBusy(true);
    setDraftActivity("saving");
    try {
      await persistCurrentConfig(true);
      setDraftActivity("idle");
      setNotice("AI 配置与 API Key 已保存，可直接生成草稿");
    } catch (error) {
      setDraftActivity("error");
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  /** 清除本机保存的 AI API Key，不改变其他配置。 */
  async function clearApiKey() {
    setBusy(true);
    try {
      await sendBackground<{ cleared: boolean }>({ type: "CLEAR_LIEPIN_AI_KEY" });
      setApiKey("");
      setAiApiKeyConfigured(false);
      setNotice("已清除本机保存的 AI API Key");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  /** 清除本机保存的 AI 请求诊断，不影响配置和 API Key。 */
  async function clearAiDiagnostics() {
    setBusy(true);
    try {
      await sendBackground<{ cleared: boolean }>({ type: "CLEAR_LIEPIN_AI_DIAGNOSTICS" });
      setAiDiagnostics([]);
      setNotice("AI 请求诊断已清除");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  /** 将本机保存的猎聘投递结果和脱敏阶段日志导出为 JSON，便于后续统计和调优。 */
  function exportDeliveryLogs() {
    if (!attempts.length) {
      setNotice("暂无可导出的投递日志");
      return;
    }
    const payload = JSON.stringify({
      exportedAt: new Date().toISOString(),
      platform: "liepin",
      attempts,
    }, null, 2);
    const url = URL.createObjectURL(new Blob([payload], { type: "application/json;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `get-jobs-liepin-delivery-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    setNotice(`已导出 ${attempts.length} 条猎聘投递日志`);
  }

  /**
   * 使用已经生成并确认的草稿执行页面沟通、消息和简历发送。
   *
   * @param job 用户选中的岗位。
   * @param greetingText 用户确认后的招呼语。
   * @param tabId 用户点击岗位时的原始猎聘标签页。
   * @param sendResume 本次草稿生成时锁定的简历发送配置。
   * @param actionInterval 单岗位内部不可逆页面动作的随机稳定等待区间。
   * @returns 页面闭环完成时返回结果；插件异常时返回 null。
   */
  async function executeJob(
    job: LiepinJobSnapshot,
    greetingText: string,
    tabId: number,
    sendResume: boolean,
    actionInterval: LiepinDeliveryTiming,
  ): Promise<DeliveryResult | null> {
    setDraftActivity("idle");
    setBusy(true);
    setNotice(`准备投递：${job.jobTitle}`);
    let taskStarted = false;
    let taskId: string | undefined;
    try {
      const targetTab = await chrome.tabs.get(tabId);
      const targetHost = targetTab.url ? new URL(targetTab.url).hostname : "";
      if (targetHost !== "liepin.com" && !targetHost.endsWith(".liepin.com")) {
        throw new Error("生成草稿后原猎聘标签页已关闭或离开猎聘，请重新识别岗位");
      }
      const startedTask = await sendBackground<TaskState>({ type: "START_LIEPIN_TASK", tabId, job });
      setTask(startedTask);
      taskStarted = true;
      taskId = startedTask.taskId;
      if (!taskId) throw new Error("后台未生成任务标识");
      activeExecution.current = { taskId, tabId };
      const result = await sendContent<DeliveryResult>({
        type: "APPLY_LIEPIN_JOB",
        taskId,
        cardKey: job.cardKey,
        greetingText,
        sendResume,
        actionInterval,
      }, tabId);
      setNotice(result.message);
      await loadAppState();
      await inspectPage();
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (taskStarted && taskId) {
        await sendBackground<TaskState>({
          type: "FAIL_LIEPIN_TASK",
          taskId,
          message: `插件未完成本次页面操作：${message}`,
        }).catch(() => undefined);
      }
      setNotice(message);
      await loadAppState();
      return null;
    } finally {
      activeExecution.current = null;
      setBusy(false);
    }
  }

  /**
   * 为用户选择的岗位生成草稿，并按配置决定等待预览或直接执行。
   *
   * @param job 用户选中的岗位。
   * @returns 草稿生成或自动执行完成时返回。
   */
  async function prepareJob(job: LiepinJobSnapshot) {
    setBusy(true);
    setDraftActivity("saving");
    setNotice(`正在保存 AI 配置：${job.jobTitle}`);
    try {
      // 权限申请必须紧邻岗位按钮的真实用户手势，因此先保存再读取目标标签页。
      const saved = await persistCurrentConfig(true);
      const tab = await getActiveTab();
      const tabHost = tab.url ? new URL(tab.url).hostname : "";
      if (!tab.id || (tabHost !== "liepin.com" && !tabHost.endsWith(".liepin.com"))) {
        throw new Error("请先打开需要投递的猎聘岗位列表页");
      }
      setDraftActivity("generating");
      setNotice(`正在生成 AI 招呼：${job.jobTitle}`);
      const sendResume = saved.config.ai.sendResume;
      const actionInterval = {
        minActionIntervalSeconds: saved.config.batch.minActionIntervalSeconds,
        maxActionIntervalSeconds: saved.config.batch.maxActionIntervalSeconds,
        resumeReceiptTimeoutSeconds: saved.config.batch.resumeReceiptTimeoutSeconds,
      };
      const draft = await sendBackground<GreetingDraft>({ type: "GENERATE_LIEPIN_GREETING", job });
      if (saved.config.ai.previewBeforeSend) {
        setPendingDraft({ tabId: tab.id, job, text: draft.text, sendResume, actionInterval });
        setDraftActivity("ready");
        setNotice(draft.warning ?? "AI 草稿已生成，请预览或编辑后确认发送");
      } else {
        setNotice(draft.warning ?? "AI 草稿已生成，正在按配置直接执行页面发送");
        setDraftActivity("idle");
        setBusy(false);
        await executeJob(job, draft.text, tab.id, sendResume, actionInterval);
        return;
      }
    } catch (error) {
      setDraftActivity("error");
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  /** 使用当前编辑后的草稿继续执行投递。 */
  async function confirmDraft() {
    if (!pendingDraft) return;
    const text = pendingDraft.text.replace(/\s+/g, " ").trim();
    if (!text || text.length > 150) {
      setNotice("招呼语必须为 1 至 150 个字符");
      return;
    }
    const selected = pendingDraft;
    setPendingDraft(null);
    setDraftActivity("idle");
    await executeJob(selected.job, text, selected.tabId, selected.sendResume, selected.actionInterval);
  }

  /** 取消尚未产生任何页面发送动作的草稿。 */
  function cancelDraft() {
    setPendingDraft(null);
    setDraftActivity("idle");
    setNotice("已取消本次草稿，未操作猎聘页面");
  }

  /** 请求当前内容脚本停止尚未完成的等待。 */
  async function stopTask() {
    setBusy(true);
    try {
      if (!task.taskId) throw new Error("当前任务缺少唯一标识，无法安全停止");
      const taskId = task.taskId;
      const stopping = await sendBackground<TaskState>({ type: "REQUEST_LIEPIN_STOP", taskId });
      setTask(stopping);
      if (!task.tabId) throw new Error("当前任务缺少目标标签页，无法安全停止");
      const stopped = await sendContent<{ stopped: boolean; applying: boolean }>({
        type: "STOP_LIEPIN_TASK",
        taskId,
      }, task.tabId);
      if (!stopped.applying) {
        const cancelled = await sendBackground<TaskState>({ type: "FINALIZE_LIEPIN_STOP", taskId });
        setTask(cancelled);
      }
      setNotice("停止请求已发送");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  /**
   * 统一检查批次启动前置条件，确保顶部直启与底部确认使用同一安全边界。
   *
   * @returns 可以启动时返回 undefined；否则返回面向用户的阻止原因。
   */
  function getBatchStartIssue(): string | undefined {
    if (busy || taskBusy || batchActive) {
      return "当前仍有岗位任务，请等待完成或先停止";
    }
    if (pendingDraft) {
      return "请先确认或取消当前 AI 草稿";
    }
    if (!context.supported || context.loggedIn !== true) {
      return "请先在当前标签页登录猎聘并重新识别岗位";
    }
    if (!batchCandidates.length) {
      return "当前页没有可顺序投递的新岗位；已显示“继续聊”的岗位会被跳过";
    }
    if (safety.cooldownRemainingSeconds > 0) {
      return `账号安全冷却中，约 ${safety.cooldownRemainingSeconds} 秒后可继续`;
    }
    const localRemainingDaily = Math.max(
      0,
      normalizedBatchConfig.maxDailyDeliveries - safety.dailyDeliveries,
    );
    const queueCount = Math.min(
      batchCandidates.length,
      normalizedBatchConfig.maxBatchSize,
      localRemainingDaily,
    );
    if (queueCount <= 0) {
      return "当前账号安全额度不足，今日不再启动新投递";
    }
    return undefined;
  }

  /** 打开底部当前页顺序投递确认区，不在第一次点击时直接发送。 */
  function requestBatchStart() {
    const issue = getBatchStartIssue();
    if (issue) {
      setNotice(issue);
      return;
    }
    const localRemainingDaily = Math.max(
      0,
      normalizedBatchConfig.maxDailyDeliveries - safety.dailyDeliveries,
    );
    const queueCount = Math.min(
      batchCandidates.length,
      normalizedBatchConfig.maxBatchSize,
      localRemainingDaily,
    );
    const guardSkipped = batchCandidates.length - queueCount;
    setBatchProgress({
      status: "confirming",
      total: queueCount,
      completed: 0,
      message: `将按页面顺序处理 ${queueCount} 个岗位；动作间随机等待 ${normalizedBatchConfig.minActionIntervalSeconds}–${normalizedBatchConfig.maxActionIntervalSeconds} 秒，岗位间等待 ${normalizedBatchConfig.minIntervalSeconds}–${normalizedBatchConfig.maxIntervalSeconds} 秒；跳过 ${knownContactedJobs.length} 个已联系岗位${guardSkipped ? `，另有 ${guardSkipped} 个受安全额度限制` : ""}`,
    });
  }

  /** 取消尚未开始的当前页顺序投递确认。 */
  function cancelBatchStart() {
    setBatchProgress(null);
    setNotice("已取消当前页顺序投递，未操作猎聘页面");
  }

  /**
   * 在两次投递之间执行可中断的随机等待。
   *
   * @param milliseconds 本次随机得到的等待毫秒数。
   * @param completed 已完成的岗位数。
   * @param total 本批次岗位总数。
   * @param messagePrefix 等待原因说明。
   * @returns 用户未请求停止时返回 true。
   */
  async function waitForBatchInterval(
    milliseconds: number,
    completed: number,
    total: number,
    messagePrefix = "随机等待",
  ): Promise<boolean> {
    const deadline = Date.now() + milliseconds;
    while (Date.now() < deadline) {
      if (batchStopRequested.current) return false;
      const nextDelaySeconds = Math.max(1, Math.ceil((deadline - Date.now()) / 1_000));
      setBatchProgress({
        status: "waiting",
        total,
        completed,
        nextDelaySeconds,
        message: `${messagePrefix} ${nextDelaySeconds} 秒后处理下一个岗位`,
      });
      // 小步等待保证“停止顺序投递”无需等完整间隔结束。
      await new Promise<void>((resolve) => window.setTimeout(resolve, Math.min(250, deadline - Date.now())));
    }
    return !batchStopRequested.current;
  }

  /**
   * 在二次确认后按页面顺序生成并投递所有未联系岗位。
   *
   * @returns 批次完成、停止或遇到不确定结果时返回。
   */
  async function confirmBatchStart() {
    let jobs: LiepinJobSnapshot[] = [];
    let completedCount = 0;
    let safeStopReason = "";
    const issue = getBatchStartIssue();
    if (issue) {
      setNotice(issue);
      return;
    }
    batchStopRequested.current = false;
    setBusy(true);
    try {
      // 批量确认是一次明确授权：每个岗位仍独立生成 AI 文本并等待消息、简历回执。
      const saved = await persistCurrentConfig(true);
      const initialSafety = await refreshSafetyStatus();
      if (initialSafety.blockedReason) throw new Error(initialSafety.blockedReason);
      const allowedCount = Math.min(
        batchCandidates.length,
        saved.config.batch.maxBatchSize,
        initialSafety.remainingDailyDeliveries,
      );
      jobs = batchCandidates.slice(0, allowedCount);
      const tab = await getActiveTab();
      const tabHost = tab.url ? new URL(tab.url).hostname : "";
      if (!tab.id || (tabHost !== "liepin.com" && !tabHost.endsWith(".liepin.com"))) {
        throw new Error("请保持需要投递的猎聘岗位列表页为当前活动标签页");
      }
      if (!jobs.length) throw new Error("确认后未找到可顺序投递的岗位，请重新识别");

      setBusy(false);
      for (let index = 0; index < jobs.length; index += 1) {
        if (batchStopRequested.current) break;
        const job = jobs[index];
        setBatchProgress({
          status: "running",
          total: jobs.length,
          completed: index,
          currentJob: job.jobTitle,
          message: `正在生成第 ${index + 1}/${jobs.length} 个岗位的 AI 招呼`,
        });
        setDraftActivity("generating");
        const draft = await sendBackground<GreetingDraft>({ type: "GENERATE_LIEPIN_GREETING", job });
        setDraftActivity("idle");
        if (batchStopRequested.current) break;
        setBatchProgress({
          status: "running",
          total: jobs.length,
          completed: index,
          currentJob: job.jobTitle,
          message: draft.source === "fallback"
            ? `第 ${index + 1}/${jobs.length} 个岗位 AI 不可用，正在使用兜底招呼语并等待分阶段回执`
            : `正在执行第 ${index + 1}/${jobs.length} 个岗位并等待分阶段回执`,
        });
        const result = await executeJob(
          job,
          draft.text,
          tab.id,
          saved.config.ai.sendResume,
          saved.config.batch,
        );
        if (batchStopRequested.current) break;
        if (!result || (result.outcome !== "delivered" && result.outcome !== "already-contacted")) {
          const reason = result?.message ?? "插件未取得本岗位的完整结果";
          setBatchProgress({
            status: "failed",
            total: jobs.length,
            completed: index,
            currentJob: job.jobTitle,
            message: `批次已停止：${reason}`,
          });
          setNotice(`顺序投递在“${job.jobTitle}”停止：${reason}`);
          return;
        }

        const completed = index + 1;
        completedCount = completed;
        if (completed < jobs.length) {
          const nextSafety = await refreshSafetyStatus();
          if (nextSafety.remainingDailyDeliveries <= 0) {
            safeStopReason = `今日已达到 ${saved.config.batch.maxDailyDeliveries} 个新投递上限，已安全停止`;
            break;
          }
          if (nextSafety.cooldownRemainingSeconds > 0) {
            const cooled = await waitForBatchInterval(
              nextSafety.cooldownRemainingSeconds * 1_000,
              completed,
              jobs.length,
              "账号安全冷却",
            );
            if (!cooled) break;
          }
          const delay = randomBatchDelayMilliseconds(saved.config.batch);
          const shouldContinue = await waitForBatchInterval(delay, completed, jobs.length);
          if (!shouldContinue) break;
        }
      }

      if (batchStopRequested.current) {
        setBatchProgress((current) => ({
          status: "cancelled",
          total: current?.total ?? jobs.length,
          completed: current?.completed ?? 0,
          currentJob: current?.currentJob,
          message: "顺序投递已停止，不会继续处理剩余岗位",
        }));
        setNotice("顺序投递已停止");
      } else if (safeStopReason) {
        setBatchProgress({
          status: "completed",
          total: jobs.length,
          completed: completedCount,
          message: safeStopReason,
        });
        setNotice(safeStopReason);
      } else {
        setBatchProgress({
          status: "completed",
          total: jobs.length,
          completed: jobs.length,
          message: `当前页 ${jobs.length} 个新岗位已按顺序处理完成`,
        });
        setNotice(`当前页顺序投递完成；另跳过 ${knownContactedJobs.length} 个已联系岗位`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setDraftActivity("error");
      setBatchProgress({
        status: "failed",
        total: jobs.length,
        completed: completedCount,
        message: `批次未开始或已停止：${message}`,
      });
      setNotice(message);
    } finally {
      setBusy(false);
    }
  }

  /** 请求停止批次等待，并中止当前仍在运行的单岗位页面任务。 */
  async function stopBatch() {
    batchStopRequested.current = true;
    setBatchProgress((current) => current ? { ...current, status: "stopping", message: "正在停止当前岗位和后续队列" } : current);
    const active = activeExecution.current;
    if (!active) return;
    try {
      await sendBackground<TaskState>({ type: "REQUEST_LIEPIN_STOP", taskId: active.taskId });
      const stopped = await sendContent<{ stopped: boolean; applying: boolean }>({
        type: "STOP_LIEPIN_TASK",
        taskId: active.taskId,
      }, active.tabId);
      if (!stopped.applying) {
        await sendBackground<TaskState>({ type: "FINALIZE_LIEPIN_STOP", taskId: active.taskId });
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * 顶部快捷入口一次点击直接启动顺序投递；运行中同一位置用于停止。
   *
   * @returns 当前状态对应的直接启动或停止请求完成时返回。
   */
  async function handleHeroBatchAction(): Promise<void> {
    if (batchActive) {
      await stopBatch();
      return;
    }
    await confirmBatchStart();
  }

  const heroBatchLabel = batchProgress?.status === "stopping"
    ? "正在停止"
    : batchActive
      ? "停止投递"
      : "顺序投递";
  const heroBatchDisabled = batchProgress?.status === "stopping"
    || (!batchActive && (busy || taskBusy || Boolean(pendingDraft)));

  return (
    <main className="app-shell">
      <header className="hero">
        <div>
          <p className="eyebrow">GET JOBS · LIEPIN MVP</p>
          <h1>猎聘投递助手</h1>
          <p>使用当前 Chrome 登录态，可单岗位确认，也可二次确认后顺序处理当前页。</p>
        </div>
        <div className="hero-actions">
          <span className={`status status-${headerStatus.className}`}>{headerStatus.label}</span>
          <button
            className={batchActive ? "danger hero-batch-button" : "hero-batch-button"}
            type="button"
            onClick={() => void handleHeroBatchAction()}
            disabled={heroBatchDisabled}
          >
            {heroBatchLabel}
          </button>
        </div>
      </header>

      <section className="panel compact-grid">
        <div>
          <span className="label">当前页面</span>
          <strong>{loginLabel}</strong>
        </div>
        <div>
          <span className="label">{taskBusy || task.status === "idle" ? "任务消息" : "上次投递结果"}</span>
          <strong>{task.message}</strong>
        </div>
      </section>

      {notice && <div className="notice">{notice}</div>}

      <section className="panel">
        <div className="section-title">
          <div>
            <span className="label">配置</span>
            <h2>猎聘检索条件</h2>
          </div>
          <button className="ghost" type="button" onClick={saveConfig} disabled={busy || batchActive}>保存全部</button>
        </div>
        <label>
          关键词（每行一个）
          <textarea value={keywordsText} onChange={(event) => setKeywordsText(event.target.value)} rows={3} />
        </label>
        <div className="field-row">
          <label>
            城市编码
            <input value={config.cityCode} onChange={(event) => setConfig({ ...config, cityCode: event.target.value })} />
          </label>
          <label>
            薪资编码
            <input value={config.salary} onChange={(event) => setConfig({ ...config, salary: event.target.value })} />
          </label>
        </div>
      </section>

      <section className="panel">
        <div className="section-title">
          <div>
            <span className="label">AI 与发送</span>
            <h2>招呼语和简历</h2>
          </div>
          <div className="key-tools">
            <span className={`key-state ${pendingApiKey ? "pending" : aiApiKeyConfigured ? "configured" : ""}`}>
              {pendingApiKey ? "Key 待保存" : aiApiKeyConfigured ? "Key 已保存" : "Key 未配置"}
            </span>
            {aiApiKeyConfigured && !pendingApiKey && (
              <button className="text-button" type="button" onClick={clearApiKey} disabled={busy || batchActive}>清除</button>
            )}
            <button className="ghost" type="button" onClick={saveAiConfig} disabled={busy || batchActive}>保存 AI 配置</button>
          </div>
        </div>
        <label>
          OpenAI 兼容 Base URL
          <input
            value={config.ai.baseUrl}
            onChange={(event) => setConfig({ ...config, ai: { ...config.ai, baseUrl: event.target.value } })}
            placeholder="https://api.openai.com/v1"
          />
        </label>
        <div className="field-row">
          <label>
            模型
            <input
              value={config.ai.model}
              onChange={(event) => setConfig({ ...config, ai: { ...config.ai, model: event.target.value } })}
              placeholder="输入兼容接口支持的模型名称"
            />
          </label>
          <label>
            API Key
            <input
              type="password"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder={aiApiKeyConfigured ? "留空则保留已保存 Key" : "输入后保存，或直接生成草稿"}
              autoComplete="off"
            />
          </label>
        </div>
        {aiProviderIssue && <p className="config-warning">{aiProviderIssue}</p>}
        <label className="profile-field">
          AI 请求超时（秒，10–600）
          <input
            type="number"
            min={10}
            max={600}
            step={10}
            value={config.ai.timeoutSeconds}
            onChange={(event) => setConfig({
              ...config,
              ai: {
                ...config.ai,
                timeoutSeconds: Number.isFinite(event.target.valueAsNumber)
                  ? event.target.valueAsNumber
                  : DEFAULT_LIEPIN_CONFIG.ai.timeoutSeconds,
              },
            })}
          />
        </label>
        <label className="profile-field">
          个人简历摘要（只填写真实经历）
          <textarea
            value={config.ai.resumeSummary}
            onChange={(event) => setConfig({ ...config, ai: { ...config.ai, resumeSummary: event.target.value } })}
            rows={5}
            placeholder="例如：5 年 Java/AI 应用经验，负责过 Agent、RAG、多模型接入……"
          />
        </label>
        <label className="profile-field prompt-field">
          <span className="field-label-row">
            <span>AI 招呼语完整提示词</span>
            <button
              className="text-button"
              type="button"
              disabled={busy || batchActive}
              onClick={() => setConfig({
                ...config,
                ai: { ...config.ai, promptTemplate: DEFAULT_GREETING_PROMPT_TEMPLATE },
              })}
            >
              恢复默认模板
            </button>
          </span>
          <textarea
            value={config.ai.promptTemplate}
            onChange={(event) => setConfig({
              ...config,
              ai: { ...config.ai, promptTemplate: event.target.value },
            })}
            rows={12}
            placeholder="输入完整业务提示词，可使用下方变量"
            spellCheck={false}
          />
        </label>
        <p className="template-help">
          可用变量：{"{{resumeSummary}}"}、{"{{jobTitle}}"}、{"{{companyName}}"}、{"{{jobArea}}"}、
          {"{{jobSalary}}"}、{"{{jobEducation}}"}、{"{{jobExperience}}"}、{"{{companyIndustry}}"}、
          {"{{companyScale}}"}、{"{{hrName}}"}、{"{{hrTitle}}"}。写作内容可完全自定义；150 字与 3 句话发送上限固定生效。
        </p>
        <div className="fallback-config">
          <label className="toggle-row">
            <input
              type="checkbox"
              checked={config.ai.useFallbackGreeting}
              onChange={(event) => setConfig({
                ...config,
                ai: { ...config.ai, useFallbackGreeting: event.target.checked },
              })}
            />
            <span>AI 请求或输出无效时使用兜底招呼语</span>
          </label>
          {config.ai.useFallbackGreeting && (
            <label>
              兜底招呼语（1–150 字，最多 3 句话）
              <textarea
                value={config.ai.fallbackGreeting}
                onChange={(event) => setConfig({
                  ...config,
                  ai: { ...config.ai, fallbackGreeting: event.target.value },
                })}
                rows={3}
                maxLength={150}
              />
            </label>
          )}
          <p className="privacy-note">兜底只用于点击猎聘发送控件之前的 AI 生成失败；页面点击后结果未知时仍会停止，不会自动重发。</p>
        </div>
        <div className="toggle-list">
          <label className="toggle-row">
            <input
              type="checkbox"
              checked={config.ai.previewBeforeSend}
              onChange={(event) => setConfig({
                ...config,
                ai: { ...config.ai, previewBeforeSend: event.target.checked },
              })}
            />
            <span>发送前预览并允许编辑（默认开启）</span>
          </label>
          <label className="toggle-row">
            <input
              type="checkbox"
              checked={config.ai.sendResume}
              onChange={(event) => setConfig({
                ...config,
                ai: { ...config.ai, sendResume: event.target.checked },
              })}
            />
            <span>AI 招呼成功后单独发送简历</span>
          </label>
          <label className="toggle-row">
            <input
              type="checkbox"
              checked={config.ai.detailedLogging}
              onChange={(event) => setConfig({
                ...config,
                ai: { ...config.ai, detailedLogging: event.target.checked },
              })}
            />
            <span>记录完整 AI 请求与响应（可能包含简历，默认关闭）</span>
          </label>
        </div>
        <p className="privacy-note">自定义提示词及其岗位/简历变量会发送给你配置的 AI 服务；API Key 仅保存在本机扩展存储，诊断中的 Authorization 始终显示为 [REDACTED]。</p>
        <details className="ai-diagnostics">
          <summary>AI POST 请求诊断（{aiDiagnostics.length}）</summary>
          <div className="diagnostic-tools">
            <button className="ghost" type="button" onClick={loadAiDiagnostics} disabled={busy}>刷新</button>
            <button className="text-button" type="button" onClick={clearAiDiagnostics} disabled={busy || !aiDiagnostics.length}>清空</button>
          </div>
          <p className="privacy-note">默认仅记录 URL、模型、消息长度、HTTP 状态、耗时和错误；开启完整日志后才记录有限长度的 POST Body 与响应正文。</p>
          <div className="diagnostic-list">
            {aiDiagnostics.slice(0, 5).map((diagnostic) => (
              <article key={diagnostic.id}>
                <strong>{diagnostic.phase === "generate" ? "生成" : "压缩"} · {diagnostic.outcome}</strong>
                <span>{new Date(diagnostic.createdAt).toLocaleString()} · {diagnostic.durationMs}ms</span>
                <pre>{JSON.stringify(diagnostic, null, 2)}</pre>
              </article>
            ))}
            {!aiDiagnostics.length && <p className="empty">尚无 AI 请求诊断。</p>}
          </div>
        </details>
      </section>

      {pendingDraft && (
        <section className="panel draft-panel">
          <div className="section-title">
            <div>
              <span className="label">发送前确认</span>
              <h2>{pendingDraft.job.jobTitle}</h2>
            </div>
          </div>
          <textarea
            value={pendingDraft.text}
            onChange={(event) => setPendingDraft({ ...pendingDraft, text: event.target.value })}
            rows={5}
            maxLength={150}
          />
          <div className="draft-meta">
            <span>{pendingDraft.text.length}/150</span>
            <span>猎聘可能先发送账号预设招呼，AI 文本将作为后续个性化消息。</span>
          </div>
          <div className="button-row draft-actions">
            <button className="ghost" type="button" onClick={cancelDraft} disabled={busy}>取消</button>
            <button type="button" onClick={confirmDraft} disabled={busy}>确认并发送</button>
          </div>
        </section>
      )}

      <section className="panel batch-panel">
        <div className="section-title">
          <div>
            <span className="label">当前页面</span>
            <h2>顺序投递全部新岗位</h2>
          </div>
          {batchActive ? (
            <button className="danger" type="button" onClick={stopBatch}>停止顺序投递</button>
          ) : (
            <button
              type="button"
              onClick={requestBatchStart}
              disabled={busy || taskBusy || Boolean(pendingDraft) || batchProgress?.status === "confirming"}
            >
              顺序投递当前页
            </button>
          )}
        </div>
        <div className="field-row">
          <label>
            动作间最短等待（秒）
            <input
              type="number"
              min={0.5}
              max={10}
              step={0.5}
              value={config.batch.minActionIntervalSeconds}
              disabled={batchActive}
              onChange={(event) => setConfig({
                ...config,
                batch: {
                  ...config.batch,
                  minActionIntervalSeconds: Number.isFinite(event.target.valueAsNumber)
                    ? event.target.valueAsNumber
                    : DEFAULT_LIEPIN_CONFIG.batch.minActionIntervalSeconds,
                },
              })}
            />
          </label>
          <label>
            动作间最长等待（秒）
            <input
              type="number"
              min={0.5}
              max={10}
              step={0.5}
              value={config.batch.maxActionIntervalSeconds}
              disabled={batchActive}
              onChange={(event) => setConfig({
                ...config,
                batch: {
                  ...config.batch,
                  maxActionIntervalSeconds: Number.isFinite(event.target.valueAsNumber)
                    ? event.target.valueAsNumber
                    : DEFAULT_LIEPIN_CONFIG.batch.maxActionIntervalSeconds,
                },
              })}
            />
          </label>
        </div>
        <div className="field-row">
          <label>
            岗位间最短等待（秒）
            <input
              type="number"
              min={5}
              max={300}
              value={config.batch.minIntervalSeconds}
              disabled={batchActive}
              onChange={(event) => setConfig({
                ...config,
                batch: {
                  ...config.batch,
                  minIntervalSeconds: Number.isFinite(event.target.valueAsNumber)
                    ? event.target.valueAsNumber
                    : DEFAULT_LIEPIN_CONFIG.batch.minIntervalSeconds,
                },
              })}
            />
          </label>
          <label>
            岗位间最长等待（秒）
            <input
              type="number"
              min={5}
              max={300}
              value={config.batch.maxIntervalSeconds}
              disabled={batchActive}
              onChange={(event) => setConfig({
                ...config,
                batch: {
                  ...config.batch,
                  maxIntervalSeconds: Number.isFinite(event.target.valueAsNumber)
                    ? event.target.valueAsNumber
                    : DEFAULT_LIEPIN_CONFIG.batch.maxIntervalSeconds,
                },
              })}
            />
          </label>
        </div>
        <div className="field-row">
          <label>
            简历回执超时（秒，10–120）
            <input
              type="number"
              min={10}
              max={120}
              step={1}
              value={config.batch.resumeReceiptTimeoutSeconds}
              disabled={batchActive}
              onChange={(event) => setConfig({
                ...config,
                batch: {
                  ...config.batch,
                  resumeReceiptTimeoutSeconds: Number.isFinite(event.target.valueAsNumber)
                    ? event.target.valueAsNumber
                    : DEFAULT_LIEPIN_CONFIG.batch.resumeReceiptTimeoutSeconds,
                },
              })}
            />
          </label>
          <div className="field-help">点击“立即投递”后，等待聊天窗口出现简历卡片的最长时间。</div>
        </div>
        <div className="field-row">
          <label>
            单批最多岗位（1–20）
            <input
              type="number"
              min={1}
              max={20}
              value={config.batch.maxBatchSize}
              disabled={batchActive}
              onChange={(event) => setConfig({
                ...config,
                batch: {
                  ...config.batch,
                  maxBatchSize: Number.isFinite(event.target.valueAsNumber)
                    ? event.target.valueAsNumber
                    : DEFAULT_LIEPIN_CONFIG.batch.maxBatchSize,
                },
              })}
            />
          </label>
          <label>
            每日最多新投递（1–50）
            <input
              type="number"
              min={1}
              max={50}
              value={config.batch.maxDailyDeliveries}
              disabled={batchActive}
              onChange={(event) => setConfig({
                ...config,
                batch: {
                  ...config.batch,
                  maxDailyDeliveries: Number.isFinite(event.target.valueAsNumber)
                    ? event.target.valueAsNumber
                    : DEFAULT_LIEPIN_CONFIG.batch.maxDailyDeliveries,
                },
              })}
            />
          </label>
        </div>
        <div className="field-row">
          <label>
            每成功几个后长冷却（3–10）
            <input
              type="number"
              min={3}
              max={10}
              value={config.batch.cooldownEvery}
              disabled={batchActive}
              onChange={(event) => setConfig({
                ...config,
                batch: {
                  ...config.batch,
                  cooldownEvery: Number.isFinite(event.target.valueAsNumber)
                    ? event.target.valueAsNumber
                    : DEFAULT_LIEPIN_CONFIG.batch.cooldownEvery,
                },
              })}
            />
          </label>
          <label>
            长冷却秒数（60–900）
            <input
              type="number"
              min={60}
              max={900}
              step={30}
              value={config.batch.cooldownSeconds}
              disabled={batchActive}
              onChange={(event) => setConfig({
                ...config,
                batch: {
                  ...config.batch,
                  cooldownSeconds: Number.isFinite(event.target.valueAsNumber)
                    ? event.target.valueAsNumber
                    : DEFAULT_LIEPIN_CONFIG.batch.cooldownSeconds,
                },
              })}
            />
          </label>
        </div>
        <div className={`safety-summary ${safety.cooldownRemainingSeconds > 0 || normalizedBatchConfig.maxDailyDeliveries <= safety.dailyDeliveries ? "safety-blocked" : ""}`}>
          <strong>今日新投递 {safety.dailyDeliveries}/{normalizedBatchConfig.maxDailyDeliveries}</strong>
          <span>
            剩余 {Math.max(0, normalizedBatchConfig.maxDailyDeliveries - safety.dailyDeliveries)} 个
            {safety.cooldownRemainingSeconds > 0 ? ` · 冷却剩余约 ${safety.cooldownRemainingSeconds} 秒` : " · 当前未冷却"}
          </span>
        </div>
        <p className="privacy-note">
          当前识别 {context.jobs.length} 个岗位；可处理 {batchCandidates.length} 个，跳过 {knownContactedJobs.length} 个“继续聊”。
          动作间等待同时用于单岗位和批量投递；批量模式会在二次确认后逐岗生成 AI 文本并直接发送，不逐岗弹出草稿预览。
        </p>
        {batchProgress && (
          <div className={`batch-progress batch-${batchProgress.status}`}>
            <strong>{batchProgress.message}</strong>
            <span>
              进度 {batchProgress.completed}/{batchProgress.total}
              {batchProgress.currentJob ? ` · ${batchProgress.currentJob}` : ""}
              {batchProgress.nextDelaySeconds ? ` · 剩余约 ${batchProgress.nextDelaySeconds} 秒` : ""}
            </span>
            {batchProgress.status === "confirming" && (
              <div className="button-row draft-actions">
                <button className="ghost" type="button" onClick={cancelBatchStart}>取消</button>
                <button type="button" onClick={confirmBatchStart}>确认并开始</button>
              </div>
            )}
          </div>
        )}
      </section>

      <section className="panel">
        <div className="section-title">
          <div>
            <span className="label">当前页面</span>
            <h2>选择一个岗位验收</h2>
          </div>
          <div className="button-row">
            {taskBusy && !batchActive && <button className="danger" type="button" onClick={stopTask} disabled={busy}>停止</button>}
            <button className="ghost" type="button" onClick={inspectPage} disabled={busy || batchActive}>重新识别</button>
          </div>
        </div>

        <div className="job-list">
          {context.jobs.slice(0, 20).map((job) => (
            <article className="job-card" key={job.cardKey}>
              <div>
                <h3>{job.jobTitle}</h3>
                <p>{[job.compName, job.jobSalaryText, job.jobArea].filter(Boolean).join(" · ") || "岗位信息待补充"}</p>
                <small>{job.buttonText || "点击投递时悬停识别沟通状态"}</small>
              </div>
              <button
                type="button"
                onClick={() => prepareJob(job)}
                disabled={busy || taskBusy || batchActive || context.loggedIn === false}
              >
                {config.ai.previewBeforeSend ? "生成草稿" : "生成并投递"}
              </button>
            </article>
          ))}
          {!context.jobs.length && <p className="empty">打开猎聘搜索结果页并点击“重新识别”。</p>}
        </div>
      </section>

      <section className="panel">
        <div className="section-title">
          <div>
            <span className="label">本机记录</span>
            <h2>最近投递结果</h2>
          </div>
          <button className="ghost" type="button" onClick={exportDeliveryLogs} disabled={!attempts.length || busy}>
            导出日志
          </button>
        </div>
        <div className="attempt-list">
          {attempts.map((attempt) => (
            <div className="attempt-entry" key={attempt.id ?? `${attempt.createdAt}-${attempt.job.cardKey}`}>
              <article>
                <div>
                  <strong>{attempt.job.jobTitle}</strong>
                  <p>{attempt.job.compName || "未知公司"}</p>
                  <small>{attempt.message}</small>
                  {attempt.evidence && <small>证据：{attempt.evidence}</small>}
                </div>
                <span className={`outcome outcome-${attempt.outcome}`}>{outcomeLabel(attempt.outcome)}</span>
              </article>
              {attempt.steps && (
                <div className="step-summary">
                  <span>沟通：{stepStatusLabel(attempt.steps.communication.status)}</span>
                  <span>招呼：{attempt.steps.greeting ? stepStatusLabel(attempt.steps.greeting.status) : "-"}</span>
                  <span>简历：{attempt.steps.resume ? stepStatusLabel(attempt.steps.resume.status) : "-"}</span>
                </div>
              )}
              {attempt.logs?.length ? (
                <details className="delivery-log">
                  <summary>查看投递日志（{attempt.logs.length} 条）</summary>
                  <div className="delivery-log-list">
                    {attempt.logs.map((entry, index) => (
                      <div className="delivery-log-entry" key={`${entry.at}-${entry.event}-${index}`}>
                        <strong>{deliveryLogPhaseLabel(entry.phase)} · {entry.message}</strong>
                        <span>{new Date(entry.at).toLocaleString()} · {entry.event}</span>
                        {entry.details && <small>{deliveryLogDetailsText(entry.details)}</small>}
                      </div>
                    ))}
                  </div>
                </details>
              ) : (
                <small className="delivery-log-empty">该记录为旧版本结果，暂无阶段日志。</small>
              )}
            </div>
          ))}
          {!attempts.length && <p className="empty">暂无投递记录。</p>}
        </div>
      </section>
    </main>
  );
}
