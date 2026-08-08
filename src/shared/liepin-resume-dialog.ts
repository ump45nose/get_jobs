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
