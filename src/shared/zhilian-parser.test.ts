// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { detectZhilianOutcomeFromText, extractZhilianJobId, parseZhilianJobs } from "./zhilian-parser";

describe("parseZhilianJobs", () => {
  it("解析原版智联卡片结构并生成稳定键", () => {
    document.body.innerHTML = `
      <div class="joblist-box__item">
        <a class="jobinfo__name" href="/jobdetail/CC123.htm">AI Agent 工程师</a>
        <p class="jobinfo__salary">25-40K</p>
        <div class="jobinfo__other-info-item"><span>杭州</span></div>
        <div class="jobinfo__other-info-item">3-5年</div>
        <div class="jobinfo__other-info-item">本科</div>
        <div class="companyinfo__name">示例科技</div>
        <button class="collect-and-apply__btn">立即投递</button>
      </div>`;

    const jobs = parseZhilianJobs(document);

    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      cardKey: "zhilian:CC123",
      jobId: "CC123",
      jobTitle: "AI Agent 工程师",
      jobSalaryText: "25-40K",
      jobArea: "杭州",
      jobExpReq: "3-5年",
      jobEduReq: "本科",
      compName: "示例科技",
      buttonText: "立即投递",
    });
  });

  it("跳过缺少岗位名称的装饰卡片", () => {
    document.body.innerHTML = `<div class="joblist-box__item"><button>立即投递</button></div>`;
    expect(parseZhilianJobs(document)).toEqual([]);
  });
});

describe("detectZhilianOutcomeFromText", () => {
  it("只把明确成功文案识别为成功", () => {
    expect(detectZhilianOutcomeFromText("申请成功").outcome).toBe("success");
    expect(detectZhilianOutcomeFromText("正在申请，请稍候").outcome).toBe("unknown");
  });

  it("区分验证、额度和简历失败", () => {
    expect(detectZhilianOutcomeFromText("请完成滑块验证").outcome).toBe("blocked");
    expect(detectZhilianOutcomeFromText("今日投递次数已达上限").outcome).toBe("blocked");
    expect(detectZhilianOutcomeFromText("未设置默认简历").outcome).toBe("failed");
  });
});

describe("extractZhilianJobId", () => {
  it("兼容详情路径和查询参数", () => {
    expect(extractZhilianJobId("https://www.zhaopin.com/jobdetail/ABC.htm")).toBe("ABC");
    expect(extractZhilianJobId("https://sou.zhaopin.com/?jobId=XYZ")).toBe("XYZ");
  });
});
