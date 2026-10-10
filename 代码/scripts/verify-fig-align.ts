/**
 * verify-fig-align.ts — v5 配图位置（左/中/右）的**真实版面验证**
 *
 * 为什么单独写一个脚本：
 *   「图放得对不对」是版面问题，光看生成的 `.tex` 里写了 `[right]` 不算数 ——
 *   宏里 `\hfill` 的填充方向写反了照样能编译通过、错误行 0，但图会贴错边
 *   （我在实现时就把 center 的填充写反过一次，编译完全看不出问题）。
 *
 * 做法：
 *   1. 生成一个受控的最小文档：同一张图分别按 left / center / right 排三次
 *   2. 用 xelatex 编译
 *   3. 用 pdftotext -bbox 读出**图注「图N」的实际 x 坐标**
 *      （图注在图的正下方，它的横向位置就代表图的位置）
 *   4. 断言：左 ≈ 15%、中 ≈ 50%、右 ≈ 85% 的正文栏宽，且**依次递增**
 *
 * 用法：npx tsx scripts/verify-fig-align.ts
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import { execFileSync } from 'child_process';

// 模板目录的位置问应用自己要（v10 整理目录后它叫「模板」，在代码文件夹的上一层）
import { templatesRootDir } from '../src/lib/latexExport';

// ============================================================
// 现生成一张合法的 PNG（不依赖仓库里有没有图 / 也不塞 base64
// —— 手写 base64 很容易弄出坏文件，libpng 会直接报 IDAT 错）
// ============================================================

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** 一张 w×h 的纯灰 PNG。 */
function makePng(w: number, h: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor RGB
  const stride = w * 3 + 1; // 每行最前面一个 filter 字节
  const raw = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    const off = y * stride;
    raw[off] = 0; // filter: none
    for (let x = 0; x < w; x++) {
      raw[off + 1 + x * 3] = 190;
      raw[off + 2 + x * 3] = 190;
      raw[off + 3 + x * 3] = 190;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

const TEMPLATES = path.join(templatesRootDir(), '默认');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'quirex-figalign-'));

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`);
  }
}

/**
 * 从 pdftotext -bbox 的输出里取出「图N」的 x 坐标（pt）。
 *
 * 注意：图注是 `图\themafig`，pdftotext 会把「图」和「1」拆成**两个 word**，
 * 所以只能按 `>图<` 找，不能指望有 `>图1<` 这种整词。
 */
function captionXs(html: string): number[] {
  const out: number[] = [];
  const re = /<word xMin="([\d.]+)"[^>]*>图<\/word>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) out.push(parseFloat(m[1]));
  return out;
}

function main(): void {
  console.log(`临时目录：${TMP}\n`);

  // ---- 准备一个受控文档 ----
  // 用现生成的小图；三处 \fig 各按一种对齐排
  fs.mkdirSync(path.join(TMP, 'images'), { recursive: true });
  fs.writeFileSync(path.join(TMP, 'images', 'test-fig-01.png'), makePng(120, 90));
  fs.copyFileSync(path.join(TEMPLATES, 'quirex.sty'), path.join(TMP, 'quirex.sty'));

  const tex = `\\documentclass[11pt,a4paper]{book}
\\usepackage{quirex}
\\newcommand{\\handoutHeader}{}
\\presetStudent
\\compactLayout
\\raggedbottom
\\begin{document}
\\begin{exercise}[SS][left]
第一题（左）。
\\fig[0.3]{images/test-fig-01.png}
\\end{exercise}
\\begin{exercise}[SS][center]
第二题（中）。
\\fig[0.3]{images/test-fig-01.png}
\\end{exercise}
\\begin{exercise}[SS][right]
第三题（右）。
\\fig[0.3]{images/test-fig-01.png}
\\end{exercise}
\\end{document}
`;
  fs.writeFileSync(path.join(TMP, 'align.tex'), tex, 'utf-8');

  // ---- 编译（跑两遍，图号/引用才稳） ----
  const xelatex = process.env.XELATEX_PATH || 'xelatex';
  for (let i = 0; i < 2; i++) {
    execFileSync(xelatex, ['-interaction=nonstopmode', '-halt-on-error', 'align.tex'], {
      cwd: TMP,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }

  const log = fs.readFileSync(path.join(TMP, 'align.log'), 'utf-8');
  const errLines = log.split(/\r?\n/).filter((l) => l.startsWith('! '));
  check('受控文档编译 0 错误', errLines.length === 0, errLines.slice(0, 3).join(' / '));
  check('生成了 align.pdf', fs.existsSync(path.join(TMP, 'align.pdf')));

  // ---- 读出图注位置 ----
  execFileSync('pdftotext', ['-bbox', 'align.pdf', 'bbox.html'], { cwd: TMP, stdio: 'ignore' });
  const html = fs.readFileSync(path.join(TMP, 'bbox.html'), 'utf-8');

  // 顺便确认：第二个可选参数**没有**被当正文排出来
  check(
    '★ 对齐参数没被当成正文排出来（不应出现 left]/center]/right] 字样）',
    !/(^|>)(left|center|right)\]/.test(html),
    html.match(/[\w]*\]/g)?.slice(0, 8).join(' ')
  );

  const xs = captionXs(html);
  check('三个图注都读到了坐标', xs.length === 3, `读到 ${xs.length} 个：${xs.join(', ')}`);

  if (xs.length !== 3) {
    console.log('\n（图注坐标数量不对，后面的断言跳过）');
  } else {
    const [x1, x2, x3] = xs;
    const pageW = 595.28; // A4 宽度（pt）
    const toPct = (x: number) => ((x / pageW) * 100).toFixed(1);
    console.log(
      `      图注 x（pt）：左=${x1.toFixed(1)}  中=${x2.toFixed(1)}  右=${x3.toFixed(1)}` +
        `\n      占页宽：${toPct(x1)}% / ${toPct(x2)}% / ${toPct(x3)}%`
    );

    check('★ 三个位置依次递增（左 < 中 < 右）', x1 < x2 && x2 < x3, `${x1} / ${x2} / ${x3}`);
    check('★ 左对齐那张在左侧（< 40% 页宽）', x1 / pageW < 0.4, `${toPct(x1)}%`);
    check(
      '★ 居中那张在页面中部（42%~58% 页宽）',
      x2 / pageW > 0.42 && x2 / pageW < 0.58,
      `${toPct(x2)}%`
    );
    check('★ 右对齐那张在右侧（> 60% 页宽）', x3 / pageW > 0.6, `${toPct(x3)}%`);
    // 居中的意思就是「左右两张的中间」
    check(
      '★ 居中那张正好落在左右两张的中间（±12pt）',
      Math.abs((x1 + x3) / 2 - x2) < 12,
      `中点 ${((x1 + x3) / 2).toFixed(1)} vs 实际 ${x2.toFixed(1)}`
    );
  }

  console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
  if (fail > 0) {
    console.log('\n失败清单：');
    for (const f of failures) console.log(`  · ${f}`);
  }

  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    console.log(`\n临时目录未能清理（可手动删）：${TMP}`);
  }
  process.exit(fail > 0 ? 1 : 0);
}

main();
