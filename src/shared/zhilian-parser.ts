import type { ZhilianExternalOutcome, ZhilianJobSnapshot } from "./types";

/** 智联搜索结果卡片的已知容器选择器，按稳定程度排序。 */
export const ZHILIAN_JOB_CARD_SELECTORS = [
  "div.joblist-box__item",
  ".joblist-box__item",
  "[class*='joblist-box__item']",
  ".job-list-panel .job-card",
  ".job-card",
] as const;

/** 智联申请按钮的已知选择器。 */
export const ZHILIAN_APPLY_BUTTON_SELECTORS = [
  "button.collect-and-apply__btn",
  "button[class*='collect-and-apply']",
] as const;

/** 智联新版左右分栏页面中，右侧岗位详情的稳定字段选择器。 */
export const ZHILIAN_DETAIL_SELECTORS = {
  title: ".job-detail-summary__title-text",
  salary: ".job-detail-summary__salary",
  company: ".job-detail-summary__company-name",
  applyButton: "button.job-detail-summary__apply",
} as const;

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

/** 规整可携带展示后缀的薪资文本，保留数值区间避免把不同薪资误判为相同。 */
function normalizeSalaryText(value: string | null | undefined): string {
  return normalizeText(value).toLowerCase().replace(/[\s·•]/g, "");
}

/** 判断详情节点及其祖先是否处于可见状态，排除 SPA 缓存的旧详情。 */
function isVisibleElement(element: HTMLElement): boolean {
  for (let current: HTMLElement | null = element; current; current = current.parentElement) {
    if (current.hidden || current.getAttribute("aria-hidden") === "true") return false;
    const style = current.ownerDocument.defaultView?.getComputedStyle(current);
    if (style?.display === "none" || style?.visibility === "hidden") return false;
  }
  return true;
}

/** 比较详情薪资与列表薪资，允许详情附加月数等展示说明。 */
function isCompatibleSalary(expected: string, actual: string): boolean {
  const normalizedExpected = normalizeSalaryText(expected);
  const normalizedActual = normalizeSalaryText(actual);
  return normalizedExpected === normalizedActual
    || normalizedActual.includes(normalizedExpected)
    || normalizedExpected.includes(normalizedActual);
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

/** 判断岗位标签是否属于学历要求。 */
function isEducationText(value: string): boolean {
  return /学历不限|不限学历|初中|高中|中专|大专|本科|硕士|博士/.test(value);
}

/** 判断岗位标签是否属于工作经验要求。 */
function isExperienceText(value: string): boolean {
  return /经验不限|不限经验|应届|在校|实习|无经验|\d+(?:-\d+)?年|[一二三四五六七八九十]+年/.test(value);
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
    const titleElement = card.querySelector<HTMLElement>(
      "a.jobinfo__name, a[class*='jobinfo__name'], .job-card__title-main",
    );
    const jobTitle = normalizeText(titleElement?.textContent);
    if (!jobTitle) return [];

    const rawLink = titleElement?.getAttribute("href") || undefined;
    const jobLink = rawLink ? new URL(rawLink, card.ownerDocument.baseURI).href : undefined;
    const jobId = extractZhilianJobId(jobLink);
    const otherItems = Array.from(card.querySelectorAll(".jobinfo__other-info-item"))
      .map((item) => normalizeText(item.textContent))
      .filter(Boolean);
    const skillTags = Array.from(card.querySelectorAll(".job-card__skill-tag"))
      .map((item) => normalizeText(item.textContent))
      .filter(Boolean);
    // 不使用 :nth-child()：卡片前置标题、薪资节点会改变全局子节点序号。
    const jobArea = readText(card, [".job-card__location"]) ?? otherItems[0];
    const jobExpReq = skillTags.find(isExperienceText) ?? otherItems[1];
    const jobEduReq = skillTags.find(isEducationText) ?? otherItems[2];
    const compName = readText(card, [
      ".companyinfo__name",
      "[class*='companyinfo__name']",
      ".job-card__company-name",
    ]);
    const jobSalaryText = readText(card, [
      ".jobinfo__salary",
      "[class*='jobinfo__salary']",
      ".job-card__salary",
    ]);
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

/**
 * 判断智联新版右侧详情是否已经绑定指定岗位。
 *
 * @param root 当前文档或详情容器。
 * @param job 待操作的岗位快照。
 * @returns 标题与已知公司都匹配时返回 true。
 */
function isZhilianDetailContainerBoundToJob(root: ParentNode, job: ZhilianJobSnapshot): boolean {
  const detailTitle = normalizeText(root.querySelector(ZHILIAN_DETAIL_SELECTORS.title)?.textContent);
  if (!detailTitle || detailTitle !== normalizeText(job.jobTitle)) return false;

  const detailCompany = normalizeText(root.querySelector(ZHILIAN_DETAIL_SELECTORS.company)?.textContent);
  if (job.compName && (!detailCompany || detailCompany !== normalizeText(job.compName))) return false;

  const detailSalary = normalizeText(root.querySelector(ZHILIAN_DETAIL_SELECTORS.salary)?.textContent);
  // 新版列表没有岗位 ID，因此已知薪资也必须一致，降低同公司同岗位名误绑定风险。
  return !job.jobSalaryText || (Boolean(detailSalary) && isCompatibleSalary(job.jobSalaryText, detailSalary));
}

/**
 * 找出当前可见的右侧详情容器，忽略 SPA 保留的隐藏旧节点。
 *
 * @param root 当前文档或测试容器。
 * @returns 每个可见详情区各一个容器；无标准容器时按详情标题向上回溯到申请按钮。
 */
export function findZhilianVisibleDetailContainers(root: ParentNode): HTMLElement[] {
  const directContainers = [
    ...(root instanceof HTMLElement && root.matches(".job-detail-summary") ? [root] : []),
    ...Array.from(root.querySelectorAll<HTMLElement>(".job-detail-summary")),
  ].filter(isVisibleElement);
  if (directContainers.length) return directContainers;

  const containers = new Set<HTMLElement>();
  for (const title of Array.from(root.querySelectorAll<HTMLElement>(ZHILIAN_DETAIL_SELECTORS.title))) {
    if (!isVisibleElement(title)) continue;
    let current = title.parentElement;
    while (current) {
      if (current.querySelector(ZHILIAN_DETAIL_SELECTORS.applyButton)) {
        containers.add(current);
        break;
      }
      if (current === root) break;
      current = current.parentElement;
    }
    // 兼容无申请按钮的静态详情，用于只读绑定校验。
    if (!current && title.parentElement) containers.add(title.parentElement);
  }
  return [...containers];
}

/**
 * 在可见详情容器中确认唯一属于目标岗位的详情区。
 *
 * @param root 当前文档或详情容器。
 * @param job 待操作的岗位快照。
 * @returns 唯一匹配的详情容器；无匹配或存在歧义时返回 null。
 */
export function findZhilianDetailContainerBoundToJob(
  root: ParentNode,
  job: ZhilianJobSnapshot,
): HTMLElement | null {
  const matches = findZhilianVisibleDetailContainers(root)
    .filter((container) => isZhilianDetailContainerBoundToJob(container, job));
  return matches.length === 1 ? matches[0] : null;
}

/**
 * 判断当前可见详情是否已经唯一绑定指定岗位。
 *
 * @param root 当前文档或详情容器。
 * @param job 待操作的岗位快照。
 * @returns 存在唯一匹配详情时返回 true。
 */
export function isZhilianDetailBoundToJob(root: ParentNode, job: ZhilianJobSnapshot): boolean {
  return Boolean(findZhilianDetailContainerBoundToJob(root, job));
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

/**
 * 判断重绘后的岗位快照是否仍指向同一个智联职位。
 *
 * 有岗位 ID 时优先使用 ID；新版列表页没有岗位 ID 时，使用由标题、公司、地区和薪资构成的
 * 指纹，避免把会随列表重排变化的 cardKey 下标当成业务身份。
 *
 * @param target 批次开始时冻结的目标岗位。
 * @param candidate 当前 DOM 重新解析出的候选岗位。
 * @returns 两个快照可安全视为同一职位时返回 true。
 */
export function isSameZhilianJob(
  target: ZhilianJobSnapshot,
  candidate: ZhilianJobSnapshot,
): boolean {
  if (target.jobId && candidate.jobId) return target.jobId === candidate.jobId;
  return target.fingerprint === candidate.fingerprint;
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
  if (["操作频繁", "访问频繁", "请求频繁", "稍后再试", "账号异常", "风险控制"].some((item) => normalized.includes(item))) {
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

/**
 * 只在智联专用 `/job-applied` 结果页读取全页正文回执。
 *
 * @param url 当前页面 URL。
 * @param bodyText 当前页面可见正文。
 * @returns 专用结果页中的明确结果；其它页面始终返回 unknown。
 */
export function detectZhilianAppliedPageOutcome(url: string, bodyText: string): ZhilianExternalOutcome {
  try {
    const parsed = new URL(url);
    if (!/(^|\.)zhaopin\.com$/i.test(parsed.hostname) || !/^\/job-applied\/?$/i.test(parsed.pathname)) {
      return { outcome: "unknown" };
    }
    return detectZhilianOutcomeFromText(bodyText);
  } catch {
    return { outcome: "unknown" };
  }
}
