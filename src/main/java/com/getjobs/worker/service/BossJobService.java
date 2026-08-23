package com.getjobs.worker.service;

import com.getjobs.application.service.ConfigService;
import com.getjobs.worker.boss.Boss;
import com.getjobs.worker.boss.BossConfig;
import com.getjobs.worker.dto.JobProgressMessage;
import com.getjobs.worker.manager.PlaywrightManager;
import com.microsoft.playwright.Page;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Service;

import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Consumer;

/**
 * Boss直聘任务服务
 * 管理Boss平台的投递任务执行和状态
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class BossJobService implements JobPlatformService {
    private static final String PLATFORM = "boss";
    // 当前分支明确关闭 BOSS 自动投递，避免调用不稳定的平台页面流程。
    private static final boolean ENABLED = false;

    private final PlaywrightManager playwrightManager;
    private final ConfigService configService;
    private final ObjectProvider<Boss> bossProvider;

    // 任务运行状态
    /** 原子任务闸门，保证并发请求只能启动一个平台投递流程。 */
    private final AtomicBoolean isRunning = new AtomicBoolean(false);
    // 停止标志
    private volatile boolean shouldStop = false;

    @Override
    public void executeDelivery(Consumer<JobProgressMessage> progressCallback) {
        // 在任务入口统一拦截，防止任何 API 或旧前端路径意外触发 BOSS 自动化。
        if (!ENABLED) {
            progressCallback.accept(JobProgressMessage.warning(PLATFORM, "BOSS 直聘已在当前分支关闭"));
            return;
        }

        if (!reserveDelivery()) {
            progressCallback.accept(JobProgressMessage.warning(PLATFORM, "任务已在运行中"));
            return;
        }
        executeReservedDelivery(progressCallback);
    }

    /**
     * 在 HTTP 返回“已启动”前原子预占本平台任务，避免排队任务重复启动。
     *
     * @return 成功预占时返回 true。
     */
    public boolean reserveDelivery() {
        return isRunning.compareAndSet(false, true);
    }

    /** 执行已预占的 BOSS 投递任务，并在 finally 中释放任务闸门。 */
    public void executeReservedDelivery(Consumer<JobProgressMessage> progressCallback) {
        try {
            // 获取Boss页面实例
            Page page = playwrightManager.getBossPage();
            if (page == null) {
                progressCallback.accept(JobProgressMessage.error(PLATFORM, "Boss页面未初始化"));
                return;
            }

            // 检查是否已登录
            if (!playwrightManager.isLoggedIn(PLATFORM)) {
                progressCallback.accept(JobProgressMessage.error(PLATFORM, "请先登录Boss直聘"));
                return;
            }

            // 通过校验后再标记运行
            shouldStop = false;

            // 暂停后台登录监控，避免与投递流程并发访问同一Page
            playwrightManager.pauseBossMonitoring();

            // 加载配置（统一从 boss_config 专表读取）
            BossConfig config = configService.getBossConfig();
            progressCallback.accept(JobProgressMessage.info(PLATFORM, "配置加载成功"));

            progressCallback.accept(JobProgressMessage.info(PLATFORM, "开始投递任务..."));

            // 创建Boss实例并执行投递
            Boss.ProgressCallback bossCallback = (message, current, total) -> {
                if (current != null && total != null) {
                    progressCallback.accept(JobProgressMessage.progress(PLATFORM, message, current, total));
                } else {
                    progressCallback.accept(JobProgressMessage.info(PLATFORM, message));
                }
            };

            Boss boss = bossProvider.getObject();
            boss.setPage(page);
            boss.setConfig(config);
            boss.setProgressCallback(bossCallback);
            boss.setShouldStopCallback(this::shouldStop);
            boss.prepare();

            int deliveredCount = boss.execute();

            progressCallback.accept(JobProgressMessage.success(PLATFORM,
                String.format("投递任务完成，共发起%d个聊天", deliveredCount)));
        } catch (Exception e) {
            log.error("Boss投递任务执行失败", e);
            progressCallback.accept(JobProgressMessage.error(PLATFORM, "投递失败: " + e.getMessage()));
        } finally {
            isRunning.set(false);
            shouldStop = false;
            // 恢复后台登录监控
            try {
                playwrightManager.resumeBossMonitoring();
            } catch (Exception ignored) {}
        }
    }

    @Override
    public void stopDelivery() {
        if (isRunning.get()) {
            log.info("收到停止Boss投递任务的请求");
            shouldStop = true;
        }
    }

    @Override
    public Map<String, Object> getStatus() {
        Map<String, Object> status = new HashMap<>();
        status.put("platform", PLATFORM);
        status.put("enabled", ENABLED);
        status.put("isRunning", isRunning.get());
        // BOSS 页面未创建，因此关闭状态下始终报告未登录。
        status.put("isLoggedIn", ENABLED && playwrightManager.isLoggedIn(PLATFORM));
        return status;
    }

    @Override
    public String getPlatformName() {
        return PLATFORM;
    }

    /**
     * 返回 BOSS 平台是否允许执行自动投递。
     *
     * @return 当前分支固定返回 false
     */
    public boolean isEnabled() {
        return ENABLED;
    }

    @Override
    public boolean isRunning() {
        return isRunning.get();
    }

    /**
     * 检查是否应该停止
     * 供Boss.java调用
     */
    public boolean shouldStop() {
        return shouldStop;
    }

    
}
