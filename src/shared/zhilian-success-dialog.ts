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

/**
 * 在明确成功弹窗内寻找唯一关闭控件，绝不关闭失败或未知页面。
 *
 * @param documentRef 当前智联页面文档。
 * @returns 唯一成功关闭控件；证据不足或存在歧义时返回 null。
 */
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
