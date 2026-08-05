// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  detectLiepinLogin,
  extractLiepinJobId,
  getLiepinChatButtonText,
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

  it("优先使用明确的已登录和未登录元素", () => {
    document.body.innerHTML = '<div id="header-quick-menu-user-info">用户</div>';
    expect(detectLiepinLogin()).toBe(true);

    document.body.innerHTML = '<a id="header-quick-menu-login" href="/login">登录</a>';
    expect(detectLiepinLogin()).toBe(false);
  });
});

