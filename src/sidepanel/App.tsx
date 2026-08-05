import { useCallback, useEffect, useMemo, useState } from "react";
import { DEFAULT_LIEPIN_CONFIG, createIdleTask } from "../shared/defaults";
import type {
  AppState,
  BackgroundRequest,
  ContentRequest,
  DeliveryAttempt,
  DeliveryResult,
  ExtensionResponse,
  LiepinConfig,
  LiepinJobSnapshot,
  LiepinPageContext,
  TaskState,
} from "../shared/types";

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
 * @returns 页面响应数据。
 */
async function sendContent<T>(request: ContentRequest): Promise<T> {
  const tab = await getActiveTab();
  const response = (await chrome.tabs.sendMessage(tab.id!, request)) as ExtensionResponse<T>;
  if (!response.ok) throw new Error(response.error || "猎聘页面操作失败");
  return response.data as T;
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

/** 猎聘插件侧边栏主界面。 */
export function App() {
  const [config, setConfig] = useState<LiepinConfig>(DEFAULT_LIEPIN_CONFIG);
  const [keywordsText, setKeywordsText] = useState("");
  const [task, setTask] = useState<TaskState>(createIdleTask());
  const [context, setContext] = useState<LiepinPageContext>(EMPTY_CONTEXT);
  const [attempts, setAttempts] = useState<DeliveryAttempt[]>([]);
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
      const saved = await sendBackground<LiepinConfig>({ type: "SAVE_LIEPIN_CONFIG", config: next });
      setConfig(saved);
      setKeywordsText(saved.keywords.join("\n"));
      setNotice("猎聘配置已保存");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  /** 对用户点击的单个岗位执行一次闭环投递。 */
  async function applyJob(job: LiepinJobSnapshot) {
    setBusy(true);
    setNotice(`准备投递：${job.jobTitle}`);
    let taskStarted = false;
    let taskId: string | undefined;
    try {
      const tab = await getActiveTab();
      const startedTask = await sendBackground<TaskState>({ type: "START_LIEPIN_TASK", tabId: tab.id!, job });
      setTask(startedTask);
      taskStarted = true;
      taskId = startedTask.taskId;
      if (!taskId) throw new Error("后台未生成任务标识");
      const result = await sendContent<DeliveryResult>({
        type: "APPLY_LIEPIN_JOB",
        taskId,
        cardKey: job.cardKey,
      });
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

  /** 请求当前内容脚本停止尚未完成的等待。 */
  async function stopTask() {
    setBusy(true);
    try {
      if (!task.taskId) throw new Error("当前任务缺少唯一标识，无法安全停止");
      const taskId = task.taskId;
      const stopping = await sendBackground<TaskState>({ type: "REQUEST_LIEPIN_STOP", taskId });
      setTask(stopping);
      const stopped = await sendContent<{ stopped: boolean; applying: boolean }>({
        type: "STOP_LIEPIN_TASK",
        taskId,
      });
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
                <small>{job.buttonText || "未识别到沟通按钮"}</small>
              </div>
              <button
                type="button"
                onClick={() => applyJob(job)}
                disabled={busy || taskBusy || !job.buttonText || context.loggedIn === false}
              >
                投递这一个
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
            <article key={`${attempt.createdAt}-${attempt.job.cardKey}`}>
              <div>
                <strong>{attempt.job.jobTitle}</strong>
                <p>{attempt.job.compName || "未知公司"}</p>
              </div>
              <span className={`outcome outcome-${attempt.outcome}`}>{outcomeLabel(attempt.outcome)}</span>
            </article>
          ))}
          {!attempts.length && <p className="empty">暂无投递记录。</p>}
        </div>
      </section>
    </main>
  );
}
