/** 后台筛选智联结果页所需的最小标签信息。 */
export interface ZhilianTabCandidate {
  id?: number;
  url?: string;
  openerTabId?: number;
}

/** 规整智联岗位编号，便于链接路径和查询参数做稳定比较。 */
function normalizeJobId(value: string | undefined): string {
  return (value ?? "").trim().replace(/\.htm$/i, "").toLowerCase();
}

/**
 * 判断 URL 是否为与当前岗位匹配的智联投递成功结果页。
 *
 * @param url 待检查标签 URL。
 * @param expectedJobId 当前任务岗位编号；缺失时只校验专用结果路径。
 * @returns 路径和岗位编号均匹配时返回 true。
 */
export function isMatchingZhilianAppliedUrl(url: string | undefined, expectedJobId?: string): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    if (!/(^|\.)zhaopin\.com$/i.test(parsed.hostname)) return false;
    if (!/^\/job-applied\/?$/i.test(parsed.pathname)) return false;
    const normalizedExpected = normalizeJobId(expectedJobId);
    if (!normalizedExpected) return true;
    return normalizeJobId(parsed.searchParams.get("number") ?? undefined) === normalizedExpected;
  } catch {
    return false;
  }
}

/**
 * 从点击后标签集合中筛出本次新增且岗位匹配的结果页。
 *
 * @param tabs 浏览器当前全部标签。
 * @param sourceTabId 原岗位列表标签 ID。
 * @param knownTabIds 点击“立即投递”前已存在的标签 ID。
 * @param expectedJobId 当前任务岗位编号。
 * @returns 零个、一个或多个安全候选；调用方对多候选执行熔断。
 */
export function findNewZhilianAppliedTabs(
  tabs: readonly ZhilianTabCandidate[],
  sourceTabId: number,
  knownTabIds: readonly number[],
  expectedJobId?: string,
): ZhilianTabCandidate[] {
  return tabs.filter((tab) => tab.id !== undefined
    && tab.id !== sourceTabId
    && !knownTabIds.includes(tab.id)
    && isMatchingZhilianAppliedUrl(tab.url, expectedJobId));
}
