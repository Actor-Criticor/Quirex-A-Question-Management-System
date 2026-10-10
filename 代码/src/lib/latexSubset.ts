/**
 * latexSubset.ts — 可移植 LaTeX 子集
 *
 * 这是「显示与导出对齐」的核心（方案 §10.3）。
 * 全系统只有一份真源（.tex），显示是渲染器、导出是原样嵌入模板，
 * 中间不存在任何格式转换 —— 所以不可能出现两边不一致。
 *
 * 白名单之外的东西（TikZ、自定义宏、\input、其它环境）会被 lint 拦下：
 * 它们在 LaTeX 里能编译，但网页端渲染不出来，就会破坏"对齐"这个承诺。
 */

// ============================================================
// 白名单
// ============================================================

/** 数学模式之外允许出现的宏 */
export const PORTABLE_MACROS = [
  'pick', // 选择括号 ( )
  'fillin', // 填空横线
  'textbf',
  'textit',
  'emph',
  'fig', // 居中不浮动示意图（自动图号）
  'includegraphics', // 行内内容图
  'begin',
  'end',
  'item',
  'hline', // tabular 里的横线
  'par',
  'quad',
  'qquad',
] as const;

/** 允许出现的环境 */
export const PORTABLE_ENVS = ['choices', 'tabular'] as const;

/** 直接禁止的模式（两端不可能一致） */
export const FORBIDDEN_PATTERNS: Array<{ re: RegExp; message: string }> = [
  { re: /\\begin\s*\{tikzpicture\}/, message: '不支持 TikZ 绘图：要画图请导出成图片，走图片通道' },
  { re: /\\tikz\b/, message: '不支持 \\tikz：要画图请导出成图片，走图片通道' },
  { re: /\\newcommand\b/, message: '不支持自定义宏 \\newcommand：网页端无法识别' },
  { re: /\\def\b/, message: '不支持 \\def：网页端无法识别' },
  { re: /\\input\b/, message: '不支持 \\input：题目内容必须是自包含的' },
  { re: /\\include\b/, message: '不支持 \\include：题目内容必须是自包含的' },
  { re: /\\usepackage\b/, message: '不支持 \\usepackage：宏包由模板统一管理' },
  { re: /\\includegraphics\s*(\[[^\]]*\])?\s*\{[^}]*\.(svg|webp)\}/i, message: 'xelatex 不支持 svg/webp，请先转成 PNG' },
];

/** 数学模式占位符（避免把公式里的宏误判成非法宏） */
const MATH_OPEN = '\u0000M';
const MATH_CLOSE = '\u0000';

// ============================================================
// 文本处理
// ============================================================

/**
 * 把 LaTeX 正文压成可搜索的纯文本：
 * 去掉 \includegraphics、\begin/\end、所有反斜杠命令与 $ { }，
 * 保留中文、数字、字母（数学环境里的字母也保留，所以能搜到公式里的变量名）。
 */
export function stripLatex(input: string): string {
  let s = input ?? '';
  s = s.replace(/\\includegraphics\s*(?:\[[^\]]*\])?\s*\{[^}]*\}/g, ' ');
  s = s.replace(/\\fig\s*(?:\[[^\]]*\])?\s*\{[^}]*\}/g, ' ');
  s = s.replace(/\\(?:begin|end)\s*\{[^}]*\}/g, ' ');
  s = s.replace(/\\[a-zA-Z@]+\*?/g, ' ');
  // v10：公式定界符 `\[ \] \( \)` 也去掉，免得检索串里混进反斜杠和方括号
  s = s.replace(/\\[\[\]()]/g, ' ');
  s = s.replace(/[{}$]/g, ' ');
  s = s.replace(/\s+/g, ' ');
  return s.trim().toLowerCase();
}

/**
 * 把数学公式抽出来换成占位符，返回替换后的文本与公式数组。
 *
 * v10：以前只认 `$...$` / `$$...$$`。而 LaTeX 里 `\[...\]`（行间公式）与
 * `\(...\)`（行内公式）**同样常见** —— 不认它们会出两种毛病：
 *   ① 网页把 `\[x^2\]` 当普通文字显示成 "[x^2]"，xelatex 却编译成公式
 *      —— 正好是这个白名单最该挡住的那种"两边不一致"；
 *   ② `\[ \begin{cases} …` 里的 cases 会被当成**块级**环境误报"不支持的环境"。
 * 所以现在四种写法都认。
 *
 * 两个小心的地方：
 *   · **先吃掉 `\\`**：表格里的 `\\[2pt]` 是"换行 + 2pt 间距"，
 *     不先跳过的话那个 `[` 会被当成行间公式的开头。
 *   · `\$` 是转义美元符号，照旧原样保留。
 *
 * latexRender 也用这个函数（原来是各写一份，两份迟早会漂）。
 */
export function extractMath(text: string): {
  text: string;
  formulas: Array<{ body: string; display: boolean }>;
} {
  const formulas: Array<{ body: string; display: boolean }> = [];
  let out = '';

  const push = (body: string, display: boolean): void => {
    formulas.push({ body, display });
    out += `${MATH_OPEN}${formulas.length - 1}${MATH_CLOSE}`;
  };

  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    // 转义的美元符号
    if (ch === '\\' && text[i + 1] === '$') {
      out += '\\$';
      i += 2;
      continue;
    }
    // 表格换行（可能带 [2pt] 间距）—— 整段当普通文本，别让后面的 [ 被当成公式开头
    if (ch === '\\' && text[i + 1] === '\\') {
      out += '\\\\';
      i += 2;
      continue;
    }
    // \[ ... \] 行间公式
    if (ch === '\\' && text[i + 1] === '[') {
      const close = text.indexOf('\\]', i + 2);
      if (close === -1) {
        out += ch;
        i += 1;
        continue;
      }
      push(text.slice(i + 2, close), true);
      i = close + 2;
      continue;
    }
    // \( ... \) 行内公式
    if (ch === '\\' && text[i + 1] === '(') {
      const close = text.indexOf('\\)', i + 2);
      if (close === -1) {
        out += ch;
        i += 1;
        continue;
      }
      push(text.slice(i + 2, close), false);
      i = close + 2;
      continue;
    }
    if (ch === '$') {
      const isDisplay = text[i + 1] === '$';
      const open = isDisplay ? '$$' : '$';
      const closeIdx = text.indexOf(open, i + open.length);
      if (closeIdx === -1) {
        out += ch; // 落单的 $，原样保留
        i += 1;
        continue;
      }
      push(text.slice(i + open.length, closeIdx), isDisplay);
      i = closeIdx + open.length;
      continue;
    }
    out += ch;
    i += 1;
  }

  return { text: out, formulas };
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ============================================================
// 图片与示意图
// ============================================================

export interface Segment {
  type: 'text' | 'image';
  /** text：原文；image：图片引用（如 images/0001-fig-01.png） */
  value: string;
  /** 仅 image：是否是 \fig（示意图，带图号） */
  isFigure: boolean;
  /** 仅 image：宽度选项原文 */
  opts?: string;
}

const IMAGE_RE = /\\includegraphics\s*(\[[^\]]*\])?\s*\{([^}]*)\}|\\fig\s*(\[[^\]]*\])?\s*\{([^}]*)\}/g;

/** 按图片宏把正文切成「文本段 / 图片段」，顺序即显示顺序 */
export function splitSegments(tex: string): Segment[] {
  const segments: Segment[] = [];
  const src = tex ?? '';
  let last = 0;
  let m: RegExpExecArray | null;
  IMAGE_RE.lastIndex = 0;

  while ((m = IMAGE_RE.exec(src)) !== null) {
    if (m.index > last) {
      segments.push({ type: 'text', value: src.slice(last, m.index), isFigure: false });
    }
    const isFigure = m[3] !== undefined;
    const opts = isFigure ? m[3] : m[1];
    const file = isFigure ? m[4] : m[2];
    segments.push({ type: 'image', value: (file ?? '').trim(), isFigure, opts });
    last = m.index + m[0].length;
  }
  if (last < src.length) {
    segments.push({ type: 'text', value: src.slice(last), isFigure: false });
  }
  return segments;
}

/** 数一数有几个 \fig（示意图）—— 用于「图号每题独立」的连续编号 */
export function countFigures(tex: string): number {
  return splitSegments(tex).filter((s) => s.type === 'image' && s.isFigure).length;
}

/** 取图片引用的文件名（images/0001-fig-01.png → 0001-fig-01.png） */
export function imageBasename(ref: string): string {
  const clean = (ref ?? '').trim().replace(/^["']|["']$/g, '');
  const parts = clean.split(/[\\/]/);
  return parts[parts.length - 1];
}

/**
 * 解析宽度选项，同时支持两种写法：
 *   \includegraphics[width=0.18\linewidth]{...}   → { fraction, 0.18 }
 *   \includegraphics[width=200px]{...}            → { px, 200 }
 *   \fig[0.4]{...}                                → { fraction, 0.4 }（\fig 用裸分数简写）
 *   无宽度选项                                     → null（用默认值）
 */
export function parseWidth(
  opts?: string
): { kind: 'fraction' | 'px'; value: number } | null {
  if (!opts) return null;

  const inner = opts.trim().replace(/^\[/, '').replace(/\]$/, '').trim();
  if (!inner) return null;

  const m = inner.match(/^(?:width\s*=\s*)?([\d.]+)\s*(\\linewidth|\\textwidth|px)?/);
  if (!m) return null;

  const value = parseFloat(m[1]);
  if (!Number.isFinite(value)) return null;

  if (m[2] === 'px') return { kind: 'px', value };
  return { kind: 'fraction', value };
}

// ============================================================
// 块级结构：choices（选项）与 tabular（表格）
// ============================================================

export interface ChoicesBlock {
  type: 'choices';
  items: string[];
}

export interface TableBlock {
  type: 'table';
  /** 行 × 列；单元格内容是 LaTeX 片段（可含行内公式） */
  rows: string[][];
  /** 列格式，如 |c|c|c| */
  colSpec: string;
}

export type ContentBlock = { type: 'text'; value: string } | ChoicesBlock | TableBlock;

/** 把 tabular 的 body 拆成行 × 列 */
export function parseTabularRows(body: string): string[][] {
  return (body ?? '')
    .replace(/\\hline/g, '')
    .split(/\\\\/)
    .map((row) => row.trim())
    .filter((row) => row.length > 0)
    .map((row) => row.split('&').map((cell) => cell.trim()));
}

/** 由若干行生成一个规范化的 tabular 环境 */
export function buildTabular(rows: string[][], colSpec?: string): string {
  if (!rows.length) return '';
  const cols = Math.max(...rows.map((r) => r.length));
  const spec = colSpec || `|${'c|'.repeat(cols)}`;
  const body = rows
    .map((r) => {
      const cells = [...r];
      while (cells.length < cols) cells.push('');
      return cells.join(' & ');
    })
    .join(' \\\\ \\hline\n');
  return `\\begin{tabular}{${spec}}\n\\hline\n${body} \\\\ \\hline\n\\end{tabular}`;
}

const BLOCK_RE = /\\begin\s*\{(choices|tabular)\}(?:(\{[^}]*\}))?([\s\S]*?)\\end\s*\{\1\}/g;

/**
 * 把正文切成「普通文本块 / choices 块 / tabular 块」。
 * 块级结构单独处理，因为它们不是行内内容（选项要排版成网格，表格要变 HTML 表）。
 */
export function splitBlocks(tex: string): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  const src = tex ?? '';
  let last = 0;
  let m: RegExpExecArray | null;
  BLOCK_RE.lastIndex = 0;

  while ((m = BLOCK_RE.exec(src)) !== null) {
    if (m.index > last) blocks.push({ type: 'text', value: src.slice(last, m.index) });

    const kind = m[1];
    const colSpec = (m[2] ?? '').replace(/[{}]/g, '');
    const body = m[3];

    if (kind === 'choices') {
      const items = body
        .split(/\\item\b/)
        .slice(1)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      blocks.push({ type: 'choices', items });
    } else {
      blocks.push({ type: 'table', rows: parseTabularRows(body), colSpec });
    }

    last = m.index + m[0].length;
  }

  if (last < src.length) blocks.push({ type: 'text', value: src.slice(last) });
  return blocks;
}

/** 兼容旧调用点：只关心「块」这件事，不区分类型 */
export function splitChoices(tex: string): ContentBlock[] {
  return splitBlocks(tex);
}

/** 选项序号 → A/B/C/D… */
export function optionLabel(i: number): string {
  return String.fromCharCode(65 + i);
}

// ============================================================
// lint：白名单之外的东西在录入/编辑时就拦下来
// ============================================================

export interface LintWarning {
  level: 'error' | 'warn';
  message: string;
  snippet?: string;
}

export function lintLatex(tex: string, label = '正文'): LintWarning[] {
  const warnings: LintWarning[] = [];
  const src = tex ?? '';
  if (!src.trim()) return warnings;

  // 消息统一带上位置前缀，界面上一眼能看出是题干还是答案出的问题
  const tag = (message: string) => `${label}：${message}`;

  for (const { re, message } of FORBIDDEN_PATTERNS) {
    const m = src.match(re);
    if (m) warnings.push({ level: 'error', message: tag(message), snippet: m[0] });
  }

  // 数学模式之外的部分：块级环境与宏都只在这里检查。
  //
  // 为什么必须排除数学模式：$...$ 内部的 \begin{array} / \begin{aligned} /
  // \begin{cases} / \begin{matrix} 等是**公式排版**，由 KaTeX 负责渲染 ——
  // 它是真正的数学引擎，这些都支持。若不加区分地把它们当"非法环境"，
  // 会把大量正常的方程组/分段函数/矩阵误报成错误（实测迁移 38 道题时误报 50 处）。
  // 白名单里的 choices / tabular 才是真正的**块级**（正文级）环境。
  const { text: outsideMath } = extractMath(src);

  const envRe = /\\(begin|end)\s*\{([^}]*)\}/g;
  let em: RegExpExecArray | null;
  while ((em = envRe.exec(outsideMath)) !== null) {
    const env = em[2].trim();
    if (!(PORTABLE_ENVS as readonly string[]).includes(env)) {
      warnings.push({
        level: 'error',
        message: tag(`不支持的环境 {${env}}：网页端只能渲染 ${PORTABLE_ENVS.join('、')}`),
        snippet: em[0],
      });
    }
  }

  // 宏（公式里的宏交给 KaTeX）
  const macroRe = /\\([a-zA-Z@]+)\*?/g;
  let mm: RegExpExecArray | null;
  while ((mm = macroRe.exec(outsideMath)) !== null) {
    const name = mm[1];
    if (!(PORTABLE_MACROS as readonly string[]).includes(name)) {
      warnings.push({
        level: 'error',
        message: tag(`白名单之外的宏 \\${name}：网页端显示可能与 LaTeX 编译结果不一致`),
        snippet: mm[0],
      });
    }
  }

  // v10：**数学模式里裸写中文**
  //
  // xelatex 的数学字体（lmroman/Computer Modern）里没有汉字，`$答案$` 这种写法
  // 编译时不会报错，只在日志里刷一排 `Missing character: There is no 答 (U+7B54)`
  // —— PDF 上那几个字直接是空的。这种"编译通过但输出缺字"最难发现
  // （老库里就有 43 处这样的历史遗留），所以录入时就拦下来。
  // `\text{中文}` / `\mbox{中文}` 是**合法**的（那边用的是正文字体），放行。
  for (const f of extractMath(src).formulas) {
    const bare = f.body.replace(/\\(?:text|mbox|hbox|textrm|textnormal)\s*\{[^{}]*\}/g, ' ');
    if (/[\u4e00-\u9fff]/.test(bare)) {
      warnings.push({
        level: 'error',
        message: tag('公式里不要直接写中文（数学字体没有汉字，PDF 会缺字）—— 要写就放进 \\text{…} 里'),
        snippet: f.body.slice(0, 40),
      });
    }
  }

  // 图片引用的文件必须存在（调用方负责传入已存在的文件集合）
  const segments = splitSegments(src);
  for (const seg of segments) {
    if (seg.type !== 'image') continue;
    const file = imageBasename(seg.value);
    if (!file) {
      warnings.push({ level: 'error', message: tag('图片引用为空'), snippet: seg.value });
      continue;
    }
    // v4：qid 可能是 `T0001` 也可能是旧的 `0001`，两种都算合规范
    // v9：还可以带学科字母（`AT0001`）—— 所以前缀放宽成"最多两个字母 + 数字"
    if (!/^[A-Za-z]{0,2}\d{3,}-(stem|fig|ans|ansfig)-\d{2,}\.[A-Za-z0-9]+$/.test(file)) {
      warnings.push({
        level: 'warn',
        message: tag(`图片文件名不符合规范「{qid}-{通道}-NN.ext」：${file}`),
        snippet: file,
      });
    }
  }

  // 美元符号配平
  const dollars = (src.match(/(^|[^\\])\$/g) ?? []).length;
  if (dollars % 2 !== 0) {
    warnings.push({ level: 'error', message: tag('美元符号 $ 数量不成对，公式可能没闭合') });
  }

  return warnings;
}

/** 校验图片引用是否都能在题目文件夹里找到 */
export function checkImageRefs(tex: string, existingFiles: Set<string>): LintWarning[] {
  const warnings: LintWarning[] = [];
  for (const seg of splitSegments(tex)) {
    if (seg.type !== 'image') continue;
    const file = imageBasename(seg.value);
    if (file && !existingFiles.has(file)) {
      warnings.push({ level: 'error', message: `图片引用的文件不存在：${file}`, snippet: seg.value });
    }
  }
  return warnings;
}

/** 找出没有被任何正文引用的图片（孤儿资产） */
export function findOrphanImages(files: string[], refs: string[]): string[] {
  const used = new Set(refs.map(imageBasename));
  return files.filter((f) => !used.has(f));
}
