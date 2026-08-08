import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_ZHILIAN_CONFIG,
  normalizeZhilianConfig,
  randomBatchDelayMilliseconds,
} from "../shared/defaults";
import { getLiepinSafetyStatus } from "../shared/liepin-safety";
import type {
  BackgroundRequest,
  ContentRequest,
  ExtensionResponse,
  LiepinSafetyStatus,
  ZhilianAppState,
  ZhilianConfig,
  ZhilianDeliveryAttempt,
  ZhilianDeliveryResult,
  ZhilianJobSnapshot,
  ZhilianPageContext,
  ZhilianTaskState,
} from "../shared/types";

const EMPTY_CONTEXT: ZhilianPageContext = { supported: false, loggedIn: null, url: "", jobs: [] };
const EMPTY_TASK: ZhilianTaskState = {
  platform: "zhilian",
  status: "idle",
  updatedAt: new Date(0).toISOString(),
  message: "尚未开始智联投递",
};
const EMPTY_SAFETY = getLiepinSafetyStatus(undefined, DEFAULT_ZHILIAN_CONFIG.batch);

/** 当前页顺序投递的临时展示状态。 */
interface ZhilianBatchProgress {
  status: "running" | "waiting" | "completed" | "stopped" | "failed";
  completed: number;
  total: number;
  message: string;
  currentJob?: string;
  remainingSeconds?: number;
}

/** 向后台发送智联业务消息并统一抛出错误。 */
async function sendBackground<T>(request: BackgroundRequest): Promise<T> {
  const response = await chrome.runtime.sendMessage(request) as ExtensionResponse<T>;
  if (!response.ok) throw new Error(response.error || "智联后台操作失败");
  return response.data as T;
}

/** 读取当前活动标签页，并确保动作仍绑定用户看到的智联页面。 */
async function getActiveTab(): Promise<chrome.tabs.Tab> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined) throw new Error("无法识别当前智联标签页");
  return tab;
}

/** 向指定智联标签页的 Content Script 发送页面操作。 */
async function sendContent<T>(request: ContentRequest, tabId: number): Promise<T> {
  const response = await chrome.tabs.sendMessage(tabId, request) as ExtensionResponse<T>;
  if (!response.ok) throw new Error(response.error || "智联页面操作失败");
  return response.data as T;
}

/** 判断 URL 是否属于智联招聘域名。 */
function isZhilianUrl(url: string | undefined): boolean {
  try {
    return Boolean(url) && /(^|\.)zhaopin\.com$/i.test(new URL(url!).hostname);
  } catch {
    return false;
  }
}

/** 将任务状态转换为简短中文标签。 */
function statusLabel(status: ZhilianTaskState["status"]): string {
  return ({
    idle: "空闲",
    running: "执行中",
    stopping: "停止中",
    success: "成功",
    cancelled: "已停止",
    blocked: "受阻",
    failed: "失败",
    interrupted: "需核对",
  } as const)[status];
}

/** 智联页内抽屉主界面：单岗位直投与当前页安全顺序投递。 */
export function ZhilianApp() {
  const [context, setContext] = useState<ZhilianPageContext>(EMPTY_CONTEXT);
  const [config, setConfig] = useState<ZhilianConfig>(DEFAULT_ZHILIAN_CONFIG);
  const [task, setTask] = useState<ZhilianTaskState>(EMPTY_TASK);
  const [attempts, setAttempts] = useState<ZhilianDeliveryAttempt[]>([]);
  const [safety, setSafety] = useState<LiepinSafetyStatus>(EMPTY_SAFETY);
  const [batchProgress, setBatchProgress] = useState<ZhilianBatchProgress | null>(null);
  const [notice, setNotice] = useState("正在读取智联页面…");
  const [busy, setBusy] = useState(false);
  const batchStopRequested = useRef(false);

  const batchActive = batchProgress?.status === "running" || batchProgress?.status === "waiting";
  const taskBusy = task.status === "running" || task.status === "stopping" || busy || batchActive;
  const candidates = useMemo(
    () => context.jobs.filter((job) => !/已投递|已申请/.test(job.buttonText ?? "")),
    [context.jobs],
  );
  const successfulCount = useMemo(
    () => attempts.filter((attempt) => attempt.outcome === "delivered").length,
    [attempts],
  );

  /** 从后台恢复智联配置、任务、历史和独立安全状态。 */
  const loadState = useCallback(async (): Promise<ZhilianAppState> => {
    const state = await sendBackground<ZhilianAppState>({ type: "GET_ZHILIAN_APP_STATE" });
    setConfig(state.config);
    setTask(state.task);
    setAttempts(state.attempts);
    setSafety(state.safety);
    return state;
  }, []);

  /** 重新识别当前智联搜索结果页。 */
  const inspectPage = useCallback(async (): Promise<ZhilianPageContext> => {
    try {
      const tab = await getActiveTab();
      if (!isZhilianUrl(tab.url)) throw new Error("请保持智联岗位列表页为当前活动标签页");
      const page = await sendContent<ZhilianPageContext>({ type: "INSPECT_ZHILIAN" }, tab.id!);
      setContext(page);
      setNotice(page.jobs.length ? `识别到 ${page.jobs.length} 个智联岗位` : page.issue || "未识别到岗位");
      return page;
    } catch (error) {
      setContext(EMPTY_CONTEXT);
      setNotice(error instanceof Error ? `${error.message}；请刷新智联页面后重试` : String(error));
      return EMPTY_CONTEXT;
    }
  }, []);

  useEffect(() => {
    void Promise.all([loadState(), inspectPage()]).catch((error: unknown) => {
      setNotice(error instanceof Error ? error.message : String(error));
    });
    const onStorageChanged = (changes: Record<string, chrome.storage.StorageChange>) => {
      const nextTask = changes.zhilianTask?.newValue as ZhilianTaskState | undefined;
      if (nextTask) setTask(nextTask);
    };
    chrome.storage.onChanged.addListener(onStorageChanged);
    return () => chrome.storage.onChanged.removeListener(onStorageChanged);
  }, [inspectPage, loadState]);

  /** 保存并返回已由后台规整的智联配置。 */
  async function saveConfig(): Promise<ZhilianConfig> {
    const saved = await sendBackground<ZhilianConfig>({
      type: "SAVE_ZHILIAN_CONFIG",
      config: normalizeZhilianConfig(config),
    });
    setConfig(saved);
    setNotice("智联简历与安全节奏配置已保存");
    return saved;
  }

  /** 执行一个岗位并把明确结果交给后台原子记录。 */
  async function executeJob(
    job: ZhilianJobSnapshot,
    tabId: number,
    frozenConfig: ZhilianConfig,
  ): Promise<ZhilianDeliveryResult> {
    const started = await sendBackground<ZhilianTaskState>({ type: "START_ZHILIAN_TASK", tabId, job });
    setTask(started);
    const result = await sendContent<ZhilianDeliveryResult>({
      type: "APPLY_ZHILIAN_JOB",
      taskId: started.taskId!,
      cardKey: job.cardKey,
      config: frozenConfig,
    }, tabId);
    const nextTask = await sendBackground<ZhilianTaskState>({
      type: "RECORD_ZHILIAN_ATTEMPT",
      taskId: started.taskId!,
      result,
    });
    setTask(nextTask);
    return result;
  }

  /** 单岗位按钮一次点击直接开始完整闭环，不再弹插件二次确认。 */
  async function applyDirect(job: ZhilianJobSnapshot): Promise<void> {
    if (taskBusy) return setNotice("已有任务正在执行，请等待完成或先停止");
    if (context.loggedIn !== true) return setNotice("请先确认智联已登录，再重新识别页面");
    let taskId: string | undefined;
    try {
      setBusy(true);
      const tab = await getActiveTab();
      if (!isZhilianUrl(tab.url)) throw new Error("请保持智联岗位列表页为当前活动标签页");
      const saved = await saveConfig();
      const result = await executeJob(job, tab.id!, saved);
      taskId = task.taskId;
      setNotice(result.message);
      await Promise.all([loadState(), inspectPage()]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setNotice(message);
      const activeState = await sendBackground<ZhilianAppState>({ type: "GET_ZHILIAN_APP_STATE" }).catch(() => null);
      taskId = activeState?.task.status === "running" ? activeState.task.taskId : taskId;
      if (taskId) {
        const failed = await sendBackground<ZhilianTaskState>({
          type: "FAIL_ZHILIAN_TASK",
          taskId,
          message,
        }).catch(() => null);
        if (failed) setTask(failed);
      }
    } finally {
      setBusy(false);
    }
  }

  /** 小步等待，保证批次停止按钮无需等待完整随机或冷却时间。 */
  async function waitBatch(milliseconds: number, completed: number, total: number, message: string): Promise<boolean> {
    const deadline = Date.now() + milliseconds;
    while (Date.now() < deadline) {
      if (batchStopRequested.current) return false;
      const remainingSeconds = Math.max(1, Math.ceil((deadline - Date.now()) / 1_000));
      setBatchProgress({ status: "waiting", completed, total, message, remainingSeconds });
      await new Promise((resolve) => window.setTimeout(resolve, Math.min(500, deadline - Date.now())));
    }
    return !batchStopRequested.current;
  }

  /** 一次点击冻结当前页岗位快照，并按安全配额顺序执行。 */
  async function startBatch(): Promise<void> {
    if (taskBusy) return setNotice("已有任务正在执行，请等待完成或先停止");
    if (context.loggedIn !== true) return setNotice("请先确认智联已登录，再重新识别页面");
    batchStopRequested.current = false;
    let activeTaskId: string | undefined;
    try {
      setBusy(true);
      const tab = await getActiveTab();
      if (!isZhilianUrl(tab.url)) throw new Error("请保持智联岗位列表页为当前活动标签页");
      const saved = await saveConfig();
      const state = await sendBackground<ZhilianAppState>({ type: "GET_ZHILIAN_APP_STATE" });
      if (state.safety.blockedReason) throw new Error(state.safety.blockedReason);
      const allowed = Math.min(
        candidates.length,
        saved.batch.maxBatchSize,
        state.safety.remainingDailyDeliveries,
      );
      const queue = candidates.slice(0, allowed);
      if (!queue.length) throw new Error("当前页没有可投递的新岗位，或今日安全额度已用完");
      setBatchProgress({ status: "running", completed: 0, total: queue.length, message: "顺序投递已开始" });

      let completed = 0;
      for (const job of queue) {
        if (batchStopRequested.current) break;
        setBatchProgress({
          status: "running",
          completed,
          total: queue.length,
          currentJob: job.jobTitle,
          message: "正在执行岗位闭环",
        });
        const result = await executeJob(job, tab.id!, saved);
        activeTaskId = undefined;
        completed += 1;
        if (result.outcome !== "delivered" && result.outcome !== "already-applied") {
          throw new Error(`在“${job.jobTitle}”熔断：${result.message}`);
        }
        const refreshed = await sendBackground<ZhilianAppState>({ type: "GET_ZHILIAN_APP_STATE" });
        setSafety(refreshed.safety);
        setAttempts(refreshed.attempts);
        if (completed >= queue.length) break;
        if (refreshed.safety.remainingDailyDeliveries <= 0) {
          throw new Error(`今日已达到 ${saved.batch.maxDailyDeliveries} 个新投递上限`);
        }
        const delay = refreshed.safety.cooldownRemainingSeconds > 0
          ? refreshed.safety.cooldownRemainingSeconds * 1_000
          : randomBatchDelayMilliseconds(saved.batch);
        const label = refreshed.safety.cooldownRemainingSeconds > 0 ? "连续成功后的账号安全冷却" : "岗位间随机等待";
        if (!(await waitBatch(delay, completed, queue.length, label))) break;
      }

      if (batchStopRequested.current) {
        setBatchProgress({ status: "stopped", completed, total: queue.length, message: "顺序投递已停止" });
        setNotice("顺序投递已停止；不会继续处理剩余岗位");
      } else {
        setBatchProgress({ status: "completed", completed, total: queue.length, message: "当前页顺序投递完成" });
        setNotice(`当前页顺序投递完成，共处理 ${completed} 个岗位`);
      }
      await Promise.all([loadState(), inspectPage()]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setBatchProgress((current) => ({
        status: "failed",
        completed: current?.completed ?? 0,
        total: current?.total ?? 0,
        message,
      }));
      setNotice(message);
      const current = await sendBackground<ZhilianAppState>({ type: "GET_ZHILIAN_APP_STATE" }).catch(() => null);
      activeTaskId = current?.task.status === "running" ? current.task.taskId : activeTaskId;
      if (activeTaskId) {
        await sendBackground({ type: "FAIL_ZHILIAN_TASK", taskId: activeTaskId, message }).catch(() => undefined);
      }
    } finally {
      setBusy(false);
    }
  }

  /** 停止当前单岗位或顺序投递，并通知结果子标签停止后续动作。 */
  async function stopTask(): Promise<void> {
    batchStopRequested.current = true;
    const state = await sendBackground<ZhilianAppState>({ type: "GET_ZHILIAN_APP_STATE" }).catch(() => null);
    if (state?.task.taskId && state.task.status === "running") {
      await sendBackground({ type: "CANCEL_ZHILIAN_TASK", taskId: state.task.taskId }).catch(() => undefined);
    }
    setNotice("正在停止；已发生的点击不会自动重试，请核对智联投递记录");
  }

  /** 更新批量配置中的单个数字字段。 */
  function updateBatchNumber(key: keyof ZhilianConfig["batch"], value: string): void {
    const parsed = Number(value);
    setConfig((current) => ({
      ...current,
      batch: { ...current.batch, [key]: Number.isFinite(parsed) ? parsed : current.batch[key] },
    }));
  }

  return (
    <main className="app-shell">
      <section className="hero">
        <div>
          <p className="eyebrow">GET JOBS · ZHILIAN</p>
          <h1>智联投递助手</h1>
          <p>一次点击完成简历选择、提交、明确回执与成功页关闭。</p>
        </div>
        <span className={`status status-${task.status}`}>{statusLabel(task.status)}</span>
      </section>

      <section className="panel compact">
        <div className="section-title">
          <div><span className="eyebrow">当前页面</span><h2>{context.loggedIn === true ? "已登录" : context.loggedIn === false ? "未登录" : "登录状态待确认"}</h2></div>
          <button className="ghost" type="button" onClick={() => void inspectPage()}>重新识别</button>
        </div>
        <p>{task.message}</p>
      </section>
      {notice && <p className="notice">{notice}</p>}

      <section className="panel">
        <div className="section-title"><div><span className="eyebrow">简历与节奏</span><h2>智联自动投递配置</h2></div><button className="ghost" type="button" disabled={taskBusy} onClick={() => void saveConfig()}>保存</button></div>
        <label>简历类型
          <select value={config.resumeMode} disabled={taskBusy} onChange={(event) => setConfig((current) => ({ ...current, resumeMode: event.target.value as ZhilianConfig["resumeMode"] }))}>
            <option value="attachment">附件简历（推荐）</option>
            <option value="online">在线简历</option>
          </select>
        </label>
        <label className="profile-field">附件简历名称（可留空）
          <input value={config.preferredResumeName} disabled={taskBusy || config.resumeMode !== "attachment"} placeholder="例如：简历-俞玮康.pdf；留空仅允许唯一附件" onChange={(event) => setConfig((current) => ({ ...current, preferredResumeName: event.target.value }))} />
        </label>
        <div className="field-row">
          <label>动作最短（秒）<input type="number" min="0.5" max="10" step="0.1" value={config.batch.minActionIntervalSeconds} onChange={(event) => updateBatchNumber("minActionIntervalSeconds", event.target.value)} /></label>
          <label>动作最长（秒）<input type="number" min="0.5" max="10" step="0.1" value={config.batch.maxActionIntervalSeconds} onChange={(event) => updateBatchNumber("maxActionIntervalSeconds", event.target.value)} /></label>
          <label>岗位最短（秒）<input type="number" min="5" max="300" value={config.batch.minIntervalSeconds} onChange={(event) => updateBatchNumber("minIntervalSeconds", event.target.value)} /></label>
          <label>岗位最长（秒）<input type="number" min="5" max="300" value={config.batch.maxIntervalSeconds} onChange={(event) => updateBatchNumber("maxIntervalSeconds", event.target.value)} /></label>
          <label>回执超时（秒）<input type="number" min="10" max="120" value={config.batch.resumeReceiptTimeoutSeconds} onChange={(event) => updateBatchNumber("resumeReceiptTimeoutSeconds", event.target.value)} /></label>
          <label>单批上限<input type="number" min="1" max="20" value={config.batch.maxBatchSize} onChange={(event) => updateBatchNumber("maxBatchSize", event.target.value)} /></label>
          <label>每日上限<input type="number" min="1" max="50" value={config.batch.maxDailyDeliveries} onChange={(event) => updateBatchNumber("maxDailyDeliveries", event.target.value)} /></label>
          <label>连续成功后冷却<input type="number" min="3" max="10" value={config.batch.cooldownEvery} onChange={(event) => updateBatchNumber("cooldownEvery", event.target.value)} /></label>
          <label>长冷却（秒）<input type="number" min="60" max="900" value={config.batch.cooldownSeconds} onChange={(event) => updateBatchNumber("cooldownSeconds", event.target.value)} /></label>
        </div>
        <p className="privacy-note">不会勾选智联“每次投递默认发送该简历”。多附件无唯一匹配、验证码、频控、上限或未知回执会立即停止并保留现场。</p>
      </section>

      <section className="panel batch-panel">
        <div className="section-title">
          <div><span className="eyebrow">当前页面</span><h2>一键顺序投递</h2></div>
          {batchActive || task.status === "running"
            ? <button className="danger" type="button" onClick={() => void stopTask()}>停止</button>
            : <button type="button" disabled={taskBusy || !candidates.length} onClick={() => void startBatch()}>顺序投递当前页</button>}
        </div>
        <div className={`safety-summary ${safety.blockedReason ? "safety-blocked" : ""}`}>
          <strong>今日新投递 {safety.dailyDeliveries}/{config.batch.maxDailyDeliveries}</strong>
          <span>剩余 {Math.max(0, safety.remainingDailyDeliveries)} 个{safety.cooldownRemainingSeconds ? ` · 冷却约 ${safety.cooldownRemainingSeconds} 秒` : " · 当前未冷却"}</span>
        </div>
        <p className="privacy-note">当前识别 {context.jobs.length} 个；可处理 {candidates.length} 个，已投岗位自动跳过。</p>
        {batchProgress && <div className={`batch-progress batch-${batchProgress.status}`}><strong>{batchProgress.message}</strong><span>进度 {batchProgress.completed}/{batchProgress.total}{batchProgress.currentJob ? ` · ${batchProgress.currentJob}` : ""}{batchProgress.remainingSeconds ? ` · 剩余约 ${batchProgress.remainingSeconds} 秒` : ""}</span></div>}
      </section>

      <section className="panel">
        <div className="section-title"><div><span className="eyebrow">单岗位</span><h2>一次点击直接投递</h2></div><span>{context.jobs.length} 个</span></div>
        <div className="job-list">
          {context.jobs.map((job) => {
            const alreadyApplied = /已投递|已申请/.test(job.buttonText ?? "");
            return <article className="job-card" key={job.cardKey}><div><h3>{job.jobTitle}</h3><p>{[job.compName, job.jobSalaryText, job.jobArea].filter(Boolean).join(" · ")}</p><small>{job.buttonText}</small></div><button type="button" disabled={taskBusy || alreadyApplied} onClick={() => void applyDirect(job)}>{alreadyApplied ? "已投递" : "直接投递"}</button></article>;
          })}
        </div>
        {!context.jobs.length && <p className="empty">打开智联职位搜索结果页并点击“重新识别”。</p>}
      </section>

      <section className="panel">
        <div className="section-title"><h2>最近智联记录</h2><span>成功 {successfulCount}</span></div>
        <div className="attempt-list">{attempts.map((attempt) => <article key={`${attempt.taskId}-${attempt.createdAt}`}><div><strong>{attempt.job.jobTitle}</strong><p>{attempt.message}</p><small>{new Date(attempt.createdAt).toLocaleString()}</small></div><span>{attempt.outcome === "delivered" ? "成功" : attempt.outcome === "already-applied" ? "已投" : "未确认"}</span></article>)}</div>
        {!attempts.length && <p className="empty">尚无智联投递记录。</p>}
      </section>
    </main>
  );
}
