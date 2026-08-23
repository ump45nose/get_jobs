package com.getjobs.application.config;

import lombok.extern.slf4j.Slf4j;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.annotation.AsyncConfigurer;
import org.springframework.scheduling.concurrent.ThreadPoolTaskExecutor;

import java.util.concurrent.Executor;
import java.util.concurrent.ThreadPoolExecutor;

/**
 * 异步配置类
 * 配置异步任务执行的线程池
 */
@Slf4j
@Configuration
public class AsyncConfig implements AsyncConfigurer {

    /**
     * 配置异步任务执行器
     * @return 线程池执行器
     */
    @Override
    @Bean(name = "taskExecutor")
    public Executor getAsyncExecutor() {
        ThreadPoolTaskExecutor executor = new ThreadPoolTaskExecutor();
        
        // 所有平台共享同一个 BrowserContext，自动化动作必须全局串行，不能并发访问 Playwright 对象。
        executor.setCorePoolSize(1);
        // 保持单线程，平台任务在队列中顺序执行。
        executor.setMaxPoolSize(1);
        // 队列容量限制待执行任务，避免无限堆积。
        executor.setQueueCapacity(20);
        // 线程名前缀
        executor.setThreadNamePrefix("GetJobs-Task-");
        // 线程空闲时间（秒）
        executor.setKeepAliveSeconds(60);
        
        // 队列满时显式拒绝，避免 HTTP 请求线程直接操作浏览器。
        executor.setRejectedExecutionHandler(new ThreadPoolExecutor.AbortPolicy());
        
        // 等待所有任务结束后再关闭线程池
        executor.setWaitForTasksToCompleteOnShutdown(true);
        // 等待时间
        executor.setAwaitTerminationSeconds(60);
        
        executor.initialize();
        
        log.info("异步任务执行器配置完成 - 核心线程数: {}, 最大线程数: {}, 队列容量: {}", 
                executor.getCorePoolSize(), executor.getMaxPoolSize(), executor.getQueueCapacity());
        
        return executor;
    }
}
