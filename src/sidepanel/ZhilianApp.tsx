import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  BackgroundRequest,
  ContentRequest,
  ExtensionResponse,
  ZhilianAppState,
  ZhilianDeliveryAttempt,
  ZhilianDeliveryResult,
  ZhilianJobSnapshot,
  ZhilianPageContext,
  ZhilianTaskState,
} from "../shared/types";

const EMPTY_CONTEXT: ZhilianPageContext = {
  supported: false,
  loggedIn: null,
  url: "",
  jobs: [],
};

const EMPTY_TASK: ZhilianTaskState = {
  platform: "zhilian",
  status: "idle",
  updatedAt: new Date(0).toISOString(),
  message: "尚未开始智联投递",
};

/** 向后台发送智联业务消息并统一抛出错误。 */
async function sendBackground<T>(request: BackgroundRequest): Promise<T> {
  const response = await chrome.runtime.sendMessage(request) as ExtensionResponse<T>;
  if (!response.ok) throw new Error(response.error || "智联后台操作失败");
  return response.data as T;
}

/** 读取当前活动标签页，并确保后续动作仍绑定用户看到的页面。 */
async function getActiveTab(): Promise<chrome.tabs.Tab> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined) throw new Error("无法识别当前智联标签页");
  return tab;
}

/** 向指定智联标签页的 Content Script 发送页面操作。 */
async function sendContent<T>(request: ContentRequest, tabId?: number): Promise<T> {
  const targetTabId = tabId ?? (await getActiveTab()).id;
  if (targetTabId === undefined) throw new Error("无法识别目标智联标签页");
  const response = await chrome.tabs.sendMessage(targetTabId, request) as ExtensionResponse<T>;
  if (!response.ok) throw new Error(response.error || "智联页面操作失败");
  return response.data as T;
}

/** 判断 URL 是否属于智联招聘域名。 */
function isZhilianUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    return /(^|\.)zhaopin\.com$/i.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** 将后台任务状态转换为简短中文标签。 */
function statusLabel(status: ZhilianTaskState["status"]): string {
  const labels: Record<ZhilianTaskState["status"], string> = {
    idle: "空闲",
    running: "执行中",
    stopping: "停止中",
    success: "成功",
    cancelled: "已停止",
    blocked: "受阻",
    failed: "失败",
    interrupted: "需核对",
  };
  return labels[status];
}

/** 智联页内抽屉主界面，首版只开放单岗位明确回执闭环。 */
export function ZhilianApp() {
  const [context, setContext] = useState<ZhilianPageContext>(EMPTY_CONTEXT);
  const [task, setTask] = useState<ZhilianTaskState>(EMPTY_TASK);
  const [attempts, setAttempts] = useState<ZhilianDeliveryAttempt[]>([]);
  const [pendingJob, setPendingJob] = useState<ZhilianJobSnapshot | null>(null);
  const [notice, setNotice] = useState("正在读取智联页面…");
  const [busy, setBusy] = useState(false);

  const taskBusy = task.status === "running" || task.status === "stopping" || busy;
  const successfulCount = useMemo(
    () => attempts.filter((attempt) => attempt.outcome === "delivered").length,
    [attempts],
  );

  /** 从后台恢复智联任务和最近历史。 */
  const loadState = useCallback(async () => {
    const state = await sendBackground<ZhilianAppState>({ type: "GET_ZHILIAN_APP_STATE" });
    setTask(state.task);
    setAttempts(state.attempts);
  }, []);

  /** 重新识别当前智联搜索结果页。 */
  const inspectPage = useCallback(async () => {
    try {
      const page = await sendContent<ZhilianPageContext>({ type: "INSPECT_ZHILIAN" });
      setContext(page);
      setNotice(page.jobs.length ? `识别到 ${page.jobs.length} 个智联岗位` : page.issue || "未识别到岗位");
    } catch (error) {
      setContext(EMPTY_CONTEXT);
      setNotice(error instanceof Error ? `${error.message}；请刷新智联页面后重试` : String(error));
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

  /** 打开单岗位二次确认，不在第一次点击时操作智联页面。 */
  function requestApply(job: ZhilianJobSnapshot): void {
    if (taskBusy) {
      setNotice("已有任务正在执行，请等待完成或先停止");
      return;
    }
    if (context.loggedIn === false) {
      setNotice("请先登录智联招聘后再投递");
      return;
    }
    setPendingJob(job);
    setNotice("请核对岗位和默认简历设置，再确认本次申请");
  }

  /** 用户二次确认后执行一次智联申请并持久化明确结果。 */
  async function confirmApply(): Promise<void> {
    if (!pendingJob) return;
    const job = pendingJob;
    let startedTask: ZhilianTaskState | null = null;
    try {
      setBusy(true);
      const tab = await getActiveTab();
      if (!isZhilianUrl(tab.url)) throw new Error("请保持原智联岗位列表页为当前活动标签页");
      startedTask = await sendBackground<ZhilianTaskState>({ type: "START_ZHILIAN_TASK", tabId: tab.id!, job });
      setTask(startedTask);
      setPendingJob(null);
      const result = await sendContent<ZhilianDeliveryResult>({
        type: "APPLY_ZHILIAN_JOB",
        taskId: startedTask.taskId!,
        cardKey: job.cardKey,
      }, tab.id);
      const nextTask = await sendBackground<ZhilianTaskState>({
        type: "RECORD_ZHILIAN_ATTEMPT",
        taskId: startedTask.taskId!,
        result,
      });
      setTask(nextTask);
      setNotice(result.message);
      await loadState();
      await inspectPage();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setNotice(message);
      if (startedTask?.taskId) {
        const failed = await sendBackground<ZhilianTaskState>({
          type: "FAIL_ZHILIAN_TASK",
          taskId: startedTask.taskId,
          message,
        }).catch(() => null);
        if (failed) setTask(failed);
      }
    } finally {
      setBusy(false);
    }
  }

  /** 停止当前页面轮询；已发生的点击不会被自动重试。 */
  async function stopTask(): Promise<void> {
    if (!task.taskId || task.status !== "running" || task.tabId === undefined) return;
    try {
      await sendContent({ type: "STOP_ZHILIAN_TASK", taskId: task.taskId }, task.tabId);
      const cancelled = await sendBackground<ZhilianTaskState>({
        type: "CANCEL_ZHILIAN_TASK",
        taskId: task.taskId,
      });
      setTask(cancelled);
      setNotice("智联任务已停止；如果此前已点击，请先核对平台投递记录");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <main className="app-shell">
      <section className="hero">
        <div>
          <p className="eyebrow">GET JOBS · ZHILIAN MVP</p>
          <h1>智联投递助手</h1>
          <p>使用当前 Chrome 登录态，首版只执行经你二次确认的单岗位默认简历申请。</p>
        </div>
        <span className={`status status-${task.status}`}>{statusLabel(task.status)}</span>
      </section>

      <section className="panel compact">
        <div className="section-title">
          <div>
            <span className="eyebrow">当前页面</span>
            <h2>{context.supported ? (context.loggedIn === false ? "未登录" : "智联页面已连接") : "请打开智联招聘"}</h2>
          </div>
          <button className="ghost" type="button" onClick={() => void inspectPage()}>重新识别</button>
        </div>
        <p>{task.message}</p>
      </section>

      {notice && <p className="notice">{notice}</p>}

      <section className="panel">
        <div className="section-title">
          <div>
            <span className="eyebrow">安全边界</span>
            <h2>单岗位默认简历申请</h2>
          </div>
        </div>
        <p className="privacy-note">智联账号必须已设置默认在线简历或附件简历。只有“申请成功/投递成功”或岗位按钮明确变为“已投递”才计为成功；结果未知会停止，不会自动重试。</p>
        <p className="privacy-note">当前版本尚未完成真实 DOM 验收，因此不开放顺序投递。验证码、上限或登录失效会立即停止。</p>
        {task.status === "running" && <button className="danger" type="button" onClick={() => void stopTask()}>停止并核对</button>}
      </section>

      {pendingJob && (
        <section className="panel">
          <div className="section-title"><h2>确认本次智联申请</h2></div>
          <article className="job-card">
            <div>
              <h3>{pendingJob.jobTitle}</h3>
              <p>{[pendingJob.compName, pendingJob.jobSalaryText, pendingJob.jobArea].filter(Boolean).join(" · ")}</p>
              <small>将使用智联账号当前默认简历</small>
            </div>
          </article>
          <div className="button-row">
            <button className="ghost" type="button" onClick={() => setPendingJob(null)}>取消</button>
            <button type="button" disabled={busy} onClick={() => void confirmApply()}>确认立即投递</button>
          </div>
        </section>
      )}

      <section className="panel">
        <div className="section-title">
          <div>
            <span className="eyebrow">当前页面</span>
            <h2>选择一个岗位验收</h2>
          </div>
          <span>{context.jobs.length} 个</span>
        </div>
        <div className="job-list">
          {context.jobs.map((job) => {
            const alreadyApplied = /已投递|已申请/.test(job.buttonText ?? "");
            return (
              <article className="job-card" key={job.cardKey}>
                <div>
                  <h3>{job.jobTitle}</h3>
                  <p>{[job.compName, job.jobSalaryText, job.jobArea].filter(Boolean).join(" · ") || "岗位信息待补充"}</p>
                  <small>{job.buttonText || "申请按钮待点击时识别"}</small>
                </div>
                <button type="button" disabled={taskBusy || alreadyApplied} onClick={() => requestApply(job)}>
                  {alreadyApplied ? "已投递" : "投递这个"}
                </button>
              </article>
            );
          })}
        </div>
        {!context.jobs.length && <p className="empty">打开智联职位搜索结果页并点击“重新识别”。</p>}
      </section>

      <section className="panel">
        <div className="section-title"><h2>最近智联记录</h2><span>成功 {successfulCount}</span></div>
        <div className="attempt-list">
          {attempts.map((attempt) => (
            <article key={`${attempt.taskId}-${attempt.createdAt}`}>
              <div>
                <strong>{attempt.job.jobTitle}</strong>
                <p>{attempt.message}</p>
                <small>{new Date(attempt.createdAt).toLocaleString()}</small>
              </div>
              <span>{attempt.outcome === "delivered" ? "成功" : attempt.outcome === "already-applied" ? "已投" : "未确认"}</span>
            </article>
          ))}
        </div>
        {!attempts.length && <p className="empty">尚无智联投递记录。</p>}
      </section>
    </main>
  );
}
