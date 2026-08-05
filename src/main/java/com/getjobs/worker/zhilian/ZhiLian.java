package com.getjobs.worker.zhilian;

import com.getjobs.application.entity.ZhilianJobDataEntity;
import com.getjobs.application.service.ZhilianService;
import com.getjobs.worker.utils.Job;
import com.getjobs.worker.utils.JobUtils;
import com.getjobs.worker.utils.PlaywrightUtil;
import com.microsoft.playwright.Locator;
import com.microsoft.playwright.Page;
import lombok.RequiredArgsConstructor;
import lombok.Setter;
import lombok.extern.slf4j.Slf4j;
import org.springframework.context.annotation.Scope;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.List;
import java.util.function.Supplier;

/**
 * @author loks666
 * 项目链接: <a href="https://github.com/loks666/get_jobs">https://github.com/loks666/get_jobs</a>
 * 智联招聘自动投递 - Playwright版本
 */
@Slf4j
@Component
@Scope("prototype")
@RequiredArgsConstructor
public class ZhiLian {

    @Setter
    private Page page;

    @Setter
    private ZhilianConfig config;

    @Setter
    private ProgressCallback progressCallback;

    @Setter
    private Supplier<Boolean> shouldStopCallback;

    private final List<Job> resultList = new ArrayList<>();
    private boolean isLimit = false;
    private int maxPage = 500;

    private static final String HOME_URL = "https://www.zhaopin.com/sou/";

    private final ZhilianService zhilianService;

    private static class PageJob {
        int index;
        String jobId;
        String jobTitle;
        String companyName;
        String jobLink;
        String salary;
        String location;
        String experience;
        String degree;

        /**
         * 保存岗位卡片中的稳定字段，供投递结果确认后写入统计列表。
         */
        PageJob(int index, String jobId, String jobTitle, String companyName,
                String jobLink, String salary, String location, String experience, String degree) {
            this.index = index;
            this.jobId = jobId;
            this.jobTitle = jobTitle;
            this.companyName = companyName;
            this.jobLink = jobLink;
            this.salary = salary;
            this.location = location;
            this.experience = experience;
            this.degree = degree;
        }
    }

    /**
     * 平台对一次投递动作返回的可识别结果。
     */
    private enum DeliveryOutcome {
        SUCCESS,
        FAILED,
        CAPTCHA,
        LIMIT,
        UNKNOWN
    }

    /**
     * 进度回调接口
     */
    @FunctionalInterface
    public interface ProgressCallback {
        void accept(String message, Integer current, Integer total);
    }

    /**
     * 准备工作：加载配置、初始化数据
     */
    public void prepare() {
        log.info("智联招聘准备工作开始...");
        resultList.clear();
        isLimit = false;
        log.info("智联招聘准备工作完成");
    }

    /**
     * 执行投递任务
     * @return 投递数量
     */
    public int execute() {
        log.info("智联招聘投递任务开始...");
        long startTime = System.currentTimeMillis();

        try {
            // 遍历所有关键词进行投递
            for (String keyword : config.getKeywords()) {
                if (shouldStop() || isLimit) {
                    sendProgress("用户取消投递或已达上限", null, null);
                    break;
                }

                String baseUrl = buildBaseUrl(1);
                deliverByKeyword(keyword, baseUrl);
            }

            long duration = System.currentTimeMillis() - startTime;
            String message = String.format("智联招聘投递完成，共投递%d个岗位，用时%s",
                resultList.size(), formatDuration(duration));
            log.info(message);
            sendProgress(message, null, null);

            if (!resultList.isEmpty()) {
                log.info("新投递公司如下:");
                resultList.forEach(job -> log.info(job.toString()));
            } else {
                log.info("未投递新的岗位...");
            }

        } catch (Exception e) {
            log.error("智联招聘投递过程出现异常", e);
            sendProgress("投递出现异常: " + e.getMessage(), null, null);
        }

        return resultList.size();
    }

    /**
     * 按关键词投递
     */
    private void deliverByKeyword(String keyword, String baseUrl) {
        if (isLimit) {
            return;
        }

        try {
            log.info("开始投递关键词: {}", keyword);
            sendProgress("正在搜索关键词: " + keyword, null, null);

            // 导航到搜索页面（路径参数：jl+城市码 + p1 + sl）
            page.navigate(baseUrl);
            PlaywrightUtil.sleep(2);

            // 在搜索框输入关键词并触发搜索（Enter键更稳健）
            try {
                Locator keywordInput = findKeywordInput();
                if (keywordInput == null || keywordInput.count() == 0) {
                    log.warn("未找到搜索输入框，跳过关键词: {}", keyword);
                    return;
                }
                keywordInput.fill("");
                keywordInput.fill(keyword);
                try { keywordInput.press("Enter"); } catch (Exception ignored) {}
                PlaywrightUtil.sleep(2);
            } catch (Exception e) {
                log.warn("搜索框输入关键词失败，跳过当前关键词: {}", e.getMessage());
                return;
            }

            // 等待岗位列表加载（CSS选择器）
            try {
                page.waitForSelector("div.joblist-box__item",
                    new Page.WaitForSelectorOptions().setTimeout(10_000));
            } catch (Exception e) {
                log.warn("等待岗位列表超时，跳过当前关键词");
                return;
            }

            // 遍历所有页面：仅以“下一页”按钮禁用状态为主，最多50页
            int pageNum = 1;
            while (pageNum <= 50) {
                if (shouldStop() || isLimit) {
                    sendProgress("用户取消投递或已达上限", null, null);
                    return;
                }

                log.info("开始投递【{}】关键词，第【{}】页...", keyword, pageNum);
                sendProgress(String.format("正在投递第%d页", pageNum), pageNum, 50);

                // 等待岗位列表出现（CSS选择器）
                try {
                    page.waitForSelector("div.positionlist",
                        new Page.WaitForSelectorOptions().setTimeout(10_000));
                } catch (Exception e) {
                    log.warn("等待岗位列表失败，刷新页面重试");
                    page.reload();
                    PlaywrightUtil.sleep(1);
                }

                // 投递当前页面
                if (!deliverCurrentPage(keyword)) {
                    break;
                }

                PlaywrightUtil.sleep(2);

                // 判断是否还有下一页
                if (isNextDisabled()) {
                    log.info("下一页按钮不可点击，结束翻页");
                    break;
                }

                // 点击下一页
                Locator nextBtn = page.locator("a.soupager__btn:has-text(\"下一页\")");
                if (nextBtn.count() > 0) {
                    try { nextBtn.first().scrollIntoViewIfNeeded(); } catch (Exception ignored) {}
                    nextBtn.first().click();
                    PlaywrightUtil.sleep(2);
                    pageNum++;
                } else {
                    log.info("未找到下一页按钮，结束翻页");
                    break;
                }
            }

            log.info("关键词【{}】投递完成", keyword);
        } catch (Exception e) {
            log.error("投递关键词【{}】时出现异常", keyword, e);
        }
    }

    /**
     * 投递当前页面的所有职位
     * @return 是否继续投递下一页
     */
    private boolean deliverCurrentPage(String keyword) {
        try {
            page.waitForSelector("div.joblist-box__item",
                    new Page.WaitForSelectorOptions().setTimeout(15000));

            if (checkIsLimit()) {
                sendProgress("用户取消投递或已达上限", null, null);
                return false;
            }

            Locator cards = page.locator("div.joblist-box__item");
            int count = cards.count();
            log.info("检测到当前页岗位数量: {}", count);

            List<PageJob> jobs = new ArrayList<>();
            // 统一采集当前页岗位后再保存（不在循环中逐个入库）
            List<ZhilianJobDataEntity> toInsert = new ArrayList<>();

            for (int i = 0; i < count; i++) {
                if (shouldStop()) {
                    sendProgress("用户取消投递或已达上限", null, null);
                    return false;
                }

                Locator card = cards.nth(i);
                String jobTitle = safeGetText(card, "a.jobinfo__name");
                String jobLink = null;
                try { jobLink = card.locator("a.jobinfo__name").getAttribute("href"); } catch (Exception ignored) {}
                String salary = safeGetText(card, "p.jobinfo__salary");
                String location = safeGetText(card, "div.jobinfo__other-info div.jobinfo__other-info-item > span");
                String experience = safeGetText(card, "div.jobinfo__other-info-item:nth-child(2)");
                String degree = safeGetText(card, "div.jobinfo__other-info-item:nth-child(3)");
                String companyName = safeGetText(card, "div.companyinfo__name");

                String jobId = extractJobIdFromLink(jobLink);

                try {
                    String jid = jobId == null ? "" : jobId.trim();
                    String jtitle = jobTitle == null ? "" : jobTitle.trim();
                    if (jid.isEmpty() || jtitle.isEmpty()) {
                        log.info("岗位缺少jobId或jobTitle，跳过采集：title={}，company={}", jtitle, companyName);
                    } else {
                        boolean exists = false;
                        try { exists = zhilianService.existsByJobId(jid); } catch (Exception checkEx) {
                            log.warn("查询jobId是否已存在失败: {}", checkEx.getMessage());
                        }
                        if (exists) {
                            log.info("jobId已存在，跳过采集：jobId={}，title={}", jid, jtitle);
                        } else {
                            ZhilianJobDataEntity entity = new ZhilianJobDataEntity();
                            entity.setJobId(jid);
                            entity.setJobTitle(jtitle);
                            entity.setJobLink(jobLink);
                            entity.setSalary(salary);
                            entity.setLocation(location);
                            entity.setExperience(experience);
                            entity.setDegree(degree);
                            entity.setCompanyName(companyName);
                            entity.setDeliveryStatus("未投递");
                            toInsert.add(entity);
                        }
                    }
                } catch (Exception ex) {
                    log.warn("采集岗位数据失败: {}", ex.getMessage());
                }

                // 保留完整岗位字段，只有平台确认成功后才加入 resultList。
                jobs.add(new PageJob(i, jobId, jobTitle, companyName,
                        jobLink, salary, location, experience, degree));
            }

            // 统一保存采集到的一整页岗位
            if (!toInsert.isEmpty()) {
                for (ZhilianJobDataEntity entity : toInsert) {
                    try {
                        zhilianService.insertJob(entity);
                        log.info("已保存岗位数据：jobId={}，title={}，company={}", entity.getJobId(), entity.getJobTitle(), entity.getCompanyName());
                    } catch (Exception ex) {
                        log.warn("保存岗位数据失败: {}", ex.getMessage());
                    }
                }
            }

            for (PageJob pj : jobs) {
                if (shouldStop()) {
                    sendProgress("用户取消投递或已达上限", null, null);
                    return false;
                }

                Locator card = page.locator("div.joblist-box__item").nth(pj.index);
                Locator applyBtn = card.locator("button.collect-and-apply__btn");
                if (applyBtn.count() == 0) {
                    log.info("岗位【{}】未找到立即投递按钮，跳过", pj.jobTitle);
                    continue;
                }
                try {
                    // 点击后等待弹窗或当前页的明确结果，禁止仅凭 click 返回就写入“已投递”。
                    DeliveryOutcome outcome = submitApplication(pj, applyBtn);
                    handleDeliveryOutcome(pj, outcome);
                    if (outcome == DeliveryOutcome.LIMIT || outcome == DeliveryOutcome.CAPTCHA) {
                        return false;
                    }
                } catch (Exception clickEx) {
                    // 点击本身失败也要记录失败状态，但不能阻塞后续岗位。
                    log.warn("投递失败，继续下一个岗位: {}", clickEx.getMessage());
                    markDeliveryStatus(pj, "投递失败");
                }

                if (checkIsLimit()) {
                    sendProgress("用户取消投递或已达上限", null, null);
                    return false;
                }
            }

            return true;
        } catch (Exception e) {
            log.error("投递当前页面失败", e);
            try {
                saveCurrentPageHtml();
                log.info("已保存当前页面到 src/main/java/com/getjobs/worker/zhilian/page.html 以便排查");
            } catch (Exception saveEx) {
                log.warn("保存当前页面HTML失败: {}", saveEx.getMessage());
            }
            return false;
        }
    }

    /**
     * 点击岗位投递按钮并等待弹窗或当前页面给出结果。
     *
     * @param job     当前岗位
     * @param applyBtn 当前岗位的投递按钮
     * @return 平台返回的投递结果
     */
    private DeliveryOutcome submitApplication(PageJob job, Locator applyBtn) {
        // 点击前记录已有页面，避免把其它平台页面误当成投递弹窗。
        List<Page> knownPages = new ArrayList<>(page.context().pages());
        log.debug("开始点击智联投递按钮：jobId={}，title={}", job.jobId, job.jobTitle);
        applyBtn.scrollIntoViewIfNeeded();
        applyBtn.click(new Locator.ClickOptions().setTimeout(10_000));

        // 智联可能打开新标签页，也可能在当前页渲染工作流弹窗。
        Page dialogPage = waitForNewPage(knownPages, 5_000);
        Page resultPage = dialogPage == null ? page : dialogPage;
        DeliveryOutcome outcome = handleDeliveryDialog(resultPage);

        // 结果已读取后及时关闭弹窗，避免下一个岗位继续复用旧页面。
        if (dialogPage != null) {
            closeDeliveryPage(dialogPage);
        }
        return outcome;
    }

    /**
     * 等待本次点击产生的新页面。
     *
     * @param knownPages 点击前已经存在的页面
     * @param timeoutMillis 最大等待时间（毫秒）
     * @return 新页面，超时则返回 null
     */
    private Page waitForNewPage(List<Page> knownPages, int timeoutMillis) {
        long deadline = System.currentTimeMillis() + timeoutMillis;
        while (System.currentTimeMillis() < deadline) {
            for (Page candidate : page.context().pages()) {
                if (!knownPages.contains(candidate) && !candidate.isClosed()) {
                    return candidate;
                }
            }
            // 使用毫秒等待，避免旧的秒级等待把弹窗关闭动作阻塞数分钟。
            PlaywrightUtil.sleepMillis(100);
        }
        return null;
    }

    /**
     * 读取投递弹窗或当前页面的结果文本，直到成功、失败、验证码或上限信号出现。
     *
     * @param resultPage 智联投递结果所在页面
     * @return 识别到的投递结果，超时返回 UNKNOWN
     */
    private DeliveryOutcome handleDeliveryDialog(Page resultPage) {
        long deadline = System.currentTimeMillis() + 15_000;
        while (System.currentTimeMillis() < deadline) {
            DeliveryOutcome outcome = detectDeliveryOutcome(resultPage);
            if (outcome != DeliveryOutcome.UNKNOWN) {
                return outcome;
            }
            // 页面是异步渲染的，短轮询等待 DOM 更新，不阻塞数十秒。
            PlaywrightUtil.sleepMillis(200);
        }
        log.warn("投递结果等待超时，未确认岗位【{}】是否成功", resultPage.url());
        return DeliveryOutcome.UNKNOWN;
    }

    /**
     * 从智联页面中识别投递结果。
     *
     * @param resultPage 结果页面
     * @return 识别结果
     */
    private DeliveryOutcome detectDeliveryOutcome(Page resultPage) {
        // 先读投递弹窗/工作流范围，避免列表中其它岗位的“已投递”状态造成误判。
        DeliveryOutcome scopedOutcome = detectOutcomeFromText(readDeliveryText(resultPage));
        if (scopedOutcome != DeliveryOutcome.UNKNOWN) {
            return scopedOutcome;
        }

        // 某些版本不创建弹窗，只在 body 显示明确提示；body 只接受明确成功文案。
        String bodyText = readBodyText(resultPage);
        if (containsAny(bodyText, "申请成功", "投递成功", "达到上限", "验证码", "滑块验证",
                "安全验证", "人机验证", "申请失败", "投递失败", "未设置默认简历", "请先完善简历")) {
            return detectOutcomeFromText(bodyText);
        }
        return DeliveryOutcome.UNKNOWN;
    }

    /**
     * 从文本中识别结果，只接受平台明确的成功/失败文案。
     */
    private DeliveryOutcome detectOutcomeFromText(String text) {
        if (text == null || text.isBlank()) {
            return DeliveryOutcome.UNKNOWN;
        }
        if (containsAny(text, "达到上限", "今日投递次数已达上限", "次数已达上限", "投递数量已达")) {
            return DeliveryOutcome.LIMIT;
        }
        if (containsAny(text, "验证码", "滑块验证", "安全验证", "人机验证", "请完成验证")) {
            return DeliveryOutcome.CAPTCHA;
        }
        if (containsAny(text, "申请成功", "投递成功")) {
            return DeliveryOutcome.SUCCESS;
        }
        if (containsAny(text, "申请失败", "投递失败", "未设置默认简历", "请先完善简历", "暂不支持投递")) {
            return DeliveryOutcome.FAILED;
        }
        return DeliveryOutcome.UNKNOWN;
    }

    /**
     * 获取投递弹窗和工作流相关 DOM 文本。
     */
    private String readDeliveryText(Page resultPage) {
        StringBuilder text = new StringBuilder();
        String[] selectors = {"div.deliver-dialog", ".a-job-apply-workflow", "[class*='dialog']"};
        for (String selector : selectors) {
            try {
                Locator locator = resultPage.locator(selector).first();
                if (locator.count() > 0) {
                    String value = locator.textContent();
                    if (value != null) {
                        text.append(' ').append(value);
                    }
                }
            } catch (Exception e) {
                log.debug("读取智联投递结果文本失败，selector={}: {}", selector, e.getMessage());
            }
        }
        return text.toString().replace('\n', ' ').trim();
    }

    /**
     * 读取页面 body 文本作为无弹窗版本的最后兜底。
     */
    private String readBodyText(Page resultPage) {
        try {
            String text = resultPage.locator("body").textContent();
            return text == null ? "" : text.replace('\n', ' ').trim();
        } catch (Exception e) {
            log.debug("读取智联页面 body 文本失败: {}", e.getMessage());
            return "";
        }
    }

    /**
     * 判断文本是否包含任一关键词。
     */
    private boolean containsAny(String text, String... keywords) {
        for (String keyword : keywords) {
            if (text.contains(keyword)) {
                return true;
            }
        }
        return false;
    }

    /**
     * 根据已确认的结果更新数据库、统计列表和任务状态。
     */
    private void handleDeliveryOutcome(PageJob job, DeliveryOutcome outcome) {
        switch (outcome) {
            case SUCCESS -> {
                // 只有平台返回成功后才更新 SQLite，并把主岗位加入投递结果列表。
                markDeliveryStatus(job, "已投递");
                resultList.add(toResultJob(job));
                log.info("已确认投递成功：jobId={}，title={}，company={}", job.jobId, job.jobTitle, job.companyName);
                sendProgress("投递成功: " + job.jobTitle, null, null);
            }
            case LIMIT -> {
                // 达到平台上限单独记录，且停止后续岗位，避免继续触发风控。
                markDeliveryStatus(job, "达到上限");
                isLimit = true;
                sendProgress("智联招聘已达到投递上限", null, null);
            }
            case CAPTCHA -> {
                // 验证码需要人工处理，单独记录并停止当前任务。
                markDeliveryStatus(job, "需要验证码");
                sendProgress("检测到智联验证码/安全验证，任务已停止", null, null);
            }
            case FAILED, UNKNOWN -> {
                // 明确失败或超时未确认均不计入成功数量，写入失败状态供后续排查。
                markDeliveryStatus(job, "投递失败");
                sendProgress("投递失败或未确认: " + job.jobTitle, null, null);
            }
        }
    }

    /**
     * 按岗位稳定键更新投递状态。
     */
    private void markDeliveryStatus(PageJob job, String status) {
        try {
            if (job.jobId != null && !job.jobId.isBlank()) {
                zhilianService.markDeliveryStatusByJobId(job.jobId, status);
            } else if (job.jobTitle != null && !job.jobTitle.isBlank()
                    && job.companyName != null && !job.companyName.isBlank()) {
                zhilianService.markDeliveryStatusByTitleAndCompany(job.jobTitle, job.companyName, status);
            } else {
                log.warn("岗位缺少可更新状态的稳定键：title={}，company={}", job.jobTitle, job.companyName);
            }
        } catch (Exception e) {
            log.warn("更新岗位投递状态失败：jobId={}，status={}，原因={}", job.jobId, status, e.getMessage());
        }
    }

    /**
     * 将已确认成功的岗位转换为任务结果对象。
     */
    private Job toResultJob(PageJob pageJob) {
        Job job = new Job();
        job.setHref(pageJob.jobLink);
        job.setJobName(pageJob.jobTitle);
        job.setJobArea(pageJob.location);
        job.setJobInfo((pageJob.experience == null ? "" : pageJob.experience)
                + "·" + (pageJob.degree == null ? "" : pageJob.degree));
        job.setSalary(pageJob.salary);
        job.setCompanyName(pageJob.companyName);
        return job;
    }

    /**
     * 关闭投递弹窗页面。
     */
    private void closeDeliveryPage(Page dialogPage) {
        try {
            Locator closeButton = dialogPage.locator("img[title='close-icon'], button:has-text('关闭'), [aria-label='关闭']").first();
            if (closeButton.count() > 0 && closeButton.isVisible()) {
                closeButton.click(new Locator.ClickOptions().setTimeout(2_000));
                PlaywrightUtil.sleepMillis(300);
            }
        } catch (Exception e) {
            log.debug("关闭智联投递弹窗按钮失败: {}", e.getMessage());
        }
        try {
            if (!dialogPage.isClosed()) {
                dialogPage.close();
            }
        } catch (Exception e) {
            log.debug("关闭智联投递弹窗页面失败: {}", e.getMessage());
        }
    }

    /**
     * 检查是否达到投递上限
     */
    private boolean checkIsLimit() {
        try {
            // 页面结果由异步请求更新，使用短毫秒等待，避免每个岗位额外阻塞一秒。
            PlaywrightUtil.sleepMillis(300);
            Locator result = page.locator("//div[@class='a-job-apply-workflow']");
            if (result.count() > 0) {
                String text = result.textContent();
                if (text != null && containsAny(text, "达到上限", "今日投递次数已达上限", "次数已达上限")) {
                    log.info("今日投递已达上限！");
                    isLimit = true;
                    return true;
                }
            }
            return false;
        } catch (Exception e) {
            return false;
        }
    }

    /**
     * 设置最大页数（已废弃：使用“下一页不可点击”+最多50页）
     */
    private void setMaxPages() {
        // 保留方法避免旧调用报错，但不再依赖输入框改页码
        maxPage = 50;
    }

    /**
     * 构建基础搜索URL（不含关键词，由搜索框触发）
     */
    private String buildBaseUrl(int pageNum) {
        StringBuilder url = new StringBuilder(HOME_URL);
        url.append("jl").append(config.getCityCode()).append("/");
        url.append("p").append(pageNum).append("?");
        url.append(JobUtils.appendParam("sl", config.getSalary()));
        return url.toString();
    }

    /**
     * 查找搜索关键词输入框（多候选选择器，提高鲁棒性）
     */
    private Locator findKeywordInput() {
        String[] candidates = new String[] {
            "input[placeholder*='职位']",
            "input[placeholder*='公司']",
            "input[name='kw']",
            "input[type='text']",
            "input[class*='search'], input[class*='sou'], input[class*='input']"
        };
        for (String sel : candidates) {
            try {
                Locator lc = page.locator(sel);
                if (lc != null && lc.count() > 0) {
                    return lc.first();
                }
            } catch (Exception ignored) {}
        }
        return null;
    }

    /**
     * 判断“下一页”是否不可点击
     */
    private boolean isNextDisabled() {
        try {
            Locator nextBtn = page.locator("a.soupager__btn:has-text(\"下一页\")");
            if (nextBtn.count() == 0) return true;
            String cls = null;
            try { cls = nextBtn.first().getAttribute("class"); } catch (Exception ignored) {}
            String disabledAttr = null;
            try { disabledAttr = nextBtn.first().getAttribute("disabled"); } catch (Exception ignored) {}
            if (cls != null && cls.contains("soupager__btn--disable")) return true;
            return disabledAttr != null && ("disabled".equalsIgnoreCase(disabledAttr) || "true".equalsIgnoreCase(disabledAttr));
        } catch (Exception e) {
            return false;
        }
    }

    private String extractJobIdFromLink(String link) {
        if (link == null) return null;
        try {
            int i = link.indexOf("jobdetail/");
            int j = link.lastIndexOf(".htm");
            if (i >= 0 && j > i) {
                return link.substring(i + "jobdetail/".length(), j);
            }
        } catch (Exception ignored) {}
        return null;
    }

    /**
     * 安全获取文本内容
     */
    private String safeGetText(Locator parent, String selector) {
        try {
            Locator element = parent.locator(selector);
            if (element.count() > 0) {
                return element.textContent();
            }
        } catch (Exception e) {
            log.debug("获取文本失败: {}", e.getMessage());
        }
        return "";
    }

    /**
     * 格式化时长
     */
    private String formatDuration(long millis) {
        long seconds = millis / 1000;
        long minutes = seconds / 60;
        long hours = minutes / 60;

        if (hours > 0) {
            return String.format("%d小时%d分钟", hours, minutes % 60);
        } else if (minutes > 0) {
            return String.format("%d分钟%d秒", minutes, seconds % 60);
        } else {
            return String.format("%d秒", seconds);
        }
    }

    /**
     * 将当前页面内容保存到项目内 page.html，覆盖原文件
     */
    private void saveCurrentPageHtml() {
        try {
            String html = page.content();
            java.nio.file.Path path = java.nio.file.Paths.get("src/main/java/com/getjobs/worker/zhilian/page.html");
            java.nio.file.Files.createDirectories(path.getParent());
            java.nio.file.Files.write(path, html.getBytes(java.nio.charset.StandardCharsets.UTF_8));
        } catch (Exception e) {
            throw new RuntimeException("写入 page.html 失败", e);
        }
    }

    /**
     * 发送进度消息
     */
    private void sendProgress(String message, Integer current, Integer total) {
        if (progressCallback != null) {
            progressCallback.accept(message, current, total);
        }
    }

    /**
     * 检查是否应该停止
     */
    private boolean shouldStop() {
        return shouldStopCallback != null && shouldStopCallback.get();
    }
}
