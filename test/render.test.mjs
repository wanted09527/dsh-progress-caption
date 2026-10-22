/**
 * 离线测试 1：不启动 DSH，用假 window / 假 React / 假 ctx / 假 store 驱动 client.js，
 * 断言注册信息正确，并且三种状态（进行中 / 成功 / 失败）的文案都对。
 *
 * 跑法：node --test test/
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIENT = path.join(HERE, '..', 'client.js');

/* ---------------- 假环境：window / document / React ---------------- */

let captured = null;
globalThis.window = { __ModuleLoader__: { load: (spec) => { captured = spec; } } };
globalThis.document = {
  head: { appendChild() {} },
  createElement() {
    return { setAttribute() {}, remove() {}, textContent: '' };
  },
};

await import(pathToFileURL(CLIENT).href);

/** 只实现本插件用到的那几个 hook。 */
function makeReact() {
  return {
    createElement(type, props, ...children) {
      return {
        type,
        props: props || {},
        children: children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false),
      };
    },
    useState(init) { return [typeof init === 'function' ? init() : init, () => {}]; },
    useEffect() {},
    useMemo(fn) { return fn(); },
    useRef(init) { return { current: init }; },
  };
}

/** 把渲染树里所有字符串拼出来，方便断言。 */
/** 把函数组件（外层壳）就地展开成元素树：组件的 Hook 分流靠「换组件」实现，测试得跟进去。 */
function resolve(node) {
  let current = node;
  for (let guard = 0; guard < 20; guard += 1) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return current;
    if (typeof current.type !== 'function') return current;
    current = current.type(current.props);
  }
  throw new Error('组件展开超过 20 层，可能有循环渲染');
}

function text(node) {
  if (node === null || node === undefined || node === false) return '';
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(text).join(' ');
  if (typeof node.type === 'function') return text(resolve(node));
  return text(node.children);
}

/* ---------------- 加载插件模块 ---------------- */

test('client.js 用包名注册一个 lazy factory', () => {
  assert.ok(captured, 'client.js 必须调用 window.__ModuleLoader__.load');
  assert.equal(captured.id, 'dsh-progress-caption');
  assert.equal(typeof captured.factory, 'function');
});

const react = makeReact();
const mod = captured.factory((name) => {
  assert.equal(name, 'react', '目前只应该 require react');
  return react;
});

test('插件声明 slots + locale 两个服务', () => {
  assert.deepEqual(mod.inject, ['slots', 'locale']);
});

/* ---------------- 假 ctx：记录注册、执行 effect ---------------- */

const dictionaries = new Map();
const registrations = [];
const effects = [];

const ctx = {
  locale: {
    bind(ns) {
      return (key) => {
        const dict = dictionaries.get(ns);
        const text = dict && dict.zh ? dict.zh[key] : undefined;
        return text !== undefined ? text : key;
      };
    },
    register(ns, dict) {
      dictionaries.set(ns, dict);
      return () => dictionaries.delete(ns);
    },
  },
  effect(run, label) {
    effects.push(label);
    return run();
  },
  slots: {
    inject(name, fn) { return fn(); },
    register(entry, component) {
      registrations.push({ entry, component });
      return () => {};
    },
  },
};

mod.apply(ctx);

test('在输入框上方注册字幕，并在回合末尾注册小结', () => {
  assert.equal(registrations.length, 2);
  const caption = registrations[0];
  assert.equal(caption.entry.name, 'conversation.input.dock');
  assert.equal(caption.entry.id, 'dsh-progress-caption');
  assert.equal(caption.entry.locale, 'dshProgressCaption');
  assert.equal(typeof caption.component, 'function');

  const summary = registrations[1];
  assert.equal(summary.entry.name, 'conversation.chat.turnTail');
  assert.equal(summary.entry.id, 'dsh-progress-caption:turn');
  assert.equal(summary.entry.order, 40);
  assert.equal(typeof summary.component, 'function');
});

test('中英字典都注册了，规则文案自动并进去', () => {
  const dict = dictionaries.get('dshProgressCaption');
  assert.ok(dict && dict.zh && dict.en, 'zh 和 en 都要有');
  assert.equal(dict.zh['r_read-config'], '正在读取配置文件');
  assert.equal(dict.en['r_read-config'], 'reading a config file');
  assert.equal(effects.length, 2, 'locale + 样式两个 effect');
});

/* ---------------- 假 store：驱动组件 ---------------- */

const { component } = registrations[0];

function render(legacy) {
  return resolve(component({ useChat: (selector) => selector({ legacy }) }));
}

const empty = { partial: null, runningCalls: [], nodes: [] };

test('没在跑的时候只剩一个小齿轮，不占地方', () => {
  const view = render(empty);
  assert.ok(view, '空闲时仍渲染一条极窄的把手');
  assert.match(view.props.className, /pgc-strip--handle/);
  const shown = text(view);
  assert.match(shown, /⚙/);
  assert.match(shown, /字号/);
  assert.doesNotMatch(shown, /正在思考/);
  assert.doesNotMatch(shown, /正在执行/);
});

test('状态一：工具在跑 → 第 N 步 / 正在执行命令 / 耗时（进行中由圆点表达）', () => {
  const view = render({
    partial: { turn: 1, step: 2, blocks: [{ kind: 'reasoning', text: '跑一下命令' }] },
    runningCalls: [{ callId: 'c1', name: 'bash', step: 2, time: Date.now() - 1200 }],
    nodes: [],
  });
  const shown = text(view);
  assert.match(shown, /第 3 步/);
  assert.match(shown, /正在执行命令/);
  assert.match(shown, /\d+\.\ds/);
  assert.match(view.props.title, /规则推断/);
  assert.match(view.props.className, /pgc-strip--running/);
});

test('状态二：思考文本命中规则表 → 正在读取配置文件', () => {
  const view = render({
    partial: {
      turn: 3,
      step: 0,
      blocks: [{ kind: 'reasoning', text: '我先读取配置文件 package.json，看看入口在哪' }],
    },
    runningCalls: [],
    nodes: [],
  });
  const shown = text(view);
  assert.match(shown, /第 1 步/);
  assert.match(shown, /(正在读取配置文件|翻一下配置文件|看看配置里怎么写的|对一下配置项)/);
  assert.match(view.props.className, /pgc-strip--thinking/);
});

test('没命中规则 → 俏皮词顶上当主文案（Claude 那种）', () => {
  const view = render({
    partial: { turn: 3, step: 1, blocks: [{ kind: 'reasoning', text: '嗯……' }] },
    runningCalls: [],
    nodes: [],
  });
  const shown = text(view);
  // 词表按 seed 起点轮换：假 React 的 tick 不走，显示的就是起点词。
  // 这条数据的 seed 是 (3*37+1) % 112 = 14 → 「酝酿中」
  assert.ok(shown.includes('酝酿中'), '应显示词表里的某个词，实际：' + shown.slice(0, 40));
  assert.match(view.props.className, /pgc-strip--thinking/);
});

test('状态三（失败）：bash 退出码 1 不算 isError，也要判成失败', () => {
  const callTime = Date.now() - 1500;
  const view = render({
    partial: { turn: 4, step: 1, blocks: [{ kind: 'tool-call', callId: 'c9', name: 'bash', argsRaw: 'ls' }] },
    runningCalls: [],
    nodes: [{
      kind: 'tool-result',
      seq: 42,
      callId: 'c9',
      name: 'bash',
      time: callTime + 1500,
      callTime,
      isError: false,
      content: [{ type: 'text', text: 'boom\n[exit code: 1]' }],
      args: {},
      call: null,
      subCalls: [],
    }],
  });
  const shown = text(view);
  assert.match(shown, /命令执行失败（exit code 1）/);
  assert.match(shown, /失败/);
  assert.match(shown, /1\.5s/);
  assert.match(shown, /看原始报错/);
  assert.match(shown, /boom/);
  assert.match(view.props.className, /pgc-strip--error/);
});

test('状态三（成功）：退出码 0 → 命令完成 / 成功', () => {
  const view = render({
    partial: { turn: 5, step: 0, blocks: [{ kind: 'tool-call', callId: 'c10', name: 'bash', argsRaw: 'true' }] },
    runningCalls: [],
    nodes: [{
      kind: 'tool-result',
      seq: 50,
      callId: 'c10',
      name: 'bash',
      time: 2000,
      callTime: 1000,
      isError: false,
      content: [{ type: 'text', text: 'ok\n[exit code: 0]' }],
      args: {},
      call: null,
      subCalls: [],
    }],
  });
  const shown = text(view);
  assert.match(shown, /跑完命令/);
  assert.match(shown, /成功/);
  assert.match(view.props.className, /pgc-strip--ok/);
});

test('普通工具 isError → 工具执行失败', () => {
  const view = render({
    partial: { turn: 6, step: 0, blocks: [{ kind: 'tool-call', callId: 'c11', name: 'read', argsRaw: '{}' }] },
    runningCalls: [],
    nodes: [{
      kind: 'tool-result',
      seq: 60,
      callId: 'c11',
      name: 'read',
      time: 3000,
      callTime: 2500,
      isError: true,
      error: { name: 'Error', code: 'ENOENT' },
      content: [{ type: 'text', text: 'no such file' }],
      args: {},
      call: null,
      subCalls: [],
    }],
  });
  assert.match(text(view), /工具执行失败/);
});

test('模型已经在写回答 → 常驻显示「正在组织回答」，不闪没', () => {
  const view = render({
    partial: { turn: 7, step: 0, blocks: [{ kind: 'text', text: '结论如下……' }] },
    runningCalls: [],
    nodes: [],
  });
  assert.match(view.props.className, /pgc-strip--writing/);
  assert.match(text(view), /正在组织回答/);
});

test('写回答时选了「只看工具」→ 才收成齿轮', () => {
  const view = __test.deriveCaption({
    partial: { turn: 7, step: 0, blocks: [{ kind: 'text', text: '结论如下……' }] },
    runningCalls: [],
    nodes: [],
    factsOnly: true,
  });
  assert.equal(view, null);
});

/* ---------------- 设置与俏皮词（纯逻辑，不依赖 React） ---------------- */

const { __test } = mod;

test('设置：坏值一律兜底回默认', () => {
  assert.deepEqual(__test.normalizeSettings(null), __test.DEFAULT_SETTINGS);
  assert.deepEqual(__test.normalizeSettings({ size: 'xxl', lines: 9, anim: 'boom', words: 'yes' }), {
    size: 'm', lines: 1, anim: 'sweep', words: true, factsOnly: false,
    accent: 'theme', okColor: 'theme', badColor: 'theme', flavorStyle: 'tint',
  });
  assert.deepEqual(__test.normalizeSettings({ size: 'l', lines: 3, anim: 'off', words: false, factsOnly: true }), {
    size: 'l', lines: 3, anim: 'off', words: false, factsOnly: true,
    accent: 'theme', okColor: 'theme', badColor: 'theme', flavorStyle: 'tint',
  });
});

test('设置：没有 localStorage 也不崩', () => {
  assert.deepEqual(__test.readSettings(), __test.DEFAULT_SETTINGS);
  assert.doesNotThrow(() => __test.writeSettings({ size: 's', lines: 2, anim: 'dots', words: false }));
});

test('配色：选了色就挂 CSS 变量，跟随主题时一个都不挂', () => {
  // 跟随主题：不注入变量，CSS 会自己退回 --dsw-alias-* 主题色
  assert.deepEqual(__test.stripVars({ accent: 'theme', okColor: 'theme', badColor: 'theme' }), {});
  const vars = __test.stripVars({ accent: 'forest', okColor: 'green', badColor: 'red' });
  assert.equal(vars['--pgc-accent'], '#2f9e68');
  assert.equal(vars['--pgc-ok'], '#2f9e68');
  assert.equal(vars['--pgc-bad'], '#d94a3d');
  // 表里没有的键一律当「跟随主题」，不抛异常
  assert.deepEqual(__test.stripVars({ accent: 'nope' }), {});
});

test('配色：色值都是合法十六进制，且六个主色互不相同', () => {
  const accents = __test.ACCENTS;
  const values = Object.keys(accents)
    .map((key) => accents[key].value)
    .filter(Boolean);
  assert.equal(values.length, 6, '主色应该正好 6 个可选值');
  values.forEach((value) => assert.match(value, /^#[0-9a-f]{6}$/i));
  assert.equal(new Set(values).size, values.length, '主色不能有重复');
});

test('设置面板：分成「长什么样 / 颜色 / 说什么」三组，颜色三项都在', () => {
  const view = render({
    partial: { turn: 1, step: 0, blocks: [{ kind: 'reasoning', text: '看看配置' }] },
    runningCalls: [],
    nodes: [],
  });
  const shown = text(view);
  assert.match(shown, /长什么样/);
  assert.match(shown, /颜色/);
  assert.match(shown, /说什么/);
  assert.match(shown, /字幕条颜色/);
  assert.match(shown, /跑成功时/);
  assert.match(shown, /跑失败时/);
  // 俏皮词样式三选一
  assert.match(shown, /淡色底/);
  assert.match(shown, /实心/);
  assert.match(shown, /素色/);
});

test('配色选中后会写回 root 的 style，且 class 带上俏皮词样式', () => {
  const previous = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: () => JSON.stringify({ accent: 'violet', okColor: 'teal', badColor: 'orange', flavorStyle: 'solid' }),
    setItem: () => {},
  };
  try {
    const view = render({
      partial: { turn: 1, step: 0, blocks: [{ kind: 'reasoning', text: '看看配置' }] },
      runningCalls: [],
      nodes: [],
    });
    assert.equal(view.props.style['--pgc-accent'], '#8b5cf6');
    assert.equal(view.props.style['--pgc-ok'], '#12a594');
    assert.equal(view.props.style['--pgc-bad'], '#e08a2e');
    assert.match(view.props.className, /pgc-flavor-solid/);
  } finally {
    if (previous === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previous;
  }
});

test('俏皮词：条数够多、中英一一对齐、取模轮换', () => {
  const count = __test.WORD_COUNT;
  assert.ok(count >= 60, '词表太小：' + count);
  assert.equal(count, 112);
  const dict = dictionaries.get('dshProgressCaption');
  const seenZh = new Set();
  for (let i = 0; i < count; i += 1) {
    assert.ok(dict.zh['w' + i], 'zh 缺 w' + i);
    assert.ok(dict.en['w' + i], 'en 缺 w' + i);
    assert.ok(!seenZh.has(dict.zh['w' + i]), '中文重复：' + dict.zh['w' + i]);
    seenZh.add(dict.zh['w' + i]);
  }
  assert.equal(__test.wordAt(0), '酝酿中');
  assert.equal(__test.wordAt(count), '酝酿中');
  assert.equal(__test.wordAt(count + 1), '琢磨中');
  assert.equal(__test.wordAt(-1), dict.zh.w1, '负数走绝对值取模');
});

test('词表筛过：直译生硬的词不进表', () => {
  const dict = dictionaries.get('dshProgressCaption');
  const banned = ['正在鼓风', '和鸣', '成核', '电离', '雾化', '升华', '嬗变', '网状化', '扭曲时空', '共生', '提取精华', '渗透'];
  const all = [];
  for (let i = 0; i < __test.WORD_COUNT; i += 1) all.push(dict.zh['w' + i]);
  for (const bad of banned) {
    assert.ok(!all.includes(bad), '不该出现：' + bad);
  }
});

test('彩蛋区：大鲸鱼 / Δ 增量都在表里，三角洲已拿掉', () => {
  const dict = dictionaries.get('dshProgressCaption');
  const at = (i) => dict.zh['w' + i];
  // 大鲸鱼：第 98–109 项
  assert.equal(at(97), '跃出海面');
  assert.equal(at(101), '声呐扫一圈');
  assert.equal(at(105), '求索中');
  assert.equal(at(106), '深度求索');
  assert.equal(at(108), '贴着海面掠');
  // Δ：最后三项
  assert.equal(at(__test.WORD_COUNT - 3), '算个增量');
  assert.equal(at(__test.WORD_COUNT - 1), '求个近似');
  // 三角洲那一组已按用户要求删除，不许偷偷回来
  const all = [];
  for (let i = 0; i < __test.WORD_COUNT; i += 1) all.push(at(i));
  for (const gone of ['撤离中', '摸金中', '开镜中', '换弹中', '绕后中', '架枪中', '打药中', '压枪中', '刚枪中']) {
    assert.ok(!all.includes(gone), '三角洲词还在：' + gone);
  }
});

test('设置面板是 2026 的样子：分段选择 + 开关，没有原生 select', () => {
  const kinds = [];
  const classes = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.type) kinds.push(node.type);
    if (node.props && typeof node.props.className === 'string') classes.push(node.props.className);
    (node.children || []).forEach(walk);
  };
  walk(render({
    partial: { turn: 2, step: 0, blocks: [{ kind: 'reasoning', text: '看看配置' }] },
    runningCalls: [],
    nodes: [],
  }));
  assert.ok(!kinds.includes('select'), '不许再用原生 select（就是它看着像 XP）');
  assert.ok(!kinds.includes('option'), '不许再用原生 option');
  assert.ok(classes.some((name) => name.includes('pgc-gear')), '齿轮按钮');
  assert.ok(classes.some((name) => name === 'pgc-sheet'), '浮层面板');
  assert.ok(classes.some((name) => name === 'pgc-seg'), '分段选择器');
  assert.ok(classes.some((name) => name === 'pgc-switch'), '滑动开关');
  assert.ok(classes.some((name) => name === 'pgc-switch-thumb'), '开关滑块');
  assert.ok(classes.some((name) => name === 'pgc-sheet-note'), '本地保存说明');
});

test('齿轮点开才出现面板（收起时 aria-hidden）', () => {
  const view = render({
    partial: { turn: 2, step: 0, blocks: [{ kind: 'reasoning', text: '看看配置' }] },
    runningCalls: [],
    nodes: [],
  });
  const gear = [];
  const panel = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.props && typeof node.props.className === 'string') {
      if (node.props.className.includes('pgc-gear')) gear.push(node);
      if (node.props.className.includes('pgc-sheet') && !node.props.className.includes('pgc-sheet-')) panel.push(node);
    }
    (node.children || []).forEach(walk);
  };
  walk(view);
  assert.equal(gear.length, 1);
  assert.equal(gear[0].props['aria-expanded'], 'false');
  assert.equal(panel.length, 1);
  assert.equal(panel[0].props['aria-hidden'], 'true');
});

test('字幕带设置面板：字号 / 行数 / 动画 / 俏皮词', () => {
  const view = render({
    partial: { turn: 9, step: 0, blocks: [{ kind: 'reasoning', text: '看看配置' }] },
    runningCalls: [],
    nodes: [],
  });
  const shown = text(view);
  assert.match(shown, /字幕设置/);
  assert.match(shown, /字号/);
  assert.match(shown, /行数/);
  assert.match(shown, /动画/);
  assert.match(shown, /俏皮词/);
  // 「没线索时」那一行：两个选项都用人话写出来，下面再补一句解释
  assert.match(shown, /没线索时/);
  assert.match(shown, /只报动作/);
  assert.match(shown, /猜一猜/);
  assert.match(shown, /猜错很正常/);
  assert.match(shown, /扫光/);
  assert.match(shown, /呼吸点/);
  assert.match(shown, /关闭/);
  assert.match(view.props.className, /pgc-size-m/);
  assert.match(view.props.className, /pgc-anim-sweep/);
});

test('把「没线索时」切到只报动作 → 选中项跟着变', () => {
  const dict = dictionaries.get('dshProgressCaption');
  assert.equal(dict.zh.facts, '没线索时');
  assert.equal(dict.zh.factsTools, '只报动作');
  assert.equal(dict.zh.factsThinking, '猜一猜');
  assert.equal(dict.en.factsTools, 'Actions only');
  assert.equal(dict.en.factsThinking, 'Guess a little');

  // 用假 localStorage 模拟用户已经打开过这个开关
  const previous = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: () => JSON.stringify({ factsOnly: true }),
    setItem: () => {},
  };
  try {
    const view = render({
      partial: { turn: 2, step: 0, blocks: [{ kind: 'reasoning', text: '看看配置' }] },
      runningCalls: [],
      nodes: [],
    });
    const shown = text(view);
    assert.match(shown, /没线索时/);
    // 两个选项始终都在，靠选中态区分，不是「开关文字来回换」
    assert.match(shown, /只报动作/);
    assert.match(shown, /猜一猜/);
  } finally {
    if (previous === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previous;
  }
});

/* ---------------- 本轮优化（2–7）的针对性用例 ---------------- */

test('耗时：一分钟内报秒，超过自动换分秒', () => {
  assert.equal(__test.durationText(1200), '1.2s');
  assert.equal(__test.durationText(59999), '60.0s');
  assert.equal(__test.durationText(75000), '1分15秒');
  assert.equal(__test.durationText(600000), '10分0秒');
});

test('正在执行命令 → 带上具体命令', () => {
  const view = render({
    partial: { turn: 1, step: 2, blocks: [] },
    runningCalls: [({
      callId: 'c1', name: 'bash', step: 2, time: Date.now() - 1200,
      argsRaw: '{"command":"npm test"}',
    })],
    nodes: [],
  });
  const shown = text(view);
  assert.match(shown, /正在执行命令/);
  assert.match(shown, /npm test/);
});

test('主文案拼成一整句，免责声明不再挤占这一行', () => {
  const view = render({
    partial: { turn: 1, step: 2, blocks: [] },
    runningCalls: [({
      callId: 'c1', name: 'bash', step: 2, time: Date.now() - 1200,
      argsRaw: '{"command":"npm test"}',
    })],
    nodes: [],
  });
  // 动作和对象在同一段文本里（不是两个互相抢宽度的 span）
  assert.match(text(view), /正在执行命令 npm test/);
  // 那一行只留主文案；免责声明挪到 title 和设置面板里
  const flat = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.props && node.props.className === 'pgc-note') flat.push(node);
    (node.children || []).forEach(walk);
  };
  walk(view);
  assert.equal(flat.length, 0, '行内不再有免责声明小字');
  assert.match(String(view.props.title || ''), /规则推断/);
});

test('状态点在扫光模式下也在（颜色就是状态），不靠文字徽标', () => {
  const view = render({
    partial: { turn: 1, step: 0, blocks: [{ kind: 'reasoning', text: '先看看 package.json' }] },
    runningCalls: [],
    nodes: [],
  });
  const dots = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.props && node.props.className === 'pgc-dot') dots.push(node);
    (node.children || []).forEach(walk);
  };
  walk(view);
  assert.equal(dots.length, 1);
});

test('工具参数 → 只显示文件名 / 搜索词，不显示整段 JSON', () => {
  assert.equal(__test.toolTarget({ argsRaw: '{"path":"E:/deepseek/插件/plugins/client.js"}' }), 'client.js');
  assert.equal(__test.toolTarget({ argsRaw: '{"pattern":"deriveCaption"}' }), 'deriveCaption');
  assert.equal(__test.toolTarget({ argsRaw: '{}' }), '');
  assert.equal(__test.toolTarget({}), '');
  // 已结算的结果：argsRaw 在 call 里（窗口截断时可能没有）
  assert.equal(__test.toolTarget({ call: { name: 'read', argsRaw: '{"path":"E:/a/b.js"}' } }), 'b.js');
});

test('动作人话：不同工具组用不同的动词，完成态换完成动词', () => {
  assert.equal(__test.actionText('bash', 'npm test', 'running'), '正在执行命令 npm test');
  assert.equal(__test.actionText('bash', 'npm test', 'ok'), '跑完命令 npm test');
  assert.equal(__test.actionText('read', 'client.js', 'running'), '正在读 client.js');
  assert.equal(__test.actionText('read', 'client.js', 'ok'), '读完了 client.js');
  assert.equal(__test.actionText('write', 'a.js', 'running'), '正在写 a.js');
  assert.equal(__test.actionText('edit', 'a.js', 'ok'), '改好了 a.js');
  assert.equal(__test.actionText('subagent', '审查', 'running'), '派了小助手 审查');
  assert.equal(__test.actionText('mnemon_recall', '', 'running'), '正在执行 mnemon_recall');
});

test('阶段话术：工具间隙的思考说「刚干完什么，在想下一步」', () => {
  const nodes = [
    { kind: 'tool-result', seq: 12, callId: 'r1', name: 'read', time: 1000, callTime: 900, isError: false, content: [], args: {}, call: null, subCalls: [] },
    { kind: 'tool-result', seq: 13, callId: 'g1', name: 'grep', time: 2000, callTime: 1800, isError: false, content: [], args: {}, call: null, subCalls: [] },
    { kind: 'tool-result', seq: 14, callId: 'r2', name: 'read', time: 3000, callTime: 2500, isError: false, content: [], args: {}, call: null, subCalls: [] },
  ];
  const tools = __test.turnTools({ nodes, turnEnds: new Map([[0, 5]]), turn: 1 });
  assert.equal(tools.length, 3, '回合内 3 条结果');
  const phase = __test.phaseText(tools, 5000);
  assert.equal(phase.text, '看完了 3 个文件，在想下一步');
  assert.equal(phase.sinceMs, 2000);

  // 编辑过的 → 「刚改完 xxx」
  const phaseEdit = __test.phaseText([
    { kind: 'tool-result', seq: 20, name: 'edit', time: 4000, callTime: 3000, isError: false,
      content: [], args: {}, call: { name: 'edit', argsRaw: '{"path":"E:/x/client.js"}' }, subCalls: [] },
  ], 9000);
  assert.equal(phaseEdit.text, '刚改完 client.js，在想下一步');

  assert.equal(__test.phaseText([], 0), null);
});

test('思考兜底链：规则 > 阶段话术 > 俏皮词', () => {
  const nodes = [
    { kind: 'tool-result', seq: 12, name: 'read', time: 1000, callTime: 900, isError: false, content: [], args: {}, call: null, subCalls: [] },
  ];
  const base = { partial: { turn: 1, step: 0 }, runningCalls: [], nodes, turnEnds: new Map([[0, 5]]) };

  // 命中规则（思考文本提到读取配置）
  const hitRule = __test.deriveCaption({ ...base,
    partial: { turn: 1, step: 0, blocks: [{ kind: 'reasoning', text: '读取配置文件 package.json' }] } });
  assert.equal(hitRule.ruleId, 'read-config');
  assert.equal(hitRule.phase, null);

  // 没命中规则但本回合干过活 → 阶段话术
  const hitPhase = __test.deriveCaption({ ...base,
    partial: { turn: 1, step: 0, blocks: [{ kind: 'reasoning', text: '嗯……' }] } });
  assert.equal(hitPhase.ruleId, null);
  assert.equal(hitPhase.phase, '看完了 1 个文件，在想下一步');

  // 什么都没有 → 交给俏皮词
  const hitWord = __test.deriveCaption({ ...base, nodes: [], turnEnds: new Map(),
    partial: { turn: 1, step: 0, blocks: [{ kind: 'reasoning', text: '嗯……' }] } });
  assert.equal(hitWord.ruleId, null);
  assert.equal(hitWord.phase, null);
});

test('成功态会自己收起（5 秒），标签稳定窗口会随速度变', () => {
  assert.equal(__test.OK_LINGER_MS, 5000);
  assert.equal(__test.LABEL_HOLD_MS, 350);
  assert.equal(__test.LABEL_HOLD_FAST_MS, 800);
  assert.ok(__test.FAST_CPS > 0, '快思考阈值必须为正');
});

test('想得快也不闪：状态没了之后最后一条至少挂 2.6 秒', () => {
  const at = 1_000_000;
  const ended = { key: 'tool:1:1', state: 'ok' };
  assert.equal(__test.pickView(ended, null, at), ended, '实时状态永远优先');
  assert.equal(__test.pickView(null, { view: ended, at: at - 900 }, at), ended, '0.9 秒时还在');
  assert.equal(__test.pickView(null, { view: ended, at: at - 2600 }, at), null, '满 2.6 秒才收');
  assert.equal(__test.pickView(null, null, at), null, '什么都没发生过就不显示');
  assert.ok(__test.MIN_SHOW_MS >= 2000, '最短停留至少 2 秒，够读完一行');
});

test('只看工具（factsOnly）：不读思考文本，没有工具就不显示', () => {
  const thinking = {
    partial: { turn: 1, step: 0, blocks: [{ kind: 'reasoning', text: '我先读取配置文件 package.json' }] },
    runningCalls: [],
    nodes: [],
  };
  // 默认：会按规则表猜（三种说法轮着来，任一种都算命中）
  assert.match(text(render(thinking)), /(正在读取配置文件|翻一下配置文件|看看配置里怎么写的|对一下配置项)/);
  // 选「只看工具」：同样的数据不再猜
  assert.equal(__test.deriveCaption({ ...thinking, factsOnly: true }), null);
  // 但有工具在跑时，仍然照常报事实
  const running = __test.deriveCaption({
    factsOnly: true,
    partial: { turn: 1, step: 0, blocks: [] },
    runningCalls: [{ callId: 'c1', name: 'bash', step: 0, time: Date.now() - 500, argsRaw: '{"command":"ls"}' }],
    nodes: [],
  });
  assert.equal(running.state, 'running');
  assert.equal(running.target, 'ls');
});

test('思考没结束就不收起：两步之间的空档也要有字幕', () => {
  // 回合还开着、partial 恰好为空（模型两步之间）→ 不能收
  const gap = __test.deriveCaption({
    partial: null, runningCalls: [], nodes: [],
    turn: 4, turnOpen: true, waitingText: '正在准备下一步',
  });
  assert.ok(gap, '回合没结束就必须有内容');
  assert.equal(gap.state, 'thinking');
  assert.equal(gap.phase, '正在准备下一步');
  assert.equal(gap.key, 'wait:4');
  // 回合结束（turnEnds 里有这一轮）→ 这时才允许收
  assert.equal(__test.deriveCaption({
    partial: null, runningCalls: [], nodes: [], turn: 4, turnOpen: false,
  }), null);
});

test('组件：partial 为空但工具还在跑时，字幕仍然挂着', () => {
  const view = render({
    partial: null,
    runningCalls: [{
      callId: 'c7', name: 'bash', step: 1, time: Date.now() - 1500,
      argsRaw: '{"command":"npm run build"}',
    }],
    nodes: [],
    turnEnds: new Map(),
  });
  assert.doesNotMatch(view.props.className, /pgc-strip--handle/, '不许收成齿轮');
  assert.match(text(view), /npm run build/);
});

test('两步之间的空档用 TURN_GAP_MS 兜住，且兜底只认「刚见过的那一轮」', () => {
  assert.ok(__test.TURN_GAP_MS >= 5000, '空档容忍至少 5 秒');
  // 没有 partial、也没见过任何回合 → 不能凭空显示
  assert.equal(__test.deriveCaption({ partial: null, runningCalls: [], nodes: [] }), null);
});

test('俏皮词真的画得出来：思考时挂着，且不会被主文案挤成 0 宽', () => {
  const view = render({
    partial: { turn: 3, step: 0, blocks: [{ kind: 'reasoning', text: '我先读取配置文件 package.json' }] },
    runningCalls: [],
    nodes: [],
    turnEnds: new Map(),
  });
  const flavors = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.props && node.props.className === 'pgc-flavor') flavors.push(node);
    (node.children || []).forEach(walk);
  };
  walk(view);
  assert.equal(flavors.length, 1, '思考期间必须有一个俏皮词');
  assert.ok(text(flavors[0]).trim().length > 0, '俏皮词不能是空的');
});

test('有俏皮词时让位给词，没词时显示「进行中」，俏皮词固定在最右', () => {
  const withWords = render({
    partial: { turn: 3, step: 0, blocks: [{ kind: 'reasoning', text: '我先读取配置文件 package.json' }] },
    runningCalls: [],
    nodes: [],
    turnEnds: new Map(),
  });
  const liveOf = (view) => {
    let live = null;
    const walk = (node) => {
      if (!node || typeof node !== 'object') return;
      if (node.props && node.props.className === 'pgc-live') live = node;
      (node.children || []).forEach(walk);
    };
    walk(view);
    return live;
  };
  const classes = (liveOf(withWords).children || []).map((c) => (c && c.props && c.props.className) || '');
  assert.ok(classes.includes('pgc-flavor'), '应该有俏皮词');
  assert.ok(classes.includes('pgc-dot'), '状态小圆点必须在，由它表达进行中');
  assert.ok(!classes.includes('pgc-chip'), '有俏皮词时不再重复挂「进行中」，省出宽度');
  assert.equal(classes[classes.length - 1], 'pgc-flavor', '俏皮词固定在最右');
});

test('关掉俏皮词后，「进行中」胶囊补回来', () => {
  const previous = globalThis.localStorage;
  globalThis.localStorage = { getItem: () => JSON.stringify({ words: false }), setItem: () => {} };
  try {
    const view = render({
      partial: { turn: 3, step: 0, blocks: [{ kind: 'reasoning', text: '我先读取配置文件 package.json' }] },
      runningCalls: [],
      nodes: [],
      turnEnds: new Map(),
    });
    let live = null;
    const walk = (node) => {
      if (!node || typeof node !== 'object') return;
      if (node.props && node.props.className === 'pgc-live') live = node;
      (node.children || []).forEach(walk);
    };
    walk(view);
    const classes = (live.children || []).map((c) => (c && c.props && c.props.className) || '');
    assert.ok(classes.includes('pgc-chip'), '没有俏皮词时必须有状态胶囊');
    assert.ok(!classes.includes('pgc-flavor'), '关掉后不该再有俏皮词');
  } finally {
    if (previous === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previous;
  }
});

test('回合小结：只数上一回合结束之后的结果', () => {
  const nodes = [
    { kind: 'tool-result', seq: 10, callTime: 100, time: 200, isError: false, content: [], args: {}, call: null, subCalls: [] },
    { kind: 'tool-result', seq: 20, callTime: 1000, time: 2500, isError: true, error: { name: 'Error', code: 'E' }, content: [], args: {}, call: null, subCalls: [] },
    { kind: 'tool-result', seq: 30, callTime: 9000, time: 9500, isError: false, content: [], args: {}, call: null, subCalls: [] },
  ];
  const week = __test.summarizeTurn({ nodes, turnEnds: new Map([[0, 5]]), endSeq: 25, turn: 1 });
  assert.deepEqual(week, { total: 2, ok: 1, bad: 1, ms: 2400 });
  assert.equal(__test.summarizeTurn({ nodes, turnEnds: new Map(), endSeq: 5, turn: 1 }), null);
  assert.equal(__test.summarizeTurn({ nodes, turnEnds: new Map([[1, 35]]), endSeq: 40, turn: 2 }), null);
});

test('回合小结组件：结在回合末尾，没有工具就返回 null', () => {
  const summary = registrations[1].component;
  const legacy = { nodes: [
    { kind: 'tool-result', seq: 10, callTime: 100, time: 200, isError: false, content: [], args: {}, call: null, subCalls: [] },
    { kind: 'tool-result', seq: 20, callTime: 1000, time: 2500, isError: true, error: { name: 'Error', code: 'E' }, content: [], args: {}, call: null, subCalls: [] },
  ], turnEnds: new Map([[0, 5]]) };
  const view = resolve(summary({ useChat: (selector) => selector({ legacy }), turn: { turn: 1, status: 'closed', steps: 2, data: [] }, seq: 25 }));
  assert.match(text(view), /本回合 · 2 次工具 · 1 成 1 败 · 用时 2\.4s/);

  const quiet = resolve(summary({ useChat: (selector) => selector({ legacy: { nodes: legacy.nodes, turnEnds: new Map([[0, 5], [1, 25]]) } }), turn: { turn: 2, status: 'closed', steps: 1, data: [] }, seq: 30 }));
  assert.equal(quiet, null, '上一回合之后没有新结果 → 不占位置');

  const open = resolve(summary({ useChat: (selector) => selector({ legacy }), turn: { turn: 1, status: 'open', steps: 2, data: [] }, seq: 25 }));
  assert.equal(open, null, '回合还没结束 → 不显示');
});

test('宿主没注入 useChat 时不崩：外层直接返回 null，不进任何 Hook', () => {
  const caption = registrations[0].component;
  const summary = registrations[1].component;
  assert.equal(caption({ t: (k) => k }), null);
  assert.equal(summary({ t: (k) => k }), null);
});

test('同一动作换着说法：每条规则至少 3 种，且不同步数会说不同的话', () => {
  const variants = __test.RULE_VARIANTS;
  const ids = Object.keys(variants);
  assert.ok(ids.length >= 17, '17 条规则都要有变体');
  for (const id of ids) {
    assert.equal(variants[id].zh.length, 3, id + ' 应有 3 种中文说法');
    assert.equal(variants[id].en.length, 3, id + ' 应有 3 种英文说法');
    assert.equal(new Set(variants[id].zh).size, 3, id + ' 三种说法不能重复');
  }
  // 同一个规则、不同 step → 文案必须换
  const one = { partial: { turn: 4, step: 0, blocks: [{ kind: 'reasoning', text: '我先读取配置文件' }] }, runningCalls: [], nodes: [] };
  const two = { partial: { turn: 4, step: 3, blocks: [{ kind: 'reasoning', text: '我先读取配置文件' }] }, runningCalls: [], nodes: [] };
  assert.notEqual(text(render(one)), text(render(two)));
});

test('副行：行数开到 2 才摘一句思考原话，行数 1 时不占地方', () => {
  assert.equal(__test.firstSentence('**先看 package.json** 的入口。后面再说'), '先看 package.json 的入口');
  assert.equal(__test.firstSentence(''), '');

  const data = {
    partial: { turn: 2, step: 0, blocks: [{ kind: 'reasoning', text: '我先读取配置文件，看看入口在哪。然后决定改哪里。' }] },
    runningCalls: [],
    nodes: [],
  };
  const previous = globalThis.localStorage;
  try {
    globalThis.localStorage = { getItem: () => JSON.stringify({ lines: 2 }), setItem: () => {} };
    const wide = render(data);
    assert.match(text(wide), /我先读取配置文件/);

    globalThis.localStorage = { getItem: () => JSON.stringify({ lines: 1 }), setItem: () => {} };
    assert.doesNotMatch(text(render(data)), /我先读取配置文件/);
  } finally {
    if (previous === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previous;
  }
});

test('耗时不到 1 秒不显示，免得挂个「0.0s」像坏了', () => {
  const data = {
    partial: { turn: 3, step: 0, blocks: [{ kind: 'reasoning', text: '想了想' }] },
    runningCalls: [],
    nodes: [],
    turnEnds: new Map([[2, 100]]),
  };
  const quick = __test.deriveCaption({ ...data, now: 500 });
  assert.equal(quick.elapsedMs, null, '思考态没有起点时本来就没有耗时');

  const running = __test.deriveCaption({
    ...data,
    runningCalls: [{ callId: 'c9', name: 'bash', step: 0, time: 10_000, argsRaw: '{"command":"ls"}' }],
    now: 10_400,
  });
  assert.equal(running.elapsedMs, 400);
  assert.doesNotMatch(text(render({ ...data, runningCalls: [{ callId: 'c9', name: 'bash', step: 0, time: Date.now() - 400, argsRaw: '{"command":"ls"}' }] })), /\d\.\d\ss/);
});
