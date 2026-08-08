import { mountEmbeddedPanel, type EmbeddedPanelController } from "./embedded-panel";
import {
  ZHILIAN_APPLY_BUTTON_SELECTORS,
  ZHILIAN_OUTCOME_SCOPE_SELECTORS,
  detectZhilianLoginState,
  detectZhilianOutcomeFromText,
  findZhilianJobCards,
  parseZhilianJobCard,
  parseZhilianJobs,
} from "../shared/zhilian-parser";
import type {
  BackgroundRequest,
  ContentRequest,
  ExtensionResponse,
  ZhilianDeliveryResult,
  ZhilianExternalOutcome,
  ZhilianJobSnapshot,
  ZhilianPageContext,
} from "../shared/types";

const SUPPORTED_HOST_PATTERN = /(^|\.)zhaopin\.com$/i;
const APPLY_TEXTS = new Set(["立即投递", "投递简历", "申请职位"]);
const ALREADY_APPLIED_TEXTS = new Set(["已投递", "已申请"]);
const RESULT_TIMEOUT_MILLISECONDS = 25_000;

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

/** 按稳定 cardKey 重新定位岗位卡片，避免列表重排后误点相邻岗位。 */
function findJobCard(cardKey: string): { card: Element; job: ZhilianJobSnapshot } | null {
  const cards = findZhilianJobCards(document);
  for (let index = 0; index < cards.length; index += 1) {
    const job = parseZhilianJobCard(cards[index], index);
    if (job?.cardKey === cardKey) return { card: cards[index], job };
  }
  return null;
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
  if (/滑块验证|安全验证|人机验证|请完成验证|验证码/.test(bodyText)) {
    return { outcome: "blocked", evidence: "智联页面要求完成安全验证" };
  }
  if (/请先登录|登录后投递/.test(bodyText)) {
    return { outcome: "failed", evidence: "智联登录状态已失效" };
  }
  return { outcome: "unknown" };
}

/** 向后台查询由当前标签页打开的智联结果页。 */
async function inspectExternalOutcome(knownTabIds: number[]): Promise<ZhilianExternalOutcome> {
  const response = await chrome.runtime.sendMessage({
    type: "FIND_ZHILIAN_EXTERNAL_OUTCOME",
    knownTabIds,
  } satisfies BackgroundRequest) as ExtensionResponse<ZhilianExternalOutcome>;
  return response.ok && response.data ? response.data : { outcome: "unknown" };
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

/** 执行一次用户已确认的智联申请并等待当前页或新标签页回执。 */
async function applySingleJob(taskId: string, cardKey: string): Promise<ZhilianDeliveryResult> {
  if (activeTaskId) throw new Error("当前页面已有智联任务正在运行");
  const target = findJobCard(cardKey);
  if (!target) throw new Error("岗位列表已变化，请重新识别后再投递");
  const button = findApplyButton(target.card);
  if (!button) throw new Error("未找到该岗位的“立即投递”按钮，请刷新页面后重试");
  const initialText = (button.textContent ?? "").replace(/\s+/g, "").trim();
  if (ALREADY_APPLIED_TEXTS.has(initialText)) {
    return buildResult(target.job, { outcome: "already-applied", evidence: initialText });
  }
  if (!APPLY_TEXTS.has(initialText) || button.disabled) {
    throw new Error("岗位申请按钮不可用，未执行点击");
  }

  activeTaskId = taskId;
  stopRequested = false;
  try {
    // 用户确认后仍加入短随机稳定等待，避免确认、滚动、点击在同一毫秒完成。
    target.card.scrollIntoView({ behavior: "smooth", block: "center" });
    const baselineOutcomeTexts = new Set(collectScopedOutcomeTexts());
    const knownExternalTabIds = await listKnownExternalTabs().catch(() => []);
    const actionDelay = 1_500 + Math.floor(Math.random() * 2_001);
    if (!(await wait(actionDelay))) {
      return { outcome: "cancelled", message: "任务已在点击前停止", job: target.job };
    }
    button.click();

    const deadline = Date.now() + RESULT_TIMEOUT_MILLISECONDS;
    while (Date.now() < deadline) {
      if (stopRequested) return { outcome: "cancelled", message: "任务已停止，请核对智联投递记录", job: target.job };
      const current = inspectCurrentOutcome(baselineOutcomeTexts);
      if (current.outcome !== "unknown") return buildResult(target.job, current);

      const refreshed = findJobCard(cardKey);
      const refreshedText = refreshed ? (findApplyButton(refreshed.card)?.textContent ?? "").replace(/\s+/g, "").trim() : "";
      if (ALREADY_APPLIED_TEXTS.has(refreshedText)) {
        return buildResult(target.job, { outcome: "success", evidence: `岗位按钮已变为“${refreshedText}”` });
      }

      const external = await inspectExternalOutcome(knownExternalTabIds)
        .catch(() => ({ outcome: "unknown" as const }));
      if (external.outcome !== "unknown") return buildResult(target.job, external);
      await wait(250);
    }
    return buildResult(target.job, { outcome: "unknown" });
  } finally {
    activeTaskId = null;
    stopRequested = false;
  }
}

ensureEmbeddedPanel();
startEmbeddedPanelRecovery();

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
  if (request.type === "STOP_ZHILIAN_TASK") {
    if (activeTaskId === request.taskId) stopRequested = true;
    sendResponse({ ok: true, data: { stopped: activeTaskId === request.taskId } } satisfies ExtensionResponse<unknown>);
    return false;
  }
  if (request.type === "APPLY_ZHILIAN_JOB") {
    void applySingleJob(request.taskId, request.cardKey)
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
