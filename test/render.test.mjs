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

test('整条字幕条没有无限动画；状态点是三颗，靠负延迟接力跳', () => {
  const stripRule = /\.pgc-strip \{([\s\S]*?)\}/.exec(sheet)[1];
  assert.doesNotMatch(stripRule, /animation:/, '根节点上不许挂动画（会整条闪）');

  // 容器定宽：三颗点在这个 18×14 的框里跳，右侧主文案一格都不动。
  const loader = /\.pgc-loader \{([\s\S]*?)\}/.exec(sheet);
  assert.ok(loader, '要有 .pgc-loader');
  assert.match(loader[1], /width: 18px/, '槽宽固定 18px，动画怎么跑都不推动主文案');
  assert.match(loader[1], /height: 14px/, '槽高 14px：一行文字约 16.8px，不撑高这一行');
  assert.doesNotMatch(loader[1], /background: var\(--pgc-accent\);/, '槽本身是空的，颜色由点自己给');

  // 三颗点各自绝对定位，横向排开 0 / 7 / 14px（间距 3px + 点径 4px）。
  const dot = /\.pgc-dot \{([\s\S]*?)\}/.exec(sheet);
  assert.ok(dot, '要有 .pgc-dot');
  assert.match(dot[1], /width: 4px; height: 4px/, '点径 4px');
  assert.match(dot[1], /border-radius: 50%/, '圆点');
  assert.match(dot[1], /transform-origin: 50% 100%/, '以底边为铰链，压扁时才是「踩在地上」');
  assert.match(sheet, /\.pgc-dot:nth-child\(2\) \{ left: 7px; \}/, '第二颗右移一格');
  assert.match(sheet, /\.pgc-dot:nth-child\(3\) \{ left: 14px; \}/, '第三颗再右移一格');

  // 经典三点的弹跳：两档共用同一套 keyframes，靠变量换周期。
  assert.match(sheet, /\.pgc-anim-calm \.pgc-loader\[data-pgc-shape="plain"\] \.pgc-dot,[\s\S]*?animation: pgc-dot-bounce var\(--pgc-dot-period\) ease infinite alternate;/,
    '两档共用同一条弹跳，靠变量换周期');
  assert.match(sheet, /\.pgc-anim-sweep \.pgc-loader\[data-pgc-shape="plain"\] \{ --pgc-dot-period: var\(--pgc-hop-cycle\); \}/,
    '扫光档换成快周期，跟文字的光带对上');
  // 负延迟是「接力」的全部秘密：三颗错开 1 周期 / 3/5 / 2/5。
  assert.match(sheet, /animation-delay: calc\(-1 \* var\(--pgc-dot-period\)\)/, '第一颗错开整周期');
  assert.match(sheet, /animation-delay: calc\(-3 \* var\(--pgc-dot-period\) \/ 5\)/, '第二颗错开 3/5 周期');
  assert.match(sheet, /animation-delay: calc\(-2 \* var\(--pgc-dot-period\) \/ 5\)/, '第三颗错开 2/5 周期');

  // 关键帧：压扁 → 弹起，只动 transform。
  const bounce = /@keyframes pgc-dot-bounce \{([\s\S]*?)\n\}/.exec(sheet);
  assert.ok(bounce, '要有 pgc-dot-bounce');
  const kf = bounce[1].replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(kf, /0% \{ transform: translateY\(0\) scale\(1\.7, \.25\); animation-timing-function: linear; \}/,
    '起点贴地压扁（squash）');
  assert.match(kf, /100% \{ transform: translateY\(-8px\) scale\(1, 1\); \}/, '到最高点时收回正常比例');
  assert.doesNotMatch(kf, /(^|[^-])(width|height|margin|padding|top|left|right):/,
    '只许动 transform，别改宽高（会重排、会抖）');
  for (const m of kf.matchAll(/translateY\((-?[\d.]+)px\)/g)) {
    assert.ok(Math.abs(Number(m[1])) <= 8, '纵向位移不超过 8px，落在 14px 高的容器里');
  }

  // 成功 / 失败态只换色，不冻住：那几秒里右边俏皮词还在滚。
  assert.match(sheet, /\.pgc-strip--ok \.pgc-dot \{ background: var\(--pgc-ok\); \}/, '成功态换色');
  assert.match(sheet, /\.pgc-strip--error \.pgc-dot \{ background: var\(--pgc-bad\); \}/, '失败态换色');
  const frozen = /\.pgc-strip--(ok|error)[^{]*\.pgc-dot[^{]*\{[^}]*animation: none[^}]*\}/.exec(sheet);
  assert.equal(frozen, null, '收尾态左侧标记继续跑，不许 freezing 成静止');

  // 全静止档：只留中间那颗，排一排不动的点看着像加载卡住。
  assert.match(sheet, /\.pgc-anim-off \.pgc-dot \{[^}]*animation: none[^}]*\}/, '全静止档真的不动');
  assert.match(sheet, /\.pgc-anim-off \.pgc-dot:nth-child\(2\),[\s\S]*?display: none;/, '只留一颗当句号');

  // reduced-motion：动画全撤之后，点要回到看得见的静止形。
  const reduced = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/.exec(sheet);
  assert.ok(reduced, '要有 reduced-motion 兜底');
  assert.match(reduced[1], /\.pgc-dot \{ transform: none !important; opacity: \.85 !important; \}/,
    '点要补回可见度，否则整个标记会消失');

  // 旧的三套形态必须彻底消失，不许以任何形式留回来。
  assert.doesNotMatch(sheet, /pgc-shape-/, '三套形态已删，不许残留 .pgc-shape-*');
  assert.doesNotMatch(sheet, /pgc-bar-fill|pgc-orbit-ring|pgc-cube-scene/, '三条/圆环/立方体的结构已删');
  assert.doesNotMatch(sheet, /@keyframes pgc-bar-sweep|@keyframes pgc-orbit-spin|@keyframes pgc-cube-walk/,
    '三套形态的关键帧已删');
});

test('扫光横扫整条、方向从左到右、光带与整框同宽', () => {
  // 光带挂在整个胶囊的覆盖层上，而不是文字格 .pgc-band：
  // band 只是「文字那一格」，右边齿轮那一列不在里面，光扫到 band 右边界就断，
  // 看着就是「右边少一块、没铺满」。覆盖层 inset: 0 才是整条。
  const after = /\.pgc-anim-sweep \.pgc-sweep::after \{([\s\S]*?)\n\}/.exec(sheet);
  assert.ok(after, '要有 .pgc-anim-sweep .pgc-sweep::after');
  const layer = /\.pgc-anim-sweep \.pgc-sweep \{([\s\S]*?)\n\}/.exec(sheet);
  assert.ok(layer, '要有覆盖层 .pgc-sweep');
  assert.match(layer[1], /position: absolute/, '覆盖层脱离流，不参与排版');
  assert.match(layer[1], /inset: 0/, '铺满整条胶囊（含齿轮那一格）');
  assert.match(layer[1], /border-radius: inherit/, '光的边界是胶囊圆角，不是方块');
  assert.match(layer[1], /overflow: hidden/, '要把超出圆角的光裁掉');
  assert.match(layer[1], /pointer-events: none/, '光不许挡住点齿轮');
  assert.match(layer[1], /display: block/);
  const rule = after[1].replace(/\/\*[\s\S]*?\*\//g, '');
  // 整条扫：光带挂在整条覆盖层上，不再只挂第一行。
  const labelAfter = /\.pgc-anim-sweep \.pgc-label::after \{([\s\S]*?)\n\}/.exec(sheet);
  assert.ok(labelAfter, '主文案上的老光带规则要保留一行显式关掉');
  assert.match(labelAfter[1], /content: none/, '主文案自己不再挂扫光（整条已经一起扫）');
  // 副行必须同样显式关掉，否则两层光会叠在一起。
  assert.match(sheet, /\.pgc-anim-sweep \.pgc-sub::after \{ content: none; animation: none; \}/,
    '副行（第二行）必须不扫');
  // 光带与整框同宽：宽度写 100%，配合 -100% → 100% 就是一整道横扫过去。
  assert.match(rule, /width: 100%/, '光带就是整框那么宽');
  assert.doesNotMatch(rule, /width: 40%/, '40% 是旧版窄光带，会变成「中间闪一下」');
  assert.match(rule, /transform: translateX\(-100%\)/, '起点藏在左边界外');
  assert.doesNotMatch(rule, /background-size/, '整条底色一起亮就是「整条一起扫」');
  // 左到右：从 -100%（藏在左边外面）走到 100%（完全越过右边界）。
  const sweep = /@keyframes pgc-sweep \{([\s\S]*?)\n\}/.exec(sheet);
  assert.ok(sweep, '要有 pgc-sweep');
  assert.match(sweep[1], /0% \{ transform: translateX\(-100%\); \}/, '起点在左边界外面');
  assert.match(sweep[1], /100% \{ transform: translateX\(100%\); \}/, '终点越过右边界');
  assert.doesNotMatch(sweep[1], /background-position/, '老实现是右到左，必须彻底换掉');
  assert.doesNotMatch(sweep[1], /\b(width|height|margin|padding|top|left|right|bottom):/,
    '扫光只许动 transform');
  // 根节点必须是定位上下文，否则 absolute 的覆盖层会跑到外层去。
  const stripRule = /\.pgc-strip \{([\s\S]*?)\}/.exec(sheet);
  assert.match(stripRule[1], /position: relative/, '.pgc-strip 要当覆盖层的定位参照');
  // 收成齿轮时没内容可扫，别再闪一下。
  assert.match(sheet, /\.pgc-strip--handle \.pgc-sweep \{ display: none !important; \}/);
  // DOM 上真的挂了这个覆盖层，且是纯装饰。
  const view = render({
    partial: { turn: 1, step: 1, blocks: [{ kind: 'reasoning', text: '嗯……' }] },
    runningCalls: [],
    nodes: [],
    endEnds: new Map(),
  });
  let layerNode = null;
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.props && node.props.className === 'pgc-sweep') layerNode = node;
    (node.children || []).forEach(walk);
  };
  walk(view);
  assert.ok(layerNode, '渲染树里要有 .pgc-sweep');
  assert.equal(layerNode.props['aria-hidden'], true);
});

test('俏皮词占固定宽度，换词不推挤主文案', () => {
  const flavor = /\.pgc-flavor \{([\s\S]*?)\}/.exec(sheet);
  assert.ok(flavor, '要能找到 .pgc-flavor 规则');
  assert.match(flavor[1], /width: 6\.6em/, '宽度写死，词长变化才不会推动左边');
  assert.doesNotMatch(flavor[1], /min-width:/, 'min-width 会让宽度跟着词长浮动');
});

test('默认档的俏皮词不画「一圈」：没有边框、没有底色，只有两端渐隐', () => {
  const flavor = /\.pgc-flavor \{([\s\S]*?)\}/.exec(sheet);
  assert.ok(flavor, '要能找到 .pgc-flavor 规则');
  // 去掉注释再看声明，否则注释里解释「以前有 border」会被误判。
  const rule = flavor[1].replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(rule, /border:\s*1px/, '默认档不许再有一圈描边，词不该被关在框里');
  assert.doesNotMatch(rule, /border-radius:\s*999px/, '没有边框就不要胶囊圆角了');
  assert.doesNotMatch(rule, /background:\s*color-mix/, '默认档不留底色，圆角矩形就是它撑出来的');
  assert.match(rule, /mask-image: linear-gradient\(90deg, transparent 0, #000 14%, #000 86%, transparent 100%\)/,
    '两端各 14% 渐变到透明：词从雾里滚进滚出，边界不是一条硬线');
  assert.match(rule, /-webkit-mask-image: linear-gradient/, 'Safari / 旧 WebKit 也要这条');
  // 滚槽本体该留的还得在。
  assert.match(rule, /overflow: hidden/, '滚槽还得裁掉滚出去的那半句');
  assert.match(rule, /height: 1\.6em/, '高度锁死，换词不撑高');
  assert.match(rule, /padding: 0 9px/, '留点内边距，不然字贴着渐隐区就没了');
  assert.doesNotMatch(rule, /animation:/, '外壳依然不许挂动画');
});

test('俏皮词只剩两档：实心有一块底，素色档连同样式一起删掉', () => {
  const solid = /\.pgc-flavor-solid \.pgc-flavor \{([\s\S]*?)\}/.exec(sheet);
  assert.ok(solid, '要有实心档规则');
  const solidRule = solid[1].replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(solidRule, /background: var\(--pgc-accent\)/, '实心档要有一块实底');
  assert.match(solidRule, /color: #fff/, '实底上要用白字');
  assert.match(solidRule, /mask-image: none/, '实心胶襄必须关掉渐隐，否则两头会被啃成透明');

  // 素色（plain）这一档按用户要求删掉了：样式段里不许再出现它的规则，
  // 选项表里也不许再收它（老存档的 'plain' 由 normalizeSettings 折回 'tint'）。
  assert.equal(__test.FLAVOR_STYLES.length, 2, '俏皮词样子只留两档');
  assert.deepEqual(__test.FLAVOR_STYLES, ['tint', 'solid']);
  assert.doesNotMatch(sheet, /\.pgc-flavor-plain/, '素色档整段删除，不许残留');

  // 成功 / 失败只换字色，不再铺一层底色。
  const ok = /\.pgc-strip--ok \.pgc-flavor \{([\s\S]*?)\}/.exec(sheet);
  assert.ok(ok, '要有成功态规则');
  assert.match(ok[1], /color: var\(--pgc-ok\)/, '成功换字色');
  assert.doesNotMatch(ok[1], /background:/, '默认档成功也不铺底色');
  const bad = /\.pgc-strip--error \.pgc-flavor \{([\s\S]*?)\}/.exec(sheet);
  assert.ok(bad, '要有失败态规则');
  assert.match(bad[1], /color: var\(--pgc-bad\)/, '失败换字色');
  assert.doesNotMatch(bad[1], /background:/, '默认档失败也不铺底色');

  // 实心档仍可以整颗换色。
  const solidOk = /\.pgc-flavor-solid\.pgc-strip--ok \.pgc-flavor \{([\s\S]*?)\}/.exec(sheet);
  assert.ok(solidOk, '实心档成功要能整颗换色');
  assert.match(solidOk[1], /background: var\(--pgc-ok\)/, '实心档成功时底色跟着换');
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
  assert.match(sheet, /\.pgc-anim-off \.pgc-live, \.pgc-anim-off \.pgc-label, \.pgc-anim-off \.pgc-flavor,\s*\n\s*\.pgc-anim-off \.pgc-flavor-track \{ animation: none; \}/);
  // 只在合成层动：位移和透明度，绝不出现 width/height/margin 之类会重排的属性。
  assert.doesNotMatch(swap[1], /\b(width|height|margin|padding|top|left|right|bottom):/,
    '换文案不许改尺寸或位置属性');
});

test('整轮最前面几步不播换文案动画：只关「换字」，不关入场', () => {
  assert.equal(__test.SETTLE_STEPS, 3, '前 3 步是状态翻得最勤的一段');
  const rule = /\.pgc-strip--settle \.pgc-flavor,\s*\n\s*\.pgc-strip--settle \.pgc-flavor-track,\s*\n\s*\.pgc-strip--settle \.pgc-label \{ animation: none; \}/;
  assert.match(sheet, rule, '前几步换文案一律硬切换');
  assert.doesNotMatch(sheet, /\.pgc-strip--settle \.pgc-live \{/,
    '入场动画一次出现只播一次，不是闪烁来源，别一起关掉');
  // 步号整轮常驻：空档时沿用上一个非空步号，不许把「第 N 步」整块摘掉。
  const view = render({
    partial: null,
    runningCalls: [{ callId: 'c9', name: 'bash', step: 4, time: Date.now() - 600 }],
    nodes: [],
    turnEnds: new Map(),
  });
  assert.match(text(view), /第 4 步/, '空档里步号必须还在');
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
  // 宿主发出来的 step 本来就是 1 起（真实会话日志核过），这里原样透传：
  // 传进来的 step 是 2，就该显示「第 2 步」，不能多算一步。
  assert.match(shown, /第 2 步/);
  assert.match(shown, /正在执行命令/);
  assert.doesNotMatch(shown, /\d+\.\ds/, '耗时已撤掉：思维链区域已经显示过，这里不再重复');
  assert.match(view.props.title, /规则推断/);
  assert.match(view.props.className, /pgc-strip--running/);
});

test('状态二：思考文本命中规则表 → 正在读取配置文件', () => {
  const view = render({
    partial: {
      turn: 3,
      step: 1,
      blocks: [{ kind: 'reasoning', text: '我先读取配置文件 package.json，看看入口在哪' }],
    },
    runningCalls: [],
    nodes: [],
  });
  const shown = text(view);
  // step 是 1 起：传 1 就显示「第 1 步」（真实宿主不会发 step: 0）。
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

test('写回答时不会再收成齿轮：factsOnly 已删，写回答一律常驻', () => {
  // 老存档里可能还留着 factsOnly:true —— 这个字段已经整项删掉，
  // 传进来也必须被无视：写回答时就该显示「正在组织回答」，而不是收起来。
  const view = __test.deriveCaption({
    partial: { turn: 7, step: 0, blocks: [{ kind: 'text', text: '结论如下……' }] },
    runningCalls: [],
    nodes: [],
    factsOnly: true,
  });
  assert.ok(view, '写回答时不许再因为老字段而收起来');
  assert.equal(view.state, 'writing');
  assert.match(view.key, /^write:/);
});

/* ---------------- 设置与俏皮词（纯逻辑，不依赖 React） ---------------- */

const { __test } = mod;

test('设置：坏值一律兜底回默认，删掉的档位折回默认档', () => {
  assert.deepEqual(__test.normalizeSettings(null), __test.DEFAULT_SETTINGS);
  assert.deepEqual(__test.normalizeSettings({ size: 'xxl', subLine: 'yes', anim: 'boom', shape: 'donut', words: 'yes' }), {
    size: 'm', subLine: true, anim: 'calm', motion: 'plain', words: true,
    accent: 'theme', accentCustom: '#4d6bfe', flavorStyle: 'tint',
  });
  // 老存档兼容：anim:'off'（全静止档已删）与 flavorStyle:'plain'（素色档已删）
  // 都是非法值，一律折回默认档，而不是原样带进运行期。
  assert.deepEqual(__test.normalizeSettings({ size: 'l', subLine: true, anim: 'off', words: false }), {
    size: 'l', subLine: true, anim: 'calm', motion: 'plain', words: false,
    accent: 'theme', accentCustom: '#4d6bfe', flavorStyle: 'tint',
  });
  assert.equal(__test.normalizeSettings({ flavorStyle: 'plain' }).flavorStyle, 'tint', '素色档折回渐隐');
  // 删掉的字段不再出现在结果里，老存档带进来也不会被读。
  const normalized = __test.normalizeSettings({ okColor: 'red', badColor: 'teal', factsOnly: true });
  for (const gone of ['okColor', 'badColor', 'factsOnly']) {
    assert.equal(gone in normalized, false, gone + ' 已彻底移除');
  }
  // 老存档里那个 shape 字段不再读：形态只有一种，存进来也不认。
  assert.equal('shape' in __test.normalizeSettings({ shape: 'orbit' }), false, 'shape 已彻底移除');
  // 老存档兼容：lines: 3 等价于 subLine: true；lines: 1 等价于 false。
  assert.equal(__test.normalizeSettings({ lines: 3 }).subLine, true);
  assert.equal(__test.normalizeSettings({ lines: 1 }).subLine, false);
  assert.equal(__test.normalizeSettings({ subLine: false, lines: 3 }).subLine, false, '新字段优先');
});

test('设置：没有 localStorage 也不崩', () => {
  assert.deepEqual(__test.readSettings(), __test.DEFAULT_SETTINGS);
  assert.doesNotThrow(() => __test.writeSettings({ size: 's', subLine: true, anim: 'dots', words: false }));
});

test('配色：选了主色才挂变量，跟随主题时一个都不挂，成功 / 失败色不再由用户决定', () => {
  // 跟随主题：不注入变量，CSS 会自己退回 --dsw-alias-* 主题色
  assert.deepEqual(__test.stripVars({ accent: 'theme' }), {});
  const vars = __test.stripVars({ accent: 'ds' });
  assert.equal(vars['--pgc-accent'], '#4d6bfe');
  assert.equal(vars['--pgc-ok'], undefined, '成功色不再由设置注入，走主题变量');
  assert.equal(vars['--pgc-bad'], undefined, '失败色同理');
  assert.deepEqual(Object.keys(vars), ['--pgc-accent'], '除主色外一个变量都不挂');
  // 表里没有的键一律当「跟随主题」，不抛异常
  assert.deepEqual(__test.stripVars({ accent: 'nope' }), {});
  // 自定义：只认合法 #rrggbb，乱填的一律不挂变量
  assert.deepEqual(__test.stripVars({ accent: 'custom', accentCustom: '#12ab34' }), { '--pgc-accent': '#12ab34' });
  assert.deepEqual(__test.stripVars({ accent: 'custom', accentCustom: 'red; behavior:url(x)' }), {});
  assert.deepEqual(__test.stripVars({ accent: 'custom' }), {});
});

test('配色：三项预设（跟随主题 / DS 蓝 / Claude 橙）加一项自定义', () => {
  const accents = __test.ACCENTS;
  assert.deepEqual(Object.keys(accents), ['theme', 'ds', 'claude', 'custom'], '预设三个 + 自定义一个');
  assert.equal(accents.theme.value, '', '跟随主题不写死色值');
  assert.equal(accents.ds.value, '#4d6bfe', 'DS 蓝');
  assert.equal(accents.claude.value, '#d97757', 'Claude 橙');
  assert.equal(accents.custom.value, '', '自定义的颜色来自设置，不写在表里');
  for (const key of ['ds', 'claude']) assert.match(accents[key].value, /^#[0-9a-f]{6}$/i);
});

test('取色方框：HSL 转出来的都是合法 #rrggbb', () => {
  for (const hue of [0, 60, 120, 200, 300, 359]) {
    for (const light of [0.2, 0.5, 0.9]) {
      assert.match(__test.hslToHex(hue, 0.86, light), /^#[0-9a-f]{6}$/i);
    }
  }
  assert.equal(__test.hslToHex(0, 1, 0.5), '#ff0000', '纯红');
  assert.equal(__test.hslToHex(120, 1, 0.5), '#00ff00', '纯绿');
});

test('设置面板：不再有「长什么样 / 颜色 / 说什么」分组标题，改成一行一个设置', () => {
  const view = render({
    partial: { turn: 1, step: 0, blocks: [{ kind: 'reasoning', text: '看看配置' }] },
    runningCalls: [],
    nodes: [],
  });
  const shown = text(view);
  // 三排大字分组标题按用户要求整段撤掉：分组关系交给行间的 .5px 细分隔线。
  assert.doesNotMatch(shown, /长什么样/, '分组标题「长什么样」应已移除');
  assert.doesNotMatch(shown, /说什么/, '分组标题「说什么」应已移除');
  // 「颜色」这个词只剩「字幕条颜色」这一行标题里还有，不能单独作为分组标题出现。
  assert.doesNotMatch(shown, /\s颜色\s/, '分组标题「颜色」应已移除');
  assert.match(shown, /字幕条颜色/, '主色那一行还在');

  const dict = dictionaries.get('dshProgressCaption');
  for (const gone of ['groupLook', 'groupColor', 'groupSay']) {
    assert.equal(dict.zh[gone], undefined, 'zh 字典里不许再有 ' + gone);
    assert.equal(dict.en[gone], undefined, 'en 字典里不许再有 ' + gone);
  }
  // 面板里也不许再有 pgc-group 节点（哪怕文本为空，只要结构还在就算没删干净）。
  const groupNodes = [];
  const scan = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.props && typeof node.props.className === 'string'
      && node.props.className.split(/\s+/).includes('pgc-group')) groupNodes.push(node);
    (node.children || []).forEach(scan);
  };
  scan(view);
  assert.equal(groupNodes.length, 0, 'pgc-group 节点应已从面板里删掉');
  // 「跑成功时 / 跑失败时」两项按用户要求删掉：成功失败一律跟主题走。
  assert.doesNotMatch(shown, /跑成功时/);
  assert.doesNotMatch(shown, /跑失败时/);
  // 俏皮词样式两选一，素色档没了
  assert.match(shown, /渐隐/);
  assert.match(shown, /实心/);
  assert.doesNotMatch(shown, /素色/);
});

test('配色选中后会写回 root 的 style，且 class 带上俏皮词样式', () => {
  const previous = globalThis.localStorage;
  // 老存档里的 violet / teal / orange 都已删：非法值折回「跟随主题」，不注入任何变量。
  globalThis.localStorage = {
    getItem: () => JSON.stringify({ accent: 'claude', okColor: 'teal', badColor: 'orange', flavorStyle: 'solid' }),
    setItem: () => {},
  };
  try {
    const view = render({
      partial: { turn: 1, step: 0, blocks: [{ kind: 'reasoning', text: '看看配置' }] },
      runningCalls: [],
      nodes: [],
    });
    assert.equal(view.props.style['--pgc-accent'], '#d97757');
    assert.equal(view.props.style['--pgc-ok'], undefined, '成功色不再写内联变量');
    assert.equal(view.props.style['--pgc-bad'], undefined, '失败色不再写内联变量');
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
  // 底部那两行小字（本地保存说明 + 免责声明）已按用户要求删掉，但免责声明
  // 仍挂在字幕条根节点的 title 上（悬停能看到），所以字典键要留着。
  assert.ok(!classes.some((name) => name === 'pgc-sheet-note'), '面板底部说明已删');
  const root = render({
    partial: { turn: 2, step: 0, blocks: [{ kind: 'reasoning', text: '看看配置' }] },
    runningCalls: [],
    nodes: [],
  });
  assert.equal(root.props.title, '字幕由规则推断，不代表模型真实意图', '免责声明转移到根节点 title');
  const dict = dictionaries.get('dshProgressCaption');
  assert.equal(dict.zh.disclaimer, '字幕由规则推断，不代表模型真实意图', '字典键必须保留');
  assert.equal(dict.zh.sheetNote, undefined, 'sheetNote 字典键已删');
});

test('设置行是「左标题 + 右控件」两栏，行间靠 .5px 细分隔线分段', () => {
  const view = render({
    partial: { turn: 2, step: 0, blocks: [{ kind: 'reasoning', text: '看看配置' }] },
    runningCalls: [],
    nodes: [],
  });

  // 结构：每一行都是 .pgc-set-row，里面左边一坨 .pgc-set-text（标题 + 可选说明），
  // 右边是控件本体。照官方 / Claude 设置页那条 row 来的。
  const rows = [];
  const scanRows = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.props && typeof node.props.className === 'string'
      && node.props.className.split(/\s+/).includes('pgc-set-row')) rows.push(node);
    (node.children || []).forEach(scanRows);
  };
  scanRows(view);
  assert.equal(rows.length, 7, '面板正好七行设置（字号 / 动画 / 状态标记 / 字幕条颜色 / 俏皮词样子 / 显示俏皮词 / 思考原话）');
  rows.forEach((row, index) => {
    const hasText = (row.children || []).some((child) => child
      && child.props && typeof child.props.className === 'string'
      && child.props.className.split(/\s+/).includes('pgc-set-text'));
    assert.ok(hasText, '第 ' + index + ' 行缺左边的标题列');
  });

  // 说明必须只有两行（状态标记 + 思考原话），且都不超过一句。
  const descs = [];
  const scanDesc = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.props && typeof node.props.className === 'string'
      && node.props.className.split(/\s+/).includes('pgc-set-desc')) descs.push(text(node));
    (node.children || []).forEach(scanDesc);
  };
  scanDesc(view);
  assert.equal(descs.length, 2, '只有两行带小字说明');
  descs.forEach((desc) => assert.ok(desc.trim().length > 0, '说明不许是空的'));

  // CSS：分组标题的样式整段删掉；行用 .5px 上边线分隔，首行不要线。
  assert.doesNotMatch(sheet, /\.pgc-group\b/, '.pgc-group 样式应已删除');
  const rowRule = /\.pgc-set-row \{([\s\S]*?)\}/.exec(sheet);
  assert.ok(rowRule, '要有 .pgc-set-row 规则');
  assert.match(rowRule[1], /display: flex/, '两栏就是 flex 一行');
  assert.match(rowRule[1], /justify-content: space-between/, '标题在左、控件在右');
  assert.match(rowRule[1], /align-items: center/, '垂直居中');
  assert.match(rowRule[1], /padding: 10px 0/, '弹层比整页设置紧凑，行内边距 10px 0');
  assert.match(rowRule[1], /border-top: \.5px solid var\(--dsw-alias-border-l2, color-mix\(in srgb, currentColor 12%, transparent\)\)/,
    '行与行之间是 .5px 细分隔线');
  assert.match(sheet, /\.pgc-set-row:first-child \{ border-top: 0;/, '首行不要上边线');
  const nameRule = /\.pgc-set-name \{([\s\S]*?)\}/.exec(sheet);
  assert.ok(nameRule, '要有 .pgc-set-name');
  assert.match(nameRule[1], /font-size: 12\.5px/, '标题 12.5px');
  const descRule = /\.pgc-set-desc \{([\s\S]*?)\}/.exec(sheet);
  assert.ok(descRule, '要有 .pgc-set-desc');
  assert.match(descRule[1], /font-size: 11px/, '说明 11px');
  // 控件尺寸统一：分段按钮 11px / 3px 8px，开关轨道 30×18，色块 18px。
  const segBtn = /\.pgc-seg-btn \{([\s\S]*?)\}/.exec(sheet);
  assert.match(segBtn[1], /padding: 3px 8px/, '分段按钮内边距 3px 8px');
  assert.match(segBtn[1], /font-size: 11px/, '分段按钮字号 11px');
  const track = /\.pgc-switch-track \{([\s\S]*?)\}/.exec(sheet);
  assert.match(track[1], /width: 30px; height: 18px/, '开关轨道 30×18');
  const swatch = /\.pgc-swatch \{([\s\S]*?)\}/.exec(sheet);
  assert.match(swatch[1], /width: 18px; height: 18px/, '色块 18px');
  // 控件贴右；窄屏（<280px）换行后改贴左。
  assert.match(sheet, /\.pgc-set-row > \.pgc-seg,\n\.pgc-set-row > \.pgc-switch,\n\.pgc-set-row > \.pgc-swatches \{ flex: 0 0 auto; margin-left: auto; \}/,
    '控件贴右');
  assert.match(sheet, /@media \(max-width: 280px\) \{[\s\S]*?margin-left: 0;[\s\S]*?\}/, '窄屏控件改贴左');

  // 面板外框：还是毛玻璃，宽度上限 300px，头部保留标题 + ✕。
  const sheetRule = /\.pgc-sheet \{([\s\S]*?)\n\}/.exec(sheet);
  assert.match(sheetRule[1], /width: 300px/, '宽度上限 300px');
  assert.match(sheetRule[1], /background: var\(--dsw-alias-bg-overlay/, '毛玻璃底色沿用主题浮层');
  assert.match(sheetRule[1], /backdrop-filter: blur/, '毛玻璃');
  assert.match(view.props.className, /pgc-strip/);
  const classes = [];
  const scanClass = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.props && typeof node.props.className === 'string') classes.push(node.props.className);
    (node.children || []).forEach(scanClass);
  };
  scanClass(view);
  assert.ok(classes.some((name) => name === 'pgc-sheet-head'), '头部还在');
  assert.ok(classes.some((name) => name === 'pgc-sheet-title'), '标题还在');
  assert.ok(classes.some((name) => name === 'pgc-sheet-close'), '✕ 还在');
  // 底部不再有任何小字。
  assert.ok(!classes.some((name) => name === 'pgc-sheet-note'), '底部说明已删');
  assert.doesNotMatch(sheet, /\.pgc-sheet-note\b/, '底部说明的样式也删了');

  // 合成层约束与动效降级：面板过渡在 reduced-motion 下一并关掉。
  const reducedBlock = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/.exec(sheet);
  assert.ok(reducedBlock, '要有 reduced-motion 兜底');
  assert.match(reducedBlock[1], /\.pgc-sheet, \.pgc-sheet \* \{ animation: none !important; transition: none !important; \}/,
    '系统开了减少动效时，面板的过渡也要停');
  // 只动合成层属性：面板里出现的过渡/动画属性不许碰宽高。
  const panelCss = sheet.slice(sheet.indexOf('.pgc-sheet {'), sheet.indexOf('.pgc-strip--handle .pgc-sheet'));
  assert.doesNotMatch(panelCss, /animation: [^;]*\b(width|height)\b/, '面板不许动画宽高');
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
  // 「没线索时」整项按用户要求删掉：不读思考文本这条岔路没了，也就没有这个设置。
  assert.doesNotMatch(shown, /没线索时/, '没线索时设置项应已移除');
  assert.doesNotMatch(shown, /只报动作|猜一猜|猜错很正常/, '它下面的选项和说明也一起删');
  assert.match(shown, /扫光/);
  assert.match(shown, /安静/);
  // 「全静止」这一档按用户要求删掉，只剩安静 / 扫光；样式里的兜底规则仍在（另有测试守着）。
  assert.doesNotMatch(shown, /全静止/, '动画只剩安静 / 扫光两档');
  // 形态选择器已整段撤掉：状态标记只有一种（三点接力跳），不再让用户挑。
  assert.doesNotMatch(shown, /进行中的标记/);
  assert.doesNotMatch(shown, /横扫|转圈|立体/);
  assert.match(view.props.className, /pgc-size-m/);
  assert.match(view.props.className, /pgc-anim-calm/);
  assert.doesNotMatch(view.props.className, /pgc-shape-/);
});

test('「没线索时」已整项删除：字典键与面板行都不许回来', () => {
  const dict = dictionaries.get('dshProgressCaption');
  for (const gone of ['facts', 'factsTools', 'factsThinking', 'factsHint']) {
    assert.equal(dict.zh[gone], undefined, 'zh 里不许再有 ' + gone);
    assert.equal(dict.en[gone], undefined, 'en 里不许再有 ' + gone);
  }
  // 老存档里可能还存着 factsOnly:true —— 这个字段已经不读了，
  // 面板照常渲染，思考文本照常按规则表猜。
  const previous = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: () => JSON.stringify({ factsOnly: true }),
    setItem: () => {},
  };
  try {
    const view = render({
      partial: { turn: 2, step: 0, blocks: [{ kind: 'reasoning', text: '我先读取配置文件 package.json' }] },
      runningCalls: [],
      nodes: [],
    });
    const shown = text(view);
    assert.doesNotMatch(shown, /没线索时/);
    assert.match(shown, /(正在读取配置文件|翻一下配置文件|看看配置里怎么写的|对一下配置项)/,
      '老字段不再能关掉「读思考文本猜一句」');
  } finally {
    if (previous === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previous;
  }
});

test('状态标记：默认是经典三点，打开 Claude 三态才换成三种轮着放', () => {
  const busy = {
    partial: { turn: 2, step: 0, blocks: [{ kind: 'reasoning', text: '看看配置' }] },
    runningCalls: [],
    nodes: [],
  };
  const shapeOf = (view) => {
    let found = null;
    const walk = (node) => {
      if (!node || typeof node !== 'object') return;
      if (node.props && node.props.className === 'pgc-loader') found = node.props['data-pgc-shape'];
      (node.children || []).forEach(walk);
    };
    walk(view);
    return found;
  };

  // 默认：不认 Claude 三态，形态名写死 plain。
  assert.equal(shapeOf(render(busy)), 'plain', '默认走经典三点');

  // 打开之后，形态取自 CLAUDE_SHAPES（弹跳 / 斜线 / 绕圈）。
  const previous = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: () => JSON.stringify({ motion: 'claude' }),
    setItem: () => {},
  };
  try {
    const shape = shapeOf(render(busy));
    assert.ok(['bounce', 'line', 'orbit'].includes(shape), '要落在 Claude 的三种形态里，而不是 plain');
  } finally {
    if (previous === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previous;
  }
});

test('Claude 三态的关键帧都齐：弹跳 / 斜线 / 四条绕圈轨道', () => {
  assert.match(sheet, /@keyframes pgc-dot-line \{/, '要有斜线轨道');
  for (const n of [1, 2, 3, 4]) {
    assert.match(sheet, new RegExp('@keyframes pgc-dot-orbit-' + n + ' \{'), '绕圈要有第 ' + n + ' 条轨道');
  }
  // 名里不许出现 pgc-shape-：那是被删掉的三套形态留下的禁区。
  assert.doesNotMatch(sheet, /pgc-shape-/, '三套形态已删，绕圈轨道用 pgc-dot-orbit-* 命名');
  // 三条轨道各按 1/4 相位分给四颗点，顺序与 Claude 源码一致：2→2、3→4、4→3。
  assert.match(sheet, /\[data-pgc-shape="orbit"\] \.pgc-dot:nth-child\(2\)[^{]*\{[^}]*pgc-dot-orbit-2/, '第二颗走 orbit-2');
  assert.match(sheet, /\[data-pgc-shape="orbit"\] \.pgc-dot:nth-child\(3\)[^{]*\{[^}]*pgc-dot-orbit-4/, '第三颗走 orbit-4');
  assert.match(sheet, /\[data-pgc-shape="orbit"\] \.pgc-dot:nth-child\(4\)[^{]*\{[^}]*pgc-dot-orbit-3/, '第四颗走 orbit-3');
  // 第四颗只有绕圈用得上，其它形态必须藏起来，否则会多出一颗不动的点。
  assert.match(sheet, /\.pgc-loader:not\(\[data-pgc-shape="orbit"\]\) \.pgc-dot:nth-child\(4\) \{ display: none; \}/,
    '非绕圈形态藏起第四颗');
});

test('绕圈轨道要采得够密：每半圈都有中间点，否则那颗点会横穿中心', () => {
  for (const n of [1, 2, 3, 4]) {
    const rule = new RegExp('@keyframes pgc-dot-orbit-' + n + ' \\{([\\s\\S]*?)\\n\\}').exec(sheet);
    assert.ok(rule, '找不到第 ' + n + ' 条绕圈轨道');
    const body = rule[1];
    // 只在起点和终点各写一个坐标时，浏览器在两点之间走直线 ——
    // 那条直线穿过椭圆中心，视觉上就是「有一颗点转得不对、斜着横穿」。
    const stops = body.match(/translate:/g) || [];
    assert.ok(stops.length >= 8,
      '第 ' + n + ' 条轨道只有 ' + stops.length + ' 个采样点，太稀，会在椭圆的直边上抄近路');
    // 采样点要真的贴着椭圆跑：四个极值都得用到（每条轨道走的是斜对的两个角）。
    assert.match(body, /-4\.75px/, '第 ' + n + ' 条要到得了左端');
    assert.match(body, /4\.75px/, '第 ' + n + ' 条要到得了右端');
    assert.match(body, /-5\.8px/, '第 ' + n + ' 条要到得了上端');
    assert.match(body, /5\.8px/, '第 ' + n + ' 条要到得了下端');
    // 绕圈只能动 translate，不许改尺寸或定位，否则每帧都要重排。
    assert.doesNotMatch(body, /\b(width|height|margin|padding|top|left|right|bottom):/,
      '第 ' + n + ' 条只许动 translate');
  }
});

test('设置面板里「状态标记」是开关：关=经典三点，开=Claude 三态', () => {
  const view = render({
    partial: { turn: 2, step: 0, blocks: [{ kind: 'reasoning', text: '看看配置' }] },
    runningCalls: [],
    nodes: [],
  });
  const shown = text(view);
  assert.match(shown, /状态标记/, '要有这一行');

  // 找到「状态标记」那一行，看它右边挂的是什么控件。
  let row = null;
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.props && node.props.className === 'pgc-set-row' && text(node).includes('状态标记')) row = node;
    (node.children || []).forEach(walk);
  };
  walk(view);
  assert.ok(row, '找到状态标记那一行');

  const rowClasses = [];
  const collect = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.props && typeof node.props.className === 'string') rowClasses.push(node.props.className);
    (node.children || []).forEach(collect);
  };
  collect(row);
  assert.ok(rowClasses.some((c) => c.split(/\s+/).includes('pgc-switch')), '这一行是开关，不是分段选择');
  assert.ok(!rowClasses.includes('pgc-seg'), '分段控件不许留下');
  const switchProps = [];
  const grabSwitch = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.props && typeof node.props.className === 'string'
      && node.props.className.split(/\s+/).includes('pgc-switch')) switchProps.push(node.props);
    (node.children || []).forEach(grabSwitch);
  };
  grabSwitch(row);
  assert.equal(switchProps.length, 1, '一个开关就够，不用并列两个按钮');
  assert.equal(switchProps[0].role, 'switch', '读屏要念成开关');
  assert.equal(switchProps[0]['aria-checked'], 'false', '默认关着＝经典三点');

  // 开关标签随开关状态换：关着写「经典三点」，打开写「Claude 三态」。
  assert.match(shown, /经典三点/);

  // 说明不再单独占一段（原来那行 .pgc-sheet-hint 已删），改成行内的一行小字：
  // 挂在「状态标记」那一行的左标题下面，形态是 .pgc-set-desc。
  const hints = [];
  const grabHint = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.props && typeof node.props.className === 'string'
      && node.props.className.split(/\s+/).includes('pgc-set-desc')) hints.push(text(node));
    (node.children || []).forEach(grabHint);
  };
  grabHint(view);
  assert.equal(hints.length, 2, '面板里只有两行带说明：状态标记 + 思考原话');
  const motionHint = hints.find((hint) => hint.includes('Claude'));
  assert.ok(motionHint, '状态标记那一行要有说明');
  assert.ok(!motionHint.includes('每 6 秒'), '把轮换间隔这类细节从说明里撤掉');
  assert.equal(motionHint.split('。').filter(Boolean).length, 1, '说明精简到一句以内');

  // 原来的独立说明段落（.pgc-sheet-hint）不许留下来——它已经并进行里了。
  const stray = [];
  const grabStray = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.props && typeof node.props.className === 'string'
      && node.props.className.split(/\s+/).includes('pgc-sheet-hint')) stray.push(node);
    (node.children || []).forEach(grabStray);
  };
  grabStray(view);
  assert.equal(stray.length, 0, '独立说明段落已并入设置行');
  // 说明必须挂在紧挨开关的那一行里，不能飘到面板别处。
  const motionRow = [];
  const grabRow = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.props && node.props.className === 'pgc-set-row' && text(node).includes('状态标记')) motionRow.push(node);
    (node.children || []).forEach(grabRow);
  };
  grabRow(view);
  assert.equal(motionRow.length, 1);
  const descInRow = [];
  const grabDescInRow = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.props && typeof node.props.className === 'string'
      && node.props.className.split(/\s+/).includes('pgc-set-desc')) descInRow.push(text(node));
    (node.children || []).forEach(grabDescInRow);
  };
  grabDescInRow(motionRow[0]);
  assert.equal(descInRow.length, 1, '状态标记这一行里恰好一行说明');

  // 打开之后，标签换成 Claude 三态，开关状态也跟着翻。
  const previous = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: () => JSON.stringify({ motion: 'claude' }),
    setItem: () => {},
  };
  try {
    const onView = render({
      partial: { turn: 2, step: 0, blocks: [{ kind: 'reasoning', text: '看看配置' }] },
      runningCalls: [],
      nodes: [],
    });
    assert.match(text(onView), /Claude 三态/, '打开后标签换成 Claude 三态');
    // 只认「状态标记」那一行里的开关：面板上还有别的开关，不能抓到最后一个。
    let onRow = null;
    const findRow = (node) => {
      if (!node || typeof node !== 'object') return;
      if (node.props && node.props.className === 'pgc-set-row' && text(node).includes('状态标记')) onRow = node;
      (node.children || []).forEach(findRow);
    };
    findRow(onView);
    assert.ok(onRow, '找到打开状态下的状态标记那一行');
    let onSwitch = null;
    const findOn = (node) => {
      if (!node || typeof node !== 'object') return;
      if (node.props && typeof node.props.className === 'string'
        && node.props.className.split(/[ 	]+/).includes('pgc-switch')) onSwitch = node.props;
      (node.children || []).forEach(findOn);
    };
    findOn(onRow);
    assert.ok(onSwitch, '这一行里有开关');
    assert.equal(onSwitch['aria-checked'], 'true', '开关处于打开态');
    assert.equal(onSwitch['data-on'], 'true');
  } finally {
    if (previous === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previous;
  }
});

test('状态标记开关不位移：标签定宽，换文案时轨道不跳', () => {
  const view = render({
    partial: { turn: 2, step: 0, blocks: [{ kind: 'reasoning', text: '看看配置' }] },
    runningCalls: [],
    nodes: [],
  });
  const switches = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.props && typeof node.props.className === 'string'
      && node.props.className.split(/[ 	]+/).includes('pgc-switch')) switches.push(node.props.className);
    (node.children || []).forEach(walk);
  };
  walk(view);
  assert.ok(switches.includes('pgc-switch pgc-switch--wide'), '状态标记那颗开关带定宽类');
  assert.equal(switches.filter((c) => c.includes('pgc-switch--wide')).length, 1, '只有它需要定宽');
  assert.match(sheet, /\.pgc-switch--wide \.pgc-switch-label \{ min-width: [0-9.]+em/, '标签定宽，换文案时轨道不左右跳');
});

test('自定义取色：选了「自定义」才出现渐变方框，平时不占地方', () => {
  const previous = globalThis.localStorage;
  const base = {
    partial: { turn: 2, step: 0, blocks: [{ kind: 'reasoning', text: '看看配置' }] },
    runningCalls: [],
    nodes: [],
  };
  const findPicker = (node, found) => {
    if (!node || typeof node !== 'object') return found;
    if (node.props && typeof node.props.className === 'string'
      && node.props.className.split(/[ 	]+/).includes('pgc-picker')) found.push(node);
    (node.children || []).forEach((child) => findPicker(child, found));
    return found;
  };
  try {
    globalThis.localStorage = { getItem: () => JSON.stringify({ accent: 'ds' }), setItem: () => {} };
    const plain = findPicker(render(base), []);
    assert.equal(plain.length, 0, '没选自定义时不该有取色框');
  } finally {
    if (previous === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previous;
  }
  const previous2 = globalThis.localStorage;
  try {
    globalThis.localStorage = {
      getItem: () => JSON.stringify({ accent: 'custom', accentCustom: '#12ab34' }),
      setItem: () => {},
    };
    const view = render(base);
    const picked = findPicker(view, []);
    assert.equal(picked.length, 1, '选了自定义才出现取色方框');
    assert.equal(picked[0].props.role, 'slider', '读屏把它当作可拖动的取色器');
    assert.equal(picked[0].props['aria-valuetext'], '#12ab34', '当前颜色要念出来');
    assert.equal(view.props.style['--pgc-accent'], '#12ab34', '自定义色写进根节点变量');
  } finally {
    if (previous2 === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previous2;
  }
});

test('一条字幕只留一个东西在动：俏皮词在场时，右边那圈弧线让位', () => {
  const busy = {
    partial: { turn: 2, step: 0, blocks: [{ kind: 'reasoning', text: '我先读取配置文件 package.json' }] },
    runningCalls: [],
    nodes: [],
  };

  const withFlavor = render(busy);
  assert.match(withFlavor.props.className, /pgc-strip--hasflavor/, '有俏皮词时要挂上「让位」标记');

  // 关掉「显示俏皮词」之后弧线应该回来接着转。
  const previous = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: () => JSON.stringify({ words: false }),
    setItem: () => {},
  };
  try {
    const noFlavor = render(busy);
    assert.doesNotMatch(noFlavor.props.className, /pgc-strip--hasflavor/, '没有俏皮词就不该让位');
  } finally {
    if (previous === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previous;
  }

  // 让位不是「藏起来但还在转」：位置收掉、透明度归零、并且真的停转。
  const rule = /\.pgc-strip--hasflavor \.pgc-slot \{([\s\S]*?)\}/.exec(sheet);
  assert.ok(rule, '要有让位规则');
  assert.match(rule[1], /width: 0/, '宽度要收掉，不然右边会留一个洞');
  assert.match(rule[1], /opacity: 0/);
  assert.match(rule[1], /pointer-events: none/);
  assert.match(sheet, /\.pgc-strip--hasflavor \.pgc-slot \.pgc-arc > span \{ animation: none; \}/,
    '让位时弧线必须停转，两个东西同时动才是「互抢」');
  const slot = /\.pgc-slot \{([\s\S]*?)\}/.exec(sheet);
  assert.match(slot[1], /transition:/, '收起来要是渐变的，别啪一下少一块');
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

test('状态标记是三点装载器，装在 .pgc-loader 里，不靠文字徽标', () => {
  const view = render({
    partial: { turn: 1, step: 0, blocks: [{ kind: 'reasoning', text: '先看看 package.json' }] },
    runningCalls: [],
    nodes: [],
  });
  const loaders = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.props && node.props.className === 'pgc-loader') loaders.push(node);
    (node.children || []).forEach(walk);
  };
  walk(view);
  assert.equal(loaders.length, 1, '标记要装在一个 .pgc-loader 里，方便整体对齐');
  const collected = [];
  const collect = (node, isRoot) => {
    if (!node || typeof node !== 'object') return;
    if (!isRoot && node.props && typeof node.props.className === 'string') collected.push(node.props.className);
    (node.children || []).forEach((child) => collect(child, false));
  };
  collect(loaders[0], true);
  assert.equal(typeof loaders[0].props['data-pgc-shape'], 'string', '形态名挂在 data-pgc-shape 上，由 CSS 分配动画');
  assert.deepEqual(collected.sort(), ['pgc-dot', 'pgc-dot', 'pgc-dot', 'pgc-dot'],
    '四颗点常驻：弹跳/斜线用前三颗，绕圈用四颗（多的那颗由 CSS 藏起来）');
});

test('工具参数 → 只显示文件名 / 搜索词，不显示整段 JSON', () => {
  assert.equal(__test.toolTarget({ argsRaw: '{"path":"E:/deepseek/插件/plugins/client.js"}' }), 'client.js');
  assert.equal(__test.toolTarget({ argsRaw: '{"pattern":"deriveCaption"}' }), 'deriveCaption');
  assert.equal(__test.toolTarget({ argsRaw: '{}' }), '');
  assert.equal(__test.toolTarget({}), '');
  // 已结算的结果：argsRaw 在 call 里（窗口截断时可能没有）
  assert.equal(__test.toolTarget({ call: { name: 'read', argsRaw: '{"path":"E:/a/b.js"}' } }), 'b.js');
  // 各家工具的路径字段叫法不同，都只留文件名。
  assert.equal(__test.toolTarget({ argsRaw: '{"file_path":"E:/a/b/client.js"}' }), 'client.js');
  assert.equal(__test.toolTarget({ argsRaw: '{"files":["E:/a/b/one.md","E:/a/b/two.md"]}' }), 'one.md');
  assert.equal(__test.toolTarget({ argsRaw: '{"notebook_path":"E:/a/nb/plan.ipynb"}' }), 'plan.ipynb');
  // 工具自带的自然语言描述：本身就是人话，截断后直接用。
  assert.equal(__test.toolTarget({ argsRaw: '{"description":"审查设置面板"}' }), '审查设置面板');
  // 顺序不许乱：命令 > path > file_path。同一份参数里同时有时，取更靠前的那个。
  assert.equal(__test.toolTarget({ argsRaw: '{"command":"npm test","path":"E:/a/b.js"}' }), 'npm test');
  assert.equal(__test.toolTarget({ argsRaw: '{"path":"E:/a/b.js","file_path":"E:/c/d.js"}' }), 'b.js');
});

test('动作人话：不同工具组用不同的动词，完成态换完成动词', () => {
  assert.equal(__test.actionText('bash', 'npm test', 'running'), '正在执行命令 npm test');
  assert.equal(__test.actionText('bash', 'npm test', 'ok'), '跑完命令 npm test');
  assert.equal(__test.actionText('read', 'client.js', 'running'), '正在读取 client.js');
  assert.equal(__test.actionText('read', 'client.js', 'ok'), '读完了 client.js');
  assert.equal(__test.actionText('write', 'a.js', 'running'), '正在写入 a.js');
  assert.equal(__test.actionText('edit', 'a.js', 'ok'), '改好了 a.js');
  assert.equal(__test.actionText('subagent', '审查', 'running'), '派了小助手 审查');
  // 以前这些高频工具全掉进 'other'，只能把工具名直接糊进句子（「正在执行 mnemon_recall」）。
  assert.equal(__test.actionText('mnemon_recall', '', 'running'), '正在翻记忆');
  assert.equal(__test.actionText('read_image', 'a.png', 'running'), '正在读取 a.png');
  assert.equal(__test.actionText('present', '', 'running'), '正在出交付物');
  assert.equal(__test.actionText('todo_write', '', 'ok'), '理好计划');
  // 真的没归类的才落到 other。
  assert.equal(__test.actionText('cordis_inspect_query', '', 'running'), '正在执行 cordis_inspect_query');
});

test('拿不到对象时补兜底名词，不留「正在读取 」这种半句', () => {
  // 动词本身不完整 → 补名词。
  assert.equal(__test.actionText('read', '', 'running'), '正在读取文件');
  assert.equal(__test.actionText('write', '', 'running'), '正在写入文件');
  assert.equal(__test.actionText('edit', '', 'running'), '正在编辑文件');
  assert.equal(__test.actionText('grep', '', 'running'), '正在搜索代码');
  // 动词里已经含着名词 → 不重复第二次。
  assert.equal(__test.actionText('bash', '', 'running'), '正在执行命令');
  assert.equal(__test.actionText('web_search', '', 'running'), '正在搜网络资料');
  assert.equal(__test.actionText('subagent', '', 'running'), '派了小助手');
  // 完成态自己就能成句，不补名词。
  assert.equal(__test.actionText('read', '', 'ok'), '读完了');
  assert.equal(__test.actionText('write', '', 'ok'), '写好了');
  // 末尾不许带空格。
  for (const tool of ['read', 'write', 'edit', 'grep', 'web_search', 'bash', 'mnemon_recall', 'present']) {
    assert.equal(__test.actionText(tool, '', 'running'), __test.actionText(tool, '', 'running').trim(),
      tool + ' 的空对象文案末尾不许有空格');
  }
});

test('细粒度状态：主文案带上具体对象（读哪个文件 / 跑哪条命令）', () => {
  // ① read 工具带 path → 「正在读取 client.js」。
  const reading = render({
    partial: { turn: 1, step: 2, blocks: [] },
    runningCalls: [({
      callId: 'c1', name: 'read', step: 2, time: Date.now() - 800,
      argsRaw: '{"path":"E:/a/b/client.js"}',
    })],
    nodes: [],
  });
  assert.match(text(reading), /正在读取 client\.js/);
  // ② bash 带 command → 「正在执行命令 npm test」。
  const running = render({
    partial: { turn: 1, step: 2, blocks: [] },
    runningCalls: [({
      callId: 'c2', name: 'bash', step: 2, time: Date.now() - 800,
      argsRaw: '{"command":"npm test"}',
    })],
    nodes: [],
  });
  assert.match(text(running), /正在执行命令 npm test/);
  // ③ 只有 file_path 没有 path → 同样取到文件名。
  const viaFilePath = render({
    partial: { turn: 1, step: 2, blocks: [] },
    runningCalls: [({
      callId: 'c3', name: 'edit', step: 2, time: Date.now() - 800,
      argsRaw: '{"file_path":"E:/a/b/README.md"}',
    })],
    nodes: [],
  });
  assert.match(text(viaFilePath), /正在编辑 README\.md/);
  // ④ 完全没参数 → 「正在读取文件」，不是末尾带空格的「正在读取 」。
  const noArgs = render({
    partial: { turn: 1, step: 2, blocks: [] },
    runningCalls: [({ callId: 'c4', name: 'read', step: 2, time: Date.now() - 800, argsRaw: '{}' })],
    nodes: [],
  });
  assert.match(text(noArgs), /正在读取文件/);
  assert.doesNotMatch(text(noArgs), /正在读取\s*$/);
  // ⑤ 已结算的 read 结果 → 「读完了 client.js」。
  const done = render({
    partial: { turn: 1, step: 3, blocks: [{ kind: 'tool-call', callId: 'c5', name: 'read', argsRaw: '{"path":"E:/a/b/client.js"}' }] },
    runningCalls: [],
    nodes: [{
      kind: 'tool-result',
      seq: 5,
      callId: 'c5',
      name: 'read',
      time: 2000,
      callTime: 1200,
      isError: false,
      content: [{ type: 'text', text: 'file body' }],
      args: {},
      call: { name: 'read', argsRaw: '{"path":"E:/a/b/client.js"}' },
      subCalls: [],
    }],
  });
  assert.match(text(done), /读完了 client\.js/);
  // ⑥ 失败态也带对象：命令挂了要说清是哪条命令，不能只剩一句「命令执行失败」。
  const failed = render({
    partial: { turn: 1, step: 4, blocks: [{ kind: 'tool-call', callId: 'c6', name: 'bash', argsRaw: '{"command":"npm test"}' }] },
    runningCalls: [],
    nodes: [{
      kind: 'tool-result',
      seq: 6,
      callId: 'c6',
      name: 'bash',
      time: 3000,
      callTime: 2200,
      isError: false,
      content: [{ type: 'text', text: 'boom\n[exit code: 1]' }],
      args: {},
      call: { name: 'bash', argsRaw: '{"command":"npm test"}' },
      subCalls: [],
    }],
  });
  assert.match(text(failed), /命令执行失败（exit code 1） npm test/);
  // 普通工具失败同样带对象。
  const failedRead = render({
    partial: { turn: 1, step: 5, blocks: [{ kind: 'tool-call', callId: 'c7', name: 'read', argsRaw: '{"path":"E:/a/b/client.js"}' }] },
    runningCalls: [],
    nodes: [{
      kind: 'tool-result',
      seq: 7,
      callId: 'c7',
      name: 'read',
      time: 3000,
      callTime: 2500,
      isError: true,
      error: { name: 'Error', code: 'ENOENT' },
      content: [{ type: 'text', text: 'no such file' }],
      args: {},
      call: { name: 'read', argsRaw: '{"path":"E:/a/b/client.js"}' },
      subCalls: [],
    }],
  });
  assert.match(text(failedRead), /工具执行失败 client\.js/);
});

test('阶段话术：工具间隙只报「刚干完什么」，不写「在想下一步」这种空尾巴', () => {
  const nodes = [
    { kind: 'tool-result', seq: 12, callId: 'r1', name: 'read', time: 1000, callTime: 900, isError: false, content: [], args: {}, call: null, subCalls: [] },
    { kind: 'tool-result', seq: 13, callId: 'g1', name: 'grep', time: 2000, callTime: 1800, isError: false, content: [], args: {}, call: null, subCalls: [] },
    { kind: 'tool-result', seq: 14, callId: 'r2', name: 'read', time: 3000, callTime: 2500, isError: false, content: [], args: {}, call: null, subCalls: [] },
  ];
  const tools = __test.turnTools({ nodes, turnEnds: new Map([[0, 5]]), turn: 1 });
  assert.equal(tools.length, 3, '回合内 3 条结果');
  const phase = __test.phaseText(tools);
  assert.equal(phase.text, '看完了 3 个文件');

  // 编辑过的 → 「刚改完 xxx」
  const phaseEdit = __test.phaseText([
    { kind: 'tool-result', seq: 20, name: 'edit', time: 4000, callTime: 3000, isError: false,
      content: [], args: {}, call: { name: 'edit', argsRaw: '{"path":"E:/x/client.js"}' }, subCalls: [] },
  ]);
  assert.equal(phaseEdit.text, '刚改完 client.js');

  assert.equal(__test.phaseText([]), null);
  // 空档话术同理：只报事实，不再吃 now。
  assert.equal(__test.gapText([]), null);
  assert.equal(__test.gapText([
    { kind: 'tool-result', seq: 21, name: 'read', time: 5000, callTime: 4500, isError: false,
      content: [], args: {}, call: { name: 'read', argsRaw: '{"path":"E:/x/a.js"}' }, subCalls: [] },
  ]).text, 'a.js 读完了');
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
  // 稳定窗口拉长到 520ms（原来 350ms）：前几步文案换得勤，350ms 还是会让人看见跳字。
  assert.equal(__test.LABEL_HOLD_MS, 520);
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

test('「没线索时」整项删掉后，deriveCaption 不再认 factsOnly 这个开关', () => {
  const thinking = {
    partial: { turn: 1, step: 0, blocks: [{ kind: 'reasoning', text: '我先读取配置文件 package.json' }] },
    runningCalls: [],
    nodes: [],
  };
  // 默认：会按规则表猜（三种说法轮着来，任一种都算命中）
  assert.match(text(render(thinking)), /(正在读取配置文件|翻一下配置文件|看看配置里怎么写的|对一下配置项)/);
  // 老存档里塞 factsOnly:true 也不再能关掉「读思考文本猜一句」——这个开关已经删了。
  const legacy = __test.deriveCaption({ ...thinking, factsOnly: true });
  assert.ok(legacy, 'factsOnly 不再能把字幕整条关掉');
  assert.equal(legacy.state, 'thinking');
  assert.equal(legacy.ruleId, 'read-config', '照样按规则表猜');
  // 也不影响「有工具在跑就照常报事实」：这条路径跟老字段彻底无关了。
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

test('俏皮词换词是「滚」不是「闪」：外壳不动，只有里面两行字在滚', () => {
  const view = render({
    partial: { turn: 3, step: 0, blocks: [{ kind: 'reasoning', text: '我先读取配置文件 package.json' }] },
    runningCalls: [],
    nodes: [],
    turnEnds: new Map(),
  });
  let flavor = null;
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.props && node.props.className === 'pgc-flavor') flavor = node;
    (node.children || []).forEach(walk);
  };
  walk(view);
  assert.ok(flavor, '要有俏皮词');
  const track = (flavor.children || []).filter(Boolean)[0];
  assert.ok(track, '滚槽里要有一条履带');
  assert.match(track.props.className, /pgc-flavor-track/, '滚槽里只放那条履带，不直接放字');
  assert.match(track.props.className, /pgc-flavor-still/, '首帧还没有「上一句」，不要滚，只淡入');

  const lines = (track.children || []).filter(Boolean);
  assert.equal(lines.length, 2, '履带上是两行：上一句在上、新的一句在下');
  assert.ok(lines.every((c) => /pgc-flavor-line/.test(c.props.className)), '履带里只放行');
  assert.equal(lines[0].props['aria-hidden'], true, '上一句别让读屏念第二遍');
  assert.ok(!lines[1].props['aria-hidden'], '下面那行才是当前这句');
  assert.ok(String(text(lines[1])).trim().length > 0, '当前这一行不能是空的');

  // 外壳是滚槽：固定高度 + 裁切，换词时底色和宽度一像素都不动。
  const shell = /\.pgc-flavor \{([\s\S]*?)\}/.exec(sheet);
  assert.ok(shell, '要有 .pgc-flavor 规则');
  assert.match(shell[1], /overflow: hidden/, '滚槽要裁掉滚出去的那半句');
  assert.match(shell[1], /position: relative/, '履带靠它绝对定位');
  assert.match(shell[1], /height: [\d.]+em/, '高度锁死，换词不撑高');
  assert.doesNotMatch(shell[1], /animation:/, '外壳不许再挂动画（原来整颗胶囊跟着闪）');

  // 一条履带整体滚半格：两行永远只差一行，不会中途叠在一起。
  const trk = /\.pgc-flavor-track \{([\s\S]*?)\}/.exec(sheet);
  assert.ok(trk, '要有 .pgc-flavor-track 规则');
  assert.match(trk[1], /height: 200%/, '履带两行高，滚半格＝滚一行');
  assert.match(trk[1], /flex-direction: column/, '两行竖着叠');
  assert.match(trk[1], /animation: pgc-flavor-roll/, '换词动画挂在履带上，不挂在行上');
  assert.match(trk[1], /transform: translateY\(-50%\)/, '默认停在下面那行：动画关掉时不会停在上一句');
  assert.doesNotMatch(trk[1], /\b(width|margin|padding|top|left|right|bottom):.*\b(px|em)\b\s*;[\s\S]*animation/,
    '只许动 transform，不许推挤排版');

  const line = /\.pgc-flavor-line \{([\s\S]*?)\}/.exec(sheet);
  assert.ok(line, '要有 .pgc-flavor-line 规则');
  assert.match(line[1], /flex: 0 0 50%/, '每行正好半条履带＝一格');

  assert.match(sheet, /\.pgc-flavor-still \{ animation: none; \}/, '首帧那条不滚');

  const kf = /@keyframes pgc-flavor-roll \{([\s\S]*?)\n\}/.exec(sheet);
  assert.ok(kf, '要有换词关键帧');
  assert.match(kf[1], /from \{ transform: translateY\(0\)/, '起点露出上一句');
  assert.match(kf[1], /to \{ transform: translateY\(-50%\)/, '终点露出新的一句');
  assert.doesNotMatch(kf[1], /\b(width|height|margin|padding|top|left|right|bottom):/, '只许动 transform');
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

test('耗时位换成绕圈的点：宽高写死，标记在槽里，且排在俏皮词左边', () => {
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
  const arc = (slot.children || []).filter(Boolean);
  assert.equal(arc.length, 1, '槽里只装一个标记');
  assert.equal(arc[0].props.className, 'pgc-arc');
  const dots = (arc[0].children || []).filter(Boolean);
  assert.equal(dots.length, 3, '三个点绕着跑');
  assert.ok(dots.every((d) => d && d.props && d.props.className === undefined), '点本身不带类名，样式靠 nth-child');
  assert.ok(classes.indexOf('pgc-slot') < classes.indexOf('pgc-flavor'), '动画位排在俏皮词左边');
  assert.ok(!classes.includes('pgc-time'), '耗时那一格已经撤掉了');

  // 尺寸写死：以后改动画怎么转，都不会把左右两边挤动。
  const rule = /\.pgc-slot \{([\s\S]*?)\}/.exec(sheet);
  assert.ok(rule, '要有 .pgc-slot 规则');
  assert.match(rule[1], /width: 3\.6em/, '宽度与原耗时格一致，俏皮词位置不变');
  assert.match(rule[1], /height:/, '高度也要锁住');
  assert.match(rule[1], /flex: 0 0 auto/, '不许被压缩');

  // 标记本身不接收点击，免得盖住右边的状态胶囊。
  const arcRule = /\.pgc-arc \{([\s\S]*?)\}/.exec(sheet);
  assert.ok(arcRule, '要有 .pgc-arc 规则');
  assert.match(arcRule[1], /pointer-events: none/, '不许吃点击');

  // 每个点都在跑同一条轨道，只靠 delay 错开出发时间（Windows 开机转圈的做法）。
  const dotRule = /^\.pgc-arc > span \{([\s\S]*?)\}/m.exec(sheet);
  assert.ok(dotRule, '要有 .pgc-arc > span 规则');
  assert.match(dotRule[1], /animation: pgc-orbit/, '默认就在转');
  assert.match(dotRule[1], /cubic-bezier\(/, '必须用缓动，线性转就是那个「死板」的来源');
  for (const n of [2, 3]) {
    assert.match(sheet, new RegExp(`:nth-child\\(${n}\\)[^}]*animation-delay`), `第 ${n} 个点要有错开的出发时间`);
  }

  const frames = /@keyframes pgc-orbit \{[\s\S]*?\n\}/.exec(sheet);
  assert.ok(frames, '要有 @keyframes pgc-orbit');
  assert.doesNotMatch(frames[0], /\b(width|height|margin|padding|top|left|right|bottom):/, 'pgc-orbit 只许动 transform / opacity');
  assert.match(frames[0], /transform:/, 'pgc-orbit 必须真的动起来');
  assert.match(frames[0], /rotate\(720deg\)/, '一圈半的行程，才有「甩」的余量');
  assert.match(frames[0], /opacity:/, '首尾要淡出，接缝才不会咯噔一下');
  assert.match(sheet, /@media \(prefers-reduced-motion: reduce\)/, '系统降级仍然保留');
  // 降级时不转，但点必须还看得见——它们的可见度平时靠关键帧给。
  const reduced = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/.exec(sheet);
  assert.ok(reduced, '要能取到降级块');
  assert.match(reduced[1], /\.pgc-arc > span \{ opacity:/, '降级时把点的可见度补回来');
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

test('副行包在「高度闸门」里：开合走过渡，不再让整条框跳高 / 缩回', () => {
  // 老实现把 .pgc-sub 直接挂在 .pgc-text 下：出现/消失的一瞬间内容高度多 13px / 少 13px，
  // 整条框跟着一跳（.pgc-band 那条 max-height 过渡恒为 7em，一次都没生效过）。
  const wrap = /\.pgc-sub-wrap \{([\s\S]*?)\}/.exec(sheet);
  assert.ok(wrap, '要有 .pgc-sub-wrap 这层壳');
  const body = wrap[1].replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(body, /max-height: 0/, '默认高度为 0：收起时壳不占地方');
  assert.match(body, /opacity: 0/, '默认透明，跟着高度一起淡出');
  assert.match(body, /overflow: hidden/, '收起时要把内容裁掉，别溢到外面');
  assert.match(body, /transition: max-height \.18s/, '高度变化必须走过渡，否则还是瞬间跳');
  assert.match(body, /opacity \.14s/, '透明度要跟着一起过渡');
  const on = /\.pgc-sub-wrap--on \{([^}]*)\}/.exec(sheet);
  assert.ok(on, '要有展开态 .pgc-sub-wrap--on');
  assert.match(on[1], /max-height: 1\.6em/, '展开到一行的高度');
  assert.match(on[1], /opacity: \.78/, '副行比主文案淡一档');

  const data = {
    partial: { turn: 4, step: 1, blocks: [{ kind: 'reasoning', text: '我先读取配置文件，看看入口在哪。' }] },
    runningCalls: [],
    nodes: [],
  };
  const find = (node, test) => {
    if (!node || typeof node !== 'object') return null;
    if (node.props && test(node)) return node;
    for (const child of node.children || []) {
      const hit = find(child, test);
      if (hit) return hit;
    }
    return null;
  };
  const previous = globalThis.localStorage;
  try {
    globalThis.localStorage = { getItem: () => JSON.stringify({ subLine: true }), setItem: () => {} };
    const wide = render(data);
    const shell = find(wide, (node) => typeof node.props.className === 'string'
      && /^pgc-sub-wrap( |$)/.test(node.props.className));
    assert.ok(shell, '副行外面必须有一层 .pgc-sub-wrap（不是直接挂 .pgc-sub）');
    assert.match(shell.props.className, /pgc-sub-wrap--on/, '有内容时要带展开态');
    const inner = find(shell, (node) => node.props.className === 'pgc-sub');
    assert.ok(inner, '.pgc-sub 要包在壳里面');
    assert.match(text(inner), /读取配置文件/);

    // 关掉时壳仍然在树上（收起靠 max-height 过渡，不是把节点摘掉）。
    globalThis.localStorage = { getItem: () => JSON.stringify({ subLine: false }), setItem: () => {} };
    const hidden = render(data);
    const closed = find(hidden, (node) => typeof node.props.className === 'string'
      && /^pgc-sub-wrap( |$)/.test(node.props.className));
    assert.ok(closed, '关掉副行时壳也要常驻，否则没有东西可过渡');
    assert.doesNotMatch(closed.props.className, /pgc-sub-wrap--on/, '关掉时不许带展开态');
  } finally {
    if (previous === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previous;
  }
});

test('工具在跑的时候副行不消失：整轮都在，state 翻成 running 也不摘', () => {
  const reasoning = '我先读取配置文件，看看入口在哪。然后决定改哪里。';
  const base = {
    partial: { turn: 9, step: 2, blocks: [{ kind: 'reasoning', text: reasoning }] },
    runningCalls: [],
    nodes: [],
    turnEnds: new Map(),
  };
  const thinking = __test.deriveCaption(base);
  assert.equal(thinking.state, 'thinking');
  assert.match(thinking.sub, /读取配置文件/, '思考时有副行');

  // 工具一起来，state 变 running：以前这里 sub 是 undefined，副行被整块摘掉。
  const running = __test.deriveCaption({
    ...base,
    runningCalls: [{ callId: 'c1', name: 'bash', step: 2, time: Date.now(), argsRaw: '{"command":"npm test"}' }],
  });
  assert.equal(running.state, 'running');
  assert.equal(running.sub, thinking.sub, '工具在跑时副行那句原话不许变、更不许消失');

  // 渲染层也核一遍：running 态那条副行确实还在条上。
  const previous = globalThis.localStorage;
  try {
    globalThis.localStorage = { getItem: () => JSON.stringify({ subLine: true }), setItem: () => {} };
    const view = render({
      ...base,
      runningCalls: [{ callId: 'c1', name: 'bash', step: 2, time: Date.now(), argsRaw: '{"command":"npm test"}' }],
    });
    assert.match(view.props.className, /pgc-strip--running/, '这一帧就是 running 态');
    assert.match(text(view), /读取配置文件/, 'running 期间副行必须还在条上');
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

test('耗时字段已彻底移除：字幕条上不再有「秒」这个东西', () => {
  const data = {
    partial: { turn: 3, step: 1, blocks: [{ kind: 'reasoning', text: '想了想' }] },
    runningCalls: [],
    nodes: [],
    turnEnds: new Map([[2, 100]]),
  };
  // 以前这里有个 elapsedMs，每秒刷新一次却没人读——既白渲染又不准，已整条删掉。
  const quick = __test.deriveCaption(data);
  assert.equal(quick.elapsedMs, undefined, 'elapsedMs 字段应已不存在');

  const shown = text(render({
    ...data,
    runningCalls: [{ callId: 'c9', name: 'bash', step: 1, time: Date.now() - 400, argsRaw: '{"command":"ls"}' }],
  }));
  assert.doesNotMatch(shown, /\d+\.\d\s?s/, '条上不该再出现任何耗时');
});

/* ---------------- 回合级结局：宿主的结论，不是猜的 ---------------- */

test('回合级失败：turn-error 会让字幕说「这一轮没跑完」，不再停在正在思考', () => {
  const view = __test.deriveCaption({
    partial: null,
    turnOpen: true,
    runningCalls: [],
    nodes: [{
      kind: 'turn-error',
      seq: 40,
      time: 4000,
      turn: 3,
      step: 2,
      message: 'upstream 502',
      code: 'UPSTREAM_ERROR',
    }],
    turnEnds: new Map(),
    turn: 3,
  });
  assert.ok(view, '不能因为 partial 空就收起来');
  assert.equal(view.state, 'error');
  assert.equal(view.kind, 'error');
  assert.equal(view.code, 'UPSTREAM_ERROR');
  assert.match(view.rawLine || '', /502/, '原始报错要能展开看');
});

test('被用户自己停的（INTERRUPTED）措辞分开，不说成「模型报错」', () => {
  const view = __test.deriveCaption({
    partial: null,
    turnOpen: true,
    runningCalls: [],
    nodes: [{ kind: 'turn-error', seq: 41, time: 4100, turn: 4, step: 1, message: 'stopped', code: 'INTERRUPTED' }],
    turnEnds: new Map(),
    turn: 4,
  });
  assert.equal(view.kind, 'interrupted');
});

test('输出到上限（turn-max-tokens）单独一个说法', () => {
  const view = __test.deriveCaption({
    partial: null,
    turnOpen: true,
    runningCalls: [],
    nodes: [{ kind: 'turn-max-tokens', seq: 42, time: 4200, turn: 5, step: 1, message: 'max tokens' }],
    turnEnds: new Map(),
    turn: 5,
  });
  assert.equal(view.kind, 'maxtokens');
});

test('上一轮的旧报错不许翻出来：只认当前这一轮', () => {
  const nodes = [{ kind: 'turn-error', seq: 30, time: 3000, turn: 2, step: 1, message: 'old', code: 'OLD' }];
  const view = __test.deriveCaption({
    partial: { turn: 3, step: 1, blocks: [{ kind: 'reasoning', text: '继续干活' }] },
    runningCalls: [],
    nodes,
    turnEnds: new Map([[2, 30]]),
  });
  assert.notEqual(view.state, 'error', '旧回合的报错不能算到新回合头上');
});

test('上游在退避重试：说第几次，而不是干等「正在思考」', () => {
  const view = __test.deriveCaption({
    partial: { turn: 6, step: 2, blocks: [{ kind: 'reasoning', text: '等一下' }] },
    runningCalls: [],
    nodes: [{
      kind: 'model-retry', seq: 50, time: 5000, turn: 6, retryState: 'scheduled',
      retry: 2, maxRetries: 5, delayMs: 2000, failure: { code: 'RATE_LIMITED' },
    }],
    turnEnds: new Map(),
  });
  assert.equal(view.retry.n, 2);
  const shown = text(render({
    partial: { turn: 6, step: 2, blocks: [{ kind: 'reasoning', text: '等一下' }] },
    runningCalls: [],
    nodes: [{
      kind: 'model-retry', seq: 50, time: 5000, turn: 6, retryState: 'scheduled',
      retry: 2, maxRetries: 5, delayMs: 2000, failure: { code: 'RATE_LIMITED' },
    }],
    turnEnds: new Map(),
  }));
  assert.match(shown, /第 2 次重试/);
});

test('重试已经开始（started）就不再说「等待中」', () => {
  const view = __test.deriveCaption({
    partial: { turn: 7, step: 1, blocks: [{ kind: 'reasoning', text: '继续' }] },
    runningCalls: [],
    nodes: [{ kind: 'model-retry', seq: 51, time: 5100, turn: 7, retryState: 'started', retry: 1 }],
    turnEnds: new Map(),
  });
  assert.ok(!view.retry, 'started 就是正常在跑了');
});

test('工具事实优先于回合结局：报错之后又跑起来，就照实报在跑什么', () => {
  const view = __test.deriveCaption({
    partial: { turn: 8, step: 2, blocks: [] },
    runningCalls: [{ callId: 'c1', name: 'bash', step: 2, time: Date.now(), argsRaw: '{"command":"npm test"}' }],
    nodes: [{ kind: 'turn-error', seq: 60, time: 6000, turn: 8, step: 1, message: 'x', code: 'X' }],
    turnEnds: new Map(),
  });
  assert.equal(view.state, 'running', '手头真的在跑东西，就先说在跑什么');
});
