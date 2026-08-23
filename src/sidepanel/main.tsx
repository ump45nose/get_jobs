import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { ZhilianApp } from "./ZhilianApp";
import "./styles.css";

/** 按 iframe 查询参数挂载当前招聘平台的助手主界面；未知平台必须显式拒绝。 */
const platform = new URLSearchParams(window.location.search).get("platform") ?? "liepin";
const root = document.getElementById("root");
if (!root) throw new Error("扩展页面缺少根节点");
if (platform !== "liepin" && platform !== "zhilian") {
  root.textContent = "不支持的招聘平台入口";
  throw new Error(`不支持的平台入口: ${platform}`);
}
ReactDOM.createRoot(root).render(
  <React.StrictMode>
    {platform === "zhilian" ? <ZhilianApp /> : <App />}
  </React.StrictMode>,
);
