import type { ZhilianExternalOutcome, ZhilianJobSnapshot } from "./types";

/** 智联搜索结果卡片的已知容器选择器，按稳定程度排序。 */
export const ZHILIAN_JOB_CARD_SELECTORS = [
  "div.joblist-box__item",
  ".joblist-box__item",
  "[class*='joblist-box__item']",
] as const;

/** 智联申请按钮的已知选择器。 */
export const ZHILIAN_APPLY_BUTTON_SELECTORS = [
  "button.collect-and-apply__btn",
  "button[class*='collect-and-apply']",
] as const;

/** 只读取当前申请工作流、对话框和短消息，避免全页其它岗位文本造成误判。 */
export const ZHILIAN_OUTCOME_SCOPE_SELECTORS = [
  ".a-job-apply-workflow",
  ".deliver-dialog",
  "[role='dialog']",
  ".ant-message",
  ".el-message",
  "[class*='toast']",
] as const;

/** 规整页面文本，便于跨 DOM 版本比较。 */
function normalizeText(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

/**
 * 依据智联顶部账号区判断登录状态。
 *
 * @param root 当前智联文档或测试容器。
 * @returns 存在账号强证据时返回 true，仅存在明确登录入口时返回 false，否则返回 null。
 */
export function detectZhilianLoginState(root: ParentNode): boolean | null {
  const accountRoot = root.querySelector(".home-header__c-login");
  if (accountRoot) {
    const accountText = normalizeText(accountRoot.textContent);
    const accountTopText = normalizeText(accountRoot.querySelector(".c-login__top")?.textContent);
    const hasAvatar = Boolean(accountRoot.querySelector("img.c-login__top__img, .c-login__top__photo img, img[alt='avatar']"));
    const hasAccountMenu = accountText.includes("个人中心")
      && accountText.includes("我的简历")
      && accountText.includes("退出");
    const hasNamedAccount = Boolean(accountTopText)
      && !/^(登录|登录\/注册|注册\/登录)$/.test(accountTopText);
    // 头像+账号名或完整账号菜单都属于已登录强证据，优先级高于隐藏登录入口。
    if ((hasAvatar && hasNamedAccount) || hasAccountMenu) return true;
  }

  const headerRoot = root.querySelector("#right_nav_header, header.home-header, .home-header");
  if (!headerRoot) return null;
  const loginElement = Array.from(headerRoot.querySelectorAll("a, button"))
    .find((element) => /^(登录|登录\/注册|注册\/登录)$/.test(normalizeText(element.textContent)));
  return loginElement ? false : null;
}

/** 从链接中提取智联岗位 ID；无法识别时返回空值。 */
export function extractZhilianJobId(link: string | undefined): string | undefined {
  if (!link) return undefined;
  const patterns = [/\/jobdetail\/([^/?#]+)\.htm/i, /[?&](?:jobId|positionId)=([^&#]+)/i];
  for (const pattern of patterns) {
    const matched = link.match(pattern)?.[1];
    if (matched) return decodeURIComponent(matched);
  }
  return undefined;
}

/** 生成无需加密但稳定的岗位指纹，避免页面重排后仅依赖数组下标。 */
function createFingerprint(parts: Array<string | undefined>): string {
  const source = parts.map(normalizeText).join("|").toLowerCase();
  let hash = 5381;
  for (let index = 0; index < source.length; index += 1) {
    hash = ((hash << 5) + hash) ^ source.charCodeAt(index);
  }
  return (hash >>> 0).toString(36);
}

/** 返回第一个有文本的子节点内容。 */
function readText(root: ParentNode, selectors: readonly string[]): string | undefined {
  for (const selector of selectors) {
    const text = normalizeText(root.querySelector(selector)?.textContent);
    if (text) return text;
  }
  return undefined;
}

/** 返回首个岗位卡片选择器命中的去重节点。 */
export function findZhilianJobCards(root: ParentNode): Element[] {
  for (const selector of ZHILIAN_JOB_CARD_SELECTORS) {
    const cards = Array.from(root.querySelectorAll(selector));
    if (cards.length) return cards;
  }
  return [];
}

/** 从智联搜索结果 DOM 中解析当前可见岗位快照。 */
export function parseZhilianJobs(root: ParentNode): ZhilianJobSnapshot[] {
  return findZhilianJobCards(root).flatMap((card, index) => {
    const titleLink = card.querySelector<HTMLAnchorElement>("a.jobinfo__name, a[class*='jobinfo__name']");
    const jobTitle = normalizeText(titleLink?.textContent);
    if (!jobTitle) return [];

    const rawLink = titleLink?.getAttribute("href") || undefined;
    const jobLink = rawLink ? new URL(rawLink, card.ownerDocument.baseURI).href : undefined;
    const jobId = extractZhilianJobId(jobLink);
    const otherItems = Array.from(card.querySelectorAll(".jobinfo__other-info-item"))
      .map((item) => normalizeText(item.textContent))
      .filter(Boolean);
    // 不使用 :nth-child()：卡片前置标题、薪资节点会改变全局子节点序号。
    const jobArea = otherItems[0];
    const jobExpReq = otherItems[1];
    const jobEduReq = otherItems[2];
    const compName = readText(card, [".companyinfo__name", "[class*='companyinfo__name']"]);
    const jobSalaryText = readText(card, [".jobinfo__salary", "[class*='jobinfo__salary']"]);
    const buttonText = readText(card, ZHILIAN_APPLY_BUTTON_SELECTORS);
    const fingerprint = createFingerprint([jobId, jobTitle, compName, jobArea, jobSalaryText]);

    return [{
      cardKey: jobId ? `zhilian:${jobId}` : `zhilian:${fingerprint}:${index}`,
      fingerprint,
      jobId,
      jobTitle,
      jobLink,
      jobSalaryText,
      jobArea,
      jobEduReq,
      jobExpReq,
      compName,
      buttonText,
    }];
  });
}

/** 解析单个已定位的智联岗位卡片，供动作前再次按稳定键核对。 */
export function parseZhilianJobCard(card: Element, index: number): ZhilianJobSnapshot | undefined {
  const owner = card.ownerDocument;
  const container = owner.createElement("div");
  container.append(card.cloneNode(true));
  const job = parseZhilianJobs(container)[0];
  if (!job) return undefined;
  // 无岗位 ID 时，恢复页面原下标参与 cardKey，避免克隆容器把所有下标重置为 0。
  return job.jobId ? job : { ...job, cardKey: `zhilian:${job.fingerprint}:${index}` };
}

/** 从智联申请结果文本中识别明确状态；没有证据时必须返回 unknown。 */
export function detectZhilianOutcomeFromText(text: string): ZhilianExternalOutcome {
  const normalized = normalizeText(text);
  if (!normalized) return { outcome: "unknown" };
  if (["今日投递次数已达上限", "次数已达上限", "投递数量已达", "达到上限"].some((item) => normalized.includes(item))) {
    return { outcome: "blocked", evidence: normalized };
  }
  if (["滑块验证", "安全验证", "人机验证", "请完成验证", "验证码"].some((item) => normalized.includes(item))) {
    return { outcome: "blocked", evidence: normalized };
  }
  if (["申请成功", "投递成功"].some((item) => normalized.includes(item))) {
    return { outcome: "success", evidence: normalized };
  }
  if (["申请失败", "投递失败", "未设置默认简历", "请先完善简历", "暂不支持投递"].some((item) => normalized.includes(item))) {
    return { outcome: "failed", evidence: normalized };
  }
  return { outcome: "unknown" };
}
