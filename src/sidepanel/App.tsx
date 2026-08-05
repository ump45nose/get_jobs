import { useCallback, useEffect, useMemo, useState } from "react";
import { DEFAULT_LIEPIN_CONFIG, createIdleTask } from "../shared/defaults";
import type {
  AppState,
  BackgroundRequest,
  ContentRequest,
  DeliveryAttempt,
  DeliveryResult,
  ExtensionResponse,
  GreetingDraft,
  LiepinConfig,
  LiepinJobSnapshot,
  LiepinPageContext,
  TaskState,
} from "../shared/types";

/** 侧边栏中等待用户预览或编辑的 AI 草稿。 */
interface PendingGreetingDraft {
  tabId: number;
  job: LiepinJobSnapshot;
  text: string;
  sendResume: boolean;
}

const EMPTY_CONTEXT: LiepinPageContext = {
  supported: false,
  loggedIn: null,
  url: "",
  jobs: [],
};

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

/** 猎聘插件侧边栏主界面。 */
export function App() {
  const [config, setConfig] = useState<LiepinConfig>(DEFAULT_LIEPIN_CONFIG);
  const [keywordsText, setKeywordsText] = useState("");
  const [task, setTask] = useState<TaskState>(createIdleTask());
  const [context, setContext] = useState<LiepinPageContext>(EMPTY_CONTEXT);
  const [attempts, setAttempts] = useState<DeliveryAttempt[]>([]);
  const [apiKey, setApiKey] = useState("");
  const [aiApiKeyConfigured, setAiApiKeyConfigured] = useState(false);
  const [pendingDraft, setPendingDraft] = useState<PendingGreetingDraft | null>(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const taskBusy = task.status === "running" || task.status === "stopping";
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
    void inspectPage();

    /** 扩展存储变化时同步后台任务状态，避免依赖轮询。 */
    const onStorageChanged = (changes: Record<string, chrome.storage.StorageChange>) => {
      const nextTask = changes.liepinTask?.newValue as TaskState | undefined;
      if (nextTask) setTask(nextTask);
    };
    chrome.storage.onChanged.addListener(onStorageChanged);
    return () => chrome.storage.onChanged.removeListener(onStorageChanged);
  }, [inspectPage, loadAppState]);

  /** 保存猎聘搜索配置。 */
  async function saveConfig() {
    setBusy(true);
    try {
      const next: LiepinConfig = {
        ...config,
        keywords: keywordsText.split(/[\n,，]+/).map((item) => item.trim()).filter(Boolean),
      };
      await ensureAiHostPermission(next.ai.baseUrl);
      const saved = await sendBackground<LiepinConfig>({
        type: "SAVE_LIEPIN_CONFIG",
        config: next,
        apiKey: apiKey || undefined,
      });
      setConfig(saved);
      setKeywordsText(saved.keywords.join("\n"));
      if (apiKey) {
        setAiApiKeyConfigured(true);
        setApiKey("");
      }
      setNotice("猎聘与 AI 配置已保存");
    } catch (error) {
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

  /**
   * 使用已经生成并确认的草稿执行页面沟通、消息和简历发送。
   *
   * @param job 用户选中的岗位。
   * @param greetingText 用户确认后的招呼语。
   * @param tabId 用户点击岗位时的原始猎聘标签页。
   * @param sendResume 本次草稿生成时锁定的简历发送配置。
   * @returns 页面闭环完成时返回。
   */
  async function executeJob(
    job: LiepinJobSnapshot,
    greetingText: string,
    tabId: number,
    sendResume: boolean,
  ) {
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
      const result = await sendContent<DeliveryResult>({
        type: "APPLY_LIEPIN_JOB",
        taskId,
        cardKey: job.cardKey,
        greetingText,
        sendResume,
      }, tabId);
      setNotice(result.message);
      await loadAppState();
      await inspectPage();
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
    } finally {
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
    setNotice(`正在生成 AI 招呼：${job.jobTitle}`);
    try {
      const tab = await getActiveTab();
      const tabHost = tab.url ? new URL(tab.url).hostname : "";
      if (!tab.id || (tabHost !== "liepin.com" && !tabHost.endsWith(".liepin.com"))) {
        throw new Error("请先打开需要投递的猎聘岗位列表页");
      }
      const sendResume = config.ai.sendResume;
      const draft = await sendBackground<GreetingDraft>({ type: "GENERATE_LIEPIN_GREETING", job });
      if (config.ai.previewBeforeSend) {
        setPendingDraft({ tabId: tab.id, job, text: draft.text, sendResume });
        setNotice("AI 草稿已生成，请预览或编辑后确认发送");
      } else {
        setNotice("AI 草稿已生成，正在按配置直接执行页面发送");
        setBusy(false);
        await executeJob(job, draft.text, tab.id, sendResume);
        return;
      }
    } catch (error) {
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
    await executeJob(selected.job, text, selected.tabId, selected.sendResume);
  }

  /** 取消尚未产生任何页面发送动作的草稿。 */
  function cancelDraft() {
    setPendingDraft(null);
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

  return (
    <main className="app-shell">
      <header className="hero">
        <div>
          <p className="eyebrow">GET JOBS · LIEPIN MVP</p>
          <h1>猎聘投递助手</h1>
          <p>使用当前 Chrome 登录态，只对你明确选择的岗位执行一次投递。</p>
        </div>
        <span className={`status status-${task.status}`}>{statusLabel(task.status)}</span>
      </header>

      <section className="panel compact-grid">
        <div>
          <span className="label">当前页面</span>
          <strong>{loginLabel}</strong>
        </div>
        <div>
          <span className="label">任务消息</span>
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
          <button className="ghost" type="button" onClick={saveConfig} disabled={busy}>保存</button>
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
            <span className={`key-state ${aiApiKeyConfigured ? "configured" : ""}`}>
              {aiApiKeyConfigured ? "Key 已保存" : "Key 未配置"}
            </span>
            {aiApiKeyConfigured && (
              <button className="text-button" type="button" onClick={clearApiKey} disabled={busy}>清除</button>
            )}
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
              placeholder={aiApiKeyConfigured ? "留空则保留已保存 Key" : "输入后点击上方保存"}
              autoComplete="off"
            />
          </label>
        </div>
        <label className="profile-field">
          个人简历摘要（只填写真实经历）
          <textarea
            value={config.ai.resumeSummary}
            onChange={(event) => setConfig({ ...config, ai: { ...config.ai, resumeSummary: event.target.value } })}
            rows={5}
            placeholder="例如：5 年 Java/AI 应用经验，负责过 Agent、RAG、多模型接入……"
          />
        </label>
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
        </div>
        <p className="privacy-note">简历摘要会发送给你配置的 AI 服务；API Key 仅保存在本机扩展存储，不写入投递历史。</p>
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

      <section className="panel">
        <div className="section-title">
          <div>
            <span className="label">当前页面</span>
            <h2>选择一个岗位验收</h2>
          </div>
          <div className="button-row">
            {taskBusy && <button className="danger" type="button" onClick={stopTask} disabled={busy}>停止</button>}
            <button className="ghost" type="button" onClick={inspectPage} disabled={busy}>重新识别</button>
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
                disabled={busy || taskBusy || context.loggedIn === false}
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
        </div>
        <div className="attempt-list">
          {attempts.map((attempt) => (
            <div className="attempt-entry" key={attempt.id ?? `${attempt.createdAt}-${attempt.job.cardKey}`}>
              <article>
                <div>
                  <strong>{attempt.job.jobTitle}</strong>
                  <p>{attempt.job.compName || "未知公司"}</p>
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
            </div>
          ))}
          {!attempts.length && <p className="empty">暂无投递记录。</p>}
        </div>
      </section>
    </main>
  );
}
