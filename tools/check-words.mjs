// 一次性自检：词表中英对齐、无重复、无禁用词
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
function pick(name) {
  const start = src.indexOf('const ' + name + ' = [');
  if (start < 0) throw new Error('not found: ' + name);
  const open = src.indexOf('[', start);
  const close = src.indexOf('];', open);
  return src
    .slice(open + 1, close)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('//'))
    .join('\n')
    .split(',')
    .map((s) => s.trim().replace(/^'/, '').replace(/'$/, ''))
    .filter(Boolean);
}
const en = pick('WORDS_EN');
const zh = pick('WORDS_ZH');
const pad = (n) => String(n).padStart(3);
const ok = en.length === zh.length;
console.log('EN', en.length, 'ZH', zh.length, ok ? 'OK' : 'MISMATCH');
console.log('dupEN', en.length - new Set(en).size, 'dupZH', zh.length - new Set(zh).size);
if (!ok) {
  const worst = Math.max(en.length, zh.length);
  for (let i = 0; i < worst; i += 1) {
    if (en[i] !== undefined && zh[i] !== undefined) continue;
    console.log('错位从第', i + 1, '项开始：EN=', en[i], 'ZH=', zh[i]);
    break;
  }
}
zh.forEach((z, i) => console.log(pad(i + 1), (en[i] || '???').padEnd(22), z));
