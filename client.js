/**
 * Client half of `dsh-progress-caption` — 思维链进度字幕。
 *
 * 一句话：在输入框上方加一行小字，说明「现在第几步 / 在干什么 / 成没成 / 花了多久」。
 * 全部判断都在本机按规则做，不联网、不调模型、不写 DSH 的任何数据。
 *
 * 数据来源（都是 DSH 已经推给界面的快照，只读）：
 *   - legacy.partial      正在流式输出的助手消息 { turn, step, blocks }
 *   - legacy.runningCalls 正在执行中的工具调用
 *   - legacy.nodes        已结算的会话节点，其中 kind === 'tool-result' 带 isError / content
 *
 * 三种状态的判定顺序（deriveCaption）：
 *   1. 有工具在跑                       → running（进行中）
 *   2. 最后一块是 tool-call 且已有结果   → ok / error（成功 / 失败）
 *   3. 最后一块是 reasoning             → thinking（按规则表猜在干什么）
 *   4. 其它（没有在跑的东西）            → 不显示
 *
 * 小动画与俏皮词（都可以在字幕条自己的设置里关掉）：
 *   - 扫光（shimmer）：用 ::after 盖一层渐变扫过文字，只动 background-position，不抖布局
 *   - 呼吸点（dots）：小圆点忽明忽暗，状态变成成功/失败就停住并换色
 *   - 俏皮词：模型停顿（思考文本 1 秒没变化）或工具跑超过 5 秒时，轮换 Claude 那种加载词
 */

window.__ModuleLoader__.load({
  id: 'dsh-progress-caption',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** Locale namespace owned by this plugin. */
    const NS = 'dshProgressCaption';
    /** Entry id inside the dock list slot. */
    const ENTRY_ID = 'dsh-progress-caption';
    /** Full-width list slot above the composer card. */
    const SLOT = 'conversation.input.dock';
    /** Dock entries sort by `order`; 20 keeps us out of the way of the composer. */
    const ORDER = 20;
    /** 每回合结尾的列表槽位：已完结回合的动作行前面。 */
    const TURN_SLOT = 'conversation.chat.turnTail';
    /** 思考文本只取末尾这么多字去匹配规则，避免长文误命中。 */
    const RULE_SAMPLE = 400;
    /** 俏皮词轮换节奏。 */
    // 俏皮词换得太勤会像弹幕，慢一点：2.8 秒换一个。
    const WORD_MS = 2800;
    /** 文案的稳定窗口：候选标签要稳住这么久才换，避免模型快速思考时标签乱闪。
     *  350ms 实测还是太短——模型前几步状态翻得最勤，350ms 就换一次文字，
     *  人眼看到的是「一直在改」。放宽到 520ms，宁可慢半拍，也不要晃。 */
    const LABEL_HOLD_MS = 520;
    /** 思考特别快时的稳定窗口：一秒钟最多换一次多一点，人眼跟得上。 */
    const LABEL_HOLD_FAST_MS = 800;
    /** 每秒新增多少个字就算「思考很快」。 */
    const FAST_CPS = 40;
    /** 成功态停留多久后收起（失败态不自动收，留着让人看原因）。 */
    const OK_LINGER_MS = 5000;
    /** 一条字幕最少挂多久：模型想得快时状态零点几秒就结束，留够人读完一行的时间。 */
    const MIN_SHOW_MS = 2600;
    /** 整轮刚开始的这几步不播「换文案淡入」。
     *  前几步是所有状态翻得最勤的地方（思考 → 派工具 → 回来 → 再思考），
     *  淡入动画一秒能重播两三次，叠起来就是「一直在闪」。这几步改成硬切换，
     *  第 4 步之后状态稳下来，再恢复成淡入。 */
    const SETTLE_STEPS = 3;
    /** 动画档位：calm = 只有左侧标记慢慢走（默认，最不打扰）；sweep = 文字扫光；off = 全静止。 */
    const ANIMS = ['calm', 'sweep', 'off'];
    /** 两步之间 partial 会短暂为空；这段时间（毫秒）内仍算「这一轮还在跑」，字幕不许收。 */
    const TURN_GAP_MS = 20000;
    /** 回合小结挂在 turnTail，排序避开官方与其他插件。 */
    const SUMMARY_ORDER = 40;
    const EMPTY = [];

    /* ------------------------------------------------------------------ *
     * 规则表：加一条 = 在数组里加一个对象，文案会自动并进字典（r_<id>）。
     * hit 里的每条正则都要命中（AND），大小写不敏感由正则自带 /i 决定。
     *
     * 【为什么英文词都套了 \b】以前 `run|build|step|type|api` 这种裸单字会命中
     * 一大片无关文本（runtime 命中 run、typeset 命中 type），实测 2000 条真实思考里
     * 有 56.9% 至少命中一个裸泛词。词边界能把这类误命中挡掉大半。
     *
     * 【为什么删掉了 run / step / type / api / build】它们在任何一段技术文本里都太常见，
     * 却几乎不携带「这一刻在干什么」的信息。宁可没命中（退回阶段话术或俏皮词），
     * 也好过为了凑命中率随口猜错。
     *
     * 【w 是权重】给「说了就基本确定」的词加分（定位问题、对比方案），
     * 给大词减分（搜代码、跑命令）。多个规则同时命中时靠它排出先后，
     * 而不是靠数组书写顺序——那样超过一半的样本文案是随手排出来的。
     * ------------------------------------------------------------------ */
    const RULES = [
      {
        id: 'read-config',
        hit: [/读|查看|\bread\b/i, /配置|设置|\bconfig\b|package\.json|\.env\b|\.json\b/i],
        w: 1.05,
        zh: '正在读取配置文件',
        en: 'reading a config file',
      },
      {
        id: 'search-code',
        hit: [/搜索|查找|定位|搜一下|\bgrep\b|\bsearch\b|\bfind\b|\brg\b/i],
        w: 0.9,
        zh: '正在搜索代码',
        en: 'searching the code',
      },
      {
        id: 'edit-code',
        hit: [/修改|编辑|改成|写入|补上|\bedit\b|\bwrite\b|\bpatch\w*\b/i],
        w: 1,
        zh: '正在修改代码',
        en: 'editing the code',
      },
      {
        id: 'run-tests',
        hit: [/测试|用例|跑一遍|\btests?\b|\bspec\b|\bvitest\b|\bjest\b/i],
        w: 1,
        zh: '正在跑测试',
        en: 'running tests',
      },
      {
        id: 'install-deps',
        hit: [/安装|依赖|\binstall\b|\bpnpm\b|\bnpm i\b|\bdependenc/i],
        w: 1.1,
        zh: '正在安装依赖',
        en: 'installing dependencies',
      },
      {
        id: 'run-command',
        hit: [/运行|执行|跑一下|命令|\bcommand\b|\bexecute\b|\bbash\b|\bpwsh\b/i],
        w: 0.9,
        zh: '正在运行命令',
        en: 'running a command',
      },
      {
        id: 'check-types',
        hit: [/\.d\.ts\b|类型|接口|签名|\btypescript\b|\binterface\b|\bsignature\b|\btype ?error\b/i],
        w: 1.05,
        zh: '正在查接口类型',
        en: 'checking the API types',
      },
      {
        id: 'plan',
        hit: [/计划|步骤|方案|先.*再|\bplan\w*\b|\bapproach\b/i],
        w: 0.85,
        zh: '正在梳理方案',
        en: 'working out an approach',
      },
      /* ---- 下面是按「AI 常见思考动作」补的第二批：更贴近模型真实内心戏 ---- */
      {
        id: 'understand',
        hit: [/理解|分析|明确|梳理一下|弄清楚|看懂|\bunderstand\b|\bmakes? sense of\b|\banaly[sz]e\b/i],
        w: 0.9,
        zh: '正在理解你的需求',
        en: 'understanding the request',
      },
      {
        id: 'recall-context',
        hit: [/回顾|回忆|之前的对话|上下文|上文|刚才说|\bcontext\b|\bearlier\b|previous message/i],
        w: 1.05,
        zh: '正在回顾上下文',
        en: 'reviewing the context',
      },
      {
        id: 'locate-bug',
        hit: [/定位|排查|问题出在|哪儿错|哪里错|根源|症结|root cause|what.{0,20}wrong|\bbug\b/i],
        w: 1.15,
        zh: '正在定位问题',
        en: 'locating the problem',
      },
      {
        id: 'compare-plans',
        hit: [/对比|比较一下|两种方案|三个方案|方案[AB12]|权衡|哪个更好|\bcompare\b|\bversus\b|\btrade-?offs?\b/i],
        w: 1.15,
        zh: '正在对比方案',
        en: 'comparing approaches',
      },
      {
        id: 'decide',
        hit: [/我决定|我打算|采用|就用这|选这|先这样|那就|\bdecide\b|go with|settle on/i],
        w: 1.1,
        zh: '正在定方案',
        en: 'settling on an approach',
      },
      {
        id: 'verify',
        hit: [/验证|检查一下|确认|核对|再看看对不对|\bverify\b|double-?check|\bconfirm\b/i],
        w: 1,
        zh: '正在检查验证',
        en: 'verifying the result',
      },
      {
        id: 'summarize',
        hit: [/总结|归纳|综上|概括|整体来看|梳理完|\bsummar/i],
        w: 1.1,
        zh: '正在总结归纳',
        en: 'summarizing findings',
      },
      {
        id: 'risk',
        hit: [/风险|担心|可能会出问题|注意别|小心|有坑|副作用|\brisks?\b|be careful|side effect|\bcaution\b/i],
        w: 1.15,
        zh: '正在评估风险',
        en: 'weighing the risks',
      },
      {
        id: 'answer-organize',
        hit: [/怎么回答|如何解释|怎么说|组织语言|怎么讲|how to (answer|explain|phrase)/i],
        w: 1.1,
        zh: '正在想怎么讲给你听',
        en: 'planning how to explain',
      },
    ];

    /* ------------------------------------------------------------------ *
     * 俏皮词表：模型卡住/停顿的时候轮流闪一个词（Claude Code 那种味道）。
     * 中英一一对应、条数必须相同；文案会自动并进字典的 w0…wN。
     * 收词原则：中文单独拎出来也顺口、有画面、不靠英文硬翻。
     * 已刻意剔除的直译硬词：Gusting 鼓风、Harmonizing 和鸣、Nucleating 成核、
     * Ionizing 电离、Nebulizing 雾化、Sublimating 升华、Transmuting 嬗变、
     * Reticulating 网状化、Warping 扭曲时空、Symbioting 共生、Zesting 提取精华、
     * Osmosing 渗透、Pollinating 传粉、Pontificating 高谈阔论、Julienning 切丝、
     * Flambéing 火焰炙烤、Precipitating 降水、Manifesting 显化、Wibbling 抖动、
     * Sock-hopping 袜子舞、Newspapering 读报，以及过于平淡的 Processing 处理、
     * Generating 生成、Determining 确定、Effecting 生效、Flowing 流动。
     * ------------------------------------------------------------------ */
    const WORDS_EN = [
      'Brewing', 'Pondering', 'Cogitating', 'Mulling', 'Ruminating', 'Noodling',
      'Vibing', 'Tinkering', 'Puttering', 'Spelunking', 'Percolating', 'Marinating',
      'Fermenting', 'Stewing', 'Simmering', 'Kneading', 'Leavening', 'Seasoning',
      'Sautéing', 'Whisking', 'Conjuring', 'Prestidigitating', 'Enchanting', 'Sleuthing',
      'Rummaging', 'Sifting', 'Puzzling', 'Weaving', 'Unravelling', 'Unfurling',
      'Deciphering', 'Inferring', 'Synthesizing', 'Deliberating', 'Ideating', 'Imagining',
      'Improvising', 'Sketching', 'Doodling', 'Proofing', 'Perusing', 'Crunching',
      'Whirring', 'Spinning', 'Orbiting', 'Swirling', 'Whirlpooling', 'Undulating',
      'Galloping', 'Scampering', 'Scurrying', 'Skedaddling', 'Gallivanting', 'Moseying',
      'Meandering', 'Wandering', 'Perambulating', 'Waddling', 'Shimmying', 'Slithering',
      'Moonwalking', 'Pouncing', 'Swooping', 'Levitating', 'Roosting', 'Nesting',
      'Germinating', 'Sprouting', 'Hatching', 'Scheming', 'Finagling', 'Mustering',
      'Wrangling', 'Forging', 'Recombobulating', 'Metamorphosing', 'Transfiguring',
      'Tomfoolering', 'Shenaniganing', 'Lollygagging', 'Dilly-dallying', 'Fiddle-faddling',
      'Flibbertigibbeting', 'Whatchamacalliting', 'Razzmatazzing', 'Razzle-dazzling',
      'Topsy-turvying', 'Hyperspacing', 'Thundering', 'Grooving', 'Zigzagging',
      'Philosophising', 'Photosynthesizing', 'Hullaballooing', 'Orchestrating',
      'Smooshing', 'Twisting',
      // 大鲸鱼（DeepSeek 的吉祥物）
      'Breaching', 'Spouting', 'Diving', 'Surfacing', 'Sonaring', 'Bubbling',
      'Migrating', 'Whalesong', 'Seeking', 'Deepseeking', 'Krilling', 'Skimming',
      // Δ（增量）
      'Deltas', 'Integrating', 'Approximating',
    ];
    const WORDS_ZH = [
      '酝酿中', '琢磨中', '沉思中', '反复琢磨', '反复嚼', '随手摆弄',
      '找感觉', '捣鼓中', '瞎忙活', '往里深挖', '慢慢沉淀', '泡着入味',
      '发酵中', '焖着呢', '小火慢炖', '揉面团', '等它发起来', '调味中',
      '颠勺中', '搅拌中', '变戏法', '变魔术', '施魔法', '找线索',
      '翻箱倒柜', '筛选中', '拼线索', '串线索', '解开中', '展开中',
      '解码中', '推断中', '综合中', '掂量中', '构思中', '想象中',
      '即兴发挥', '速写中', '涂鸦中', '校对中', '细读中', '啃数据',
      '嗡嗡转', '转圈中', '绕圈圈', '打旋中', '搅漩涡', '起伏中',
      '飞奔中', '小跑中', '急匆匆', '溜之大吉', '闲逛中', '溜达中',
      '漫游中', '漫步中', '踱步中', '摇摇摆摆', '扭着走', '滑行中',
      '滑太空步', '扑上去', '俯冲中', '飘着呢', '落窝中', '搭窝中',
      '发芽中', '冒芽中', '憋大招', '盘算中', '想辙中', '攒劲中',
      '收拾中', '锻造中', '回血中', '变身中', '变个样',
      '胡闹中', '搞事情', '摸鱼中', '磨蹭中', '拖拖拉拉',
      '碎碎念', '那个啥', '整花活', '眼花缭乱',
      '天翻地覆', '跃迁中', '雷声滚滚', '踩上点', '绕来绕去',
      '思考人生', '晒太阳充电', '吵吵嚷嚷', '统筹中',
      '捏扁了', '扭转中',
      '跃出海面', '喷水柱', '潜入深海', '浮上来换气', '声呐扫一圈', '吐泡泡',
      '洄游中', '哼鲸歌', '求索中', '深度求索', '捞磷虾', '贴着海面掠',
      '算个增量', '求积分', '求个近似',
    ];

    /** 工具 → 动词组（决定「正在读 / 正在执行命令」这些人话动词）。 */
    const TOOL_VERB_GROUPS = {
      bash: 'exec', ops_bash: 'exec', pwsh: 'exec',
      read: 'read', ops_read_files: 'read', read_image: 'read',
      glob: 'find', grep: 'find', search_context: 'find',
      write: 'write', edit: 'edit',
      web_search: 'web', web_fetch: 'web',
      subagent: 'delegate', subagent_fork: 'delegate', send_message: 'delegate',
      // 真实会话里出现频率不低、以前全掉进 'other' 的那些（事件量占比约 6%）：
      // 掉进 other 就只能显示「正在执行 compress」这种把工具名直接糊上去的句子。
      compress: 'recall', decompress: 'recall',
      mnemon_recall: 'recall', mnemon_remember: 'recall',
      mnemon_runtime_memory: 'recall',
      mnemon_document_search: 'recall',
      mnemon_document_create: 'write', mnemon_document_manage: 'write',
      todo_write: 'plan',
      present: 'deliver',
      job_output: 'job', job_kill: 'job', job_list: 'job',
      list_agents: 'job',
      ask_user_question: 'ask',
      skill: 'skill',
      load_workspace_dependencies: 'env',
    };

    /** 动词组 → 阶段（判断「看完了 N 个文件」这类话术）。 */
    const GROUP_PHASES = {
      read: 'read', find: 'read', exec: 'exec', write: 'edit', edit: 'edit',
      web: 'web', delegate: 'delegate',
      recall: 'recall', plan: 'plan', deliver: 'deliver',
      job: 'job', ask: 'ask', skill: 'skill', env: 'env',
    };

    const DICT = {
      zh: {
        step: '第 {n} 步',
        thinking: '正在思考',
        writing: '正在组织回答',
        stateRunning: '进行中',
        stateOk: '成功',
        stateFail: '失败',
        failTool: '工具执行失败',
        failExit: '命令执行失败（exit code {code}）',
        failKilled: '命令被终止（exit code null）',
        /* 回合级失败：这一轮不是被工具坑的，而是模型这轮压根没跑完。
           宿主在 turn/end 里给了结论（error / max-tokens / interrupted），这是比任何推断都硬的事实。 */
        failTurn: '这一轮没跑完',
        failTurnCode: '这一轮没跑完（{code}）',
        failMaxTokens: '回答到长度上限，这一轮被截断了',
        failInterrupted: '这一轮被中断了',
        /* 上游在退避重试：限流、超时这类，和「模型在思考」不是一回事，得说出来。 */
        retryWait: '上游抖动，第 {n} 次重试等待中',
        retryWaitBare: '上游抖了一下，等会儿再试',
        detail: '看原始报错',
        elapsedMin: '{m}分{s}秒',
        sumTurn: '本回合',
        sumTools: '{n} 次工具',
        sumPair: '{ok} 成 {bad} 败',
        sumTime: '用时 {s}',
        disclaimer: '字幕由规则推断，不代表模型真实意图',
        settings: '字幕设置',
        close: '收起设置',
        groupLook: '长什么样',
        groupColor: '颜色',
        groupSay: '说什么',
        preview: '预览',
        size: '字号',
        sizeS: '小',
        sizeM: '中',
        sizeL: '大',
        subLine: '思考原话',
        subLineHint: '打开后，主文案下面多一行模型自己写的思考首句',
        anim: '动画',
        animCalm: '安静',
        animSweep: '扫光',
        animOff: '全静止',
        colorAccent: '字幕条颜色',
        colorOk: '跑成功时',
        colorBad: '跑失败时',
        colorFlavor: '俏皮词样子',
        toneTheme: '跟随主题',
        toneTint: '淡色底',
        toneSolid: '实心',
        tonePlain: '素色',
        swOcean: '海蓝',
        swForest: '森林',
        swSunset: '日落',
        swViolet: '紫罗兰',
        swRose: '玫红',
        swGraphite: '石墨',
        swGreen: '翠绿',
        swTeal: '青色',
        swRed: '朱红',
        swOrange: '暖橙',
        words: '显示俏皮词',
        wordsOn: '开',
        wordsOff: '关',
        facts: '没线索时',
        factsTools: '只报动作',
        factsThinking: '猜一猜',
        factsHint: '没在跑工具的时候，选「猜一猜」它会从思考内容里猜一句；猜错很正常，看看就好。',
        sheetNote: '设置只存在这个浏览器里',
        idleStrip: '字幕已就绪，现在没有在跑的任务',
        /* 工具 → 人话动词（运行中 / 完成），比「正在执行读取文件」这种拼接自然得多 */
        v_exec_run: '正在执行命令',
        v_exec_done: '跑完命令',
        v_read_run: '正在读',
        v_read_done: '读完了',
        v_find_run: '正在搜',
        v_find_done: '搜完了',
        v_write_run: '正在写',
        v_write_done: '写好了',
        v_edit_run: '正在改',
        v_edit_done: '改好了',
        v_web_run: '正在搜网络资料',
        v_web_done: '查完资料',
        v_delegate_run: '派了小助手',
        v_delegate_done: '小助手回来了',
        v_recall_run: '正在翻记忆',
        v_recall_done: '翻完记忆',
        v_plan_run: '正在理计划',
        v_plan_done: '理好计划',
        v_deliver_run: '正在出交付物',
        v_deliver_done: '交付物出来了',
        v_job_run: '正在看后台任务',
        v_job_done: '后台任务看完了',
        v_ask_run: '正在等你拍板',
        v_ask_done: '等你拍板',
        v_skill_run: '正在翻技能手册',
        v_skill_done: '翻完技能手册',
        v_env_run: '正在查运行环境',
        v_env_done: '查完运行环境',
        v_other_run: '正在执行',
        v_other_done: '完成了',
        /* 阶段话术：工具间隙的思考，按「本回合刚干完什么」说人话。
           只说已经发生的事实，不写「在想下一步」这种放之四海皆准的尾巴。 */
        phase_read: '看完了 {n} 个文件',
        phase_edit: '刚改完{target}',
        phase_exec: '命令跑完了',
        phase_web: '查完资料',
        phase_delegate: '小助手回来了',
        phase_recall: '翻了 {n} 次记忆',
        phase_plan: '理完了计划',
        phase_deliver: '交付物已经出好了',
        phase_job: '看过后台任务了',
        phase_ask: '在等你回话',
        phase_skill: '查过技能手册了',
        phase_env: '查过运行环境了',
        phase_other: '这一轮跑了 {n} 步',
        /* 两步之间的空档（工具刚回来、模型还没开口）：报「刚才那件事 + 花了多久」，
           没有可报的事实就不写主文案，交给俏皮词。 */
        waitFormat: '{what} · {time}',
        waitFormatBare: '{what}',
        w_exec: '跑完了',
        w_read: '读完了',
        w_find: '搜完了',
        w_write: '写好了',
        w_edit: '改好了',
        w_web: '查完了',
        w_delegate: '回来了',
        w_recall: '翻完了',
        w_plan: '理完了',
        w_deliver: '出好了',
        w_job: '看完了',
        w_ask: '问过了',
        w_skill: '翻完了',
        w_env: '查完了',
        w_other: '跑完了',
      },
      en: {
        step: 'Step {n}',
        thinking: 'thinking',
        writing: 'writing the answer',
        stateRunning: 'running',
        stateOk: 'done',
        stateFail: 'failed',
        failTool: 'tool call failed',
        failExit: 'command failed (exit code {code})',
        failKilled: 'command was killed (exit code null)',
        failTurn: 'this turn did not finish',
        failTurnCode: 'this turn did not finish ({code})',
        failMaxTokens: 'hit the length limit, this turn was cut off',
        failInterrupted: 'this turn was interrupted',
        retryWait: 'upstream hiccup, waiting for retry {n}',
        retryWaitBare: 'upstream hiccup, retrying shortly',
        detail: 'show the raw error',
        elapsedMin: '{m}m {s}s',
        sumTurn: 'Turn',
        sumTools: '{n} tools',
        sumPair: '{ok} ok, {bad} failed',
        sumTime: 'took {s}',
        disclaimer: 'Inferred from rules, not the model’s intent',
        settings: 'Caption settings',
        close: 'Close settings',
        groupLook: 'Shape',
        groupColor: 'Colour',
        groupSay: 'What it says',
        preview: 'Preview',
        size: 'Text size',
        sizeS: 'Small',
        sizeM: 'Medium',
        sizeL: 'Large',
        subLine: 'Raw thought',
        subLineHint: 'Also show the first line of what the model itself wrote',
        anim: 'Animation',
        animCalm: 'Calm',
        animSweep: 'Shimmer',
        animOff: 'Still',
        colorAccent: 'Strip',
        colorOk: 'When it works',
        colorBad: 'When it fails',
        colorFlavor: 'Fun word look',
        toneTheme: 'Theme',
        toneTint: 'Tinted',
        toneSolid: 'Solid',
        tonePlain: 'Plain',
        swOcean: 'Ocean',
        swForest: 'Forest',
        swSunset: 'Sunset',
        swViolet: 'Violet',
        swRose: 'Rose',
        swGraphite: 'Graphite',
        swGreen: 'Green',
        swTeal: 'Teal',
        swRed: 'Red',
        swOrange: 'Amber',
        words: 'Playful words',
        wordsOn: 'On',
        wordsOff: 'Off',
        facts: 'When unsure',
        factsTools: 'Actions only',
        factsThinking: 'Guess a little',
        factsHint: 'When no tool is running, “Guess a little” reads the reasoning text for a clue. Guesses can be wrong.',
        sheetNote: 'Saved in this browser only',
        idleStrip: 'Caption is ready — nothing is running right now',
        v_exec_run: 'running command',
        v_exec_done: 'ran command',
        v_read_run: 'reading',
        v_read_done: 'read',
        v_find_run: 'searching',
        v_find_done: 'searched',
        v_write_run: 'writing',
        v_write_done: 'wrote',
        v_edit_run: 'editing',
        v_edit_done: 'edited',
        v_web_run: 'searching the web',
        v_web_done: 'finished a web search',
        v_delegate_run: 'delegated a subagent',
        v_delegate_done: 'subagent returned',
        v_recall_run: 'digging through memory',
        v_recall_done: 'memory checked',
        v_plan_run: 'reworking the plan',
        v_plan_done: 'plan updated',
        v_deliver_run: 'preparing the deliverable',
        v_deliver_done: 'deliverable ready',
        v_job_run: 'checking background jobs',
        v_job_done: 'background jobs checked',
        v_ask_run: 'waiting on your call',
        v_ask_done: 'waiting on your call',
        v_skill_run: 'looking up a skill',
        v_skill_done: 'skill looked up',
        v_env_run: 'probing the environment',
        v_env_done: 'environment probed',
        v_other_run: 'running',
        v_other_done: 'done with',
        phase_read: 'read {n} files',
        phase_edit: 'just edited{target}',
        phase_exec: 'command finished',
        phase_web: 'web search done',
        phase_delegate: 'subagent came back',
        phase_recall: 'checked memory {n} times',
        phase_plan: 'plan reworked',
        phase_deliver: 'deliverable is ready',
        phase_job: 'checked background jobs',
        phase_ask: 'waiting for your reply',
        phase_skill: 'consulted a skill',
        phase_env: 'checked the environment',
        phase_other: 'ran {n} steps this turn',
        waitFormat: '{what} · {time}',
        waitFormatBare: '{what}',
        w_exec: 'command finished',
        w_read: 'file read',
        w_find: 'search done',
        w_write: 'file written',
        w_edit: 'edit done',
        w_web: 'web search done',
        w_delegate: 'subagent came back',
        w_recall: 'memory checked',
        w_plan: 'plan updated',
        w_deliver: 'deliverable ready',
        w_job: 'jobs checked',
        w_ask: 'asked',
        w_skill: 'skill checked',
        w_env: 'environment checked',
        w_other: 'step finished',
      },
    };

    // 同一个动作换着说法说，别每次都是同一句——这是「说话单调」的正解。
    // 3 条一轮，按 (回合, 步) 确定性挑选，不随机闪回、也不逐帧乱跳。
    const RULE_VARIANTS = {
      'read-config': {
        zh: ['翻一下配置文件', '看看配置里怎么写的', '对一下配置项'],
        en: ['flipping through the config', 'checking what the config says', 'comparing config entries'],
      },
      'search-code': {
        zh: ['在代码里找', '搜一下相关实现', '翻找那段逻辑'],
        en: ['digging through the code', 'searching for the implementation', 'hunting for that logic'],
      },
      'edit-code': {
        zh: ['动手改代码', '把这段改成想要的', '补上缺的那几行'],
        en: ['editing the code', 'rewriting that part', 'filling in the missing lines'],
      },
      'run-tests': {
        zh: ['跑一遍测试', '看看用例过没过', '验证改动有没有坏'],
        en: ['running the tests', 'checking the test results', 'verifying nothing broke'],
      },
      'install-deps': {
        zh: ['装一下依赖', '把缺的包补上', '拉取需要的库'],
        en: ['installing dependencies', 'adding the missing packages', 'pulling the libraries'],
      },
      'run-command': {
        zh: ['跑一条命令', '执行一下看看', '让系统跑起来'],
        en: ['running a command', 'executing it to see', 'letting the system run'],
      },
      'check-types': {
        zh: ['查接口类型', '对一下类型签名', '看看参数长什么样'],
        en: ['checking the type signatures', 'matching the API types', 'looking at the parameter shapes'],
      },
      plan: {
        zh: ['琢磨步骤', '排一下顺序', '想怎么分几步做'],
        en: ['sketching the steps', 'ordering the work', 'deciding how to split it'],
      },
      understand: {
        zh: ['琢磨你的意思', '先弄清要什么', '读一遍需求'],
        en: ['working out what you mean', 'pinning down the request', 'reading the requirement'],
      },
      'recall-context': {
        zh: ['回想前面的对话', '翻回上文对照', '把上下文捋一遍'],
        en: ['recalling the earlier thread', 'checking back on context', 'going over the conversation'],
      },
      'locate-bug': {
        zh: ['找问题出在哪', '定位出错的地方', '缩小问题范围'],
        en: ['tracking down the bug', 'locating the failure', 'narrowing the problem down'],
      },
      'compare-plans': {
        zh: ['权衡两种做法', '比较几个方案', '看哪条路更稳'],
        en: ['weighing two approaches', 'comparing the options', 'seeing which path is safer'],
      },
      decide: {
        zh: ['定下来用哪种', '拿个主意', '拍板选一条'],
        en: ['settling on one', 'making the call', 'picking a path'],
      },
      verify: {
        zh: ['再验一遍', '核对结果对不对', '复查一下'],
        en: ['double-checking', 'verifying the result', 'reviewing it once more'],
      },
      summarize: {
        zh: ['收个尾', '把结论整理一下', '理一遍要说什么'],
        en: ['wrapping up', 'tidying the conclusions', 'lining up what to say'],
      },
      risk: {
        zh: ['想有没有坑', '先掂量风险', '看会不会弄坏别的'],
        en: ['watching for pitfalls', 'weighing the risk', 'checking for collateral damage'],
      },
      'answer-organize': {
        zh: ['组织怎么回答', '把话理顺', '准备把结果讲清楚'],
        en: ['organizing the answer', 'getting the wording straight', 'preparing to explain'],
      },
    };

    // 规则表的文案并进字典：改规则只动 RULES 一处。
    for (const rule of RULES) {
      DICT.zh['r_' + rule.id] = rule.zh;
      DICT.en['r_' + rule.id] = rule.en;
      const variants = RULE_VARIANTS[rule.id];
      if (!variants) continue;
      variants.zh.forEach((text, index) => { DICT.zh['r_' + rule.id + '_' + index] = text; });
      variants.en.forEach((text, index) => { DICT.en['r_' + rule.id + '_' + index] = text; });
    }
    // 俏皮词也进字典，这样切语言时自动跟着换。
    WORDS_ZH.forEach((word, index) => {
      DICT.zh['w' + index] = word;
      DICT.en['w' + index] = WORDS_EN[index] || word;
    });
    const WORD_COUNT = WORDS_ZH.length;

    /* ---------------- 设置：存在浏览器本地，不写 DSH 数据 ---------------- */

    const SETTINGS_KEY = 'dsh-progress-caption:settings';
    const DEFAULT_SETTINGS = {
      size: 'm', subLine: false, anim: 'calm', words: true, factsOnly: false,
      accent: 'theme', okColor: 'theme', badColor: 'theme', flavorStyle: 'tint',
    };
    const SIZES = ['s', 'm', 'l'];
    const FLAVOR_STYLES = ['tint', 'solid', 'plain'];

    /**
     * 配色表。值直接写死成十六进制，不再依赖主题变量——主题把颜色关掉时
     * （比如某些皮肤的「素色模式」），字幕条自己还能有颜色，不至于一片灰。
     */
    const ACCENTS = {
      theme: { label: 'toneTheme', value: '' },
      ocean: { label: 'swOcean', value: '#4d6bfe' },
      forest: { label: 'swForest', value: '#2f9e68' },
      sunset: { label: 'swSunset', value: '#e07a3f' },
      violet: { label: 'swViolet', value: '#8b5cf6' },
      rose: { label: 'swRose', value: '#e0558c' },
      graphite: { label: 'swGraphite', value: '#6b7280' },
    };
    const OK_COLORS = {
      theme: { label: 'toneTheme', value: '' },
      green: { label: 'swGreen', value: '#2f9e68' },
      teal: { label: 'swTeal', value: '#12a594' },
    };
    const BAD_COLORS = {
      theme: { label: 'toneTheme', value: '' },
      red: { label: 'swRed', value: '#d94a3d' },
      orange: { label: 'swOrange', value: '#e08a2e' },
    };

    function pickFrom(table, value, fallbackKey) {
      return table[value] ? value : fallbackKey;
    }

    /** 把选中的颜色折算成 CSS 变量，挂在字幕条根节点上。 */
    function stripVars(settings) {
      const accent = ACCENTS[settings.accent] || ACCENTS.theme;
      const ok = OK_COLORS[settings.okColor] || OK_COLORS.theme;
      const bad = BAD_COLORS[settings.badColor] || BAD_COLORS.theme;
      const vars = {};
      if (accent.value) vars['--pgc-accent'] = accent.value;
      if (ok.value) vars['--pgc-ok'] = ok.value;
      if (bad.value) vars['--pgc-bad'] = bad.value;
      return vars;
    }

    function pick(value, allowed, fallback) {
      return allowed.indexOf(value) >= 0 ? value : fallback;
    }

    function normalizeSettings(raw) {
      const source = raw && typeof raw === 'object' ? raw : {};
      return {
        size: pick(source.size, SIZES, DEFAULT_SETTINGS.size),
        // 旧版本这里是 lines: 1|2|3，实测只起到「要不要显示副行」的开关作用，
        // 所以换成布尔开关；老存档里 lines>=2 的等价于 subLine:true，免得升级后设置被重置。
        subLine: source.subLine === undefined
          ? Number(source.lines) >= 2
          : Boolean(source.subLine),
        anim: pick(source.anim, ANIMS, DEFAULT_SETTINGS.anim),
        words: source.words === undefined ? DEFAULT_SETTINGS.words : Boolean(source.words),
        factsOnly: source.factsOnly === undefined ? DEFAULT_SETTINGS.factsOnly : Boolean(source.factsOnly),
        accent: pickFrom(ACCENTS, source.accent, DEFAULT_SETTINGS.accent),
        okColor: pickFrom(OK_COLORS, source.okColor, DEFAULT_SETTINGS.okColor),
        badColor: pickFrom(BAD_COLORS, source.badColor, DEFAULT_SETTINGS.badColor),
        flavorStyle: pick(source.flavorStyle, FLAVOR_STYLES, DEFAULT_SETTINGS.flavorStyle),
      };
    }

    /**
     * 读设置。localStorage 在某些宿主里可能不可用（无痕、权限），一律兜底到默认值，
     * 绝不让异常冒到界面。
     */
    function readSettings() {
      try {
        if (typeof localStorage === 'undefined') return { ...DEFAULT_SETTINGS };
        const text = localStorage.getItem(SETTINGS_KEY);
        return normalizeSettings(text ? JSON.parse(text) : null);
      } catch {
        return { ...DEFAULT_SETTINGS };
      }
    }

    function writeSettings(value) {
      try {
        if (typeof localStorage === 'undefined') return;
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(value));
      } catch {
        /* 存不了就算了，只影响下次打开 */
      }
    }

    /** 极简占位替换：fmt('第 {n} 步', { n: 2 }) → '第 2 步'。 */
    function fmt(template, vars) {
      return String(template).replace(/\{(\w+)\}/g, (all, name) =>
        vars && vars[name] !== undefined ? String(vars[name]) : all);
    }

    /** 字典兜底（英文或未注册时也能显示文字）。apply 里会被 locale 服务换成 t。 */
    let translate = (key) => (DICT.zh[key] !== undefined ? DICT.zh[key] : key);

    /** 第 index 个俏皮词（自动取模；文案已在字典里，切语言自动跟着换）。 */
    function wordAt(index) {
      return translate('w' + (Math.abs(index) % WORD_COUNT));
    }

    /**
     * 工具动作的人话：动词组 + 具体对象拼成一整句。
     * bash → 「正在执行命令 npm test」；read → 「正在读 client.js」；完成态换完成动词。
     */
    function actionText(tool, target, state) {
      const group = TOOL_VERB_GROUPS[tool] || 'other';
      const verb = translate(state === 'running' ? 'v_' + group + '_run' : 'v_' + group + '_done');
      let object = target ? ' ' + target : '';
      if (group === 'other' && tool) object = ' ' + tool;
      return verb + object;
    }

    /**
     * 本回合已完成的工具结果（用 seq 卡回合边界，全是事实，不猜）。
     * 工具间隙模型又在思考时，靠它说「看完了 3 个文件」。
     */
    function turnTools(source) {
      const nodes = source && Array.isArray(source.nodes) ? source.nodes : EMPTY;
      const ends = source && source.turnEnds;
      const turn = source && typeof source.turn === 'number' ? source.turn : null;
      if (turn === null) return EMPTY;
      const boundary = ends && typeof ends.get === 'function' ? (ends.get(turn - 1) || 0) : 0;
      const list = [];
      for (const node of nodes) {
        if (!node || node.kind !== 'tool-result') continue;
        if (typeof node.seq !== 'number' || node.seq <= boundary) continue;
        list.push(node);
      }
      return list;
    }

    /**
     * 两步之间的空档话术：工具刚回来、模型还没开口的那一两秒。
     * 只说「刚才那件事 + 花了多久」（都是事实），没有事实就返回 null——
     * 这时上层的思考分支会退到俏皮词，绝不写「正在准备下一步」这种放之四海皆准的空话。
     * @returns {null | {text: string, id: string}}
     */
    function gapText(tools) {
      if (!tools || tools.length === 0) return null;
      const last = tools[tools.length - 1];
      const group = TOOL_VERB_GROUPS[last.name] || 'other';
      const verb = translate('w_' + group);
      const target = toolTarget(last);
      const what = target ? target + ' ' + verb : verb;
      const id = String(last.callId || last.seq || last.name || 'tool');
      const ran = typeof last.callTime === 'number' && typeof last.time === 'number'
        ? Math.max(0, last.time - last.callTime)
        : null;
      // 超过一秒才报时长；零点几秒报出来反而是噪音。
      if (ran !== null && ran >= 1000) {
        return { text: fmt(translate('waitFormat'), { what, time: durationText(ran) }), id };
      }
      return { text: fmt(translate('waitFormatBare'), { what }), id };
    }

    /**
     * 阶段话术：按「本回合刚干完什么」说人话（最后一条工具的类型决定阶段）。
     * @returns {null | {text: string}}
     */
    function phaseText(tools) {
      if (!tools || tools.length === 0) return null;
      const last = tools[tools.length - 1];
      const group = TOOL_VERB_GROUPS[last.name] || 'other';
      const phase = GROUP_PHASES[group] || 'other';
      let text;
      if (phase === 'read') {
        const n = tools.filter((tool) => {
          const g = TOOL_VERB_GROUPS[tool.name] || 'other';
          return g === 'read' || g === 'find';
        }).length;
        text = fmt(translate('phase_read'), { n });
      } else if (phase === 'edit') {
        const target = toolTarget(last);
        text = fmt(translate('phase_edit'), { target: target ? ' ' + target : '' });
      } else {
        text = fmt(translate('phase_' + phase), phase === 'other' ? { n: tools.length } : {});
      }
      return { text };
    }

    /**
     * 决定这一帧显示什么：实时状态优先；实时状态没了，就把最后一条挂满 MIN_SHOW_MS。
     * 抽成纯函数方便离线测试（组件里只管用 setTimeout 到点清掉）。
     */
    function pickView(view, held, now) {
      if (view) return view;
      if (!held || !held.view || typeof held.at !== 'number') return null;
      return Math.max(0, now - held.at) < MIN_SHOW_MS ? held.view : null;
    }

    /** 取会话选择器 Hook。只在 Live 组件里调用，那边已确认 props.useChat 存在。 */
    function useChatOf(props) {
      return props.useChat;
    }

    /** 耗时文案：一分钟内报秒（1.2s），超过报分秒（1分15秒）。 */
    function durationText(ms) {
      const total = Math.max(0, Number(ms) || 0);
      if (total < 60000) return (total / 1000).toFixed(1) + 's';
      const minutes = Math.floor(total / 60000);
      const seconds = Math.round((total % 60000) / 1000);
      return fmt(translate('elapsedMin'), { m: minutes, s: seconds });
    }

    /** 压短：换行拍平，超长截断，别把字幕条撑爆。 */
    function shrink(text) {
      const flat = String(text).replace(/\\"/g, '"').replace(/\s+/g, ' ').trim();
      return flat.length > 44 ? flat.slice(0, 43) + '…' : flat;
    }

    /**
     * 从工具参数里抠「到底在碰什么」：命令 → 路径末段 → 搜索词 → 网络搜索词。
     * 运行中的调用读 argsRaw；已结算的结果读 call.argsRaw（窗口截断时可能没有）。
     */
    function toolTarget(source) {
      const raw = typeof source === 'object' && source !== null
        ? (typeof source.argsRaw === 'string'
          ? source.argsRaw
          : source.call && typeof source.call.argsRaw === 'string' ? source.call.argsRaw : '')
        : '';
      if (!raw) return '';
      const command = /"(?:command|cmd)"\s*:\s*"((?:[^"\\]|\\.){1,90})/.exec(raw);
      if (command) return shrink(command[1]);
      const file = /"path"\s*:\s*"((?:[^"\\]|\\.){1,160})/.exec(raw);
      if (file) return shrink(file[1].split(/[\\/]/).pop() || file[1]);
      const pattern = /"pattern"\s*:\s*"((?:[^"\\]|\\.){1,64})/.exec(raw);
      if (pattern) return shrink(pattern[1]);
      const query = /"query"\s*:\s*"((?:[^"\\]|\\.){1,60})/.exec(raw);
      if (query) return shrink(query[1]);
      return '';
    }

    /** 把工具结果的 content 块拼成纯文本（DSH 的结果可能是多块）。 */
    function contentText(blocks) {
      if (!Array.isArray(blocks)) return '';
      const parts = [];
      for (const block of blocks) {
        if (!block) continue;
        if (typeof block.text === 'string') parts.push(block.text);
        else if (typeof block.content === 'string') parts.push(block.content);
      }
      return parts.join('\n');
    }

    function firstLine(text) {
      const line = String(text || '').split('\n').find((item) => item.trim() !== '');
      return line ? line.trim().slice(0, 200) : '';
    }

    /** 最近一条已结算的工具结果（legacy.nodes 按 seq 递增）。 */
    function lastToolResult(nodes) {
      for (let i = nodes.length - 1; i >= 0; i -= 1) {
        if (nodes[i] && nodes[i].kind === 'tool-result') return nodes[i];
      }
      return null;
    }

    /** 最后一块有内容的思考文本。 */
    function lastReasoningText(blocks) {
      if (!Array.isArray(blocks)) return '';
      for (let i = blocks.length - 1; i >= 0; i -= 1) {
        const block = blocks[i];
        if (block && block.kind === 'reasoning' && typeof block.text === 'string' && block.text.length > 0) {
          return block.text;
        }
      }
      return '';
    }

    /** 去掉 markdown 记号与多余空白，副行只显示纯文字。 */
    function plainText(text) {
      return String(text || '')
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/[`*_>#]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    }

    /** 口语垫词：模型爱在句首加这些，占了位置却没有信息。 */
    const LEAD_FILLER = /^(but|and|so|then|now|ok|okay|well|actually|basically|hmm|wait|also|plus|still|just|therefore|thus|next|first|second|third|finally|let me|let's|i need to|i should|i will|i'll|i want to|i'm going to|we need to|we should|不过|但是|但|所以|因此|然后|现在|那么|好的|嗯|其实|另外|还有|首先|其次|最后|让我|我先|我来看|接下来|先看|再看|值得注意的是|需要说明的是)[\s,，：:—-]*/i;

    /** 有判断、有取舍、有卡点的句子，信息量最高。 */
    const THOUGHT_SIGNAL = /(因为|所以|但是|不过|其实|问题|原因|风险|应该|不该|选择|取舍|取决于|卡在|失败|报错|错误|根因|关键|注意|否则|反而|这意味着|说明|限制|代价|矛盾|冲突|怀疑|猜测|不确定|原因是|问题是|better|because|however|instead|reason|risk|problem|issue|tradeoff|depends|fail|error|root cause|means |suggest)/i;

    /** 带具体东西（路径、文件名、数字、命令）的句子，也比空话强。 */
    const THOUGHT_SPECIFIC = /([\w.-]+\/[\w./-]+|\b[\w-]+\.(js|mjs|ts|tsx|json|md|yml|yaml|css|html)\b|"[^"]{2,40}"|\b\d+(\.\d+)?\s*(ms|s|px|em|rem|KB|MB|%)\b|\bexit code\b|\b[a-zA-Z_]{3,}\(\))/i;

    /** 反复剥掉句首口语垫词，剥到没得剥为止（连续两个垫词很常见）。 */
    function stripLead(sentence) {
      let out = String(sentence || '').trim();
      for (let guard = 0; guard < 4; guard += 1) {
        const next = out.replace(LEAD_FILLER, '').trim();
        if (next === out || next.length < 4) break;
        out = next;
      }
      // 剥掉「Let me」之后可能剩个小写开头（"read client.js…"），补回大写才像句子。
      if (/^[a-z]/.test(out)) out = out.charAt(0).toUpperCase() + out.slice(1);
      return out;
    }

    /** 按中英标点切句，只留长度像句子的片段。 */
    function splitSentences(text) {
      return plainText(text)
        .split(/(?<=[。！？!?;；])\s*|(?<=[.])\s+/)
        .map((item) => item.trim())
        .filter((item) => item.length >= 8 && item.length <= 200);
    }

    /** 截到 60 字以内，尽量在标点处断，别切断一个词。 */
    function clipSentence(sentence) {
      if (sentence.length <= 60) return sentence;
      const cut = sentence.slice(0, 60);
      const lastBreak = Math.max(
        cut.lastIndexOf('，'),
        cut.lastIndexOf(','),
        cut.lastIndexOf('；'),
        cut.lastIndexOf('：'),
        cut.lastIndexOf(':'),
      );
      return (lastBreak >= 24 ? cut.slice(0, lastBreak) : cut) + '…';
    }

    /**
     * 从一整段思考里挑一句最值得给用户看的，当副行。
     * 为什么不用第一句：模型的第 1 句几乎都是「Now let me…/让我先看看」这种过场话，
     * 真正的判断、权衡、卡点通常在后面。这里只截断和排序，不改写内容——所以不会「猜错」。
     * 一条都挑不出来时返回空串，宁可这行不显示，也不显示一句废话。
     */
    function pickThought(text) {
      const list = splitSentences(text);
      if (list.length === 0) return '';
      let best = null;
      let fallback = '';
      list.forEach((raw, index) => {
        const sentence = stripLead(raw);
        if (sentence.length < 8) return;
        // 「…：1.」这种是清单开头，单独摘出来读着像断掉，跳过。
        const looksLikeList = /[:：]\s*\d?\.?\s*$/.test(sentence) || /^\d+[.、)]\s*$/.test(sentence);
        if (!looksLikeList && sentence.length >= 10) fallback = sentence;
        if (looksLikeList) return;
        let value = 0;
        if (THOUGHT_SIGNAL.test(sentence)) value += 5;
        if (THOUGHT_SPECIFIC.test(sentence)) value += 3;
        if (sentence.length >= 12 && sentence.length <= 60) value += 2;
        if (sentence.length < 10) value -= 3;
        // 越靠后越接近「当下正在纠结的事」，给一点加成。
        if (list.length > 1) value += (index / (list.length - 1)) * 1.5;
        if (!best || value > best.value) best = { sentence, value };
      });
      if (best && best.value >= 3) return clipSentence(best.sentence);
      return fallback ? clipSentence(fallback) : '';
    }

    /**
     * 失败判定。注意：bash 失败时 isError 恒为 false（DSH 把它当"已完成、退出码是数据"），
     * 所以还要读结果尾巴上的 `[exit code: N]`。
     */
    function failureOf(result) {
      if (!result) return null;
      const text = contentText(result.content);
      const match = /\[exit code: (-?\d+|null)\]$/.exec(text.trim());
      const code = match ? match[1] : null;
      if (result.isError) {
        const name = result.error && result.error.code ? String(result.error.code) : null;
        return { kind: 'tool', code: name, rawLine: firstLine(text) };
      }
      if (code === 'null') return { kind: 'killed', code: 'null', rawLine: firstLine(text) };
      if (code !== null && code !== '0') return { kind: 'exit', code, rawLine: firstLine(text) };
      return null;
    }

    /**
     * 规则表匹配：末尾 RULE_SAMPLE 字里，取「分最高」的那条规则。
     *
     * 以前是「命中第一条就返回」——但实测 2000 条真实思考里，有 53.2% 同时命中多条规则，
     * 谁先谁后完全取决于数组书写顺序，等于一半以上的文案是随手排出来的。
     * 现在按 rule.w 打分（说了就基本确定的词加分、大词减分），打平才退回数组顺序。
     */
    function pickRule(text) {
      if (!text) return null;
      const sample = String(text).slice(-RULE_SAMPLE);
      let best = null;
      let bestScore = -Infinity;
      for (const rule of RULES) {
        if (!rule.hit.every((pattern) => pattern.test(sample))) continue;
        const score = typeof rule.w === 'number' ? rule.w : 1;
        // 严格大于才替换 → 同分时保留数组里靠前的那条，行为可预测。
        if (score > bestScore) {
          best = rule;
          bestScore = score;
        }
      }
      return best;
    }

    /**
     * 最近一条「这一轮没跑完」的回合级节点：模型报错（turn-error）或输出到上限（turn-max-tokens）。
     * 这两个是宿主直接给的结论，不是猜的——字幕以前完全没读，所以回合挂了也只会停在「正在思考」。
     * @returns {null | {kind:'error'|'maxtokens', code:string, rawLine:string, turn:number, seq:number}}
     */
    function latestTurnFailure(nodes, turn) {
      if (!Array.isArray(nodes) || nodes.length === 0) return null;
      if (typeof turn !== 'number') return null;
      for (let i = nodes.length - 1; i >= 0; i -= 1) {
        const node = nodes[i];
        if (!node) continue;
        if (node.kind !== 'turn-error' && node.kind !== 'turn-max-tokens') continue;
        // 只认当前这一轮：翻历史会话时不会把上一轮的旧报错翻出来。
        if (typeof node.turn === 'number' && node.turn !== turn) continue;
        return {
          // 客户端码里有两个是「用户自己停的」和「登录掉了」，说成「模型报错」会吓人，单列出来。
          kind: node.kind === 'turn-error'
            ? (node.code === 'INTERRUPTED' ? 'interrupted' : 'error')
            : 'maxtokens',
          code: node.code || '',
          rawLine: firstLine(node.message),
          turn,
          seq: typeof node.seq === 'number' ? node.seq : 0,
        };
      }
      return null;
    }

    /**
     * 还挂着没开始的那次模型重试（限流 / 上游抖动）。
     * 宿主把重试链放在 model-retry 节点里，retryState 有 scheduled / started / cancelled 三态；
     * 只认 scheduled——started 说明已经在重试了，那就是正常的「正在思考」。
     * @returns {null | {n:number, max:number, delayMs:number, code:string}}
     */
    function pendingRetry(nodes, turn) {
      if (!Array.isArray(nodes) || nodes.length === 0) return null;
      if (typeof turn !== 'number') return null;
      for (let i = nodes.length - 1; i >= 0; i -= 1) {
        const node = nodes[i];
        if (!node || node.kind !== 'model-retry') continue;
        if (typeof node.turn === 'number' && node.turn !== turn) continue;
        if (node.retryState !== 'scheduled') return null;
        return {
          n: typeof node.retry === 'number' ? node.retry : 1,
          max: typeof node.maxRetries === 'number' ? node.maxRetries : 0,
          delayMs: typeof node.delayMs === 'number' ? node.delayMs : 0,
          code: node.failure && node.failure.code ? String(node.failure.code) : '',
        };
      }
      return null;
    }

    /**
     * 纯函数：快照的一段 → 字幕视图模型（不碰 React，方便离线测试）。
     * 优先级：回合失败 > 工具事实 > 重试中 > 规则表（读思考文本）> 阶段话术 > 俏皮词。
     * @returns {null | {state:'running'|'thinking'|'ok'|'error'|'writing', key:string,
     *   step:number|null, turn:number|null, tool:string, target:string, ruleId:string|null,
     *   phase:string|null, sub?:string, kind:string|null, code:string|null, rawLine:string,
     *   retry?:{n:number,max:number,delayMs:number,code:string}}}
     */
    function deriveCaption(input) {
      const source = input || {};
      const partial = source.partial || null;
      const calls = Array.isArray(source.runningCalls) ? source.runningCalls : EMPTY;
      const nodes = Array.isArray(source.nodes) ? source.nodes : EMPTY;
      const turn = partial && typeof partial.turn === 'number'
        ? partial.turn
        : (typeof source.turn === 'number' ? source.turn : null);

      // 0) 这一轮已经挂了 / 打到输出上限：宿主给了结论就直接报，别装作还在思考。
      //    放在最前面，是因为它比任何「正在进行中」的推断都更接近真相。
      //    组件会把算好的 failure 传进来（它用的是 openTurn，能兜住两步之间的空档）；
      //    离线调用没传时，这里按 turn 自己算一次，保证这个函数单独拿出来也是对的。
      const failure = source.failure !== undefined
        ? source.failure
        : latestTurnFailure(nodes, turn);
      // 手头真有工具在跑就先说在跑什么：那是正在发生的事实，
      // 而「这一轮挂了」是结论，等它空了再报（否则失败后立刻重跑会一直卡在报错上）。
      if (failure && calls.length === 0) {
        return {
          key: 'turnfail:' + (failure.turn || 0) + ':' + (failure.kind || 'error'),
          state: 'error',
          turn: typeof failure.turn === 'number' ? failure.turn : turn,
          step: null,
          tool: '',
          target: '',
          ruleId: null,
          phase: null,
          kind: failure.kind || 'error',
          code: failure.code || null,
          rawLine: failure.rawLine || '',
        };
      }

      // 回合还没结束（模型没交出这一轮）：哪怕这一刻 partial 是空的（两步之间的空档），
      // 也不能让字幕收起来——用户要的是「思考没结束就一直挂着」。
      if (!partial && calls.length === 0) {
        if (!source.turnOpen || turn === null) return null;
        // 空档时只报事实：本回合刚跑完的那条工具 + 它花了多久。
        // 没事实可报就把 phase 留空，上层会退到俏皮词——不写「正在准备下一步」这种空话。
        const done = gapText(turnTools({ nodes, turnEnds: source.turnEnds, turn }));
        return {
          key: 'wait:' + turn + ':' + (done ? done.id : '-'),
          state: 'thinking',
          turn,
          step: null,
          tool: '',
          target: '',
          ruleId: null,
          phase: done ? done.text : null,
          kind: null,
          code: null,
          rawLine: '',
        };
      }

      // 宿主发出来的 step 本来就是 1 起（用真实会话日志核过：第一个 step 就是 1），
      // 这里绝对不能再 +1，否则「第 1 步」会被显示成「第 2 步」。
      const step = partial && typeof partial.step === 'number' ? partial.step : null;

      // 1) 有工具在跑。
      if (calls.length > 0) {
        let call = calls[0];
        for (const candidate of calls) {
          if (candidate && typeof candidate.time === 'number' && candidate.time >= (call.time || 0)) call = candidate;
        }
        return {
          key: 'run:' + (call.callId || call.name || 'tool'),
          state: 'running',
          turn,
          step: typeof call.step === 'number' ? call.step : step,
          tool: call.name || '',
          target: toolTarget(call),
          ruleId: null,
          phase: null,
          kind: null,
          code: null,
          rawLine: '',
        };
      }

      const blocks = partial && Array.isArray(partial.blocks) ? partial.blocks : EMPTY;
      const tail = blocks.length > 0 ? blocks[blocks.length - 1] : null;
      const tailKind = tail ? tail.kind : null;

      // 2) 已经在写回答：整条保持显示（不要闪没），只有「只报事实」才收起来。
      if (tailKind === 'text') {
        if (source.factsOnly) return null;
        return {
          key: 'write:' + (partial.turn || 0) + ':' + (partial.step || 0),
          state: 'writing',
          turn,
          step,
          tool: '',
          target: '',
          ruleId: null,
          phase: null,
          kind: null,
          code: null,
          rawLine: '',
        };
      }

      // 3) 最后一块是工具调用 → 看最近一条结果成没成。
      //    blocks 为空（回合刚开始、一个字还没吐）时跳过，免得把上一回合的旧结果闪出来。
      if (tailKind !== 'reasoning' && blocks.length > 0) {
        const result = lastToolResult(nodes);
        if (result) {
          const bad = failureOf(result);
          return {
            key: 'done:' + (result.callId || result.seq || ''),
            state: bad ? 'error' : 'ok',
            turn,
            step,
            tool: result.name || '',
            target: toolTarget(result),
            ruleId: null,
            phase: null,
            kind: bad ? bad.kind : null,
            code: bad ? bad.code : null,
            rawLine: bad ? bad.rawLine : '',
          };
        }
      }

      // 4) 还在思考。
      //    factsOnly（只报事实）：不读思考文本，没有工具在跑就整条收起来。
      //    否则多层兜底：重试中 → 规则表（读思考文本）→ 阶段话术（本回合干过什么）→ 俏皮词。
      if (source.factsOnly) return null;
      // 上游抖动正在退避：这是事实，比读思考文本猜出来的动作准，所以排在规则表前面。
      const retry = source.retry !== undefined ? source.retry : pendingRetry(nodes, turn);
      if (retry) {
        return {
          key: 'retry:' + (partial.turn || 0) + ':' + (partial.step || 0) + ':' + retry.n,
          state: 'thinking',
          turn,
          step,
          tool: '',
          target: '',
          ruleId: null,
          phase: null,
          kind: null,
          code: retry.code || null,
          rawLine: '',
          retry,
        };
      }
      const rule = pickRule(lastReasoningText(blocks));
      const tools = turnTools({ nodes, turnEnds: source.turnEnds, turn: partial.turn });
      const phase = phaseText(tools);
      return {
        key: 'think:' + (partial.turn || 0) + ':' + (partial.step || 0) + ':' + (rule ? rule.id : (phase ? 'p' : '-')),
        state: 'thinking',
        turn,
        step,
        tool: '',
        target: '',
        ruleId: rule ? rule.id : null,
        // 副行：从这段思考里挑一句最有信息量的（不是第一句——第一句几乎都是过场话）。
        sub: pickThought(lastReasoningText(blocks)),
        phase: !rule && phase ? phase.text : null,
        kind: null,
        code: null,
        rawLine: '',
      };
    }

    /** 每 period 毫秒 +1；active 为假时不动（省电，也不打扰）。 */
    function useTick(period, active) {
      const [tick, setTick] = React.useState(0);
      React.useEffect(() => {
        if (!active) return undefined;
        const timer = setInterval(() => setTick((value) => value + 1), period);
        return () => clearInterval(timer);
      }, [active, period]);
      return tick;
    }

    /** 设置面板里的一行：左边标题，右边控件。 */
    function settingRow(t, labelKey, control) {
      return h('label', { className: 'pgc-set-row', key: labelKey },
        h('span', { className: 'pgc-set-name' }, t(labelKey)),
        control);
    }

    /**
     * 外层只决定「渲染哪个组件」。
     * 不能在同一个组件里写「有 useChat 就调 Hook、没有就不调」：那样两次渲染的 Hook
     * 数量会变，React 会报 Rendered fewer hooks than expected。换组件就没这问题，
     * 因为每个组件内部的 Hook 数量是固定的。
     */
    function CaptionStrip(props) {
      return props.useChat ? h(CaptionStripLive, props) : null;
    }

    function CaptionStripLive(props) {
      const t = props.t || translate;
      const partial = useChatOf(props)((state) => state.legacy.partial);
      const runningCalls = useChatOf(props)((state) => state.legacy.runningCalls);
      const nodes = useChatOf(props)((state) => state.legacy.nodes);
      const turnEnds = useChatOf(props)((state) => state.legacy.turnEnds);
      // 这一轮结束没有？判断顺序：partial 里带着 turn；partial 短暂为空时用「刚见过的那一轮」兜底。
      // 不用 turnTimings 猜（历史会话里回合表可能不全，会误判成永远在跑）。
      // 只要这一轮还开着，字幕就一直挂着——两步之间 partial 为空也不收。
      const seenTurn = React.useRef({ turn: null, at: 0 });
      React.useEffect(() => {
        if (partial && typeof partial.turn === 'number') {
          seenTurn.current = { turn: partial.turn, at: Date.now() };
        }
      }, [partial]);
      // 每次渲染现算（不放进 useMemo：它要用 Date.now()，放进 memo 反而会拿着旧时间）。
      let openTurn = partial && typeof partial.turn === 'number' ? partial.turn : null;
      if (openTurn === null && seenTurn.current.turn !== null
        && Date.now() - seenTurn.current.at < TURN_GAP_MS) {
        openTurn = seenTurn.current.turn;
      }
      if (openTurn !== null && turnEnds && typeof turnEnds.has === 'function' && turnEnds.has(openTurn)) {
        openTurn = null;
      }

      const [settings, setSettings] = React.useState(readSettings);
      const [settingsOpen, setSettingsOpen] = React.useState(false);
      const update = (patch) => {
        setSettings((prev) => {
          const next = normalizeSettings({ ...prev, ...patch });
          writeSettings(next);
          return next;
        });
      };

      // 键盘可达性：面板打开时按 Esc 收起，并把焦点还给齿轮。
      // 以前只能再点一次齿轮才能关，纯键盘用户打开面板后没有退路。
      const gearRef = React.useRef(null);
      React.useEffect(() => {
        if (!settingsOpen) return undefined;
        if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') {
          return undefined;
        }
        const onKey = (event) => {
          if (!event || (event.key !== 'Escape' && event.key !== 'Esc')) return;
          setSettingsOpen(false);
          const gear = gearRef.current;
          if (gear && typeof gear.focus === 'function') gear.focus();
        };
        document.addEventListener('keydown', onKey);
        return () => {
          if (typeof document.removeEventListener === 'function') {
            document.removeEventListener('keydown', onKey);
          }
        };
      }, [settingsOpen]);

      // 回合级事实：这一轮是不是已经挂了 / 是不是在等上游重试。
      // 以前字幕只认工具结果，模型限流、回合被打断、输出超长时它会一直停在「正在思考」。
      const failure = React.useMemo(
        () => latestTurnFailure(nodes, openTurn),
        [nodes, openTurn],
      );
      const retry = React.useMemo(
        () => (failure ? null : pendingRetry(nodes, openTurn)),
        [nodes, openTurn, failure],
      );
      const view = React.useMemo(
        () => deriveCaption({
          partial,
          runningCalls,
          nodes,
          turnEnds,
          failure,
          retry,
          factsOnly: settings.factsOnly,
          turn: openTurn,
          turnOpen: openTurn !== null,
        }),
        [partial, runningCalls, nodes, failure, retry, settings.factsOnly, openTurn, t],
      );

      // 一闪而过的状态也要留一会儿再收：模型想得快的时候，字幕常常零点几秒就消失，人来不及读。
      // 规则：新状态立刻顶上；状态没了之后，最后一条至少挂满 MIN_SHOW_MS。
      const [held, setHeld] = React.useState(null);
      // 用 ref 记住「正在挂住的那条」，effect 里不再读 state。
      // 之前 effect 依赖里带着 held 自己：每次 view 变化都会 setHeld 一个新对象 →
      // 又多一轮渲染 → 视觉上就是抖一下、闪一下。
      const heldRef = React.useRef(null);
      heldRef.current = held;
      const liveKey = view ? view.key : null;
      React.useEffect(() => {
        if (view) {
          // 同一个 key 就不动 state（view 每次都是新对象，无脑 set 会白白多渲染一轮）。
          if (heldRef.current && heldRef.current.key === view.key) return undefined;
          const next = { key: view.key, view, at: Date.now() };
          heldRef.current = next;
          setHeld(next);
          return undefined;
        }
        const prev = heldRef.current;
        if (!prev || !prev.view) return undefined;
        const left = MIN_SHOW_MS - (Date.now() - prev.at);
        const clear = () => {
          heldRef.current = null;
          setHeld(null);
        };
        if (left <= 0) {
          clear();
          return undefined;
        }
        const timer = setTimeout(clear, left);
        return () => clearTimeout(timer);
      }, [liveKey]);
      const shown = pickView(view, held, Date.now());
      const holding = Boolean(shown) && !view;

      // 出字速度：思考文本变了就记下长度和真实时间。
      // 「快」= 每秒新增字数超过阈值，这时把标签切换压慢一点，人眼才跟得上。
      const thinkText = lastReasoningText(partial && partial.blocks);
      const seen = React.useRef(null);
      React.useEffect(() => {
        const at = Date.now();
        const prev = seen.current;
        const length = thinkText.length;
        const delta = prev && prev.text === thinkText ? 0 : Math.max(0, length - (prev ? prev.length : 0));
        const span = prev ? Math.max(1, at - prev.at) : 1;
        const cps = prev && prev.text === thinkText ? 0 : Math.round((delta / span) * 1000);
        seen.current = { text: thinkText, length, at, cps };
      }, [thinkText]);
      const fast = Boolean(seen.current) && seen.current.cps >= FAST_CPS;
      const holdMs = fast ? LABEL_HOLD_FAST_MS : LABEL_HOLD_MS;

      // 俏皮词是常驻的：只要有字幕条就有它，不管这一刻是在思考、跑工具还是刚跑完。
      // 位置固定在最右端，「进行中」会主动让位，所以它不会再把主文案挤扁。
      const wordsOn = Boolean(settings.words) && Boolean(view);
      // 起点按回合错开：一百多个词轮完要三分钟，不错开的话彩蛋永远排在最后。
      const seed = Math.abs(((shown && shown.turn) || 0) * 37
        + ((partial && partial.step) || 0)) % WORD_COUNT;
      const wordTick = useTick(WORD_MS, wordsOn);
      const flavor = settings.words ? wordAt(seed + wordTick) : null;

      // 候选文案随数据实时变，但真正显示的要稳一下：模型思考快的时候标签会一秒跳三次。
      // 一律拼成完整一句话（动作 + 具体对象），别只甩两个字的标签。
      const candidate = React.useMemo(() => {
        if (!shown) return t('idleStrip');
        if (shown.state === 'thinking') {
          // 上游退避重试：这条必须排在规则文案前面——它是事实，规则是从思考文本里猜的。
          // （原来这个分支放在 thinking 之后，永远走不到。）
          if (shown.retry) {
            return shown.retry.n > 0
              ? fmt(t('retryWait'), { n: shown.retry.n })
              : t('retryWaitBare');
          }
          // 三层兜底：规则文案（读思考文本）→ 阶段话术（本回合干过什么）→ 俏皮词。
          if (shown.ruleId) {
            // 同一动作三种说法轮着来：按（回合, 步）算，稳定不闪。
            const variants = RULE_VARIANTS[shown.ruleId];
            const count = variants ? variants.zh.length : 0;
            if (count > 0) {
              const index = Math.abs((shown.turn || 0) * 13 + (shown.step || 0) * 7) % count;
              return t('r_' + shown.ruleId + '_' + index);
            }
            return t('r_' + shown.ruleId);
          }
          if (shown.phase) return shown.phase;
          return flavor || t('thinking');
        }
        if (shown.state === 'writing') return t('writing');
        if (shown.state === 'running') return actionText(shown.tool, shown.target, 'running');
        if (shown.state === 'error') {
          if (shown.kind === 'exit') return fmt(t('failExit'), { code: shown.code });
          if (shown.kind === 'killed') return t('failKilled');
          // 回合级失败：模型这轮没跑完，不是某个工具挂了，措辞要区分开。
          if (shown.kind === 'maxtokens') return t('failMaxTokens');
          if (shown.kind === 'interrupted') return t('failInterrupted');
          if (shown.kind === 'error') {
            return shown.code ? fmt(t('failTurnCode'), { code: shown.code }) : t('failTurn');
          }
          return t('failTool') + (shown.target ? ' ' + shown.target : '');
        }
        return actionText(shown.tool, shown.target, 'ok');
      }, [shown, flavor, t]);
      const [label, setLabel] = React.useState(candidate);
      React.useEffect(() => {
        if (label === candidate) return undefined;
        const timer = setTimeout(() => setLabel(candidate), holdMs);
        return () => clearTimeout(timer);
      }, [candidate, label, holdMs]);
      // 有事实标签时，俏皮词退到后面当陪衬；已经拼进主文案了就别再重复一遍。
      // 事实标签在场时它一定挂着（不再看「是不是正在思考」），这样它有个固定位置，
      // 不会一会儿出现一会儿被主文案顶掉，看起来就不会「抢位置」。
      const suffix = settings.words && flavor && candidate.indexOf(flavor) < 0 ? flavor : null;

      // 成功态停留几秒就收；失败态留着，等人看完原因或开下一轮。
      const [gone, setGone] = React.useState(false);
      const viewKey = shown ? shown.key : null;
      const viewState = shown ? shown.state : null;
      React.useEffect(() => {
        setGone(false);
        if (viewState !== 'ok') return undefined;
        const timer = setTimeout(() => setGone(true), OK_LINGER_MS);
        return () => clearTimeout(timer);
      }, [viewKey, viewState]);
      const showFull = Boolean(shown) && !gone;
      // 收起（只剩齿轮）时不需要任何稳定窗口：这时候没人看得见文字，
      // 让它直接跟上候选。否则重新出现的头 holdMs 里会闪一下上一次的旧句子。
      React.useEffect(() => {
        if (!showFull && label !== candidate) setLabel(candidate);
      }, [showFull, candidate, label]);

      // 收起时不要立刻把文字抽走：那样会看到「字先消失、空壳再缩」的两段动作。
      // 记住最后一次画出来的内容，让它在收起的 180ms 里跟着淡出，看起来才是一个整体。
      const paintedRef = React.useRef(null);
      if (shown) paintedRef.current = shown;
      const painted = showFull ? shown : paintedRef.current;

      // 步骤号整轮常驻：两步之间 partial 会短暂为空，那一刻 view 的 step 是 null，
      // 以前就照着 null 把「第 N 步」整块摘掉，下一步再挂回来——看着就是标题在闪。
      // 现在记住最后一个非空步号，空档时沿用；只有跨到新的一轮才清空。
      const stepRef = React.useRef({ turn: null, step: null });
      const shownTurn = shown && typeof shown.turn === 'number' ? shown.turn : null;
      if (shownTurn !== null && stepRef.current.turn !== shownTurn) {
        stepRef.current = { turn: shownTurn, step: null };
      }
      if (shown && typeof shown.step === 'number') stepRef.current.step = shown.step;
      const pinnedStep = shown && typeof shown.step === 'number' ? shown.step : stepRef.current.step;
      // 整轮最前面这几步状态翻得最勤：不播任何淡入，纯硬切换，把「闪」从根上掐掉。
      const settling = typeof pinnedStep === 'number' && pinnedStep <= SETTLE_STEPS;
      // 俏皮词换词要「滚上去」：得同时留着上一句，让它往上滚出去，新的一句从底下顶上来。
      // 这里在渲染期记住「上一个是哪句」——写两遍结果一样，所以重复渲染也不会错位。
      const flavorRef = React.useRef({ cur: suffix, prev: null });
      if (flavorRef.current.cur !== suffix) {
        flavorRef.current = { cur: suffix, prev: flavorRef.current.cur };
      }
      const flavorPrev = flavorRef.current.prev;

      const status = !shown
        ? ''
        : shown.state === 'ok'
          ? t('stateOk')
          : shown.state === 'error'
            ? t('stateFail')
            : t('stateRunning');

      // 现代控件：分段选择器（替代原生 <select>）+ 滑动开关。
      // 颜色全部取 DSH 自己的主题变量，明暗主题自动跟着走，不再出现系统灰控件。
      const seg = (name, value, options, onChange) => h('span', {
        className: 'pgc-seg',
        role: 'group',
        'aria-label': t(name),
      }, options.map((option) => h('button', {
        type: 'button',
        key: option.value,
        className: 'pgc-seg-btn',
        'data-on': option.value === value ? 'true' : 'false',
        'aria-pressed': option.value === value ? 'true' : 'false',
        onClick: () => onChange(option.value),
      }, t(option.label))));

      // 颜色选择：色块按钮，比下拉直观；「跟随主题」用一个小圆环表示。
      // 色块本身没有可见文字，所以颜色名必须写进 aria-label —— 以前六个色块的
      // aria-label 全是同一个「字幕条颜色」，读屏根本分不出点的是哪个色。
      const swatches = (name, value, table, onChange) => h('span', {
        className: 'pgc-swatches',
        role: 'group',
        'aria-label': t(name),
      }, Object.keys(table).map((key) => h('button', {
        type: 'button',
        key,
        className: 'pgc-swatch' + (table[key].value ? '' : ' pgc-swatch--auto'),
        'data-on': key === value ? 'true' : 'false',
        'aria-pressed': key === value ? 'true' : 'false',
        'aria-label': t(table[key].label),
        title: t(table[key].label),
        style: table[key].value ? { '--pgc-sw': table[key].value } : undefined,
        onClick: () => onChange(key),
      }, table[key].value ? '' : 'A')));

      const switchButton = (on, label, hint, flip) => h('button', {
        type: 'button',
        className: 'pgc-switch',
        role: 'switch',
        'aria-checked': on ? 'true' : 'false',
        'data-on': on ? 'true' : 'false',
        title: hint || label,
        onClick: flip,
      }, h('span', { className: 'pgc-switch-track' },
        h('span', { className: 'pgc-switch-thumb' })),
        h('span', { className: 'pgc-switch-label' }, label));

      // 面板常驻 DOM（收起时只改变透明度和位移），点齿轮开合，展开有过渡动画。
      const settingsPanel = h('div', { className: 'pgc-settings' },
        h('button', {
          type: 'button',
          className: 'pgc-gear',
          ref: gearRef,
          'aria-expanded': settingsOpen ? 'true' : 'false',
          'aria-label': t('settings'),
          title: t('settings'),
          onClick: () => setSettingsOpen((open) => !open),
        }, '⚙'),
        h('div', {
          className: 'pgc-sheet' + (settingsOpen ? ' pgc-sheet--open' : ''),
          role: 'dialog',
          'aria-label': t('settings'),
          'aria-hidden': settingsOpen ? 'false' : 'true',
        },
          h('div', { className: 'pgc-sheet-head' },
            h('span', { className: 'pgc-sheet-title' }, t('settings')),
            h('button', {
              type: 'button',
              className: 'pgc-sheet-close',
              'aria-label': t('close'),
              title: t('close'),
              onClick: () => setSettingsOpen(false),
            }, '✕')),
          h('div', { className: 'pgc-sheet-body' },
            h('span', { className: 'pgc-group' }, t('groupLook')),
            settingRow(t, 'size', seg('size', settings.size, [
              { value: 's', label: 'sizeS' },
              { value: 'm', label: 'sizeM' },
              { value: 'l', label: 'sizeL' },
            ], (value) => update({ size: value }))),
            settingRow(t, 'anim', seg('anim', settings.anim, [
              { value: 'calm', label: 'animCalm' },
              { value: 'sweep', label: 'animSweep' },
              { value: 'off', label: 'animOff' },
            ], (value) => update({ anim: value }))),
            h('span', { className: 'pgc-group' }, t('groupColor')),
            settingRow(t, 'colorAccent', swatches('accent', settings.accent, ACCENTS, (value) => update({ accent: value }))),
            settingRow(t, 'colorOk', seg('okColor', settings.okColor, [
              { value: 'theme', label: 'toneTheme' },
              { value: 'green', label: 'swGreen' },
              { value: 'teal', label: 'swTeal' },
            ], (value) => update({ okColor: value }))),
            settingRow(t, 'colorBad', seg('badColor', settings.badColor, [
              { value: 'theme', label: 'toneTheme' },
              { value: 'red', label: 'swRed' },
              { value: 'orange', label: 'swOrange' },
            ], (value) => update({ badColor: value }))),
            settingRow(t, 'colorFlavor', seg('flavorStyle', settings.flavorStyle, [
              { value: 'tint', label: 'toneTint' },
              { value: 'solid', label: 'toneSolid' },
              { value: 'plain', label: 'tonePlain' },
            ], (value) => update({ flavorStyle: value }))),
            h('span', { className: 'pgc-group' }, t('groupSay')),
            settingRow(t, 'words', switchButton(settings.words, settings.words ? t('wordsOn') : t('wordsOff'), '', () => update({ words: !settings.words }))),
            settingRow(t, 'subLine', switchButton(settings.subLine, settings.subLine ? t('wordsOn') : t('wordsOff'), t('subLineHint'), () => update({ subLine: !settings.subLine }))),
            settingRow(t, 'facts', seg('facts', settings.factsOnly ? 'tools' : 'thinking', [
              { value: 'tools', label: 'factsTools' },
              { value: 'thinking', label: 'factsThinking' },
            ], (value) => update({ factsOnly: value === 'tools' }))),
            h('p', { className: 'pgc-sheet-hint' }, t('factsHint')),
            h('p', { className: 'pgc-sheet-note' }, t('sheetNote')),
            h('p', { className: 'pgc-sheet-note' }, t('disclaimer')))));

      // 注意：这里不再「有字幕就返回整条、没字幕就返回把手」两套结构。
      // 两套结构会让 React 把整棵子树卸载重建，看起来就是闪一下、没有过渡。
      // 现在永远返回同一个外层（状态条），只切 class；里面的内容用 .pgc-band 收放，
      // 收起来时它高度变 0 并淡出，过渡由 CSS 负责。
      const stripClass = [
        'pgc-strip',
        'pgc-strip--' + (shown ? shown.state : 'idle'),
        holding ? 'pgc-strip--held' : null,
        showFull ? null : 'pgc-strip--handle',
        settling ? 'pgc-strip--settle' : null,
        // 有俏皮词时，右边那圈弧线让位（见 .pgc-slot 上面的注释）：一条字幕只留一个东西在动。
        suffix ? 'pgc-strip--hasflavor' : null,
        'pgc-size-' + settings.size,
        'pgc-anim-' + settings.anim,
        'pgc-flavor-' + settings.flavorStyle,
      ].filter(Boolean).join(' ');

      const colorVars = stripVars(settings);

      return h('div', {
        className: stripClass,
        'data-plugin': 'dsh-progress-caption',
        title: t('disclaimer'),
        style: Object.keys(colorVars).length > 0 ? colorVars : undefined,
      },
        // 扫光的覆盖层：铺满整条胶囊（含右侧齿轮那一格），由 CSS 在「扫光」档才显示。
        // 必须挂在根节点上而不是 .pgc-band 里——band 只是文字那一格，
        // 光扫到 band 右边界就断了，右边齿轮区会留一块没扫到的空白，看着就是没铺满。
        h('span', { className: 'pgc-sweep', 'aria-hidden': true }),
        // 收起时不再「整段不渲染」：内容留着，由 .pgc-band 的高度/透明度过渡把它收掉。
        // 这样字的淡出和条的收缩是同一个动作；也免得读屏念一遍已经看不见的字（收起时 aria-hidden）。
        h('span', { className: 'pgc-band', 'aria-hidden': showFull ? undefined : 'true' },
          painted && showFull
            ? h('span', { className: 'pgc-live', role: 'status', 'aria-live': 'polite' },
              // 步号用 pinnedStep，不用 painted.step：两步之间 partial 为空时，
              // painted.step 会是 null，把「第 N 步」整块摘掉再挂回来，就是标题在闪。
              // pinnedStep 会沿用最后一个非空步号，跨轮才清空，所以它整轮都在、不乱动。
              pinnedStep !== null
                ? h('span', { className: 'pgc-step' }, fmt(t('step'), { n: pinnedStep }))
                : null,
              // 状态标记：一组三点循环（和右侧那个弧线是同一套动作语言）。
              // 之前这里试过「条 / 圆环 / 立体方块」三种形态，观感没做出来，已整段删掉。
              // 三个点装在固定宽度的 .pgc-loader 里，靠负 animation-delay 错开相位，
              // 所以点怎么跳都不会推动右边的主文案。
              h('span', { className: 'pgc-loader', 'aria-hidden': true },
                h('span', { className: 'pgc-dot' }),
                h('span', { className: 'pgc-dot' }),
                h('span', { className: 'pgc-dot' })),
              // 加 key 让「换文案」重挂载一次，淡入才会重播；label 已经被 holdMs
              // 稳定过（最快 520ms / 快思考 800ms 才换一次），比 160ms 的动画长，不会连成闪烁。
              h('span', { className: 'pgc-text' },
                h('span', { className: 'pgc-label', key: label }, label),
                // 「思考原话」开关打开后，才多给一行模型自己的思考首句当副行。
                settings.subLine && painted.state === 'thinking' && painted.sub
                  ? h('span', { className: 'pgc-sub' }, painted.sub)
                  : null),
              // 俏皮词在场时，不再重复挂「进行中」——两个都在就互相挤，主文案被压成两三个字。
              // 进行中由左侧小圆点表达；「成功 / 失败」是结论，任何时候都留着。
              status && (!suffix || painted.state === 'ok' || painted.state === 'error')
                ? h('span', { className: 'pgc-chip' }, status)
                : null,
              // 这里原来是耗时（`pgc-time`），已移除：那个数字和思维链区域的时间重复，
              // 而且每秒跳一次还容易抢注意力。位置现在放一个匀速转的细弧线。
              // 宽高写死在 .pgc-slot 上（3.6em × 1em，与原来的耗时格一样宽），
              // 所以弧线怎么转都不会把左右两边挤动，俏皮词的位置也跟以前一致。
              // 不能删：删掉后「状态胶囊 → 俏皮词」的间距会变，看着像排版塌了。
              h('span', {
                className: 'pgc-slot',
                'data-pgc-slot': 'loop',
                'aria-hidden': true,
              }, h('span', { className: 'pgc-arc' },
                [0, 1, 2].map((i) => h('span', { key: i })))),
              // 俏皮词放最右端：它只是气氛，不属于左边那句状态描述。
              // 换词时胶囊底色不动，只有里面那条「两行字的履带」整体往上滚半格：
              // 上一句滚出框、新的一句顶到中间停住。
              // 原来是把整个胶囊重挂载一次、从 45% 透明度浮上来 —— 每 2.8 秒连底色跟着闪一下，
              // 那是「生硬」的来源。
              suffix
                ? h('span', { className: 'pgc-flavor' },
                  h('span', {
                    // key 换掉 = 整条履带重新挂载 = 换词动画从 translateY(0) 重新滚一次。
                    // 只有滚动体重挂载，胶囊外壳不动，所以底色和边框不会跟着闪。
                    className: flavorPrev ? 'pgc-flavor-track' : 'pgc-flavor-track pgc-flavor-still',
                    key: 'roll:' + suffix,
                  },
                    h('span', { className: 'pgc-flavor-line', 'aria-hidden': true }, flavorPrev || suffix),
                    h('span', { className: 'pgc-flavor-line' }, suffix)))
                : null)
            : null,
          painted && showFull && painted.state === 'error' && painted.rawLine
            ? h('details', { className: 'pgc-detail' },
              h('summary', { className: 'pgc-detail-sum' }, t('detail')),
              h('code', { className: 'pgc-raw' }, painted.rawLine))
            : null),
        settingsPanel);
    }

    /**
     * 一个回合的小结：只数事实（工具结果条数、成败、耗时），不猜语义。
     * 范围 = 上一个回合结束之后、这一回合结束之前（用 seq 卡住）。
     */
    function summarizeTurn(source) {
      const nodes = source && Array.isArray(source.nodes) ? source.nodes : EMPTY;
      const endSeq = source && typeof source.endSeq === 'number' ? source.endSeq : null;
      const turn = source && typeof source.turn === 'number' ? source.turn : null;
      if (endSeq === null || turn === null) return null;
      const ends = source.turnEnds;
      const prev = ends && typeof ends.get === 'function' ? (ends.get(turn - 1) || 0) : 0;
      const results = [];
      for (const node of nodes) {
        if (!node || node.kind !== 'tool-result') continue;
        if (typeof node.seq !== 'number' || node.seq <= prev || node.seq > endSeq) continue;
        results.push(node);
      }
      if (results.length === 0) return null;
      let ok = 0;
      let bad = 0;
      let first = Infinity;
      let last = -Infinity;
      for (const node of results) {
        if (failureOf(node)) bad += 1; else ok += 1;
        if (typeof node.callTime === 'number') first = Math.min(first, node.callTime);
        if (typeof node.time === 'number') last = Math.max(last, node.time);
      }
      const ms = Number.isFinite(first) && Number.isFinite(last) ? Math.max(0, last - first) : 0;
      return { total: results.length, ok, bad, ms };
    }

    /** 回合末尾的一行小结（挂在 conversation.chat.turnTail）。 */
    function TurnSummary(props) {
      return props.useChat ? h(TurnSummaryLive, props) : null;
    }

    function TurnSummaryLive(props) {
      const t = props.t || translate;
      const nodes = useChatOf(props)((state) => state.legacy.nodes);
      const turnEnds = useChatOf(props)((state) => state.legacy.turnEnds);
      const turn = props.turn;
      if (!turn || turn.status !== 'closed' || typeof turn.turn !== 'number') return null;
      const summary = summarizeTurn({
        nodes,
        turnEnds,
        endSeq: props.seq,
        turn: turn.turn,
      });
      if (!summary) return null;
      const parts = [
        t('sumTurn'),
        fmt(t('sumTools'), { n: summary.total }),
        summary.bad > 0 ? fmt(t('sumPair'), { ok: summary.ok, bad: summary.bad }) : null,
        summary.ms > 0 ? fmt(t('sumTime'), { s: durationText(summary.ms) }) : null,
      ].filter(Boolean);
      return h('div', {
        className: 'pgc-summary',
        'data-plugin': 'dsh-progress-caption',
        title: t('disclaimer'),
      }, h('span', { className: 'pgc-summary-text' }, parts.join(' · ')));
    }

    /* ------------------------------------------------------------------ *
     * 样式：全部 pgc- 前缀；颜色尽量用 currentColor / 系统色，自动跟明暗主题。
     * 动画只碰 opacity / transform / background-position，绝不改宽高，避免推挤布局。
     * ------------------------------------------------------------------ */
    const CSS = `
/* 自定义配色走这三个变量；没选（跟随主题）时自动退回 DSH 主题色。 */
.pgc-strip {
  --pgc-accent: var(--dsw-alias-brand-primary, #4d6bfe);
  --pgc-ok: var(--dsw-alias-state-success-primary, #2f9e68);
  --pgc-bad: var(--dsw-alias-state-error-primary, #d94a3d);
  display: flex; align-items: center; gap: 8px; box-sizing: border-box;
  /* 宽度对齐输入框卡片。官方输入卡是「父容器先左右各留 side-clearance，再由卡片
     用 max-width 卡上限」两层（uV2eYG_root 的 padding + uV2eYG_card 的 max-width），
     而字幕条所在的 composerStack 是**没有内边距**的（wSkVaW_composerStack 只有 gap），
     所以这里必须自己减掉两侧留白，否则会比输入框宽出 2×16px、看起来像撑满整个容器。 */
  width: calc(100% - 2 * var(--dsh-composer-side-clearance, 16px));
  max-width: var(--dsh-composer-card-max-width, 952px);
  margin: 0 auto 6px; padding: 5px 10px; border-radius: 10px;
  border: 1px solid color-mix(in srgb, var(--pgc-accent) 20%, transparent);
  background: color-mix(in srgb, var(--pgc-accent) 8%, transparent);
  line-height: 1.4; color: var(--dsw-alias-label-primary, inherit);
  /* 扫光覆盖层 .pgc-sweep 按整条胶囊定位（inset: 0），所以这里必须有定位上下文。
     设置面板自己有 position: relative，不受影响。 */
  position: relative;
  /* 根节点故意不挂 animation：它一挂，任何一次重渲染都可能让整条重播一遍，
     那就是「闪」。入场交给 .pgc-band 的收放过渡，视觉上是一整块浮出来。 */
  /* 状态标记的节奏放在这里，只改一处：左侧的条与右侧那圈弧线共用同一个周期，
     一条字幕里不出现两种节奏（旧版是点 3.2s、弧 2.2s，两边各走各的）。
     变量名还叫 --pgc-dot-cycle，因为弧线那几行也在用它，改名要一起动，没必要。 */
  --pgc-dot-cycle: 2.4s;
  /* 扫光档的周期：条扫得快一档，跟文字的流光对上（.9s 一次）。 */
  --pgc-hop-cycle: .9s;
  transition: background-color .2s ease, border-color .2s ease, padding .2s cubic-bezier(.23, 1, .32, 1);
}
/* 思考/工具/状态切换时只换底色和描边，绝不重排：整条的高度、位置都不动。 */
.pgc-band {
  display: flex; align-items: center; gap: 0; min-width: 0; flex: 1 1 auto;
  /* 光在覆盖层 .pgc-sweep 上从整条胶囊底下扫过去，文字要压在上面才不被染色。
     这里给个定位 + z-index: 1，把整块文字层抬到 .pgc-sweep（z-index: auto）之上。 */
  position: relative; z-index: 1;
  /* 7em 是给「主文案 + 副行」留的上限。
     收放用 max-height（会触发布局，这是唯一一处：不收高度就只能留个空壳），
     时长压到 180ms 并把缓动换成强 ease-out，看上去是一口气收掉而不是慢慢挤。 */
  max-height: 7em; opacity: 1;
  /* 这里必须裁剪：收成齿轮、展开/收起时靠它把多出来的行藏住。
     但裁剪框正好贴着内容高度时，入场/换词那 2px 的 translateY 会把右下角
     （俏皮词胶囊的底边）切掉一条——一行时内容最矮，所以只有「一行」才看得见。
     解法：上下各加 6px 内边距把裁剪框撑开，再用 -6px 外边距抵回去，
     外层占位高度一分不差，但裁剪框比内容高 12px，2px 的位移就切不到了。
     注意不能改成 overflow: visible —— 那样收起途中内容会从 0 高度的框里溢出去，
     压到上面那条排队消息上，就是「指令堆叠时显示异常」。 */
  padding-block: 6px; margin-block: -6px;
  overflow: hidden;
  transition: max-height .18s cubic-bezier(.23, 1, .32, 1), opacity .16s ease;
}
/* 收起时把刚才那 6px 内边距和外边距一起归零，才能真正收成一条细缝。 */
.pgc-strip--handle .pgc-band { max-height: 0; opacity: 0; padding-block: 0; margin-block: 0; }
/* DeepSeek 蓝是主色；成功/失败只换强调色，形状和排版保持一致。 */
.pgc-strip--ok { border-color: color-mix(in srgb, var(--pgc-ok) 24%, transparent); background: color-mix(in srgb, var(--pgc-ok) 8%, transparent); }
.pgc-strip--error { border-color: color-mix(in srgb, var(--pgc-bad) 28%, transparent); background: color-mix(in srgb, var(--pgc-bad) 9%, transparent); }
/* 入场动画挂在 .pgc-live 上，而不是整条根节点：它只在「有内容 ↔ 无内容」切换时
   挂载一次，所以一次出现只播一次；根节点挂动画则会被任何重渲染重播，那就是闪。
   from/to 只碰 opacity 与 transform，不参与布局。 */
.pgc-live { display: flex; align-items: center; gap: 7px; min-width: 0; flex: 1 1 auto; animation: pgc-enter .22s cubic-bezier(.23, 1, .32, 1) both; }
.pgc-size-s { font-size: 11px; }
.pgc-size-m { font-size: 12px; }
.pgc-size-l { font-size: 13.5px; }
.pgc-step { flex: 0 0 auto; font-variant-numeric: tabular-nums; font-weight: 600; color: var(--pgc-accent); }
.pgc-strip--ok .pgc-step { color: var(--pgc-ok); }
.pgc-strip--error .pgc-step { color: var(--pgc-bad); }
/* ── 状态标记：三颗 4px 的点，排队起跳 ────────────────────────────────────────
   形态照着 dsh-claude-style 的 .dsh-claude-chat-wait-dot 抄（
   node_modules/dsh-claude-style/lib/client.js）：
   - 容器 18×14，三颗点各自绝对定位在 left 0 / 7 / 14px；
   - 周期 .5s、ease、infinite alternate：一条动画既去又回，不用写两段；
   - 三颗的负延迟分别是 -1 周期 / -3/5 周期 / -2/5 周期 —— 于是任何时候
     都有一颗在最高点、一颗在半空、一颗刚落地，读起来是「接力跳」而不是三颗齐跳；
   - 关键帧里先压扁再弹起（squash & stretch）：0% 时 scale(1.7,.25) 贴地，
     起来后拉回 1，落地那一下才有重量感；
   - 全程只动 transform，走合成层，不改宽高、不推挤右边的主文案。

   为什么不用「一条横扫的线 / 绕圈的点 / 立体方块」：那三套做过了，观感不对，已删。
   容器定宽 18px，跳动幅度在容器内部消化，右侧文案一格都不动。 */
.pgc-loader {
  position: relative;
  flex: 0 0 auto;
  width: 18px; height: 14px;
  overflow: visible;
  /* 安静档周期（默认）：比扫光档慢一半，属于「在动，但不抢注意力」。 */
  --pgc-dot-period: 1.1s;
}
.pgc-dot {
  position: absolute;
  bottom: 0; left: 0;
  width: 4px; height: 4px;
  border-radius: 50%;
  background: var(--pgc-accent);
  /* 以底部为铰链：压扁时往下铺、拉长时往上顶，看起来才像「踩在地上」。 */
  transform-origin: 50% 100%;
  transition: background-color .26s cubic-bezier(.23, 1, .32, 1);
}
.pgc-dot:nth-child(2) { left: 7px; }
.pgc-dot:nth-child(3) { left: 14px; }
/* 安静 / 扫光两档都在跳，只是周期不同；扫光档跟文字的光带对上（.5s）。 */
.pgc-anim-calm .pgc-dot,
.pgc-anim-sweep .pgc-dot {
  animation: pgc-dot-bounce var(--pgc-dot-period) ease infinite alternate;
}
.pgc-anim-calm .pgc-dot:nth-child(1),
.pgc-anim-sweep .pgc-dot:nth-child(1) { animation-delay: calc(-1 * var(--pgc-dot-period)); }
.pgc-anim-calm .pgc-dot:nth-child(2),
.pgc-anim-sweep .pgc-dot:nth-child(2) { animation-delay: calc(-3 * var(--pgc-dot-period) / 5); }
.pgc-anim-calm .pgc-dot:nth-child(3),
.pgc-anim-sweep .pgc-dot:nth-child(3) { animation-delay: calc(-2 * var(--pgc-dot-period) / 5); }
.pgc-anim-sweep .pgc-loader { --pgc-dot-period: var(--pgc-hop-cycle); }
/* 成功 / 失败态：只换颜色，不把标记冻住。
   原来这里写 animation: none —— 结果是「动作已经跑完、但这一轮还没收」的那几秒里，
   左边定住了、右边俏皮词还在滚，一边静一边动，看着像坏了。 */
.pgc-strip--ok .pgc-dot { background: var(--pgc-ok); }
.pgc-strip--error .pgc-dot { background: var(--pgc-bad); }
/* 全静止档：三颗点停在原地，只留中间那颗 —— 排一排不动的点在视觉上像「加载卡住」。 */
.pgc-anim-off .pgc-dot { animation: none; transform: none; opacity: .55; }
.pgc-anim-off .pgc-dot:nth-child(2),
.pgc-anim-off .pgc-dot:nth-child(3) { display: none; }
/* 主文案：一行放不下就省略号，别缩成俩字。
   不再按「行数 2/3」加 line-clamp——主文案是拼出来的整句（十几个字），
   开 2/3 行几乎不会真的折行，视觉上没差别，所以那个设置项已经删了。 */
.pgc-text { display: flex; flex-direction: column; justify-content: center; flex: 1 1 auto; min-width: 0; }
.pgc-sub { flex: 0 0 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: .92em; line-height: 1.5; color: var(--dsw-alias-label-secondary, inherit); opacity: .78; }
.pgc-label { position: relative; flex: 0 0 auto; min-width: 0; overflow: hidden; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 1; overflow-wrap: anywhere; }
/* 文案换了才重播的淡入上浮：只动 opacity + translateY（合成层），不改宽高、不重排。
   160ms 是「看得见但来不及拖沓」的量级；换文案的间隔由 holdMs 兜住，不会连成闪烁。
   只在「安静 / 扫光」两档挂动画，「全静止」档连这个也关掉。 */
.pgc-anim-calm .pgc-label,
.pgc-anim-sweep .pgc-label { animation: pgc-swap .16s cubic-bezier(.23, 1, .32, 1) both; }
/* 整轮最前面几步（≤ SETTLE_STEPS）一律硬切换：状态翻得最勤的就是这几步，
   淡入/上浮一秒能量播两三次，叠起来就是「一直在闪」。这一步只关「换文案」的动画，
   不动排版，也不关 .pgc-live 的入场动画——那个一次出现只播一次，不是闪烁来源。 */
.pgc-strip--settle .pgc-flavor,
.pgc-strip--settle .pgc-flavor-track,
.pgc-strip--settle .pgc-label { animation: none; }
/* 扫光：整条字幕从左到右掠过一遍，光带铺满这个框的宽度。
   （原来是 40% 宽的光带只在第一行主文案里走，看起来是「中间闪一下」。）
   - 挂在一个铺满整条胶囊的覆盖层 .pgc-sweep 上，而不是 .pgc-band 上：
     band 只是「文字那一格」，右边放齿轮的那一列不在它里面，
     光扫到 band 右边界就断了，看着就是「没有占满、右边少一块」。
   - 覆盖层 inset: 0 + border-radius: inherit + overflow: hidden：
     光的边界就是整条胶囊的圆角轮廓，齿轮那一格也一起被扫到；
   - width: 100%：光带本身就有整框那么宽，配合 translateX(-100%) → translateX(100%)
     正好是「左边界外 → 右边界外」，全程没有局部聚集；
   - 渐变是「透明 → 亮 → 透明」横跨整条，所以扫过时看到的是均匀一道光，不是中间一个点；
   - pointer-events: none：光只是画的，不影响点齿轮；
   - 只动 transform（合成层），不改宽高、不起重排。 */
/* 扫光覆盖层：默认不存在，只有「扫光」档才铺开。
   收成齿轮时也没有内容可扫，一并关掉，免得那颗小胶囊上闪一下。 */
.pgc-sweep { display: none; }
.pgc-strip--handle .pgc-sweep { display: none !important; }
.pgc-anim-sweep .pgc-sweep {
  display: block;
  position: absolute; inset: 0;
  border-radius: inherit;
  overflow: hidden;
  pointer-events: none;
}
.pgc-anim-sweep .pgc-sweep::after {
  content: '';
  position: absolute;
  top: 0; bottom: 0; left: 0;
  width: 100%;
  pointer-events: none;
  background-image: linear-gradient(
    90deg,
    transparent 0%,
    color-mix(in srgb, var(--pgc-accent) 22%, transparent) 45%,
    color-mix(in srgb, var(--pgc-accent) 30%, transparent) 50%,
    color-mix(in srgb, var(--pgc-accent) 22%, transparent) 55%,
    transparent 100%
  );
  transform: translateX(-100%);
  animation: pgc-sweep 2.4s cubic-bezier(.45, .05, .55, .95) infinite;
}
/* 主文案自己不再挂扫光（以前是 .pgc-label::after 那层窄光带）。 */
.pgc-anim-sweep .pgc-label::after { content: none; animation: none; }
/* 第二行（思考原话）也不再单独扫：整条已经一起扫了，再叠一层就是双光。 */
.pgc-anim-sweep .pgc-sub::after { content: none; animation: none; }
/* 俏皮词：不用斜体（中文被强行倾斜很难看），固定占最右一格。
   宽度写死 6.6em：词最短 3 字最长 5 字，写死之后换词时右边这块纹丝不动，
   左边的状态文字就不会被一会儿推左一会儿推右（这也是「闪」的一个来源）。
   换词时外壳（底色 / 圆角 / 宽度）一律不动，只有里面两行字在滚：
   这个框就是那条「滚槽」，overflow: hidden 把滚出去的那半句裁掉。 */
.pgc-flavor {
  flex: 0 0 auto; width: 6.6em; max-width: 46%; margin-left: 6px;
  position: relative; display: inline-flex; align-items: center; justify-content: center;
  height: 1.6em;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: center;
  font-style: normal; font-weight: 600; font-size: .95em; line-height: 1.6; letter-spacing: .2px;
  color: var(--pgc-accent);
  background: color-mix(in srgb, var(--pgc-accent) 15%, transparent);
  border: 1px solid color-mix(in srgb, var(--pgc-accent) 30%, transparent);
  border-radius: 999px; padding: 0 9px;
  transition: color .18s ease, background-color .18s ease, border-color .18s ease;
}
/* 滚槽里的滚动体：上一句在上、新的一句在下，两行竖直叠着，整体往上滚半格。
   滚动体的高度是滚槽的两倍，所以「滚半格」正好等于「滚一行」——
   任何一帧，两行之间的距离都恰好是一行，绝不会像各动各的那样在中间叠成一坨。
   只动 transform，走合成层，不重排，也不推挤左边的主文案。 */
.pgc-flavor-track {
  position: absolute; left: 0; right: 0; top: 0; height: 200%;
  display: flex; flex-direction: column;
  /* 默认就停在下面那一行（新词）：动画被关掉时等于硬切换，不会停在上一句上。 */
  transform: translateY(-50%);
  animation: pgc-flavor-roll .42s cubic-bezier(.25, .46, .45, .94) both;
}
.pgc-flavor-line {
  flex: 0 0 50%;
  display: flex; align-items: center; justify-content: center;
  overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
}
/* 刚出现（还没有「上一句」）时不要滚：条本身已经在播入场动画，再滚一次就显得吵。 */
.pgc-flavor-still { animation: none; }
/* 俏皮词三种样式：淡色底（默认）/ 实心 / 素色（不要底色，只留字）。 */
/* 换词动画挂在滚动体上（.pgc-flavor-track 自带 animation），外壳不再挂，
   所以原来「每个词都连胶囊一起重挂载」的闪烁没有了。全静止档由后面的规则统一关掉。 */
.pgc-flavor-solid .pgc-flavor { color: #fff; background: var(--pgc-accent); border-color: transparent; }
.pgc-flavor-plain .pgc-flavor { color: var(--pgc-accent); background: transparent; border-color: transparent; opacity: .92; }
.pgc-strip--ok .pgc-flavor {
  color: var(--pgc-ok);
  background: color-mix(in srgb, var(--pgc-ok) 15%, transparent);
  border-color: color-mix(in srgb, var(--pgc-ok) 30%, transparent);
}
.pgc-strip--error .pgc-flavor {
  color: var(--pgc-bad);
  background: color-mix(in srgb, var(--pgc-bad) 15%, transparent);
  border-color: color-mix(in srgb, var(--pgc-bad) 30%, transparent);
}
.pgc-flavor-solid.pgc-strip--ok .pgc-flavor { color: #fff; background: var(--pgc-ok); border-color: transparent; }
.pgc-flavor-solid.pgc-strip--error .pgc-flavor { color: #fff; background: var(--pgc-bad); border-color: transparent; }
.pgc-flavor-plain.pgc-strip--ok .pgc-flavor { background: transparent; border-color: transparent; }
.pgc-flavor-plain.pgc-strip--error .pgc-flavor { background: transparent; border-color: transparent; }
.pgc-chip { flex: 0 0 auto; padding: 0 6px; border: 1px solid color-mix(in srgb, var(--pgc-accent) 38%, transparent); border-radius: 999px; font-size: 11px; color: var(--pgc-accent); }
.pgc-strip--ok .pgc-chip { color: var(--pgc-ok); border-color: color-mix(in srgb, var(--pgc-ok) 48%, transparent); }
.pgc-strip--error .pgc-chip { color: var(--pgc-bad); border-color: color-mix(in srgb, var(--pgc-bad) 52%, transparent); }
/* 【原耗时位】原来这里放的是耗时（.pgc-time，已移除：和思维链区域的时间重复）。
   现在这块地放「三个点绕着圈跑」的加载标记（原来是三颗原地跳动的点，太吵；中间试过
   一根匀速转的弧线，被评价为死板——一段硬边的弧按固定角速度转，看着就是个节拍器）：
   - 盒子宽高写死（3.6em × 1em，宽度与原来的耗时格一致），所以怎么转都不推挤左右；
   - 三个点各自跑同一条 0→720° 的过渡曲线，只差 0.18s 的出发时间：曲线两头慢、
     中间快，所以慢的地方几个点挤成一串、快的地方一下甩开——这是 Windows 开机转圈
     的手法，转起来有"甩"的感觉，不是匀速转盘；
   - 0→720° 是整两圈，所以关键帧结束时位置与起点重合；配合两端速度为 0 的对称缓动，
     循环接缝不会「咯噔」，首尾的淡入淡出只是把"停一下"那口气掩掉；
   - 点只画 2px，整体 12px（就是 1em），在行里不顶格；
   - 只动 transform / opacity（合成层），不改宽高、不重排、不遮挡点击。 */
.pgc-slot {
  flex: 0 0 auto;
  width: 3.6em; height: 1em;
  display: inline-flex; align-items: center; justify-content: center;
  /* 收起来 / 展开时是渐变的，不是啪一下少一块。 */
  transition: width .2s cubic-bezier(.23, 1, .32, 1), opacity .2s ease;
}
/* 一条字幕里只允许一个东西在动。
   本来右边那圈绕圈的点转得好好的，俏皮词一加上，两个相邻的小东西（相隔不到 40px、
   同一个强调色、还有两种不同的节奏：弧线 2.2s 一圈，俏皮词 2.8s 滚一次）就互相抢视线，
   看的人不知道该盯哪个 —— 这就是「互抢」。
   规则改成：俏皮词在场时，弧线停转并让出位置；俏皮词不在（只报动作 / 自己关掉了）时弧线照转。
   两种状态都只有一处动。 */
.pgc-strip--hasflavor .pgc-slot { width: 0; opacity: 0; pointer-events: none; }
.pgc-strip--hasflavor .pgc-slot .pgc-arc > span { animation: none; }
.pgc-arc {
  position: relative;
  width: 12px; height: 12px;
  display: block;
  pointer-events: none;
}
.pgc-arc > span {
  position: absolute; inset: 0;
  opacity: 0;
  animation: pgc-orbit 2.2s cubic-bezier(.45, .05, .55, .95) infinite;
}
/* 点画在每格的正上方，整格旋转，就等于绕圆心公转。 */
.pgc-arc > span::before {
  content: '';
  position: absolute; top: 0; left: 50%;
  width: 2px; height: 2px; margin-left: -1px;
  border-radius: 50%;
  background: var(--pgc-accent);
}
/* 静止时的姿态：三个点均分一圈（动画跑起来时 transform 由关键帧接管）。 */
.pgc-arc > span:nth-child(1) { transform: rotate(0deg); animation-delay: 0s; }
.pgc-arc > span:nth-child(2) { transform: rotate(120deg); animation-delay: .18s; }
.pgc-arc > span:nth-child(3) { transform: rotate(240deg); animation-delay: .36s; }
/* 安静档：转慢一点，别抢注意力。 */
.pgc-anim-calm .pgc-arc > span { animation-duration: var(--pgc-dot-cycle); }
/* 全静止档：不转，三个点常亮成一圈。 */
.pgc-anim-off .pgc-arc > span { animation: none; opacity: .6; }
/* 已经成功 / 已经失败：没必要继续转，停住，颜色跟随状态色。 */
.pgc-strip--ok .pgc-arc > span,
.pgc-strip--error .pgc-arc > span { animation: none; opacity: .75; }
.pgc-strip--ok .pgc-arc > span::before { background: var(--pgc-ok); }
.pgc-strip--error .pgc-arc > span::before { background: var(--pgc-bad); }
.pgc-strip--handle { padding: 0 10px 2px; background: transparent; border-color: transparent; justify-content: flex-end; }
/* 状态已经结束、只是还没挂满最短停留时间：保持不透明，靠收起动画收，不要再压暗一次（压暗会被看成闪）。 */
.pgc-strip--held { opacity: 1; }
.pgc-summary { margin: 2px 0 4px; font-size: 11px; color: var(--dsw-alias-label-secondary, inherit); opacity: .7; }
.pgc-summary-text { font-variant-numeric: tabular-nums; }
.pgc-detail { flex: 0 0 auto; }
.pgc-detail-sum { font-size: 11px; opacity: .6; cursor: pointer; }
.pgc-raw { display: block; margin-top: 4px; padding: 4px 6px; border-radius: 6px; background: color-mix(in srgb, currentColor 8%, transparent); font-size: 11px; white-space: pre-wrap; }
/* 设置：齿轮 + 浮层面板。颜色取 DSH Theme 服务暴露的 --dsw-alias-* 变量，
   没有变量时退回 currentColor 混色，明暗主题都能自动跟随。 */
.pgc-settings { flex: 0 0 auto; position: relative; display: flex; align-items: center; z-index: 2; }
.pgc-gear {
  width: 22px; height: 22px; display: grid; place-items: center; padding: 0; margin-left: 2px;
  border: 1px solid transparent; border-radius: 999px; background: transparent;
  color: var(--dsw-alias-label-secondary, currentColor); font: inherit; font-size: 12px; line-height: 1;
  cursor: pointer;
  transition: background-color .18s ease, color .18s ease, transform .18s ease;
}
.pgc-gear:hover { color: var(--dsw-alias-label-primary, currentColor); background: color-mix(in srgb, currentColor 10%, transparent); }
.pgc-gear:active { transform: scale(.93); }
.pgc-gear[aria-expanded='true'] { color: #fff; background: var(--dsw-alias-brand-primary, #4f7cff); }
.pgc-sheet {
  position: absolute; right: 0; bottom: calc(100% + 8px); z-index: 40;
  width: 300px; box-sizing: border-box; padding: 14px 14px 12px;
  display: flex; flex-direction: column; gap: 11px;
  max-height: min(76vh, 560px); overflow-y: auto;
  border-radius: 16px; border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.28));
  background: var(--dsw-alias-bg-overlay, Canvas); color: var(--dsw-alias-label-primary, currentColor);
  box-shadow: 0 28px 56px -28px rgba(0,0,0,.5), 0 10px 24px -18px rgba(0,0,0,.4);
  backdrop-filter: blur(20px) saturate(1.5); -webkit-backdrop-filter: blur(20px) saturate(1.5);
  opacity: 0; visibility: hidden; transform: translateY(6px) scale(.97); transform-origin: bottom right;
  transition: opacity .16s ease, transform .18s cubic-bezier(.2,.9,.25,1), visibility .18s;
}
.pgc-sheet--open { opacity: 1; visibility: visible; transform: none; }
.pgc-strip--handle .pgc-sheet { right: 12px; }
.pgc-sheet-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 0 2px; }
.pgc-sheet-title { font-size: 12px; font-weight: 600; letter-spacing: .01em; }
.pgc-sheet-close {
  width: 20px; height: 20px; display: grid; place-items: center; padding: 0;
  border: 0; border-radius: 999px; background: transparent;
  color: var(--dsw-alias-label-secondary, currentColor); font-size: 10px; line-height: 1; cursor: pointer;
  transition: background-color .18s ease, color .18s ease;
}
.pgc-sheet-close:hover { color: var(--dsw-alias-label-primary, currentColor); background: color-mix(in srgb, currentColor 10%, transparent); }
.pgc-sheet-body { display: grid; gap: 8px; }
/* 分组标题做成一条细分隔线 + 小标签，视觉上把面板切成几段，不用数行。 */
.pgc-group {
  display: flex; align-items: center; gap: 8px; margin-top: 4px;
  font-size: 10.5px; font-weight: 600; letter-spacing: .04em;
  color: var(--dsw-alias-label-secondary, inherit); opacity: .75;
}
.pgc-group::after { content: ''; flex: 1; height: 1px; background: var(--dsw-alias-border-l1, rgba(127,127,127,.22)); }
.pgc-group:first-child { margin-top: 0; }
/* 色板：一排小圆点，选中的加一圈描边。 */
.pgc-swatches { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 0 2px; }
.pgc-swatch {
  position: relative; width: 20px; height: 20px; padding: 0; border-radius: 999px;
  border: 1px solid color-mix(in srgb, #000 18%, transparent);
  background: var(--pgc-sw, transparent); color: #fff; font: inherit; font-size: 9px; line-height: 1;
  display: grid; place-items: center; cursor: pointer;
  transition: transform .16s ease, box-shadow .16s ease;
}
.pgc-swatch:hover { transform: scale(1.12); }
.pgc-swatch[data-on='true'] { box-shadow: 0 0 0 2px var(--dsw-alias-bg-overlay, Canvas), 0 0 0 4px var(--pgc-sw, currentColor); }
.pgc-swatch--auto { background: transparent; color: var(--dsw-alias-label-secondary, currentColor); border-style: dashed; font-size: 10px; }
.pgc-swatch--auto[data-on='true'] { background: color-mix(in srgb, currentColor 12%, transparent); }
.pgc-sheet-split { display: block; height: 1px; margin: 1px 0; background: var(--dsw-alias-border-l1, rgba(127,127,127,.24)); }
.pgc-sheet-note { margin: 0; font-size: 10px; line-height: 1.45; opacity: .55; }
.pgc-sheet-hint { margin: 2px 0 4px; font-size: 10.5px; line-height: 1.55; color: var(--dsw-alias-label-secondary, inherit); opacity: .8; }
.pgc-set-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin: 0; }
.pgc-set-name { font-size: 11.5px; color: var(--dsw-alias-label-secondary, currentColor); }
.pgc-seg { display: inline-flex; align-items: center; gap: 2px; padding: 2px; border-radius: 10px; background: color-mix(in srgb, currentColor 7%, transparent); }
.pgc-seg-btn {
  min-width: 24px; padding: 3px 8px; border: 0; border-radius: 8px; background: transparent;
  color: var(--dsw-alias-label-secondary, currentColor); font: inherit; font-size: 11px; line-height: 1.35;
  cursor: pointer; transition: background-color .16s ease, color .16s ease, box-shadow .16s ease;
}
.pgc-seg-btn:hover { color: var(--dsw-alias-label-primary, currentColor); }
.pgc-seg-btn[data-on='true'] {
  color: var(--dsw-alias-label-primary, currentColor);
  background: color-mix(in srgb, var(--dsw-alias-brand-primary, #4f7cff) 20%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--dsw-alias-brand-primary, #4f7cff) 34%, transparent);
}
.pgc-switch { display: inline-flex; align-items: center; gap: 7px; padding: 0; border: 0; background: transparent; color: var(--dsw-alias-label-secondary, currentColor); font: inherit; font-size: 11px; cursor: pointer; }
.pgc-switch-track { position: relative; width: 30px; height: 18px; border-radius: 999px; background: color-mix(in srgb, currentColor 22%, transparent); transition: background-color .2s ease; }
.pgc-switch-thumb { position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 999px; background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,.35); transition: transform .2s cubic-bezier(.3,.9,.3,1); }
.pgc-switch[data-on='true'] .pgc-switch-track { background: var(--dsw-alias-brand-primary, #4f7cff); }
.pgc-switch[data-on='true'] .pgc-switch-thumb { transform: translateX(12px); }
.pgc-switch[data-on='true'] .pgc-switch-label { color: var(--dsw-alias-label-primary, currentColor); }
/* 全静止档：条停住，但整条留着 —— 一条实心短线当作「进行中」的静态记号。
   不留空轨（那看着像坏了），也不再压到 .45（静态下压暗等于没画）。 */
.pgc-anim-off .pgc-label::after { content: none; animation: none; }
/* 「全静止」档真的全静止：入场、换文案、换词都不动，只剩底色过渡（那不算动效）。 */
.pgc-anim-off .pgc-live, .pgc-anim-off .pgc-label, .pgc-anim-off .pgc-flavor,
.pgc-anim-off .pgc-flavor-track { animation: none; }
@media (prefers-reduced-motion: reduce) {
  .pgc-strip, .pgc-strip * { animation: none !important; transition: none !important; }
  .pgc-label::after { content: none !important; }
  /* 系统开了「减少动态效果」时，也不再做位移和缩放，只留颜色的硬切换。 */
  .pgc-band { max-height: 7em; opacity: 1; }
  .pgc-strip--handle .pgc-band { max-height: 0; opacity: 0; margin-block: 0; padding-block: 0; }
  /* 不转的时候，点靠 keyframes 才亮起来，这里要补回可见度，否则整个标记会消失。 */
  .pgc-arc > span { opacity: .6 !important; }
  /* 同理：三点停住后要回到「看得见」的静止形（靠 keyframes 才有位移，一撤就全落回原位）。 */
  .pgc-dot { transform: none !important; opacity: .85 !important; }
}
@keyframes pgc-enter {
  from { opacity: 0; transform: translateY(2px) scale(.984); }
  to { opacity: 1; transform: none; }
}
/* 换文案/换词用的：起点不是 0 而是 .45 —— 真的从 0 开始，每隔几百毫秒就有一次
   「字消失再浮现」，看着就是闪。从 .45 起跳是「换了一句话」而不是「断了一下」。 */
@keyframes pgc-swap {
  from { opacity: .45; transform: translateY(2px); }
  to { opacity: 1; transform: none; }
}
/* 俏皮词换词：两行字当作一条履带，整体往上滚半格（半格＝一行）。
   起点是 translateY(0)（露出上一句），终点是 translateY(-50%)（露出新的一句），
   缓动前段快、后段慢慢落位，所以读起来是「滚上去停住」，不是匀速平移。
   裁切框（.pgc-flavor 的 overflow: hidden）负责把滚出框的那半句切干净。 */
@keyframes pgc-flavor-roll {
  from { transform: translateY(0); }
  to { transform: translateY(-50%); }
}
/* 三点弹跳：照着 dsh-claude-style 的 @keyframes dsh-claude-wait-dot 写。
   0% 贴地压扁（scale(1.7,.25)），40% 起跳并收回到正常比例，
   60% 继续上升，100% 到达最高点。配 infinite alternate 就是「弹起→落回」的往返，
   ease 让落地前减速、起跳时加速，读起来有重力。
   translateY 上限 8px 全部落在 14px 高的容器里，不会溢出到文案行。 */
@keyframes pgc-dot-bounce {
  0% { transform: translateY(0) scale(1.7, .25); animation-timing-function: linear; }
  40% { transform: translateY(-3.2px) scale(1, 1); animation-timing-function: linear; }
  60% { transform: translateY(-4.8px) scale(1, 1); }
  100% { transform: translateY(-8px) scale(1, 1); }
}
/* 扫光关键帧：整条光带从左边界外一路走到右边界外，全程匀速横穿。
   宽度就是整框（100%），所以 -100% 时完全在左侧看不见，100% 时完全越过右侧，
   中间任何时刻都是一道「和框一样宽」的光在平移——没有局部聚集的闪烁。 */
@keyframes pgc-sweep {
  0% { transform: translateX(-100%); }
  100% { transform: translateX(100%); }
}
/* 预留位上的加载标记：三个点绕圈。
   每个点跑同一条 0→720° 的曲线，起点相位差 120°、出发时间差 0.18s；
   曲线是两头慢中间快的对称缓动，所以收尾速度都是 0，循环接缝处不会「咯噔」一下。
   全程只动 transform / opacity，走合成层。 */
@keyframes pgc-orbit {
  0% { transform: rotate(0deg); opacity: 0; }
  10% { opacity: 1; }
  90% { opacity: 1; }
  100% { transform: rotate(720deg); opacity: 0; }
}
`;

    function apply(ctx) {
      // 先注册字典再取绑定：反过来的话，注册完成前那一小段时间里 t() 会直接返回 key 名。
      ctx.effect(() => ctx.locale.register(NS, DICT), 'dsh-progress-caption: locale dictionaries');
      translate = ctx.locale.bind(NS);

      ctx.effect(() => {
        const tag = document.createElement('style');
        tag.setAttribute('data-plugin', 'dsh-progress-caption');
        tag.textContent = CSS;
        document.head.appendChild(tag);
        return () => tag.remove();
      }, 'dsh-progress-caption: stylesheet');

      ctx.slots.inject(SLOT, () => ctx.slots.register({
        name: SLOT,
        id: ENTRY_ID,
        order: ORDER,
        locale: NS,
      }, CaptionStrip));

      // 每回合末尾的小结；没有工具结果时组件自己返回 null，不占位置。
      ctx.slots.inject(TURN_SLOT, () => ctx.slots.register({
        name: TURN_SLOT,
        id: ENTRY_ID + ':turn',
        order: SUMMARY_ORDER,
        locale: NS,
      }, TurnSummary));
    }

    // __test 只给离线测试用；DSH 只认 inject / apply，多出来的字段会被忽略。
    return {
      inject: ['slots', 'locale'],
      apply,
      __test: {
        deriveCaption,
        failureOf,
        pickRule,
        latestTurnFailure,
        pendingRetry,
        RULE_VARIANTS,
        pickThought,
        stripLead,
        splitSentences,
        wordAt,
        durationText,
        toolTarget,
        actionText,
        turnTools,
        gapText,
        phaseText,
        summarizeTurn,
        readSettings,
        writeSettings,
        normalizeSettings,
        stripVars,
        ACCENTS,
        OK_COLORS,
        BAD_COLORS,
        DEFAULT_SETTINGS,
        WORD_COUNT,
        RULES,
        DICT,
        LABEL_HOLD_MS,
        LABEL_HOLD_FAST_MS,
        SETTLE_STEPS,
        FAST_CPS,
        OK_LINGER_MS,
        MIN_SHOW_MS,
        TURN_GAP_MS,
        pickView,
      },
    };
  },
});
