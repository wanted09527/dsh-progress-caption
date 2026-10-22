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
/** 记录插件创建的 DOM 元素（样式那一支要拿它的 textContent 做断言）。 */
const created = [];
globalThis.window = { __ModuleLoader__: { load: (spec) => { captured = spec; } } };
globalThis.document = {
  head: { appendChild() {} },
  createElement() {
    const element = {
      attrs: {},
      setAttribute(name, value) { element.attrs[name] = value; },
      remove() {},
      textContent: '',
    };
    created.push(element);
    return element;
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

/* ---------------- 样式表：不闪 / 不撑满的硬约束 ----------------
 * 这两条只能靠 CSS 保证，逻辑测试看不出来，所以直接对注入的样式文本做断言。
 * 一旦有人把宽度改回 100%、或者给整条加无限动画，这里会红。 */
const cssTag = created.find((element) => element.attrs['data-plugin'] === 'dsh-progress-caption');
const sheet = cssTag ? cssTag.textContent : '';

test('样式表注入到 head，且带 data-plugin 标记', () => {
  assert.ok(cssTag, '要注入 <style data-plugin="dsh-progress-caption">');
  assert.ok(sheet.length > 1000, '样式内容不该是空的');
});

test('字幕条宽度跟输入框对齐：减掉两侧留白，不写 100%', () => {
  const rule = /\.pgc-strip \{([\s\S]*?)\}/.exec(sheet);
  assert.ok(rule, '要能找到 .pgc-strip 规则');
  const body = rule[1];
  assert.match(body, /calc\(100% - 2 \* var\(--dsh-composer-side-clearance, 16px\)\)/,
    '父容器没有内边距，必须自己减两侧留白');
  assert.match(body, /max-width: var\(--dsh-composer-card-max-width, 952px\)/,
    '宽度上限要跟输入框卡片一致');
  assert.match(body, /margin: 0 auto/, '要居中');
  assert.doesNotMatch(body, /(^|\W)width: 100%/, '写 100% 就会把整行撑满');
});

test('整条字幕条没有无限动画；小圆点在安静档只做呼吸，扫光档才跳', () => {
  const stripRule = /\.pgc-strip \{([\s\S]*?)\}/.exec(sheet)[1];
  assert.doesNotMatch(stripRule, /animation:/, '根节点上不许挂动画（会整条闪）');
  assert.match(sheet, /\.pgc-anim-calm \.pgc-dot \{ animation: pgc-breathe/, '安静档只给状态点呼吸');
  assert.match(sheet, /\.pgc-anim-sweep \.pgc-dot \{ animation: pgc-hop/, '扫光档才让三点跳');
  const breathe = /@keyframes pgc-breathe \{([\s\S]*?)\n\}/.exec(sheet);
  assert.ok(breathe, '要有 pgc-breathe');
  assert.doesNotMatch(breathe[1], /opacity:/, '呼吸不许动 opacity（会看着在闪）');
  // 三点错相位靠负延迟：没有它们就是三颗点一起闪，那才是「闪」。
  assert.match(sheet, /\.pgc-anim-sweep \.pgc-dot:nth-child\(2\) \{ animation-delay: -\.6s; \}/);
  assert.match(sheet, /\.pgc-anim-sweep \.pgc-dot:nth-child\(3\) \{ animation-delay: -\.3s; \}/);
  const loader = /\.pgc-loader \{([\s\S]*?)\}/.exec(sheet);
  assert.ok(loader, '要有 .pgc-loader');
  assert.match(loader[1], /width: 16px/, '三点总宽写死，跳起来也不会推动主文案');
  const hop = /@keyframes pgc-hop \{([\s\S]*?)\n\}/.exec(sheet);
  assert.ok(hop, '要有 pgc-hop');
  assert.doesNotMatch(hop[1], /(width|height|margin|padding|top|left)/,
    '起跳只许动 transform，别改宽高（会重排、会抖）');
});

test('扫光只扫第一行、方向从左到右、光带窄于整行', () => {
  const after = /\.pgc-anim-sweep \.pgc-label::after \{([\s\S]*?)\n\}/.exec(sheet);
  assert.ok(after, '要有 .pgc-anim-sweep .pgc-label::after');
  const rule = after[1].replace(/\/\*[\s\S]*?\*\//g, '');
  // 只扫第一行：光带挂在 .pgc-label 上，且第二行必须显式关掉。
  assert.match(sheet, /\.pgc-anim-sweep \.pgc-sub::after \{ content: none; animation: none; \}/,
    '副行（第二行）必须不扫');
  // 不整条扫：光带只有这一行的 40% 宽，且不再靠 background-size 撑满。
  assert.match(rule, /width: 40%/, '光带要窄，不能铺满整行');
  assert.doesNotMatch(rule, /inset: 0/, 'inset: 0 会让光带铺满整条');
  assert.doesNotMatch(rule, /background-size/, '整条底色一起亮就是「整条一起扫」');
  // 左到右：从 -100%（藏在左边外面）走到正数（越过右边界）。
  const sweep = /@keyframes pgc-sweep \{([\s\S]*?)\n\}/.exec(sheet);
  assert.ok(sweep, '要有 pgc-sweep');
  assert.match(sweep[1], /0% \{ transform: translateX\(-100%\); \}/, '起点在左边界外面');
  assert.match(sweep[1], /100% \{ transform: translateX\(350%\); \}/, '终点越过右边界');
  assert.doesNotMatch(sweep[1], /background-position/, '老实现是右到左，必须彻底换掉');
  assert.doesNotMatch(sweep[1], /\b(width|height|margin|padding|top|left|right|bottom):/,
    '扫光只许动 transform');
});

test('俏皮词占固定宽度，换词不推挤主文案', () => {
  const flavor = /\.pgc-flavor \{([\s\S]*?)\}/.exec(sheet);
  assert.ok(flavor, '要能找到 .pgc-flavor 规则');
  assert.match(flavor[1], /width: 6\.6em/, '宽度写死，词长变化才不会推动左边');
  assert.doesNotMatch(flavor[1], /min-width:/, 'min-width 会让宽度跟着词长浮动');
});

test('一行时不许把俏皮词胶囊切掉一条：靠内边距撑开裁剪框，且必须仍然裁剪', () => {
  const bandRule = /\.pgc-band \{([\s\S]*?)\}/.exec(sheet);
  assert.ok(bandRule, '要能找到 .pgc-band 规则');
  // 去掉注释再看声明，否则注释里提到过的写法会被误判。
  const band = bandRule[1].replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(band, /overflow: hidden/, '必须裁剪，否则收起时内容会溢出去压到上一条消息');
  assert.doesNotMatch(band, /overflow: visible/, 'overflow: visible 会导致「指令堆叠时显示异常」');
  assert.match(band, /padding-block: 6px/, '用内边距把裁剪框撑开，2px 位移才切不到胶囊底边');
  assert.match(band, /margin-block: -6px/, '负外边距抵回去，外层占位高度才不变');
  const handle = /\.pgc-strip--handle \.pgc-band \{([\s\S]*?)\}/.exec(sheet);
  assert.ok(handle, '收起时要能收成细缝');
  assert.match(handle[1], /max-height: 0/);
  assert.match(handle[1], /padding-block: 0/, '收起时内边距也要归零');
  assert.match(handle[1], /margin-block: 0/, '收起时负外边距也要归零');
});

test('系统开了「减少动态效果」就把动画全关掉', () => {
  assert.match(sheet, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(sheet, /animation: none !important/);
  assert.match(sheet, /transition: none !important/);
});

test('换文案的动画从半透明起步，不是从 0 闪出来', () => {
  const swap = /@keyframes pgc-swap \{([\s\S]*?)\n\}/.exec(sheet);
  assert.ok(swap, '要有 pgc-swap');
  assert.match(swap[1], /opacity: \.45/, '起点要大于 0，否则每次换字都是「消失再浮现」');
  assert.doesNotMatch(swap[1], /opacity: 0[;,}]/, '换文案不许从完全透明开始');
  // 换文案的动画只能挂在「安静 / 扫光」两档上；全静止档必须真的静止。
  assert.match(sheet, /\.pgc-anim-calm \.pgc-label,\s*\n\s*\.pgc-anim-sweep \.pgc-label \{ animation: pgc-swap/);
  assert.match(sheet, /\.pgc-anim-off \.pgc-live, \.pgc-anim-off \.pgc-label, \.pgc-anim-off \.pgc-flavor \{ animation: none; \}/);
  // 只在合成层动：位移和透明度，绝不出现 width/height/margin 之类会重排的属性。
  assert.doesNotMatch(swap[1], /\b(width|height|margin|padding|top|left|right|bottom):/,
    '换文案不许改尺寸或位置属性');
});

test('入场只播一次，挂在内容层而不是整条根节点', () => {
  const stripRule = /\.pgc-strip \{([\s\S]*?)\}/.exec(sheet)[1];
  assert.doesNotMatch(stripRule, /animation:/, '根节点挂动画会被每次重渲染重播，就是闪');
  const live = /\.pgc-live \{([\s\S]*?)\}/.exec(sheet);
  assert.ok(live, '要能找到 .pgc-live 规则');
  assert.match(live[1], /animation: pgc-enter/, '入场动画挂在内容层，一次出现只播一次');
  const enter = /@keyframes pgc-enter \{([\s\S]*?)\n\}/.exec(sheet);
  assert.ok(enter, '要有 pgc-enter');
  assert.match(enter[1], /scale\(\.98/, '入场是轻微放大，不是从 0 弹出来');
  assert.doesNotMatch(enter[1], /scale\(0\)/, '不许 scale(0)');
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

test('状态一：工具在跑 → 第 N 步 / 正在执行命令（进行中由三点表达，不再挂耗时）', () => {
  const view = render({
    partial: { turn: 1, step: 2, blocks: [{ kind: 'reasoning', text: '跑一下命令' }] },
    runningCalls: [{ callId: 'c1', name: 'bash', step: 2, time: Date.now() - 1200 }],
    nodes: [],
  });
  const shown = text(view);
  assert.match(shown, /第 3 步/);
  assert.match(shown, /正在执行命令/);
  assert.doesNotMatch(shown, /\d+\.\ds/, '耗时已撤掉：思维链区域已经显示过，这里不再重复');
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
  assert.doesNotMatch(shown, /1\.5s/, '条上不再挂耗时，避免和思维链区域重复');
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
  assert.deepEqual(__test.normalizeSettings({ size: 'xxl', subLine: 'yes', anim: 'boom', words: 'yes' }), {
    size: 'm', subLine: true, anim: 'calm', words: true, factsOnly: false,
    accent: 'theme', okColor: 'theme', badColor: 'theme', flavorStyle: 'tint',
  });
  assert.deepEqual(__test.normalizeSettings({ size: 'l', subLine: true, anim: 'off', words: false, factsOnly: true }), {
    size: 'l', subLine: true, anim: 'off', words: false, factsOnly: true,
    accent: 'theme', okColor: 'theme', badColor: 'theme', flavorStyle: 'tint',
  });
  // 老存档兼容：lines: 3 等价于 subLine: true；lines: 1 等价于 false。
  assert.equal(__test.normalizeSettings({ lines: 3 }).subLine, true);
  assert.equal(__test.normalizeSettings({ lines: 1 }).subLine, false);
  assert.equal(__test.normalizeSettings({ subLine: false, lines: 3 }).subLine, false, '新字段优先');
});

test('设置：没有 localStorage 也不崩', () => {
  assert.deepEqual(__test.readSettings(), __test.DEFAULT_SETTINGS);
  assert.doesNotThrow(() => __test.writeSettings({ size: 's', subLine: true, anim: 'dots', words: false }));
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

test('字幕带设置面板：字号 / 思考原话 / 动画 / 俏皮词', () => {
  const view = render({
    partial: { turn: 9, step: 0, blocks: [{ kind: 'reasoning', text: '看看配置' }] },
    runningCalls: [],
    nodes: [],
  });
  const shown = text(view);
  assert.match(shown, /字幕设置/);
  assert.match(shown, /字号/);
  assert.match(shown, /思考原话/);
  assert.match(shown, /动画/);
  assert.match(shown, /俏皮词/);
  // 「行数」这个设置项已经删掉了：它原来只起「要不要显示副行」的开关作用，
  // 名字却叫行数，实测开到 2/3 几乎没有视觉差别（主文案是整句，不折行）。
  assert.doesNotMatch(shown, /行数/, '行数设置项应已移除');
  // 「没线索时」那一行：两个选项都用人话写出来，下面再补一句解释
  assert.match(shown, /没线索时/);
  assert.match(shown, /只报动作/);
  assert.match(shown, /猜一猜/);
  assert.match(shown, /猜错很正常/);
  assert.match(shown, /扫光/);
  assert.match(shown, /安静/);
  assert.match(shown, /全静止/);
  assert.match(view.props.className, /pgc-size-m/);
  assert.match(view.props.className, /pgc-anim-calm/);
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

test('状态点固定三颗，装在 .pgc-loader 里，不靠文字徽标', () => {
  const view = render({
    partial: { turn: 1, step: 0, blocks: [{ kind: 'reasoning', text: '先看看 package.json' }] },
    runningCalls: [],
    nodes: [],
  });
  const dots = [];
  const loaders = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.props && node.props.className === 'pgc-dot') dots.push(node);
    if (node.props && node.props.className === 'pgc-loader') loaders.push(node);
    (node.children || []).forEach(walk);
  };
  walk(view);
  assert.equal(loaders.length, 1, '三点要装在一个 .pgc-loader 里，方便整体对齐');
  assert.equal(dots.length, 3, '三颗点：靠负延迟错开相位，看着像排队跳');
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

test('阶段话术：工具间隙只报「刚干完什么」，不写「在想下一步」这种空尾巴', () => {
  const nodes = [
    { kind: 'tool-result', seq: 12, callId: 'r1', name: 'read', time: 1000, callTime: 900, isError: false, content: [], args: {}, call: null, subCalls: [] },
    { kind: 'tool-result', seq: 13, callId: 'g1', name: 'grep', time: 2000, callTime: 1800, isError: false, content: [], args: {}, call: null, subCalls: [] },
    { kind: 'tool-result', seq: 14, callId: 'r2', name: 'read', time: 3000, callTime: 2500, isError: false, content: [], args: {}, call: null, subCalls: [] },
  ];
  const tools = __test.turnTools({ nodes, turnEnds: new Map([[0, 5]]), turn: 1 });
  assert.equal(tools.length, 3, '回合内 3 条结果');
  const phase = __test.phaseText(tools, 5000);
  assert.equal(phase.text, '看完了 3 个文件');
  assert.equal(phase.sinceMs, 2000);

  // 编辑过的 → 「刚改完 xxx」
  const phaseEdit = __test.phaseText([
    { kind: 'tool-result', seq: 20, name: 'edit', time: 4000, callTime: 3000, isError: false,
      content: [], args: {}, call: { name: 'edit', argsRaw: '{"path":"E:/x/client.js"}' }, subCalls: [] },
  ], 9000);
  assert.equal(phaseEdit.text, '刚改完 client.js');

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
  assert.equal(hitPhase.phase, '看完了 1 个文件');

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

test('两步之间的空档：报刚跑完的那条工具和耗时，没事实就不写空话', () => {
  const nodes = [
    { kind: 'tool-result', seq: 12, callId: 'b1', name: 'bash', time: 5000, callTime: 3800, isError: false,
      content: [{ text: 'ok' }], args: {}, call: { name: 'bash', argsRaw: '{"command":"npm test"}' }, subCalls: [] },
  ];
  // 回合还开着、partial 恰好为空（模型两步之间）→ 不能收，且要说人话
  const gap = __test.deriveCaption({
    partial: null, runningCalls: [], nodes, turnEnds: new Map([[0, 5]]), turn: 4, turnOpen: true,
  });
  assert.ok(gap, '回合没结束就必须有内容');
  assert.equal(gap.state, 'thinking');
  assert.equal(gap.phase, 'npm test 跑完了 · 1.2s');
  assert.equal(gap.key, 'wait:4:b1');

  // 本回合什么都没跑过 → phase 留空，交给俏皮词，绝不能冒出「正在准备下一步」
  const bare = __test.deriveCaption({
    partial: null, runningCalls: [], nodes: [], turn: 4, turnOpen: true,
  });
  assert.ok(bare, '回合没结束就必须有内容');
  assert.equal(bare.phase, null);
  assert.equal(bare.key, 'wait:4:-');

  // 回合结束（turnEnds 里有这一轮）→ 这时才允许收
  assert.equal(__test.deriveCaption({
    partial: null, runningCalls: [], nodes: [], turn: 4, turnOpen: false,
  }), null);
});

test('空档话术只说事实：不到 1 秒不报时长，没有工具就返回 null', () => {
  assert.equal(__test.gapText([], 0), null);
  const quick = __test.gapText([
    { kind: 'tool-result', seq: 9, callId: 'q1', name: 'read', time: 1200, callTime: 900, isError: false,
      content: [], args: {}, call: { name: 'read', argsRaw: '{"path":"E:/x/a.js"}' }, subCalls: [] },
  ], 2000);
  assert.equal(quick.text, 'a.js 读完了');
  assert.equal(quick.id, 'q1');
  // 全部文案里不许再出现放之四海皆准的过场话
  const zh = __test.DICT.zh;
  Object.keys(zh).forEach((key) => {
    assert.doesNotMatch(String(zh[key]), /正在准备下一步|在想下一步/, key + ' 里还有空话');
  });
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
  assert.ok(classes.includes('pgc-loader'), '三点装载器必须在，由它表达进行中');
  assert.ok(!classes.includes('pgc-chip'), '有俏皮词时不再重复挂「进行中」，省出宽度');
  assert.equal(classes[classes.length - 1], 'pgc-flavor', '俏皮词固定在最右');
});

test('耗时位换成三点循环：宽高写死，点在槽里，且排队在俏皮词左边', () => {
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
  const kids = (live.children || []).filter(Boolean);
  const classes = kids.map((c) => (c && c.props && c.props.className) || '');
  const slot = kids.find((c) => c && c.props && c.props.className === 'pgc-slot');
  assert.ok(slot, '动画位必须在（删了版面会位移）');
  assert.equal(slot.props['data-pgc-slot'], 'loop', '给人看的标记');
  assert.equal(slot.props['aria-hidden'], true, '只是装饰，别让读屏念出来');
  const loop = (slot.children || []).filter(Boolean);
  assert.equal(loop.length, 1, '槽里装一层循环容器');
  assert.equal(loop[0].props.className, 'pgc-loop');
  const dots = (loop[0].children || []).filter(Boolean);
  assert.equal(dots.length, 3, 'Claude 那种三点');
  dots.forEach((d) => assert.equal(d.props.className, 'pgc-loop-dot'));
  assert.ok(classes.indexOf('pgc-slot') < classes.indexOf('pgc-flavor'), '动画位排在俏皮词左边');
  assert.ok(!classes.includes('pgc-time'), '耗时那一格已经撤掉了');

  // 尺寸写死：以后改动画怎么跳，都不会把左右两边挤动。
  const rule = /\.pgc-slot \{([\s\S]*?)\}/.exec(sheet);
  assert.ok(rule, '要有 .pgc-slot 规则');
  assert.match(rule[1], /width: 3\.6em/, '宽度与原耗时格一致，俏皮词位置不变');
  assert.match(rule[1], /height:/, '高度也要锁住');
  assert.match(rule[1], /flex: 0 0 auto/, '不许被压缩');

  // 三点只许动合成层属性。
  const dot = /\.pgc-loop-dot \{([\s\S]*?)\}/.exec(sheet);
  assert.ok(dot, '要有 .pgc-loop-dot 规则');
  assert.match(dot[1], /animation: pgc-loop-bounce/, '默认就在跳');
  const hasKey = (name) => new RegExp(`@keyframes ${name} \\{[\\s\\S]*?\\n\\}`).exec(sheet);
  for (const name of ['pgc-loop-bounce', 'pgc-loop-bounce-big']) {
    const frames = hasKey(name);
    assert.ok(frames, `要有 @keyframes ${name}`);
    const body = frames[0];
    assert.doesNotMatch(body, /\b(width|height|margin|padding|top|left|right|bottom):/, `${name} 只许动 transform/opacity`);
    assert.match(body, /transform:/, `${name} 必须真的动起来`);
  }
  assert.match(sheet, /@media \(prefers-reduced-motion: reduce\)/, '系统降级仍然保留');
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

test('副行：打开「思考原话」才摘一句，关着时不占地方', () => {
  const data = {
    partial: { turn: 2, step: 0, blocks: [{ kind: 'reasoning', text: '我先读取配置文件，看看入口在哪。然后决定改哪里。' }] },
    runningCalls: [],
    nodes: [],
  };
  const previous = globalThis.localStorage;
  try {
    globalThis.localStorage = { getItem: () => JSON.stringify({ subLine: true }), setItem: () => {} };
    const wide = render(data);
    assert.match(text(wide), /读取配置文件/);
    // 「我先」这类过场话必须被剥掉，副行从有内容的半句开始。
    assert.doesNotMatch(text(wide), /我先读取配置文件/);

    globalThis.localStorage = { getItem: () => JSON.stringify({ subLine: false }), setItem: () => {} };
    assert.doesNotMatch(text(render(data)), /读取配置文件/);

    // 老存档（只有 lines 字段）也要按原样复活：lines>=2 视为打开。
    globalThis.localStorage = { getItem: () => JSON.stringify({ lines: 2 }), setItem: () => {} };
    assert.match(text(render(data)), /读取配置文件/);
    globalThis.localStorage = { getItem: () => JSON.stringify({ lines: 1 }), setItem: () => {} };
    assert.doesNotMatch(text(render(data)), /读取配置文件/);
  } finally {
    if (previous === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previous;
  }
});

test('副行挑句：不再摘第一句过场话，而是挑有判断/有具体东西的那句', () => {
  // 第一句是纯过场话 → 必须跳过它
  const passing = 'Now let me look at the files. The real problem is that the strip has no stable width.';
  const picked = __test.pickThought(passing);
  assert.doesNotMatch(picked, /^Now let me/, '过场话不能被当成副行');
  assert.match(picked, /real problem|stable width/, '应该挑到有信息量的那句：' + picked);

  // 中文：「我先…」要剥掉
  assert.equal(__test.stripLead('我先读取配置文件'), '读取配置文件');
  assert.equal(__test.stripLead('But also, the reason is simple'), 'The reason is simple');

  // 清单开头（"…：1."）不单独摘出来
  assert.doesNotMatch(__test.pickThought('改这里：1. 先改 A 2. 再改 B'), /[:：]\s*$|：1\.$/);

  // 实在挑不出来 → 返回空串，宁可这行不显示
  assert.equal(__test.pickThought('好的'), '');
  assert.equal(__test.pickThought(''), '');

  // 只截断、不改写：挑出来的句子必须是原文里真实存在的一段
  const text0 = 'The key risk is that the timer keeps firing while the tab is hidden, so the strip updates forever.';
  const one = __test.pickThought(text0);
  assert.ok(text0.includes(one.replace(/…$/, '')), '不许改写原文：' + one);
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
