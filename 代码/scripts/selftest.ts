/**
 * selftest.ts — 第 1 步「地基」的自测脚本
 *
 * 在临时题库里真实建题、改标签、跑检索，验证方案里写死的边界条件：
 *   · 题号 1 / 30 合法，0 / 31 报错，T3 → 3，第12题 → 12
 *   · 难度 0.01 / 0.99 合法，0 / 1 / 94 的处理，留空合法
 *   · 整卷 searchText 恒为空（描述不进搜索）
 *   · qid 从 T0001 起严格递增；失败不占号
 *   · 标签停用后不进联想表，但手打关键字仍能搜到
 *   · 标签改名会改题目文件并留下备份
 *
 * 运行：npx tsx scripts/selftest.ts
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

import * as service from '../src/lib/service';
import {
  parseNumberField,
  parseDifficultyField,
  validateNumber,
  validateDifficulty,
  difficultyToBand,
  difficultyText,
  normalizeInnovation,
} from '../src/lib/validate';
import {
  isQuestionId,
  isQidName,
  listQidFolders,
  numberToQid,
  paperNumberToId,
  qidToNumber,
  backupsDir,
  questionDir,
} from '../src/lib/paths';
import { parseQid, displayQid, subjectLetterOf } from '../src/lib/types';
import * as store from '../src/lib/store';
import { loadIndex } from '../src/lib/searchIndex';
import { renderLatex, isImageOnly } from '../src/lib/latexRender';
import { lintLatex, countFigures, parseWidth, stripLatex, splitBlocks, buildTabular } from '../src/lib/latexSubset';
import { composeStemTex, splitOptionsFromStem, composeAnswer, parseAnswerLetters, hasImageMarkers } from '../src/lib/latexCompose';
import { templatesRootDir } from '../src/lib/latexExport';
import { isolateVault } from './isolate';
import {
  DEFAULT_FIG_ALIGN,
  FIG_ALIGNS,
  FIG_ALIGN_CLASS,
  FIG_ALIGN_TEX,
  isFigAlign,
  resolveFigAlign,
} from '../src/lib/types';

// 必须先指向临时题库，再调用任何存储函数
const TMP = path.join(os.tmpdir(), `quirex-selftest-${Date.now()}`);
process.env.VAULT_PATH = TMP;
// 光设环境变量不够：config.json 的优先级更高（见 isolate.ts 里的说明）
isolateVault(TMP);

// ============================================================
// 迷你断言框架
// ============================================================

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

function eq<T>(name: string, actual: T, expected: T): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  check(name, a === b, `期望 ${b}，实际 ${a}`);
}

function section(title: string): void {
  console.log(`\n=== ${title} ===`);
}

const PDF_BUF = Buffer.from('%PDF-1.4\n% selftest\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n');

async function main(): Promise<void> {
  console.log(`临时题库：${TMP}`);
  service.ensureWorkspace();

  // ==========================================================
  section('1. 题号校验（只读数字，1–30）');
  // ==========================================================
  eq('"1" → 1', parseNumberField('1').value, 1);
  eq('"30" → 30', parseNumberField('30').value, 30);
  eq('"T3" → 3', parseNumberField('T3').value, 3);
  eq('"第12题" → 12', parseNumberField('第12题').value, 12);
  eq('"T3." → 3', parseNumberField('T3.').value, 3);
  eq('"" → null（允许留空）', parseNumberField('').value, null);
  check('"31" 报错', !!parseNumberField('31').error, JSON.stringify(parseNumberField('31')));
  check('"0" 报错', !!parseNumberField('0').error);
  check('"abc" 报错（没有数字）', !!parseNumberField('abc').error);
  check('validateNumber(30) 通过', validateNumber(30) === null);
  check('validateNumber(31) 拦截', validateNumber(31) !== null);

  // ==========================================================
  section('2. 难度校验（只读数字，0.01–0.99 或留空）');
  // ==========================================================
  eq('"0.01" → 0.01', parseDifficultyField('0.01').value, 0.01);
  eq('"0.99" → 0.99', parseDifficultyField('0.99').value, 0.99);
  eq('"0.5" → 0.5', parseDifficultyField('0.5').value, 0.5);
  eq('"" → null（未录入）', parseDifficultyField('').value, null);
  check('"0" 报错（0 不再是"没填"的表示）', !!parseDifficultyField('0').error);
  check('"1" 报错', !!parseDifficultyField('1').error);
  check('"1.0" 报错', !!parseDifficultyField('1.0').error);
  const d94 = parseDifficultyField('94');
  check('"94" 报错但不自动改', !!d94.error, JSON.stringify(d94));
  check('"94" 给出"是否按 0.94"提示', !!d94.hint && d94.hint.includes('0.94'), d94.hint);
  const d944 = parseDifficultyField('0.944');
  eq('"0.944" 四舍五入为 0.94', d944.value, 0.94);
  check('"0.944" 带四舍五入提示', !!d944.hint, d944.hint);
  check('validateDifficulty(0.99) 通过', validateDifficulty(0.99) === null);
  check('validateDifficulty(1) 拦截', validateDifficulty(1) !== null);

  // ---- v2：难度固定档位（左闭右开）----
  eq('档位：0.94 → 基础', difficultyToBand(0.94), '基础');
  eq('档位边界 0.50 → 基础（不是压轴）', difficultyToBand(0.5), '基础');
  eq('档位：0.49 → 压轴', difficultyToBand(0.49), '压轴');
  eq('档位边界 0.25 → 压轴（不是困难）', difficultyToBand(0.25), '压轴');
  eq('档位：0.24 → 困难', difficultyToBand(0.24), '困难');
  eq('档位：0.01 → 困难', difficultyToBand(0.01), '困难');
  eq('档位上限 0.99 → 基础', difficultyToBand(0.99), '基础');
  eq('档位：留空 → null', difficultyToBand(undefined), null);
  eq('难度显示文案：0.62 → 基础', difficultyText(0.62), '0.62 基础');
  eq('难度显示文案：0.40 → 压轴', difficultyText(0.4), '0.40 压轴');
  eq('难度显示文案：0.10 → 困难', difficultyText(0.1), '0.10 困难');
  eq('难度未录入的文案', difficultyText(undefined), '未录入');
  eq('创新标记规范化：true', normalizeInnovation(true), true);
  eq('创新标记规范化："是"', normalizeInnovation('是'), true);
  eq('创新标记规范化：false', normalizeInnovation(false), false);
  eq('创新标记规范化：undefined', normalizeInnovation(undefined), false);

  // ==========================================================
  section('3. qid 顺序分配（T0001 起，失败不占号）');
  // ==========================================================
  eq('空库下一个号 = T0001', service.nextQidPreview(), 'AT0001');

  // 先制造一次失败：整卷缺题目 PDF，应当抛错且不占号
  let threw = false;
  try {
    await service.createQuestion({ kind: '整卷', source: '25全国2' });
  } catch {
    threw = true;
  }
  check('整卷缺 PDF 被拦下', threw);
  eq('失败后下一个号仍是 T0001（未占号）', service.nextQidPreview(), 'AT0001');
  eq('失败后题库里没有目录', listQidFolders().length, 0);

  // ==========================================================
  section('4. 创建单题');
  // ==========================================================
  const q1 = await service.createQuestion({
    kind: '单题',
    type: '单选',
    source: '25全国1',
    number: 'T1',
    difficulty: '0.94',
    knowledge: ['复数的实部与虚部', '复数代数形式的乘法运算'],
    description: '复数为背景的送分题，用来巩固虚部定义',
    stem: '$(1+5\\mathrm{i})\\mathrm{i}$ 的虚部为 \\pick\n\n\\begin{choices}\n  \\item $-1$\n  \\item $0$\n  \\item $1$\n  \\item $6$\n\\end{choices}',
    answer: 'C。因为 $(1+5i)i=i+5i^{2}=-5+i$，所以虚部为 $1$。',
  });
  eq('第一题 qid = T0001', q1.qid, 'AT0001');

  const f1 = service.getQuestion('AT0001');
  eq('kind = 单题', f1.meta.kind, '单题');
  eq('type = 单选', f1.meta.type, '单选');
  eq('number = 1（T1 已转数字）', f1.meta.number, 1);
  eq('difficulty = 0.94', f1.meta.difficulty, 0.94);
  eq('source 保留', f1.meta.source, '25全国1');
  eq('知识点 2 个', f1.meta.knowledge?.length, 2);
  eq('status = 启用', f1.meta.status, '启用');
  check('题干.tex 已落盘', fs.existsSync(path.join(questionDir('AT0001'), '题干.tex')));
  check('答案.tex 已落盘', fs.existsSync(path.join(questionDir('AT0001'), '答案.tex')));
  check('元数据 md 已落盘', fs.existsSync(path.join(questionDir('AT0001'), 'AT0001.md')));
  check('题干内容含 \\pick', f1.stem.includes('\\pick'));
  eq('下一个号 = T0002', service.nextQidPreview(), 'AT0002');

  const q2 = await service.createQuestion({
    kind: '单题',
    type: '填空',
    source: '25全国1',
    number: '3',
    difficulty: '', // 留空 = 未录入
    knowledge: ['复数的实部与虚部'],
    description: '填空题：难度留空，验证可空',
    stem: '函数 $f(x)=x^2$ 的最小值为 \\fillin',
    answer: '$0$',
  });
  eq('第二题 qid = T0002', q2.qid, 'AT0002');
  const f2 = service.getQuestion('AT0002');
  check('难度留空时 meta 里没有 difficulty', f2.meta.difficulty === undefined);
  eq('未录入难度的档位 = null', difficultyToBand(f2.meta.difficulty), null);

  // ==========================================================
  section('5. 创建整卷（PDF + 字段矩阵）');
  // ==========================================================
  const q3 = await service.createQuestion({
    kind: '整卷',
    source: '25全国2',
    difficulty: '0.62',
    // 故意传入整卷不该有的字段，应当被忽略
    type: '解答',
    number: '7',
    knowledge: ['不该出现的知识点'],
    description:
      '2025 全国二卷完整卷。描述里故意写「复数」和唯一标记词ALPHAX，用来验证它们都不会进搜索索引。'.repeat(8),
    pdf: { paper: PDF_BUF, answer: PDF_BUF },
  });
  eq('第三题（试卷）拿到独立 id P001', q3.qid, 'AP001');

  const f3 = service.getQuestion('AP001');
  eq('kind = 整卷', f3.meta.kind, '整卷');
  check('整卷没有题型', f3.meta.type === undefined);
  check('整卷没有题号', f3.meta.number === undefined);
  check('整卷没有知识点', f3.meta.knowledge === undefined);
  eq('整卷保留来源', f3.meta.source, '25全国2');
  eq('整卷保留难度', f3.meta.difficulty, 0.62);
  check('整卷没有题干文本', f3.stem === '');
  check('题目.pdf 已落盘', fs.existsSync(path.join(questionDir('AP001'), '题目.pdf')));
  check('答案.pdf 已落盘', fs.existsSync(path.join(questionDir('AP001'), '答案.pdf')));
  eq('pdfs 列出 2 个', f3.pdfs.length, 2);

  // 非 PDF 内容必须被拦住
  threw = false;
  try {
    await service.createQuestion({
      kind: '整卷',
      source: '25全国3',
      pdf: { paper: Buffer.from('这不是 PDF') },
    });
  } catch {
    threw = true;
  }
  check('假 PDF（魔数不对）被拦下', threw);
  // v2：试卷占的是 P 系列，回滚后不影响单题的号
  eq('被拦下后没占号（单题下一个仍是 AT0003）', service.nextQidPreview(), 'AT0003');
  eq('试卷下一个 = AP002（失败那次没占号；AP001 已被成功创建）', service.nextIdPreview('整卷'), 'AP002');

  eq('qid 目录共 3 个', listQidFolders().length, 3);

  // ==========================================================
  section('6. 索引：整卷 searchText 恒为空');
  // ==========================================================
  const index = loadIndex();
  eq('索引 3 条', index.length, 3);
  const e1 = index.find((e) => e.qid === 'AT0001')!;
  const e3 = index.find((e) => e.qid === 'AP001')!;
  check('单题 searchText 非空', e1.searchText.length > 0);
  check('单题 searchText 已去掉 LaTeX 命令', !e1.searchText.includes('\\pick'), e1.searchText);
  check('单题 searchText 含题干中文', e1.searchText.includes('虚部'), e1.searchText);
  eq('整卷 searchText 为空字符串', e3.searchText, '');
  check('整卷描述进不了 searchText', !e3.searchText.includes('复数'));
  check(
    '索引里描述只存截断预览（≤201 字）',
    (e3.descPreview ?? '').length <= 201,
    `实际 ${(e3.descPreview ?? '').length}`
  );
  check(
    '完整描述仍在 md 里（长于预览上限，说明只是索引截断、存储未截断）',
    (f3.meta.description ?? '').length > 201,
    `实际 ${(f3.meta.description ?? '').length} 字`
  );

  // ==========================================================
  section('7. 检索');
  // ==========================================================
  // 用 qid 集合做精确断言，而不是只比数量 —— 这样才能真正证明「哪些题被命中」
  const qidsOf = (p: Parameters<typeof service.searchQuestions>[0]): string[] =>
    service.searchQuestions(p).items.map((e) => e.qid);

  // 注意：T0001 与 T0002 的知识点标签里都含「复数」「虚部」，所以两路都会命中
  eq('搜「虚部」→ T0001、T0002', qidsOf({ q: '虚部' }), ['AT0001', 'AT0002']);
  eq('搜「复数」→ T0001、T0002', qidsOf({ q: '复数' }), ['AT0001', 'AT0002']);
  check(
    '★ 搜「复数」不含整卷 P001 —— 描述不进搜索索引',
    !qidsOf({ q: '复数' }).includes('AP001')
  );
  eq(
    '★ 搜只出现在整卷描述里的唯一标记词 → 0 条',
    qidsOf({ q: '唯一标记词ALPHAX' }),
    []
  );
  eq(
    '搜来源「全国」→ 三条全部走标签路命中（含整卷）',
    qidsOf({ q: '全国' }),
    ['AT0001', 'AT0002', 'AP001']
  );
  eq('按 kind=整卷 筛选', qidsOf({ kind: '整卷' }), ['AP001']);
  eq('按 kind=单题 筛选', qidsOf({ kind: '单题' }), ['AT0001', 'AT0002']);
  eq('按 type=单选 筛选', qidsOf({ type: '单选' }), ['AT0001']);
  eq(
    '题号范围 1–2（T0002 的题号是 3，不在范围内）',
    qidsOf({ numMin: 1, numMax: 2 }),
    ['AT0001']
  );
  eq('题号范围 2–30 → 只有 T0002', qidsOf({ numMin: 2, numMax: 30 }), ['AT0002']);
  eq(
    '不设范围时未录入难度的题不被排除',
    qidsOf({ kind: '单题' }),
    ['AT0001', 'AT0002']
  );
  eq('难度范围 0.9–0.99', qidsOf({ diffMin: 0.9, diffMax: 0.99 }), ['AT0001']);
  eq(
    '知识点多选是 OR（两个知识点 → 两题都命中）',
    qidsOf({ knowledge: ['复数的实部与虚部', '复数代数形式的乘法运算'] }),
    ['AT0001', 'AT0002']
  );
  eq('知识点命中不存在的词 → 0 条', qidsOf({ knowledge: ['不存在的知识点'] }), []);
  eq(
    '关键字空格分词 = AND（虚部 + 来源）',
    qidsOf({ q: '虚部 25全国1' }),
    ['AT0001', 'AT0002']
  );
  eq('关键字 AND 一真一假 → 0 条', qidsOf({ q: '虚部 不存在的词' }), []);

  // ==========================================================
  section('8. 标签表：派生 / 停用 / 恢复');
  // ==========================================================
  let vocab = service.listTags(false);
  const srcNames = vocab.source.map((t) => t.name);
  check('来源含 25全国1', srcNames.includes('25全国1'), JSON.stringify(srcNames));
  check('来源含 25全国2', srcNames.includes('25全国2'));
  const kpNames = vocab.knowledge.map((t) => t.name);
  eq('知识点 2 个', kpNames.length, 2);
  eq(
    '知识点引用计数正确',
    vocab.knowledge.find((t) => t.name === '复数的实部与虚部')?.count,
    2
  );
  check(
    '整卷的知识点没混进来',
    !kpNames.includes('不该出现的知识点'),
    JSON.stringify(kpNames)
  );

  // 停用来源「25全国2」（整卷在用）
  service.retireTag('source', '25全国2');
  vocab = service.listTags(false);
  check(
    '停用后不在联想表里',
    !vocab.source.map((t) => t.name).includes('25全国2'),
    JSON.stringify(vocab.source.map((t) => t.name))
  );
  const vocabAll = service.listTags(true);
  const retiredItem = vocabAll.source.find((t) => t.name === '25全国2');
  check('「显示已停用」能看到它', !!retiredItem);
  check('且标记为 retired', retiredItem?.retired === true);
  eq('引用计数仍保留（题目上的值没被改）', retiredItem?.count, 1);
  eq(
    '题目上的来源值原样保留',
    service.getMeta('AP001')?.source,
    '25全国2'
  );
  eq(
    '手打关键字仍能搜到被停用的标签（2 条）',
    service.searchQuestions({ q: '25全国2' }).total,
    1
  );

  service.restoreTag('source', '25全国2');
  vocab = service.listTags(false);
  check(
    '恢复后重新出现在联想表里',
    vocab.source.map((t) => t.name).includes('25全国2')
  );

  // ==========================================================
  section('9. 标签改名（撞名即合并，带备份）');
  // ==========================================================
  const preview = service.previewRename('knowledge', '复数代数形式的乘法运算', '复数乘法运算');
  eq('预览：受影响 1 道题', preview.affected.length, 1);
  check('预览：不是合并（目标名还没人用）', preview.merging === false);

  const renameRes = service.renameTag('knowledge', '复数代数形式的乘法运算', '复数乘法运算');
  eq('改名影响 1 道题', renameRes.changed, 1);
  eq(
    '题目上的知识点已更新',
    JSON.stringify(service.getMeta('AT0001')?.knowledge),
    JSON.stringify(['复数的实部与虚部', '复数乘法运算'])
  );
  check('留下了备份', service.listBackups().length >= 1);
  eq(
    '新名字可搜到',
    service.searchQuestions({ knowledge: ['复数乘法运算'] }).total,
    1
  );

  // 还原备份
  const backupId = service.listBackups()[0].id;
  const restored = service.restoreBackup(backupId);
  eq('从备份还原 1 道题', restored.restored, 1);
  eq(
    '知识点还原为原名',
    JSON.stringify(service.getMeta('AT0001')?.knowledge),
    JSON.stringify(['复数的实部与虚部', '复数代数形式的乘法运算'])
  );

  // ==========================================================
  section('10. 状态：停用题目（替代删除）');
  // ==========================================================
  service.setStatus('AT0002', '停用');
  eq('默认搜索不含停用题', service.searchQuestions({ kind: '单题' }).total, 1);
  eq(
    'status=全部 时含停用题',
    service.searchQuestions({ kind: '单题', status: '全部' }).total,
    2
  );
  eq('停用不改变 qid', service.getMeta('AT0002')?.qid, 'AT0002');
  check('停用后文件仍在（题目不可删除）', store.questionExists('AT0002'));
  service.setStatus('AT0002', '启用');
  eq('恢复启用后又能搜到', service.searchQuestions({ kind: '单题' }).total, 2);

  // ==========================================================
  section('11. 图片四通道');
  // ==========================================================
  const img = service.addImage('AT0001', 'fig', Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  eq('示意图文件名带 qid 与通道前缀', img.name, 'AT0001-fig-01.png');
  const img2 = service.addImage('AT0001', 'fig', Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  eq('同通道第二张自增为 02', img2.name, 'AT0001-fig-02.png');
  const imgStem = service.addImage('AT0001', 'stem', Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  eq('题干图走 A 通道', imgStem.name, 'AT0001-stem-01.png');

  let imgThrew = false;
  try {
    service.addImage('AP001', 'fig', Buffer.from([0x89]));
  } catch {
    imgThrew = true;
  }
  check('整卷不允许图片通道', imgThrew);

  eq('图片素材共 3 个', service.getQuestion('AT0001').assets.length, 3);
  check('删除图片成功', service.deleteAsset('AT0001', 'AT0001-fig-02.png'));
  eq('删除后剩 2 个', service.getQuestion('AT0001').assets.length, 2);
  check('重复删除返回 false', service.deleteAsset('AT0001', 'AT0001-fig-02.png') === false);
  check(
    '拒绝路径穿越',
    service.deleteAsset('AT0001', '../../T0002.md') === false
  );

  // ==========================================================
  section('12. 其它');
  // ==========================================================
  // 描述不设上限
  const longDesc = '描述'.repeat(3000);
  await service.createQuestion({
    kind: '单题',
    type: '解答',
    source: '25全国1',
    number: 5,
    description: longDesc,
    stem: 'x',
  });
  eq('超长描述完整存下（6000 字）', service.getMeta('AT0003')?.description?.length, 6000);

  // 题型必填
  threw = false;
  try {
    await service.createQuestion({ kind: '单题', source: '25全国1' });
  } catch {
    threw = true;
  }
  check('单题不选题型被拦下', threw);

  // 题型无效值
  threw = false;
  try {
    await service.createQuestion({ kind: '单题', type: '判断题', source: 'x' });
  } catch {
    threw = true;
  }
  check('题型只接受四枚举', threw);

  eq('最终题目目录共 4 个（3 单题 + 1 试卷）', listQidFolders().length, 4);
  eq('单题下一个号 = AT0004', service.nextQidPreview(), 'AT0004');
  eq('试卷下一个号 = AP002', service.nextIdPreview('整卷'), 'AP002');

  // 索引与目录一致
  const finalIndex = loadIndex();
  eq('索引条数与目录数一致', finalIndex.length, listQidFolders().length);

  // ==========================================================
  section('13. 录入规范化（结构化输入 → 唯一 LaTeX 真源）');
  // ==========================================================
  const c1 = composeStemTex({
    type: '单选',
    stem: '题干文字',
    options: ['$-1$', '$0$', '$1$', '$6$'],
  });
  check('选择题自动补 \\pick', c1.tex.includes('\\pick'));
  check(
    '选择题拼出 choices 环境',
    c1.tex.includes('\\begin{choices}') && c1.tex.includes('\\end{choices}')
  );
  eq('选项条数 4', (c1.tex.match(/\\item/g) ?? []).length, 4);
  check('自动补的内容有回报提示', c1.notes.some((n) => n.includes('\\pick')));

  const c2 = composeStemTex({ type: '单选', stem: '已有 \\pick 在句中', options: ['甲', '乙'] });
  eq('题干已含 \\pick 时不重复补', (c2.tex.match(/\\pick/g) ?? []).length, 1);

  const c3 = composeStemTex({ type: '填空', stem: '$a=$' });
  check('填空题自动补 \\fillin', c3.tex.includes('\\fillin'));

  const c4 = composeStemTex({ type: '解答', stem: '(1) 求证…' });
  eq('解答题不做任何自动补', c4.tex, '(1) 求证…');

  const split = splitOptionsFromStem('题干\nA．甲\nB．乙\nC．丙\nD．丁');
  check('能从题干里拆出选项', !!split);
  eq('拆出的题干只剩正文', split?.stem, '题干');
  eq('拆出 4 个选项', split?.options.length, 4);
  eq('拆出的选项内容正确', split?.options[2], '丙');

  // ==========================================================
  section('14. 显示端渲染（与导出端共用同一份 .tex）');
  // ==========================================================
  const r1 = renderLatex(f1.stem, { qid: 'AT0001' });
  check('题干渲染出 choices 列表', r1.html.includes('ma-choices'));
  eq('渲染出 4 个选项', (r1.html.match(/ma-option-label/g) ?? []).length, 4);
  check('\\pick 渲染成空括号', r1.html.includes('ma-pick'));
  check('公式交给 KaTeX 渲染', r1.html.includes('katex'));
  check('渲染过程没有报错', r1.problems.length === 0, r1.problems.join('；'));

  // 带示意图的题：图号必须每题独立且连续（题干先数，答案接着编）
  const figQ = await service.createQuestion({
    kind: '单题',
    type: '解答',
    source: '渲染测试',
    number: 1,
    stem: '如图',
    answer: '解答',
  });
  const figName1 = service.addImage(figQ.qid, 'fig', Buffer.from([0x89, 0x50, 0x4e, 0x47])).name;
  const figName2 = service.addImage(figQ.qid, 'fig', Buffer.from([0x89, 0x50, 0x4e, 0x47])).name;
  const stemWithFig = `如图，正方体中 \\fig[0.4]{images/${figName1}}`;
  const ansWithFig = `作辅助线 \\fig[0.3]{images/${figName2}}`;
  service.writeContent(figQ.qid, 'stem', stemWithFig);
  service.writeContent(figQ.qid, 'answer', ansWithFig);

  const rs = renderLatex(stemWithFig, { qid: figQ.qid, figureStart: 1 });
  check('\\fig 渲染成 figure', rs.html.includes('ma-fig'));
  check('题干示意图编号为 图1', rs.html.includes('图1'));
  eq('题干数出 1 张示意图', rs.figureCount, 1);
  eq('下一张可用编号 = 2', rs.nextFigure, 2);
  check('图片地址指向题目资产路由', rs.html.includes(`/api/assets/${figQ.qid}/${figName1}`));
  // v3：宽度不再写成 width，而是 CSS 变量 --ma-fig-w（由样式表再加高度上限）
  check('宽度选项 0.4 换算成 40%', rs.html.includes('--ma-fig-w:40%'));
  check('不再直接写死 width（v3 改为上限约束）', !rs.html.includes('style="width:'));

  const ra = renderLatex(ansWithFig, { qid: figQ.qid, figureStart: rs.nextFigure });
  check('答案里的图接着编号为 图2', ra.html.includes('图2'));

  const withCaption = renderLatex(stemWithFig, {
    qid: figQ.qid,
    captions: { [figName1]: '正方体示意图' },
  });
  check('图注能渲染出来', withCaption.html.includes('正方体示意图'));

  const missing = renderLatex('图 \\includegraphics[width=0.3\\linewidth]{images/GONE-fig-01.png}', {
    qid: 'AT0001',
    existingFiles: new Set<string>(),
  });
  check('图片缺失时页面给出提示', missing.html.includes('ma-img-missing'));
  check('并把缺失记进 problems', missing.problems.some((p) => p.includes('缺失')));

  eq('宽度解析 0.4\\linewidth', JSON.stringify(parseWidth('[width=0.4\\linewidth]')), '{"kind":"fraction","value":0.4}');
  eq('宽度解析 200px', JSON.stringify(parseWidth('[width=200px]')), '{"kind":"px","value":200}');
  eq('没有任何宽度选项时返回 null', parseWidth(undefined), null);

  // ==========================================================
  section('15. lint：白名单之外的东西一律拦下');
  // ==========================================================
  check(
    'TikZ 被拦',
    lintLatex('\\begin{tikzpicture}\\draw (0,0);\\end{tikzpicture}').some((w) => w.level === 'error')
  );
  check('\\newcommand 被拦', lintLatex('\\newcommand{\\foo}{bar}').some((w) => w.level === 'error'));
  check('\\input 被拦', lintLatex('\\input{other.tex}').some((w) => w.level === 'error'));
  check(
    '非法环境被拦（如 align）',
    lintLatex('\\begin{align}x\\end{align}').some((w) => w.level === 'error')
  );
  // ★ 数学模式内部的 array / aligned / cases 是公式排版，由 KaTeX 渲染，不能误报
  // （迁移真实数据时曾因此把 7 个文件里的 11 处 array + 14 处 aligned 误报成 50 个错误）
  eq(
    '数学模式内的 array 不报警',
    lintLatex('$\\left\\{\\begin{array}{l}x=1\\\\y=2\\end{array}\\right.$').length,
    0
  );
  eq('数学模式内的 aligned 不报警', lintLatex('$$\\begin{aligned}a&=b\\\\c&=d\\end{aligned}$$').length, 0);
  eq('数学模式内的 cases 不报警', lintLatex('$\\begin{cases}x>0\\\\y<1\\end{cases}$').length, 0);
  eq('数学模式内的 matrix 不报警', lintLatex('$\\begin{pmatrix}1&0\\\\0&1\\end{pmatrix}$').length, 0);
  check(
    '数学模式**外**的 array 仍被拦',
    lintLatex('\\begin{array}{l}x\\end{array}').some((w) => w.level === 'error')
  );
  check('svg 图片被拦（xelatex 不支持）', lintLatex('\\includegraphics{images/x.svg}').some((w) => w.level === 'error'));
  eq('白名单宏不报警', lintLatex('题目 \\pick\\fillin \\textbf{粗} \\textit{斜}').length, 0);
  eq('数学模式里的宏不报警（交给 KaTeX）', lintLatex('$\\dfrac{1}{2}+\\sqrt{3}$').length, 0);
  check('美元符号不配平报警', lintLatex('$x + 1').some((w) => w.message.includes('不成对')));
  eq('choices 环境是合法的', lintLatex('\\begin{choices}\\item a\\end{choices}').length, 0);
  check(
    '图片名不符规范时给出 warn',
    lintLatex('\\includegraphics{images/随便起的名字.png}').some((w) => w.level === 'warn')
  );

  // 搜素文本与图像判定
  check('stripLatex 去掉命令保留中文', stripLatex('$x$ 的虚部为 \\pick').includes('虚部'));
  eq('countFigures 数示意图', countFigures(stemWithFig), 1);

  // ==========================================================
  section('16. 待入库图片与占位标记（录入页的核心链路）');
  // ==========================================================
  // 录入页选图时 qid 还不存在，所以正文里插 [[img:N]] 占位标记，
  // 保存时拿到 qid 后再换成真正的宏（文件名要带 qid 才全库唯一）。
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const composedAdd = composeStemTex({
    type: '单选',
    stem: '如图 [[img:0]] 所示，求角的大小',
    options: ['甲', '乙', '丙', '丁'],
  });
  check('占位标记在组合题干后仍保留', composedAdd.tex.includes('[[img:0]]'));

  const addQ = await service.createQuestion({
    kind: '单题',
    type: '单选',
    source: '录入测试',
    number: 1,
    stem: composedAdd.tex,
    answer: '作辅助线 [[img:1]] 即可',
    pendingImages: [
      { channel: 'fig', buf: PNG, ext: 'png', asFigure: true, width: 0.35 },
      { channel: 'ansfig', buf: PNG, ext: 'png', asFigure: true, width: 0.3 },
    ],
  });
  const addFull = service.getQuestion(addQ.qid);
  check(
    '题干里的标记换成了真正的 \\fig 宏（带 qid 文件名）',
    addFull.stem.includes(`\\fig[0.35]{images/${addQ.qid}-fig-01.png}`),
    addFull.stem
  );
  check(
    '答案里的标记也换了，走的是答案示意图通道',
    addFull.answer.includes(`\\fig[0.3]{images/${addQ.qid}-ansfig-01.png}`),
    addFull.answer
  );
  check('正文里没有残留的占位标记', !/\[\[img:\d+\]\]/.test(addFull.stem + addFull.answer));
  check(
    '图片按 {qid}-{通道}-01 落盘',
    fs.existsSync(path.join(questionDir(addQ.qid), `${addQ.qid}-fig-01.png`))
  );
  eq('两个通道各一张图', addFull.assets.length, 2);

  const contentImgQ = await service.createQuestion({
    kind: '单题',
    type: '解答',
    source: '录入测试',
    number: 2,
    stem: '整题就是一张图：[[img:0]]',
    pendingImages: [{ channel: 'stem', buf: PNG, ext: 'png', asFigure: false, width: 0.5 }],
  });
  check(
    '内容图用 \\includegraphics（不是 \\fig）',
    service
      .getQuestion(contentImgQ.qid)
      .stem.includes(`\\includegraphics[width=0.5\\linewidth]{images/${contentImgQ.qid}-stem-01.png}`),
    service.getQuestion(contentImgQ.qid).stem
  );

  // 渲染端要能把这些宏正确显示出来
  const rendered = renderLatex(addFull.stem, { qid: addQ.qid, figureStart: 1 });
  check('渲染出 figure 且宽度 0.35 → 35%', rendered.html.includes('--ma-fig-w:35%'), rendered.html);
  check('渲染出 图1', rendered.html.includes('图1'));
  check('渲染无报错', rendered.problems.length === 0, rendered.problems.join('；'));

  // ---------- v3：图片尺寸一致性 ----------
  // 真源里的 width= 保持原样，但渲染出的 HTML 必须是「上限」而不是「写死宽度」，
  // 再由样式表施加 max-height，否则竖长示意图 / 大截图会把卡片撑爆。
  check('示意图宽度写成 CSS 变量而非 width', rs.html.includes('style="--ma-fig-w:40%"'));
  check('示意图不再有 width:100% 的合流写法', !rendered.html.includes('style="width:'));
  const inlineImg = renderLatex('图 \\includegraphics[width=0.5\\linewidth]{images/x-stem-01.png} 所示', {
    qid: 'AT0001',
    existingFiles: new Set(['x-stem-01.png']),
  });
  check('行内图宽度也写成 CSS 变量', inlineImg.html.includes('--ma-img-w:50%'));
  check('行内图不带 width= 时给 auto（自适应 + 高度上限）', 
    renderLatex('\\includegraphics{images/y-stem-01.png}', {
      qid: 'AT0001',
      existingFiles: new Set(['y-stem-01.png']),
    }).html.includes('--ma-img-w:auto'));

  // 纯图题判定：这才是 .ma-image-only 的真正依据
  check('纯图题判定为真（只有一张 \\fig）', isImageOnly('\\fig[0.6]{images/a-fig-01.png}'));
  check('纯图题判定为真（只有一张 \\includegraphics）', isImageOnly('\\includegraphics{images/a-stem-01.png}'));
  check('有文字的题判定为假', !isImageOnly('如图 \\fig{images/a-fig-01.png} 所示'));
  check('没有图判定为假', !isImageOnly('已知集合 $A$'));
  check('多个纯图也判定为真', isImageOnly('\\fig{images/a-fig-01.png}\n\\fig{images/a-fig-02.png}'));

  // 答案组合与字母解析
  eq('单选取一个字母', JSON.stringify(parseAnswerLetters('C')), '["C"]');
  eq('多选字母去重排序', JSON.stringify(parseAnswerLetters('d,a,a')), '["D","A"]');
  eq('字母 + 详解 组合成 "C。因为…"', composeAnswer(['C'], '因为虚部是 1'), 'C。因为虚部是 1');
  eq('只有字母', composeAnswer(['A', 'D'], ''), 'AD');
  eq('只有详解', composeAnswer([], '略'), '略');
  check('hasImageMarkers 能识别残留标记', hasImageMarkers('还有 [[img:3]] 没用掉'));

  // ==========================================================
  section('17. 标签引用计数的口径（含停用题）');
  // ==========================================================
  // 语义决定：标签计数与改名/彻底清除的影响范围，一律以「全部题目（含停用）」为准。
  // 理由：停用≠删除，标签值确实还在那些题上；操作必须覆盖它们，否则会留漏网之鱼。
  const semQ = await service.createQuestion({
    kind: '单题',
    type: '解答',
    source: '口径测试',
    number: 1,
    knowledge: ['口径测试知识点'],
    stem: 'x',
  });
  let semVocab = service.listTags(true);
  let kpItem = semVocab.knowledge.find((k) => k.name === '口径测试知识点');
  eq('启用时 count = enabledCount = 1', `${kpItem?.count}/${kpItem?.enabledCount}`, '1/1');

  service.setStatus(semQ.qid, '停用');
  semVocab = service.listTags(true);
  kpItem = semVocab.knowledge.find((k) => k.name === '口径测试知识点');
  eq('停用后 count 仍是 1（含停用题）', kpItem?.count, 1);
  eq('但 enabledCount 变成 0', kpItem?.enabledCount, 0);

  eq(
    '默认检索看不到停用题',
    service.searchQuestions({ knowledge: ['口径测试知识点'] }).total,
    0
  );
  eq(
    'status=全部 时能看到（与 count 口径一致）',
    service.searchQuestions({ knowledge: ['口径测试知识点'], status: '全部' }).total,
    1
  );
  eq(
    '改名会影响停用题（不漏网）',
    service.previewRename('knowledge', '口径测试知识点', '口径测试知识点2').affected.length,
    1
  );

  // ==========================================================
  section('18. 表格（tabular）');
  // ==========================================================
  // v0 数据里有 HTML 表格，而网页端必须也能显示 —— 所以把 tabular 纳入可移植子集，
  // 两端各自渲染：LaTeX 原样编译，网页解析成 HTML 表。
  const tabularTex =
    '\\begin{tabular}{|c|c|}\n\\hline\n级数 & 风速 \\\\ \\hline\n2 & $1.6$~$3.3$ \\\\ \\hline\n\\end{tabular}';

  eq('tabular 是合法环境', lintLatex(tabularTex).length, 0);

  const blocks18 = splitBlocks(`前文\n\n${tabularTex}\n\n后文`);
  const tableBlock = blocks18.find((b) => b.type === 'table');
  check('能切出表格块', !!tableBlock);
  if (tableBlock && tableBlock.type === 'table') {
    eq('解析出 2 行', tableBlock.rows.length, 2);
    eq('每行 2 列', tableBlock.rows[0].length, 2);
    eq('单元格内容正确', tableBlock.rows[0][0], '级数');
    eq('列格式解析正确', tableBlock.colSpec, '|c|c|');
    eq('前后的普通文本也保留', blocks18.filter((b) => b.type === 'text').length, 2);
  }

  const tableHtml = renderLatex(tabularTex, { qid: 'AT0001' }).html;
  check('渲染成 HTML 表格', tableHtml.includes('class="ma-table"'));
  eq('渲染出 2 行', (tableHtml.match(/<tr>/g) ?? []).length, 2);
  eq('渲染出 4 个单元格', (tableHtml.match(/<td>/g) ?? []).length, 4);
  check('单元格里的公式交给 KaTeX', tableHtml.includes('katex'));
  check('没有渲染报错', renderLatex(tabularTex, { qid: 'AT0001' }).problems.length === 0);

  const built = buildTabular([
    ['级数', '风速'],
    ['2', '1.6~3.3'],
  ]);
  check('buildTabular 生成 tabular 环境', built.startsWith('\\begin{tabular}{|c|c|}'));
  check('buildTabular 的行分隔正确', built.includes('级数 & 风速 \\\\ \\hline'));
  eq('生成结果能通过 lint', lintLatex(built).length, 0);

  // ==========================================================
  section('19. v4：单题 id 前缀 T / 资源名兼容 / 备份上限');
  // ==========================================================

  // ---- id 方案：严格写、宽松读 ----
  // v9：写入的 id 前面带**学科字母**（默认单学科就是 A）→ AT0001。
  // 不传学科参数 = 用"当前学科"；要断言老形态就显式传空串。
  eq('numberToQid(1) 写出 AT0001（v9 起带学科字母）', numberToQid(1), 'AT0001');
  eq('★ 显式传空学科字母时才是老的 T0001', numberToQid(1, ''), 'T0001');
  eq('★ 换个学科字母：BT0007', numberToQid(7, 'B'), 'BT0007');
  eq('numberToQid(123) 补零到 4 位', numberToQid(123, ''), 'T0123');
  eq('numberToQid(12345) 超位数自然变长', numberToQid(12345, ''), 'T12345');
  eq('numberToQid(12345) 带学科字母也自然变长', numberToQid(12345, 'C'), 'CT12345');
  check('T0001 是合法单题 id', isQuestionId('T0001'));
  check('★ v9：AT0001 也是合法单题 id', isQuestionId('AT0001'));
  check('★ 旧的纯数字 0001 仍然被认作合法单题 id（宽松读）', isQuestionId('0001'));
  check('★ 旧的 4 位以上纯数字也认（00010）', isQuestionId('00010'));
  check('T123 位数不够，不算合法（要 4 位起）', !isQuestionId('T123'));
  check('★ 带学科字母但位数不够也不算（AT123）', !isQuestionId('AT123'));
  check('纯数字位数不够不算（001）', !isQuestionId('001'));
  check('P001 不是单题 id（那是整卷）', !isQuestionId('P001'));
  check('★ AP001 也不是单题 id', !isQuestionId('AP001'));
  check('T 和 P 都算合法题目目录名', isQidName('T0001') && isQidName('P001'));
  check('★ AT0001 / AP001 也都是合法题目目录名', isQidName('AT0001') && isQidName('AP001'));
  eq('★ qidToNumber 能吃新格式', qidToNumber('T0001'), 1);
  eq('★ qidToNumber 能吃带学科字母的格式', qidToNumber('AT0001'), 1);
  eq('★ qidToNumber 也能吃旧格式（老库可读）', qidToNumber('0001'), 1);
  eq('★ T 与旧数字解析出同一个号', qidToNumber('T0042'), qidToNumber('0042'));
  eq('★ 带学科字母与不带解析出同一个号', qidToNumber('BT0042'), qidToNumber('T0042'));
  eq('整卷 id 规则：不带字母时还是 P007', paperNumberToId(7, ''), 'P007');
  eq('整卷 id 带学科字母：AP007', paperNumberToId(7), 'AP007');

  // ---- v9：显示形态（界面上一律去掉学科字母） ----
  eq('★ displayQid(AT0001) 去掉字母 → T0001', displayQid('AT0001'), 'T0001');
  eq('★ displayQid(AP001) 去掉字母 → P001', displayQid('AP001'), 'P001');
  eq('★ displayQid(BT0042) → T0042', displayQid('BT0042'), 'T0042');
  eq('★ displayQid 对本来就没字母的 id 原样返回', displayQid('T0001'), 'T0001');
  eq('★ displayQid 对更老的纯数字 id 也原样返回', displayQid('0001'), '0001');
  eq('★ subjectLetterOf 读出学科字母', subjectLetterOf('BT0007'), 'B');
  eq('没有字母时 subjectLetterOf 是空串', subjectLetterOf('T0007'), '');
  eq(
    '★ parseQid 拆得干净（AT0001 → A / 单题 / 1）',
    JSON.stringify(parseQid('AT0001')),
    JSON.stringify({ subject: 'A', kind: '单题', number: 1 })
  );
  eq(
    '★ parseQid 也能拆整卷（AP012 → A / 整卷 / 12）',
    JSON.stringify(parseQid('AP012')),
    JSON.stringify({ subject: 'A', kind: '整卷', number: 12 })
  );
  check('parseQid 对不是 id 的字符串返回 null', parseQid('随便') === null && parseQid('A0001') === null);

  // ---- 资源文件名三种前缀都认（这里是漏改会静默丢图的地方） ----
  check('新格式资源名能解析', store.parseAssetName('T0001-fig-01.png') !== null);
  check('★ 旧格式资源名也能解析（不会静默丢图）', store.parseAssetName('0001-fig-01.png') !== null);
  check('★★ v9：带学科字母的资源名也要能解析', store.parseAssetName('AT0001-fig-01.png') !== null);
  eq(
    '带学科字母时的 qid 前缀解析正确',
    store.parseAssetName('AT0001-fig-01.png')?.name,
    'AT0001-fig-01.png'
  );
  eq('通道解析正确', store.parseAssetName('T0009-ansfig-12.jpg')?.channel, 'ansfig');
  eq('序号解析正确', store.parseAssetName('T0009-ansfig-12.jpg')?.index, 12);
  check('不合规范的名字照样被拒', store.parseAssetName('随便一个名字.png') === null);
  eq(
    '★ 新写入的资源名带 qid（v9 起前面还有学科字母）',
    store.buildAssetName('AT0001', 'fig', 1, 'png'),
    'AT0001-fig-01.png'
  );

  // ---- 备份上限 100 ----
  // 直接造 105 份备份文件，看 listBackups 是否裁到 100 并删掉最旧的
  {
    const dir = backupsDir();
    fs.mkdirSync(dir, { recursive: true });
    for (const f of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, f));
    for (let i = 0; i < 105; i++) {
      // 时间递增，保证第 i 条严格比第 i-1 条新
      const at = new Date(Date.UTC(2026, 0, 1, 0, 0, 0) + i * 60000).toISOString();
      const id = `tags-test-${String(i).padStart(3, '0')}`;
      fs.writeFileSync(
        path.join(dir, `${id}.json`),
        JSON.stringify({
          id,
          file: path.join(dir, `${id}.json`),
          createdAt: at,
          operation: `test-${i}`,
          affected: [],
        }),
        'utf-8'
      );
    }
    eq('造了 105 份备份', fs.readdirSync(dir).filter((f) => f.endsWith('.json')).length, 105);

    const listed = service.listBackups();
    eq('★ 列表被裁到上限 100', listed.length, 100);
    eq(
      '★ 磁盘上旧文件也真被删掉了',
      fs.readdirSync(dir).filter((f) => f.endsWith('.json')).length,
      100
    );
    check('★ 保留的是最新的（最旧那几条已不在）', !listed.some((b) => b.operation === 'test-0'), listed.map((b) => b.operation).slice(-3).join(','));
    check('最新的那条还在', listed.some((b) => b.operation === 'test-104'));
    check('列表是倒序（最新在前）', listed[0].createdAt >= listed[1].createdAt);

    // ---- 同一秒内连做两次操作不该互相覆盖 ----
    for (const f of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, f));
    service.addTag('source', 'v4备份校验');
    // 连着改两次名（几乎同一秒）
    service.renameTag('source', 'v4备份校验', 'v4备份校验A');
    service.renameTag('source', 'v4备份校验A', 'v4备份校验B');
    const dupFiles = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    eq('★ 同一秒两次操作产生两份备份（不再同名覆盖）', dupFiles.length, 2);
    for (const f of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, f));
  }

  // ==========================================================
  section('20. v5：配图位置 / 网页图片渲染 / 宽度统一');
  // ==========================================================

  // ---- 位置解析：手动值优先；v8 起**默认一律靠右**（示意图的习惯位置）----
  eq('解答题默认靠右', resolveFigAlign('解答'), '右');
  eq('★ v8：单选题默认也靠右（不再按题型推导）', resolveFigAlign('单选'), '右');
  eq('多选题默认靠右', resolveFigAlign('多选'), '右');
  eq('填空题默认靠右', resolveFigAlign('填空'), '右');
  eq('没有题型也靠右', resolveFigAlign(undefined), '右');
  eq('★ DEFAULT_FIG_ALIGN 与默认值一致', DEFAULT_FIG_ALIGN, resolveFigAlign(undefined));
  eq('★ 手动设过就用手动值（解答题设成左）', resolveFigAlign('解答', '左'), '左');
  eq('★ 手动设过就用手动值（单选题设成中）', resolveFigAlign('单选', '中'), '中');
  check('三个合法位置都被认', FIG_ALIGNS.every((a) => isFigAlign(a)));
  check('非法位置被拒', !isFigAlign('中右') && !isFigAlign('center') && !isFigAlign(1));
  eq('位置 → 网页类名（左）', FIG_ALIGN_CLASS['左'], 'left');
  eq('位置 → 网页类名（右）', FIG_ALIGN_CLASS['右'], 'right');
  eq('位置 → LaTeX 对齐（右）', FIG_ALIGN_TEX['右'], 'right');
  eq('位置 → LaTeX 对齐（中）', FIG_ALIGN_TEX['中'], 'center');
  check(
    '每个位置都有网页类名与 LaTeX 映射',
    FIG_ALIGNS.every((a) => !!FIG_ALIGN_CLASS[a] && !!FIG_ALIGN_TEX[a])
  );

  // ---- 网页渲染：位置真的进了 HTML ----
  const figTex = `如图 \\fig[0.4]{images/AT0001-fig-01.png} 所示`;
  const figOpts = { qid: 'AT0001', existingFiles: new Set(['AT0001-fig-01.png']) };
  check(
    '★ v8：不给 figAlign 时渲染成 ma-fig-right（默认靠右，与 resolveFigAlign 一致）',
    renderLatex(figTex, figOpts).html.includes('ma-fig-right')
  );
  check(
    '★ 给「右」时渲染成 ma-fig-right',
    renderLatex(figTex, { ...figOpts, figAlign: '右' }).html.includes('ma-fig-right')
  );
  check(
    '★ 给「左」时渲染成 ma-fig-left',
    renderLatex(figTex, { ...figOpts, figAlign: '左' }).html.includes('ma-fig-left')
  );
  check(
    '★ 位置类不会串（给「右」时不含 left/center）',
    (() => {
      const h = renderLatex(figTex, { ...figOpts, figAlign: '右' }).html;
      return h.includes('ma-fig-right') && !h.includes('ma-fig-left') && !h.includes('ma-fig-center');
    })()
  );
  check(
    '宽度百分比仍写进 --ma-fig-w（0.4 → 40%），不受位置影响',
    renderLatex(figTex, { ...figOpts, figAlign: '右' }).html.includes('--ma-fig-w:40%')
  );

  // ---- 模板能力（这两个坑都是实打实踩过的） ----
  // 模板目录的位置问应用自己要（v10 整理目录后它叫「模板」，且在代码文件夹的上一层）
  const styPath = path.join(templatesRootDir(), '默认', 'quirex.sty');
  const sty = fs.readFileSync(styPath, 'utf-8');
  check(
    '★ 模板用 \\NewDocumentEnvironment 声明 exercise（两个 O{} 可选参数）',
    /\\NewDocumentEnvironment\{exercise\}\{\s*O\{M\}\s*O\{center\}\s*\}/.test(sty)
  );
  check(
    '★ 没有用有坑的 \\newenvironment{exercise}[2][]（那是 1 可选 + 1 必选）',
    !/\\newenvironment\{exercise\}\[2\]/.test(sty)
  );
  check(
    '★ \\fig 用 \\makebox 摆放位置（靠 \\hfill 会被 parfillskip 顶偏）',
    /\\makebox\[\\linewidth\]\[r\]/.test(sty) && /\\makebox\[\\linewidth\]\[c\]/.test(sty)
  );
  check('\\fig 兜底宽度已从 0.45 降到 0.3', /\\newcommand\{\\fig\}\[2\]\[0\.3\]/.test(sty));

  // ---- 宽度统一：全站只用一把尺子 ----
  const globals = fs.readFileSync(path.join('src', 'app', 'globals.css'), 'utf-8');
  check('★ 定义了统一的正文栏宽度 --ma-col-w', /--ma-col-w:\s*1000px/.test(globals));
  check('v3 的 --ma-read-w 已删除（避免两把尺子）', !/^\s*--ma-read-w:/m.test(globals));
  check(
    '★ 图片兜底上限改成 em（不再是 px）',
    /--ma-fig-h:\s*\d+em/.test(globals) && !/--ma-fig-h:\s*\d+px/.test(globals)
  );
  check('★ 图外面没有边框了', !/\.ma-fig img\s*\{[^}]*border:/.test(globals));
  check(
    '★ 有左/中/右三个位置类',
    ['.ma-fig-left', '.ma-fig-center', '.ma-fig-right'].every((c) => globals.includes(c))
  );
  check('★ 有点图放大的遮罩样式', /\.ma-lightbox\s*\{/.test(globals));
  const browseCss = fs.readFileSync(path.join('src', 'app', 'page.module.css'), 'utf-8');
  check(
    '★ 题库页整页收敛到 --ma-col-w（搜索区与列表自动同宽同左边界）',
    /\.page\s*\{[^}]*max-width:\s*var\(--ma-col-w\)/.test(browseCss)
  );
  check('★ 浏览页 CSS 里已无 px 图片上限', !/--ma-fig-h:\s*\d+px/.test(browseCss));
  check('浏览页 CSS 里已无双栏网格残留', !/grid-template-columns/.test(browseCss));

  // ==========================================================
  section('结果');
  // ==========================================================
  console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
  if (fail > 0) {
    console.log('\n失败清单：');
    for (const f of failures) console.log(`  · ${f}`);
  }

  // 清理临时题库
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
    console.log(`\n已清理临时题库 ${TMP}`);
  } catch (e) {
    console.log(`\n临时题库清理失败（可手动删）：${(e as Error).message}`);
  }

  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('\n自测脚本自身崩了：', e);
  process.exit(2);
});
