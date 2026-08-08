// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_ZHILIAN_CONFIG } from "./defaults";
import {
  findZhilianResumeDialog,
  findZhilianSuccessCloseButton,
} from "./zhilian-resume-dialog";

describe("智联简历选择与成功关闭", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("默认唯一选择附件 PDF 而不是已选中的在线简历", () => {
    document.body.innerHTML = `
      <div role="dialog">
        <h2>请选择要投递的简历</h2>
        <label><input type="radio" name="resume" checked />在线简历</label>
        <label><input type="radio" name="resume" />简历-俞玮康.pdf <small>2026.08.08 上传</small></label>
        <label><input type="checkbox" />每次投递默认发送该简历</label>
        <button type="button">投递简历</button>
      </div>
    `;

    const actions = findZhilianResumeDialog(document, DEFAULT_ZHILIAN_CONFIG);
    expect(actions?.selectedResumeText).toContain("简历-俞玮康.pdf");
    expect(actions?.resumeControl.textContent).toContain("简历-俞玮康.pdf");
    expect(actions?.submitButton.textContent).toBe("投递简历");
  });

  it("多个附件未配置名称时拒绝猜测", () => {
    document.body.innerHTML = `
      <div role="dialog">
        <p>请选择要投递的简历</p>
        <label><input type="radio" />简历-A.pdf</label>
        <label><input type="radio" />简历-B.pdf</label>
        <button type="button">投递简历</button>
      </div>
    `;
    expect(() => findZhilianResumeDialog(document, DEFAULT_ZHILIAN_CONFIG)).toThrow("未唯一匹配唯一附件简历");
  });

  it("按配置名称唯一选择附件", () => {
    document.body.innerHTML = `
      <div class="resume-dialog">
        <p>请选择要投递的简历</p>
        <label><input type="radio" />简历-A.pdf</label>
        <label><input type="radio" />简历-俞玮康.pdf</label>
        <button type="button">投递简历</button>
      </div>
    `;
    const actions = findZhilianResumeDialog(document, {
      ...DEFAULT_ZHILIAN_CONFIG,
      preferredResumeName: "俞玮康",
    });
    expect(actions?.selectedResumeText).toContain("俞玮康");
  });

  it("不操作账户级默认复选框且拒绝近似提交文案", () => {
    document.body.innerHTML = `
      <div role="dialog">
        <p>请选择要投递的简历</p>
        <label><input type="radio" />附件简历.pdf</label>
        <label><input type="checkbox" checked />每次投递默认发送该简历</label>
        <button type="button">确认投递简历</button>
      </div>
    `;
    expect(() => findZhilianResumeDialog(document, DEFAULT_ZHILIAN_CONFIG)).toThrow("未找到唯一可用");
  });

  it("仅从明确成功弹窗返回唯一关闭控件", () => {
    document.body.innerHTML = `
      <div role="dialog"><p>投递成功</p><button aria-label="关闭"></button></div>
      <div class="notice">申请失败 <button>关闭</button></div>
    `;
    expect(findZhilianSuccessCloseButton(document)?.getAttribute("aria-label")).toBe("关闭");
  });
});
