/**
 * migrate-v0.ts — 把 v0 题库迁移到 v1
 *
 * 安全原则：
 *   · **默认只做 dry-run**（不写盘），先给你一份"将要做什么"的报告
 *   · 加 --apply 才真的写；写的是**新的目标库**，源库一个字都不动
 *   · 旧 qid（v0 是 Date.now() 的 16 位数）会被重新分配成 0001 起的顺序号 —— 不可逆，所以必须看报告
 *
 * 用法：
 *   npx tsx scripts/migrate-v0.ts                          # dry-run，源 ../题库 → 目标 <系统临时目录>/quirex-v1
 *   npx tsx scripts/migrate-v0.ts --from D:\我的Vault --to D:\我的Vault-v1
 *   npx tsx scripts/migrate-v0.ts --apply                  # 真的写
 *   npx tsx scripts/migrate-v0.ts --limit 5 --apply        # 只迁前 5 道（试跑）
 *
 * 字段映射：
 *   单选题→单选 / 多选题→多选 / 填空题→填空 / 解答题→解答
 *   exam_type → 丢弃（v1 没有类别）    grade / semester → 丢弃
 *   tags / ai_tags → 丢弃              status: 待入库 → 启用
 *   [选] → \pick   [填] → \fillin   [多选] → \pick
 *   <table>…</table> → tabular 环境（两端都能渲染）
 *   ![](images/x.jpg) → 图片拷进题目文件夹，按 {qid}-{通道}-NN 命名，正文改成 \includegraphics / \fig
 *   ## 解析 → 并入答案（答案与解析合并）    ### 我的备注 → 描述
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import matter from 'gray-matter';

import * as service from '../src/lib/service';
import { buildTabular, parseWidth } from '../src/lib/latexSubset';
import { composeStemTex } from '../src/lib/latexCompose';
import { listQidFolders, isQidName, isQuestionId, qidToNumber, numberToQid } from '../src/lib/paths';
import { parseDifficultyField, parseNumberField } from '../src/lib/validate';
import { resolvePathValue } from '../src/lib/config';
import { DEFAULT_SUBJECT_DIR } from '../src/lib/subjects';
import type { ImageChannel, QuestionType } from '../src/lib/types';

// ============================================================
// 参数
// ============================================================

function argValue(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : fallback;
}

/**
 * 默认源库 = **当前题库位置**（跟应用同一套解析：config.json > 环境变量 > 默认）。
 * 默认目标库 = **系统临时目录**里的 quirex-v1，刻意不落在项目文件夹里 ——
 * 迁移是"看一眼结果"的一次性动作，别在你的文件夹里留下一个 题库-v1。
 * 想留住结果就显式写 `--to`（README 里就是这么示范的）。
 */
const FROM = path.resolve(argValue('from', resolvePathValue('vaultPath'))!);
const TO = path.resolve(argValue('to', path.join(os.tmpdir(), 'quirex-v1'))!);
const APPLY = process.argv.includes('--apply');
const LIMIT = Number(argValue('limit', '0')) || 0;

/**
 * v9：迁移出来的库按**学科 A** 写 qid（`AT0001`…）。
 *
 * 为什么写死而不是用"当前学科"：迁移的落点由 `--to` 指定，跟界面里选中的
 * 学科没有关系 —— 用当前学科的话，"界面停在化学时迁移"会得到一批 BT0001，
 * 让人完全摸不着头脑。迁移产物是一套新库，就是 A。
 */
const MIGRATE_SUBJECT = 'A';

const TYPE_MAP: Record<string, QuestionType> = {
  单选题: '单选',
  多选题: '多选',
  填空题: '填空',
  解答题: '解答',
};

// ============================================================
// v0 解析
// ============================================================

interface V0Question {
  filePath: string;
  relPath: string;
  oldQid: string;
  data: Record<string, unknown>;
  sections: Record<string, string>;
}

/** 与 v0 的 parseSections 等价：## 分节，备注下面还有 ### 子节 */
function parseSections(raw: string): Record<string, string> {
  const result: Record<string, string> = {};
  const parts = raw.replace(/\r\n/g, '\n').split(/\n(?=## )/);
  for (const block of parts) {
    const m = block.match(/^## (.+?)\n([\s\S]*)$/);
    if (!m) continue;
    const title = m[1].trim();
    const body = m[2].trim();
    if (title === '备注') {
      let noteBody = '';
      for (const sub of body.split(/\n(?=### )/)) {
        const sm = sub.match(/^### (.+?)\n([\s\S]*)$/);
        if (sm) result[sm[1].trim()] = sm[2].trim();
        else noteBody += sub;
      }
      if (noteBody.trim()) result['备注'] = noteBody.trim();
    } else {
      result[title] = body;
    }
  }
  return result;
}

function scanV0(vaultDir: string): V0Question[] {
  const bank = path.join(vaultDir, '题库');
  if (!fs.existsSync(bank)) throw new Error(`源库里找不到「题库」目录：${bank}`);

  const out: V0Question[] = [];

  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // 跳过已经是本系统格式的题目目录（v4 单题 T0001… / 旧 0001…，试卷 P001…）以及系统目录
        if (isQidName(entry.name) || entry.name === '_meta') {
          continue;
        }
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.md') || entry.name.endsWith('.bak')) continue;

      const raw = fs.readFileSync(full, 'utf-8');
      let parsed;
      try {
        parsed = matter(raw);
      } catch (e) {
        console.warn(`  ! YAML 解析失败，跳过：${full}（${(e as Error).message}）`);
        continue;
      }
      out.push({
        filePath: full,
        relPath: path.relative(vaultDir, full),
        oldQid: String(parsed.data.qid ?? ''),
        data: parsed.data as Record<string, unknown>,
        sections: parseSections(parsed.content),
      });
    }
  };

  walk(bank);
  // 按旧 qid 升序 → 新 qid 顺序稳定可复现
  out.sort((a, b) => {
    const av = Number(a.oldQid) || 0;
    const bv = Number(b.oldQid) || 0;
    if (av !== bv) return av - bv;
    return a.relPath.localeCompare(b.relPath);
  });
  return out;
}

// ============================================================
// 文本转换
// ============================================================

interface PendingImage {
  channel: ImageChannel;
  buf: Buffer;
  ext: string;
  asFigure: boolean;
  width: number;
}

interface CollectContext {
  imagesDir: string;
  pending: PendingImage[];
  /** 记录每张图先落在哪个位置（题干/答案），用于事后决定通道 */
  slot: Array<'stem' | 'answer'>;
  notes: string[];
}

/** 把一个 markdown 图片引用换成占位标记，并把图片读进内存 */
function collectImage(ctx: CollectContext, ref: string, alt: string, slot: 'stem' | 'answer'): string {
  const clean = ref.split('|')[0].trim();
  const file = path.basename(clean);
  const full = path.join(ctx.imagesDir, file);

  if (!fs.existsSync(full)) {
    ctx.notes.push(`图片缺失（源库里没有）：${file}`);
    return '';
  }

  const ext = (path.extname(file).slice(1) || 'jpg').toLowerCase();
  const widthOpt = parseWidth(alt ? `width=${alt}` : undefined);
  const width = widthOpt?.kind === 'fraction' ? widthOpt.value : 0.35;

  const index = ctx.pending.length;
  ctx.pending.push({ channel: 'stem', buf: fs.readFileSync(full), ext, asFigure: false, width });
  ctx.slot.push(slot);
  return `[[img:${index}]]`;
}

/** v0 的 HTML 表格 → v1 的 tabular */
function convertHtmlTables(text: string, notes: string[]): string {
  return text.replace(/<table>([\s\S]*?)<\/table>/gi, (_full, body: string) => {
    const rows: string[][] = [];
    for (const rowMatch of body.matchAll(/<tr>([\s\S]*?)<\/tr>/gi)) {
      const cells = [...rowMatch[1].matchAll(/<t[dh]>([\s\S]*?)<\/t[dh]>/gi)].map((c) =>
        c[1].replace(/<[^>]+>/g, '').trim()
      );
      if (cells.length) rows.push(cells);
    }
    if (!rows.length) return '';
    notes.push('HTML 表格已转成 tabular 环境');
    return `\n\n${buildTabular(rows)}\n\n`;
  });
}

/** v0 的 markdown 语法 → LaTeX（只在迁移时做一次，运行期不做任何转换） */
function convertInline(text: string, ctx: CollectContext, slot: 'stem' | 'answer'): string {
  let s = text ?? '';

  // 图片（Obsidian 内嵌 + 标准 markdown 两种写法）
  s = s.replace(/!\[\[([^\]]+)\]\]/g, (_m, ref: string) => collectImage(ctx, ref, '', slot));
  s = s.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_m, alt: string, ref: string) =>
    collectImage(ctx, ref, alt, slot)
  );

  // 题型空白标记
  s = s.replace(/\[多选\]/g, '\\pick');
  s = s.replace(/\[选\]/g, '\\pick');
  s = s.replace(/\[填\]/g, '\\fillin');

  // 表格
  s = convertHtmlTables(s, ctx.notes);

  // 少数残留的 markdown 行内语法
  s = s.replace(/\*\*([^*]+)\*\*/g, '\\textbf{$1}');
  s = s.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '\\textit{$1}');

  // 分隔线
  s = s.replace(/^\s*={5,}\s*$/gm, '');

  return s.replace(/\n{3,}/g, '\n\n').trim();
}

/** 从 ## 选项 里解析出 A/B/C/D 各项 */
function parseOptions(optionText: string): string[] {
  if (!optionText) return [];
  return optionText
    .split(/\n+/)
    .map((s) => s.trim())
    .filter((s) => /^[A-Da-d]\s*[．.、)）]/.test(s))
    .map((s) => s.replace(/^[A-Da-d]\s*[．.、)）]\s*/, ''));
}

// ============================================================
// 主流程
// ============================================================

interface Migrated {
  oldQid: string;
  newQid: string;
  relPath: string;
  type: QuestionType;
  source?: string;
  number?: number;
  difficulty?: number;
  imageCount: number;
}

async function main(): Promise<void> {
  console.log('Quirex v0 → v1 迁移');
  console.log('='.repeat(64));
  console.log(`源库  ：${FROM}`);
  console.log(`目标库：${TO}`);
  console.log(`模式  ：${APPLY ? '★ APPLY（会写盘）' : 'dry-run（只出报告，不写盘）'}${LIMIT ? `  仅前 ${LIMIT} 道` : ''}`);
  console.log('');

  const all = scanV0(FROM);
  if (all.length === 0) {
    console.log('源库里没有找到 v0 格式的题目文件。');
    return;
  }
  const questions = LIMIT ? all.slice(0, LIMIT) : all;

  const imagesDir = path.join(FROM, 'images');
  const dest = TO;
  // 新库的落点 = 「学科 A（数学）」的题库目录，名字跟应用保持一致
  const destBank = path.join(dest, DEFAULT_SUBJECT_DIR);

  // 目标库里已有的单题号（纯数字目录；试卷是 P 开头，不占单题的号）
  const destQuestionNums = fs.existsSync(destBank)
    ? fs
        .readdirSync(destBank, { withFileTypes: true })
        // v4：单题目录可能是 T0001（新）或 0001（旧），两种都要算进已有数量
        .filter((e) => e.isDirectory() && isQuestionId(e.name))
        .map((e) => qidToNumber(e.name))
        .filter((n) => Number.isFinite(n))
    : [];
  const destQuestionCount = destQuestionNums.length;
  // 与 qid.ts 的分配规则一致：max(已有最大号)+1（不是"数量+1"，否则有空洞时会算错）
  const firstNewNumber = destQuestionNums.length ? Math.max(...destQuestionNums) + 1 : 1;

  console.log(`扫描到 ${all.length} 道 v0 题目${LIMIT ? `（本次处理前 ${questions.length} 道）` : ''}。`);
  if (destQuestionCount > 0) {
    console.log(
      `⚠ 目标库里已经有 ${destQuestionCount} 道单题，新题会从 ${numberToQid(firstNewNumber, MIGRATE_SUBJECT)} 号往后排。`
    );
  }
  console.log('');

  // ---- 转换（纯计算，不写盘）----
  interface Prepared {
    v0: V0Question;
    type: QuestionType;
    source?: string;
    numberRaw?: unknown;
    difficultyRaw?: unknown;
    knowledge: string[];
    description?: string;
    stem: string;
    answer: string;
    pending: PendingImage[];
    notes: string[];
    imageCount: number;
  }

  const prepared: Prepared[] = [];
  const globalNotes: string[] = [];

  for (const v0 of questions) {
    const notes: string[] = [];

    // 题型
    const rawType = String(v0.data.type ?? '').trim();
    const type = TYPE_MAP[rawType];
    if (!type) {
      notes.push(`题型「${rawType || '(空)'}」无法识别，按「解答」处理`);
    }
    const finalType: QuestionType = type ?? '解答';

    // 题号
    const numParsed = parseNumberField(v0.data.number);
    if (numParsed.error) notes.push(`题号「${String(v0.data.number)}」越界或无法解析，已留空`);
    if (numParsed.hint) notes.push(numParsed.hint);

    // 难度：v0 用 0 表示"没填"
    const rawDiff = v0.data.difficulty;
    const diffIsZero = rawDiff === 0 || rawDiff === '0' || rawDiff === '';
    const diffParsed = diffIsZero
      ? { value: null as number | null, error: undefined as string | undefined, hint: undefined as string | undefined }
      : parseDifficultyField(rawDiff);
    if (diffIsZero && rawDiff !== undefined) notes.push('v0 用 0 表示未填难度 → 已留空');
    if (diffParsed.error) notes.push(`难度「${String(rawDiff)}」越界，已留空`);

    // 知识点
    const knowledge = (Array.isArray(v0.data.knowledge) ? v0.data.knowledge : [])
      .map((k) => String(k).trim())
      .filter(Boolean);

    // 图片收集上下文
    const ctx: CollectContext = { imagesDir, pending: [], slot: [], notes };

    // 题干
    const stemText = convertInline(v0.sections['题目'] ?? '', ctx, 'stem');
    const options = parseOptions(v0.sections['选项'] ?? '');
    const composed = composeStemTex({ type: finalType, stem: stemText, options });
    notes.push(...composed.notes);

    // 答案 = 答案 + 解析（合并）
    const answerParts = [v0.sections['答案'] ?? '', v0.sections['解析'] ?? '']
      .map((t) => convertInline(t, ctx, 'answer'))
      .filter(Boolean);
    const answerText = answerParts.join('\n\n');
    if (v0.sections['解析']) notes.push('「解析」已并入答案（v1 不再分离）');

    // 描述 = 我的备注（有 AI 备注就接在后面，避免丢信息）
    const myNote = (v0.sections['我的备注'] ?? '').trim();
    const aiNote = (v0.sections['AI备注'] ?? v0.sections['AI 备注'] ?? '').trim();
    const description = [myNote, aiNote ? `【AI备注】${aiNote}` : ''].filter(Boolean).join('\n\n') || undefined;

    // 图片通道：题干里除了图片还有正文 → 当示意图（居中带图号）；纯图题 → 当题干图。
    // 答案同理：答案里还有文字就走 ansfig（答案示意图），整页就是图才走 ans（答案图本身）。
    const stripForProbe = (s: string) =>
      s.replace(/\[\[img:\d+\]\]/g, '').replace(/\\[a-zA-Z]+/g, '').replace(/[{}$\s]/g, '');
    const stemHasText = stripForProbe(composed.tex).length > 0;
    const answerHasText = stripForProbe(answerText).length > 0;

    ctx.pending.forEach((img, i) => {
      const slot = ctx.slot[i];
      if (slot === 'stem') {
        img.channel = stemHasText ? 'fig' : 'stem';
        img.asFigure = stemHasText;
      } else {
        img.channel = answerHasText ? 'ansfig' : 'ans';
        img.asFigure = answerHasText;
      }
    });

    if (v0.data.tags && (v0.data.tags as unknown[]).length) notes.push('旧 tags 字段已丢弃（v1 没有自定义标签）');
    if (v0.data.ai_tags && (v0.data.ai_tags as unknown[]).length) notes.push('旧 ai_tags 字段已丢弃');
    if (v0.data.grade) notes.push('旧 grade（年级）已丢弃');
    if (v0.data.semester) notes.push('旧 semester（学期）已丢弃');
    if (v0.data.exam_type) notes.push('旧 exam_type（类别）已丢弃');

    prepared.push({
      v0,
      type: finalType,
      source: v0.data.source ? String(v0.data.source).trim() : undefined,
      numberRaw: numParsed.error ? undefined : (numParsed.value ?? undefined),
      difficultyRaw: diffParsed.error ? undefined : (diffParsed.value ?? undefined),
      knowledge,
      description,
      stem: composed.tex,
      answer: answerText,
      pending: ctx.pending,
      notes,
      imageCount: ctx.pending.length,
    });
  }

  // ---- 报告 ----
  const typeCount = new Map<string, number>();
  let totalImages = 0;
  let totalNotes = 0;
  for (const p of prepared) {
    typeCount.set(p.type, (typeCount.get(p.type) ?? 0) + 1);
    totalImages += p.imageCount;
    totalNotes += p.notes.length;
  }

  console.log('类型分布       ：' + [...typeCount.entries()].map(([k, v]) => `${k} ${v}`).join('  '));
  console.log(`图片总数       ：${totalImages}`);
  console.log(`提示/待修正项  ：${totalNotes}`);
  const withNotes = prepared.filter((p) => p.notes.length);
  console.log(`有提示的题目   ：${withNotes.length} 道`);
  console.log('');

  console.log('id 映射（旧 → 新）：');
  const base = firstNewNumber;
  prepared.forEach((p, i) => {
    const newId = numberToQid(base + i, MIGRATE_SUBJECT);
    const bits = [
      `新 ${newId}`,
      p.type,
      p.source ?? '(无来源)',
      p.numberRaw !== undefined ? `第${p.numberRaw}题` : '无题号',
      p.difficultyRaw !== undefined ? `难度${p.difficultyRaw}` : '难度未录入',
      p.imageCount ? `${p.imageCount}图` : '',
    ].filter(Boolean);
    console.log(`  旧 ${p.v0.oldQid || '(无)'}  →  ${bits.join('  ')}`);
  });
  console.log('');

  if (totalNotes) {
    console.log('待修正 / 提示清单：');
    for (const p of withNotes) {
      console.log(`  · ${p.v0.relPath}`);
      for (const n of p.notes) console.log(`      - ${n}`);
    }
    console.log('');
  }

  if (!APPLY) {
    console.log('以上是 dry-run 报告，**没有写任何文件**。');
    console.log('确认无误后加 --apply 真的迁移：');
    console.log(`  npx tsx scripts/migrate-v0.ts --from "${FROM}" --to "${TO}" --apply`);
    return;
  }

  // ---- 写盘 ----
  console.log(`开始写入目标库：${dest}`);
  process.env.VAULT_PATH = dest;
  service.ensureWorkspace();

  const done: Migrated[] = [];
  for (const p of prepared) {
    try {
      const { qid, warnings } = await service.createQuestion({
        kind: '单题',
        type: p.type,
        source: p.source,
        number: p.numberRaw,
        difficulty: p.difficultyRaw,
        knowledge: p.knowledge,
        description: p.description,
        stem: p.stem,
        answer: p.answer,
        pendingImages: p.pending.length ? p.pending : undefined,
      });
      done.push({
        oldQid: p.v0.oldQid,
        newQid: qid,
        relPath: p.v0.relPath,
        type: p.type,
        source: p.source,
        number: p.numberRaw as number | undefined,
        difficulty: p.difficultyRaw as number | undefined,
        imageCount: p.imageCount,
      });
      if (warnings.length) {
        // createQuestion 的软提示
        globalNotes.push(`${qid}: ${warnings.join('；')}`);
      }
    } catch (e) {
      console.error(`  ✗ ${p.v0.relPath} 迁移失败：${(e as Error).message}`);
      globalNotes.push(`${p.v0.relPath}: 迁移失败 ${(e as Error).message}`);
    }
  }

  // ---- 映射表落盘，便于回溯 ----
  service.ensureWorkspace();
  const mapFile = path.join(dest, DEFAULT_SUBJECT_DIR, '_meta', 'migration-map.json');
  fs.writeFileSync(
    mapFile,
    JSON.stringify(
      {
        migratedAt: new Date().toISOString(),
        from: FROM,
        to: dest,
        count: done.length,
        questions: done,
        notes: globalNotes,
      },
      null,
      2
    ) + '\n',
    'utf-8'
  );

  const vocab = service.listTags(true);
  console.log('');
  console.log(`✓ 迁移完成：${done.length} 道题`);
  console.log(`  目标库题目数：${listQidFolders().length}`);
  console.log(`  来源 ${vocab.source.length} 个 / 知识点 ${vocab.knowledge.length} 个`);
  console.log(`  映射表：${mapFile}`);
  console.log('');
  console.log('源库完全没有被改动。用新库启动：');
  console.log(`  把 .env.local 里的 VAULT_PATH 改成 ${dest}`);
}

main().catch((e) => {
  console.error('迁移失败：', e);
  process.exit(1);
});
