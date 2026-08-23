import { isElementVisible, normalizeText } from "./liepin-parser";

/** 猎聘简历发送弹窗允许自动确认的精确按钮文案。 */
const RESUME_CONFIRM_LABELS = new Set([
  "确定",
  "确认发送",
  "发送简历",
  "立即投递",
]);

/**
 * 判断元素是否属于猎聘聊天主窗口，而不是附件简历确认弹窗。
 *
 * @param element 待判断的弹窗节点。
 * @returns 属于聊天窗口时返回 true。
 */
function isLiepinChatDialog(element: HTMLElement): boolean {
  return Array.from(element.classList).some((className) => className.includes("im-ui-basic-chat-modal"));
}

/**
 * 获取页面中可能由 React Portal 挂载的简历确认弹窗。
 *
 * @param root 页面文档或测试 DOM 根节点。
 * @returns 所有可见且文本明确的简历确认弹窗。
 */
function findResumeDialogs(root: ParentNode): HTMLElement[] {
  const candidates = new Set<HTMLElement>();
  const selectors = [
    "[role='dialog']",
    ".ant-im-modal",
    "[class*='ant-modal']",
  ];
  for (const selector of selectors) {
    for (const dialog of root.querySelectorAll<HTMLElement>(selector)) candidates.add(dialog);
  }

  return Array.from(candidates).filter((dialog) => {
    if (!isElementVisible(dialog) || isLiepinChatDialog(dialog)) return false;
    const text = normalizeText(dialog.textContent);
    // 只认附件选择弹窗的稳定文案，避免页面其他“发送简历”按钮成为候选。
    return text.includes("选择附件简历")
      || text.includes("招聘方将同时收到")
      || text.includes("默认在线简历和附件简历");
  });
}

/**
 * 判断附件简历确认弹窗是否仍然可见。
 *
 * @param root 页面文档或测试 DOM 根节点。
 * @returns 弹窗仍在页面上时返回 true。
 */
export function isLiepinResumeConfirmationDialogVisible(root: ParentNode = document): boolean {
  return findResumeDialogs(root).length > 0;
}

/**
 * 判断附件选择弹窗中的单选项是否已有明确选中项。
 *
 * @param dialog 当前候选简历弹窗。
 * @returns 没有单选项或至少一个单选项已选中时返回 true。
 */
function hasSelectedResumeOption(dialog: HTMLElement): boolean {
  const radios = Array.from(dialog.querySelectorAll<HTMLElement>("input[type='radio'], [role='radio']"));
  if (!radios.length) return true;
  return radios.some((radio) => {
    if (radio instanceof HTMLInputElement) return radio.checked;
    return radio.getAttribute("aria-checked") === "true";
  });
}

/**
 * 在可见猎聘简历弹窗中查找唯一、安全且可用的确认按钮。
 *
 * @param root 页面文档或测试 DOM 根节点。
 * @returns 唯一确认按钮；条件不明确时返回 undefined，避免误点。
 */
export function findLiepinResumeConfirmationButton(
  root: ParentNode = document,
): HTMLElement | undefined {
  const candidates = new Set<HTMLElement>();
  const dialogs = findResumeDialogs(root);
  for (const dialog of dialogs) {
    const text = normalizeText(dialog.textContent);
    if (!text.includes("简历") || !hasSelectedResumeOption(dialog)) continue;

    // 仅接受精确业务文案；关闭、预览及其他弹窗动作不会进入候选集合。
    const buttons = Array.from(dialog.querySelectorAll<HTMLElement>("button, [role='button']")).filter((button) => {
      const label = normalizeText(button.textContent);
      const disabled = button instanceof HTMLButtonElement
        ? button.disabled
        : button.getAttribute("aria-disabled") === "true";
      return !disabled && isElementVisible(button) && RESUME_CONFIRM_LABELS.has(label);
    });
    if (buttons.length === 1) candidates.add(buttons[0]);
  }

  // 页面同时出现多个候选弹窗时拒绝自动操作，要求用户人工核对。
  return candidates.size === 1 ? Array.from(candidates)[0] : undefined;
}

/** 等待附件简历弹窗 DOM 变化时使用的配置。 */
export interface LiepinResumeDialogWaitOptions {
  /** 页面文档或测试 DOM 根节点。 */
  root?: ParentNode;
  /** 最长等待毫秒数。 */
  timeoutMilliseconds: number;
  /** 任务停止、验证出现或其它业务条件满足时提前中止。 */
  shouldAbort?: () => boolean;
  /** MutationObserver 未收到变化时的兜底轮询间隔。 */
  pollMilliseconds?: number;
}

/**
 * 等待简历弹窗发生一次 DOM/状态变化，同时用短轮询兜底未触发 MutationObserver 的属性更新。
 *
 * @param root 当前页面或测试根节点。
 * @param timeoutMilliseconds 本次最长等待时长。
 * @returns DOM 变化或兜底计时结束时返回。
 */
function waitForResumeDialogMutation(root: ParentNode, timeoutMilliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      observer.disconnect();
      clearTimeout(timer);
      resolve();
    };
    const observer = new MutationObserver(finish);
    const timer = setTimeout(finish, Math.max(1, timeoutMilliseconds));
    // React Portal 可能替换整个按钮或只切换单选框/禁用样式，两类变化都需要唤醒重新定位。
    observer.observe(root as Node, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "style", "disabled", "aria-disabled", "aria-checked", "checked"],
    });
  });
}

/**
 * 串行等待猎聘附件简历弹窗中的唯一可用确认按钮。
 *
 * @param options 等待根节点、超时、业务中止条件与轮询间隔。
 * @returns 找到的当前按钮节点；超时或业务中止时返回 undefined。
 */
export async function waitForLiepinResumeConfirmationButton(
  options: LiepinResumeDialogWaitOptions,
): Promise<HTMLElement | undefined> {
  const root = options.root ?? document;
  const pollMilliseconds = Math.max(20, options.pollMilliseconds ?? 120);
  const deadline = Date.now() + Math.max(0, options.timeoutMilliseconds);
  while (Date.now() < deadline) {
    if (options.shouldAbort?.()) return undefined;
    const button = findLiepinResumeConfirmationButton(root);
    if (button) return button;
    await waitForResumeDialogMutation(root, Math.min(pollMilliseconds, deadline - Date.now()));
  }
  return options.shouldAbort?.() ? undefined : findLiepinResumeConfirmationButton(root);
}

/**
 * 串行等待附件简历确认弹窗完全关闭，防止关闭动画期间提前读取聊天回执。
 *
 * @param options 等待根节点、超时、业务中止条件与轮询间隔。
 * @returns 弹窗已经关闭时返回 true；超时或业务中止时返回 false。
 */
export async function waitForLiepinResumeConfirmationDialogToClose(
  options: LiepinResumeDialogWaitOptions,
): Promise<boolean> {
  const root = options.root ?? document;
  const pollMilliseconds = Math.max(20, options.pollMilliseconds ?? 120);
  const deadline = Date.now() + Math.max(0, options.timeoutMilliseconds);
  while (Date.now() < deadline) {
    if (options.shouldAbort?.()) return false;
    if (!isLiepinResumeConfirmationDialogVisible(root)) return true;
    await waitForResumeDialogMutation(root, Math.min(pollMilliseconds, deadline - Date.now()));
  }
  return !options.shouldAbort?.() && !isLiepinResumeConfirmationDialogVisible(root);
}
