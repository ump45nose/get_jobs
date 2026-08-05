import type { LiepinConfig, TaskState } from "./types";

/** 新安装插件使用的猎聘配置。 */
export const DEFAULT_LIEPIN_CONFIG: LiepinConfig = {
  keywords: [],
  cityCode: "",
  salary: "",
};

/**
 * 创建新的空闲任务状态。
 *
 * @param message 展示给用户的初始消息。
 * @returns 可直接持久化的任务状态。
 */
export function createIdleTask(message = "尚未开始投递"): TaskState {
  return {
    platform: "liepin",
    status: "idle",
    updatedAt: new Date().toISOString(),
    message,
  };
}

