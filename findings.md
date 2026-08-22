# 迁移发现

## 2026-08-22 Git fork 同步

- `D:\Github\get_jobs-extension` 当前 `main` 位于 `9459f9e`，工作区干净，但 `git remote -v`、分支跟踪配置均为空；它不是一个已配置 fork 关系的本地仓库。
- 在没有 remote 的情况下直接执行 pull/push 会无法确定目标，需先从相邻 `get_jobs` 仓库的 remote、系统 Git 凭据或用户 GitHub 仓库信息确定 `origin`（用户 fork）与 `upstream`（原仓库）。
- 本机没有 `gh` 可执行文件，因此不能依赖 GitHub CLI 创建/查询 fork；优先复用 Git 原生命令和既有认证。
- 相邻 `D:\Github\get_jobs` 已配置明确 fork 关系：`origin=https://github.com/ump45nose/get_jobs.git`，`upstream=https://github.com/loks666/get_jobs.git`；本地 `main` 与记录的 `upstream/main` 相比为上游 0、本地 4，且工作区干净。
- `D:\Github\boss-helper-v2` 也有 fork/upstream，但当前正处于合并 `upstream/main` 的大量未解决冲突状态；这属于另一个仓库，不能在未确认目标前把 get_jobs-extension 的推送任务误切到 BOSS 仓库。
- `get_jobs-extension` 有 338 个提交，说明它很可能沿用了 get_jobs 历史而只是缺失 remote；下一步需用 merge-base 验证共同祖先，再安全补回相同的 origin/upstream。
- merge-base 验证否定了上述推测：extension 无法解析 get_jobs 的 `f809428`，自身根提交为 `ddaa4ed`，两者是无共同祖先的独立仓库。把 `upstream/main` 强行 pull 到 extension 会制造无意义的全仓冲突，禁止这样处理。
- 安全发布方式是把 extension 推到用户 fork 的独立分支（不覆盖 Java 主分支）；fork 原分支同步与冲突处理应在真正具有 upstream 关系的对应仓库中完成。
- extension 已按上述策略发布到 `ump45nose/get_jobs` 的 `codex/get-jobs-extension` 分支；Java `main` 保持原有历史。
- Java fork 获取最新引用后相对 `loks666/get_jobs:main` 为上游 0、本地 4，无需额外 merge。
- 真正存在冲突的 `boss-helper-v2` 已合并 `Ocyss/boss-helper:main`：22 个冲突以 V2 独立命名空间、默认关闭自动投递、日志脱敏、图片简历和限流为优先完成取舍，并推送到 `ump45nose/boss-helper-v2:codex/boss-helper-v2`。

## 2026-08-18 智联岗位识别与顶部直启

- 智联当前解析入口为 `src/shared/zhilian-parser.ts`，Content Script 的 `inspectPage()` 仅在智联域调用该解析器；提示“尚未识别”说明域名识别正常但解析结果为空。
- `ZhilianApp.tsx` 已让 `inspectPage()` 返回 `ZhilianPageContext`，但现有 `startBatch()` 没有接收快照参数，若直接照搬“先识别再启动”仍可能读取 React 上一次渲染中的旧岗位列表。
- 智联顶部目前没有批次快捷按钮，正文“一键顺序投递”直接使用旧 `candidates`；目标应是顶部单击执行“重新识别 → 使用返回快照过滤已投递岗位 → 直接启动”，运行中同一位置允许停止。
- 2026-08-18 对用户当前 `/jobs/?pageMode=recommend` 页面只读核验确认：旧 `.joblist-box__item`、`a.jobinfo__name`、`button.collect-and-apply__btn` 数量均为 0；新版列表稳定结构为 `.job-list-panel` 下 20 个 `.job-card`。
- 新版字段类名为 `.job-card__title-main`、`.job-card__salary`、`.job-card__skill-tag`、`.job-card__company-name`、`.job-card__location`；卡片自身无岗位链接和申请按钮，当前选中卡片以 `.job-card--active` 标识。
- 新版“立即投递”只存在右侧详情区，按钮为 `.job-detail-summary__apply`；因此不能仅补解析选择器，投递动作还必须变为“定位并点击列表卡片 → 等待右侧详情与目标岗位匹配 → 点击详情区唯一申请按钮”。
- 新版卡片没有岗位 ID 属性或详情链接，可继续用标题、公司、地区、薪资生成稳定指纹；动作前按 `cardKey` 重新定位，详情绑定至少校验标题与公司，避免右侧仍停留在上一个岗位时误投。

## 2026-08-13 猎聘顶部直启前自动识别

- 顶部“顺序投递”不能只串行调用现有 `inspectPage()` 与 `confirmBatchStart()`：前者仅执行 `setContext()`，React 状态更新异步，后者在同一事件闭包中仍可能读取旧 `context` 与旧 `batchCandidates`。
- 稳定方案是让识别函数返回 `LiepinPageContext`，并让批次校验、候选岗位切片和队列创建显式接收该快照；这样单击行为不依赖下一次 React 渲染是否已经完成。
- 启动前还应同步刷新持久化安全状态，避免用过期的每日额度或冷却信息阻止/放行任务；AI 配置保存、额度复核和异常熔断仍由原批次状态机执行。
- 底部入口继续使用当前已识别快照并保留二次确认，只有顶部快捷入口执行“重新识别 → 刷新安全状态 → 直接启动”。

## 2026-08-11 猎聘顶部顺序投递入口

- 顶部按钮只应成为现有批次入口的快捷方式，不能绕过“确认并开始”、每日/单批额度、冷却、登录校验、运行互斥或异常熔断。
- 批次运行时顶部同一位置应提供停止入口，避免用户还要滚动到批次配置区才能中止。
- 猎聘主界面位于 `src/sidepanel/App.tsx`，顶部 `.hero` 当前只有状态徽标；现有批次入口由 `requestBatchStart()`、`confirmBatchStart()`、`stopBatch()` 三个函数构成，可直接复用。
- 顶部按钮采用三态最符合“点进来直接投”且不削弱安全边界：空闲显示“顺序投递”，第一次点击进入现有二次确认；确认态同一位置显示“确认并开始”；运行/等待/停止中显示“停止投递”。
- TypeScript 与生产构建已验证顶部三态函数进入最终 sidepanel 产物，`.hero-actions` 样式也已打包；入口仅改变可达性，没有新增后台消息或页面点击路径。
- 顶部入口在批次 `stopping` 状态显示“正在停止”并禁用重复点击；其它活动状态保持可点击停止，确认态则直接调用原 `confirmBatchStart()`。
- 0.5.4 对用户意图理解错误：顶部入口不应复用确认态，而应直接调用批次执行；为避免绕过校验，需要把启动前登录、候选岗位、冷却、任务互斥和当日额度检查提取成公共校验，同时供顶部直启与底部确认使用。
- 公共 `getBatchStartIssue()` 已同时接入 `requestBatchStart()` 与 `confirmBatchStart()`；顶部直启只跳过 UI 确认，不跳过任何启动校验或后台刷新后的安全阻断。
- 0.5.5 的顶部标签只保留“顺序投递/停止投递/正在停止”，源码中的“确认并开始”仅存在于底部批次确认区。

## 2026-08-11 猎聘附件简历同步确认

- 原 Java `get_jobs` 猎聘实现只点击“聊一聊”、等待聊天窗口并关闭，不发送简历，也不处理附件简历确认弹窗；其“继续聊即已投递”不能作为插件闭环依据。
- 真实页面弹窗根节点为 `.ant-im-modal[role="dialog"]`，正文含“选择附件简历/招聘方将同时收到”，确认按钮精确文本为“立即投递”且未禁用。
- 附件单选框在真实 DOM 中 `checked=true`，同时具有 `.ant-im-radio-wrapper-checked` 与 `.ant-im-radio-checked`；当前失败不是未选择简历。
- 旧实现把 `confirmResumeDialogIfPresent()` 放进 `waitForStepReceipt()` 的每轮回调，弹窗动作和简历卡片回执轮询耦合，容易在 React 重绘或延迟挂载时产生状态竞争与错误诊断。
- 0.5.3 将一次简历投递总超时分配给四个串行阶段；任一阶段检测到本人简历卡片可直接确认成功，检测到停止、验证或登录失效则终止，弹窗/按钮歧义与关闭超时均返回 unknown 并保留页面现场。

## 已知背景

- 当前 Java 项目使用 Spring Boot、Playwright、SQLite 和 Next.js。
- BOSS 已在当前 fork 中关闭。
- 智联已修复明显等待单位错误与成功确认逻辑，但真实账号闭环尚未验收。
- 用户决定先迁移成熟度更高的猎聘闭环，再处理智联。

## 待核验

- 猎聘现有 Worker 的入口、状态机和停止机制。
- 猎聘登录、搜索列表、详情页与投递结果选择器。
- 现有配置字段、黑名单和数据库记录结构。
- 前端可复用的配置表单和统计展示。

## 猎聘 Java 闭环

- 入口为 `LiepinJobService.executeDelivery()`：检查页面、登录状态和运行状态，读取配置，暂停登录监控后执行 Worker，finally 恢复状态。
- `Liepin.execute()` 监听猎聘搜索接口 `com.liepin.searchfront4c.pc-search-job`，从响应解析岗位、公司、招聘者并批量保存快照。
- 搜索条件首期只有 `keywords`、`cityCode`、`salary`；搜索页从第 0 页开始，使用 Ant Design 分页器翻页。
- 投递按钮主要识别“聊一聊”；“继续聊”在旧逻辑中直接视为已投递。
- 旧逻辑看到聊天头 `.__im_basic__header-wrap` 后标记成功；关闭聊天窗失败时也会把“可能成功”写成已投递，这一点迁移时必须收紧。
- 停止机制只是 `shouldStop` 标志；插件版需要持久化任务状态，避免 MV3 后台休眠后重复执行。

## 猎聘数据与 UI

- 配置字段：`keywords`、`city`、`salaryCode`；关键词兼容 JSON 数组和逗号分隔字符串。
- 岗位记录字段：岗位、公司、招聘者信息，以及 `delivered` 0/1 和创建/更新时间。
- 原前端操作包括登录状态、保存配置、启动、停止、退出、列表、筛选、统计和 CSV 导出。
- 插件首期保留配置、当前页面岗位识别、单岗位投递、开始/停止、历史记录；复杂统计图表可在闭环后补充。

## 首期迁移修正

- “继续聊”只能记录为 `already-contacted`，不能与本次新投递成功混为一谈。
- 只有聊天窗口/平台提示明确出现，且岗位与当前目标一致时，才记录 `delivered`。
- 验证码、登录失效、按钮缺失和页面结构变化都必须成为显式结果，自动停止任务。

## 独立审查与竞态修复

- 停止请求与成功结果可能并发，旧实现会把刚成功的任务覆盖为取消；已改为只在相同 `taskId` 且状态仍为 `stopping` 时完成取消。
- 两个侧边栏可能同时从 `idle` 启动；已在 Service Worker 中加入串行状态变更队列。
- 旧标签页的迟到结果可能覆盖新任务；所有投递、停止、失败和落库消息现均携带并校验唯一 `taskId`。
- 侧边栏关闭或消息链路失联可能让任务永久运行；已加入一分钟 `chrome.alarms` 看门狗，超时进入 `interrupted`。
- IndexedDB 完成事件监听原先存在潜在注册时序风险；现于发起读写请求前创建事务完成 Promise。

## 真实 Chrome 首次验收反馈

- 插件已启用，但猎聘网页没有任何可见控件。
- 真实 Chrome 进一步核验发现截图页为 `https://c.liepin.com/`，首版 Manifest 仅匹配 `https://www.liepin.com/*`，因此 Content Script 根本没有注入；这是页面无控件的直接技术根因。
- `c.liepin.com` 首页实际可匹配 `div[class*='job-card-pc-container']` 40 个，现有岗位卡片选择器可继续使用。
- 修正方案：Content Script 使用 Shadow DOM 注入固定悬浮按钮；用户点击后由 Service Worker 调用 `chrome.sidePanel.open()`。
- Manifest 的权限和内容脚本匹配范围改为全部猎聘 HTTPS 子域 `https://*.liepin.com/*`，并兼容裸域。

## 真实 Chrome 第二次验收反馈

- 已联系岗位在卡片上直接显示“继续聊”，插件可以识别并允许点击。
- 未联系岗位默认只显示招聘者头像和姓名，“聊一聊”需要悬停招聘者区域后动态出现；首版侧边栏因 `buttonText` 为空而禁用投递按钮。
- 修复目标：识别阶段不再因按钮尚未出现而禁用岗位；执行阶段先激活招聘者区域并等待目标按钮挂载，再区分“聊一聊”和“继续聊”。

## 原版猎聘与 AI/简历能力核验

- 原版 `Liepin.submitJob()` 只点击“聊一聊”、等待聊天窗口并关闭窗口；源码注释明确说明猎聘会自动发送账号中配置的招呼语。
- 原版猎聘配置只有关键词、城市和薪资，不注入 AI 服务，也没有填写消息或发送简历附件的实现。
- 原版 README 要求用户在猎聘 App 中设置默认或自定义招呼语；因此本次验收看到自定义招呼符合原版行为，不是插件迁移遗漏了既有 AI 能力。
- 原版的“成功”实际只是建立聊天，不代表简历已发送；插件后续需要把建立沟通、消息发送和简历发送拆成三个独立结果。

## boss-helper 参考边界

- boss-helper V2 的 AI 招呼与 AI 回复只生成草稿；生成后会校验非空、非“需人工判断”、不超过 150 字和 3 句话。
- boss-helper V2 明确硬性关闭自动消息发送，要求用户复制草稿后人工发送；当前代码没有自动发送简历附件。
- 它绕过页面控件的是 BOSS 私有 `friend/add` 接口，用于发起沟通/投递，并通过页面登录态令牌鉴权；聊天 WebSocket、上传接口和简历协议字段虽有定义，但未组成活动发送链路。
- 猎聘若要完全绕过控件发送，必须单独抓取并维护猎聘私有请求的地址、参数、CSRF/签名和成功回执，不能直接复用 BOSS 的接口实现。

## 建议实现边界

- 首先实现 AI 草稿：结合岗位、公司、招聘者和用户简历摘要生成个性化招呼，展示给用户预览、编辑和确认。
- 确认后使用猎聘当前聊天输入框与发送按钮完成消息发送，并等待页面明确回执；AI 生成可不操作页面，但真正发送仍需页面控件或猎聘私有接口二选一。
- 简历发送作为独立步骤：识别可用简历入口、触发附件发送并等待成功回执，失败时不得把任务记为完整成功。
- 私有接口直发仅作为实验能力：先通过诊断模式记录用户手动操作产生的网络请求，再判断签名稳定性、风控与账号风险。
- AI 招呼收益不能由仓库代码推断，应按回复率、有效回复率和面试转化率做 A/B 验证；通用 AI 文案未必优于已调优的固定招呼。

## 阶段 11 真实猎聘页面控件

- 当前已登录 Chrome 的猎聘首页存在已打开聊天窗口，可直接读取到文本框占位符“请输入文字，按Enter键发送”和独立“发送”按钮。
- 聊天窗口存在“发简历”入口，已有消息记录同时显示招呼语和简历卡片；简历卡片包含“俞玮康的简历”“在线简历”“附件简历”等可用于阶段回执的可见证据。
- 页面证明文本发送与简历发送是两个独立动作，后续 Content Script 必须在当前聊天窗口内限定选择器和回执基线，避免匹配历史聊天或全局旧提示。
- 真实页面只用于只读 DOM 核验，本阶段未点击发送、发简历或任何岗位沟通按钮。
- 当前聊天根容器为 `.im-ui-chat-container`；文本框为 `textarea.im-ui-textarea[placeholder*='请输入文字']`，发送按钮为 `button.im-ui-basic-send-btn`。
- 简历入口的可操作元素为 `.im-ui-action-button.action-resume`，位于 `.chatwin-action`；该入口可能直接产生外部发送，因此只读核验时未点击。
- 当前自己发送的文本消息结构包含 `.im-ui-txt.send .im-ui-txt-content .text`，可通过发送前后同文案计数增长确认文本回执。
- 旧版 `.__im_basic__header-wrap` 在当前聊天 DOM 中不存在；新的沟通成功证据应优先使用可见 `.im-ui-basic-chat-modal .im-ui-chat-container`。

## 阶段 11 实现落点

- 当前侧边栏点击岗位后立即创建任务并发送 `APPLY_LIEPIN_JOB`，预览确认必须前移到任务不可逆点击之前。
- AI 请求适合由 Service Worker 执行：侧边栏只提交岗位快照并接收草稿，Content Script 只接收最终确认后的招呼文本和“是否发送简历”指令。
- 草稿不写入 IndexedDB 投递历史；历史只记录三个阶段的结果与证据摘要，避免长期保存完整 AI 输入和 API 密钥。
- 当前任务看门狗只有一分钟；AI 生成发生在任务创建前，因此不会因模型响应耗时占用或触发投递看门狗。
- 配置需要补充 OpenAI 兼容 Base URL、模型、API 密钥、个人简历摘要、预览确认默认开关和发送简历开关。
- Chrome MV3 的跨域 `fetch` 必须具备目标主机权限；采用 `optional_host_permissions` 并在用户保存 AI 配置的手势中只申请实际 Base URL 的 origin，避免安装时获取全网访问权。
- 简历发送回执可在当前聊天容器内统计 `.im-ui-txt.send .im-ui-send-attachment-card`；真实页面的卡片标题类为 `.im-ui-send-attachment-card-info-title`。

## 阶段 11 独立复核修正

- 草稿生成是异步操作，必须把待确认草稿、任务启动、页面执行和停止消息绑定到用户点击岗位时的原始 `tabId`，不能再次查询当前活动标签页。
- 文本或简历点击后若没有检测到 DOM 回执，只能标记为 `unknown/blocked` 并要求人工核对，不能标记失败后鼓励重试，否则存在重复消息或重复简历风险。
- 沟通成功必须同时确认当前聊天窗口包含所选岗位标题，避免其他会话窗口被误判为本次岗位。
- AI Base URL 额外拒绝内嵌用户名和密码；旧配置读取按字段类型回退安全默认值；侧边栏提供本机 API Key 清除入口。
- 简历确认弹窗可能延迟出现，回执轮询期间只允许点击唯一且文字明确的简历确认按钮。

## 0.2.0 AI 配置验收反馈

- AI 区域显示模型和已输入的密码型 API Key，但“Key 未配置”仍为红色，说明输入值只存在侧边栏 React 状态，尚未写入后台密钥存储。
- 当前唯一“保存”按钮位于“猎聘检索条件”区域顶部，与 AI 配置区域视觉距离较远，用户合理地认为 AI 表单会即时生效或拥有独立保存入口。
- “生成草稿”直接调用后台生成接口，后台只读取已持久化密钥；未保存时请求立即失败，所以按钮只闪烁一次忙碌态后恢复。
- 顶部任务状态属于上一轮投递任务，不属于草稿生成流程；草稿失败不应继续突出陈旧的投递失败消息。
- 后台保存键名与生成读取键名一致，问题不是存储键错配，而是生成按钮没有先持久化当前表单中的 Key。
- 智谱官方 OpenAI 兼容常规 Base URL 为 `https://open.bigmodel.cn/api/paas/v4`，Coding Plan 为 `https://open.bigmodel.cn/api/coding/paas/v4`；当前 URL 拼接逻辑会错误追加 `/v1/chat/completions`，需要改为在任意非空版本路径后直接追加 `/chat/completions`。
- 截图中的 `glm-5-2-260617` 与 `https://api.openai.com/v1` 明确不匹配；界面应在保存或生成前给出可操作提示，而不是让请求瞬时失败。
- 旧投递结果不应删除，因为它对应真实验收历史；顶部应标记为“上次失败”，草稿生成则使用独立的“生成中/待确认/草稿失败”状态。
- 用户后续改用 `http://127.0.0.1:3001/v1`，该地址属于插件允许的本机 HTTP 兼容接口，预期完整请求为 `http://127.0.0.1:3001/v1/chat/completions`；它仍出现 Key 未配置，排除了 GLM/OpenAI 公网 Base URL 错配是当前红色状态的唯一原因。

## 0.2.2 AI 超时配置

- 当前 `generateGreetingDraft()` 将 30 秒写死为 `30_000`，侧边栏、持久化配置和旧配置迁移都没有超时字段。
- 本机 GLM 或代理首次加载模型可能明显超过 30 秒；新安装及旧配置回退值调整为 120 秒，并允许用户在 AI 模块配置 10 至 600 秒。
- 超时值必须在后台读取与保存时归一化，不能只依赖 HTML 数字输入框约束；最终错误信息应包含本次实际等待秒数。

## 0.2.3 聊天窗口绑定验收反馈

- 岗位卡片标题为“大模型应用工程师【杭州-浦沿】”，聊天窗口标题只显示“大模型应用工程师”；公司均为“中控技术”，截图证明平台会在聊天头移除卡片标题中的地区后缀。
- 新聊天窗口已经打开，猎聘账号默认招呼“Hello！对这个机会超感兴趣的，希望能有进一步了解的机会。”也已自动发送；插件随后在岗位绑定校验处停止，所以没有填写或发送 AI 草稿，也没有进入简历发送步骤。
- 修复不能简单删除岗位绑定保护，应使用规整后的核心岗位名并结合公司名，避免把右侧其他历史会话误认作当前目标。
- 当前真实 DOM 只有一个可见 `.im-ui-basic-chat-modal .im-ui-chat-container`，其文本明确包含聊天岗位“大模型应用工程师”和公司“中控技术”，但不包含卡片完整标题中的“【杭州-浦沿】”。
- 当前目标聊天的发送方文本节点只有平台默认招呼和“这是我的简历，合适的话可以随时联系我～”，没有 AI 草稿；同时已存在一个 `.im-ui-send-attachment-card` 简历卡片且“发简历”入口仍可见。
- 插件在岗位绑定失败后已提前返回，不可能执行自身的 AI 与简历步骤，因此现有简历卡片来自平台自动行为或其他非本轮插件步骤；修复后必须把“当前聊天已存在简历卡片”视为无需重复点击的成功证据。
- 当前聊天弹窗及前 120 个后代节点未暴露可用的 jobId、positionId 或岗位链接，无法用 `jobId=79800975` 做更强绑定；现阶段最稳定的可见证据仍是核心岗位名与公司名组合。
- 精确标题也应在公司名存在时一起校验；只有剥离末尾 `【地区】` 后产生的核心标题匹配时，必须要求公司名同时匹配，不能把所有括号内容都删除，因为“（临床试验方向）”等可能属于岗位核心名称。

## 0.2.4 猎头岗位与页面顺序投递反馈

- 新截图岗位卡片标题和聊天头都以省略号截断为“AIGC资深图像算法…”，聊天中只有平台默认 Hello 招呼，没有 AI 草稿文本，也没有可见简历卡片。
- 招聘者头部显示猎头公司“杭州速聘专猎人力资源服务…”，岗位信息区显示用人公司“某杭州计算机软件公司”；匹配逻辑不能把招聘者所属猎头公司误当作岗位公司。
- 当前页面批量能力必须复用单岗位的 AI 生成、沟通、消息和简历回执，不能用无回执的连续点击替代；应顺序执行、每岗关闭聊天后再随机等待、遇到未知结果立即停止，避免重复外部消息。
- 批量启动属于一次明确的用户授权，但实现与本轮开发验收不得实际点击岗位或发送消息。
- 当前真实 DOM 快照并未截断关键值：首张卡片和聊天岗位的可访问文本均为完整“AIGC资深图像算法工程师”，聊天岗位区也包含“某杭州计算机软件公司”；若 0.2.3 Content Script 已真正重新加载，标题匹配应成功，因此本次还需继续核验 AI 文本写入/发送按钮阶段以及实际加载版本。
- 实际复现现有 `TITLE_SELECTORS` 后找到直接根因：最高优先级 `a[data-nick='job-detail-job-info']` 的 `textContent` 为“岗位名【地区】薪资经验学历”，所以保存的 `jobTitle` 并非截图显示的纯标题；0.2.3 只会剥离位于字符串末尾的 `【地区】`，面对后续薪资字段仍然匹配失败。
- 同一卡片的 `[class*='job-title']` 节点文本仅为“岗位名【地区】”，应提高其优先级并继续由匹配函数剥离地区；这比为错误的“标题+薪资+经验”快照增加模糊前缀更可靠。
- 顺序投递采用侧边栏内存队列，不在页面刷新、侧边栏关闭或浏览器重启后自动恢复，避免不确定状态下重复发送；每个岗位仍创建独立持久化任务和投递记录。
- 批量候选会冻结为确认时的当前页快照，并跳过识别时明确显示“继续聊”的岗位；其他岗位逐个生成 AI 文本、执行沟通/招呼/简历闭环，只有 `delivered` 或 `already-contacted` 才进入下一项。
- 批量模式不能同时保留逐岗位草稿弹窗，否则无法无人值守顺序运行；界面改为批量启动前二次确认，并明确说明该次授权会直接发送每岗 AI 草稿，单岗位模式仍保留默认预览编辑。

## 0.2.5 附件简历确认弹窗反馈

- 最新截图证明 0.2.4 已越过岗位绑定与 AI 消息步骤，并进入独立简历发送阶段；当前阻断点是猎聘新增/变化的二次确认弹窗。
- 弹窗标题为“选择附件简历”，提示“招聘方将同时收到您的默认在线简历和附件简历”，已有一个单选附件，最终外部动作按钮文字为“立即投递”。
- 修复必须将“点击发简历”和“点击立即投递”视为两个独立动作，且最终仍以当前聊天内本人简历卡片数量增长作为成功回执，不能仅凭弹窗关闭判定成功。
- 当前已登录 Chrome 的只读 DOM 核验确认弹窗为唯一 `[role='dialog'].ant-im-modal`，完整可访问名称包含“选择附件简历”；附件单选框已经 `checked=true`，插件无需重新选择附件。
- 弹窗中有两个无文本关闭按钮和唯一有文本主按钮 `button.ant-im-btn-primary`，其精确文字为“立即投递”、`disabled=false`；因此应继续使用“简历弹窗 + 精确按钮文案 + 唯一可见启用候选”的收紧条件，不需要扩大到模糊文本或位置选择器。
- 独立代码复核确认新实现无高风险误点：确认动作最多执行一次，而最终成功仍只由当前聊天新增本人简历卡片决定；理论上的其他弹窗结构差异不应在没有真实 DOM 证据时扩大自动点击范围。

## 0.2.6 顺序投递账号安全护栏

- 0.2.5 已有基础保护：单线程顺序执行、默认 15–45 秒随机间隔、未知回执/验证码/登录失效立即停止、批次不自动恢复；但尚无每批上限、每日累计上限和连续成功后的长冷却。
- “防封号”无法被软件保证；可实现的是降低异常高频行为和失控批量的合规护栏。明确不做浏览器指纹伪装、验证码绕过、隐藏自动化特征或规避平台风控。
- 现有 Content Script 已把验证码、极验和“操作频繁”转换为 `blocked`，侧边栏对任何非 `delivered/already-contacted` 结果都会立即停批；无需重写熔断状态机，只需扩展少量强风险短语。
- 护栏状态采用 `chrome.storage.local` 持久化本机当日新投递数、连续成功数和冷却截止时间；后台在每次 `START_LIEPIN_TASK` 前原子检查，保证单岗位与批量入口都受同一限制。
- 默认策略定为单批最多 10、每日最多 30、每成功 5 个冷却 180 秒；批量队列按批次与当日剩余额度取较小值，`already-contacted` 不计入新投递额度。
- 独立审查确认单岗位与批量入口都会在后台创建任务前检查同一持久化护栏，重复或迟到回执不会重复累计；跨午夜只重置每日/连续计数，尚未结束的绝对冷却时间继续生效。
- 侧边栏监听 `liepinSafety` 存储变化并重新从后台计算状态，保证多窗口之间同步每日额度和剩余冷却。

## 0.2.7 自定义提示词与招呼语长度收口

- 当前 `generateGreetingDraft()` 把 system/user 两段提示词写死在后台，AI 配置只有接口、模型、超时、简历摘要与发送开关，因此现状不支持用户完整控制写作要求。
- 当前模型只收到自然语言的“最多 150 字、最多 3 句话”约束；模型偶发不遵守后，`validateGreetingDraft()` 会直接抛出“超过 150 字”，这正是用户反馈偶发成功、偶发失败的根因。
- `boss-helper-v2` 支持角色消息数组和 `{{ variable }}` 模板渲染，默认模板明确要求 80–130 字、绝对不超过 150 字；但它的运行时校验仍是超限即跳过，没有自动压缩机制。
- 本插件采用更适合当前轻量 UI 的单一完整提示词模板：用户可编辑全部业务写作要求，并使用岗位、招聘者、简历摘要等白名单变量；程序始终追加不可关闭的“纯文本、最多 150 字”平台约束。
- 长度处理采用两层收口：首次生成若超出 150 字或 3 句，自动发起一次压缩请求；压缩结果仍超限时只删除尾部内容并规范标点，保证不会再因纯长度问题阻止发送。空文本和“需人工判断”仍必须停止。
- 现有保存/读取链路在 `background/index.ts` 中逐字段白名单化；新增 `promptTemplate` 时必须同时覆盖默认配置、旧存储迁移、保存响应和侧边栏表单，避免再次出现“表单可见但后台未保存”的历史问题。
- 预览确认仍会对用户手工编辑文本执行 1–150 字限制；生成阶段的自动压缩只处理模型输出，不放宽最终发送硬校验。
- 0.2.7 自动化回归覆盖自定义变量渲染、未知变量报错、简历摘要按需校验、首次超限二次压缩、压缩失败回退和最终长度/句数约束，共 30 项测试通过。

## 0.2.8 GLM 空响应回归

- 用户提供的简历摘要包含 4 年经验、医院项目、Agent/RAG 技术栈与多项量化成果，信息明显充足；“请补充个人简历摘要”属于通用错误文案误判，不应归因于用户配置。
- 0.2.7 相比此前成功路径新增了固定 `max_tokens: 256`。对带推理过程的兼容模型，该额度可能在生成最终 `content` 前耗尽，形成 HTTP 成功但正文为空；长度安全已有后置压缩与硬校验，不需要用低 token 上限承担字符限制。
- Git 版本对比确认 0.2.6 的成功请求只包含模型、温度、流式开关和消息，`max_tokens: 256` 确为 0.2.7 引入的回归变量；0.2.8 恢复为不主动限制模型输出 token，再由已有压缩链路收口字符数。
- 新错误分类不再把所有无效文本归因于简历摘要：空 `content` 提示检查模型最终正文/非推理模式，明确的“需人工判断”才提示调整自定义提示词或补充该提示词所需信息。

## 0.2.9 单岗位动作节奏

- 当前内容脚本的单岗位内部等待主要是 React 轮询：滚动后固定 180ms、输入后每 80ms 检查按钮、回执每 120–150ms 检查；一旦节点立即出现，聊天点击、文本发送、简历点击、确认弹窗和关闭聊天会连续完成。
- 当前随机配置只作用于两个完整岗位之间，默认 15–45 秒；因此“内部瞬时、岗位间长停顿”的结构与用户真实验收一致。
- 合规修复应把可配置随机稳定等待放在不可逆动作边界：滚动/悬停后点击沟通、聊天建立后写入招呼、写入后点击发送、招呼回执后点击简历、弹窗出现后点击确认、简历回执后关闭聊天。
- 动作等待用于页面稳定、给停止/验证信号留出响应时间；不实现鼠标轨迹伪造、指纹隐藏、验证码绕过或其他规避平台检测能力。
- 由于单岗位内部将新增多段等待，岗位间默认值可从 15–45 秒缩短为 5–15 秒；每日上限、每 5 个长冷却和异常熔断继续保留，不能用缩短岗位间隔绕过安全额度。
- 原任务看门狗固定为 1 分钟；当用户把动作间隔配置到允许的 10 秒上限时，六段等待叠加页面回执可能超过一分钟并被后台误判失联，因此看门狗需同步放宽到 3 分钟。
- 简历确认弹窗的动作等待发生在回执轮询内部；回执超时必须额外加上动作最长等待预算，否则配置 10 秒时可能刚点击“立即投递”就立即超时。

## 阶段 23 首页注入式主界面初步评估

- 当前扩展的 Side Panel 由 Manifest `side_panel.default_path`、`sidePanel` 权限和后台 `chrome.sidePanel.open()` 组成；猎聘 Content Script 已经使用 Shadow DOM 注入一个悬浮入口，因此具备把完整 React UI 挂入网页的基础。
- `boss-helper-v2` 的核心界面不是 Chrome Side Panel，而是在 Content Script 中创建宿主节点、附加开放 Shadow Root、注入独立样式，再把 Vue 应用挂载到 Shadow DOM 容器。
- 初步看，配置、任务编排、AI 请求和后台持久化无需迁移到页面上下文；可继续通过 `chrome.runtime.sendMessage` 使用现有 Service Worker，只替换 UI 的挂载载体。
- 当前 React 界面直接调用 `chrome.tabs.query/get/sendMessage`、`chrome.permissions.request` 和 `chrome.storage.onChanged`。注入页面后仍处于 Content Script 的隔离世界，`chrome.runtime` 与存储 API 可用；但 `chrome.tabs`、动态主机权限申请以及“当前标签页”解析不宜由页内 UI 直接承担，需要改为后台消息代理或直接绑定当前 Content Script 所在标签页。
- 当前构建把 React Side Panel 交给 Vite，把猎聘 Content Script 单独打成 IIFE。若把完整 React UI 注入页面，需要新增一个可被 Content Script 引入的页内 React 入口，并把 CSS 以内联文本或构建产物方式送进 Shadow Root；这属于构建与挂载层改造，不涉及投递状态机重写。
- `boss-helper-v2` 使用自定义元素管理挂载/卸载，并在断开 DOM 时主动 `app.unmount()`；它同时把弹窗 portal 指向 Shadow Root 内容器，避免弹窗逃逸到网页 DOM。React 版本也应具备显式 unmount 和 Shadow Root 内的弹层容器。
- 当前 Side Panel 样式把 `:root`、`body` 和全局元素选择器作为隔离前提；迁入网页时不能原样把 CSS 放入 document，必须注入 Shadow Root，并将根背景、最小宽度与滚动容器改为面板宿主范围，否则会污染猎聘页面或出现高度/滚动异常。
- 页面注入本身不会改变现有投递、AI、简历与回执协议，账号风险基本不因“显示位置”增加；风险主要是前端兼容和误操作。继续使用现有页面控件自动化时，平台风控风险与当前 Side Panel 版本相同。
- 推荐采用“固定浮层抽屉 + 悬浮按钮开关”，不修改猎聘主内容区宽度和 margin。若模仿 boss-helper 直接插入岗位布局并挤压页面，猎聘聊天抽屉、响应式栅格和 SPA 改版会显著提高布局回归风险。
- 最低回归方案是在现有 Shadow DOM 宿主中注入固定抽屉，并用仅对猎聘域开放的 `chrome-extension://.../sidepanel.html` iframe 承载现有 React 应用。这样 `chrome.tabs`、`chrome.permissions.request`、存储监听和现有样式都继续运行在扩展页面上下文，避免为纯 Content Script 重写权限与标签页适配层。
- Manifest 需要把 `sidepanel.html` 及其构建资源声明为仅猎聘匹配的 `web_accessible_resources`；后台插件图标点击改为向当前猎聘 Content Script 发送显示/隐藏消息。完成真实验收后再移除 `sidePanel` 权限、`side_panel` 声明和 `OPEN_SIDE_PANEL` 分支。
- 注入抽屉建议固定在右侧、独立滚动、可折叠并支持 Esc 关闭；必须设置明确的 `pointer-events` 边界，避免透明宿主遮挡猎聘岗位卡片。不要修改猎聘 `.recommend-result-inner` 一类站点节点的 margin。
- 现有 Content Script 宿主挂在 `document.documentElement`，猎聘 SPA 的普通路由切换不会替换该根节点；仍应增加宿主丢失后的幂等重挂载和卸载清理，防止站点脚本清理未知节点后入口消失。
- 风险结论：固定 iframe 抽屉的实现/兼容风险为中低，原生 React 直接挂 Shadow Root 为中等，照搬 boss-helper 的页内插入并挤压主内容为中高；三者都不会自然降低或升高现有自动投递账号风险。

## 阶段 24 首页注入式主界面实现依据

- Chrome 官方 MV3 文档确认，网页导航到扩展资源时该资源必须列入 `web_accessible_resources`；资源路径支持 `*` 通配符，并可通过 `matches` 只向猎聘来源开放。Content Script 可用 `chrome.runtime.getURL()` 生成 iframe 地址。
- Chrome 官方 `chrome.action` 文档确认，无 popup 的工具栏图标可通过 `action.onClicked` 接收当前标签页并触发 Content Script，因此移除 Side Panel 后可把图标改为页内抽屉开关。
- 为减少资源暴露，只声明 `sidepanel.html` 与 Vite `assets/*`，匹配范围继续限制为现有猎聘域；不扩大 host permissions，也不引入远程脚本。
- 当前 Content Script 只在文件末尾调用一次 `mountPageLauncher()`，宿主直接挂在 `document.documentElement`；实现抽屉时可复用该稳定宿主，并增加幂等恢复观察器，不需要监听或修改猎聘业务容器。
- 当前后台只有三处 Side Panel 耦合：`OPEN_SIDE_PANEL` 消息分支、安装时 `setPanelBehavior`、启动时 `setPanelBehavior`。移除这些分支后，新增 `chrome.action.onClicked` 向当前猎聘标签页发送 `TOGGLE_EMBEDDED_PANEL` 即可。
- 现有 Vite 继续构建 `sidepanel.html` 与 `assets/*`，无需改变输出模型；页面注入只需通过 Manifest 开放这些现有产物。iframe 方案不会把约 224KB React bundle 合并进 37KB Content Script。
- 抽屉关闭采用隐藏而非卸载 iframe，以保留配置表单和批次内存状态；因此关闭按钮必须明确标为“收起”，文档也需说明收起不会停止正在运行的批次，停止仍使用界面内的专用控件。
- 0.3.0 最终产物校验确认：源 Manifest 与 `dist/manifest.json` 均无 `side_panel`、`sidePanel` 权限和旧消息分支；iframe HTML 引用的两个 Vite 资源均存在，网页可访问范围仅为猎聘域。

## 阶段 25 抽屉宽度与 MiniMax 输出反馈

- 截图显示 0.3.0 页内抽屉右侧内容被裁切，底部出现横向滚动条；需要同时提高桌面端抽屉宽度并核对 React 表单中双列网格、长提示词说明和按钮区域的最小宽度，不能只用 `overflow-x: hidden` 掩盖内容。
- 当前报错明确发生在 AI 草稿生成/校验阶段，而不是猎聘页面消息发送阶段。用户使用 `MiniMax-M3`，其兼容响应偶尔可能输出包装文本、特殊结构或模型自行返回“需人工判断”，需核对当前提取和判定代码后再修。
- 兜底只应用于 API 请求失败、响应无法提取、模型拒绝/需人工判断或草稿格式无效等“发送前”错误；页面发送点击后若回执未知仍必须停止核对，禁止用兜底再次发送造成重复消息。
- POST 日志采用两级策略：始终记录 URL、模型、超时、消息角色/长度、HTTP 状态、耗时与错误摘要；完整请求/响应仅在用户显式开启详细日志时保留有限条数，Authorization/API Key 永不记录。
- 直接根因不是 MiniMax 的 HTTP JSON 格式：当前固定系统提示词明确要求“不能满足时输出‘需人工判断’”，而后置校验器又把这句话当作致命错误；两者互相矛盾，模型只要遵循前者就会终止批次。
- MiniMax 官方 OpenAI 兼容接口仍以 `POST /v1/chat/completions` 和 `choices[0].message.content` 返回最终正文；官方也说明部分推理模型可把推理内容放在单独字段。因此本轮保留兼容端点，同时加强对正文中 JSON/代码块包装的提取，不把推理文本误作招呼语。
- 当前抽屉桌面宽度为 430px，悬浮入口打开时偏移 462px；表单双列 Grid 子项没有 `min-width: 0`。扩大抽屉时必须同步入口偏移，并为 Grid/Flex 子项补充收缩规则。
- 诊断的真实密钥不只要避开 Authorization 字段，还要防止上游响应或网络错误意外回显；持久化前应对请求、响应与错误文本再次按当前 Key 替换为 `[REDACTED]`。

## 阶段 26 与 boss-helper-v2 合并初步发现

- 两者都是 Manifest V3 扩展，域名天然互斥：`boss-helper-v2` 只匹配 BOSS，`get_jobs-extension` 只匹配猎聘；单一 Manifest 同时声明两组 Content Script 和 host 权限在技术上可行。
- 最大差异不是平台逻辑，而是工程底座：BOSS 使用 WXT + Vue 3 + Nuxt UI + Tailwind Shadow DOM，并同时构建 Chrome/Edge/Firefox；猎聘使用手写 Vite/esbuild + React 19，仅面向 Chrome。
- `boss-helper-v2` 已包含更完整的多模型、日志、统计、配置导入导出、IndexedDB、跨浏览器构建与发布设施；猎聘则拥有更严格的分阶段回执、任务看门狗、每日配额和页面注入 iframe 抽屉。若做长期单插件，优先以 BOSS 的 WXT 仓库作为宿主，比把 BOSS 大量 Vue/WXT 能力迁入轻量 React 工程成本更低。
- 不建议把两个现有产物简单拼进同一 ZIP，也不建议长期并存两套 Service Worker；那会导致 Manifest、消息路由、存储权限、版本和工具栏行为难以统一。应当保留一套 WXT 后台和 Manifest，在其上注册 `boss`、`liepin` 两个平台适配器。
- `boss-helper-v2` 当前工作树已有用户变更：跟踪文件 `boss-helper-v2-0.6.0.zip` 被删除。本轮只读评估必须保留该状态，不在 BOSS 仓库写入或提交。
- BOSS 的页面链路分成 ISOLATED Content Script 与注入 MAIN world 的 `boss.js`，通过 `comctx` 和 V2 namespace 通信；猎聘完全运行在 ISOLATED Content Script，并用扩展 iframe 承载 React UI。统一插件不能让猎聘复用 BOSS 的 MAIN-world 请求机制，平台入口应继续分开。
- BOSS 的 `HelperContext<C,T,S>`、`DeliveryWorkflow`、模型/配置 composable 和日志已经具备一定通用抽象，但当前 Vue 组件、FormData、存储键和文案仍以 BOSS 为中心。可复用的是基础设施和页面容器，不宜强行让猎聘立即改写成同一套投递状态机。
- 两边都有 IndexedDB，但用途和库不同：BOSS 的 `BossHelperV2DB/images` 保存图片简历，猎聘的原生 IndexedDB 保存投递记录。只要保持不同数据库名即可共存，合并首期无需做危险的数据迁移。
- 两边都已经实现 AI 兜底和“发送后未知不重试”边界，但模型配置结构、诊断粒度、默认开关不同。首期应保留平台独立配置，后续再抽象共享 Provider，避免一次合并同时改变真实投递行为。
- WXT 生成的 Chrome Manifest 目前已有一个后台、两个 BOSS Content Script 和一个 `options_ui`；增加猎聘 Content Script 与网页可访问 UI 资源不存在结构限制，但猎聘的 alarm 看门狗、工具栏 action 和可信存储访问级别必须显式迁入这一个后台。
- BOSS 页面主体运行在 MAIN world，并依赖站点 Vue 实例、内部请求和 MQTT；猎聘只依赖可见 DOM。两者不能共享同一页面适配器，但可以共享后台注册器、平台类型和 AI 请求设施。
- 合并后无需强求统一视觉：BOSS 继续使用页面内宽列表，猎聘继续使用右侧固定抽屉。用户要求的“一个插件”可以先落实为一个安装包、一个扩展身份和一套构建发布，而不是同时重写两个成熟页面 UI。
- 许可证是重要发布约束：`boss-helper-v2` 为 MIT；`get_jobs-extension` 当前没有 LICENSE，但原 `get_jobs` 使用 GETJOBS-NC-1.0，仅允许非商业使用并要求保留署名。若猎聘实现包含原项目的派生代码，合并发行物不能整体宣称纯 MIT，必须保留 GET JOBS 非商业条款/署名并清楚标注哪些文件受其约束。
- 权限体验会发生变化：BOSS 当前安装时申请 `http://*/*`、`https://*/*`，猎聘当前仅固定申请猎聘域并对 AI 域采用 optional permission。合并若直接沿用 BOSS Manifest，会让猎聘用户看到全站访问权限；应单独评估把 AI/地图等外部域迁为可选权限，至少不要因合并进一步扩大权限。
- BOSS 当前没有正式单元测试脚本，主要依靠类型、lint、格式、构建和静态 smoke；猎聘已有 39 项 Vitest 回归。迁移时应保留猎聘测试，并把 WXT 的验证入口扩展为“单元测试 + 三浏览器构建 + smoke”，不能只依赖 BOSS 现有 smoke。
- 猎聘约 5,224 行、19 个 TS/TSX/CSS 文件，其中 UI `App.tsx` 约 1,300 行、Content Script 约 807 行、后台/AI 约 936 行；BOSS 源码约 12,929 行、80 个文件。以体量判断，把较小的猎聘模块迁入 BOSS 底座明显优于反向迁移。
- 猎聘跨浏览器适配的明确阻点是大量 `chrome.*` 直接调用以及 Chrome 专属 `storage.local.setAccessLevel()`；迁入 WXT 时可批量换成 `browser.*`，对 `setAccessLevel` 做能力检测，alarms/action/permissions 则通过 WXT Manifest 按浏览器声明。
- BOSS 当前用 Bun 锁文件，猎聘用 npm lock；统一仓库应只保留 BOSS 的 Bun/WXT 工具链，不能在同一根目录长期维护两个 lockfile。猎聘 Vitest 可以作为 WXT 仓库的 dev dependency/script 加入。
- 统一工具栏行为需要平台路由：猎聘页点击 action 切换抽屉；BOSS 页可定位/显示现有助手；其他页面打开统一 options。不能直接照搬猎聘当前“所有 action 点击都向当前 tab 发送 TOGGLE”逻辑。
- BOSS 仓库有 origin/upstream 和完整发布链，猎聘仓库当前没有远端；从版本管理与后续上游同步角度，也更适合在 `boss-helper-v2` 新建集成分支，而不是把 BOSS 历史搬入猎聘仓库。
- WXT 官方文档确认同一扩展可通过 `{name}.content.ts` 发现多个 Content Script，也支持 unlisted HTML page 和 `createIframeUi()`；因此猎聘现有“网页固定抽屉 + iframe 扩展页”可在 WXT 中原样表达，不需要先改成 BOSS 的页面内 Vue UI。
- WXT 官方同时确认可直接加入任意 Vite framework plugin，并为不同 entrypoint 创建独立应用实例；在现有 Vue module 之外增加 React Vite plugin、保留猎聘 React iframe 是受支持的过渡方案。长期是否转 Vue属于维护成本选择，不是合并前置条件。
- WXT 构建时会在 Node 环境导入 entrypoint 以读取配置，运行时代码必须放在 `main()` 内。迁移猎聘 Content Script 时不能直接复制当前文件末尾的全局监听/挂载代码，应包装为 `defineContentScript({ main(ctx) { ... } })` 并使用 ctx 做卸载/失效清理。
- Chrome 官方文档确认 `setAccessLevel()` 控制的是整个 storage area，`storage.local` 默认对 Content Script 开放；因此猎聘当前调用 `local.setAccessLevel(TRUSTED_CONTEXTS)` 会直接阻断 BOSS 的 `ContentCounter.storageGet/Set/Rm` 和 chat-monitor 对 local 的直接访问，不能原样合并。
- 推荐的安全解法不是移除猎聘保护，而是把 BOSS 的存储读写也收口到 Background：为 `BackgroundCounter` 增加 storage get/set/remove，`ContentCounter` 只转发；chat-monitor 改为通过明确消息让后台读取开关和入队。Chrome 支持时再统一设置 `TRUSTED_CONTEXTS`，Firefox 不支持时能力检测后跳过。这样合并反而能提升 BOSS 密钥隔离。
- 扩展存储按 extension ID 隔离。若以 BOSS 的固定 Manifest key/扩展身份发布，现有 BOSS 配置能延续，但旧 `get_jobs-extension` 的猎聘配置、API Key、投递历史无法被新扩展直接读取。合并前应先给猎聘增加脱敏配置导出，新插件提供导入；API Key 必须重新输入，不能导出。
- 迁移期间不能让旧猎聘插件与新合并插件同时启用在猎聘域，否则两套 Content Script/悬浮入口可能同时响应。验收流程应是导出配置 → 安装/更新合并版 → 导入并重填 Key → 禁用旧猎聘插件 → 单岗位验收。
- 现有 Chrome 产物体量约为 BOSS 2.27 MB（其中 MAIN-world `boss.js` 2.19 MB）、猎聘 315 KB；过渡期同时带 Vue 和 React 对安装包影响有限，远小于 BOSS 现有主 bundle，体量不是要求立刻重写 React 的理由。
- BOSS smoke 目前把版本、ZIP 文件名和大量源码路径/符号写死；合并后需改为平台化 smoke，同时断言 Manifest 同时包含 BOSS/猎聘匹配、猎聘 iframe 资源、alarms/action 权限、两个平台默认高风险开关状态及禁止 Cookie 权限。
- 猎聘当前构建强制 target `chrome120`，而 BOSS 还构建 Firefox/Edge。首个合并里程碑应先保证 Chrome 产物与猎聘真实验收，再逐步修正 Firefox 能力差异；不应在首次搬迁中宣称猎聘已跨浏览器可用。

### 合并方案比较

| 方案                                           | 结论     | 主要原因                                                                                                               |
| ---------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------- |
| 以 BOSS/WXT 为宿主，猎聘 React iframe 暂时保留 | 推荐     | WXT 官方支持多个 Content Script、unlisted iframe page 和额外 React Vite plugin；迁移面最小，能保持两个已验收 UI/状态机 |
| 以 BOSS/WXT 为宿主，同时把猎聘 UI 重写为 Vue   | 后续优化 | 长期技术栈统一，但首次合并会额外重写约 1,300 行 UI，真实投递回归面无必要扩大                                           |
| 以猎聘 Vite/React 为宿主迁入 BOSS              | 不推荐   | 需要搬迁约 1.3 万行 BOSS/WXT/Vue/MAIN-world/MQTT 代码并重建多浏览器发布体系                                            |
| 直接拼接两个现有 dist/ZIP                      | 不可持续 | Manifest、Service Worker、扩展身份、存储、工具栏和更新链无法仅靠文件复制正确合并                                       |

### 推荐的首期目录与运行边界

```text
boss-helper-v2（统一宿主）
├─ src/entrypoints/background.ts          # 唯一 Service Worker，注册两个平台后台
├─ src/entrypoints/content.ts             # 现有 BOSS isolated bridge，首期不重排
├─ src/entrypoints/boss/                  # 现有 BOSS MAIN-world 代码
├─ src/entrypoints/liepin.content.ts       # 新增猎聘 isolated Content Script
├─ src/entrypoints/liepin-panel/           # 新增 React iframe 页面
├─ src/platforms/liepin/background/        # AI、任务、alarms、数据库与消息处理
├─ src/platforms/liepin/shared/            # parser、resume dialog、safety 与类型
└─ src/platforms/shared/                   # 后台存储/消息注册等真正通用的少量设施
```

- 首期不移动现有 BOSS 大目录，避免破坏 upstream 合并；只新增猎聘目录并把后台入口拆成可注册模块。
- 消息必须带平台前缀或 `platform` 判别字段，后台监听器对未知消息返回 `undefined`，避免两个平台互相消费。
- 存储继续使用 `boss-helper-v2:*` 与 `liepin*` 独立 namespace；数据库继续保留 `BossHelperV2DB` 和猎聘数据库名。
- AI 配置首期独立，猎聘继续使用自己的提示词/超时/兜底/诊断；共享模型 Provider 放到合并稳定后的单独重构，不与搬迁耦合。

### 推荐实施顺序

1. 在 BOSS 基线创建独立集成 worktree/分支，保留当前仓库里用户删除 ZIP 的未提交状态；开发构建使用临时扩展 key，避免覆盖已安装 BOSS V2。
2. 先增加猎聘脱敏配置导出/导入协议，并把 BOSS 配置、模型和 chat-monitor 存储统一代理到 Background，解决 `TRUSTED_CONTEXTS` 冲突。
3. 在 WXT 中加入 React/Vitest，建立 `liepin.content.ts` 和 `liepin-panel.html` 空壳，先验收 Manifest、iframe 和 action 平台路由，不接真实投递。
4. 迁入猎聘 shared/parser/safety/database/AI/background，保持原存储 key、默认值、兜底和回执语义，跑完现有 39 项测试。
5. 迁入猎聘 Content Script 与 React UI；Chrome 上分别做 BOSS 无发送 smoke、猎聘只读识别，然后由用户进行一个猎聘岗位真实闭环。
6. 更新统一 ZIP、许可证/署名、安装迁移文档；确认旧猎聘插件已禁用，再把生产构建切回 BOSS 固定 Manifest key。
7. Chrome 稳定后再处理 Edge/Firefox 兼容和是否把猎聘 UI 改写为 Vue；智联适配排在统一插件稳定之后。

### 风险结论与工作量

- 技术可行性：高。WXT 官方能力覆盖所需入口和 iframe UI。
- 首期实现风险：中等。最大风险依次是 storage access level、旧扩展数据迁移、单后台消息路由和 Chrome-only API，不是页面选择器。
- 业务回归风险：中低，只要首期保留猎聘状态机和 React UI，不把它强行改写成 BOSS workflow。
- 发布/授权风险：中高，必须处理 GET JOBS 非商业许可证与署名，不能沿用纯 MIT 表述。
- 预计工作量：Chrome 单插件 MVP 约 4–7 个专注开发日并包含一次两平台验收；同时统一 Vue UI、AI Provider 和三浏览器行为通常还需额外 3–5 日。该估计不包含后续智联适配。

## 阶段 27 智联接入启动

- 用户已明确暂停统一插件合并，当前实现目标切回 `get_jobs-extension`。
- BOSS 继续关闭；智联与猎聘必须使用独立的页面适配器、平台状态和投递记录，避免智联改动破坏已经验收的猎聘闭环。
- 首先完成智联单岗位、明确回执的业务闭环；只有单岗位稳定后才开放当前页顺序投递。
- 当前 Manifest 只匹配猎聘域，且只有一个 `content.js`；智联接入需要新增独立 `zhilian-content.js` 构建入口，并把页内 iframe 资源单独开放给智联域，不能让猎聘内容脚本在智联运行。
- 当前插件名称、描述和 action 文案仍写死“猎聘助手”，阶段 28 需要改成平台中性的 Get Jobs 助手，同时由后台根据当前标签页把工具栏动作路由到对应平台内容脚本。
- 原 Java 智联实现当前已采用 `div.joblist-box__item`、`button.collect-and-apply__btn` 和 `a-job-apply-workflow` 等选择器，并已改为点击后等待明确结果；这些只能作为候选线索，必须以当前真实智联页面 DOM 验证后才能用于插件。
- 原 Java 当前成功文案包括“申请成功/投递成功”，风控文案包括“验证码/滑块验证/安全验证/人机验证”，失败文案包括“未设置默认简历/请先完善简历”；插件将沿用“未知即停止且不记成功”的边界。
- 本机 Browser Relay 服务已成功启动，但 Chrome 端当前没有附加标签页；因此本轮不能依赖已登录页面做 DOM 抽样，选择器实现必须采用多候选、可诊断、未知即停策略，并等待用户随后在智联页面进行只读/单岗位验收。
- 现有类型、后台存储键、任务状态、数据库记录和 React UI 全部以 `liepin` 命名；若一次性强行泛化会扩大猎聘回归面。智联首期应新增独立类型/Content Script/解析器，后台仅新增明确的智联消息路由，UI 再用平台分支展示。
- 当前 `scripts/build.mjs` 用 esbuild 把 `src/content/liepin.ts` 单独输出为 `content.js`；可平行增加 `src/content/zhilian.ts -> zhilian-content.js`，无需改变猎聘产物。
- 现有 `DeliveryResult`、AI 生成和数据库接口都绑定 `LiepinJobSnapshot`/`platform: "liepin"`。首期可把岗位快照抽成可兼容的公共字段并将平台扩为联合类型，但应保持所有猎聘存储键与 ContentRequest 名称不变。
- 当前 UI 的标签页识别、文案、按钮和批次逻辑高度绑定猎聘。智联第一阶段宜先提供单岗位识别与投递入口；在真实回执未验收前不复制批量按钮。
- 原 Java 智联闭环并没有 AI 招呼或聊天消息步骤，核心是岗位卡片上的“立即投递”与默认简历申请；因此智联首个可验收闭环应定义为“用户选择岗位 → 点击立即投递 → 等待申请成功/失败/验证/上限回执”，不虚构平台不存在的聊天链路。
- 原 Java 岗位卡片字段候选为 `a.jobinfo__name`、`p.jobinfo__salary`、`.jobinfo__other-info-item`、`.companyinfo__name`；按钮候选为 `button.collect-and-apply__btn`。仓库没有已保存的 `page.html`，这些选择器尚无当前页面样本佐证。
- 智联点击后可能在当前页渲染 `.a-job-apply-workflow`，也可能打开新标签页。Content Script 只能直接读当前文档，跨标签结果需要后台按 `openerTabId`/智联域定位新标签并向该标签的智联 Content Script 请求结果。
- AI 模块只依赖岗位的通用字段，可后续把入参从 `LiepinJobSnapshot` 收窄为公共岗位视图；但智联首期不应为了“复用 AI”改变其真实投递语义。
- 智联 MVP 使用 iframe 查询参数 `platform=zhilian` 路由独立 React 界面，因此无需重写猎聘 `App.tsx`；两个站点共享抽屉容器和样式，但业务组件、Content Script、任务存储与历史均分离。
- 跨标签回执只检查 `openerTabId` 等于原岗位列表标签且 URL 属于智联域的标签页，避免读取或误关联用户其它智联标签。
- 0.4.0 生产产物已确认包含猎聘 `content.js` 与智联 `zhilian-content.js` 两个互斥域入口；智联 Content Script 约 21 KB，未把猎聘约 56 KB 页面状态机打包进去。
- 静态成功路径没有关闭结果标签页、没有循环点击、没有未知结果重试；唯一不可逆动作是用户二次确认后的一次 `button.click()`。
- 提交前发现 `package-lock.json` 根版本仍为 0.3.1，属于版本一致性问题，已同步为 0.4.0。
- 申请结果必须与本次点击建立因果边界：点击前记录当前工作流文本与既有 `openerTabId` 子标签页，点击后忽略完全相同的旧提示和旧结果页，只读取新增/变化证据。

## 阶段 32 智联新版页面验收反馈

- 用户截图明确显示右上角账号姓名“俞玮康”、头像及已展开的“个人中心/我的简历/退出”等账号菜单，实际已登录；0.4.0 仍返回“未登录”，说明旧版登录类名检测发生假阴性。
- 截图中的新版岗位卡片布局与原 Java 线索明显不同：按钮文案仍为“立即投递”，但岗位标题、公司、招聘者和按钮已采用新版双栏卡片，不能继续只依赖 `joblist-box__item/jobinfo__name`。
- 登录判断应优先使用强证据（账号菜单中的“退出”、个人中心/我的简历组合、顶部账号与头像），只有存在明确“登录/注册”入口且没有任何强登录证据时才返回未登录；否则返回未知而非假阴性。
- Chrome 只读 DOM 已确认真实登录节点：头像为 `img.c-login__top__img`，账号容器为 `.c-login__top`，完整账号菜单容器为 `.home-header__c-login`；其文本包含账号名、“个人中心”“我的简历”“退出”。
- 同一真实页面的岗位主选择器并未失效：`div.joblist-box__item`、`a.jobinfo__name`、`button.collect-and-apply__btn` 均存在，岗位详情链接和“立即投递”按钮各 20 个。截图看似新版双栏，但实际类名仍兼容原解析器。
- 当前假阴性的直接原因是 `detectLoginState()` 未覆盖 `.home-header__c-login/.c-login__top/.c-login__top__img`，随后又在宽泛的全页 `a, button` 中命中了某个隐藏登录入口。修复必须先判强登录证据，再把未登录入口搜索限制到顶部导航。
- 使用修复后完全一致的规则对真实页面只读验证，结果为 `loggedIn: true`；同时识别 20 个岗位卡片和 20 个“立即投递”按钮，第一张岗位的标题、薪资、公司和按钮文本均正确。
- 最新真实截图确认智联“立即投递”后出现“请选择要投递的简历”弹窗：在线简历当前被选中、存在附件 PDF、“每次投递默认发送该简历”复选框和唯一“投递简历”按钮。
- 用户红框明确指向附件 PDF，本轮应支持“附件优先 + 可配置附件名”；若仅有一个附件可自动选择，多个附件时必须按配置名称唯一匹配，否则停止。
- 插件不应点击平台的“每次投递默认发送该简历”复选框；这属于账户级持久设置，且自动闭环无需依赖它。
- 用户要求的一次点击是取消插件自己的二次核对，不等于跳过智联平台简历弹窗；Content Script 仍需在动作间隔后显式选择简历并点击平台“投递简历”。
- 当前已登录智联标签页的简历弹窗已关闭，页面只剩岗位列表；只读快照确认已有 3 个岗位按钮变为“已投递”、其余仍为“立即投递”，但不能为了获取 DOM 再制造一次真实申请。
- 因缺少可见弹窗样本，弹窗适配必须采用保守语义规则并配回归测试：精确标题、可见唯一弹窗、简历类型/名称唯一匹配、精确“投递简历”按钮；任何歧义都返回未知并停止。
- 智联限流/账号异常文案必须与验证码、额度上限同级熔断；0.5.0 同时检查申请作用域和当前可见页面文本，不会在命中后继续下一个岗位。
- 智联安全计数使用独立 `zhilianSafety` 存储，不与猎聘 `liepinSafety` 混用；但复用同一组已测试的日期重置、跨日冷却、配额和连续成功算法。
- 0.5.0 源码提交已拆分完成；Chrome 只读会话也已正常结束，没有保留由 Codex 接管的标签页。
- 用户进一步确认智联已配置默认简历后，“立即投递”本身就会发送简历；此前根据截图推断还需“选择配置简历 → 投递简历”属于多余流程。
- 0.5.1 应删除简历类型/名称配置和弹窗操作，仅等待“立即投递”产生的明确回执；成功关闭、随机动作等待、配额、冷却和异常熔断保持不变。
- 0.5.1 真实批次停在首个岗位：浏览器已打开 `https://www.zhaopin.com/job-applied?...` 成功标签，页面明确显示“恭喜您，投递成功！”，但标签未关闭，助手在结果页显示“智联任务已停止”。
- 截图说明成功页会成为当前活动标签且也注入智联助手；原列表页仍在其它标签。当前仅按 `openerTabId === sourceTabId` 查找结果页的方案存在漏归因风险。
- 当前 Chrome 只读连接时成功页已不在开放标签列表，仅剩原 `/recommend` 列表页，无法继续读取已关闭标签的 `openerTabId`；不能为了复现再触发真实投递。
- 源码确认根因：点击前基线只收集 `openerTabId === sourceTabId` 的标签；点击后候选和最终关闭也都强制同一条件。若智联通过 `noopener` 或站点脚本打开 `/job-applied`，三处都会漏掉该成功页。
- 批次本身冻结了原列表页 `tab.id` 并始终向该 ID 发送后续岗位指令，因此只要后台正确识别、确认并关闭成功标签，活动标签切换不会破坏后续队列。
- 真实页面验证没有重载扩展、没有点击岗位或投递按钮；用户仍需在 Chrome 扩展页重新加载 0.4.1 并刷新智联页面，才能让已加载的旧 Content Script 切换到新逻辑。
