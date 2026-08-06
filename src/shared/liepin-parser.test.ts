// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  detectLiepinLogin,
  extractLiepinJobId,
  getLiepinChatButtonText,
  matchLiepinChatToJob,
  parseLiepinJobCards,
} from "./liepin-parser";

describe("猎聘岗位卡片解析", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("从埋点属性解析岗位字段和 jobId", () => {
    const tracking = encodeURIComponent(JSON.stringify({ jobId: "987654" }));
    document.body.innerHTML = `
      <div class="job-card-pc-container-v2" data-tlg-ext="${tracking}">
        <a class="job-title-box" href="https://www.liepin.com/job/987654">Java 工程师</a>
        <span class="company-name">示例科技</span>
        <span class="job-salary">20-30k</span>
        <span class="job-area">上海</span>
        <button>聊一聊</button>
      </div>
    `;

    const [job] = parseLiepinJobCards();
    expect(job.jobId).toBe("987654");
    expect(job.cardKey).toBe("job-987654");
    expect(job.jobTitle).toContain("Java 工程师");
    expect(job.compName).toBe("示例科技");
    expect(job.buttonText).toBe("聊一聊");
  });

  it("区分继续聊并可从链接兜底解析 jobId", () => {
    document.body.innerHTML = `
      <div class="job-card-pc-container">
        <a href="https://www.liepin.com/job/123456">产品经理</a>
        <button>继续聊</button>
      </div>
    `;
    const card = document.querySelector("div")!;
    expect(extractLiepinJobId(card)).toBe("123456");
    expect(getLiepinChatButtonText(card)).toBe("继续聊");
  });

  it("优先读取纯岗位标题，避免详情链接把薪资经验拼入标题", () => {
    document.body.innerHTML = `
      <div class="job-card-pc-container">
        <a data-nick="job-detail-job-info" href="https://www.liepin.com/job/123456">
          <span class="job-title">AIGC资深图像算法工程师【杭州】</span>
          <span>25-40k·15薪</span><span>5-10年</span><span>统招本科</span>
        </a>
        <span class="company-name">某杭州计算机软件公司</span>
        <button>聊一聊</button>
      </div>
    `;

    const [job] = parseLiepinJobCards();
    expect(job.jobTitle).toBe("AIGC资深图像算法工程师【杭州】");
  });

  it("优先使用明确的已登录和未登录元素", () => {
    document.body.innerHTML = '<div id="header-quick-menu-user-info">用户</div>';
    expect(detectLiepinLogin()).toBe(true);

    document.body.innerHTML = '<a id="header-quick-menu-login" href="/login">登录</a>';
    expect(detectLiepinLogin()).toBe(false);
  });

  it("使用核心岗位名和公司匹配省略地区后缀的聊天窗口", () => {
    const job = {
      cardKey: "job-1",
      fingerprint: "1",
      jobTitle: "大模型应用工程师【杭州-浦沿】",
      compName: "中控技术",
    };
    const chatText = "黄女士 中控技术·招聘专员 大模型应用工程师 硕士 3年以上";

    expect(matchLiepinChatToJob(chatText, job)).toBe(true);
    expect(matchLiepinChatToJob("其他公司 大模型应用工程师", job)).toBe(false);
  });

  it("保留岗位核心括号内容并继续支持完整标题匹配", () => {
    const job = {
      cardKey: "job-2",
      fingerprint: "2",
      jobTitle: "大模型Agent开发工程师（临床试验方向）【杭州】",
      compName: "示例医药",
    };

    expect(matchLiepinChatToJob("示例医药 大模型Agent开发工程师（临床试验方向）", job)).toBe(true);
    expect(matchLiepinChatToJob("示例医药 大模型Agent开发工程师", job)).toBe(false);
    expect(matchLiepinChatToJob("大模型Agent开发工程师（临床试验方向）【杭州】", job)).toBe(true);
  });

  it("兼容旧版本把薪资经验拼入标题的猎头岗位快照", () => {
    const job = {
      cardKey: "job-3",
      fingerprint: "3",
      jobTitle: "AIGC资深图像算法工程师【杭州】25-40k·15薪5-10年统招本科",
      compName: "某杭州计算机软件公司",
    };

    expect(matchLiepinChatToJob(
      "某杭州计算机软件公司 AIGC资深图像算法工程师",
      job,
    )).toBe(true);
    expect(matchLiepinChatToJob("其他公司 AIGC资深图像算法工程师", job)).toBe(false);
  });
});
