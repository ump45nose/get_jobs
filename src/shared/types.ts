/** 猎聘插件当前支持的配置。 */
export interface LiepinConfig {
  keywords: string[];
  cityCode: string;
  salary: string;
}

/** 从猎聘岗位卡片中提取的稳定业务字段。 */
export interface LiepinJobSnapshot {
  cardKey: string;
  fingerprint: string;
  jobId?: string;
  jobTitle: string;
  jobLink?: string;
  jobSalaryText?: string;
  jobArea?: string;
  jobEduReq?: string;
  jobExpReq?: string;
  jobPublishTime?: string;
  compName?: string;
  compIndustry?: string;
  compScale?: string;
  hrName?: string;
  hrTitle?: string;
  buttonText?: string;
}

/** 内容脚本对当前猎聘页面的识别结果。 */
export interface LiepinPageContext {
  supported: boolean;
  loggedIn: boolean | null;
  url: string;
  jobs: LiepinJobSnapshot[];
  issue?: string;
}

/** 单岗位投递的业务结果，避免把“已联系”误计为新投递。 */
export type DeliveryOutcome =
  | "delivered"
  | "already-contacted"
  | "cancelled"
  | "blocked"
  | "failed";

/** 单岗位投递完成后返回给侧边栏的结果。 */
export interface DeliveryResult {
  outcome: DeliveryOutcome;
  message: string;
  job: LiepinJobSnapshot;
  evidence?: string;
}

/** 持久化的投递尝试记录。 */
export interface DeliveryAttempt extends DeliveryResult {
  id?: number;
  taskId: string;
  platform: "liepin";
  createdAt: string;
}

/** MV3 后台可恢复的任务状态。 */
export type TaskStatus =
  | "idle"
  | "running"
  | "stopping"
  | "success"
  | "cancelled"
  | "blocked"
  | "failed"
  | "interrupted";

/** 持久化任务状态，不依赖 Service Worker 的内存生命周期。 */
export interface TaskState {
  platform: "liepin";
  status: TaskStatus;
  taskId?: string;
  tabId?: number;
  cardKey?: string;
  jobId?: string;
  startedAt?: string;
  updatedAt: string;
  message: string;
}

/** 侧边栏初始化时一次性读取的应用状态。 */
export interface AppState {
  config: LiepinConfig;
  task: TaskState;
  attempts: DeliveryAttempt[];
}

/** 发送给 Content Script 的消息。 */
export type ContentRequest =
  | { type: "INSPECT_LIEPIN" }
  | { type: "APPLY_LIEPIN_JOB"; taskId: string; cardKey: string }
  | { type: "STOP_LIEPIN_TASK"; taskId: string };

/** 发送给 Service Worker 的消息。 */
export type BackgroundRequest =
  | { type: "GET_APP_STATE" }
  | { type: "SAVE_LIEPIN_CONFIG"; config: LiepinConfig }
  | { type: "START_LIEPIN_TASK"; tabId: number; job: LiepinJobSnapshot }
  | { type: "REQUEST_LIEPIN_STOP"; taskId: string }
  | { type: "FINALIZE_LIEPIN_STOP"; taskId: string }
  | { type: "FAIL_LIEPIN_TASK"; taskId: string; message: string }
  | { type: "RECORD_LIEPIN_ATTEMPT"; taskId: string; result: DeliveryResult }
  | { type: "CONTENT_READY" };

/** 跨插件上下文统一使用的消息响应。 */
export interface ExtensionResponse<T> {
  ok: boolean;
  data?: T;
  error?: string;
}
