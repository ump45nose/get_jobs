/** OpenAI 兼容接口与投递行为配置。 */
export interface LiepinAiConfig {
  baseUrl: string;
  model: string;
  timeoutSeconds: number;
  resumeSummary: string;
  promptTemplate: string;
  useFallbackGreeting: boolean;
  fallbackGreeting: string;
  detailedLogging: boolean;
  previewBeforeSend: boolean;
  sendResume: boolean;
}

/** 当前页顺序投递的随机间隔配置。 */
export interface LiepinBatchConfig {
  minIntervalSeconds: number;
  maxIntervalSeconds: number;
  minActionIntervalSeconds: number;
  maxActionIntervalSeconds: number;
  /** 点击确认发送简历后，等待聊天回执的最长时间。 */
  resumeReceiptTimeoutSeconds: number;
  maxBatchSize: number;
  maxDailyDeliveries: number;
  cooldownEvery: number;
  cooldownSeconds: number;
}

/** 猎聘插件当前支持的配置。 */
export interface LiepinConfig {
  keywords: string[];
  cityCode: string;
  salary: string;
  ai: LiepinAiConfig;
  batch: LiepinBatchConfig;
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

/** 单个投递阶段的状态。 */
export type DeliveryStepStatus = "success" | "failed" | "skipped" | "unknown";

/** 沟通、招呼消息或简历发送阶段的独立结果。 */
export interface DeliveryStepResult {
  status: DeliveryStepStatus;
  message: string;
  evidence?: string;
}

/** 单岗位页面投递的可审计阶段日志，内容只允许保存脱敏状态和计数。 */
export interface DeliveryLogEntry {
  at: string;
  phase: "task" | "communication" | "greeting" | "resume";
  event: string;
  message: string;
  details?: Record<string, string | number | boolean | null>;
}

/** 完整投递链路的分阶段回执。 */
export interface DeliverySteps {
  communication: DeliveryStepResult;
  greeting?: DeliveryStepResult;
  resume?: DeliveryStepResult;
}

/** 单岗位投递完成后返回给助手界面的结果。 */
export interface DeliveryResult {
  outcome: DeliveryOutcome;
  message: string;
  job: LiepinJobSnapshot;
  evidence?: string;
  steps?: DeliverySteps;
  /** 页面动作与平台回执的脱敏时间线，便于分析“需处理”原因。 */
  logs?: DeliveryLogEntry[];
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

/** 持久化的投递节奏状态，用于跨助手实例和后台休眠维持安全配额。 */
export interface LiepinSafetyState {
  dayKey: string;
  dailyDeliveries: number;
  consecutiveDeliveries: number;
  cooldownUntil?: string;
  updatedAt: string;
}

/** 助手界面和任务启动前使用的账号安全状态。 */
export interface LiepinSafetyStatus extends LiepinSafetyState {
  remainingDailyDeliveries: number;
  cooldownRemainingSeconds: number;
  blockedReason?: string;
}

/** 助手界面初始化时一次性读取的应用状态。 */
export interface AppState {
  config: LiepinConfig;
  aiApiKeyConfigured: boolean;
  task: TaskState;
  attempts: DeliveryAttempt[];
  safety: LiepinSafetyStatus;
}

/** 配置保存完成后的后台确认结果。 */
export interface SavedLiepinConfig {
  config: LiepinConfig;
  aiApiKeyConfigured: boolean;
}

/** AI 生成完成后返回给助手界面的可编辑草稿。 */
export interface GreetingDraft {
  text: string;
  source: "ai" | "fallback";
  warning?: string;
}

/** 单次 AI POST 请求的脱敏诊断记录。 */
export interface AiDiagnosticLog {
  id: string;
  createdAt: string;
  phase: "generate" | "compress";
  endpoint: string;
  model: string;
  timeoutSeconds: number;
  durationMs: number;
  detailed: boolean;
  request: {
    method: "POST";
    headers: Record<string, string>;
    messageCharacters: Array<{ role: "system" | "user"; characters: number }>;
    body?: string;
  };
  response?: {
    status: number;
    statusText: string;
    contentType: string;
    body?: string;
  };
  outcome: "success" | "http-error" | "network-error" | "timeout" | "invalid-response";
  error?: string;
}

/** 发送给 Content Script 的消息。 */
export type ContentRequest =
  | { type: "INSPECT_LIEPIN" }
  | { type: "TOGGLE_EMBEDDED_PANEL" }
  | {
      type: "APPLY_LIEPIN_JOB";
      taskId: string;
      cardKey: string;
      greetingText: string;
      sendResume: boolean;
      actionInterval: Pick<LiepinBatchConfig, "minActionIntervalSeconds" | "maxActionIntervalSeconds" | "resumeReceiptTimeoutSeconds">;
    }
  | { type: "STOP_LIEPIN_TASK"; taskId: string };

/** 发送给 Service Worker 的消息。 */
export type BackgroundRequest =
  | { type: "GET_APP_STATE" }
  | { type: "GET_LIEPIN_SAFETY_STATUS" }
  | { type: "SAVE_LIEPIN_CONFIG"; config: LiepinConfig; apiKey?: string }
  | { type: "CLEAR_LIEPIN_AI_KEY" }
  | { type: "GET_LIEPIN_AI_DIAGNOSTICS" }
  | { type: "CLEAR_LIEPIN_AI_DIAGNOSTICS" }
  | { type: "GENERATE_LIEPIN_GREETING"; job: LiepinJobSnapshot }
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
