/**
 * 离线测试 2：把「DSH 插件清单要求」写成可执行的检查表。
 * 不需要 DSH，只看文件本身：声明齐全、要发布的文件都在、图标和文案合法。
 *
 * 跑法：node --test test/
 */
import assert from 'node:assert/strict';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE_NAME = 'dsh-progress-caption';
const read = (rel) => readFile(path.join(ROOT, rel), 'utf8');
const exists = async (rel) => {
  try {
    await stat(path.join(ROOT, rel));
    return true;
  } catch {
    return false;
  }
};

const manifest = JSON.parse(await read('package.json'));

test('包身份：名字 / 版本 / 模块类型 / 许可', () => {
  assert.equal(manifest.name, PACKAGE_NAME);
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.type, 'module');
  assert.equal(manifest.license, 'MIT');
  assert.equal(typeof manifest.description, 'string');
  assert.ok(manifest.description.length > 20, 'description 要能让插件列表读懂');
});

test('exports 至少给出 . / ./client / ./icon / ./locale/*.json', () => {
  assert.equal(manifest.exports['.'], './index.js');
  assert.equal(manifest.exports['./client'], './client.js');
  assert.equal(manifest.exports['./icon'], './icon.svg');
  assert.equal(manifest.exports['./locale/*.json'], './locale/*.json');
});

test('dsh 声明：bundle 补丁 + web 客户端', () => {
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml');
  assert.equal(manifest.dsh.client.platform, 'web');
  assert.equal(manifest.dsh.client.immediately, true);
  assert.ok(Array.isArray(manifest.dsh.client.inject));
  assert.ok(manifest.dsh.client.inject.every((id) => typeof id === 'string' && id.startsWith('@deepseek-ai/')),
    'inject 只列官方客户端包');
  assert.ok(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-slots'));
  assert.ok(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-locale'));
});

test('cordis.patch.yml 插入一行，id 与包名要能对上', async () => {
  const patch = await read('cordis.patch.yml');
  assert.match(patch, /^- insert:/m);
  assert.match(patch, new RegExp('id: ' + PACKAGE_NAME));
  assert.match(patch, new RegExp("name: " + PACKAGE_NAME));
});

test('client.js 的 loader id 必须等于包名', async () => {
  const client = await read('client.js');
  const match = /window\.__ModuleLoader__\.load\(\{\s*\n\s*id:\s*'([^']+)'/.exec(client);
  assert.ok(match, 'client.js 必须以 __ModuleLoader__.load({ id, factory }) 开头');
  assert.equal(match[1], PACKAGE_NAME);
  assert.match(client, /factory\(require\)/);
  assert.match(client, /inject: \['slots', 'locale'\]/);
  assert.match(client, /\bapply,|\bapply\s*\}/, '必须导出 apply');
});

test('一个文件都不许漏进 files（发布/打包只带这些）', async () => {
  const declared = new Set(manifest.files);
  const expand = async (pattern) => {
    if (!pattern.includes('*')) return (await exists(pattern)) ? [pattern] : [];
    const dir = path.posix.dirname(pattern);
    const ext = path.posix.extname(pattern).replace('*', '');
    const names = await readdir(path.join(ROOT, dir));
    return names.filter((name) => name.endsWith(ext)).map((name) => dir + '/' + name);
  };
  const runtime = ['index.js', 'client.js', 'cordis.patch.yml', 'README.md', 'icon.svg', 'locale/*.json'];
  for (const pattern of runtime) {
    assert.ok(declared.has(pattern), 'files 里缺 ' + pattern);
    const found = await expand(pattern);
    assert.ok(found.length > 0, pattern + ' 匹配不到任何文件');
  }
});

test('显示元数据：中英 locale 都有 meta.title / meta.description', async () => {
  for (const lang of ['zh', 'en']) {
    const doc = JSON.parse(await read('locale/' + lang + '.json'));
    assert.equal(typeof doc.meta.title, 'string');
    assert.equal(typeof doc.meta.description, 'string');
    assert.ok(doc.meta.title.length > 0 && doc.meta.description.length > 0);
  }
});

test('图标：SVG、在包内、不超过 256 KiB', async () => {
  const info = await stat(path.join(ROOT, 'icon.svg'));
  assert.ok(info.size <= 256 * 1024, '图标必须 <= 256 KiB');
  const svg = await read('icon.svg');
  assert.match(svg, /^<svg[\s>]/);
  assert.match(svg, /<\/svg>\s*$/);
  assert.doesNotMatch(svg, /(href|src)\s*=\s*["']https?:/i, '图标不得引用外部资源');
});

test('README 存在且写了「不做什么」', async () => {
  const readme = await read('README.md');
  assert.match(readme, /不做/);
});
