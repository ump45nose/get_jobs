/** 页内助手宿主的稳定标识，供幂等挂载和站点清理后的恢复使用。 */
export const EMBEDDED_PANEL_HOST_ID = "get-jobs-extension-panel";

/** 创建页内助手时需要的运行参数。 */
export interface EmbeddedPanelOptions {
  documentRef: Document;
  iframeUrl: string;
  initiallyOpen?: boolean;
}

/** 页内助手对 Content Script 暴露的最小控制接口。 */
export interface EmbeddedPanelController {
  host: HTMLElement;
  isOpen: () => boolean;
  setOpen: (open: boolean) => void;
  toggle: () => boolean;
  destroy: () => void;
}

const mountedControllers = new WeakMap<HTMLElement, EmbeddedPanelController>();

/**
 * 在猎聘页面创建样式隔离的固定抽屉，并用扩展 iframe 承载现有 React 界面。
 *
 * @param options 页面文档、扩展页面地址和初始显示状态。
 * @returns 可切换、查询和销毁抽屉的控制器。
 */
export function mountEmbeddedPanel(options: EmbeddedPanelOptions): EmbeddedPanelController {
  const { documentRef, iframeUrl, initiallyOpen = true } = options;
  const existingHost = documentRef.getElementById(EMBEDDED_PANEL_HOST_ID);
  if (existingHost) {
    const existingController = mountedControllers.get(existingHost);
    if (existingController) return existingController;
    // 清理无法复用的同名残留节点，避免创建两个可点击入口。
    existingHost.remove();
  }

  const host = documentRef.createElement("div");
  host.id = EMBEDDED_PANEL_HOST_ID;
  const shadow = host.attachShadow({ mode: "open" });
  const style = documentRef.createElement("style");
  style.textContent = `
    :host { all: initial; pointer-events: none; }
    *, *::before, *::after { box-sizing: border-box; }
    .launcher, .drawer { pointer-events: auto; }
    .launcher {
      position: fixed;
      right: 76px;
      bottom: 28px;
      z-index: 2147483645;
      display: inline-flex;
      align-items: center;
      gap: 8px;
      min-height: 44px;
      padding: 0 15px 0 10px;
      border: 1px solid rgba(255, 255, 255, 0.42);
      border-radius: 999px;
      color: #fff;
      background: linear-gradient(135deg, #ff7629, #e85a18);
      box-shadow: 0 10px 28px rgba(154, 62, 18, 0.32);
      font: 700 13px/1 system-ui, "Microsoft YaHei", sans-serif;
      letter-spacing: .01em;
      cursor: pointer;
      transition: transform .16s ease, box-shadow .16s ease, right .2s ease;
    }
    .launcher[data-open="true"] { right: min(462px, calc(100vw - 72px)); }
    .launcher:hover {
      transform: translateY(-2px);
      box-shadow: 0 13px 32px rgba(154, 62, 18, 0.4);
    }
    .launcher:focus-visible, .close:focus-visible {
      outline: 3px solid rgba(255, 118, 41, 0.3);
      outline-offset: 3px;
    }
    .mark {
      display: grid;
      width: 27px;
      height: 27px;
      place-items: center;
      border-radius: 50%;
      color: #e85a18;
      background: #fff;
      font-size: 12px;
      font-weight: 900;
    }
    .drawer {
      position: fixed;
      top: 14px;
      right: 14px;
      bottom: 14px;
      z-index: 2147483646;
      display: grid;
      width: min(430px, calc(100vw - 28px));
      grid-template-rows: 42px minmax(0, 1fr);
      overflow: hidden;
      border: 1px solid rgba(23, 32, 42, 0.16);
      border-radius: 16px;
      background: #f4f7f9;
      box-shadow: 0 22px 64px rgba(23, 32, 42, 0.3);
      font-family: Inter, "Microsoft YaHei", system-ui, sans-serif;
    }
    .drawer[hidden] { display: none; }
    .drawer-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 10px 0 14px;
      color: #fff;
      background: #17202a;
      user-select: none;
    }
    .drawer-title { font-size: 13px; font-weight: 800; letter-spacing: .02em; }
    .close {
      display: grid;
      width: 30px;
      height: 30px;
      place-items: center;
      border: 0;
      border-radius: 9px;
      color: #fff;
      background: rgba(255, 255, 255, 0.1);
      font: 700 20px/1 system-ui, sans-serif;
      cursor: pointer;
    }
    .close:hover { background: rgba(255, 255, 255, 0.2); }
    iframe {
      width: 100%;
      height: 100%;
      border: 0;
      background: #f4f7f9;
    }
    @media (max-width: 640px) {
      .launcher[data-open="true"] { display: none; }
      .drawer { inset: 8px; width: auto; border-radius: 12px; }
    }
  `;

  const launcher = documentRef.createElement("button");
  launcher.type = "button";
  launcher.className = "launcher";
  launcher.title = "打开 Get Jobs 猎聘投递助手";
  launcher.setAttribute("aria-label", "打开 Get Jobs 猎聘投递助手");
  const mark = documentRef.createElement("span");
  mark.className = "mark";
  mark.textContent = "GJ";
  const launcherText = documentRef.createElement("span");
  launcherText.textContent = "Get Jobs 助手";
  launcher.append(mark, launcherText);

  const drawer = documentRef.createElement("aside");
  drawer.className = "drawer";
  drawer.setAttribute("aria-label", "Get Jobs 猎聘投递助手");
  const header = documentRef.createElement("header");
  header.className = "drawer-header";
  const title = documentRef.createElement("span");
  title.className = "drawer-title";
  title.textContent = "Get Jobs · 猎聘投递助手";
  const closeButton = documentRef.createElement("button");
  closeButton.type = "button";
  closeButton.className = "close";
  closeButton.title = "收起助手（不会停止正在运行的任务）";
  closeButton.setAttribute("aria-label", "收起 Get Jobs 助手，不停止正在运行的任务");
  closeButton.textContent = "×";
  header.append(title, closeButton);

  const iframe = documentRef.createElement("iframe");
  iframe.title = "Get Jobs 猎聘投递助手主界面";
  iframe.setAttribute("loading", "eager");
  drawer.append(header, iframe);
  shadow.append(style, launcher, drawer);
  documentRef.documentElement.append(host);

  let open = false;

  /** 根据显示状态同步抽屉、入口无障碍属性和 iframe 懒加载。 */
  const setOpen = (nextOpen: boolean): void => {
    open = nextOpen;
    drawer.hidden = !open;
    launcher.dataset.open = String(open);
    launcher.setAttribute("aria-expanded", String(open));
    launcher.title = open ? "收起 Get Jobs 猎聘投递助手" : "打开 Get Jobs 猎聘投递助手";
    launcher.setAttribute("aria-label", launcher.title);
    if (open && !iframe.getAttribute("src")) {
      // 只有首次打开时才加载 React 页面，关闭后保留表单和批次内存状态。
      iframe.src = iframeUrl;
    }
  };

  /** 切换抽屉状态并返回切换后的值。 */
  const toggle = (): boolean => {
    setOpen(!open);
    return open;
  };

  const onLauncherClick = (): void => {
    toggle();
  };
  const onCloseClick = (): void => {
    setOpen(false);
    launcher.focus();
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape" && open) onCloseClick();
  };

  launcher.addEventListener("click", onLauncherClick);
  closeButton.addEventListener("click", onCloseClick);
  documentRef.addEventListener("keydown", onKeyDown);

  const controller: EmbeddedPanelController = {
    host,
    isOpen: () => open,
    setOpen,
    toggle,
    destroy: () => {
      launcher.removeEventListener("click", onLauncherClick);
      closeButton.removeEventListener("click", onCloseClick);
      documentRef.removeEventListener("keydown", onKeyDown);
      mountedControllers.delete(host);
      host.remove();
    },
  };
  mountedControllers.set(host, controller);
  setOpen(initiallyOpen);
  return controller;
}
