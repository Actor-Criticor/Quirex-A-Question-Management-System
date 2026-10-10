/**
 * verify-v10-export.ts — 校验 v10 这一轮对「导出」的改动（不需要浏览器）
 *
 * 要证明的：
 *   1. **难度只出档位词**，标注行里不再出现「难度」两个字
 *   2. **创新是一颗五角星**（`$\bigstar$`），不再是「【创新】」三个字
 *   3. **题型标记不再是可选项**：多选题一律自带「（多选）」，
 *      `EXPORT_INFO_KEYS` 里没有 typeMark（勾选框从 7 个减到 6 个）
 *   4. **按题型分组**：章序固定 单选 → 多选 → 填空 → 解答，而且是**真导出一遍**
 *      拿 .tex 与日志验证（不是只看代码）
 *   5. 星号与（多选）在 PDF 里**没有丢字**（Missing character）
 *
 * 跑法：先 npm run dev，再 npx tsx scripts/verify-v10-export.ts
 * 导出到临时目录，不动你的 导出/。
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

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

const SRC = 'v10校验';

async function main(): Promise<void> {
  const types = await import('../src/lib/types');
  const label = await import('../src/lib/exportLabel');
  const service = await import('../src/lib/service');
  const { exportHandout } = await import('../src/lib/latexExport');
  const { DEFAULT_EXPORT_INFO, EXPORT_INFO_KEYS } = types;

  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'quirex-v10-export-'));
  process.env.EXPORT_DIR = path.join(TMP, '导出');

  const created: string[] = [];

  // ============================================================
  section('#1 标注行：难度只出档位词、创新不出文字');
  // ============================================================
  check(
    `选项只有 6 个，且没有 typeMark`,
    EXPORT_INFO_KEYS.length === 6 && !(EXPORT_INFO_KEYS as readonly string[]).includes('typeMark'),
    JSON.stringify(EXPORT_INFO_KEYS)
  );

  const base = {
    qid: 'AT9001',
    kind: '单题' as const,
    source: '25全国1',
    number: 1,
    difficulty: 0.94,
    year: 2025,
    knowledge: ['复数的实部与虚部'],
    status: '启用' as const,
    createdAt: '',
    updatedAt: '',
  };

  const full = label.buildInfoLabel(
    { ...base, type: '单选' },
    { ...DEFAULT_EXPORT_INFO, knowledge: true, year: true }
  );
  console.log(`      完整标注行：${full}`);
  check('★ 难度只写「基础」这种档位词，不写「难度 基础」', !!full && full.includes('基础') && !full.includes('难度'), String(full));
  check('来源与题号还是合成第一段（不分家）', !!full && /^25全国1 第1题/.test(full), String(full));
  check('年份照旧带「年份」前缀（只去掉了难度那个）', !!full && full.includes('年份 2025'), String(full));
  check('知识点照旧带前缀', !!full && full.includes('知识点 复数的实部与虚部'), String(full));
  for (const d of [0.94, 0.3, 0.1]) {
    const one = label.buildInfoLabel({ ...base, difficulty: d, type: '填空' }, DEFAULT_EXPORT_INFO);
    check(`难度 ${d} → 「${one}」（档位词，无「难度」二字）`, !!one && !one.includes('难度') && !/\d\.\d/.test(one), String(one));
  }
  const none = label.buildInfoLabel({ ...base, difficulty: undefined }, DEFAULT_EXPORT_INFO);
  check('没录难度时那一段直接不出现（不留空位）', none === '25全国1 第1题', String(none));

  // ============================================================
  section('#2 预览：创新是星、（多选）永远在');
  // ============================================================
  const pv1 = label.previewInfoLine({ ...base, type: '多选' }, DEFAULT_EXPORT_INFO);
  check('多选题的预览带 typeMark（不再看勾选，永远带）', pv1.typeMark === true, JSON.stringify(pv1));
  const pv2 = label.previewInfoLine({ ...base, type: '单选' }, DEFAULT_EXPORT_INFO);
  check('单选题不带', pv2.typeMark === false, JSON.stringify(pv2));
  const pv3 = label.previewInfoLine({ ...base, type: '多选', innovation: true }, DEFAULT_EXPORT_INFO);
  check('创新题的预览带 innovation 标记', pv3.innovation === true, JSON.stringify(pv3));
  const pv4 = label.previewInfoLine(
    { ...base, type: '单选' },
    { ...DEFAULT_EXPORT_INFO, innovation: false }
  );
  check('不勾创新就不带', pv4.innovation === false, JSON.stringify(pv4));

  // ============================================================
  section('#3 造 4 道不同类型 + 1 道创新 + 1 道多选，真导出一遍');
  // ============================================================
  const specs: Array<{ type: '单选' | '多选' | '填空' | '解答'; innovation?: boolean }> = [
    { type: '解答' }, // 故意先放解答：按题型分组时它必须排到最后
    { type: '多选', innovation: true },
    { type: '填空' },
    { type: '单选' },
  ];
  for (const [i, s] of specs.entries()) {
    const isChoice = s.type === '单选' || s.type === '多选';
    const r = await service.createQuestion({
      kind: '单题',
      type: s.type,
      source: SRC,
      number: i + 1,
      difficulty: 0.6,
      knowledge: ['v10 校验知识点'],
      innovation: s.innovation,
      stem: isChoice
        ? `$x+${i}$ 等于 \\pick\n\n\\begin{choices}\n  \\item $1$\n  \\item $2$\n  \\item $3$\n\\end{choices}`
        : `求 $x+${i}$ 的值 \\fillin`,
      answer: '答案是 $2$。',
    });
    created.push(r.qid);
  }
  check(`造了 ${created.length} 道题（含 1 道多选、1 道创新）`, created.length === 4, created.join(','));

  const res = await exportHandout({
    title: 'v10按题型分组',
    qids: created,
    options: { group: 'type', info: { ...DEFAULT_EXPORT_INFO, knowledge: true } },
  });
  check('按题型分组真导出了', res.count === 4, `count=${res.count}`);
  const tex = fs.readFileSync(path.join(res.outDir, '题目.tex'), 'utf-8');

  const sections = [...tex.matchAll(/\\section\{([^}]*)\}/g)].map((m) => m[1]);
  console.log(`      .tex 里的分节顺序：${sections.join(' → ')}`);
  check(
    '★★ 章序固定为 单选 → 多选 → 填空 → 解答（不管篮子里什么顺序）',
    JSON.stringify(sections) === JSON.stringify(['单选', '多选', '填空', '解答']),
    JSON.stringify(sections)
  );
  check(
    '★ 四类各自的题都在（没被漏掉）',
    tex.match(/\\begin\{exercise\}/g)?.length === 4,
    String(tex.match(/\\begin\{exercise\}/g)?.length)
  );

  // 标注行
  const qinfos = tex.match(/\\qinfo\{[^}]*\}/g) ?? [];
  console.log(`      标注行样例：${qinfos[0]}`);
  check('★ 标注行里没有「难度」两个字', qinfos.length > 0 && qinfos.every((q) => !q.includes('难度')), qinfos.slice(0, 3).join(' | '));
  check('★ 标注行里有档位词「基础」', qinfos.some((q) => /·\s*(基础|压轴|困难)\s*(·|\})/.test(q)), qinfos.slice(0, 3).join(' | '));

  // 星与（多选）
  check('★★ 创新用的是五角星 $\\bigstar$，不是「【创新】」', tex.includes('$\\bigstar$') && !tex.includes('【创新】'), tex.match(/.{0,30}bigstar.{0,20}/)?.[0]);
  check(
    '★★ 多选题自带「（多选）」（没有勾选项也带）',
    tex.includes('（多选）') && !tex.includes('(多选题)'),
    tex.match(/.{0,20}多选.{0,20}/)?.[0]
  );

  // ============================================================
  section('#4 编译真的干净（星号没丢字）');
  // ============================================================
  for (const role of ['题目', '答案'] as const) {
    const log = fs.readFileSync(path.join(res.outDir, `${role}.log`), 'utf-8');
    check(`★ ${role}.log 0 错误`, !/^! /m.test(log), (log.match(/^! .*/m) ?? [''])[0]);
    check(
      `★ ${role}.log 没有丢字（五角星与「（多选）」都排得出来）`,
      !log.includes('Missing character'),
      (log.match(/Missing character.*/g) ?? []).slice(0, 3).join(' | ')
    );
  }
  const pdfText = (await import('child_process')).execFileSync(
    'pdftotext',
    [path.join(res.outDir, '题目.pdf'), '-'],
    { encoding: 'utf-8', maxBuffer: 16 * 1024 * 1024 }
  );
  check('★ PDF 里能看到「（多选）」', pdfText.includes('（多选）'), pdfText.slice(0, 200).replace(/\n/g, ' '));
  check('★ PDF 里能看到档位词（基础/压轴/困难）', /基础|压轴|困难/.test(pdfText), pdfText.slice(0, 200).replace(/\n/g, ' '));
  check('★ PDF 里不再有「难度」两个字', !pdfText.includes('难度'), pdfText.match(/.{0,20}难度.{0,20}/)?.[0]);

  // ============================================================
  section('#5 另外三种分组照旧能用');
  // ============================================================
  for (const g of ['flat', 'knowledge', 'source'] as const) {
    const r = await exportHandout({ title: `v10分组-${g}`, qids: created, options: { group: g } });
    const t = fs.readFileSync(path.join(r.outDir, '题目.tex'), 'utf-8');
    const ok =
      g === 'flat'
        ? !/\\section\{|\\chapter\{/.test(t)
        : g === 'knowledge'
          ? /\\section\{v10 校验知识点\}/.test(t)
          : /\\chapter\{v10校验\}/.test(t);
    check(`分组「${g}」照旧生效`, ok, t.slice(0, 200).replace(/\n/g, ' '));
  }

  // 清理
  for (const q of created) {
    try {
      service.updateQuestion(q, { status: '停用' });
    } catch {
      /* 算了 */
    }
  }
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* 算了 */
  }
  console.log(`\n（已停用 ${created.length} 道校验题；临时导出目录已删）`);
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
