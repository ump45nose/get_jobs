// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { findZhilianSuccessCloseButton } from "./zhilian-success-dialog";

describe("智联成功页面关闭", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("仅从明确成功弹窗返回唯一关闭控件", () => {
    document.body.innerHTML = `
      <div role="dialog"><p>投递成功</p><button aria-label="关闭"></button></div>
      <div class="notice">申请失败 <button>关闭</button></div>
    `;
    expect(findZhilianSuccessCloseButton(document)?.getAttribute("aria-label")).toBe("关闭");
  });

  it("失败、未知或多个成功弹窗时拒绝关闭", () => {
    document.body.innerHTML = `<div role="dialog"><p>投递失败</p><button>关闭</button></div>`;
    expect(findZhilianSuccessCloseButton(document)).toBeNull();

    document.body.innerHTML = `
      <div role="dialog"><p>投递成功</p><button>关闭</button></div>
      <div role="dialog"><p>申请成功</p><button>关闭</button></div>
    `;
    expect(findZhilianSuccessCloseButton(document)).toBeNull();
  });
});
