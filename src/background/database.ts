import type {
  DeliveryAttempt,
  LiepinJobSnapshot,
  ZhilianDeliveryAttempt,
  ZhilianJobSnapshot,
} from "../shared/types";

const DATABASE_NAME = "get-jobs-extension";
const DATABASE_VERSION = 1;
const JOB_STORE = "jobs";
const ATTEMPT_STORE = "attempts";

interface StoredJob extends LiepinJobSnapshot {
  key: string;
  lastOutcome: DeliveryAttempt["outcome"];
  updatedAt: string;
}

type AnyDeliveryAttempt = DeliveryAttempt | ZhilianDeliveryAttempt;
type AnyJobSnapshot = LiepinJobSnapshot | ZhilianJobSnapshot;

/** 将任一平台尝试写入共享但按 platform 分键的对象仓库。 */
async function savePlatformDeliveryAttempt(attempt: AnyDeliveryAttempt): Promise<void> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction([JOB_STORE, ATTEMPT_STORE], "readwrite");
    const completed = waitForTransaction(transaction);
    const key = `${attempt.platform}:${attempt.job.jobId ?? attempt.job.fingerprint}`;
    const storedJob = {
      ...attempt.job,
      key,
      lastOutcome: attempt.outcome,
      updatedAt: attempt.createdAt,
    } satisfies AnyJobSnapshot & { key: string; lastOutcome: string; updatedAt: string };
    transaction.objectStore(JOB_STORE).put(storedJob);
    // 同一任务只允许一条审计记录；重复消息会覆盖该记录而不会重复消耗额度或膨胀历史。
    transaction.objectStore(ATTEMPT_STORE).put({
      ...attempt,
      id: `${attempt.platform}:${attempt.taskId}`,
    });
    await completed;
  } finally {
    database.close();
  }
}

/**
 * 打开并按版本初始化插件数据库。
 *
 * @returns IndexedDB 数据库连接。
 */
function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onerror = () => reject(request.error ?? new Error("打开 IndexedDB 失败"));
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(JOB_STORE)) {
        database.createObjectStore(JOB_STORE, { keyPath: "key" });
      }
      if (!database.objectStoreNames.contains(ATTEMPT_STORE)) {
        const attempts = database.createObjectStore(ATTEMPT_STORE, {
          keyPath: "id",
          autoIncrement: true,
        });
        attempts.createIndex("createdAt", "createdAt");
      }
    };
    request.onsuccess = () => resolve(request.result);
  });
}

/**
 * 等待 IndexedDB 事务完成并统一处理失败。
 *
 * @param transaction 待等待事务。
 * @returns 事务成功时完成。
 */
function waitForTransaction(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB 事务失败"));
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB 事务已中止"));
  });
}

/**
 * 写入一次投递结果，并同步更新岗位最后状态。
 *
 * @param attempt 已完成的投递尝试。
 * @returns 写入完成时返回。
 */
export async function saveDeliveryAttempt(attempt: DeliveryAttempt): Promise<void> {
  await savePlatformDeliveryAttempt(attempt);
}

/** 写入一次智联申请结果，并使用 `zhilian:` 前缀隔离岗位状态。 */
export async function saveZhilianDeliveryAttempt(attempt: ZhilianDeliveryAttempt): Promise<void> {
  await savePlatformDeliveryAttempt(attempt);
}

/**
 * 读取最近的投递记录。
 *
 * @param limit 最大返回数量。
 * @returns 按时间倒序排列的投递尝试。
 */
export async function listRecentAttempts(limit = 20): Promise<DeliveryAttempt[]> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(ATTEMPT_STORE, "readonly");
    const completed = waitForTransaction(transaction);
    const request = transaction.objectStore(ATTEMPT_STORE).getAll();
    const attempts = await new Promise<DeliveryAttempt[]>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result as DeliveryAttempt[]);
      request.onerror = () => reject(request.error ?? new Error("读取投递记录失败"));
    });
    await completed;
    return attempts
      .filter((attempt) => !attempt.platform || attempt.platform === "liepin")
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, limit);
  } finally {
    database.close();
  }
}

/** 读取最近的智联申请记录，避免混入猎聘聊天投递历史。 */
export async function listRecentZhilianAttempts(limit = 20): Promise<ZhilianDeliveryAttempt[]> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(ATTEMPT_STORE, "readonly");
    const completed = waitForTransaction(transaction);
    const request = transaction.objectStore(ATTEMPT_STORE).getAll();
    const attempts = await new Promise<ZhilianDeliveryAttempt[]>((resolve, reject) => {
      request.onsuccess = () => resolve(
        (request.result as AnyDeliveryAttempt[])
          .filter((attempt): attempt is ZhilianDeliveryAttempt => attempt.platform === "zhilian"),
      );
      request.onerror = () => reject(request.error ?? new Error("读取智联投递记录失败"));
    });
    await completed;
    return attempts
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, limit);
  } finally {
    database.close();
  }
}
