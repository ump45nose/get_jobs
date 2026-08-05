import {
  LIEPIN_SELECTORS,
  detectLiepinLogin,
  inspectLiepinPage,
  isElementVisible,
  normalizeText,
  parseLiepinJobCard,
  parseLiepinJobCards,
} from "../shared/liepin-parser";
import type {
  BackgroundRequest,
  ContentRequest,
  DeliveryResult,
  ExtensionResponse,
  LiepinJobSnapshot,
} from "../shared/types";

let stopRequested = false;
let applying = false;
let activeTaskId: string | undefined;
const LAUNCHER_HOST_ID = "get-jobs-extension-launcher";

/**
 * 在猎聘页面注入隔离样式的悬浮入口，解决工具栏图标未固定时无法发现插件的问题。
 *
 * @returns 悬浮入口存在或创建完成时返回。
 */
function mountPageLauncher(): void {
  if (document.getElementById(LAUNCHER_HOST_ID)) {
    return;
  }

  const host = document.createElement("div");
  host.id = LAUNCHER_HOST_ID;
  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = `
    :host { all: initial; }
    button {
      position: fixed;
      right: 76px;
      bottom: 28px;
      z-index: 2147483646;
      display: inline-flex;
      align-items: center;
      gap: 8px;
      min-height: 44px;
      padding: 0 15px 0 10px;
      border: 1px solid rgba(255, 255, 255, 0.42);
      border-radius: 999px;
      color: #fff;
      background: linear-gradient(135deg, #ff7629, #e85a18);
      box-shadow: 0 10px 28px rgba(154, 62, 18, 0.32);
      font: 700 13px/1 system-ui, "Microsoft YaHei", sans-serif;
      letter-spacing: .01em;
      cursor: pointer;
      transition: transform .16s ease, box-shadow .16s ease, opacity .16s ease;
    }
    button:hover {
      transform: translateY(-2px);
      box-shadow: 0 13px 32px rgba(154, 62, 18, 0.4);
    }
    button:focus-visible {
      outline: 3px solid rgba(255, 118, 41, 0.28);
      outline-offset: 3px;
    }
    button:disabled { cursor: wait; opacity: .72; }
    .mark {
      display: grid;
      width: 27px;
      height: 27px;
      place-items: center;
      border-radius: 50%;
      color: #e85a18;
      background: #fff;
      font-size: 12px;
      font-weight: 900;
    }
  `;

  const button = document.createElement("button");
  button.type = "button";
  button.title = "打开 Get Jobs 猎聘投递助手";
  button.setAttribute("aria-label", "打开 Get Jobs 猎聘投递助手");
  button.innerHTML = '<span class="mark">GJ</span><span class="text">Get Jobs 助手</span>';
  button.addEventListener("click", async () => {
    const label = button.querySelector<HTMLElement>(".text");
    button.disabled = true;
    if (label) label.textContent = "正在打开…";
    try {
      const response = (await chrome.runtime.sendMessage({
        type: "OPEN_SIDE_PANEL",
      } satisfies BackgroundRequest)) as ExtensionResponse<{ opened: boolean }>;
      if (!response.ok) {
        throw new Error(response.error || "侧边栏打开失败");
      }
      if (label) label.textContent = "Get Jobs 助手";
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      button.title = `${message}；也可以点击 Chrome 工具栏中的插件图标`;
      if (label) label.textContent = "打开失败，重试";
    } finally {
      button.disabled = false;
    }
  });

  shadow.append(style, button);
  document.documentElement.append(host);
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

/**
 * 在页面重新渲染后重新定位用户选中的岗位卡片。
 *
 * @param cardKey 侧边栏识别时生成的卡片键。
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
  await delay(180);
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
      if (selector.includes("captcha") || selector.includes("geetest") || /验证码|安全验证|完成验证|操作频繁/.test(text)) {
        return text || "检测到平台安全验证";
      }
    }
  }
  return undefined;
}

/**
 * 读取平台明确展示的沟通成功证据。
 *
 * @returns 找到时返回提示文本。
 */
function detectSuccessEvidence(): string | undefined {
  const chatHeader = document.querySelector(LIEPIN_SELECTORS.chatHeader);
  if (isElementVisible(chatHeader)) {
    return normalizeText(chatHeader?.textContent) || "猎聘聊天窗口已打开";
  }

  const selectors = ["[role='alert']", "[class*='toast']", "[class*='message']"];
  for (const selector of selectors) {
    for (const element of document.querySelectorAll(selector)) {
      if (!isElementVisible(element)) continue;
      const text = normalizeText(element.textContent);
      if (/打招呼成功|沟通成功|消息已发送|已发送/.test(text)) {
        return text;
      }
    }
  }
  return undefined;
}

/**
 * 点击成功后尽力关闭聊天窗口；关闭失败不改变已经确认的业务结果。
 *
 * @returns 关闭动作结束时返回。
 */
async function closeChatWindow(): Promise<void> {
  const close = document.querySelector<HTMLElement>(LIEPIN_SELECTORS.chatClose);
  if (close && isElementVisible(close)) {
    close.click();
    await delay(150);
  }
}

/**
 * 等待聊天成功、验证码、登录失效、停止或超时。
 *
 * @param timeoutMilliseconds 最大等待时长。
 * @returns 投递业务结果与证据。
 */
async function waitForDeliveryOutcome(
  timeoutMilliseconds: number,
): Promise<{ outcome: DeliveryResult["outcome"]; message: string; evidence?: string }> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if (stopRequested) {
      return { outcome: "cancelled", message: "用户已停止本次投递" };
    }

    const verification = detectVerificationEvidence();
    if (verification) {
      return {
        outcome: "blocked",
        message: "猎聘要求安全验证，任务已停止",
        evidence: verification,
      };
    }

    if (detectLiepinLogin() === false) {
      return { outcome: "blocked", message: "猎聘登录状态已失效" };
    }

    const success = detectSuccessEvidence();
    if (success) {
      return {
        outcome: "delivered",
        message: "猎聘已打开本岗位聊天窗口，投递确认成功",
        evidence: success,
      };
    }
    await delay(150);
  }
  return {
    outcome: "failed",
    message: "点击后未在限定时间内检测到明确成功结果",
  };
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
 * @returns 已持久化的投递结果。
 */
async function applySingleJob(taskId: string, cardKey: string): Promise<DeliveryResult> {
  if (applying) {
    throw new Error("已有岗位正在投递，请等待当前任务结束");
  }
  applying = true;
  activeTaskId = taskId;
  stopRequested = false;

  try {
    let located = findJobCard(cardKey);
    if (!located) {
      throw new Error("页面已更新，找不到所选岗位，请重新识别岗位");
    }
    let { card, job } = located;

    if (detectLiepinLogin() === false) {
      const result: DeliveryResult = { outcome: "blocked", message: "请先登录猎聘", job };
      await recordResult(taskId, result);
      return result;
    }

    // 页面已有聊天窗时无法证明新点击产生了窗口，先要求用户手动关闭以防误判。
    if (isElementVisible(document.querySelector(LIEPIN_SELECTORS.chatHeader))) {
      const result: DeliveryResult = {
        outcome: "blocked",
        message: "页面已有聊天窗口，请先关闭后再投递",
        job,
      };
      await recordResult(taskId, result);
      return result;
    }

    let target = findChatButton(card);
    if (!target) {
      const revealed = await revealChatButton(cardKey);
      if (revealed) {
        located = revealed;
        card = revealed.card;
        job = revealed.job;
        target = revealed.target;
      }
    }
    if (!target) {
      const result: DeliveryResult = {
        outcome: "failed",
        message: "悬停招聘者区域后仍未找到“聊一聊”或“继续聊”按钮",
        job,
      };
      await recordResult(taskId, result);
      return result;
    }

    if (target.text.includes("继续聊")) {
      const result: DeliveryResult = {
        outcome: "already-contacted",
        message: "该岗位已显示“继续聊”，记录为此前已联系，不计作本次新投递",
        job: { ...job, buttonText: target.text },
        evidence: target.text,
      };
      await recordResult(taskId, result);
      return result;
    }

    card.scrollIntoView({ behavior: "smooth", block: "center" });
    await delay(180);
    if (stopRequested) {
      const result: DeliveryResult = { outcome: "cancelled", message: "用户已停止本次投递", job };
      await recordResult(taskId, result);
      return result;
    }

    // 侧边栏操作由用户明确触发；这里只点击所选卡片中的唯一目标按钮。
    target.button.click();
    const outcome = await waitForDeliveryOutcome(6_000);
    const result: DeliveryResult = { ...outcome, job: { ...job, buttonText: target.text } };
    if (result.outcome === "delivered") {
      await closeChatWindow();
    }
    await recordResult(taskId, result);
    return result;
  } finally {
    applying = false;
    activeTaskId = undefined;
  }
}

chrome.runtime.onMessage.addListener((request: ContentRequest, _sender, sendResponse) => {
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
    void applySingleJob(request.taskId, request.cardKey)
      .then((result) => sendResponse({ ok: true, data: result } satisfies ExtensionResponse<unknown>))
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        sendResponse({ ok: false, error: message } satisfies ExtensionResponse<unknown>);
      });
    return true;
  }
  return false;
});

mountPageLauncher();

// 通知后台页面脚本已重新装载；若旧任务仍在运行，后台会安全中止而不是重复点击。
void chrome.runtime.sendMessage({ type: "CONTENT_READY" } satisfies BackgroundRequest).catch(() => undefined);

// 保留显式引用，确保构建器不会误判岗位列表解析为无用代码。
void parseLiepinJobCards;
