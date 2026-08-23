import type { BackgroundRequest, ContentRequest, ExtensionResponse } from "../shared/types";

/**
 * 向 Service Worker 发送类型化业务消息，并把失败响应统一转换为异常。
 *
 * @param request 后台业务请求。
 * @returns 响应中的业务数据。
 */
export async function sendBackground<T>(request: BackgroundRequest): Promise<T> {
  const response = (await chrome.runtime.sendMessage(request)) as ExtensionResponse<T>;
  if (!response.ok) throw new Error(response.error || "后台操作失败");
  return response.data as T;
}

/**
 * 获取当前窗口活动标签页，所有投递动作必须显式绑定此标签页。
 *
 * @returns 当前活动标签页。
 */
export async function getActiveTab(): Promise<chrome.tabs.Tab> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("无法获取当前标签页");
  return tab;
}

/**
 * 向指定页面的 Content Script 发送请求，并统一处理扩展响应错误。
 *
 * @param request 页面操作请求。
 * @param tabId 已绑定的目标标签页；省略时使用当前活动标签页。
 * @returns Content Script 返回的业务数据。
 */
export async function sendContent<T>(request: ContentRequest, tabId?: number): Promise<T> {
  const targetTabId = tabId ?? (await getActiveTab()).id;
  if (!targetTabId) throw new Error("无法识别目标标签页");
  const response = (await chrome.tabs.sendMessage(targetTabId, request)) as ExtensionResponse<T>;
  if (!response.ok) throw new Error(response.error || "页面操作失败");
  return response.data as T;
}
