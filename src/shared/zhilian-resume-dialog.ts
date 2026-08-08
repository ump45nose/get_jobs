import type { ZhilianConfig } from "./types";

/** 智联简历选择弹窗中经过唯一性校验的安全动作集合。 */
export interface ZhilianResumeDialogActions {
  root: HTMLElement;
  resumeControl: HTMLElement;
  submitButton: HTMLElement;
  selectedResumeText: string;
}

/** 判断元素是否处于当前可交互页面中；jsdom 测试没有布局信息时按未隐藏处理。 */
function isVisible(element: HTMLElement): boolean {
  if (element.hidden || element.getAttribute("aria-hidden") === "true") return false;
  const style = element.getAttribute("style") ?? "";
  if (/display\s*:\s*none|visibility\s*:\s*hidden/i.test(style)) return false;
  return element.getClientRects().length > 0 || typeof navigator === "undefined" || /jsdom/i.test(navigator.userAgent);
}

/** 将页面文案压缩为适合精确语义判断的单行文本。 */
function textOf(element: Element): string {
  return (element.textContent ?? "").replace(/\s+/g, " ").trim();
}

/** 从 radio 向上定位只承载当前简历选项的最小可点击容器。 */
function findOptionContainer(control: HTMLElement, root: HTMLElement): HTMLElement {
  if (control instanceof HTMLInputElement && control.labels?.[0]) return control.labels[0];
  let current: HTMLElement | null = control;
  for (let depth = 0; current && current !== root && depth < 5; depth += 1) {
    const controls = current.querySelectorAll('input[type="radio"], [role="radio"]');
    if (controls.length === 1 && textOf(current).length > 0) return current;
    current = current.parentElement;
  }
  return control;
}

/**
 * 在当前文档中解析唯一且可安全操作的智联简历弹窗。
 *
 * @param documentRef 当前页面文档。
 * @param config 用户保存的简历选择配置。
 * @returns 唯一匹配时返回动作集合；没有弹窗返回 null；歧义或缺失时抛出错误。
 */
export function findZhilianResumeDialog(
  documentRef: Document,
  config: ZhilianConfig,
): ZhilianResumeDialogActions | null {
  const roots = Array.from(documentRef.querySelectorAll<HTMLElement>(
    '[role="dialog"], .ant-modal, .el-dialog, [class*="modal"], [class*="dialog"]',
  )).filter((root) => isVisible(root) && textOf(root).includes("请选择要投递的简历"));
  const uniqueRoots = roots.filter((root, index) => !roots.some((other, otherIndex) => (
    otherIndex !== index && other.contains(root)
  )));
  if (uniqueRoots.length === 0) return null;
  if (uniqueRoots.length !== 1) throw new Error("检测到多个智联简历弹窗，已停止以避免误投");
  const root = uniqueRoots[0];

  const submitButtons = Array.from(root.querySelectorAll<HTMLElement>('button, [role="button"]'))
    .filter((button) => isVisible(button)
      && !(button instanceof HTMLButtonElement && button.disabled)
      && button.getAttribute("aria-disabled") !== "true"
      && textOf(button) === "投递简历");
  if (submitButtons.length !== 1) throw new Error("未找到唯一可用的“投递简历”按钮，已停止");

  const controls = Array.from(root.querySelectorAll<HTMLElement>('input[type="radio"], [role="radio"]'))
    .map((control) => ({ control, container: findOptionContainer(control, root) }));
  const options = controls.map((item) => ({ ...item, text: textOf(item.container) }));
  const preferredName = config.preferredResumeName.replace(/\s+/g, "").toLowerCase();
  const candidates = options.filter((option) => {
    const normalizedText = option.text.replace(/\s+/g, "").toLowerCase();
    if (config.resumeMode === "online") return normalizedText.includes("在线简历");
    if (normalizedText.includes("在线简历")) return false;
    if (preferredName) return normalizedText.includes(preferredName);
    return /\.pdf|附件简历|上传/.test(normalizedText);
  });
  if (candidates.length !== 1) {
    const target = config.resumeMode === "online"
      ? "在线简历"
      : preferredName
        ? `名称包含“${config.preferredResumeName}”的附件简历`
        : "唯一附件简历";
    throw new Error(`未唯一匹配${target}，已停止；请检查智联简历配置`);
  }
  return {
    root,
    // 实际站点常把原生 radio 隐藏在可见 label 内，点击容器比直接点击隐藏 input 更稳定。
    resumeControl: candidates[0].container,
    submitButton: submitButtons[0],
    selectedResumeText: candidates[0].text,
  };
}

/** 在明确成功弹窗内寻找唯一关闭控件，绝不关闭失败或未知页面。 */
export function findZhilianSuccessCloseButton(documentRef: Document): HTMLElement | null {
  const successRoots = Array.from(documentRef.querySelectorAll<HTMLElement>(
    '[role="dialog"], .ant-modal, .el-dialog, [class*="modal"], [class*="dialog"]',
  )).filter((root) => isVisible(root) && /申请成功|投递成功/.test(textOf(root)));
  const roots = successRoots.filter((root, index) => !successRoots.some((other, otherIndex) => (
    otherIndex !== index && other.contains(root)
  )));
  if (roots.length !== 1) return null;
  const candidates = Array.from(roots[0].querySelectorAll<HTMLElement>(
    'button, [role="button"], [aria-label="关闭"], [aria-label="Close"], .ant-modal-close, .el-dialog__headerbtn',
  )).filter((element) => {
    if (!isVisible(element)) return false;
    const text = textOf(element);
    const label = element.getAttribute("aria-label") ?? "";
    return /^(关闭|完成|知道了|我知道了|Close)$/i.test(text || label)
      || element.matches(".ant-modal-close, .el-dialog__headerbtn");
  });
  return candidates.length === 1 ? candidates[0] : null;
}
