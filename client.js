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
    /** 工具跑多久之后开始陪聊（加一个俏皮词）。 */
    const LONG_TOOL_MS = 5000;
    /** 俏皮词轮换节奏。 */
    // 俏皮词换得太勤会像弹幕，慢一点：2.8 秒换一个。
    const WORD_MS = 2800;
    /** 文案的稳定窗口：候选标签要稳住这么久才换，避免模型快速思考时标签乱闪。 */
    const LABEL_HOLD_MS = 350;
    /** 思考特别快时的稳定窗口：一秒钟最多换一次多一点，人眼跟得上。 */
    const LABEL_HOLD_FAST_MS = 800;
    /** 每秒新增多少个字就算「思考很快」。 */
    const FAST_CPS = 40;
    /** 成功态停留多久后收起（失败态不自动收，留着让人看原因）。 */
    const OK_LINGER_MS = 5000;
    /** 一条字幕最少挂多久：模型想得快时状态零点几秒就结束，留够人读完一行的时间。 */
    const MIN_SHOW_MS = 2600;
    /** 计时器刷新间隔：1 秒太迟钝，400ms 跟手又不费电。 */
    const NOW_MS = 400;
    /** 两步之间 partial 会短暂为空；这段时间（毫秒）内仍算「这一轮还在跑」，字幕不许收。 */
    const TURN_GAP_MS = 20000;
    /** 回合小结挂在 turnTail，排序避开官方与其他插件。 */
    const SUMMARY_ORDER = 40;
    const EMPTY = [];

    /* ------------------------------------------------------------------ *
     * 规则表：加一条 = 在数组里加一个对象，文案会自动并进字典（r_<id>）。
     * hit 里的每条正则都要命中（AND），大小写不敏感由正则自带 /i 决定。
     * ------------------------------------------------------------------ */
    const RULES = [
      {
        id: 'read-config',
        hit: [/读|查看|read/i, /配置|设置|config|package\.json|\.env|\.json/i],
        zh: '正在读取配置文件',
        en: 'reading a config file',
      },
      {
        id: 'search-code',
        hit: [/搜索|查找|定位|搜一下|grep|search|find/i],
        zh: '正在搜索代码',
        en: 'searching the code',
      },
      {
        id: 'edit-code',
        hit: [/修改|编辑|改成|写入|补上|edit|write|patch/i],
        zh: '正在修改代码',
        en: 'editing the code',
      },
      {
        id: 'run-tests',
        hit: [/测试|用例|跑一遍|test|spec|vitest|jest/i],
        zh: '正在跑测试',
        en: 'running tests',
      },
      {
        id: 'install-deps',
        hit: [/安装|依赖|install|pnpm|npm i|dependenc/i],
        zh: '正在安装依赖',
        en: 'installing dependencies',
      },
      {
        id: 'run-command',
        hit: [/运行|执行|跑一下|命令|run|execute|command|build/i],
        zh: '正在运行命令',
        en: 'running a command',
      },
      {
        id: 'check-types',
        hit: [/\.d\.ts|类型|接口|签名|type|api|signature/i],
        zh: '正在查接口类型',
        en: 'checking the API types',
      },
      {
        id: 'plan',
        hit: [/计划|步骤|方案|先.*再|plan|approach|step/i],
        zh: '正在梳理方案',
        en: 'working out an approach',
      },
      /* ---- 下面是按「AI 常见思考动作」补的第二批：更贴近模型真实内心戏 ---- */
      {
        id: 'understand',
        hit: [/理解|分析|明确|梳理一下|弄清楚|看懂|understand|make sense of|analy[sz]e the/i],
        zh: '正在理解你的需求',
        en: 'understanding the request',
      },
      {
        id: 'recall-context',
        hit: [/回顾|回忆|之前的对话|上下文|上文|刚才说|earlier|the context|previous message/i],
        zh: '正在回顾上下文',
        en: 'reviewing the context',
      },
      {
        id: 'locate-bug',
        hit: [/定位|排查|问题出在|哪儿错|哪里错|根源|root cause|what.*wrong|bug在哪|症结/i],
        zh: '正在定位问题',
        en: 'locating the problem',
      },
      {
        id: 'compare-plans',
        hit: [/对比|比较一下|两种方案|三个方案|方案[AB12]|权衡|哪个更好|compare|versus|trade-?off/i],
        zh: '正在对比方案',
        en: 'comparing approaches',
      },
      {
        id: 'decide',
        hit: [/我决定|我打算|采用|就用这|选这|先这样|那就|decide|go with|settle on/i],
        zh: '正在定方案',
        en: 'settling on an approach',
      },
      {
        id: 'verify',
        hit: [/验证|检查一下|确认|核对|再看看对不对|verify|double-?check|confirm/i],
        zh: '正在检查验证',
        en: 'verifying the result',
      },
      {
        id: 'summarize',
        hit: [/总结|归纳|综上|概括|整体来看|梳理完|summar|to sum up|overall/i],
        zh: '正在总结归纳',
        en: 'summarizing findings',
      },
      {
        id: 'risk',
        hit: [/风险|担心|可能会出问题|注意别|小心|有坑|副作用|risk|careful|side effect|caution/i],
        zh: '正在评估风险',
        en: 'weighing the risks',
      },
      {
        id: 'answer-organize',
        hit: [/怎么回答|如何解释|怎么说|组织语言|怎么讲|how to (answer|explain|phrase)/i],
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
      read: 'read', ops_read_files: 'read',
      glob: 'find', grep: 'find',
      write: 'write', edit: 'edit',
      web_search: 'web', web_fetch: 'web',
      subagent: 'delegate', subagent_fork: 'delegate',
    };

    /** 动词组 → 阶段（判断「看完了 N 个文件，在想下一步」这类话术）。 */
    const GROUP_PHASES = {
      read: 'read', find: 'read', exec: 'exec', write: 'edit', edit: 'edit',
      web: 'web', delegate: 'delegate',
    };

    const DICT = {
      zh: {
        step: '第 {n} 步',
        thinking: '正在思考',
        writing: '正在组织回答',
        waiting: '正在准备下一步',
        stateRunning: '进行中',
        stateOk: '成功',
        stateFail: '失败',
        failTool: '工具执行失败',
        failExit: '命令执行失败（exit code {code}）',
        failKilled: '命令被终止（exit code null）',
        detail: '看原始报错',
        elapsed: '{s}s',
        elapsedMin: '{m}分{s}秒',
        sumTurn: '本回合',
        sumTools: '{n} 次工具',
        sumPair: '{ok} 成 {bad} 败',
        sumTime: '用时 {s}',
        disclaimer: '字幕由规则推断，不代表模型真实意图',
        settings: '字幕设置',
        size: '字号',
        sizeS: '小',
        sizeM: '中',
        sizeL: '大',
        lines: '行数',
        anim: '动画',
        animSweep: '扫光',
        animDots: '呼吸点',
        animOff: '关闭',
        words: '俏皮词',
        wordsOn: '开',
        wordsOff: '关',
        facts: '字幕内容',
        factsTools: '只看工具',
        factsThinking: '也看思考',
        factsHint: '选「也看思考」时，没工具在跑就从思考里猜它在干嘛；猜错很正常，别当真。',
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
        v_other_run: '正在执行',
        v_other_done: '完成了',
        /* 阶段话术：工具间隙的思考，按「本回合刚干完什么」说人话 */
        phase_read: '看完了 {n} 个文件，在想下一步',
        phase_edit: '刚改完{target}，在想下一步',
        phase_exec: '命令跑完了，在想下一步',
        phase_web: '查完资料，在想下一步',
        phase_delegate: '小助手回来了，在想下一步',
        phase_other: '做完了 {n} 步，在想下一步',
      },
      en: {
        step: 'Step {n}',
        thinking: 'thinking',
        writing: 'writing the answer',
        waiting: 'getting ready for the next step',
        stateRunning: 'running',
        stateOk: 'done',
        stateFail: 'failed',
        failTool: 'tool call failed',
        failExit: 'command failed (exit code {code})',
        failKilled: 'command was killed (exit code null)',
        detail: 'show the raw error',
        elapsed: '{s}s',
        elapsedMin: '{m}m {s}s',
        sumTurn: 'Turn',
        sumTools: '{n} tools',
        sumPair: '{ok} ok, {bad} failed',
        sumTime: 'took {s}',
        disclaimer: 'Inferred from rules, not the model’s intent',
        settings: 'Caption settings',
        size: 'Text size',
        sizeS: 'Small',
        sizeM: 'Medium',
        sizeL: 'Large',
        lines: 'Lines',
        anim: 'Animation',
        animSweep: 'Shimmer',
        animDots: 'Breathe',
        animOff: 'Off',
        words: 'Playful words',
        wordsOn: 'On',
        wordsOff: 'Off',
        facts: 'Caption content',
        factsTools: 'Tools only',
        factsThinking: 'Tools + thinking',
        factsHint: 'With “Tools + thinking”, the caption guesses from the reasoning text when no tool is running. Guesses can be wrong.',
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
        v_other_run: 'running',
        v_other_done: 'done with',
        phase_read: 'read {n} files, thinking next',
        phase_edit: 'just edited{target}, thinking next',
        phase_exec: 'command finished, thinking next',
        phase_web: 'web search done, thinking next',
        phase_delegate: 'subagent returned, thinking next',
        phase_other: 'did {n} steps, thinking next',
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
    const DEFAULT_SETTINGS = { size: 'm', lines: 1, anim: 'sweep', words: true, factsOnly: false };
    const SIZES = ['s', 'm', 'l'];
    const ANIMS = ['sweep', 'dots', 'off'];

    function pick(value, allowed, fallback) {
      return allowed.indexOf(value) >= 0 ? value : fallback;
    }

    function normalizeSettings(raw) {
      const source = raw && typeof raw === 'object' ? raw : {};
      const lines = Number(source.lines);
      return {
        size: pick(source.size, SIZES, DEFAULT_SETTINGS.size),
        lines: lines === 2 || lines === 3 ? lines : 1,
        anim: pick(source.anim, ANIMS, DEFAULT_SETTINGS.anim),
        words: source.words === undefined ? DEFAULT_SETTINGS.words : Boolean(source.words),
        factsOnly: source.factsOnly === undefined ? DEFAULT_SETTINGS.factsOnly : Boolean(source.factsOnly),
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
     * 工具间隙模型又在思考时，靠它说「看完了 3 个文件，在想下一步」。
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
     * 阶段话术：按「本回合刚干完什么」说人话（最后一条工具的类型决定阶段）。
     * @returns {null | {text: string, sinceMs: number}}
     */
    function phaseText(tools, now) {
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
      const sinceMs = typeof last.time === 'number' ? Math.max(0, (now || Date.now()) - last.time) : null;
      return { text, sinceMs };
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

    /**
     * 摘思考原文的第一句当副行：只截断、不改写，所以永远不会「猜错」。
     * 去掉 markdown 记号（**、`、#）和多余空白，中文句号/问号/换行都算断句。
     */
    function firstSentence(text) {
      if (typeof text !== 'string') return '';
      const clean = text
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/[`*_>#]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      if (!clean) return '';
      const cut = clean.match(/^(.{4,80}?)([。！？!?]|$)/);
      const sentence = cut ? cut[1] : clean.slice(0, 80);
      return sentence.length > 60 ? sentence.slice(0, 60) + '…' : sentence;
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

    /** 规则表匹配：末尾 RULE_SAMPLE 字里，命中第一条 full-match 的规则。 */
    function pickRule(text) {
      if (!text) return null;
      const sample = String(text).slice(-RULE_SAMPLE);
      for (const rule of RULES) {
        if (rule.hit.every((pattern) => pattern.test(sample))) return rule;
      }
      return null;
    }

    /**
     * 纯函数：快照的一段 → 字幕视图模型（不碰 React，方便离线测试）。
     * 优先级：工具事实 > 规则表（读思考文本）> 阶段话术（本回合干过什么）> 俏皮词。
     * @returns {null | {state:'running'|'thinking'|'ok'|'error'|'writing', key:string,
     *   step:number|null, tool:string, target:string, ruleId:string|null,
     *   phase:string|null, elapsedMs:number|null, kind:string|null, code:string|null, rawLine:string}}
     */
    function deriveCaption(input) {
      const source = input || {};
      const partial = source.partial || null;
      const calls = Array.isArray(source.runningCalls) ? source.runningCalls : EMPTY;
      const nodes = Array.isArray(source.nodes) ? source.nodes : EMPTY;
      const now = typeof source.now === 'number' ? source.now : Date.now();
      const turn = partial && typeof partial.turn === 'number'
        ? partial.turn
        : (typeof source.turn === 'number' ? source.turn : null);
      // 回合还没结束（模型没交出这一轮）：哪怕这一刻 partial 是空的（两步之间的空档），
      // 也不能让字幕收起来——用户要的是「思考没结束就一直挂着」。
      if (!partial && calls.length === 0) {
        if (!source.turnOpen || turn === null) return null;
        return {
          key: 'wait:' + turn,
          state: 'thinking',
          turn,
          step: null,
          tool: '',
          target: '',
          ruleId: null,
          phase: source.waitingText || '',
          elapsedMs: null,
          kind: null,
          code: null,
          rawLine: '',
        };
      }

      const step = partial && typeof partial.step === 'number' ? partial.step + 1 : null;

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
          step: typeof call.step === 'number' ? call.step + 1 : step,
          tool: call.name || '',
          target: toolTarget(call),
          ruleId: null,
          phase: null,
          elapsedMs: typeof call.time === 'number' ? Math.max(0, now - call.time) : null,
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
          elapsedMs: null,
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
          const failure = failureOf(result);
          return {
            key: 'done:' + (result.callId || result.seq || ''),
            state: failure ? 'error' : 'ok',
            turn,
            step,
            tool: result.name || '',
            target: toolTarget(result),
            ruleId: null,
            phase: null,
            elapsedMs: typeof result.callTime === 'number' && typeof result.time === 'number'
              ? Math.max(0, result.time - result.callTime)
              : null,
            kind: failure ? failure.kind : null,
            code: failure ? failure.code : null,
            rawLine: failure ? failure.rawLine : '',
          };
        }
      }

      // 4) 还在思考。
      //    factsOnly（只报事实）：不读思考文本，没有工具在跑就整条收起来。
      //    否则三层兜底：规则表（读思考文本）→ 阶段话术（本回合干过什么）→ 俏皮词。
      if (source.factsOnly) return null;
      const rule = pickRule(lastReasoningText(blocks));
      const tools = turnTools({ nodes, turnEnds: source.turnEnds, turn: partial.turn });
      const phase = phaseText(tools, now);
      return {
        key: 'think:' + (partial.turn || 0) + ':' + (partial.step || 0) + ':' + (rule ? rule.id : (phase ? 'p' : '-')),
        state: 'thinking',
        turn,
        step,
        tool: '',
        target: '',
        ruleId: rule ? rule.id : null,
        // 副行：直接摘思考原文的第一句（不加工、不猜），让字幕有「解说感」。
        sub: firstSentence(lastReasoningText(blocks)),
        phase: !rule && phase ? phase.text : null,
        elapsedMs: !rule && phase ? phase.sinceMs : null,
        kind: null,
        code: null,
        rawLine: '',
      };
    }

    /** 跑着的时候每秒刷一次，让耗时数字会走。 */
    function useNow(active) {
      const [now, setNow] = React.useState(() => Date.now());
      React.useEffect(() => {
        if (!active) return undefined;
        const timer = setInterval(() => setNow(Date.now()), NOW_MS);
        return () => clearInterval(timer);
      }, [active]);
      return now;
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

    function CaptionStrip(props) {
      const t = props.t || translate;
      const useChat = props.useChat;
      const partial = useChat ? useChat((state) => state.legacy.partial) : null;
      const runningCalls = useChat ? useChat((state) => state.legacy.runningCalls) : EMPTY;
      const nodes = useChat ? useChat((state) => state.legacy.nodes) : EMPTY;
      const turnEnds = useChat ? useChat((state) => state.legacy.turnEnds) : null;
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
      const active = Boolean(partial)
        || (Array.isArray(runningCalls) && runningCalls.length > 0)
        || openTurn !== null;

      const [settings, setSettings] = React.useState(readSettings);
      const [settingsOpen, setSettingsOpen] = React.useState(false);
      const update = (patch) => {
        setSettings((prev) => {
          const next = normalizeSettings({ ...prev, ...patch });
          writeSettings(next);
          return next;
        });
      };

      const now = useNow(active);
      const view = React.useMemo(
        () => deriveCaption({
          partial,
          runningCalls,
          nodes,
          turnEnds,
          now,
          factsOnly: settings.factsOnly,
          turn: openTurn,
          turnOpen: openTurn !== null,
          waitingText: t('waiting'),
        }),
        [partial, runningCalls, nodes, now, settings.factsOnly, openTurn, t],
      );

      // 一闪而过的状态也要留一会儿再收：模型想得快的时候，字幕常常零点几秒就消失，人来不及读。
      // 规则：新状态立刻顶上；状态没了之后，最后一条至少挂满 MIN_SHOW_MS。
      const [held, setHeld] = React.useState(null);
      React.useEffect(() => {
        if (view) {
          setHeld((prev) => (prev && prev.key === view.key ? prev : { key: view.key, view, at: Date.now() }));
          return undefined;
        }
        if (!held || !held.view) return undefined;
        const left = MIN_SHOW_MS - (Date.now() - held.at);
        if (left <= 0) {
          setHeld(null);
          return undefined;
        }
        const timer = setTimeout(() => setHeld(null), left);
        return () => clearTimeout(timer);
      }, [view ? view.key : null, held]);
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

      const longTool = Boolean(view) && view.state === 'running'
        && typeof view.elapsedMs === 'number' && view.elapsedMs >= LONG_TOOL_MS;
      // 俏皮词不再等停顿：思考期间一直轮换（不知道说什么时就用它当主文案），长工具时陪衬。
      const wordsOn = Boolean(settings.words) && Boolean(view)
        && (view.state === 'thinking' || longTool);
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
      const suffix = wordsOn && flavor && candidate.indexOf(flavor) < 0 ? flavor : null;

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
              'aria-label': t('settings'),
              onClick: () => setSettingsOpen(false),
            }, '✕')),
          h('div', { className: 'pgc-sheet-body' },
            settingRow(t, 'size', seg('size', settings.size, [
              { value: 's', label: 'sizeS' },
              { value: 'm', label: 'sizeM' },
              { value: 'l', label: 'sizeL' },
            ], (value) => update({ size: value }))),
            settingRow(t, 'lines', seg('lines', String(settings.lines), [
              { value: '1', label: '1' },
              { value: '2', label: '2' },
              { value: '3', label: '3' },
            ], (value) => update({ lines: Number(value) }))),
            settingRow(t, 'anim', seg('anim', settings.anim, [
              { value: 'sweep', label: 'animSweep' },
              { value: 'dots', label: 'animDots' },
              { value: 'off', label: 'animOff' },
            ], (value) => update({ anim: value }))),
            h('span', { className: 'pgc-sheet-split' }),
            settingRow(t, 'words', switchButton(settings.words, settings.words ? t('wordsOn') : t('wordsOff'), '', () => update({ words: !settings.words }))),
            settingRow(t, 'facts', seg('facts', settings.factsOnly ? 'tools' : 'thinking', [
              { value: 'tools', label: 'factsTools' },
              { value: 'thinking', label: 'factsThinking' },
            ], (value) => update({ factsOnly: value === 'tools' }))),
            h('p', { className: 'pgc-sheet-hint' }, t('factsHint')),
            h('p', { className: 'pgc-sheet-note' }, t('sheetNote')),
            h('p', { className: 'pgc-sheet-note' }, t('disclaimer')))));

      // 空闲（或成功已淡出）时只留一个很小的齿轮：设置随时点得到，又不占地方。
      if (!showFull) {
        return h('div', {
          className: 'pgc-strip pgc-strip--handle',
          'data-plugin': 'dsh-progress-caption',
        }, settingsPanel);
      }

      const stripClass = [
        'pgc-strip',
        'pgc-strip--' + shown.state,
        holding ? 'pgc-strip--held' : null,
        'pgc-size-' + settings.size,
        'pgc-lines-' + settings.lines,
        'pgc-anim-' + settings.anim,
      ].filter(Boolean).join(' ');

      return h('div', {
        className: stripClass,
        'data-plugin': 'dsh-progress-caption',
        title: t('disclaimer'),
      },
        // 朗读区域只包状态文字：设置面板不在里面，免得切换时被一起念出来。
        h('span', { className: 'pgc-live', role: 'status', 'aria-live': 'polite' },
          shown.step !== null
            ? h('span', { className: 'pgc-step' }, fmt(t('step'), { n: shown.step }))
            : null,
          h('span', { className: 'pgc-dot', 'aria-hidden': true }),
          // 不加 key：换文案时别整块重挂载，否则淡入动画每次都重播，看起来一断一断的。
          h('span', { className: 'pgc-text' },
            h('span', { className: 'pgc-label' }, label),
            // 行数设成 2 及以上，才多给一行「思考原话」当副行。
            settings.lines >= 2 && shown.state === 'thinking' && shown.sub
              ? h('span', { className: 'pgc-sub' }, shown.sub)
              : null),
          // 状态胶囊和俏皮词是两回事：有俏皮词时就把「进行中」收起来，别两个胶囊挤一起。
          status && !suffix ? h('span', { className: 'pgc-chip' }, status) : null,
          // 不到 1 秒不显示耗时：刚切过来就挂个「0.0s」，像坏了一样。
          shown.elapsedMs !== null && shown.elapsedMs >= 1000
            ? h('span', { className: 'pgc-time' }, durationText(shown.elapsedMs))
            : null,
          // 俏皮词放最右端：它只是气氛，不属于左边那句状态描述。
          suffix ? h('span', { className: 'pgc-flavor' }, suffix) : null),
        shown.state === 'error' && shown.rawLine
          ? h('details', { className: 'pgc-detail' },
            h('summary', { className: 'pgc-detail-sum' }, t('detail')),
            h('code', { className: 'pgc-raw' }, shown.rawLine))
          : null,
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
      const t = props.t || translate;
      const useChat = props.useChat;
      const nodes = useChat ? useChat((state) => state.legacy.nodes) : EMPTY;
      const turnEnds = useChat ? useChat((state) => state.legacy.turnEnds) : null;
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
.pgc-strip {
  display: flex; align-items: center; gap: 8px; box-sizing: border-box;
  margin: 0 12px 6px; padding: 5px 10px; border-radius: 10px;
  border: 1px solid color-mix(in srgb, var(--dsw-alias-brand-primary, #4d6bfe) 20%, transparent);
  background: color-mix(in srgb, var(--dsw-alias-brand-primary, #4d6bfe) 8%, transparent);
  line-height: 1.4; color: var(--dsw-alias-label-primary, inherit);
  transition: background-color .2s ease, border-color .2s ease, opacity .18s ease;
}
/* DeepSeek 蓝是主色；成功/失败只换强调色，形状和排版保持一致。 */
.pgc-strip--ok { border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary, #2f9e68) 24%, transparent); background: color-mix(in srgb, var(--dsw-alias-state-success-primary, #2f9e68) 8%, transparent); }
.pgc-strip--error { border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary, #d94a3d) 28%, transparent); background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #d94a3d) 9%, transparent); }
.pgc-live { display: flex; align-items: center; gap: 7px; min-width: 0; flex: 1 1 auto; }
.pgc-size-s { font-size: 11px; }
.pgc-size-m { font-size: 12px; }
.pgc-size-l { font-size: 13.5px; }
.pgc-step { flex: 0 0 auto; font-variant-numeric: tabular-nums; font-weight: 600; color: var(--dsw-alias-brand-primary, #4d6bfe); }
.pgc-strip--ok .pgc-step { color: var(--dsw-alias-state-success-primary, #2f9e68); }
.pgc-strip--error .pgc-step { color: var(--dsw-alias-state-error-primary, #d94a3d); }
.pgc-dot {
  flex: 0 0 auto; width: 7px; height: 7px; border-radius: 50%;
  background: var(--dsw-alias-brand-primary, #4d6bfe);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-brand-primary, #4d6bfe) 18%, transparent);
  animation: pgc-pulse 1.6s ease-in-out infinite;
}
.pgc-strip--ok .pgc-dot {
  background: var(--dsw-alias-state-success-primary, #2f9e68); animation: none;
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-success-primary, #2f9e68) 18%, transparent);
}
.pgc-strip--error .pgc-dot {
  background: var(--dsw-alias-state-error-primary, #d94a3d); animation: none;
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-error-primary, #d94a3d) 18%, transparent);
}
/* 主文案：一行放不下就省略号，别缩成俩字。 */
.pgc-text { display: flex; flex-direction: column; justify-content: center; flex: 1 1 auto; min-width: 0; }
.pgc-sub { flex: 0 0 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: .92em; line-height: 1.5; color: var(--dsw-alias-label-secondary, inherit); opacity: .78; }
.pgc-label { position: relative; flex: 0 0 auto; min-width: 0; overflow: hidden; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 1; overflow-wrap: anywhere; }
.pgc-lines-2 .pgc-label { -webkit-line-clamp: 2; }
.pgc-lines-3 .pgc-label { -webkit-line-clamp: 3; }
.pgc-anim-sweep .pgc-label::after { content: ''; position: absolute; inset: 0; pointer-events: none; background-image: linear-gradient(100deg, transparent 38%, color-mix(in srgb, var(--dsw-alias-brand-primary, #4d6bfe) 28%, transparent) 50%, transparent 62%); background-size: 260% 100%; background-repeat: no-repeat; animation: pgc-sweep 2.2s linear infinite; }
/* 俏皮词：不用斜体（中文被强行倾斜很难看），改成品牌色胶囊，白字底 + 实心字，一眼能看见。 */
.pgc-flavor {
  flex: 0 0 auto; max-width: 46%; margin-left: 6px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-style: normal; font-weight: 600; font-size: .95em; line-height: 1.6; letter-spacing: .2px;
  color: var(--dsw-alias-brand-primary, #4d6bfe);
  background: color-mix(in srgb, var(--dsw-alias-brand-primary, #4d6bfe) 15%, transparent);
  border: 1px solid color-mix(in srgb, var(--dsw-alias-brand-primary, #4d6bfe) 30%, transparent);
  border-radius: 999px; padding: 0 9px; margin-left: 1px;
}
.pgc-strip--ok .pgc-flavor {
  color: var(--dsw-alias-state-success-primary, #2f9e68);
  background: color-mix(in srgb, var(--dsw-alias-state-success-primary, #2f9e68) 15%, transparent);
  border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary, #2f9e68) 30%, transparent);
}
.pgc-strip--error .pgc-flavor {
  color: var(--dsw-alias-state-error-primary, #d94a3d);
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #d94a3d) 15%, transparent);
  border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary, #d94a3d) 30%, transparent);
}
.pgc-chip { flex: 0 0 auto; padding: 0 6px; border: 1px solid color-mix(in srgb, var(--dsw-alias-brand-primary, #4d6bfe) 38%, transparent); border-radius: 999px; font-size: 11px; color: var(--dsw-alias-brand-primary, #4d6bfe); }
.pgc-strip--ok .pgc-chip { color: var(--dsw-alias-state-success-primary, #2f9e68); border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary, #2f9e68) 48%, transparent); }
.pgc-strip--error .pgc-chip { color: var(--dsw-alias-state-error-primary, #d94a3d); border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary, #d94a3d) 52%, transparent); }
.pgc-time { flex: 0 0 auto; font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-secondary, inherit); opacity: .9; }
.pgc-strip--handle { margin: 0; padding: 0 14px 2px; background: transparent; border-color: transparent; justify-content: flex-end; }
/* 状态已经结束、只是还没挂满最短停留时间：稍微淡一点，表示它马上收。 */
.pgc-strip--held { opacity: .88; }
.pgc-summary { margin: 2px 0 4px; font-size: 11px; color: var(--dsw-alias-label-secondary, inherit); opacity: .7; }
.pgc-summary-text { font-variant-numeric: tabular-nums; }
.pgc-detail { flex: 0 0 auto; }
.pgc-detail-sum { font-size: 11px; opacity: .6; cursor: pointer; }
.pgc-raw { display: block; margin-top: 4px; padding: 4px 6px; border-radius: 6px; background: color-mix(in srgb, currentColor 8%, transparent); font-size: 11px; white-space: pre-wrap; }
/* 设置：齿轮 + 浮层面板。颜色取 DSH Theme 服务暴露的 --dsw-alias-* 变量，
   没有变量时退回 currentColor 混色，明暗主题都能自动跟随。 */
.pgc-settings { flex: 0 0 auto; position: relative; display: flex; align-items: center; }
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
  width: 246px; box-sizing: border-box; padding: 12px 12px 10px;
  display: flex; flex-direction: column; gap: 10px;
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
.pgc-sheet-body { display: grid; gap: 9px; }
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
.pgc-anim-off .pgc-dot { animation: none; opacity: .45; }
.pgc-anim-off .pgc-label::after { content: none; animation: none; }
@media (max-width: 720px) { .pgc-note { display: none; } }
@media (prefers-reduced-motion: reduce) {
  .pgc-strip, .pgc-strip * { animation: none !important; transition: none !important; }
  .pgc-label::after { content: none !important; }
}
@keyframes pgc-pulse { 0%, 100% { opacity: .22; } 50% { opacity: .65; } }
@keyframes pgc-sweep { 0% { background-position: 120% 0; } 100% { background-position: -60% 0; } }
@keyframes pgc-fade { from { opacity: 0; transform: translateY(1px); } to { opacity: 1; transform: none; } }
`;

    function apply(ctx) {
      translate = ctx.locale.bind(NS);

      ctx.effect(() => ctx.locale.register(NS, DICT), 'dsh-progress-caption: locale dictionaries');

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
        RULE_VARIANTS,
        firstSentence,
        wordAt,
        durationText,
        toolTarget,
        actionText,
        turnTools,
        phaseText,
        summarizeTurn,
        readSettings,
        writeSettings,
        normalizeSettings,
        DEFAULT_SETTINGS,
        WORD_COUNT,
        RULES,
        DICT,
        LABEL_HOLD_MS,
        LABEL_HOLD_FAST_MS,
        FAST_CPS,
        OK_LINGER_MS,
        MIN_SHOW_MS,
        TURN_GAP_MS,
        pickView,
      },
    };
  },
});
