// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  findLiepinResumeConfirmationButton,
  waitForLiepinResumeConfirmationButton,
  waitForLiepinResumeConfirmationDialogToClose,
} from "./liepin-resume-dialog";

describe("猎聘附件简历确认弹窗", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("识别已选附件弹窗中的唯一立即投递按钮", () => {
    document.body.innerHTML = `
      <div role="dialog" class="ant-im-modal">
        <button type="button" class="ant-im-modal-close"></button>
        <h2>选择附件简历</h2>
        <p>招聘方将同时收到您的默认在线简历和附件简历</p>
        <label><input type="radio" checked />anthropic-resume-tem</label>
        <button type="button">预览</button>
        <button type="button" class="ant-im-btn-primary">立即投递</button>
      </div>
    `;

    const button = findLiepinResumeConfirmationButton();
    expect(button?.textContent).toBe("立即投递");
  });

  it("附件单选项未选中时拒绝点击立即投递", () => {
    document.body.innerHTML = `
      <div role="dialog" class="ant-im-modal">
        <h2>选择附件简历</h2>
        <label><input type="radio" />附件简历</label>
        <button type="button">立即投递</button>
      </div>
    `;

    expect(findLiepinResumeConfirmationButton()).toBeUndefined();
  });

  it("拒绝禁用按钮和近似文案，避免扩大自动点击范围", () => {
    document.body.innerHTML = `
      <div role="dialog" class="ant-im-modal">
        <p>选择附件简历</p>
        <input type="radio" checked />
        <button type="button" disabled>立即投递</button>
        <button type="button">立即投递附件</button>
      </div>
    `;

    expect(findLiepinResumeConfirmationButton()).toBeUndefined();
  });

  it("存在多个简历确认候选时拒绝自动选择", () => {
    document.body.innerHTML = `
      <div role="dialog"><p>选择附件简历</p><button type="button">立即投递</button></div>
      <div class="ant-modal-content"><p>招聘方将同时收到您的默认在线简历和附件简历</p><button type="button">立即投递</button></div>
    `;

    expect(findLiepinResumeConfirmationButton()).toBeUndefined();
  });

  it("识别没有 role 属性但带 ant-modal 类名的 Portal 弹窗", () => {
    document.body.innerHTML = `
      <div class="ant-modal-root">
        <div class="ant-modal-content">
          <h2>选择附件简历</h2>
          <div role="radio" aria-checked="true">简历-俞非康</div>
          <button type="button" class="ant-im-btn-primary">立即投递</button>
        </div>
      </div>
    `;

    expect(findLiepinResumeConfirmationButton()?.textContent).toBe("立即投递");
  });

  it("不把聊天窗口内的简历文字识别为确认弹窗", () => {
    document.body.innerHTML = `
      <div role="dialog" class="im-ui-basic-chat-modal">
        <p>这是我的简历</p>
        <button type="button">发送简历</button>
      </div>
    `;

    expect(findLiepinResumeConfirmationButton()).toBeUndefined();
  });

  it("等待 React Portal 延迟挂载后再返回立即投递按钮", async () => {
    const pending = waitForLiepinResumeConfirmationButton({ timeoutMilliseconds: 300 });
    window.setTimeout(() => {
      document.body.innerHTML = `
        <div role="dialog" class="ant-im-modal">
          <h2>选择附件简历</h2>
          <label class="ant-im-radio-wrapper ant-im-radio-wrapper-checked">
            <input type="radio" checked />简历-俞玮康
          </label>
          <button type="button">立即投递</button>
        </div>
      `;
    }, 10);

    expect((await pending)?.textContent).toBe("立即投递");
  });

  it("按钮重绘为可用状态后才结束串行等待", async () => {
    document.body.innerHTML = `
      <div role="dialog" class="ant-im-modal">
        <h2>选择附件简历</h2>
        <input type="radio" checked />
        <button type="button" disabled>立即投递</button>
      </div>
    `;
    const pending = waitForLiepinResumeConfirmationButton({ timeoutMilliseconds: 300 });
    window.setTimeout(() => {
      const oldButton = document.querySelector("button");
      const currentButton = document.createElement("button");
      currentButton.textContent = "立即投递";
      oldButton?.replaceWith(currentButton);
    }, 10);

    expect((await pending)?.textContent).toBe("立即投递");
  });

  it("等待确认弹窗从页面移除后再返回关闭成功", async () => {
    document.body.innerHTML = `
      <div role="dialog" class="ant-im-modal">
        <h2>选择附件简历</h2>
      </div>
    `;
    const pending = waitForLiepinResumeConfirmationDialogToClose({ timeoutMilliseconds: 300 });
    window.setTimeout(() => document.querySelector("[role='dialog']")?.remove(), 10);

    expect(await pending).toBe(true);
  });

  it("业务中止后即使按钮可见也不返回确认控件", async () => {
    document.body.innerHTML = `
      <div role="dialog" class="ant-im-modal">
        <h2>选择附件简历</h2>
        <input type="radio" checked />
        <button type="button">立即投递</button>
      </div>
    `;

    expect(await waitForLiepinResumeConfirmationButton({
      timeoutMilliseconds: 100,
      shouldAbort: () => true,
    })).toBeUndefined();
  });

  it("确认弹窗在超时内未关闭时返回 false 并保留现场", async () => {
    document.body.innerHTML = `
      <div role="dialog" class="ant-im-modal">
        <h2>选择附件简历</h2>
      </div>
    `;

    expect(await waitForLiepinResumeConfirmationDialogToClose({
      timeoutMilliseconds: 20,
      pollMilliseconds: 20,
    })).toBe(false);
    expect(document.querySelector("[role='dialog']")).not.toBeNull();
  });
});
