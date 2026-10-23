/**
 * 生成 preview-dots.html：把「改之前」和「改之后」的三颗状态点并排放在一起，
 * 同一屏、同一时刻、同样内容，眼睛直接对照，不用在两个文件之间来回切。
 *
 * 旧值不是凭印象写的，是从本次改动的 diff 里逐条抄回来的：
 *   --pgc-dot-cycle: 3.2s；keyframes 0%,30%,100% opacity .38 → 50% opacity 1；
 *   transform translateY(-1px)（无缩放）；点2 delay -2.13s、点3 delay -1.07s。
 * 新值是 client.js 现在线上的值：2.4s、0%,4% .3 → 44% opacity 1 + translateY(-2px) scale(1.25)、
 *   点2 delay calc(2.4s / -3)、点3 delay calc(2.4s / -3 * 2)。
 *
 * 跑法：node tools/compare-dots.mjs
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(HERE, '..');

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>状态点：改之前 vs 改之后</title>
<style>
  :root { --accent: #4d6bfe; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 32px 24px 56px;
    font: 14px/1.6 system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
    background: #f7f8fa; color: #1f2329;
  }
  h1 { font-size: 17px; margin: 0 0 4px; }
  p.lead { margin: 0 0 24px; color: #646a73; font-size: 13px; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; max-width: 1040px; }
  .card {
    background: #fff; border: 1px solid #e5e6eb; border-radius: 12px;
    padding: 18px 20px 22px;
  }
  .card.bad { border-color: #f5c2c0; }
  .card.good { border-color: #a9d3ab; }
  .tag { display: inline-block; font-size: 12px; padding: 1px 8px; border-radius: 999px; margin-left: 8px; }
  .tag.bad { background: #fdecea; color: #c0392b; }
  .tag.good { background: #e8f5e9; color: #2e7d32; }
  .card h2 { font-size: 14px; margin: 0 0 2px; font-weight: 600; }
  .spec { color: #8a9099; font-size: 12px; margin: 0 0 18px; font-variant-numeric: tabular-nums; }
  .stage {
    display: flex; align-items: center; gap: 14px; min-height: 64px;
    padding: 14px 16px; background: #fafbfc; border-radius: 8px;
  }
  .caption { font-size: 13px; color: #646a73; }

  /* ── 点本体：两份只有周期、幅度、相位不同 ───────────────────────── */
  .loader {
    flex: 0 0 auto; display: inline-flex; align-items: flex-end; gap: 2px;
    width: 16px; height: 8px;
  }
  .dot {
    width: 4px; height: 4px; border-radius: 50%;
    background: var(--accent); transform-origin: 50% 100%;
  }

  /* 旧：3.2s、抬 1px、无缩放、30% 空转、相位 |delay| 递减 */
  .old { --cycle: 3.2s; }
  .old .dot:nth-child(2) { animation-delay: -2.13s; }
  .old .dot:nth-child(3) { animation-delay: -1.07s; }
  .old .dot { animation: breathe-old var(--cycle) cubic-bezier(.37, 0, .63, 1) infinite; }
  @keyframes breathe-old {
    0%, 30%, 100% { opacity: .38; transform: translateY(0); }
    50% { opacity: 1; transform: translateY(-1px); }
  }

  /* 新：2.4s、抬 2px + 1.25 倍、4% 空转、相位让波峰按 1→2→3 到（|delay| 递减） */
  .new { --cycle: 2.4s; }
  .new .dot:nth-child(2) { animation-delay: calc(var(--cycle) / -3 * 2); }
  .new .dot:nth-child(3) { animation-delay: calc(var(--cycle) / -3); }
  .new .dot { animation: breathe-new var(--cycle) cubic-bezier(.37, 0, .63, 1) infinite; }
  @keyframes breathe-new {
    0%, 4% { opacity: .3; transform: translateY(0) scale(1); }
    44% { opacity: 1; transform: translateY(-2px) scale(1.25); }
    100% { opacity: .3; transform: translateY(0) scale(1); }
  }

  /* 放大：4px 的点在正常尺寸下很难判断，放大后相位与幅度一目了然。 */
  body.big .loader { width: 48px; height: 24px; gap: 6px; align-items: flex-end; }
  body.big .dot { width: 12px; height: 12px; }
  body.big .dot { animation-duration: var(--cycle); }

  .ctrl {
    max-width: 1040px; margin: 26px 0 0; display: flex; gap: 18px;
    align-items: center; flex-wrap: wrap;
  }
  .ctrl label { display: inline-flex; align-items: center; gap: 7px; cursor: pointer; }
  .notes { max-width: 1040px; margin: 22px 0 0; padding: 14px 18px; background: #fff;
           border: 1px solid #e5e6eb; border-radius: 10px; font-size: 13px; color: #4a5058; }
  .notes b { color: #1f2329; }
  .notes ul { margin: 6px 0 0; padding-left: 20px; }
  .notes li { margin: 3px 0; }
  code { font-family: ui-monospace, Consolas, monospace; font-size: 12px;
         background: #f2f3f5; padding: 1px 5px; border-radius: 4px; }
</style>
</head>
<body>
  <h1>第几步后面那三个点：改之前 vs 改之后</h1>
  <p class="lead">两栏同时跑同一段动画，唯一变量是下面列出的那几个数。默认是真实尺寸（4px），勾「放大 3 倍」看得更清楚。</p>

  <div class="grid">
    <div class="card bad">
      <h2>改之前<span class="tag bad">你说不好的那版</span></h2>
      <p class="spec">周期 3.2s · 抬 1px · 无缩放 · 亮度 .38→1 · 空转 30%</p>
      <div class="stage old">
        <span class="loader" aria-hidden="true"><span class="dot"></span><span class="dot"></span><span class="dot"></span></span>
        <span class="caption">第 3 步 · 正在读取 README.md</span>
      </div>
    </div>

    <div class="card good">
      <h2>改之后<span class="tag good">现在 client.js 里的</span></h2>
      <p class="spec">周期 2.4s · 抬 2px · 放大 1.25 · 亮度 .3→1 · 空转 4%</p>
      <div class="stage new">
        <span class="loader" aria-hidden="true"><span class="dot"></span><span class="dot"></span><span class="dot"></span></span>
        <span class="caption">第 3 步 · 正在读取 README.md</span>
      </div>
    </div>
  </div>

  <div class="ctrl">
    <label><input type="checkbox" id="big"> 放大 3 倍（只看形，不看尺寸感）</label>
    <label><input type="checkbox" id="slow"> 慢放 4 倍（看相位是不是 1→2→3）</label>
  </div>

  <div class="notes">
    <b>为什么要看相位：</b>三颗点共用一条 keyframes，只靠负延迟错开。负延迟 −D 表示「已经跑了 D」，
    所以局部时间提前了 D，波峰也就提前 D 到：<code>t_peak = 0.44T − delay</code>。
    <b>|delay| 越大，波峰越早</b>。要让波从左往右传，<code>|delay|</code> 必须随点号<b>递减</b>。
    <ul>
      <li><b>旧版</b><code>-2.13s / -1.07s</code>——|delay| 递减，波峰 1.056 / 1.326 / 2.386s，顺序 <b>1→2→3</b>，方向其实是对的；真正让它「看不出来」的是下面 B 项：抬 1px、无缩放、空转 30%。</li>
      <li><b>新版</b><code>calc(2.4s / -3 * 2) / calc(2.4s / -3)</code>——波峰 1.056 / 1.856 / 0.256s，环形的 <b>1→2→3</b>，间隔正好 0.8s。</li>
    </ul>
    这条换算我自己也写反过一次（先是把加减号搞错，后来又照着错结论改了测试），所以现在测试里
    既断言「乘数必须是 2/3 和 1/3」，又按时间真算一遍先后顺序，两头互相咬。
  </div>

<script>
  const big = document.getElementById('big');
  const slow = document.getElementById('slow');
  big.addEventListener('change', () => {
    document.body.classList.toggle('big', big.checked);
    applySpeed();
  });
  slow.addEventListener('change', applySpeed);

  // 慢放靠 animation-duration 乘 4 实现；相位是 calc 里跟 var 走的，会自动一起放慢，
  // 所以慢放状态下看到的先后顺序仍然是真实顺序。
  function applySpeed() {
    const k = slow.checked ? 4 : 1;
    document.querySelector('.old').style.setProperty('--cycle', (3.2 * k) + 's');
    document.querySelector('.new').style.setProperty('--cycle', (2.4 * k) + 's');
  }
</script>
</body>
</html>
`;

writeFileSync(path.join(root, 'preview-dots.html'), html, 'utf8');
console.log('已生成 preview-dots.html（' + (html.length / 1024).toFixed(1) + ' KB）');
