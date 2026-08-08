import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { ZhilianApp } from "./ZhilianApp";
import "./styles.css";

/** 按 iframe 查询参数挂载当前招聘平台的助手主界面。 */
const platform = new URLSearchParams(window.location.search).get("platform");
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {platform === "zhilian" ? <ZhilianApp /> : <App />}
  </React.StrictMode>,
);
