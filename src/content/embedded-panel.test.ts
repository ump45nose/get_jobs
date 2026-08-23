// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import {
  EMBEDDED_PANEL_HOST_ID,
  mountEmbeddedPanel,
  type EmbeddedPanelController,
  type EmbeddedPanelOptions,
} from "./embedded-panel";

const mountedForTest = new Set<EmbeddedPanelController>();

/** 挂载测试实例并登记清理，确保文档级键盘监听不会泄漏到后续用例。 */
function mountForTest(options: EmbeddedPanelOptions): EmbeddedPanelController {
  const controller = mountEmbeddedPanel(options);
  mountedForTest.add(controller);
  return controller;
}

/** 每个用例后恢复干净页面，避免 Shadow DOM 宿主影响其他测试。 */
afterEach(() => {
  mountedForTest.forEach((controller) => controller.destroy());
  mountedForTest.clear();
  document.getElementById(EMBEDDED_PANEL_HOST_ID)?.remove();
});

describe("猎聘首页注入式主界面", () => {
  it("首次打开时加载扩展页面并支持入口和关闭按钮切换", () => {
    const controller = mountForTest({
      documentRef: document,
      iframeUrl: "chrome-extension://test/sidepanel.html?embedded=1",
    });
    const shadow = controller.host.shadowRoot!;
    const launcher = shadow.querySelector<HTMLButtonElement>(".launcher")!;
    const drawer = shadow.querySelector<HTMLElement>(".drawer")!;
    const iframe = shadow.querySelector<HTMLIFrameElement>("iframe")!;
    const styleText = shadow.querySelector("style")?.textContent ?? "";

    expect(controller.isOpen()).toBe(true);
    expect(drawer.hidden).toBe(false);
    expect(iframe.getAttribute("src")).toBe("chrome-extension://test/sidepanel.html?embedded=1");
    expect(styleText).toContain("width: min(520px");
    expect(styleText).toContain("right: min(552px");

    launcher.click();
    expect(controller.isOpen()).toBe(false);
    expect(drawer.hidden).toBe(true);

    launcher.click();
    shadow.querySelector<HTMLButtonElement>(".close")!.click();
    expect(controller.isOpen()).toBe(false);
  });

  it("关闭状态不提前加载 iframe，并可通过 Escape 收起", () => {
    const controller = mountForTest({
      documentRef: document,
      iframeUrl: "chrome-extension://test/sidepanel.html?embedded=1",
      initiallyOpen: false,
    });
    const iframe = controller.host.shadowRoot!.querySelector<HTMLIFrameElement>("iframe")!;
    expect(iframe.getAttribute("src")).toBeNull();

    controller.setOpen(true);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(controller.isOpen()).toBe(false);
    expect(iframe.getAttribute("src")).toContain("sidepanel.html");
  });

  it("重复挂载复用同一控制器，销毁后清理宿主", () => {
    const first = mountForTest({ documentRef: document, iframeUrl: "chrome-extension://test/panel" });
    const second = mountForTest({ documentRef: document, iframeUrl: "chrome-extension://test/panel" });
    expect(second).toBe(first);
    expect(document.querySelectorAll(`#${EMBEDDED_PANEL_HOST_ID}`)).toHaveLength(1);

    first.destroy();
    expect(document.getElementById(EMBEDDED_PANEL_HOST_ID)).toBeNull();
  });
});
