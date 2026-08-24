import { mountEmbeddedPanel, type EmbeddedPanelController } from "./embedded-panel";
import {
  ZHILIAN_APPLY_BUTTON_SELECTORS,
  ZHILIAN_DETAIL_SELECTORS,
  ZHILIAN_OUTCOME_SCOPE_SELECTORS,
  detectZhilianLoginState,
  detectZhilianAppliedPageOutcome,
  detectZhilianOutcomeFromText,
  findZhilianJobCards,
  isZhilianDetailBoundToJob,
  isSameZhilianJob,
  parseZhilianJobCard,
  parseZhilianJobs,
} from "../shared/zhilian-parser";
import { randomActionDelayMilliseconds } from "../shared/defaults";
import { findZhilianSuccessCloseButton } from "../shared/zhilian-success-dialog";
import type {
  BackgroundRequest,
  ContentRequest,
  ExtensionResponse,
  ZhilianDeliveryResult,
  ZhilianExternalOutcome,
  ZhilianConfig,
  ZhilianJobSnapshot,
  ZhilianPageContext,
} from "../shared/types";

const SUPPORTED_HOST_PATTERN = /(^|\.)zhaopin\.com$/i;
const APPLY_TEXTS = new Set(["立即投递", "申请职位"]);
const ALREADY_APPLIED_TEXTS = new Set(["已投递", "已申请"]);

let panelController: EmbeddedPanelController | null = null;
let recoveryObserver: MutationObserver | null = null;
let activeTaskId: string | null = null;
let stopRequested = false;

/** 创建或复用智联页内助手抽屉。 */
function ensureEmbeddedPanel(): EmbeddedPanelController {
  if (panelController?.host.isConnected) return panelController;
  panelController = mountEmbeddedPanel({
    documentRef: document,
    iframeUrl: chrome.runtime.getURL("sidepanel.html?embedded=1&platform=zhilian"),
    initiallyOpen: true,
    platformLabel: "智联",
  });
  return panelController;
}

/** 监控站点 SPA 清理未知节点的情况，并幂等恢复助手入口。 */
function startEmbeddedPanelRecovery(): void {
  if (recoveryObserver) return;
  recoveryObserver = new MutationObserver(() => {
    if (!panelController?.host.isConnected) {
      const wasOpen = panelController?.isOpen() ?? false;
      panelController = null;
      ensureEmbeddedPanel().setOpen(wasOpen);
    }
  });
  recoveryObserver.observe(document.documentElement, { childList: true });
}

/** 等待指定毫秒数，并允许任务在等待期间被安全停止。 */
async function wait(milliseconds: number): Promise<boolean> {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    if (stopRequested) return false;
    await new Promise((resolve) => window.setTimeout(resolve, Math.min(200, deadline - Date.now())));
  }
  return !stopRequested;
}

/** 读取当前页岗位列表和基本登录状态。 */
function inspectPage(): ZhilianPageContext {
  const supported = SUPPORTED_HOST_PATTERN.test(location.hostname);
  const jobs = supported ? parseZhilianJobs(document) : [];
  return {
    supported,
    loggedIn: supported ? detectZhilianLoginState(document) : null,
    url: location.href,
    jobs,
    issue: !supported
      ? "当前页面不是智联招聘"
      : jobs.length
        ? undefined
        : "当前页面尚未识别到智联岗位卡片，请打开职位搜索结果页",
  };
}

/**
 * 按岗位业务身份重新定位卡片：优先精确 cardKey，列表重排后仅在稳定身份唯一时回退到指纹。
 *
 * @param target 批次开始时冻结的目标岗位。
 * @returns 唯一匹配的当前 DOM 卡片；存在歧义时返回 null，绝不点击相邻岗位。
 */
function findJobCard(target: ZhilianJobSnapshot): { card: Element; job: ZhilianJobSnapshot } | null {
  const cards = findZhilianJobCards(document);
  const fingerprintMatches: Array<{ card: Element; job: ZhilianJobSnapshot }> = [];
  for (let index = 0; index < cards.length; index += 1) {
    const job = parseZhilianJobCard(cards[index], index);
    if (!job) continue;
    if (job.cardKey === target.cardKey) return { card: cards[index], job };
    if (isSameZhilianJob(target, job)) fingerprintMatches.push({ card: cards[index], job });
  }
  // 无岗位 ID 的 cardKey 包含页面下标。首个投递触发重绘后，只有唯一稳定指纹才允许继续。
  return fingerprintMatches.length === 1 ? fingerprintMatches[0] : null;
}

/** 在岗位卡片内寻找语义明确的申请按钮。 */
function findApplyButton(card: Element): HTMLButtonElement | null {
  for (const selector of ZHILIAN_APPLY_BUTTON_SELECTORS) {
    for (const candidate of card.querySelectorAll<HTMLButtonElement>(selector)) {
      const text = (candidate.textContent ?? "").replace(/\s+/g, "").trim();
      if (APPLY_TEXTS.has(text) || ALREADY_APPLIED_TEXTS.has(text)) return candidate;
    }
  }
  return Array.from(card.querySelectorAll<HTMLButtonElement>("button"))
    .find((candidate) => {
      const text = (candidate.textContent ?? "").replace(/\s+/g, "").trim();
      return APPLY_TEXTS.has(text) || ALREADY_APPLIED_TEXTS.has(text);
    }) ?? null;
}

/**
 * 在新版右侧详情中寻找与指定岗位绑定的申请按钮。
 *
 * @param job 当前冻结的目标岗位。
 * @returns 详情标题和公司匹配时返回唯一申请按钮，否则返回 null。
 */
function findBoundDetailApplyButton(job: ZhilianJobSnapshot): HTMLButtonElement | null {
  if (!isZhilianDetailBoundToJob(document, job)) return null;
  const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>(ZHILIAN_DETAIL_SELECTORS.applyButton));
  if (buttons.length !== 1) return null;
  const text = (buttons[0].textContent ?? "").replace(/\s+/g, "").trim();
  return APPLY_TEXTS.has(text) || ALREADY_APPLIED_TEXTS.has(text) ? buttons[0] : null;
}

/**
 * 兼容旧版卡片内按钮和新版右侧详情按钮。
 *
 * @param target 已通过稳定键重新定位的目标卡片。
 * @returns 当前与岗位绑定的申请按钮。
 */
function findApplyButtonForJob(target: { card: Element; job: ZhilianJobSnapshot }): HTMLButtonElement | null {
  return findApplyButton(target.card) ?? findBoundDetailApplyButton(target.job);
}

/**
 * 激活新版左侧卡片，并等待右侧详情明确切换到目标岗位。
 *
 * @param target 已通过稳定键定位的目标岗位卡片。
 * @param config 保存时冻结的智联配置。
 * @returns 旧版卡片内按钮或新版详情区按钮。
 */
async function prepareApplyButton(
  target: { card: Element; job: ZhilianJobSnapshot },
  config: ZhilianConfig,
): Promise<HTMLButtonElement> {
  const embeddedButton = findApplyButton(target.card);
  if (embeddedButton) return embeddedButton;
  if (!target.card.matches(".job-card")) {
    throw new Error("未找到该岗位的“立即投递”按钮，请刷新页面后重试");
  }

  // 新版页面必须先模拟用户选择左侧岗位，再读取右侧详情；不能直接点击上一个岗位的按钮。
  await waitAction(config);
  (target.card as HTMLElement).click();
  const deadline = Date.now() + Math.min(10_000, config.batch.resumeReceiptTimeoutSeconds * 1_000);
  while (Date.now() < deadline) {
    if (stopRequested) throw new Error("智联任务已停止");
    const refreshed = findJobCard(target.job);
    const button = refreshed ? findApplyButtonForJob(refreshed) : null;
    if (button) return button;
    if (!(await wait(100))) throw new Error("智联任务已停止");
  }
  throw new Error("点击岗位后未能确认右侧详情已切换到目标岗位，未执行投递");
}

/** 收集当前可见申请工作流的文本证据。 */
function collectScopedOutcomeTexts(): string[] {
  const texts = new Set<string>();
  for (const selector of ZHILIAN_OUTCOME_SCOPE_SELECTORS) {
    for (const element of document.querySelectorAll<HTMLElement>(selector)) {
      const visible = element.getClientRects().length > 0 || element.getAttribute("role") === "dialog";
      const text = (element.textContent ?? "").replace(/\s+/g, " ").trim();
      if (visible && text) texts.add(text);
    }
  }
  return [...texts];
}

/** 检查当前文档是否出现明确的申请结果。 */
function inspectCurrentOutcome(ignoredTexts: ReadonlySet<string> = new Set()): ZhilianExternalOutcome {
  for (const text of collectScopedOutcomeTexts()) {
    if (ignoredTexts.has(text)) continue;
    const outcome = detectZhilianOutcomeFromText(text);
    if (outcome.outcome !== "unknown") return outcome;
  }
  // 验证和登录失效可能不是标准弹窗，允许从全页读取这两类高风险信号。
  const bodyText = (document.body?.innerText ?? "").replace(/\s+/g, " ");
  // `/job-applied` 是智联独立成功页，正文中的“投递成功”是该页面的强回执。
  const appliedPageOutcome = detectZhilianAppliedPageOutcome(location.href, bodyText);
  if (appliedPageOutcome.outcome !== "unknown") return appliedPageOutcome;
  if (/滑块验证|安全验证|人机验证|请完成验证|验证码/.test(bodyText)) {
    return { outcome: "blocked", evidence: "智联页面要求完成安全验证" };
  }
  if (/操作频繁|访问频繁|请求频繁|稍后再试|账号异常|风险控制/.test(bodyText)) {
    return { outcome: "blocked", evidence: "智联页面出现频控或账号风险提示" };
  }
  if (/请先登录|登录后投递/.test(bodyText)) {
    return { outcome: "failed", evidence: "智联登录状态已失效" };
  }
  return { outcome: "unknown" };
}

/** 让本次新开的智联标签页继续等待明确申请回执。 */
async function continueExternalApplication(
  knownTabIds: number[],
  taskId: string,
  config: ZhilianConfig,
  jobId?: string,
): Promise<ZhilianExternalOutcome> {
  const response = await chrome.runtime.sendMessage({
    type: "CONTINUE_ZHILIAN_EXTERNAL_APPLICATION",
    knownTabIds,
    taskId,
    config,
    jobId,
  } satisfies BackgroundRequest) as ExtensionResponse<ZhilianExternalOutcome>;
  return response.ok && response.data ? response.data : { outcome: "unknown" };
}

/** 在明确成功后请求后台关闭本次新开的结果标签页。 */
async function closeExternalSuccessTab(
  tabId: number,
  knownTabIds: number[],
  jobId?: string,
): Promise<void> {
  const response = await chrome.runtime.sendMessage({
    type: "CLOSE_ZHILIAN_EXTERNAL_SUCCESS_TAB",
    tabId,
    knownTabIds,
    jobId,
  } satisfies BackgroundRequest) as ExtensionResponse<unknown>;
  if (!response.ok) throw new Error(response.error || "智联申请成功，但关闭结果页失败");
}

/** 点击前记录由当前列表页已经打开的智联结果标签，防止复用旧成功页。 */
async function listKnownExternalTabs(): Promise<number[]> {
  const response = await chrome.runtime.sendMessage({
    type: "LIST_ZHILIAN_EXTERNAL_TABS",
  } satisfies BackgroundRequest) as ExtensionResponse<number[]>;
  return response.ok && Array.isArray(response.data) ? response.data : [];
}

/** 把页面级结果转换为稳定的单岗位业务结果。 */
function buildResult(
  job: ZhilianJobSnapshot,
  outcome: ZhilianExternalOutcome,
): ZhilianDeliveryResult {
  if (outcome.outcome === "success") {
    return { outcome: "delivered", message: "智联已明确返回申请成功", job, evidence: outcome.evidence };
  }
  if (outcome.outcome === "already-applied") {
    return { outcome: "already-applied", message: "该岗位已投递，本次未重复点击", job, evidence: outcome.evidence };
  }
  if (outcome.outcome === "blocked") {
    return { outcome: "blocked", message: "智联要求验证或已达到投递上限，任务已停止", job, evidence: outcome.evidence };
  }
  if (outcome.outcome === "failed") {
    return { outcome: "failed", message: outcome.evidence || "智联明确返回申请失败", job, evidence: outcome.evidence };
  }
  return { outcome: "failed", message: "点击后未检测到明确申请结果，请先核对智联投递记录", job };
}

/** 等待一个随机动作间隔，并在停止时抛出可识别错误。 */
async function waitAction(config: ZhilianConfig): Promise<void> {
  const completed = await wait(randomActionDelayMilliseconds(config.batch));
  if (!completed) throw new Error("智联任务已停止");
}

/**
 * 检查当前文档回执，并仅在明确成功后关闭成功弹窗。
 *
 * @param config 保存时冻结的智联配置。
 * @param ignoredTexts 点击前已存在的回执文本。
 * @returns 出现明确结果时返回；仍在等待时返回 unknown。
 */
async function advanceCurrentApplication(
  config: ZhilianConfig,
  ignoredTexts: ReadonlySet<string>,
): Promise<ZhilianExternalOutcome> {
  const outcome = inspectCurrentOutcome(ignoredTexts);
  if (outcome.outcome !== "unknown") {
    if (outcome.outcome === "success") {
      // 只在明确成功后等待并关闭成功弹窗；找不到唯一关闭按钮时保留现场。
      await waitAction(config);
      findZhilianSuccessCloseButton(document)?.click();
    }
    return outcome;
  }
  return { outcome: "unknown" };
}

/** 在当前智联文档内等待申请回执，供新开的岗位页调用。 */
async function completeCurrentApplication(
  taskId: string,
  config: ZhilianConfig,
  ignoredOutcomeTexts: string[] = [],
): Promise<ZhilianExternalOutcome> {
  if (activeTaskId && activeTaskId !== taskId) throw new Error("当前页面已有智联任务正在运行");
  activeTaskId = taskId;
  stopRequested = false;
  const deadline = Date.now() + config.batch.resumeReceiptTimeoutSeconds * 1_000;
  try {
    while (Date.now() < deadline) {
      if (stopRequested) return { outcome: "unknown", evidence: "智联任务已停止" };
      const outcome = await advanceCurrentApplication(config, new Set(ignoredOutcomeTexts));
      if (outcome.outcome !== "unknown") return outcome;
      if (!(await wait(250))) return { outcome: "unknown", evidence: "智联任务已停止" };
    }
    return { outcome: "unknown", evidence: "等待智联明确回执超时" };
  } finally {
    activeTaskId = null;
    stopRequested = false;
  }
}

/** 执行一次智联申请并等待当前页或本次新标签页返回明确回执。 */
async function applySingleJob(
  taskId: string,
  requestedJob: ZhilianJobSnapshot,
  config: ZhilianConfig,
): Promise<ZhilianDeliveryResult> {
  if (activeTaskId) throw new Error("当前页面已有智联任务正在运行");
  const target = findJobCard(requestedJob);
  if (!target) throw new Error("岗位列表已变化，请重新识别后再投递");

  activeTaskId = taskId;
  stopRequested = false;
  try {
    // 单次点击授权后，滚动、选择卡片与真正申请之间仍保留随机动作等待。
    target.card.scrollIntoView({ behavior: "smooth", block: "center" });
    let button = await prepareApplyButton(target, config);
    const initialText = (button.textContent ?? "").replace(/\s+/g, "").trim();
    if (ALREADY_APPLIED_TEXTS.has(initialText)) {
      return buildResult(target.job, { outcome: "already-applied", evidence: initialText });
    }
    if (!APPLY_TEXTS.has(initialText) || button.disabled) {
      throw new Error("岗位申请按钮不可用，未执行点击");
    }

    const baselineOutcomeTexts = new Set(collectScopedOutcomeTexts());
    const knownExternalTabIds = await listKnownExternalTabs().catch(() => []);
    if (!(await wait(randomActionDelayMilliseconds(config.batch)))) {
      return { outcome: "cancelled", message: "任务已在点击前停止", job: target.job };
    }
    // 等待期间站点可能重绘详情按钮，点击前必须再次绑定当前岗位并获取实时节点。
    const refreshedBeforeClick = findJobCard(requestedJob);
    const liveButton = refreshedBeforeClick ? findApplyButtonForJob(refreshedBeforeClick) : null;
    if (!liveButton
      || !liveButton.isConnected
      || liveButton.disabled
      || !APPLY_TEXTS.has((liveButton.textContent ?? "").replace(/\s+/g, "").trim())) {
      throw new Error("目标岗位申请按钮在点击前发生变化，未执行投递");
    }
    button = liveButton;
    button.click();

    const deadline = Date.now() + config.batch.resumeReceiptTimeoutSeconds * 1_000;
    while (Date.now() < deadline) {
      if (stopRequested) return { outcome: "cancelled", message: "任务已停止，请核对智联投递记录", job: target.job };
      const current = await advanceCurrentApplication(config, baselineOutcomeTexts);
      if (current.outcome !== "unknown") return buildResult(target.job, current);

      const refreshed = findJobCard(requestedJob);
      const refreshedText = refreshed
        ? (findApplyButtonForJob(refreshed)?.textContent ?? "").replace(/\s+/g, "").trim()
        : "";
      if (ALREADY_APPLIED_TEXTS.has(refreshedText)) {
        // 按钮回执先出现时再等待一个动作间隔，给成功弹窗渲染和关闭留出时间。
        if (!(await wait(randomActionDelayMilliseconds(config.batch)))) {
          return { outcome: "cancelled", message: "任务已停止，请核对智联投递记录", job: target.job };
        }
        const delayedOutcome = inspectCurrentOutcome(baselineOutcomeTexts);
        if (delayedOutcome.outcome === "success") findZhilianSuccessCloseButton(document)?.click();
        return buildResult(target.job, { outcome: "success", evidence: `岗位按钮已变为“${refreshedText}”` });
      }

      const external = await continueExternalApplication(knownExternalTabIds, taskId, config, target.job.jobId)
        .catch(() => ({ outcome: "unknown" as const }));
      if (external.outcome !== "unknown") {
        if (external.outcome === "success" && external.tabId !== undefined) {
          await closeExternalSuccessTab(external.tabId, knownExternalTabIds, target.job.jobId);
        }
        return buildResult(target.job, external);
      }
      await wait(250);
    }
    return buildResult(target.job, { outcome: "unknown" });
  } finally {
    activeTaskId = null;
    stopRequested = false;
  }
}

// 成功结果页只承担回执监听并会被关闭，不挂载完整助手，避免产生第二个误导界面实例。
if (!/^\/job-applied\/?$/i.test(location.pathname)) {
  ensureEmbeddedPanel();
  startEmbeddedPanelRecovery();
}

chrome.runtime.onMessage.addListener((request: ContentRequest, _sender, sendResponse) => {
  if (request.type === "TOGGLE_EMBEDDED_PANEL") {
    sendResponse({ ok: true, data: { open: ensureEmbeddedPanel().toggle() } } satisfies ExtensionResponse<unknown>);
    return false;
  }
  if (request.type === "INSPECT_ZHILIAN") {
    sendResponse({ ok: true, data: inspectPage() } satisfies ExtensionResponse<ZhilianPageContext>);
    return false;
  }
  if (request.type === "INSPECT_ZHILIAN_OUTCOME") {
    sendResponse({ ok: true, data: inspectCurrentOutcome() } satisfies ExtensionResponse<ZhilianExternalOutcome>);
    return false;
  }
  if (request.type === "COMPLETE_ZHILIAN_APPLICATION") {
    void completeCurrentApplication(
      request.taskId,
      request.config,
      request.ignoredOutcomeTexts,
    )
      .then((data) => sendResponse({ ok: true, data } satisfies ExtensionResponse<ZhilianExternalOutcome>))
      .catch((error: unknown) => sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      } satisfies ExtensionResponse<unknown>));
    return true;
  }
  if (request.type === "STOP_ZHILIAN_TASK") {
    if (activeTaskId === request.taskId) stopRequested = true;
    sendResponse({ ok: true, data: { stopped: activeTaskId === request.taskId } } satisfies ExtensionResponse<unknown>);
    return false;
  }
  if (request.type === "APPLY_ZHILIAN_JOB") {
    void applySingleJob(request.taskId, request.job, request.config)
      .then((data) => sendResponse({ ok: true, data } satisfies ExtensionResponse<ZhilianDeliveryResult>))
      .catch((error: unknown) => sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      } satisfies ExtensionResponse<unknown>));
    return true;
  }
  return false;
});

void chrome.runtime.sendMessage({ type: "ZHILIAN_CONTENT_READY" } satisfies BackgroundRequest).catch(() => undefined);
