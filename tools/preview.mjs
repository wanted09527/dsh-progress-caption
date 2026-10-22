/**
 * 生成 preview.html：不用启动 DSH，直接双击就能看字幕条和设置面板长什么样。
 * 用的是 client.js 里那份真 CSS（正则抠出来），主题变量给出浅色/深色两组近似值。
 *
 * 跑法：node tools/preview.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(HERE, '..');
const source = readFileSync(path.join(root, 'client.js'), 'utf8');

const start = source.indexOf('const CSS = `');
const end = source.indexOf('`;', start);
if (start < 0 || end < 0) throw new Error('client.js 里找不到 CSS 模板字符串');
const css = source.slice(start + 'const CSS = `'.length, end);

const sheet = (open) => `
      <div class="pgc-settings">
        <button type="button" class="pgc-gear" aria-expanded="${open ? 'true' : 'false'}" aria-label="字幕设置">⚙</button>
        <div class="pgc-sheet${open ? ' pgc-sheet--open' : ''}" role="dialog" aria-label="字幕设置" aria-hidden="${open ? 'false' : 'true'}">
          <div class="pgc-sheet-head">
            <span class="pgc-sheet-title">字幕设置</span>
            <button type="button" class="pgc-sheet-close" aria-label="关闭">✕</button>
          </div>
          <div class="pgc-sheet-body">
            <span class="pgc-group">长什么样</span>
            <label class="pgc-set-row"><span class="pgc-set-name">字号</span>
              <span class="pgc-seg" role="group">
                <button type="button" class="pgc-seg-btn" data-on="false">小</button>
                <button type="button" class="pgc-seg-btn" data-on="true">中</button>
                <button type="button" class="pgc-seg-btn" data-on="false">大</button>
              </span>
            </label>
            <label class="pgc-set-row"><span class="pgc-set-name">动画</span>
              <span class="pgc-seg" role="group">
                <button type="button" class="pgc-seg-btn" data-on="true">安静</button>
                <button type="button" class="pgc-seg-btn" data-on="false">扫光</button>
                <button type="button" class="pgc-seg-btn" data-on="false">全静止</button>
              </span>
            </label>
            <span class="pgc-group">颜色</span>
            <label class="pgc-set-row"><span class="pgc-set-name">字幕条颜色</span>
            <span class="pgc-swatches" role="group">
              <button type="button" class="pgc-swatch pgc-swatch--auto" data-on="false" title="跟随主题">A</button>
              <button type="button" class="pgc-swatch" data-on="true" title="海蓝" style="--pgc-sw:#4d6bfe"></button>
              <button type="button" class="pgc-swatch" data-on="false" title="森林" style="--pgc-sw:#2f9e68"></button>
              <button type="button" class="pgc-swatch" data-on="false" title="日落" style="--pgc-sw:#e07a3f"></button>
              <button type="button" class="pgc-swatch" data-on="false" title="紫罗兰" style="--pgc-sw:#8b5cf6"></button>
              <button type="button" class="pgc-swatch" data-on="false" title="玫红" style="--pgc-sw:#e0558c"></button>
              <button type="button" class="pgc-swatch" data-on="false" title="石墨" style="--pgc-sw:#6b7280"></button>
            </span></label>
            <label class="pgc-set-row"><span class="pgc-set-name">跑成功时</span>
              <span class="pgc-seg" role="group">
                <button type="button" class="pgc-seg-btn" data-on="true">跟随主题</button>
                <button type="button" class="pgc-seg-btn" data-on="false">翠绿</button>
                <button type="button" class="pgc-seg-btn" data-on="false">青色</button>
              </span>
            </label>
            <label class="pgc-set-row"><span class="pgc-set-name">跑失败时</span>
              <span class="pgc-seg" role="group">
                <button type="button" class="pgc-seg-btn" data-on="true">跟随主题</button>
                <button type="button" class="pgc-seg-btn" data-on="false">朱红</button>
                <button type="button" class="pgc-seg-btn" data-on="false">暖橙</button>
              </span>
            </label>
            <label class="pgc-set-row"><span class="pgc-set-name">俏皮词样子</span>
              <span class="pgc-seg" role="group">
                <button type="button" class="pgc-seg-btn" data-on="true">淡色底</button>
                <button type="button" class="pgc-seg-btn" data-on="false">实心</button>
                <button type="button" class="pgc-seg-btn" data-on="false">素色</button>
              </span>
            </label>
            <span class="pgc-group">说什么</span>
            <label class="pgc-set-row"><span class="pgc-set-name">显示俏皮词</span>
              <button type="button" class="pgc-switch" role="switch" data-on="true" aria-checked="true">
                <span class="pgc-switch-track"><span class="pgc-switch-thumb"></span></span>
                <span class="pgc-switch-label">开</span>
              </button>
            </label>
            <label class="pgc-set-row"><span class="pgc-set-name">思考原话</span>
              <button type="button" class="pgc-switch" role="switch" data-on="false" aria-checked="false">
                <span class="pgc-switch-track"><span class="pgc-switch-thumb"></span></span>
                <span class="pgc-switch-label">关</span>
              </button>
            </label>
            <label class="pgc-set-row"><span class="pgc-set-name">没线索时</span>
              <span class="pgc-seg" role="group">
                <button type="button" class="pgc-seg-btn" data-on="false">只报动作</button>
                <button type="button" class="pgc-seg-btn" data-on="true">猜一猜</button>
              </span>
            </label>
            <p class="pgc-sheet-hint">没在跑工具的时候，选「猜一猜」它会从思考内容里猜一句；猜错很正常，看看就好。</p>
            <p class="pgc-sheet-note">设置只存在这个浏览器里</p>
          </div>
        </div>
      </div>`;

const strip = (state, body, extra = '') => `
      <div class="pgc-strip pgc-strip--${state} pgc-size-m pgc-anim-calm" data-plugin="dsh-progress-caption" title="字幕由规则推断，不代表模型真实意图">
        <span class="pgc-live" role="status" aria-live="polite">${body}</span>
        ${extra}
        ${sheet(false)}
      </div>`;

const handle = `
      <div class="pgc-strip pgc-strip--handle" data-plugin="dsh-progress-caption">
        ${sheet(true)}
      </div>`;

const page = (theme) => `
  <section class="panel ${theme}">
    <h2>${theme === 'light' ? '浅色主题' : '深色主题'}</h2>
    <div class="dock">
${handle}
${strip('running', `
          <span class="pgc-step">第 3 步</span>
          <span class="pgc-loader" aria-hidden="true"><span class="pgc-dot"></span><span class="pgc-dot"></span><span class="pgc-dot"></span></span>
          <span class="pgc-label">正在执行命令 npm test</span>
          <span class="pgc-slot" aria-hidden="true"></span>
          <span class="pgc-flavor">琢磨中</span>`)}
${strip('ok', `
          <span class="pgc-step">第 4 步</span>
          <span class="pgc-loader" aria-hidden="true"><span class="pgc-dot"></span><span class="pgc-dot"></span><span class="pgc-dot"></span></span>
          <span class="pgc-label">命令完成 npm test</span>
          <span class="pgc-chip">成功</span>
          <span class="pgc-slot" aria-hidden="true"></span>`)}
${strip('error', `
          <span class="pgc-step">第 5 步</span>
          <span class="pgc-loader" aria-hidden="true"><span class="pgc-dot"></span><span class="pgc-dot"></span><span class="pgc-dot"></span></span>
          <span class="pgc-label">命令执行失败（exit code 1）</span>
          <span class="pgc-chip">失败</span>
          <span class="pgc-slot" aria-hidden="true"></span>`, `
        <details class="pgc-detail">
          <summary class="pgc-detail-sum">看原始报错</summary>
          <code class="pgc-raw">boom\n[exit code: 1]</code>
        </details>`)}
${strip('thinking', `
          <span class="pgc-step">第 2 步</span>
          <span class="pgc-loader" aria-hidden="true"><span class="pgc-dot"></span><span class="pgc-dot"></span><span class="pgc-dot"></span></span>
          <span class="pgc-text"><span class="pgc-label">翻一下配置文件</span></span>
          <span class="pgc-flavor">酝酿中</span>`)}
${strip('thinking', `
          <span class="pgc-step">第 6 步</span>
          <span class="pgc-loader" aria-hidden="true"><span class="pgc-dot"></span><span class="pgc-dot"></span><span class="pgc-dot"></span></span>
          <span class="pgc-text">
            <span class="pgc-label">看看配置里怎么写的</span>
            <span class="pgc-sub">先看 package.json 的入口，再决定改哪里</span>
          </span>
          <span class="pgc-slot" aria-hidden="true"></span>
          <span class="pgc-flavor">盘算中</span>`, '', 2)}
${strip('thinking', `
          <span class="pgc-step">第 7 步</span>
          <span class="pgc-loader" aria-hidden="true"><span class="pgc-dot"></span><span class="pgc-dot"></span><span class="pgc-dot"></span></span>
          <span class="pgc-text"><span class="pgc-label">npm test 跑完了 · 1.2s</span></span>
          <span class="pgc-flavor">缓口气</span>`)}
      <div class="pgc-summary"><span class="pgc-summary-text">本回合 · 3 次工具 · 2 成 1 败 · 用时 12.4s</span></div>
    </div>
    <p class="doc">主文案是一整句（动作 + 具体对象），状态靠左侧蓝点与右侧胶囊的双色表示；最后一条是空闲齿轮 + 展开的设置面板。</p>
  </section>`;

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>dsh-progress-caption 预览</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; padding: 28px; font: 14px/1.5 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; background: #eef0f4; color: #1f2328; }
  h1 { margin: 0 0 4px; font-size: 18px; }
  .hint { margin: 0 0 22px; font-size: 12.5px; opacity: .6; }
  .panels { display: grid; gap: 22px; grid-template-columns: repeat(auto-fit, minmax(430px, 1fr)); }
  .panel { border-radius: 18px; overflow: visible; box-shadow: 0 18px 40px -28px rgba(0,0,0,.5); }
  .panel h2 { margin: 0; padding: 10px 16px; font-size: 12px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; opacity: .6; }
  .dock { padding: 10px 0 26px; min-height: 660px; display: flex; flex-direction: column; justify-content: flex-end; }
  .doc { margin: 0; padding: 34px 16px 14px; font-size: 11.5px; opacity: .55; }
  .light {
    --dsw-alias-bg-base: #ffffff;
    --dsw-alias-bg-layer-1: #f6f7f9;
    --dsw-alias-bg-layer-2: #eceef2;
    --dsw-alias-bg-overlay: #ffffff;
    --dsw-alias-border-l1: rgba(15, 23, 42, .10);
    --dsw-alias-border-l2: rgba(15, 23, 42, .18);
    --dsw-alias-brand-primary: #4d6bfe;
    --dsw-alias-label-primary: #1f2328;
    --dsw-alias-label-secondary: #6b7280;
    --dsw-alias-state-success-primary: #2f9e68;
    --dsw-alias-state-error-primary: #d94a3d;
    background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary);
  }
  .dark {
    --dsw-alias-bg-base: #16181c;
    --dsw-alias-bg-layer-1: #1e2126;
    --dsw-alias-bg-layer-2: #24282e;
    --dsw-alias-bg-overlay: #22262c;
    --dsw-alias-border-l1: rgba(255, 255, 255, .14);
    --dsw-alias-border-l2: rgba(255, 255, 255, .22);
    --dsw-alias-brand-primary: #6d8dff;
    --dsw-alias-label-primary: #e6e8eb;
    --dsw-alias-label-secondary: #9aa3ad;
    --dsw-alias-state-success-primary: #4dc48a;
    --dsw-alias-state-error-primary: #ff6b5e;
    background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary);
  }
${css}
</style>
</head>
<body>
  <h1>dsh-progress-caption · 静态预览</h1>
  <p class="hint">这份 HTML 用的就是插件里的真 CSS；主题变量按 DSH 的浅/深两套取近似值。真实界面里颜色会跟着你的主题走。</p>
  <div class="panels">
${page('light')}
${page('dark')}
  </div>
</body>
</html>
`;

writeFileSync(path.join(root, 'preview.html'), html, 'utf8');
console.log('written:', path.join(root, 'preview.html'));
