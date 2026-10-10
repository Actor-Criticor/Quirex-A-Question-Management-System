/**
 * latexCompose.ts — 结构化录入 → 规范 LaTeX（只在写入时做一次）
 *
 * 录入页给的是分字段的结构化输入（题干、四个选项、答案），
 * 落盘时必须规范化成唯一的 LaTeX 真源：
 *   · 选择题 → 题干末尾 \pick（除非用户已手写）+ choices 环境
 *   · 填空题 → \fillin（除非用户已手写；可以有多个）
 *   · 解答题 → 原样
 *
 * 这一步是"录入时规范化一次，之后显示与导出都只是渲染同一份真源"的关键。
 */

import type { QuestionType } from './types';

export interface ComposeInput {
  type: QuestionType;
  /** 题干原文（LaTeX，可含 $...$） */
  stem: string;
  /** 选项（仅单选/多选）；空项会被丢弃 */
  options?: string[];
}

export interface ComposeResult {
  tex: string;
  /** 自动补了什么，回报给界面 */
  notes: string[];
}

/** 清掉粘贴带进来的残留：分隔线、行尾空白 */
function tidy(text: string): string {
  return (text ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/^\s*={5,}\s*$/gm, '')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function composeStemTex(input: ComposeInput): ComposeResult {
  const notes: string[] = [];
  let stem = tidy(input.stem);

  if (!stem) return { tex: '', notes };

  if (input.type === '单选' || input.type === '多选') {
    if (!/\\pick\b/.test(stem)) {
      stem = `${stem} \\pick`;
      notes.push('题干末尾已自动补上 \\pick（选择题的空括号）');
    }

    const options = (input.options ?? []).map((o) => tidy(o)).filter(Boolean);
    if (options.length) {
      const items = options.map((o) => `  \\item ${o}`).join('\n');
      stem = `${stem}\n\n\\begin{choices}\n${items}\n\\end{choices}`;
      if (options.length < 2) {
        notes.push(`只填了 ${options.length} 个选项，选择题通常需要 4 个`);
      }
    } else {
      notes.push('没有填选项，已只保存题干');
    }
  } else if (input.type === '填空') {
    if (!/\\fillin\b/.test(stem)) {
      stem = `${stem} \\fillin`;
      notes.push('题干末尾已自动补上 \\fillin（填空题的横线）');
    }
  }
  // 解答题不做任何自动补

  return { tex: stem, notes };
}

/** 从题干里把 "A．…  B．…  C．…  D．…" 四行拆出来（录入页的便利功能） */
export function splitOptionsFromStem(stem: string): { stem: string; options: string[] } | null {
  const lines = (stem ?? '').replace(/\r\n/g, '\n').split('\n');
  const picked: Array<{ label: string; text: string; line: number }> = [];

  lines.forEach((line, i) => {
    const m = line.match(/^\s*([A-Da-d])\s*[．.、)）]\s*(.*)$/);
    if (m) picked.push({ label: m[1].toUpperCase(), text: m[2].trim(), line: i });
  });

  if (picked.length < 2) return null;

  const labels = picked.map((p) => p.label);
  if (new Set(labels).size !== labels.length) return null;

  const optionLines = new Set(picked.map((p) => p.line));
  const rest = lines.filter((_, i) => !optionLines.has(i));
  const ordered = ['A', 'B', 'C', 'D']
    .map((l) => picked.find((p) => p.label === l))
    .filter((p): p is (typeof picked)[number] => !!p);

  return {
    stem: tidy(rest.join('\n')),
    options: ordered.map((p) => p.text),
  };
}

// ============================================================
// 待入库图片的占位标记
// ============================================================
//
// 录入页里图片是先选好、最后才保存的，而图片文件名要带 qid（全库唯一），
// qid 又必须入库时才分配 —— 鸡生蛋问题。
// 解法：录入页在正文里插入 [[img:N]] 占位标记，保存时服务端拿到 qid 后
// 把标记替换成真正的宏。这样既保持了 qid 前缀命名，又不用先建空题。

export const IMG_MARKER_RE = /\[\[img:(\d+)\]\]/g;

export function imageMarker(index: number): string {
  return `[[img:${index}]]`;
}

/**
 * 生成图片宏。
 *
 *   asFigure=true  → \fig[宽]{images/xxx.png}
 *                    示意图：带「图N」编号、**默认靠右**（位置由 meta.figAlign 决定）
 *   asFigure=false → 行内内容图（题干图 / 答案图 / 选项图）
 *                    **默认居中** —— v8 改的
 *
 * 为什么行内图要包一层 `\begin{center}`：以前它就是裸的 `\includegraphics`，
 * 于是图片段落跟着正文左对齐，一张孤零零的图贴在左边很难看。
 * 插图这个动作本身（不管插的是题干图还是示意图）默认就该是居中的；
 * 想让它跟某段文字并排，作者自己会把它写在那一行里（`center` 只影响自己的段落，
 * 写在行内也不会把句子拆开）。
 */
export function buildImageMacro(fileName: string, asFigure: boolean, width = 0.4): string {
  const ref = `images/${fileName}`;
  if (asFigure) return `\\fig[${width}]{${ref}}`;
  return `\\begin{center}\n  \\includegraphics[width=${width}\\linewidth]{${ref}}\n\\end{center}`;
}

/** 把 [[img:N]] 换成 macros[N]；没有对应图片的标记会被清掉 */
export function replaceImageMarkers(tex: string, macros: string[]): string {
  return (tex ?? '').replace(IMG_MARKER_RE, (_, idx: string) => {
    const macro = macros[parseInt(idx, 10)];
    return macro ?? '';
  });
}

/** 正文里还有没有没用完的占位标记 */
export function hasImageMarkers(tex: string): boolean {
  IMG_MARKER_RE.lastIndex = 0;
  return IMG_MARKER_RE.test(tex ?? '');
}

/** 把 "AD" 这样的选项字母切成 ['A','D'] */
export function parseAnswerLetters(raw: string): string[] {
  return Array.from(new Set((raw ?? '').toUpperCase().match(/[A-D]/g) ?? []));
}

/**
 * 组合作答文本：选择题给字母 + 可选详解。
 *   字母 + 详解 → "C。因为……"
 *   只有字母   → "C"
 *   只有详解   → "因为……"
 */
export function composeAnswer(letters: string[], detail: string): string {
  const d = tidy(detail);
  const l = letters.join('');
  if (l && d) return `${l}。${d}`;
  return l || d;
}
