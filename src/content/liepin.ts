import {
  LIEPIN_SELECTORS,
  detectLiepinLogin,
  inspectLiepinPage,
  isElementVisible,
  matchLiepinChatToJob,
  normalizeText,
  parseLiepinJobCard,
  parseLiepinJobCards,
} from "../shared/liepin-parser";
import {
  findLiepinResumeConfirmationButton,
  isLiepinResumeConfirmationDialogVisible,
} from "../shared/liepin-resume-dialog";
import { containsLiepinRiskSignal } from "../shared/liepin-safety";
import {
  normalizeActionInterval,
  normalizeResumeReceiptTimeoutSeconds,
  randomActionDelayMilliseconds,
} from "../shared/defaults";
import {
  EMBEDDED_PANEL_HOST_ID,
  mountEmbeddedPanel,
  type EmbeddedPanelController,
} from "./embedded-panel";
import type {
  BackgroundRequest,
  ContentRequest,
  DeliveryLogEntry,
  DeliveryResult,
  DeliveryStepResult,
  ExtensionResponse,
  LiepinBatchConfig,
  LiepinJobSnapshot,
} from "../shared/types";

let stopRequested = false;
let applying = false;
let activeTaskId: string | undefined;
let embeddedPanel: EmbeddedPanelController | undefined;
let panelRecoveryObserver: MutationObserver | undefined;

/**
 * 在猎聘页面挂载固定抽屉，复用扩展页面展示完整 React 主界面。
 *
 * @returns 抽屉存在或创建完成时返回。
 */
function ensureEmbeddedPanel(): EmbeddedPanelController {
  if (embeddedPanel?.host.isConnected) return embeddedPanel;
  embeddedPanel?.destroy();
  embeddedPanel = mountEmbeddedPanel({
    documentRef: document,
    iframeUrl: chrome.runtime.getURL("sidepanel.html?embedded=1"),
  });
  return embeddedPanel;
}

/**
 * 监听站点对根节点的清理并幂等恢复助手宿主，避免 SPA 更新后入口消失。
 *
 * @returns 观察器启动完成时返回。
 */
function startEmbeddedPanelRecovery(): void {
  ensureEmbeddedPanel();
  panelRecoveryObserver?.disconnect();
  panelRecoveryObserver = new MutationObserver(() => {
    if (!document.getElementById(EMBEDDED_PANEL_HOST_ID)) ensureEmbeddedPanel();
  });
  // 宿主是 documentElement 的直接子节点，只观察该层可避免监听猎聘大量业务 DOM 变化。
  panelRecoveryObserver.observe(document.documentElement, { childList: true });
}

/**
 * 等待指定毫秒数，同时保留给停止标记生效的机会。
 *
 * @param milliseconds 等待时长。
 * @returns 等待完成时返回。
 */
function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

/** 单岗位内部不可逆页面动作使用的配置快照。 */
type ActionInterval = Pick<LiepinBatchConfig, "minActionIntervalSeconds" | "maxActionIntervalSeconds">;

/** 内容脚本执行单岗位投递时使用的动作与简历回执等待配置。 */
type DeliveryTiming = ActionInterval & Pick<LiepinBatchConfig, "resumeReceiptTimeoutSeconds">;

/** 投递日志允许写入的脱敏字段类型。 */
type DeliveryLogDetails = Record<string, string | number | boolean | null>;

/** 单岗位投递阶段日志回调。 */
type DeliveryLogger = (
  phase: DeliveryLogEntry["phase"],
  event: string,
  message: string,
  details?: DeliveryLogDetails,
) => void;

/**
 * 创建单岗位日志写入器，统一时间格式并限制每条日志字段为脱敏值。
 *
 * @param logs 当前岗位的日志数组。
 * @returns 可传给各投递阶段的日志回调。
 */
function createDeliveryLogger(logs: DeliveryLogEntry[]): DeliveryLogger {
  return (phase, event, message, details) => {
    logs.push({
      at: new Date().toISOString(),
      phase,
      event,
      message,
      ...(details ? { details } : {}),
    });
  };
}

/**
 * 在两个页面动作之间执行可被停止请求打断的随机稳定等待。
 *
 * @param interval 用户保存时锁定的动作等待区间。
 * @returns 等待完成返回 true；用户请求停止时返回 false。
 */
async function waitForActionInterval(interval: ActionInterval): Promise<boolean> {
  const deadline = Date.now() + randomActionDelayMilliseconds(interval);
  while (Date.now() < deadline) {
    if (stopRequested) return false;
    // 小步等待兼顾页面稳定与停止按钮响应速度。
    await delay(Math.min(150, deadline - Date.now()));
  }
  return !stopRequested;
}

/**
 * 在页面重新渲染后重新定位用户选中的岗位卡片。
 *
 * @param cardKey 助手界面识别时生成的卡片键。
 * @returns 卡片元素与最新快照。
 */
function findJobCard(cardKey: string): { card: Element; job: LiepinJobSnapshot } | null {
  const cards = Array.from(document.querySelectorAll(LIEPIN_SELECTORS.jobCards));
  for (let index = 0; index < cards.length; index += 1) {
    const job = parseLiepinJobCard(cards[index], index);
    if (job.cardKey === cardKey) {
      return { card: cards[index], job };
    }
  }
  return null;
}

/**
 * 查找岗位卡片中的猎聘沟通按钮。
 *
 * @param card 岗位卡片。
 * @returns 目标按钮和规整文本。
 */
function findChatButton(card: Element): { button: HTMLButtonElement; text: string } | null {
  const buttons = Array.from(card.querySelectorAll<HTMLButtonElement>("button"));
  for (const button of buttons) {
    const text = normalizeText(button.textContent);
    if ((text.includes("聊一聊") || text.includes("继续聊")) && !button.disabled) {
      return { button, text };
    }
  }
  return null;
}

/**
 * 向猎聘招聘者区域发送悬停事件，触发 React 动态挂载“聊一聊/继续聊”按钮。
 *
 * @param element 招聘者信息区域。
 * @returns 事件发送完成时返回。
 */
function dispatchRecruiterHover(card: HTMLElement, recruiter: HTMLElement): void {
  const common = { bubbles: true, cancelable: true, composed: true, view: window };
  const dispatchSequence = (element: HTMLElement) => {
    // React 的 onMouseEnter 由冒泡 mouseover 合成；move 事件兼容页面额外的悬停判断。
    element.dispatchEvent(new PointerEvent("pointerover", { ...common, pointerType: "mouse" }));
    element.dispatchEvent(new PointerEvent("pointerenter", { ...common, bubbles: false, pointerType: "mouse" }));
    element.dispatchEvent(new PointerEvent("pointermove", { ...common, pointerType: "mouse" }));
    element.dispatchEvent(new MouseEvent("mouseover", common));
    element.dispatchEvent(new MouseEvent("mouseenter", { ...common, bubbles: false }));
    element.dispatchEvent(new MouseEvent("mousemove", common));
  };
  // 猎聘可能把监听器挂在卡片或招聘者区域，两层都触发以兼容当前 React 实现。
  dispatchSequence(card);
  dispatchSequence(recruiter);
}

/**
 * 激活指定岗位招聘者区域，并等待动态沟通按钮挂载。
 *
 * @param cardKey 岗位卡片稳定键。
 * @param timeoutMilliseconds 最大等待时长。
 * @returns 最新卡片、岗位和按钮；超时返回 null。
 */
async function revealChatButton(
  cardKey: string,
  actionInterval: ActionInterval,
  timeoutMilliseconds = 1_500,
): Promise<{
  card: Element;
  job: LiepinJobSnapshot;
  target: { button: HTMLButtonElement; text: string };
} | null> {
  const located = findJobCard(cardKey);
  if (!located) return null;

  const recruiterSelectors = [
    ".recruiter-info-box",
    "[class*='recruiter-info-box']",
    "[class*='recruiter']",
    "[class*='hr-']",
    "[class*='contact']",
  ];
  let recruiter: HTMLElement | null = null;
  for (const selector of recruiterSelectors) {
    const candidate = located.card.querySelector<HTMLElement>(selector);
    if (candidate) {
      recruiter = candidate;
      break;
    }
  }
  if (!recruiter) return null;

  located.card.scrollIntoView({ behavior: "smooth", block: "center" });
  if (!await waitForActionInterval(actionInterval)) return null;
  if (!(located.card instanceof HTMLElement)) return null;
  dispatchRecruiterHover(located.card, recruiter);

  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if (stopRequested) return null;
    // React 可能重绘整张卡片，因此每次都通过 cardKey 重新定位最新节点。
    const current = findJobCard(cardKey);
    if (current) {
      const target = findChatButton(current.card);
      if (target) {
        return { ...current, target };
      }
    }
    await delay(80);
  }
  return null;
}

/**
 * 读取当前可见的安全验证或验证码提示。
 *
 * @returns 检测到验证时返回证据文本。
 */
function detectVerificationEvidence(): string | undefined {
  const selectors = [
    "iframe[src*='captcha']",
    "[class*='geetest']",
    "[class*='captcha']",
    "[role='dialog']",
    "[role='alert']",
  ];
  for (const selector of selectors) {
    for (const element of document.querySelectorAll(selector)) {
      if (!isElementVisible(element)) continue;
      const text = normalizeText(element.textContent);
      if (selector.includes("captcha") || selector.includes("geetest") || containsLiepinRiskSignal(text)) {
        return text || "检测到平台安全验证";
      }
    }
  }
  return undefined;
}

/**
 * 获取当前可见的猎聘聊天根容器。
 *
 * @returns 当前聊天容器，不存在时返回 null。
 */
function getActiveChatContainer(): HTMLElement | null {
  const container = document.querySelector<HTMLElement>(LIEPIN_SELECTORS.chatContainer);
  return container && isElementVisible(container) ? container : null;
}

/**
 * 获取包含猎聘聊天标题栏的证据容器。
 *
 * @param chat 当前消息容器。
 * @returns 优先返回聊天弹窗根节点，避免标题栏位于消息容器外时误判岗位不匹配。
 */
function getCommunicationEvidenceContainer(chat: HTMLElement): HTMLElement {
  return chat.closest<HTMLElement>(".im-ui-basic-chat-modal") ?? chat;
}

/**
 * 读取沟通回执的结构化诊断，不保存聊天正文，避免日志泄露招聘者消息。
 *
 * @param job 当前待投递岗位。
 * @returns 当前聊天节点、文本长度和岗位匹配状态。
 */
function getCommunicationDiagnostic(job: LiepinJobSnapshot): DeliveryLogDetails {
  const chat = getActiveChatContainer();
  const evidenceContainer = chat ? getCommunicationEvidenceContainer(chat) : null;
  const text = normalizeText(evidenceContainer?.textContent);
  return {
    chatFound: Boolean(chat),
    chatTextCharacters: text.length,
    jobMatched: Boolean(evidenceContainer && matchLiepinChatToJob(text, job)),
  };
}

/**
 * 读取平台明确展示的沟通成功证据。
 *
 * @param job 当前所选岗位。
 * @returns 找到时返回提示文本。
 */
function detectCommunicationEvidence(job: LiepinJobSnapshot): string | undefined {
  const chat = getActiveChatContainer();
  if (!chat) return undefined;
  const evidenceContainer = getCommunicationEvidenceContainer(chat);
  const text = normalizeText(evidenceContainer.textContent);
  // 使用完整标题，或“核心标题 + 公司”绑定当前窗口，兼容聊天头省略卡片地区后缀。
  if (matchLiepinChatToJob(text, job)) {
    return `猎聘聊天窗口已打开：${job.jobTitle}`;
  }
  return undefined;
}

/**
 * 点击成功后尽力关闭聊天窗口；关闭失败不改变已经确认的业务结果。
 *
 * @param actionInterval 关闭聊天前使用的随机稳定等待区间。
 * @param onLog 当前岗位日志回调。
 * @returns 关闭动作结束时返回。
 */
async function closeChatWindow(actionInterval: ActionInterval, onLog?: DeliveryLogger): Promise<void> {
  if (!await waitForActionInterval(actionInterval)) {
    onLog?.("task", "close-cancelled", "关闭聊天窗口前收到停止请求");
    return;
  }
  const modal = getActiveChatContainer()?.closest(".im-ui-basic-chat-modal");
  const close = modal?.querySelector<HTMLElement>(
    `${LIEPIN_SELECTORS.chatClose}, img[alt='close'], button.ant-im-modal-close`,
  );
  if (close && isElementVisible(close)) {
    onLog?.("task", "close-click", "已点击关闭聊天窗口");
    close.click();
    const deadline = Date.now() + 2_000;
    while (getActiveChatContainer() && Date.now() < deadline) {
      await delay(100);
    }
    onLog?.("task", getActiveChatContainer() ? "close-timeout" : "close-success", getActiveChatContainer()
      ? "关闭聊天窗口超时，但不影响已确认的投递结果"
      : "聊天窗口已关闭");
  } else {
    onLog?.("task", "close-control-missing", "未找到聊天窗口关闭按钮，但不影响已确认的投递结果");
  }
}

/**
 * 等待聊天成功、验证码、登录失效、停止或超时。
 *
 * @param timeoutMilliseconds 最大等待时长。
 * @param job 当前所选岗位，用于绑定聊天窗口。
 * @param onLog 当前岗位日志回调。
 * @returns 投递业务结果与证据。
 */
async function waitForCommunicationOutcome(
  timeoutMilliseconds: number,
  job: LiepinJobSnapshot,
  onLog?: DeliveryLogger,
): Promise<{ outcome: DeliveryResult["outcome"]; message: string; evidence?: string }> {
  const startedAt = Date.now();
  onLog?.("communication", "wait-start", "开始等待与当前岗位匹配的聊天窗口", {
    timeoutMilliseconds,
  });
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if (stopRequested) {
      onLog?.("communication", "cancelled", "等待聊天窗口期间收到停止请求");
      return { outcome: "cancelled", message: "用户已停止本次投递" };
    }

    const verification = detectVerificationEvidence();
    if (verification) {
      onLog?.("communication", "verification", "等待聊天窗口期间检测到安全验证", {
        evidenceCharacters: verification.length,
      });
      return {
        outcome: "blocked",
        message: "猎聘要求安全验证，任务已停止",
        evidence: verification,
      };
    }

    if (detectLiepinLogin() === false) {
      onLog?.("communication", "login-lost", "等待聊天窗口期间登录状态失效");
      return { outcome: "blocked", message: "猎聘登录状态已失效" };
    }

    const success = detectCommunicationEvidence(job);
    if (success) {
      onLog?.("communication", "receipt-success", "已检测到与岗位匹配的聊天窗口", {
        elapsedMilliseconds: Date.now() - startedAt,
        ...getCommunicationDiagnostic(job),
      });
      return {
        outcome: "delivered",
        message: "猎聘已打开本岗位聊天窗口",
        evidence: success,
      };
    }
    await delay(150);
  }
  onLog?.("communication", "receipt-timeout", "超时未检测到与岗位匹配的聊天窗口", {
    elapsedMilliseconds: Date.now() - startedAt,
    ...getCommunicationDiagnostic(job),
  });
  return {
    outcome: "blocked",
    message: "点击后未检测到与所选岗位匹配的聊天窗口，结果未知，请先核对沟通记录",
  };
}

/**
 * 统计当前聊天中与目标草稿完全一致的本人发送消息数量。
 *
 * @param chat 当前聊天根容器。
 * @param greetingText 目标招呼语。
 * @returns 完全匹配的已发送消息数量。
 */
function countSentGreeting(chat: HTMLElement, greetingText: string): number {
  return Array.from(chat.querySelectorAll(LIEPIN_SELECTORS.sentText)).filter(
    (element) => normalizeText(element.textContent) === greetingText,
  ).length;
}

/**
 * 统计当前聊天中本人已发送的简历卡片数量。
 *
 * @param chat 当前聊天根容器。
 * @returns 已发送简历卡片数量。
 */
function countSentResumeCards(chat: HTMLElement): number {
  const matched = new Set<HTMLElement>();
  for (const element of chat.querySelectorAll<HTMLElement>(LIEPIN_SELECTORS.sentResume)) {
    matched.add(element.closest<HTMLElement>(".im-ui-txt.send") ?? element);
  }

  // 兜底按“本人发送消息 + 简历/附件语义”识别新版本卡片，仍然不扫描接收消息和输入工具栏。
  for (const message of chat.querySelectorAll<HTMLElement>(".im-ui-txt.send")) {
    if (message.querySelector(LIEPIN_SELECTORS.sentResume)) continue;
    const classText = message.querySelector<HTMLElement>("[class*='resume'], [class*='attachment']");
    const dataText = message.querySelector<HTMLElement>("[data-type*='resume'], [data-type*='attachment']");
    const text = normalizeText(message.textContent);
    if ((classText || dataText) && /简历|附件/.test(text)) matched.add(message);
  }
  return matched.size;
}

/**
 * 生成简历投递阶段的脱敏页面诊断，帮助区分“未点击”与“回执选择器失配”。
 *
 * @param chat 当前聊天容器，可为空。
 * @returns 仅包含计数和布尔值的诊断文本，不包含简历正文。
 */
function getResumeDeliveryDiagnostic(chat: HTMLElement | null): string {
  const resumeCards = chat ? countSentResumeCards(chat) : 0;
  const dialogVisible = isLiepinResumeConfirmationDialogVisible();
  const confirmButton = findLiepinResumeConfirmationButton();
  return `确认弹窗=${dialogVisible ? "仍在" : "已关闭"}，确认按钮=${confirmButton ? "可见" : "未找到"}，本人简历卡片=${resumeCards}`;
}

/**
 * 以接近真实鼠标操作的事件顺序触发猎聘 React 按钮。
 *
 * @param element 待点击的可见按钮。
 * @returns 点击事件派发完成时返回。
 */
function clickLiepinButton(element: HTMLElement): void {
  element.focus?.();
  const view = element.ownerDocument.defaultView ?? window;
  const rect = element.getBoundingClientRect();
  const eventInit = {
    bubbles: true,
    cancelable: true,
    composed: true,
    view,
    clientX: rect.left + Math.max(1, rect.width / 2),
    clientY: rect.top + Math.max(1, rect.height / 2),
  };
  // 先补齐 Ant/React 可能依赖的鼠标按下和抬起事件，最后只派发一次 click，避免重复发送。
  element.dispatchEvent(new MouseEvent("mousedown", eventInit));
  element.dispatchEvent(new MouseEvent("mouseup", eventInit));
  element.click();
}

/**
 * 以兼容 React 受控输入框的方式写入招呼语。
 *
 * @param input 猎聘聊天输入框。
 * @param value 已经用户确认的招呼语。
 * @returns 输入事件发送完成时返回。
 */
function setControlledTextareaValue(input: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  if (!setter) {
    throw new Error("当前浏览器无法写入猎聘聊天输入框");
  }
  setter.call(input, value);
  input.dispatchEvent(new InputEvent("input", {
    bubbles: true,
    inputType: "insertText",
    data: value,
  }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

/**
 * 等待一个阶段的页面回执，同时处理中止、验证和登录失效。
 *
 * @param successCheck 阶段成功证据检查函数。
 * @param successMessage 成功状态说明。
 * @param timeoutMessage 超时状态说明。
 * @param timeoutMilliseconds 最大等待时长。
 * @param onPoll 每次检查前执行的可选页面动作。
 * @param phase 当前投递阶段。
 * @param onLog 当前岗位日志回调。
 * @returns 独立阶段回执。
 */
async function waitForStepReceipt(
  successCheck: () => string | undefined,
  successMessage: string,
  timeoutMessage: string,
  timeoutMilliseconds = 8_000,
  onPoll?: () => void | Promise<void>,
  phase: DeliveryLogEntry["phase"] = "task",
  onLog?: DeliveryLogger,
): Promise<DeliveryStepResult> {
  const startedAt = Date.now();
  onLog?.(phase, "wait-start", `开始等待${successMessage}回执`, { timeoutMilliseconds });
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if (stopRequested) {
      onLog?.(phase, "cancelled", `等待${successMessage}回执期间收到停止请求`);
      return { status: "failed", message: "用户已停止本次投递" };
    }
    const verification = detectVerificationEvidence();
    if (verification) {
      onLog?.(phase, "verification", `等待${successMessage}回执期间检测到安全验证`, {
        evidenceCharacters: verification.length,
      });
      return { status: "failed", message: "猎聘要求安全验证", evidence: verification };
    }
    if (detectLiepinLogin() === false) {
      onLog?.(phase, "login-lost", `等待${successMessage}回执期间登录状态失效`);
      return { status: "failed", message: "猎聘登录状态已失效" };
    }
    await onPoll?.();
    const evidence = successCheck();
    if (evidence) {
      onLog?.(phase, "receipt-success", successMessage, {
        elapsedMilliseconds: Date.now() - startedAt,
        evidenceCharacters: evidence.length,
      });
      return { status: "success", message: successMessage, evidence };
    }
    await delay(120);
  }
  // 页面点击已经发生但缺少明确回执时不能断言失败，要求人工核对以避免重复发送。
  onLog?.(phase, "receipt-timeout", `${timeoutMessage}，结果未知`, {
    elapsedMilliseconds: Date.now() - startedAt,
  });
  return { status: "unknown", message: `${timeoutMessage}，结果未知，请先核对当前聊天记录` };
}

/**
 * 在当前聊天窗口发送 AI 招呼语并等待本人消息节点出现。
 *
 * @param greetingText 用户确认后的招呼语。
 * @param actionInterval 聊天建立后和文本写入后的随机稳定等待区间。
 * @param onLog 当前岗位日志回调。
 * @returns 文本发送阶段回执。
 */
async function sendGreetingAndWait(
  greetingText: string,
  actionInterval: ActionInterval,
  onLog?: DeliveryLogger,
): Promise<DeliveryStepResult> {
  const startedAt = Date.now();
  onLog?.("greeting", "start", "开始写入并发送招呼语", {
    characters: greetingText.length,
  });
  if (!await waitForActionInterval(actionInterval)) {
    onLog?.("greeting", "cancelled", "等待发送招呼语前收到停止请求");
    return { status: "failed", message: "用户已停止本次投递" };
  }
  const initialVerification = detectVerificationEvidence();
  if (initialVerification) {
    onLog?.("greeting", "verification", "发送招呼语前检测到安全验证", {
      evidenceCharacters: initialVerification.length,
    });
    return { status: "failed", message: "猎聘要求安全验证", evidence: initialVerification };
  }
  if (detectLiepinLogin() === false) {
    onLog?.("greeting", "login-lost", "发送招呼语前登录状态失效");
    return { status: "failed", message: "猎聘登录状态已失效" };
  }
  const chat = getActiveChatContainer();
  if (!chat) {
    onLog?.("greeting", "chat-missing", "发送招呼语时聊天窗口不存在");
    return { status: "failed", message: "聊天窗口已消失，无法发送 AI 招呼语" };
  }
  const input = chat.querySelector<HTMLTextAreaElement>(LIEPIN_SELECTORS.chatInput);
  let sendButton = chat.querySelector<HTMLButtonElement>(LIEPIN_SELECTORS.chatSend);
  if (!input || !sendButton || !isElementVisible(input) || !isElementVisible(sendButton)) {
    onLog?.("greeting", "controls-missing", "未找到聊天输入框或发送按钮", {
      inputFound: Boolean(input),
      sendButtonFound: Boolean(sendButton),
    });
    return { status: "failed", message: "未找到猎聘聊天输入框或发送按钮" };
  }

  const baseline = countSentGreeting(chat, greetingText);
  setControlledTextareaValue(input, greetingText);
  const enabledDeadline = Date.now() + 2_000;
  while (Date.now() < enabledDeadline) {
    // React 可能在输入事件后替换按钮节点，因此每轮重新读取当前按钮。
    sendButton = chat.querySelector<HTMLButtonElement>(LIEPIN_SELECTORS.chatSend);
    if (sendButton && !sendButton.disabled && isElementVisible(sendButton)) break;
    await delay(80);
  }
  if (!sendButton || sendButton.disabled || !isElementVisible(sendButton)) {
    onLog?.("greeting", "send-disabled", "写入招呼语后发送按钮仍不可用");
    return { status: "failed", message: "写入招呼语后猎聘发送按钮仍不可用" };
  }

  if (!await waitForActionInterval(actionInterval)) {
    onLog?.("greeting", "cancelled", "等待发送招呼语期间收到停止请求");
    return { status: "failed", message: "用户已停止本次投递" };
  }
  const verification = detectVerificationEvidence();
  if (verification) {
    onLog?.("greeting", "verification", "点击发送招呼语前检测到安全验证", {
      evidenceCharacters: verification.length,
    });
    return { status: "failed", message: "猎聘要求安全验证", evidence: verification };
  }
  if (detectLiepinLogin() === false) {
    onLog?.("greeting", "login-lost", "点击发送招呼语前登录状态失效");
    return { status: "failed", message: "猎聘登录状态已失效" };
  }
  // 等待期间 React 可能替换按钮节点，点击前重新定位当前可见且启用的发送按钮。
  sendButton = getActiveChatContainer()?.querySelector<HTMLButtonElement>(LIEPIN_SELECTORS.chatSend) ?? null;
  if (!sendButton || sendButton.disabled || !isElementVisible(sendButton)) {
    onLog?.("greeting", "send-disabled", "等待期间发送按钮失效");
    return { status: "failed", message: "等待发送期间猎聘发送按钮已失效" };
  }
  onLog?.("greeting", "click", "已点击猎聘招呼发送按钮", {
    elapsedMilliseconds: Date.now() - startedAt,
  });
  sendButton.click();
  return waitForStepReceipt(
    () => {
      // React 可能在发送后替换聊天节点，每轮重新获取当前窗口再检查回执。
      const currentChat = getActiveChatContainer();
      return currentChat && countSentGreeting(currentChat, greetingText) > baseline
        ? greetingText
        : undefined;
    },
    "AI 招呼语已发送",
    "点击发送后未检测到 AI 招呼语回执",
    8_000,
    undefined,
    "greeting",
    onLog,
  );
}

/**
 * 如果猎聘弹出简历确认框，则点击其中唯一明确的确认按钮。
 *
 * @param actionInterval 弹窗出现后点击确认前的随机稳定等待区间。
 * @returns 找到并点击确认按钮时返回 true。
 */
async function confirmResumeDialogIfPresent(actionInterval: ActionInterval): Promise<boolean> {
  const button = findLiepinResumeConfirmationButton();
  if (!button) return false;
  if (!await waitForActionInterval(actionInterval)) return false;
  if (detectVerificationEvidence()) return false;
  // 弹窗等待期间可能重绘，确认前必须重新获取唯一安全候选。
  const currentButton = findLiepinResumeConfirmationButton();
  if (!currentButton) return false;
  clickLiepinButton(currentButton);
  return true;
}

/**
 * 等待附件简历确认弹窗完成关闭动画，避免过早读取旧聊天节点。
 *
 * @param timeoutMilliseconds 最大等待时长。
 * @returns 弹窗关闭时返回 true，超时仍存在时返回 false。
 */
async function waitForResumeDialogToClose(timeoutMilliseconds = 3_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if (!isLiepinResumeConfirmationDialogVisible()) return true;
    if (stopRequested) return false;
    await delay(100);
  }
  return !isLiepinResumeConfirmationDialogVisible();
}

/**
 * 在当前聊天窗口单独发送在线/附件简历并等待本人简历卡片数量增加。
 *
 * @param timing 招呼回执后动作等待与简历确认回执等待配置。
 * @param onLog 当前岗位日志回调。
 * @returns 简历发送阶段回执。
 */
async function sendResumeAndWait(
  timing: DeliveryTiming,
  onLog?: DeliveryLogger,
): Promise<DeliveryStepResult> {
  const actionInterval: ActionInterval = timing;
  const startedAt = Date.now();
  onLog?.("resume", "start", "开始打开简历发送入口", {
    receiptTimeoutSeconds: normalizeResumeReceiptTimeoutSeconds(timing.resumeReceiptTimeoutSeconds),
  });
  if (!await waitForActionInterval(actionInterval)) {
    onLog?.("resume", "cancelled", "打开简历发送入口前收到停止请求");
    return { status: "failed", message: "用户已停止本次投递" };
  }
  const verification = detectVerificationEvidence();
  if (verification) {
    onLog?.("resume", "verification", "打开简历发送入口前检测到安全验证", {
      evidenceCharacters: verification.length,
    });
    return { status: "failed", message: "猎聘要求安全验证", evidence: verification };
  }
  if (detectLiepinLogin() === false) {
    onLog?.("resume", "login-lost", "打开简历发送入口前登录状态失效");
    return { status: "failed", message: "猎聘登录状态已失效" };
  }
  const chat = getActiveChatContainer();
  if (!chat) {
    onLog?.("resume", "chat-missing", "发送简历时聊天窗口不存在");
    return { status: "failed", message: "聊天窗口已消失，无法发送简历" };
  }
  const existingResumeCards = countSentResumeCards(chat);
  if (existingResumeCards > 0) {
    onLog?.("resume", "already-present", "当前聊天已有本人简历卡片，跳过重复发送", {
      cards: existingResumeCards,
    });
    return {
      status: "success",
      message: "当前聊天已存在本人简历卡片，未重复发送",
      evidence: `当前聊天已有 ${existingResumeCards} 张本人简历卡片`,
    };
  }
  const resumeButton = chat.querySelector<HTMLElement>(LIEPIN_SELECTORS.chatResume);
  if (!resumeButton || !isElementVisible(resumeButton)) {
    onLog?.("resume", "control-missing", "未找到猎聘发简历入口");
    return { status: "failed", message: "未找到猎聘“发简历”入口" };
  }

  const baseline = countSentResumeCards(chat);
  onLog?.("resume", "click-open", "已点击发简历入口", {
    baselineCards: baseline,
    elapsedMilliseconds: Date.now() - startedAt,
  });
  clickLiepinButton(resumeButton);
  let confirmationClicked = false;
  let confirmationDialogClosed = false;
  let confirmationDialogObserved = false;
  const receiptTimeout = normalizeResumeReceiptTimeoutSeconds(timing.resumeReceiptTimeoutSeconds) * 1_000;
  const receipt = await waitForStepReceipt(
    () => {
      // React 可能在简历发送后替换聊天节点，始终在当前可见窗口中确认新增卡片。
      const currentChat = getActiveChatContainer();
      return currentChat && countSentResumeCards(currentChat) > baseline
        ? "当前聊天新增本人简历卡片"
        : undefined;
    },
    "简历已发送",
    "点击发简历后未检测到简历卡片回执",
    receiptTimeout,
    // 弹窗可能异步出现；轮询期间仅点击文字明确且唯一的简历确认按钮，并等待关闭后再判断卡片。
    async () => {
      if (!confirmationDialogObserved && isLiepinResumeConfirmationDialogVisible()) {
        confirmationDialogObserved = true;
        onLog?.("resume", "dialog-visible", "已检测到附件简历确认弹窗", {
          confirmButtonFound: Boolean(findLiepinResumeConfirmationButton()),
        });
      }
      if (!confirmationClicked) {
        confirmationClicked = await confirmResumeDialogIfPresent(actionInterval);
        if (confirmationClicked) {
          confirmationDialogClosed = await waitForResumeDialogToClose();
          onLog?.("resume", "click-confirm", "已点击附件简历确认按钮", {
            dialogClosed: confirmationDialogClosed,
            elapsedMilliseconds: Date.now() - startedAt,
          });
          // 诊断只输出计数与状态，不输出简历正文或接口密钥。
          console.debug("[Get Jobs][Liepin][Resume] 已点击确认", {
            dialogClosed: confirmationDialogClosed,
            diagnostic: getResumeDeliveryDiagnostic(getActiveChatContainer()),
          });
        }
      }
    },
    "resume",
    onLog,
  );
  if (receipt.status === "unknown") {
    // 把脱敏诊断同时放入结果，用户无需打开 DevTools 才能判断卡在哪个阶段。
    const diagnostic = getResumeDeliveryDiagnostic(getActiveChatContainer());
    onLog?.("resume", "receipt-unknown", "简历回执未确认", {
      dialogObserved: confirmationDialogObserved,
      confirmationClicked,
      dialogClosed: confirmationDialogClosed,
      diagnostic,
    });
    return {
      ...receipt,
      message: `${receipt.message}（${diagnostic}）`,
      evidence: diagnostic,
    };
  }
  return receipt;
}

/**
 * 创建未执行阶段的统一回执。
 *
 * @param message 跳过原因。
 * @returns 跳过状态回执。
 */
function skippedStep(message: string): DeliveryStepResult {
  return { status: "skipped", message };
}

/**
 * 把结果交给 Service Worker 持久化，并刷新最终任务状态。
 *
 * @param taskId 本次投递唯一标识。
 * @param result 单岗位投递结果。
 * @returns 后台确认响应。
 */
async function recordResult(taskId: string, result: DeliveryResult): Promise<ExtensionResponse<unknown>> {
  const request: BackgroundRequest = { type: "RECORD_LIEPIN_ATTEMPT", taskId, result };
  return chrome.runtime.sendMessage(request) as Promise<ExtensionResponse<unknown>>;
}

/**
 * 对用户明确选中的单个猎聘岗位执行一次投递。
 *
 * @param taskId 本次投递唯一标识。
 * @param cardKey 岗位卡片稳定键。
 * @param greetingText 已确认的 AI 招呼语。
 * @param sendResume 是否在招呼成功后发送简历。
 * @param actionInterval 单岗位内部动作随机稳定等待区间。
 * @returns 已持久化的投递结果。
 */
async function applySingleJob(
  taskId: string,
  cardKey: string,
  greetingText: string,
  sendResume: boolean,
  actionInterval: DeliveryTiming,
): Promise<DeliveryResult> {
  if (applying) {
    throw new Error("已有岗位正在投递，请等待当前任务结束");
  }
  applying = true;
  activeTaskId = taskId;
  stopRequested = false;
  const logs: DeliveryLogEntry[] = [];
  const onLog = createDeliveryLogger(logs);
  const recordAndReturn = async (result: DeliveryResult): Promise<DeliveryResult> => {
    onLog("task", "complete", result.message, {
      outcome: result.outcome,
      logCountBeforeComplete: logs.length,
    });
    const persistedResult: DeliveryResult = {
      ...result,
      logs: logs.length ? logs.slice() : undefined,
    };
    await recordResult(taskId, persistedResult);
    return persistedResult;
  };

  try {
    let located = findJobCard(cardKey);
    if (!located) {
      throw new Error("页面已更新，找不到所选岗位，请重新识别岗位");
    }
    let { card, job } = located;
    onLog("task", "start", "开始执行猎聘岗位投递", {
      jobTitleCharacters: job.jobTitle.length,
      sendResume,
    });

    const normalizedGreeting = normalizeText(greetingText);
    if (!normalizedGreeting || normalizedGreeting.length > 150) {
      onLog("task", "validation-failed", "招呼语校验失败，阻止页面操作", {
        characters: normalizedGreeting.length,
      });
      const result: DeliveryResult = {
        outcome: "failed",
        message: "AI 招呼语为空或超过 150 字，已阻止页面操作",
        job,
        steps: {
          communication: skippedStep("招呼语校验失败，未建立沟通"),
          greeting: { status: "failed", message: "AI 招呼语为空或超过 150 字" },
          resume: skippedStep("未发送简历"),
        },
      };
      return recordAndReturn(result);
    }

    if (detectLiepinLogin() === false) {
      onLog("task", "login-lost", "开始投递前登录状态失效");
      const result: DeliveryResult = { outcome: "blocked", message: "请先登录猎聘", job };
      return recordAndReturn(result);
    }

    // 页面已有聊天窗时无法证明新点击产生了窗口，先要求用户手动关闭以防误判。
    if (getActiveChatContainer()) {
      onLog("communication", "chat-already-open", "页面已有聊天窗口，拒绝进行无法绑定岗位的点击");
      const result: DeliveryResult = {
        outcome: "blocked",
        message: "页面已有聊天窗口，请先关闭后再投递",
        job,
        steps: {
          communication: { status: "failed", message: "页面已有其他聊天窗口" },
          greeting: skippedStep("未发送 AI 招呼语"),
          resume: skippedStep("未发送简历"),
        },
      };
      return recordAndReturn(result);
    }

    let target = findChatButton(card);
    if (!target) {
      const revealed = await revealChatButton(cardKey, actionInterval);
      if (revealed) {
        located = revealed;
        card = revealed.card;
        job = revealed.job;
        target = revealed.target;
      }
    }
    if (!target) {
      onLog("communication", "control-missing", "未找到聊一聊或继续聊按钮");
      const result: DeliveryResult = {
        outcome: "failed",
        message: "悬停招聘者区域后仍未找到“聊一聊”或“继续聊”按钮",
        job,
      };
      return recordAndReturn(result);
    }

    if (target.text.includes("继续聊")) {
      onLog("communication", "already-contacted", "岗位已显示继续聊，跳过重复投递", {
        buttonTextCharacters: target.text.length,
      });
      const result: DeliveryResult = {
        outcome: "already-contacted",
        message: "该岗位已显示“继续聊”，记录为此前已联系，不计作本次新投递",
        job: { ...job, buttonText: target.text },
        evidence: target.text,
        steps: {
          communication: skippedStep("该岗位此前已经建立沟通"),
          greeting: skippedStep("为避免重复消息，未发送 AI 招呼语"),
          resume: skippedStep("为避免重复简历，未发送简历"),
        },
      };
      return recordAndReturn(result);
    }

    card.scrollIntoView({ behavior: "smooth", block: "center" });
    await waitForActionInterval(actionInterval);
    if (stopRequested) {
      onLog("communication", "cancelled", "点击沟通按钮前收到停止请求");
      const result: DeliveryResult = { outcome: "cancelled", message: "用户已停止本次投递", job };
      return recordAndReturn(result);
    }
    const verificationBeforeCommunication = detectVerificationEvidence();
    if (verificationBeforeCommunication) {
      onLog("communication", "verification", "点击沟通按钮前检测到安全验证", {
        evidenceCharacters: verificationBeforeCommunication.length,
      });
      const result: DeliveryResult = {
        outcome: "blocked",
        message: "猎聘要求安全验证，未点击沟通按钮",
        job,
        evidence: verificationBeforeCommunication,
        steps: {
          communication: { status: "failed", message: "点击前检测到猎聘安全验证", evidence: verificationBeforeCommunication },
          greeting: skippedStep("未发送 AI 招呼语"),
          resume: skippedStep("未发送简历"),
        },
      };
      return recordAndReturn(result);
    }
    const refreshedLocated = findJobCard(cardKey);
    const refreshedTarget = refreshedLocated ? findChatButton(refreshedLocated.card) : null;
    if (!refreshedLocated || !refreshedTarget || refreshedTarget.text.includes("继续聊")) {
      onLog("communication", "state-changed", "等待点击期间岗位沟通按钮状态发生变化");
      const result: DeliveryResult = {
        outcome: "blocked",
        message: "等待点击期间岗位按钮状态发生变化，未继续操作，请重新识别",
        job,
        steps: {
          communication: { status: "unknown", message: "沟通按钮在点击前发生变化" },
          greeting: skippedStep("未发送 AI 招呼语"),
          resume: skippedStep("未发送简历"),
        },
      };
      return recordAndReturn(result);
    }
    card = refreshedLocated.card;
    job = refreshedLocated.job;
    target = refreshedTarget;

    // 助手界面操作由用户明确触发；这里只点击所选卡片中的唯一目标按钮。
    onLog("communication", "click", "已点击岗位沟通按钮", {
      buttonTextCharacters: target.text.length,
    });
    target.button.click();
    const communication = await waitForCommunicationOutcome(8_000, job, onLog);
    const communicationStep: DeliveryStepResult = {
      status: communication.outcome === "delivered"
        ? "success"
        : communication.message.includes("结果未知")
          ? "unknown"
          : "failed",
      message: communication.message,
      evidence: communication.evidence,
    };
    if (communication.outcome !== "delivered") {
      const result: DeliveryResult = {
        ...communication,
        job: { ...job, buttonText: target.text },
        steps: {
          communication: communicationStep,
          greeting: skippedStep("聊天窗口未确认，未发送 AI 招呼语"),
          resume: skippedStep("聊天窗口未确认，未发送简历"),
        },
      };
      return recordAndReturn(result);
    }

    const greeting = await sendGreetingAndWait(normalizedGreeting, actionInterval, onLog);
    if (greeting.status !== "success") {
      const result: DeliveryResult = {
        outcome: stopRequested ? "cancelled" : greeting.status === "unknown" ? "blocked" : "failed",
        message: greeting.message,
        job: { ...job, buttonText: target.text },
        evidence: greeting.evidence,
        steps: {
          communication: communicationStep,
          greeting,
          resume: skippedStep("AI 招呼语未确认成功，未继续发送简历"),
        },
      };
      return recordAndReturn(result);
    }

    const resume = sendResume
      ? await sendResumeAndWait(actionInterval, onLog)
      : skippedStep("配置已关闭自动发送简历");
    if (!sendResume) onLog("resume", "skipped", "配置已关闭自动发送简历");
    const completed = resume.status === "success" || resume.status === "skipped";
    const resumeAlreadyPresent = resume.status === "success" && resume.message.includes("未重复发送");
    const result: DeliveryResult = {
      outcome: completed
        ? "delivered"
        : stopRequested
          ? "cancelled"
          : resume.status === "unknown"
            ? "blocked"
            : "failed",
      message: completed
        ? sendResume
          ? resumeAlreadyPresent
            ? "AI 招呼语已确认发送；当前聊天已有简历，未重复发送"
            : "AI 招呼语与简历均已确认发送"
          : "AI 招呼语已确认发送，配置未要求发送简历"
        : resume.message,
      job: { ...job, buttonText: target.text },
      evidence: [communicationStep.evidence, greeting.evidence, resume.evidence].filter(Boolean).join("；"),
      steps: { communication: communicationStep, greeting, resume },
    };
    if (result.outcome === "delivered") await closeChatWindow(actionInterval, onLog);
    return recordAndReturn(result);
  } finally {
    applying = false;
    activeTaskId = undefined;
  }
}

chrome.runtime.onMessage.addListener((request: ContentRequest, _sender, sendResponse) => {
  if (request.type === "TOGGLE_EMBEDDED_PANEL") {
    const open = ensureEmbeddedPanel().toggle();
    sendResponse({ ok: true, data: { open } } satisfies ExtensionResponse<unknown>);
    return false;
  }
  if (request.type === "INSPECT_LIEPIN") {
    sendResponse({ ok: true, data: inspectLiepinPage() } satisfies ExtensionResponse<unknown>);
    return false;
  }
  if (request.type === "STOP_LIEPIN_TASK") {
    const matchesActiveTask = applying && activeTaskId === request.taskId;
    if (matchesActiveTask) {
      stopRequested = true;
    }
    sendResponse({
      ok: true,
      data: { stopped: matchesActiveTask, applying: matchesActiveTask },
    } satisfies ExtensionResponse<unknown>);
    return false;
  }
  if (request.type === "APPLY_LIEPIN_JOB") {
    void applySingleJob(
      request.taskId,
      request.cardKey,
      request.greetingText,
      request.sendResume,
      request.actionInterval,
    )
      .then((result) => sendResponse({ ok: true, data: result } satisfies ExtensionResponse<unknown>))
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        sendResponse({ ok: false, error: message } satisfies ExtensionResponse<unknown>);
      });
    return true;
  }
  return false;
});

startEmbeddedPanelRecovery();

// 通知后台页面脚本已重新装载；若旧任务仍在运行，后台会安全中止而不是重复点击。
void chrome.runtime.sendMessage({ type: "CONTENT_READY" } satisfies BackgroundRequest).catch(() => undefined);

// 保留显式引用，确保构建器不会误判岗位列表解析为无用代码。
void parseLiepinJobCards;
