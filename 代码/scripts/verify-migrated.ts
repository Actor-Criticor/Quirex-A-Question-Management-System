/**
 * verify-migrated.ts — 校验迁移成果
 *
 * 迁移工具说"成功"不算数 —— 这里用迁移出来的库真跑一遍：
 *   · 全部题目的核心元数据完整性
 *   · 每道题的图片引用是否都能落到实际文件
 *   · LaTeX 是否通过可移植子集检查（网页与导出一致的前提）
 *   · 全部题目拼成一份讲义后，xelatex 能不能编译过
 *
 * 运行：npx tsx scripts/verify-migrated.ts [库路径]
 *
 * v10：目标库不存在时**自己先跑一次迁移**把它生成出来。
 * 以前是硬性假设"已经跑过 migrate-v0 --apply"，而那个目录是 .gitignore 的临时产物 ——
 * 清理旧数据时把它删掉，这个套件立刻变成一条看不懂的报错（真事）。
 * 现在它自给自足：要校验迁移，就自己先把迁移跑一遍（只写目标库，源库一个字不动）。
 *
 * v10 整理目录后：默认目标库改成**系统临时目录**里的 quirex-v1，不再往项目文件夹里
 * 丢一个 题库-v1 —— 校验套件不该在你的文件夹里留东西。要看结果就传一个路径进来。
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { execFileSync } from 'child_process';

import { configFilePath, resolvePathValue } from '../src/lib/config';

const VAULT = process.argv[2] || path.join(os.tmpdir(), 'quirex-v1');
process.env.VAULT_PATH = VAULT;

/** 迁移的**源库** = 用户当前的题库位置（在下面改 config.json 之前先记下来） */
const SOURCE_LIB = resolvePathValue('vaultPath');

/*
 * ⚠️ 光设 `process.env.VAULT_PATH` 不够：配置层的优先级是 **config.json > 环境变量**，
 * 而只要你在「设置 → 路径」里改过一次，盘上就有 config.json —— 那时这个套件会去校验
 * **别人的库**（实测：它跑去校验当前的演示库，报出"1 道缺题干"这种跟迁移毫不相干的失败）。
 * 所以这里把目标库临时写进 config.json，跑完原样写回（跟 verify-v9-subject-ui 一个套路）。
 * 导出目录也一并指到临时目录，免得校验产物落进你的「导出」。
 */
const CONFIG_FILE = configFilePath();
const savedConfig = fs.existsSync(CONFIG_FILE) ? fs.readFileSync(CONFIG_FILE, 'utf-8') : null;
const savedRaw = savedConfig ? (JSON.parse(savedConfig) as Record<string, unknown>) : {};
const TMP_EXPORT = path.join(os.tmpdir(), 'quirex-v1-导出');
fs.writeFileSync(
  CONFIG_FILE,
  JSON.stringify({ ...savedRaw, vaultPath: VAULT, exportDir: TMP_EXPORT }, null, 2) + '\n',
  'utf-8'
);

/** 跑完把 config.json 原样写回（process.exit 也会触发 exit 事件） */
function restoreConfig(): void {
  try {
    if (savedConfig !== null) fs.writeFileSync(CONFIG_FILE, savedConfig, 'utf-8');
    else fs.rmSync(CONFIG_FILE, { force: true });
  } catch {
    /* 写不回去也别让套件崩在这儿 */
  }
}
process.on('exit', restoreConfig);

import * as service from '../src/lib/service';
import { listQidFolders, questionDir } from '../src/lib/paths';
import { exportHandout } from '../src/lib/latexExport';
import { lintLatex, checkImageRefs, splitSegments, imageBasename } from '../src/lib/latexSubset';
import { isQuestionType } from '../src/lib/types';

let pass = 0;
let fail = 0;
/** 目标库里没数据 → 明确跳过（不是"通过"，见 main 里的说明） */
let skipped = false;
const failures: string[] = [];

function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    pass++;
  } else {
    fail++;
    failures.push(detail ? `${name} — ${detail}` : name);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(t: string): void {
  console.log(`\n=== ${t} ===`);
}

/**
 * 目标库不在（或者还是空的）就自己造一个（见文件头说明）。
 *
 * ⚠️ 判据不能是"目录存不存在"：任何一次读索引都会顺带把 `题库/_meta/` 建出来，
 * 所以那个目录**总是**在的，照着判会永远跳过迁移（实测：空库上校验"通过 0 道题"）。
 * 正确的判据是"里面有没有题目"。
 */
function ensureTargetVault(): void {
  if (listQidFolders().length > 0) return;
  console.log(`目标库里还没有题目：${path.resolve(VAULT)}`);

  // 先看源库里有没有 v0 格式的文件 —— 没有就别白跑一趟，说清楚为什么
  const from = SOURCE_LIB;
  const v0Files: string[] = [];
  const scan = (dir: string): void => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) scan(p);
      else if (/\.md$/.test(e.name)) v0Files.push(p);
    }
  };
  scan(path.join(from, '题库'));
  /*
   * v1 的题目文件叫 `<qid>.md`（AT0001.md，**名字里没有横杠**）；
   * v0 的叫 `<来源>-T<题号>.md`（25全国1-T19.md）。
   *
   * ⚠️ 判据必须容忍那个 `T`：第一版我写成 `/-\d+\.md$/`，而实际文件名是
   * `…-T19.md`（横杠后面是 T 不是数字）→ 一个都匹配不上 → 套件以为"源库里没有
   * v0 数据"，静默跳过并报一堆失败。这类"假设错了格式"的坑，测试自己也会踩。
   */
  const v0Only = v0Files.filter((p) => /-T?\d+\.md$/i.test(path.basename(p)));
  if (v0Only.length === 0) {
    console.log(`源库 ${from} 里没有 v0 格式的题目文件 —— 没有可迁移的东西。`);
    console.log('（这个套件校验的是"迁移结果"；没有 v0 数据时它没有意义，直接跳过。）\n');
    return;
  }

  console.log(`→ 先跑一次迁移把它生成出来（只写这个目录；源库不动）…\n`);
  try {
    // 源库显式传进去：这个子进程也会读 config.json，而我们已经把它的 vaultPath 临时改成目标库了
    execFileSync(
      'npx',
      ['tsx', 'scripts/migrate-v0.ts', '--apply', '--from', from, '--to', VAULT],
      { stdio: 'inherit', shell: true }
    );
  } catch {
    console.log('\n（迁移没能完成 —— 接着校验下去，下面的失败会说明缺了什么）');
  }
  console.log('');
}

async function main(): Promise<void> {
  ensureTargetVault();
  console.log(`校验目标库：${path.resolve(VAULT)}`);

  const qids = listQidFolders();
  console.log(`共 ${qids.length} 道题\n`);

  /*
   * 一道题都没有 → 没有可校验的东西，**明确地说"跳过"**然后退出。
   *
   * 以前会硬着头皮往下跑：`listTags` 拿到空表、再读某个标签的 `name` 就崩在
   * `Cannot read properties of undefined`（真事，清库之后就这样）。
   * "跳过一个没有前提的套件"和"校验通过"是两回事 —— 所以这里把话说清楚。
   */
  if (qids.length === 0) {
    console.log('目标库里没有题目 —— 本套件校验的是**迁移结果**，没有数据就没得校验。');
    console.log('跳过。要真校验一次，先跑：npx tsx scripts/migrate-v0.ts --apply');
    skipped = true;
    return;
  }

  // ==========================================================
  section('1. 每道题的完整性');
  // ==========================================================
  let badType = 0;
  let badNumber = 0;
  let badDifficulty = 0;
  let missingStem = 0;
  let orphanRefs = 0;
  let lintProblems = 0;
  let imageTotal = 0;

  for (const qid of qids) {
    const full = service.getQuestion(qid);
    const m = full.meta;

    if (m.kind !== '单题' && m.kind !== '整卷') check(`${qid} kind 合法`, false, String(m.kind));
    if (m.kind === '单题') {
      if (!isQuestionType(m.type)) badType++;
      if (m.number !== undefined && (m.number < 1 || m.number > 30)) badNumber++;
      if (m.difficulty !== undefined && (m.difficulty < 0.01 || m.difficulty > 0.99)) badDifficulty++;
      if (!full.stem.trim()) missingStem++;
    }

    const files = new Set(full.assets.map((a) => a.name));
    imageTotal += files.size;

    const refs = [...splitSegments(full.stem), ...splitSegments(full.answer)]
      .filter((s) => s.type === 'image')
      .map((s) => imageBasename(s.value))
      .filter(Boolean);
    for (const r of refs) if (!files.has(r)) orphanRefs++;

    const problems = [
      ...lintLatex(full.stem, '题干'),
      ...lintLatex(full.answer, '答案'),
      ...checkImageRefs(full.stem, files),
      ...checkImageRefs(full.answer, files),
    ].filter((p) => p.level === 'error');
    if (problems.length) {
      lintProblems += problems.length;
      if (lintProblems <= 5) console.log(`      ${qid}: ${problems[0].message}`);
    }
  }

  check(`全部 ${qids.length} 道题的题型都合法（单选/多选/填空/解答）`, badType === 0, `${badType} 道不合法`);
  check('题号都在 1–30 内', badNumber === 0, `${badNumber} 道越界`);
  check('难度都在 0.01–0.99 内或未录入', badDifficulty === 0, `${badDifficulty} 道越界`);
  check('每道单题都有题干', missingStem === 0, `${missingStem} 道缺题干`);
  check('图片引用都能落到实际文件', orphanRefs === 0, `${orphanRefs} 处悬空引用`);
  check('全部题目通过可移植子集检查', lintProblems === 0, `${lintProblems} 个问题`);
  console.log(`      图片共 ${imageTotal} 张`);

  // ==========================================================
  section('2. 标签表');
  // ==========================================================
  const vocab = service.listTags(true);
  check(`来源 ${vocab.source.length} 个`, vocab.source.length > 0);
  check(`知识点 ${vocab.knowledge.length} 个`, vocab.knowledge.length > 0);
  const noOrphanTag = vocab.source.every((t) => t.count > 0) && vocab.knowledge.every((t) => t.count > 0);
  check('没有引用计数为 0 的孤儿标签', noOrphanTag);

  // ==========================================================
  section('3. 检索（迁移后索引可用）');
  // ==========================================================
  const all = service.searchQuestions({ status: '全部', size: 500 });
  check(`检索能返回全部 ${qids.length} 道`, all.total === qids.length, `实际 ${all.total}`);
  const singles = service.searchQuestions({ kind: '单题', status: '全部', size: 500 });
  check('按类型筛选可用', singles.total > 0);
  const bySource = service.searchQuestions({ source: vocab.source[0].name, status: '全部', size: 500 });
  check(`按来源「${vocab.source[0].name}」筛选可用`, bySource.total > 0, `${bySource.total} 道`);
  const byKp = service.searchQuestions({ knowledge: [vocab.knowledge[0].name], status: '全部', size: 500 });
  check(`按知识点「${vocab.knowledge[0].name}」筛选可用`, byKp.total > 0, `${byKp.total} 道`);
  const byNum = service.searchQuestions({ numMin: 1, numMax: 5, status: '全部', size: 500 });
  check('题号范围筛选可用', byNum.total > 0, `${byNum.total} 道`);

  // ==========================================================
  section('4. 导出全部题目并用 xelatex 编译（最关键的一步）');
  // ==========================================================
  const result = await exportHandout({
    title: '迁移校验讲义',
    qids,
    options: { group: 'flat' },
  });

  console.log(`      导出目录：${result.outDir}`);
  check(`导出包含 ${result.count} 道题`, result.count > 0, `实际 ${result.count}`);
  check(`复制了 ${result.imageCount} 张图片`, result.imageCount > 0);

  // v2：产出两个 PDF
  const pdfQuestions = path.join(result.outDir, '题目.pdf');
  const pdfAnswers = path.join(result.outDir, '答案.pdf');
  check('生成了 题目.tex', fs.existsSync(path.join(result.outDir, '题目.tex')));
  check('生成了 答案.tex', fs.existsSync(path.join(result.outDir, '答案.tex')));
  check('★ 生成了 题目.pdf', fs.existsSync(pdfQuestions));
  check('★ 生成了 答案.pdf', fs.existsSync(pdfAnswers));
  check(
    '★ 两个 PDF 编译都零错误',
    result.compile.questions.ok &&
      result.compile.answers.ok &&
      result.compile.questions.errorCount === 0 &&
      result.compile.answers.errorCount === 0,
    [result.compile.questions.log, result.compile.answers.log].join('\n').slice(0, 800)
  );

  for (const [label, f] of [
    ['题目.pdf', pdfQuestions],
    ['答案.pdf', pdfAnswers],
  ] as const) {
    if (fs.existsSync(f)) {
      const size = fs.statSync(f).size;
      console.log(`      ${label} ${size} 字节`);
      check(`${label} 不是空的`, size > 10000, `${size} 字节`);
    }
  }

  // 题目版不含答案、答案版含答案 —— 用两个 tex 的预设验证
  const qTex = fs.readFileSync(path.join(result.outDir, '题目.tex'), 'utf-8');
  const aTex = fs.readFileSync(path.join(result.outDir, '答案.tex'), 'utf-8');
  check('题目.tex 用学生版预设', qTex.includes('\\presetStudent'));
  check('答案.tex 用教师版预设', aTex.includes('\\presetTeacher'));
  check('两个 tex 的正文相同（只有预设不同）', qTex.length > 0 && aTex.length > 0);

  if (result.warnings.length) {
    console.log('      导出提示：');
    for (const w of result.warnings.slice(0, 10)) console.log(`        · ${w}`);
  }

  // ==========================================================
  section('结果');
  // ==========================================================
  if (skipped) {
    console.log('\n跳过（没有可校验的数据）—— 通过 0 项，失败 0 项');
    process.exit(0);
  }
  console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
  if (fail > 0) {
    console.log('\n失败清单：');
    for (const f of failures) console.log(`  · ${f}`);
  }
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('校验脚本崩了：', e);
  process.exit(2);
});

void execFile;
void questionDir;
