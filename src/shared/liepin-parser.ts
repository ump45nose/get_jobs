import type { LiepinJobSnapshot, LiepinPageContext } from "./types";

export const LIEPIN_SELECTORS = {
  jobCards: "div[class*='job-card-pc-container']",
  chatContainer: ".im-ui-basic-chat-modal .im-ui-chat-container",
  chatInput: "textarea.im-ui-textarea[placeholder*='请输入文字']",
  chatSend: "button.im-ui-basic-send-btn",
  chatResume: ".im-ui-action-button.action-resume",
  sentText: ".im-ui-txt.send .im-ui-txt-content .text",
  sentResume: ".im-ui-txt.send .im-ui-send-attachment-card",
  chatClose: "[aria-label='close']",
  loggedIn: [
    "#header-quick-menu-user-info",
    "img.header-quick-menu-user-photo",
    ".header-quick-menu-user-photo",
  ],
  loggedOut: [
    "#header-quick-menu-login",
    "a[href*='login']",
    "a[data-key='login']",
    "button[data-key='login']",
  ],
} as const;

const TITLE_SELECTORS = [
  "a[data-nick='job-detail-job-info']",
  ".job-title-box a",
  "[class*='job-title']",
  "a[href*='/job/']",
];
const COMPANY_SELECTORS = [
  "[class*='company-name']",
  "[class*='comp-name']",
  "a[href*='/company/']",
];
const SALARY_SELECTORS = ["[class*='job-salary']", "[class*='salary']"];
const AREA_SELECTORS = ["[class*='job-dq']", "[class*='job-area']", "[class*='area']"];
const RECRUITER_SELECTORS = [
  "[class*='recruiter-name']",
  ".recruiter-info-box [class*='name']",
  "[class*='hr-name']",
];

/**
 * 规整页面文本，消除换行与重复空白对指纹和展示的影响。
 *
 * @param value 原始文本。
 * @returns 单行文本。
 */
export function normalizeText(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

/**
 * 将页面文本规整为适合岗位绑定比较的形式。
 *
 * @param value 岗位、公司或聊天窗口文本。
 * @returns 移除空白并统一大小写后的文本。
 */
function normalizeMatchText(value: string | null | undefined): string {
  return normalizeText(value).replace(/\s+/g, "").toLocaleLowerCase();
}

/**
 * 判断当前聊天文本是否属于用户选择的猎聘岗位。
 *
 * @param chatText 当前可见聊天容器文本。
 * @param job 用户点击时保存的岗位快照。
 * @returns 完整标题匹配，或核心标题与公司同时匹配时返回 true。
 */
export function matchLiepinChatToJob(chatText: string, job: LiepinJobSnapshot): boolean {
  const normalizedChat = normalizeMatchText(chatText);
  const normalizedTitle = normalizeMatchText(job.jobTitle);
  if (!normalizedChat || !normalizedTitle) return false;

  // 完整标题是原有的强证据，即使猎头职位没有公开真实公司名也可继续使用。
  if (normalizedChat.includes(normalizedTitle)) return true;

  // 猎聘聊天头会移除卡片末尾的【地区】；降级匹配时必须同时命中公司，避免误绑同名岗位。
  const coreTitle = normalizeMatchText(normalizeText(job.jobTitle).replace(/\s*【[^】]+】\s*$/, ""));
  const company = normalizeMatchText(job.compName);
  return coreTitle !== normalizedTitle
    && Boolean(coreTitle)
    && Boolean(company)
    && normalizedChat.includes(coreTitle)
    && normalizedChat.includes(company);
}

/**
 * 判断元素是否处于可交互状态。
 *
 * @param element 待检测元素。
 * @returns 元素未隐藏时返回 true。
 */
export function isElementVisible(element: Element | null): boolean {
  if (!(element instanceof HTMLElement)) {
    return false;
  }
  const style = window.getComputedStyle(element);
  return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
}

/**
 * 从多个候选选择器中读取第一个有效文本。
 *
 * @param root 查询根节点。
 * @param selectors 按优先级排列的选择器。
 * @returns 找不到时返回空字符串。
 */
function queryText(root: ParentNode, selectors: readonly string[]): string {
  for (const selector of selectors) {
    const text = normalizeText(root.querySelector(selector)?.textContent);
    if (text) {
      return text;
    }
  }
  return "";
}

/**
 * 从卡片埋点属性或岗位链接中提取 jobId。
 *
 * @param card 猎聘岗位卡片。
 * @returns 找不到时返回 undefined。
 */
export function extractLiepinJobId(card: Element): string | undefined {
  const ext = card.getAttribute("data-tlg-ext");
  if (ext) {
    try {
      const parsed = JSON.parse(decodeURIComponent(ext)) as { jobId?: string | number };
      if (parsed.jobId) {
        return String(parsed.jobId);
      }
    } catch {
      const extMatch = ext.match(/(?:\\?"jobId\\?"\s*:\s*\\?")(\d+)/);
      if (extMatch?.[1]) {
        return extMatch[1];
      }
    }
  }

  const scmMatch = card.getAttribute("data-tlg-scm")?.match(/jobId=(\d+)/);
  if (scmMatch?.[1]) {
    return scmMatch[1];
  }

  const href = card.querySelector<HTMLAnchorElement>("a[href*='/job/'], a[href*='jobId=']")?.href;
  return href?.match(/\/job\/(\d+)/)?.[1] ?? href?.match(/[?&]jobId=(\d+)/)?.[1];
}

/**
 * 为缺少 jobId 的卡片生成稳定的短指纹。
 *
 * @param value 参与指纹计算的业务文本。
 * @returns 十六进制短指纹。
 */
function hashFingerprint(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

/**
 * 获取卡片内“聊一聊”或“继续聊”按钮文本。
 *
 * @param card 猎聘岗位卡片。
 * @returns 目标按钮文本，找不到时返回 undefined。
 */
export function getLiepinChatButtonText(card: Element): string | undefined {
  const buttons = Array.from(card.querySelectorAll<HTMLButtonElement>("button"));
  for (const button of buttons) {
    const text = normalizeText(button.textContent);
    if (text.includes("聊一聊") || text.includes("继续聊")) {
      return text;
    }
  }
  return undefined;
}

/**
 * 把一个猎聘岗位卡片解析为可持久化快照。
 *
 * @param card 猎聘岗位卡片。
 * @param index 卡片在当前列表中的位置，仅作为最后兜底。
 * @returns 岗位快照。
 */
export function parseLiepinJobCard(card: Element, index: number): LiepinJobSnapshot {
  const jobId = extractLiepinJobId(card);
  const jobTitle = queryText(card, TITLE_SELECTORS) || `未命名岗位 ${index + 1}`;
  const compName = queryText(card, COMPANY_SELECTORS) || undefined;
  const jobSalaryText = queryText(card, SALARY_SELECTORS) || undefined;
  const jobArea = queryText(card, AREA_SELECTORS) || undefined;
  const hrName = queryText(card, RECRUITER_SELECTORS) || undefined;
  const jobLink = card.querySelector<HTMLAnchorElement>("a[href*='/job/']")?.href;
  const fingerprintSource = [jobId, jobTitle, compName, jobLink].filter(Boolean).join("|");
  const fingerprint = hashFingerprint(fingerprintSource || `card-${index}`);

  return {
    cardKey: jobId ? `job-${jobId}` : `fingerprint-${fingerprint}`,
    fingerprint,
    jobId,
    jobTitle,
    jobLink,
    jobSalaryText,
    jobArea,
    compName,
    hrName,
    buttonText: getLiepinChatButtonText(card),
  };
}

/**
 * 解析当前页面所有猎聘岗位卡片。
 *
 * @param root 页面文档或测试用根节点。
 * @returns 按页面顺序排列的岗位快照。
 */
export function parseLiepinJobCards(root: ParentNode = document): LiepinJobSnapshot[] {
  return Array.from(root.querySelectorAll(LIEPIN_SELECTORS.jobCards)).map(parseLiepinJobCard);
}

/**
 * 判断当前猎聘页面的登录状态。
 *
 * @param root 页面文档。
 * @returns true 为已登录，false 为明确未登录，null 为页面尚不能判断。
 */
export function detectLiepinLogin(root: ParentNode = document): boolean | null {
  if (LIEPIN_SELECTORS.loggedIn.some((selector) => isElementVisible(root.querySelector(selector)))) {
    return true;
  }
  if (LIEPIN_SELECTORS.loggedOut.some((selector) => isElementVisible(root.querySelector(selector)))) {
    return false;
  }
  return null;
}

/**
 * 生成当前标签页的猎聘上下文。
 *
 * @returns 侧边栏可直接展示的页面状态。
 */
export function inspectLiepinPage(): LiepinPageContext {
  const supported = location.hostname === "www.liepin.com" || location.hostname.endsWith(".liepin.com");
  return {
    supported,
    loggedIn: supported ? detectLiepinLogin() : null,
    url: location.href,
    jobs: supported ? parseLiepinJobCards() : [],
    issue: supported ? undefined : "当前标签页不是猎聘页面",
  };
}
