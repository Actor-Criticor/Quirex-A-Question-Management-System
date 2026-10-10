/**
 * latexExport.ts — 导出「可直接编译」的 LaTeX 讲义文件夹
 *
 * 设计要点（方案 §13）：
 *   1) 题目正文**原样**从 题干.tex / 答案.tex 取出塞进模板 —— 不做任何格式转换。
 *      所以"网页显示"与"PDF 结果"不可能不一致。
 *   2) 图片引用在库里就写成 images/{qid}-{通道}-NN.png，全库唯一
 *      → 导出只是**复制文件**，.tex 一个字都不用改（零重写、零漂移）。
 *   3) 导出后自动跑一次 xelatex，把编译结果回报给界面 —— 编译不过当场就知道是哪道题。
 *   4) **只导单题**。整卷（v7 起）不进试题篮：试卷页上是 PDF，没有可重新排版的内容，
 *      复制一份 PDF 到导出目录没有任何意义。整卷的正确用法是"当来源"——
 *      在题库浏览里看它名下有哪些题，把那些题加进篮子。
 */

import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import {
  type QuestionMeta,
  type ExportInfoOptions,
  DEFAULT_EXPORT_INFO,
  FIG_ALIGN_TEX,
  coerceExportInfo,
  resolveFigAlign,
} from './types';
import { exportRootDir, ensureDir, questionDir } from './paths';
import { resolvePathValue } from './config';
import { readContent, readMeta } from './store';
import { difficultyToBand } from './validate';
import { imageBasename, splitSegments } from './latexSubset';
import { applyTemplate, listTemplateInfos, validateTemplate, type TemplateInfo } from './templates';
import { buildInfoLabel as buildInfoLabelPure } from './exportLabel';
import type { BasketExportOptions, BasketGroup } from './baskets';
import { GROUP_TYPE_ORDER } from './baskets';

// ============================================================
// 模板（v6：契约见 lib/templates.ts，这里只管"用"）
// ============================================================

export function templatesRootDir(): string {
  // v6：走配置层 —— config.json > 环境变量 TEMPLATES_DIR > 默认 <项目>/templates
  return resolvePathValue('templatesDir');
}

/** v6：xelatex 可执行文件。留空 = 交给系统 PATH */
export function xelatexBin(): string {
  return resolvePathValue('xelatexPath') || 'xelatex';
}

/**
 * 取一个可用模板。**不可用的模板在这里直接抛错**，并把校验问题原样带上 ——
 * 导出过程中途才炸、或者悄悄用一个坏模板编出一份错的 PDF，都比这糟糕。
 */
export function resolveTemplate(name = '默认'): TemplateInfo {
  if (name.includes('/') || name.includes('\\') || name.includes('..')) {
    throw new Error(`模板名不合法：${name}`);
  }
  const dir = path.join(templatesRootDir(), name);
  if (!fs.existsSync(dir)) {
    const list = listTemplateInfos(templatesRootDir()).map((t) => t.id);
    throw new Error(
      `模板「${name}」不存在。${list.length ? `现有模板：${list.join('、')}` : '模板目录里还没有模板。'}`
    );
  }
  const info = validateTemplate(dir, name);
  if (!info.usable) {
    throw new Error(`模板「${name}」不可用：\n· ${info.issues.join('\n· ')}`);
  }
  return info;
}

/** 兼容旧调用：只要目录路径 */
export function getTemplateDir(name = '默认'): string {
  return resolveTemplate(name).dir;
}

/** 可用的模板名列表 */
export function listTemplates(): string[] {
  return listTemplateInfos(templatesRootDir())
    .filter((t) => t.usable)
    .map((t) => t.id);
}

// ============================================================
// 预设 / 版式
// ============================================================

const PRESET_MACRO = {
  student: '\\presetStudent',
  answer: '\\presetAnswer',
  teacher: '\\presetTeacher',
  slide: '\\presetSlide',
} as const;

/** v2：版式固定标准（不再给用户选） */
const LAYOUT_MACRO = {
  compact: '\\compactLayout',
  normal: '\\normalLayout',
  spacious: '\\spaciousLayout',
} as const;

// ============================================================
// 模板替换
// ============================================================
//
// v6：applyTemplate / TEMPLATE_TOKENS 搬到 lib/templates.ts 了 ——
// 那边定义"契约"（meta.json 怎么描述一个模板、怎么校验），这边只管用。
// 这里保留一个转发导出，免得老代码/脚本里的 import 断掉。
export { applyTemplate, KNOWN_TOKENS as TEMPLATE_TOKENS } from './templates';


// ============================================================
// 正文生成
// ============================================================

/** 留白档位：按难度档位和题型挑（v2：用 基础/压轴/困难） */
function blankLevel(meta: QuestionMeta): 'SS' | 'S' | 'M' | 'L' {
  const band = difficultyToBand(meta.difficulty);
  const isChoiceOrBlank = meta.type === '单选' || meta.type === '多选' || meta.type === '填空';

  if (isChoiceOrBlank) {
    if (band === '困难') return 'M';
    if (band === '压轴') return 'S';
    return 'SS';
  }
  // 解答题：越难留白越多
  if (band === '困难' || band === '压轴') return 'L';
  return 'M';
}

/**
 * 题目标注行 —— 拼装逻辑在 lib/exportLabel.ts（那份是纯函数，导出弹窗的
 * 实时预览用的是同一个函数，保证"预览什么导出就是什么"）。
 * 这里只保留一层薄封装：老调用点按 `buildResLabel(meta)` 用。
 */
export function buildInfoLabel(meta: QuestionMeta, info: ExportInfoOptions): string | null {
  return buildInfoLabelPure(meta, info, true);
}

/** 老名字：只给「来源 第N题」时用它（v6 起由 buildInfoLabel 承担全部） */
export function buildResLabel(meta: QuestionMeta): string | null {
  return buildInfoLabelPure(meta, {
    ...DEFAULT_EXPORT_INFO,
    difficulty: false,
    knowledge: false,
    year: false,
  });
}

/** 只处理最有破坏力的 %（会把后面整行注掉）；其余靠 xelatex 校验兜底 */
function sanitizeTex(text: string): string {
  return (text ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/(^|[^\\])%/g, '$1\\%')
    .trim();
}

export interface BuiltQuestion {
  qid: string;
  meta: QuestionMeta;
  tex: string;
  /** 该题引用到的图片文件名 */
  images: string[];
}

/** 把一道单题编译成 exercise 片段 */
export function buildExercise(
  meta: QuestionMeta,
  stem: string,
  answer: string,
  info: ExportInfoOptions = DEFAULT_EXPORT_INFO
): BuiltQuestion {
  const lines: string[] = [];
  // v5：第二个可选参数 = 配图位置（meta.figAlign 优先，没设过按题型推导）。
  // 「简答题的示意图靠右」这条习惯就由这里自动带上，录入时也能手动覆盖。
  const align = FIG_ALIGN_TEX[resolveFigAlign(meta.type, meta.figAlign)];
  lines.push(`\\begin{exercise}[${blankLevel(meta)}][${align}]`);

  // v6：题目信息由导出选项决定装什么（来源/题号/难度/知识点/年份）
  // v10：创新改成一顆五角星；多选题**永远**带「（多选）」—— 不再是可勾选的项
  const tag: string[] = [];
  const label = buildInfoLabel(meta, info);
  if (label) tag.push(`\\qinfo{${label}}`);
  if (info.innovation && meta.innovation) tag.push('$\\bigstar$');
  if (meta.type === '多选') tag.push('（多选）');
  if (tag.length) lines.push(tag.join(''));
  lines.push('');

  lines.push(sanitizeTex(extractBody(stem)));

  const ans = sanitizeTex(extractBody(answer));
  if (ans) {
    lines.push('');
    lines.push(`\\ans{${ans}}`);
  }

  lines.push('\\end{exercise}');
  lines.push('');

  const images = [...splitSegments(stem ?? ''), ...splitSegments(answer ?? '')]
    .filter((s) => s.type === 'image')
    .map((s) => imageBasename(s.value))
    .filter(Boolean);

  return { qid: meta.qid, meta, tex: lines.join('\n'), images };
}

/** 去掉可能存在的 choices 之外的空壳，同时保留正文原样（含 choices 环境） */
function extractBody(tex: string): string {
  return (tex ?? '').replace(/^\s*={5,}\s*$/gm, '').trim();
}

export interface HandoutBuild {
  body: string;
  questions: BuiltQuestion[];
  /** qid → 需要的图片文件名 */
  imagesByQid: Map<string, string[]>;
  warnings: string[];
}

/** 按分组方式把题目拼成正文 */
export function buildHandoutBody(
  items: BuiltQuestion[],
  group: BasketGroup
): HandoutBuild {
  const warnings: string[] = [];
  const imagesByQid = new Map<string, string[]>();
  for (const it of items) imagesByQid.set(it.qid, it.images);

  if (group === 'flat' || items.length === 0) {
    return { body: items.map((i) => i.tex).join('\n'), questions: items, imagesByQid, warnings };
  }

  const buckets = new Map<string, BuiltQuestion[]>();

  if (group === 'source') {
    for (const it of items) {
      const key = it.meta.source ?? '未指定来源';
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key)!.push(it);
    }
  } else if (group === 'type') {
    // v10：按题型。**章序固定**（单选→多选→填空→解答），不按题号也不按篮子顺序 ——
    // 一份卷子读起来就该是这个顺序，这也是你要它排在分组里的原因。
    for (const t of GROUP_TYPE_ORDER) {
      const list = items.filter((i) => i.meta.type === t);
      if (list.length) buckets.set(t, list);
    }
    // 兜底：万一有题没题型（老数据），别把它悄悄丢掉
    const rest = items.filter((i) => !(GROUP_TYPE_ORDER as readonly string[]).includes(i.meta.type ?? ''));
    if (rest.length) buckets.set('未标题型', rest);
  } else {
    // 按知识点：每题只归入它的第一个知识点，避免同一道题在多处重复出现
    for (const it of items) {
      const key = it.meta.knowledge?.[0] ?? '未归类';
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key)!.push(it);
    }
    const multi = items.filter((i) => (i.meta.knowledge?.length ?? 0) > 1);
    if (multi.length) {
      warnings.push(
        `按知识点分组时，${multi.length} 道有多个知识点的题只归入了第一个知识点（避免重复出现）`
      );
    }
  }

  const chunks: string[] = [];
  for (const [key, list] of buckets) {
    // 按来源用 \chapter（换页起新章）；其余用 \section（接着排）
    chunks.push(group === 'source' ? `\\chapter{${key}}` : `\\section{${key}}`);
    chunks.push(list.map((i) => i.tex).join('\n'));
  }

  return { body: chunks.join('\n'), questions: items, imagesByQid, warnings };
}

// ============================================================
// 打包
// ============================================================

/**
 * 把讲义标题变成能当文件夹名的字符串（v6）。
 *
 * 导出文件夹以前固定叫 `讲义_时间戳`，于是导出历史里一列全是「讲义_2026…」，
 * 根本认不出哪次是哪次。现在用 `<标题>_<时间戳>`，一眼能认出。
 *
 * Windows 文件名不能含 `\ / : * ? " < > |`，也不能以点或空格结尾；
 * 再顺手压掉连续下划线、限长（标题可以很长，文件夹名不行）。
 */
export function sanitizeFolderName(title: string, maxLen = 60): string {
  return (title ?? '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_') // 非法字符
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '') // Windows 不允许点/空格结尾
    .replace(/_{2,}/g, '_')
    .slice(0, maxLen)
    .replace(/[. ]+$/, '');
}

export interface ExportResult {
  folder: string;
  outDir: string;
  /** 使用的模板 id（文件夹名）与显示名 */
  template: string;
  templateName: string;
  count: number;
  imageCount: number;
  warnings: string[];
  /** v6：分段耗时（毫秒），用来回答"到底慢在哪" */
  timings: {
    readMs: number;
    writeMs: number;
    compileMs: number;
    questionsMs: number;
    answersMs: number;
    totalMs: number;
    /** 实际跑了几次 xelatex（正常应为 2） */
    xelatexRuns: number;
  };
  /** 两个 PDF 的编译结果 */
  compile: {
    questions: CompileResult;
    answers: CompileResult;
    /** 两个都成功才算整体成功 */
    ok: boolean;
    pdfs: string[];
  };
}

export interface ExportInput {
  title: string;
  qids: string[];
  options: BasketExportOptions;
  author?: string;
}

const BUILD_BAT = `@echo off
REM Quirex 讲义编译脚本
REM 输出：题目.pdf（只有题干 + 留白）与 答案.pdf（题干 + 答案）
chcp 65001 >nul
cd /d "%~dp0"
echo 正在编译 题目.tex ...
xelatex -interaction=nonstopmode "题目.tex"
xelatex -interaction=nonstopmode "题目.tex"
echo 正在编译 答案.tex ...
xelatex -interaction=nonstopmode "答案.tex"
xelatex -interaction=nonstopmode "答案.tex"
echo.
if exist "题目.pdf" (echo 完成 -^> 题目.pdf) else (echo 题目.pdf 编译失败，请查看 题目.log)
if exist "答案.pdf" (echo 完成 -^> 答案.pdf) else (echo 答案.pdf 编译失败，请查看 答案.log)
pause
`;

const BUILD_SH = `#!/bin/sh
# Quirex 讲义编译脚本：产出 题目.pdf 与 答案.pdf
set -e
cd "$(dirname "$0")"
xelatex -interaction=nonstopmode "题目.tex"; xelatex -interaction=nonstopmode "题目.tex"
xelatex -interaction=nonstopmode "答案.tex"; xelatex -interaction=nonstopmode "答案.tex"
echo "完成 -> 题目.pdf / 答案.pdf"
`;

/**
 * 编译说明。v6 起「样式文件名」不再写死 —— 由调用方按模板的 styleFiles 传进来，
 * 否则改个 .sty 名字，这份说明就会指向一个不存在的文件。
 */
function readmeTxt(styleFiles: string[], templateName: string): string {
  return `Quirex 导出讲义 —— 说明
==================================

交付物（两个 PDF）
------------------
题目.pdf    只有题干，带做题留白 —— 给学生做
答案.pdf    题干 + 答案 —— 给老师 / 对答案

这个文件夹是自包含的，拿到任何装了 TeX Live / MiKTeX 的机器上都能重新编译。

重新编译
--------
Windows：双击 build.bat
macOS / Linux： sh build.sh
或手动：
    xelatex "题目.tex"    （跑两遍，第二遍解决交叉引用）
    xelatex "答案.tex"

用 xelatex，不要用 pdflatex —— 讲义用 ctex 处理中文。

文件说明
--------
题目.tex / 答案.tex   讲义正文（同一份内容，只有开头的显示预设不同）
${styleFiles.map((f) => `${f.padEnd(21)}样式（题目环境、示意图 \\fig、答案标签）`).join('\n')}
images/               题目用到的图片（文件名带 id 前缀，全局唯一）
build.bat / build.sh  一键编译

题目.tex 与 答案.tex 的区别只在开头一行：
    题目.tex → \\presetStudent   （显示题干、留白打开、不显示答案）
    答案.tex → \\presetTeacher   （显示题干与答案、留白关闭）

本次使用的模板：${templateName}
改外观：编辑模板目录里的 main.tex（默认是「模板/默认/」），下次导出就会用新的。
`;
}

export interface CompileResult {
  ok: boolean;
  pdfExists: boolean;
  errorCount: number;
  warningCount: number;
  log: string;
  /**
   * v6：实际跑了几遍 xelatex。
   * 以前是**无条件跑两遍**（4 次串行调用里有一半是白跑的）——
   * 本项目图号用 `\themafig` 直接计数、模板里也没有 `\ref`/`\label`/`\tableofcontents`，
   * 所以正常情况下**一遍就够**，只有日志里明确要求 Rerun 时才补第二遍。
   */
  passes: number;
  /** v6：这一遍的耗时（毫秒），用于界面显示"慢在哪" */
  ms: number;
}

/**
 * 分析 xelatex 日志。
 *
 * 关键教训：nonstopmode 下即使文档彻底坏掉，xelatex 仍会吐出一张 PDF。
 * 所以**不能用「PDF 存在」当成功判据** —— 必须去日志里数真正的错误（`! ` 开头）。
 */
function analyzeLogFile(outDir: string, baseName: string): { errors: string[]; warnings: number } {
  const logPath = path.join(outDir, `${baseName}.log`);
  if (!fs.existsSync(logPath)) {
    return { errors: [`没有生成 ${baseName}.log（xelatex 可能没跑起来）`], warnings: 0 };
  }
  const text = fs.readFileSync(logPath, 'utf-8');
  const lines = text.split(/\r?\n/);

  const errors: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('! ')) {
      errors.push(lines.slice(i, i + 3).join(' ⏎ ').trim());
    }
  }
  if (/Emergency stop/.test(text) && errors.length === 0) {
    errors.push('xelatex 紧急停止（Emergency stop）');
  }

  const warnings = (text.match(/^(Overfull|Underfull|LaTeX Warning)/gm) ?? []).length;
  return { errors, warnings };
}

/**
 * v6：这一遍跑完后，到底**需不需要**再跑一遍？
 *
 * 这里必须分清楚两类"要 rerun"：
 *
 *   A. **内容正确性**（必须补跑）
 *      · `There were undefined references`  —— 有 \ref 没解析出来，页面上会印 ??
 *      · `Label(s) may have changed`         —— 引用值变了，必须重排
 *
 *   B. **PDF 元数据簿记**（多数情况不值当）
 *      · `Rerun to get /PageLabels entry`    —— hyperref 的页标签，看不见
 *      · `Rerun to get outlines right`       —— 书签。**但只有真的生成了书签才值得补跑**：
 *        日志里那一行的校验和如果是空文件的 MD5（D41D8CD9…），说明 .out 里什么都没有，
 *        补跑一遍也是白补。
 *
 * 实测：本项目模板第一遍就会报 B 类，于是以前"无条件两遍"看起来很有道理，
 * 其实第二遍什么都没改 —— 白白多花约 3 秒。
 */
function logWantsRerun(outDir: string, baseName: string): boolean {
  const logPath = path.join(outDir, `${baseName}.log`);
  if (!fs.existsSync(logPath)) return false;
  const text = fs.readFileSync(logPath, 'utf-8');

  // A 类：内容有问题，必须补
  if (/There were undefined references/i.test(text)) return true;
  if (/Label\(s\) may have changed/i.test(text)) return true;

  // B 类里的书签：只有真的写出了书签才补
  if (/Rerun to get outlines right/i.test(text)) {
    const outFile = path.join(outDir, `${baseName}.out`);
    try {
      if (fs.existsSync(outFile) && fs.statSync(outFile).size > 0) return true;
    } catch {
      /* 读不到就当没有书签 */
    }
  }

  // 剩下的（PageLabels 之类）是纯 PDF 元数据，不值得为它多跑一遍
  return false;
}

/**
 * 编译一个 .tex，然后按日志判定成功与否。
 *
 * v6 的两处改动：
 *   1. **第 2 遍改成按需** —— 只在日志里真的出现 Rerun 才补一遍（以前无条件两遍）
 *   2. **修掉 spawn 错误的死代码** —— 以前 `try { await once() } catch { spawnProblem }`
 *      永远进不去 catch（once() 把错误转成了字符串 resolve），
 *      于是"找不到 xelatex"时报的是日志里那句难懂的话。现在按 ENOENT 单独识别。
 */
function runXelatex(outDir: string, baseName: string, maxPasses = 2): Promise<CompileResult> {
  const bin = xelatexBin();
  const texFile = `${baseName}.tex`;

  /** 跑一遍；返回这一遍的耗时，以及"是不是根本没能启动 xelatex" */
  const once = () =>
    new Promise<{ ms: number; spawnError: string | null }>((resolve) => {
      const t0 = Date.now();
      execFile(
        bin,
        ['-interaction=nonstopmode', '-file-line-error', texFile],
        { cwd: outDir, timeout: 180000, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
        (err) => {
          const ms = Date.now() - t0;
          const e = err as (Error & { code?: string }) | null;
          // ENOENT = 找不到这个程序（跟"文档里有 LaTeX 错误"是两回事，要分开报）
          const missing = e && (e.code === 'ENOENT' || /ENOENT/.test(e.message));
          if (missing) {
            resolve({
              ms,
              spawnError: `找不到 xelatex（当前用的是「${bin}」）。请确认已安装 TeX Live，或在设置里指定 xelatex 的完整路径。`,
            });
          } else {
            resolve({ ms, spawnError: null });
          }
        }
      );
    });

  return (async () => {
    const t0 = Date.now();
    let passes = 0;

    const first = await once();
    passes = 1;
    if (first.spawnError) {
      return {
        ok: false,
        pdfExists: false,
        errorCount: 1,
        warningCount: 0,
        log: first.spawnError,
        passes,
        ms: Date.now() - t0,
      };
    }

    // 只有日志明确要求时才补第二遍
    if (maxPasses > 1 && logWantsRerun(outDir, baseName)) {
      await once();
      passes = 2;
    }

    const pdfExists = fs.existsSync(path.join(outDir, `${baseName}.pdf`));
    const { errors, warnings } = analyzeLogFile(outDir, baseName);
    const ok = pdfExists && errors.length === 0;
    const log = errors.length
      ? [...errors.slice(0, 8), ...(errors.length > 8 ? [`…还有 ${errors.length - 8} 条错误`] : [])].join('\n')
      : pdfExists
        ? ''
        : `没有生成 ${baseName}.pdf`;

    return {
      ok,
      pdfExists,
      errorCount: errors.length,
      warningCount: warnings,
      log,
      passes,
      ms: Date.now() - t0,
    };
  })();
}

// ============================================================
// 主流程
// ============================================================

export async function exportHandout(input: ExportInput): Promise<ExportResult> {
  const tAll = Date.now();
  const warnings: string[] = [];

  const templateName = input.options.template || '默认';
  // v6：模板在这里就解析并校验完 —— 坏模板当场报错，不会导到一半才炸
  const tpl = resolveTemplate(templateName);
  const tplManifest = tpl.manifest!;
  const group = (input.options.group ?? 'flat') as BasketGroup;
  // v6：题目信息要装哪些（来源/题号/难度/知识点/年份/两个标记）
  const infoOpts = coerceExportInfo(input.options.info);

  // v2：顺序永远是试题篮里的顺序（不再有「按 id 排序」选项）
  const qids = [...input.qids];

  // ---- 只收单题（整卷不进试题篮，见文件头说明）----
  const tRead = Date.now();
  const singles: BuiltQuestion[] = [];

  for (const qid of qids) {
    const meta = readMeta(qid);
    if (!meta) {
      warnings.push(`${qid} 不存在，已跳过`);
      continue;
    }
    if (meta.status === '停用') {
      warnings.push(`${qid} 已停用，已跳过（讲义只收启用中的题）`);
      continue;
    }
    if (meta.kind === '整卷') {
      // v7：正常进不来（加入试题篮那一步就挡住了）。真出现了就明说，别默默跳过。
      warnings.push(`${qid} 是整卷，已跳过（整卷不进试题篮，也不参与讲义导出）`);
      continue;
    }

    const stem = readContent(qid, 'stem');
    const answer = readContent(qid, 'answer');
    if (!stem.trim()) warnings.push(`单题 ${qid} 没有题干，已跳过`);
    else singles.push(buildExercise(meta, stem, answer, infoOpts));
  }

  const built = buildHandoutBody(singles, group);
  warnings.push(...built.warnings);
  const readMs = Date.now() - tRead;

  // ---- 建导出文件夹 ----
  // v6：文件夹名带标题，导出历史里一眼认得出是哪次。
  // v8：不再拼 `<标题>_<时间戳>` —— 标题的**默认值本身就是时间戳**了，
  //     再拼一遍会变成「2026-10-09 21:30_20261009_213000」这种啰嗦名字。
  //     改成「文件夹名 = 清洗后的标题」，重名时加 -2、-3（同一天导两次也不会打架）。
  const tWrite = Date.now();
  const wantedTitle = (input.title ?? '').trim();
  const folderBase = sanitizeFolderName(wantedTitle) || '讲义';
  const root = exportRootDir();
  let folder = folderBase;
  for (let n = 2; fs.existsSync(path.join(root, folder)) && n < 1000; n++) {
    folder = `${folderBase}-${n}`;
  }
  const outDir = path.join(root, folder);
  ensureDir(outDir);
  const imagesDir = path.join(outDir, 'images');
  ensureDir(imagesDir);

  // ---- 两个 .tex：同一份正文，只有开头的显示预设不同 ----
  const template = fs.readFileSync(path.join(tpl.dir, 'main.tex'), 'utf-8');
  const today = new Date();
  const dateText = `${today.getFullYear()} 年 ${today.getMonth() + 1} 月 ${today.getDate()} 日`;

  // v6：只替换模板自己声明用到的占位符（校验已保证"声明过的各出现恰好一次"）
  const tplTokens = tplManifest.tokens;

  const makeTex = (presetMacro: string, title: string): string => {
    const tex = applyTemplate(
      template,
      {
        TITLE: title,
        AUTHOR: input.author ?? '',
        DATE: dateText,
        PRESET: presetMacro,
        LAYOUT: LAYOUT_MACRO.normal,
        BODY: built.body,
      },
      tplTokens
    );

    // 结构自检：正文必须在 \begin{document} 之后（挡「内容被注进注释」那类模板事故）
    const docIdx = tex.indexOf('\\begin{document}');
    const exIdx = tex.indexOf('\\begin{exercise}');
    if (docIdx === -1) throw new Error('套用模板后没有 \\begin{document}，模板有问题');
    if (exIdx !== -1 && exIdx < docIdx) {
      throw new Error('套用模板后题目出现在 \\begin{document} 之前，模板或替换逻辑有问题');
    }
    return tex;
  };

  // 标题留空时用文件夹名当标题（含时间戳，至少不会是一张无名讲义）
  const baseTitle = wantedTitle || folder;
  fs.writeFileSync(
    path.join(outDir, '题目.tex'),
    makeTex(PRESET_MACRO.student, baseTitle),
    'utf-8'
  );
  fs.writeFileSync(
    path.join(outDir, '答案.tex'),
    makeTex(PRESET_MACRO.teacher, `${baseTitle}（答案）`),
    'utf-8'
  );

  // ---- 样式文件：按 meta.json 的 styleFiles 原样复制 ----
  // v6 之前这里硬编码 mathatlas.sty，于是改个名字都得改代码。
  for (const name of tplManifest.styleFiles) {
    fs.copyFileSync(path.join(tpl.dir, name), path.join(outDir, name));
  }

  // ---- 图片：只复制文件，不改 .tex（文件名已带 id 前缀，全库唯一）----
  const copied = new Set<string>();
  for (const q of built.questions) {
    for (const name of q.images) {
      const src = path.join(questionDir(q.qid), name);
      if (!fs.existsSync(src)) {
        warnings.push(`图片缺失：${q.qid}/${name}`);
        continue;
      }
      if (copied.has(name)) continue;
      fs.copyFileSync(src, path.join(imagesDir, name));
      copied.add(name);
    }
  }

  // ---- 编译脚本与说明 ----
  fs.writeFileSync(path.join(outDir, 'build.bat'), BUILD_BAT, 'utf-8');
  fs.writeFileSync(path.join(outDir, 'build.sh'), BUILD_SH, 'utf-8');
  fs.writeFileSync(
    path.join(outDir, '编译说明.txt'),
    readmeTxt(tplManifest.styleFiles, tplManifest.name),
    'utf-8'
  );

  if (warnings.length) {
    fs.appendFileSync(
      path.join(outDir, '编译说明.txt'),
      `\n\n本次导出的提示\n--------------\n${warnings.map((w) => `· ${w}`).join('\n')}\n`,
      'utf-8'
    );
  }

  // ---- 两个 PDF 都编译一遍并校验 ----
  //
  // v6：**并行**。以前是 `await 编译题目` → `await 编译答案` 串行，
  // 加上每个文件无条件跑两遍 → 4 次 xelatex 首尾相接。
  // 现在：第 2 遍按需（正常只跑 1 遍）+ 两个文件同时编译 → 实测 12.7s → 约 4s。
  const writeMs = Date.now() - tWrite;
  const empty: CompileResult = {
    ok: true,
    log: '',
    pdfExists: false,
    errorCount: 0,
    warningCount: 0,
    passes: 0,
    ms: 0,
  };

  const hasQuestions = built.questions.length > 0;
  const tCompile = Date.now();

  const [compileQuestions, compileAnswers] = hasQuestions
    ? await Promise.all([runXelatex(outDir, '题目'), runXelatex(outDir, '答案')])
    : [empty, empty];

  const compileMs = Date.now() - tCompile;

  const pdfs: string[] = [];
  if (compileQuestions.pdfExists) pdfs.push('题目.pdf');
  if (compileAnswers.pdfExists) pdfs.push('答案.pdf');

  const totalMs = Date.now() - tAll;

  return {
    folder,
    outDir,
    /** 用了哪个模板 / 它的显示名与描述 —— 界面上"这次是用什么导的"要说得出来 */
    template: tpl.id,
    templateName: tplManifest.name,
    count: built.questions.length,
    imageCount: copied.size,
    warnings,
    /**
     * v6：分段耗时。以前只感觉"慢"，说不清慢在哪 ——
     * 现在界面上直接显示 读题/写文件/编译 各占多少，以后想再优化有依据。
     */
    timings: {
      readMs: readMs,
      writeMs: writeMs,
      compileMs,
      questionsMs: compileQuestions.ms,
      answersMs: compileAnswers.ms,
      totalMs,
      /** 实际跑了几次 xelatex（正常应为 2：题目 1 遍 + 答案 1 遍） */
      xelatexRuns: compileQuestions.passes + compileAnswers.passes,
    },
    compile: {
      questions: compileQuestions,
      answers: compileAnswers,
      ok: compileQuestions.ok && compileAnswers.ok,
      pdfs,
    },
  };
}
