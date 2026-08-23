package com.getjobs.application.controller;

import com.getjobs.application.service.ConfigService;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.HashMap;
import java.util.Map;
import java.util.Set;

/**
 * 配置控制器
 * 提供配置管理的REST API接口
 */
@Slf4j
@RestController
@RequestMapping("/api/config")
public class ConfigController {

    /** 不向浏览器返回的凭据型配置键。 */
    private static final Set<String> SENSITIVE_CONFIG_KEYS = Set.of("API_KEY", "HOOK_URL");
    /** 本控制器允许更新的基础运行配置，平台专属配置必须走对应平台接口。 */
    private static final Set<String> WRITABLE_CONFIG_KEYS = Set.of(
            "HOOK_URL", "BASE_URL", "API_KEY", "MODEL", "BOT_IS_SEND"
    );

    @Autowired
    private ConfigService configService;

    /**
     * 获取所有配置
     * @return 配置Map
     */
    @GetMapping
    public ResponseEntity<Map<String, Object>> getAllConfigs() {
        Map<String, Object> response = new HashMap<>();

        try {
            Map<String, String> configs = sanitizeConfigs(configService.getAllConfigsAsMap());

            response.put("success", true);
            response.put("data", configs);
            response.put("message", "获取配置成功");

            return ResponseEntity.ok(response);

        } catch (Exception e) {
            log.error("获取配置失败", e);
            response.put("success", false);
            response.put("message", "获取配置失败: " + e.getMessage());
            return ResponseEntity.internalServerError().body(response);
        }
    }

    /**
     * 根据配置键获取单个配置
     * @param key 配置键
     * @return 配置值
     */
    @GetMapping("/{key}")
    public ResponseEntity<Map<String, Object>> getConfigByKey(@PathVariable String key) {
        Map<String, Object> response = new HashMap<>();

        try {
            if (SENSITIVE_CONFIG_KEYS.contains(key)) {
                response.put("success", false);
                response.put("message", "敏感配置不支持读取");
                return ResponseEntity.status(403).body(response);
            }
            var config = configService.getConfigByKey(key);

            if (config != null) {
                response.put("success", true);
                response.put("data", config);
                response.put("message", "获取配置成功");
                return ResponseEntity.ok(response);
            } else {
                response.put("success", false);
                response.put("message", "配置不存在");
                return ResponseEntity.notFound().build();
            }

        } catch (Exception e) {
            log.error("获取配置失败: {}", key, e);
            response.put("success", false);
            response.put("message", "获取配置失败: " + e.getMessage());
            return ResponseEntity.internalServerError().body(response);
        }
    }

    /**
     * 批量更新配置
     * @param configMap 配置Map，key为config_key，value为config_value
     * @return 更新结果
     */
    @PostMapping
    public ResponseEntity<Map<String, Object>> batchUpdateConfigs(@RequestBody Map<String, String> configMap) {
        Map<String, Object> response = new HashMap<>();

        try {
            if (configMap == null || configMap.isEmpty()) {
                response.put("success", false);
                response.put("message", "配置数据不能为空");
                return ResponseEntity.badRequest().body(response);
            }

            if (!configMap.keySet().stream().allMatch(WRITABLE_CONFIG_KEYS::contains)) {
                response.put("success", false);
                response.put("message", "请求包含不允许更新的配置键");
                return ResponseEntity.badRequest().body(response);
            }
            int updateCount = configService.batchUpdateConfigs(configMap);

            response.put("success", true);
            response.put("message", "配置更新成功");
            response.put("updateCount", updateCount);

            log.info("批量更新配置成功，共更新 {} 项", updateCount);
            return ResponseEntity.ok(response);

        } catch (Exception e) {
            log.error("批量更新配置失败", e);
            response.put("success", false);
            response.put("message", "配置更新失败: " + e.getMessage());
            return ResponseEntity.internalServerError().body(response);
        }
    }

    /**
     * 更新单个配置
     * @param key 配置键
     * @param requestBody 请求体包含value
     * @return 更新结果
     */
    @PutMapping("/{key}")
    public ResponseEntity<Map<String, Object>> updateConfig(
            @PathVariable String key,
            @RequestBody Map<String, String> requestBody) {

        Map<String, Object> response = new HashMap<>();

        try {
            if (!WRITABLE_CONFIG_KEYS.contains(key)) {
                response.put("success", false);
                response.put("message", "不允许更新该配置键");
                return ResponseEntity.badRequest().body(response);
            }
            String value = requestBody.get("value");

            if (value == null) {
                response.put("success", false);
                response.put("message", "配置值不能为空");
                return ResponseEntity.badRequest().body(response);
            }

            boolean success = configService.updateConfig(key, value);

            if (success) {
                response.put("success", true);
                response.put("message", "配置更新成功");
                return ResponseEntity.ok(response);
            } else {
                response.put("success", false);
                response.put("message", "配置更新失败，配置键可能不存在");
                return ResponseEntity.badRequest().body(response);
            }

        } catch (Exception e) {
            log.error("更新配置失败: {}", key, e);
            response.put("success", false);
            response.put("message", "配置更新失败: " + e.getMessage());
            return ResponseEntity.internalServerError().body(response);
        }
    }

    /**
     * 健康检查接口
     * @return 服务状态
     */
    @GetMapping("/health")
    public ResponseEntity<Map<String, Object>> healthCheck() {
        Map<String, Object> response = new HashMap<>();
        response.put("success", true);
        response.put("service", "ConfigController");
        response.put("status", "healthy");
        response.put("timestamp", System.currentTimeMillis());

        return ResponseEntity.ok(response);
    }

    /**
     * 将凭据从通用配置响应中移除，仅保留是否已配置的状态。
     *
     * @param configs 数据库存储的完整配置。
     * @return 可安全返回给管理页面的配置快照。
     */
    private Map<String, String> sanitizeConfigs(Map<String, String> configs) {
        Map<String, String> sanitized = new HashMap<>(configs);
        for (String key : SENSITIVE_CONFIG_KEYS) {
            sanitized.remove(key);
            sanitized.put(key + "_CONFIGURED", Boolean.toString(
                    configs.containsKey(key) && configs.get(key) != null && !configs.get(key).isBlank()
            ));
        }
        return sanitized;
    }
}
