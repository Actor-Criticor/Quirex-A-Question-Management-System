/**
 * latexRender.ts — LaTeX 正文 → HTML（网页显示端）
 *
 * 这是「显示」这一半：把唯一真源（题干.tex / 答案.tex）渲染成网页。
 * 导出那一半是把同一份 .tex 原样嵌进模板 —— 两边共用同一份文本，
 * 所以不存在漂移。渲染规则严格照 latexSubset 的可移植白名单来。
 */

import katex from 'katex';
import { FIG_ALIGN_CLASS, DEFAULT_FIG_ALIGN, type FigAlign } from './types';
import {
  escapeHtml,
  extractMath,
  imageBasename,
  parseWidth,
  splitBlocks,
  splitSegments,
  optionLabel,
} from './latexSubset';

export interface RenderOptions {
  qid: string;
  /** 首张示意图的编号（题干与答案共用一套连续编号，题干先数） */
  figureStart?: number;
  /** 示意图图注（键为文件名） */
  captions?: Record<string, string>;
  /** 题目文件夹里实际存在的文件；给了就可以标出缺失的图 */
  existingFiles?: Set<string>;
  /**
   * 图片地址解析器。
   * 默认指向 /api/assets/{qid}/{name}；录入页预览时用它把待入库图片
   * 指向浏览器的 object URL —— 这样预览走的是和正式显示完全相同的渲染路径。
   */
  assetUrl?: (fileName: string) => string;
  /**
   * v5：示意图位置（左/中/右）。由 meta.figAlign（或按题型推导）决定，
   * 与 PDF 那边 `\fig` 的对齐是同一个值 —— 否则网页和 PDF 会不一致。
   */
  figAlign?: FigAlign;
}

export interface RenderResult {
  html: string;
  /** 本文本里渲染了几张示意图 */
  figureCount: number;
  /** 下一个可用的示意图编号 */
  nextFigure: number;
  /** 渲染问题（KaTeX 失败、图片缺失） */
  problems: string[];
}

const MATH_PLACEHOLDER_RE = /\u0000M(\d+)\u0000/g;

function renderMath(body: string, display: boolean): string {
  try {
    return katex.renderToString(body, {
      displayMode: display,
      throwOnError: false,
      output: 'html',
      strict: false,
    });
  } catch (e) {
    return `<code class="ma-math-error" title="${escapeHtml((e as Error).message)}">${escapeHtml(body)}</code>`;
  }
}

/** 把 \textbf{...} 这类一层花括号的宏换成 HTML 标签（最多迭代 3 层嵌套） */
function replaceBraced(html: string, macro: string, tag: string): string {
  const re = new RegExp(`\\\\${macro}\\s*\\{([^{}]*)\\}`, 'g');
  let out = html;
  for (let i = 0; i < 3; i++) {
    const next = out.replace(re, `<${tag}>$1</${tag}>`);
    if (next === out) break;
    out = next;
  }
  return out;
}

/**
 * 纯文本（含行内公式、白名单宏）→ HTML。
 * 必须在 extractMath 之后、且不能在图片段上调用。
 */
export function inlineLatexToHtml(text: string, problems: string[] = []): string {
  /*
   * 1) 抽出公式换成占位符（占位符用 NUL 包裹，不会被后续处理破坏）。
   *
   * v10：改用 latexSubset 里那个**共用的** extractMath —— 以前这里自己抄了一份，
   * 两份只认 `$...$`；现在 `\[...\]` / `\(...\)` 也认，而且 lint 与渲染
   * 走的是同一套规则（各写一份的话，迟早会出现"lint 说没事、渲染成字面文本"）。
   */
  const { text: work, formulas } = extractMath(text ?? '');

  // 2) 转义 HTML（占位符是控制字符，不受影响）
  let html = escapeHtml(work);

  // 3) 白名单宏
  html = html.replace(/\\pick\b/g, '<span class="ma-pick">(&nbsp;&nbsp;&nbsp;&nbsp;)</span>');
  html = html.replace(/\\fillin\b/g, '<span class="ma-fillin"></span>');
  html = html.replace(/\\qquad\b/g, '&emsp;&emsp;');
  html = html.replace(/\\quad\b/g, '&emsp;');
  html = html.replace(/\\par\b/g, '\n\n');
  html = html.replace(/\\\$/g, '$');
  html = replaceBraced(html, 'textbf', 'strong');
  html = replaceBraced(html, 'textit', 'em');
  html = replaceBraced(html, 'emph', 'em');

  // 4) 段落与换行（空行分段，单换行 <br>）
  const paras = html
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  html = paras.map((p) => `<p>${p.replace(/\n/g, '<br/>')}</p>`).join('');

  // 5) 还原公式为 KaTeX 输出
  html = html.replace(MATH_PLACEHOLDER_RE, (_, idx: string) => {
    const f = formulas[parseInt(idx, 10)];
    if (!f) return '';
    const rendered = renderMath(f.body, f.display);
    if (rendered.includes('katex-error')) problems.push(`公式渲染有问题：${f.body}`);
    return rendered;
  });

  return html;
}

/** 图片段 → HTML */
function imageToHtml(
  file: string,
  opts: string | undefined,
  isFigure: boolean,
  figNo: number,
  o: RenderOptions,
  problems: string[]
): string {
  const name = imageBasename(file);
  const src = o.assetUrl
    ? o.assetUrl(name)
    : `/api/assets/${encodeURIComponent(o.qid)}/${encodeURIComponent(name)}`;
  const w = parseWidth(opts);

  const missing = o.existingFiles ? !o.existingFiles.has(name) : false;

  if (missing) {
    problems.push(`图片文件缺失：${name}`);
    return `<span class="ma-img-missing">图片缺失：${escapeHtml(name)}</span>`;
  }

  if (isFigure) {
    // v3：宽度不再直接写成 width —— 改写成 CSS 变量 --ma-fig-w，
    // 由样式表同时施加「最大宽（尊重作者比例）+ 最大高（按显示场景）」。
    // 作者写的 width= 一个字都不改，PDF 输出不受影响。
    const width = w
      ? w.kind === 'fraction'
        ? `${Math.round(w.value * 100)}%`
        : `${w.value}px`
      : '45%';
    const captionTex = o.captions?.[name];
    const captionHtml = captionTex
      ? `<figcaption>图${figNo}　${inlineLatexToHtml(captionTex, problems)}</figcaption>`
      : `<figcaption>图${figNo}</figcaption>`;
    // v5：位置由 figAlign 决定；v8 起默认靠右（与 resolveFigAlign 的默认值一致）
    const alignClass = `ma-fig-${FIG_ALIGN_CLASS[o.figAlign ?? DEFAULT_FIG_ALIGN]}`;
    return `<figure class="ma-fig ${alignClass}" style="--ma-fig-w:${width}"><img src="${src}" alt="${escapeHtml(
      name
    )}"/>${captionHtml}</figure>`;
  }

  const width = w
    ? w.kind === 'fraction'
      ? `${Math.round(w.value * 100)}%`
      : `${w.value}px`
    : 'auto';
  // v3：同理 —— 行内图的宽度是「上限」，另有 max-height 兜底，
  // 否则大截图会按原始像素撑满一整屏。
  return `<span class="ma-img"><img src="${src}" alt="${escapeHtml(
    name
  )}" style="--ma-img-w:${width}"/></span>`;
}

/**
 * 渲染一整段正文（题干或答案）：
 *   先切块（choices 选项 / tabular 表格），再切图片段，其余按行内规则处理。
 */
export function renderLatex(tex: string, options: RenderOptions): RenderResult {
  const problems: string[] = [];
  const figureStart = options.figureStart ?? 1;
  let figNo = figureStart;
  let figureCount = 0;
  let html = '';

  const takeFigureNo = () => {
    const n = figNo;
    figNo += 1;
    figureCount += 1;
    return n;
  };

  const blocks = splitBlocks(tex ?? '');

  for (const block of blocks) {
    if (block.type === 'choices') {
      const items = block.items.map((item, i) => {
        const inner = renderSegmentsHtml(item, options, takeFigureNo, problems);
        return `<li class="ma-option"><span class="ma-option-label">${optionLabel(i)}．</span>${inner}</li>`;
      });
      html += `<ol class="ma-choices">${items.join('')}</ol>`;
      continue;
    }

    if (block.type === 'table') {
      const rows = block.rows
        .map((row) => {
          const cells = row
            .map((cell) => `<td>${renderSegmentsHtml(cell, options, takeFigureNo, problems)}</td>`)
            .join('');
          return `<tr>${cells}</tr>`;
        })
        .join('');
      html += `<div class="ma-table-wrap"><table class="ma-table"><tbody>${rows}</tbody></table></div>`;
      continue;
    }

    html += renderSegmentsHtml(block.value, options, takeFigureNo, problems);
  }

  return { html, figureCount, nextFigure: figNo, problems };
}

/** 把一段（可能含图片的）文本渲染成 HTML */
function renderSegmentsHtml(
  tex: string,
  options: RenderOptions,
  takeFigureNo: () => number,
  problems: string[]
): string {
  const segments = splitSegments(tex);
  return segments
    .map((seg) => {
      if (seg.type === 'text') {
        // 纯空白段（图片之间的换行）直接跳过，避免生成空 <p>
        if (!seg.value.trim()) return '';
        return inlineLatexToHtml(seg.value, problems);
      }
      return imageToHtml(
        seg.value,
        seg.opts,
        seg.isFigure,
        seg.isFigure ? takeFigureNo() : 0,
        options,
        problems
      );
    })
    .join('');
}

/** 判断这段正文是不是"纯图片题"（没有任何可读文字） */
export function isImageOnly(tex: string): boolean {
  const segments = splitSegments(tex ?? '');
  if (!segments.some((s) => s.type === 'image')) return false;
  const textPart = segments
    .filter((s) => s.type === 'text')
    .map((s) => s.value)
    .join('')
    .replace(/\\[a-zA-Z]+/g, '')
    .replace(/[{}$\s]/g, '');
  return textPart.length === 0;
}
