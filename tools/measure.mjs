// 一次性排查脚本：把真实 CSS 抠出来，量「一行」时俏皮词胶囊是否被 .pgc-band 的
// overflow 裁掉，以及换文案交叉淡入时整条字幕的高度有没有变（.pgc-label 只由静态的
// .pgc-label-cur 撑高，.pgc-label-prev 绝对定位不参与布局）。
// 用法：node tools/measure.mjs 生成 measure.html，再用 headless Edge 的
// --dump-dom 读页面里写回 <pre> 的测量结果；带 ANIM=1 可量动画播放中的几何。
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const client = readFileSync(join(here, '..', 'client.js'), 'utf8');
const css = /const CSS = `([\s\S]*?)`;/.exec(client)[1];

// 量「静止状态」的几何：把动画全关掉，否则会量到 transform 播到一半的中间值。
// 想看「动画播放中会不会被裁剪框切到」，就带 ANIM=1 跑。
const killAnim = process.env.ANIM === '1'
  ? ''
  : '.pgc-strip, .pgc-strip * { animation: none !important; transition: none !important; }';

// 三点装载器 —— 和 client.js 里的 JSX 一模一样。
const LOADER = '<span class="pgc-loader" aria-hidden="true"><span class="pgc-dot"></span><span class="pgc-dot"></span><span class="pgc-dot"></span></span>';

const strip = (body, cls) => `
  <div class="pgc-strip pgc-strip--thinking pgc-size-m pgc-anim-calm pgc-flavor-tint ${cls}" data-plugin="dsh-progress-caption">
    <span class="pgc-band"><span class="pgc-live" role="status" aria-live="polite">${body}</span></span>
  </div>`;

const page = `<!doctype html><meta charset="utf-8">
<style>
${css}
${killAnim}
body { font: 12px/1.4 system-ui, sans-serif; background: #fff; color: #222; padding: 20px; }
.wrap { width: 900px; }
h3 { font-size: 12px; margin: 18px 0 6px; color: #666; }
pre { font: 11px/1.5 monospace; background: #f4f4f4; padding: 8px; }
</style>
<div class="wrap">
  <h3>一行（只主文案 + 俏皮词）</h3>
  <div id="one">
  ${strip(`
    <span class="pgc-step">第 2 步</span>
    ${LOADER}
    <span class="pgc-text"><span class="pgc-label"><span class="pgc-label-cur">翻一下配置文件</span></span></span>
    <span class="pgc-flavor">小跑中</span>`, '')}
  </div>

  <h3>两行（多一行副行）</h3>
  <div id="two">
  ${strip(`
    <span class="pgc-step">第 6 步</span>
    ${LOADER}
    <span class="pgc-text">
      <span class="pgc-label"><span class="pgc-label-cur">看看配置里怎么写的</span></span>
      <span class="pgc-sub-wrap pgc-sub-wrap--on"><span class="pgc-sub">先看 package.json 的入口，再决定改哪里</span></span>
    </span>
    <span class="pgc-flavor">小跑中</span>`, '')}
  </div>

  <h3>换文案交叉淡入（新旧两层同时在）</h3>
  <div id="cross">
  ${strip(`
    <span class="pgc-step">第 3 步</span>
    ${LOADER}
    <span class="pgc-text">
      <span class="pgc-label">
        <span class="pgc-label-cur">看看配置里怎么写的</span>
        <span class="pgc-label-prev" aria-hidden="true">翻一下配置文件</span>
      </span>
    </span>
    <span class="pgc-flavor">小跑中</span>`, '')}
  </div>

  <h3>俏皮词换词（新旧两层同时在胶囊里）</h3>
  <div id="cross-flavor">
  ${strip(`
    <span class="pgc-step">第 3 步</span>
    ${LOADER}
    <span class="pgc-text"><span class="pgc-label"><span class="pgc-label-cur">看看配置里怎么写的</span></span></span>
    <span class="pgc-flavor">
      <span class="pgc-flavor-cur">琢磨中</span>
      <span class="pgc-flavor-prev" aria-hidden="true">小跑中</span>
    </span>`, '')}
  </div>

  <h3>收起（齿轮）</h3>
  <div id="handle">
  ${strip(`
    <span class="pgc-step">第 2 步</span>
    ${LOADER}
    <span class="pgc-text"><span class="pgc-label"><span class="pgc-label-cur">翻一下配置文件</span></span></span>
    <span class="pgc-flavor">小跑中</span>`, 'pgc-strip--handle')}
  </div>
</div>
<pre id="out"></pre>
<script>
const rows = [];
for (const id of ['one', 'two', 'cross', 'cross-flavor', 'handle']) {
  const strip = document.querySelector('#' + id + ' .pgc-strip');
  const band = document.querySelector('#' + id + ' .pgc-band');
  const live = document.querySelector('#' + id + ' .pgc-live');
  const pill = document.querySelector('#' + id + ' .pgc-flavor');
  const label = document.querySelector('#' + id + ' .pgc-label');
  const cur = document.querySelector('#' + id + ' .pgc-label-cur');
  const prev = document.querySelector('#' + id + ' .pgc-label-prev');
  const fcur = document.querySelector('#' + id + ' .pgc-flavor-cur');
  const fprev = document.querySelector('#' + id + ' .pgc-flavor-prev');
  if (!strip || !band || !live || !pill || !label || !cur) { rows.push(id + ' missing'); continue; }
  const s = strip.getBoundingClientRect();
  const b = band.getBoundingClientRect();
  const l = live.getBoundingClientRect();
  const p = pill.getBoundingClientRect();
  const lb = label.getBoundingClientRect();
  const c = cur.getBoundingClientRect();
  const pr = prev ? prev.getBoundingClientRect() : null;
  const fc = fcur ? fcur.getBoundingClientRect() : null;
  const fp = fprev ? fprev.getBoundingClientRect() : null;
  // 只有 band 真的会裁剪时，「超出 band」才算被切掉；overflow:visible 时超出多少都看得见。
  const ov = getComputedStyle(band).overflow;
  const willClip = ov !== 'visible';
  const outside = p.top < b.top - 0.01 || p.bottom > b.bottom + 0.01;
  rows.push(id + ' strip=' + s.height.toFixed(2) + ' band=' + b.height.toFixed(2) +
    ' live=' + l.height.toFixed(2) + ' pill=' + p.height.toFixed(2) +
    ' label=' + lb.height.toFixed(2) + ' cur=' + c.height.toFixed(2) +
    ' prev=' + (pr ? pr.height.toFixed(2) : '-') +
    ' prevAbs=' + (prev ? getComputedStyle(prev).position : '-') +
    ' pillW=' + p.width.toFixed(2) +
    ' pillLeft=' + (p.left - l.left).toFixed(2) +
    ' flavorCur=' + (fc ? fc.width.toFixed(2) : '-') +
    ' flavorPrev=' + (fp ? fp.width.toFixed(2) : '-') +
    ' flavorPrevAbs=' + (fprev ? getComputedStyle(fprev).position : '-') +
    ' pillTopOff=' + (p.top - b.top).toFixed(2) +
    ' pillBotOff=' + (b.bottom - p.bottom).toFixed(2) +
    ' overflow=' + ov +
    ' outside=' + outside +
    ' clipped=' + (willClip && outside));
}
document.getElementById('out').textContent = rows.join('\\n');
</script>`;

writeFileSync(join(here, '..', 'measure.html'), page, 'utf8');
console.log('written: measure.html');
