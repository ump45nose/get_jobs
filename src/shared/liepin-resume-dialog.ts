import { isElementVisible, normalizeText } from "./liepin-parser";

/** 猎聘简历发送弹窗允许自动确认的精确按钮文案。 */
const RESUME_CONFIRM_LABELS = new Set([
  "确定",
  "确认发送",
  "发送简历",
  "立即投递",
]);

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
  const candidates: HTMLElement[] = [];
  const dialogs = Array.from(root.querySelectorAll<HTMLElement>("[role='dialog'], .ant-im-modal"));
  for (const dialog of dialogs) {
    if (!isElementVisible(dialog) || dialog.matches(".im-ui-basic-chat-modal")) continue;
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
    if (buttons.length === 1) candidates.push(buttons[0]);
  }

  // 页面同时出现多个候选弹窗时拒绝自动操作，要求用户人工核对。
  return candidates.length === 1 ? candidates[0] : undefined;
}
