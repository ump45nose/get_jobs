import { describe, expect, it } from "vitest";
import {
  findNewZhilianAppliedTabs,
  isMatchingZhilianAppliedUrl,
} from "./zhilian-external-tab";

describe("智联跨标签成功页归因", () => {
  it("识别没有 openerTabId 的新 job-applied 标签", () => {
    const tabs = findNewZhilianAppliedTabs([
      { id: 10, url: "https://www.zhaopin.com/recommend" },
      { id: 11, url: "https://www.zhaopin.com/job-applied?number=ABC123" },
    ], 10, [], "ABC123");
    expect(tabs.map((tab) => tab.id)).toEqual([11]);
  });

  it("忽略点击前旧结果页和其它岗位结果页", () => {
    const tabs = findNewZhilianAppliedTabs([
      { id: 11, url: "https://www.zhaopin.com/job-applied?number=ABC123" },
      { id: 12, url: "https://www.zhaopin.com/job-applied?number=OTHER" },
    ], 10, [11], "ABC123");
    expect(tabs).toEqual([]);
  });

  it("拒绝普通智联页面和非智联伪结果页", () => {
    expect(isMatchingZhilianAppliedUrl("https://www.zhaopin.com/recommend", "ABC")).toBe(false);
    expect(isMatchingZhilianAppliedUrl("https://example.com/job-applied?number=ABC", "ABC")).toBe(false);
  });

  it("保留多个同岗位新结果供调用方熔断", () => {
    const tabs = findNewZhilianAppliedTabs([
      { id: 11, url: "https://www.zhaopin.com/job-applied?number=ABC" },
      { id: 12, url: "https://www.zhaopin.com/job-applied?number=ABC" },
    ], 10, [], "ABC");
    expect(tabs).toHaveLength(2);
  });
});
