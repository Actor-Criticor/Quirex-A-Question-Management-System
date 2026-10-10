/**
 * verify-multi-template.ts — 校验「多套模板」这件事真的成立（v8b 新增）
 *
 * 光在设置页里看到三张卡片不算数。这里要证明的是：
 *   1. 三套模板**都能用**（各自真跑一次 xelatex，两份 PDF 都 0 错误）
 *   2. 选不同的模板，**出来的 PDF 真的不一样**（不是复制粘贴改了个名字）
 *   3. 双栏那套**真的是两栏**（量 PDF 里每行的宽度：两栏的行明显更窄）
 *
 * 第 3 条是重点：模板自己加的宏包、自己包的结构，导出程序管不着，
 * 所以只能拿编译出来的成品去量 —— 这也是唯一能证伪"假模板"的办法。
 *
 * 跑法：先 npm run dev（只用到它的题库），再 npx tsx scripts/verify-multi-template.ts
 * 导出到临时目录，不动你的 导出/。
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

const BASE = process.env.VERIFY_BASE ?? 'http://localhost:3000';

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    const line = detail ? `${name} — ${detail}` : name;
    failures.push(line);
    console.log(`  ✗ ${line}`);
  }
}

function section(t: string): void {
  console.log(`\n=== ${t} ===`);
}

/** PDF 里所有词的包围盒 */
interface Word {
  xMin: number;
  xMax: number;
  yMin: number;
}

function pdfWords(pdfPath: string): Word[] {
  const xml = execFileSync('pdftotext', ['-bbox', pdfPath, '-'], {
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const out: Word[] = [];
  for (const m of xml.matchAll(
    /<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)"/g
  )) {
    out.push({ xMin: Number(m[1]), yMin: Number(m[2]), xMax: Number(m[3]) });
  }
  return out;
}

/**
 * 每行宽度（同一行 = yMin 接近的那些词）的中位数。
 * 单栏的正文行接近整版宽；两栏的行只有一半多一点 —— 这是判断"真两栏"的硬指标。
 */
/**
 * 「像不像两栏」的判据：**每行的起点 x 分布**。
 *
 * 一开始我去量"行宽中位数"，那是错的 —— 行宽由**内容多长**决定，跟栏宽没关系：
 * 题目本身很短时，单栏的绝大多数行也只有一百来点宽，看起来跟两栏差不多。
 * 真正能区分的是起点：单栏的每一行都从左边距开始（一个簇），
 * 两栏则有一半的行从页面中间那条分栏线右侧开始（第二个簇）。
 *
 * 返回：起点落在"页面右半边"的行占比。
 */
function rightHalfLineRatio(words: Word[]): number {
  if (words.length === 0) return 0;
  const lines = new Map<number, number>(); // y → 起点 x
  let maxRight = 0;
  for (const w of words) {
    const key = Math.round(w.yMin / 3);
    lines.set(key, Math.min(lines.get(key) ?? Number.POSITIVE_INFINITY, w.xMin));
    maxRight = Math.max(maxRight, w.xMax);
  }
  const mid = maxRight / 2;
  const starts = [...lines.values()];
  const right = starts.filter((x) => x > mid).length;
  return right / starts.length;
}

function medianLineWidth(words: Word[]): number {
  const lines = new Map<number, { min: number; max: number }>();
  for (const w of words) {
    const key = Math.round(w.yMin / 3); // 3pt 内的词算同一行
    const cur = lines.get(key);
    if (!cur) lines.set(key, { min: w.xMin, max: w.xMax });
    else {
      cur.min = Math.min(cur.min, w.xMin);
      cur.max = Math.max(cur.max, w.xMax);
    }
  }
  const widths = [...lines.values()].map((l) => l.max - l.min).sort((a, b) => a - b);
  if (widths.length === 0) return 0;
  return widths[Math.floor(widths.length / 2)];
}

async function main(): Promise<void> {
  const { listTemplateInfos } = await import('../src/lib/templates');
  const { templatesRootDir, exportHandout } = await import('../src/lib/latexExport');
  const { listQidFolders } = await import('../src/lib/paths');

  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'quirex-multi-tpl-'));
  const realRoot = templatesRootDir();
  process.env.EXPORT_DIR = path.join(TMP, '导出');

  try {
    // ============================================================
    section('#1 模板目录里确实有多套，而且都能用');
    // ============================================================
    const infos = listTemplateInfos(realRoot);
    check('模板根目录里有多于一套模板', infos.length >= 2, `${infos.length} 套`);
    for (const t of infos) {
      check(
        `「${t.id}」可用（显示名「${t.manifest?.name ?? '?'}」）`,
        t.usable,
        t.issues.join(' | ')
      );
    }
    check(
      '★ 三套的显示名各不相同（导出弹窗里要能分辨）',
      new Set(infos.map((t) => t.manifest?.name)).size === infos.length,
      infos.map((t) => `${t.id}→${t.manifest?.name}`).join('，')
    );
    check(
      '★ 各有自己的描述（弹窗里会显示）',
      infos.every((t) => (t.manifest?.description ?? '').length > 5),
      infos.map((t) => t.id).join(',')
    );

    // 顺便验接口也认
    const r = await fetch(`${BASE}/api/export/templates`, { cache: 'no-store' });
    const d = (await r.json()) as { usableIds?: string[]; templates?: unknown[] };
    check(
      `★ /api/export/templates 列出全部 ${infos.length} 套、都可用`,
      r.status === 200 && (d.templates?.length ?? 0) === infos.length && (d.usableIds?.length ?? 0) === infos.length,
      `status=${r.status} templates=${d.templates?.length} usable=${d.usableIds?.length}`
    );

    // ============================================================
    section('#2 每套都真导一次、真编译一遍');
    // ============================================================
    const qids = listQidFolders().slice(0, 4);
    check('题库里有题可导', qids.length >= 2, JSON.stringify(qids));

    interface Result {
      id: string;
      name: string;
      dir: string;
      pdfSize: number;
      medianLine: number;
      rightRatio: number;
      pages: number;
      styleCopied: string[];
    }
    const results: Result[] = [];

    for (const t of infos) {
      const res = await exportHandout({
        title: `多模板验证-${t.id}`,
        qids,
        options: { template: t.id },
      });
      const files = fs.readdirSync(res.outDir);
      const styles = t.manifest?.styleFiles ?? [];
      const styleCopied = styles.filter((f) => files.includes(f));

      check(`「${t.id}」导出成功`, res.count > 0, `count=${res.count}`);
      check(
        `「${t.id}」的样式文件被复制进导出目录（${styles.join('、')}）`,
        styleCopied.length === styles.length,
        files.join(',')
      );

      const tex = fs.readFileSync(path.join(res.outDir, '题目.tex'), 'utf-8');
      check(`「${t.id}」生成的 tex 没有残留占位符`, !/\{\{[A-Z]+\}\}/.test(tex));
      check(`「${t.id}」生成的 tex 没有残留注释行`, !/^\s*%%\s*Quirex/m.test(tex));

      for (const role of ['题目', '答案'] as const) {
        const log = fs.readFileSync(path.join(res.outDir, `${role}.log`), 'utf-8');
        check(
          `★ 「${t.id}」${role}.log 0 错误`,
          !/^! /m.test(log),
          (log.match(/^! .*/m) ?? [''])[0]
        );
        check(
          `★ 「${t.id}」${role}.log 没有丢字`,
          !log.includes('Missing character'),
          (log.match(/Missing character.*/g) ?? []).slice(0, 2).join(' | ')
        );
      }

      const pdf = path.join(res.outDir, '题目.pdf');
      check(`「${t.id}」生成了 题目.pdf`, fs.existsSync(pdf));
      const size = fs.statSync(pdf).size;
      const words = pdfWords(pdf);
      const pages = Number(
        execFileSync('pdfinfo', [pdf], { encoding: 'utf-8' }).match(/^Pages:\s+(\d+)/m)?.[1] ?? 0
      );
      const median = medianLineWidth(words);
      const rightRatio = rightHalfLineRatio(words);

      console.log(
        `      ${t.id.padEnd(6)} 题目.pdf ${size} 字节 · ${pages} 页 · 行宽中位数 ${median.toFixed(0)}pt · 起点在右半边的行 ${(rightRatio * 100).toFixed(0)}%`
      );
      results.push({ id: t.id, name: t.manifest?.name ?? t.id, dir: res.outDir, pdfSize: size, medianLine: median, pages, rightRatio, styleCopied });
    }

    // ============================================================
    section('#3 ★ 换模板，出来的 PDF 真的不一样');
    // ============================================================
    const sizes = results.map((r) => r.pdfSize);
    check(
      '★ 三套产出的 PDF 字节数两两不同（不是同一份东西换了个名字）',
      new Set(sizes).size === sizes.length,
      results.map((r) => `${r.id}=${r.pdfSize}`).join(' ')
    );

    // 两栏那套：应该有一大批行的起点落在页面右半边
    const twoCol = results.find((r) => r.id === '双栏试卷');
    const single = results.find((r) => r.id === '默认');
    const narrow = results.find((r) => r.id === '紧凑题单');
    if (twoCol && single) {
      check(
        `★ 双栏那套确实是两栏：${(twoCol.rightRatio * 100).toFixed(0)}% 的行从右半边开始`,
        twoCol.rightRatio >= 0.25,
        `双栏=${(twoCol.rightRatio * 100).toFixed(0)}%`
      );
      check(
        `★ 单栏那套不是两栏：只有 ${(single.rightRatio * 100).toFixed(0)}% 的行从右半边开始（那是居中标题）`,
        single.rightRatio <= 0.2,
        `单栏=${(single.rightRatio * 100).toFixed(0)}%`
      );
      check(
        '★ 两者的分栏特征差得很明显（不是噪声）',
        twoCol.rightRatio > single.rightRatio * 2,
        `${(twoCol.rightRatio * 100).toFixed(0)}% vs ${(single.rightRatio * 100).toFixed(0)}%`
      );
    } else {
      check('找到「双栏试卷」与「默认」两套', false, results.map((r) => r.id).join(','));
    }
    if (narrow && single) {
      check(
        `紧凑题单是单栏（起点在右半边的行 ${(narrow.rightRatio * 100).toFixed(0)}%）`,
        narrow.rightRatio <= 0.2,
        `${(narrow.rightRatio * 100).toFixed(0)}%`
      );
    }

    // ============================================================
    section('#4 每套模板的产物是自包含的');
    // ============================================================
    for (const r of results) {
      const tex = fs.readFileSync(path.join(r.dir, '题目.tex'), 'utf-8');
      const sty = r.styleCopied[0] ?? '';
      check(
        `「${r.id}」的 tex 里引用的样式与复制进来的一致（${sty}）`,
        sty !== '' && tex.includes(`\\usepackage{${path.basename(sty, '.sty')}}`),
        sty
      );
      check(`「${r.id}」目录里有 build.bat / build.sh`, fs.existsSync(path.join(r.dir, 'build.bat')) && fs.existsSync(path.join(r.dir, 'build.sh')));
    }
  } finally {
    try {
      fs.rmSync(TMP, { recursive: true, force: true });
    } catch {
      /* 临时目录删不掉无所谓 */
    }
  }
}

main()
  .then(() => {
    console.log(`\n${'='.repeat(56)}`);
    console.log(`通过 ${pass}，失败 ${fail}`);
    if (failures.length) {
      console.log('\n失败项：');
      for (const f of failures) console.log(`  · ${f}`);
    }
    process.exit(fail === 0 ? 0 : 1);
  })
  .catch((e) => {
    console.error('\n脚本自身出错：', e);
    process.exit(1);
  });
