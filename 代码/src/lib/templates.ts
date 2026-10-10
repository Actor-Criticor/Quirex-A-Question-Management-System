/**
 * templates.ts — 讲义模板契约（v6 #4）
 *
 * ## 为什么要有"契约"
 *
 * v6 之前，模板目录里有什么、导出时该复制哪些文件，全写在 latexExport.ts 的代码里：
 * 硬编码了 `main.tex`、`mathatlas.sty`、六个占位符。于是想加一个模板、想把 .sty 改个名，
 * 都得改代码。现在把这份"约定"挪进模板自己的 `meta.json` ——
 * **模板自我描述，导出程序只按描述办事**。加模板 = 往「模板」文件夹里放一个文件夹。
 *
 * ## 契约（meta.json，schema 1）
 *
 * ```json
 * {
 *   "schema": 1,
 *   "name": "默认",                         // 导出弹窗里显示的名字（必填）
 *   "description": "一句话说明（选填）",
 *   "engine": "xelatex",                    // 目前只支持 xelatex（选填，默认 xelatex）
 *   "styleFiles": ["quirex.sty"],           // 要一并复制到导出目录的文件（必填）
 *   "tokens": ["TITLE","AUTHOR","DATE","PRESET","LAYOUT","BODY"],   // 用到的占位符（必填）
 *   "defaults": { "group": "flat" }         // 选填：选中这套模板时默认怎么分组
 * }
 * ```
 *
 * 三条硬规矩：
 *   1. `{{BODY}}` 与 `{{PRESET}}` 必须声明。少了 BODY 就没有正文；少了 PRESET，
 *      「题目 / 答案」两份就会长得一模一样 —— 这种错必须当场报出来，不能等编译。
 *   2. 声明的占位符在 main.tex 里**必须各出现恰好一次**，多一次少一次都报错。
 *   3. 校验看的是**去掉注释之后**的 main.tex。这样模板注释里可以放心写 `{{BODY}}`
 *      当文档说明 —— 替换前先把注释删掉，就不会把正文注进注释里。
 *      （v5 之前这是真实踩过的坑：注释里写一次、正文里写一次 → 计数为 2 → 报错；
 *        只写在注释里 → 计数为 1 → 静默把内容注进注释、编译"通过"但输出是错的。）
 *
 * v9 收窄：`defaults` 以前还写 `preset` / `layout`，但导出流程**从来没读过它们**
 * （预设由「题目版 / 答案版」决定，版式写在 main.tex 里）。文档里写一个不生效的
 * 字段比不写更糟 —— 所以只留真正生效的 `group`，README 里的字段表与之对齐。
 */

import fs from 'fs';
import path from 'path';

/** 契约版本。将来接口变了就 +1，老模板能被识别出来并提示升级。 */
export const TEMPLATE_SCHEMA = 1;

/** 导出程序认识的全部占位符 */
export const KNOWN_TOKENS = ['TITLE', 'AUTHOR', 'DATE', 'PRESET', 'LAYOUT', 'BODY'] as const;
export type TokenName = (typeof KNOWN_TOKENS)[number];

/** 必须声明的占位符 */
export const REQUIRED_TOKENS: TokenName[] = ['PRESET', 'BODY'];

/** 每个占位符的含义 —— 报错信息和界面提示都用它，避免两处文案不一致 */
export const TOKEN_DOC: Record<TokenName, string> = {
  TITLE: '讲义标题',
  AUTHOR: '作者',
  DATE: '日期',
  PRESET: '显示预设（题目 / 答案两份靠它区分，取值见 \\.sty 里的 preset 宏）',
  LAYOUT: '留白版式',
  BODY: '题目正文（由导出程序生成）',
};

export const SUPPORTED_ENGINES = ['xelatex'] as const;

export interface TemplateDefaults {
  /**
   * 选中这套模板时，导出弹窗里的「分组」默认切到哪一档：
   * `flat` 平铺 / `knowledge` 按知识点 / `source` 按来源。
   * 用户仍可在弹窗里随手改（改了就以他的为准）。
   */
  group?: string;
}

export interface TemplateManifest {
  schema: number;
  name: string;
  description: string;
  engine: string;
  styleFiles: string[];
  tokens: TokenName[];
  defaults: TemplateDefaults;
}

/** 一个模板的完整情况：清单 + 校验结果 */
export interface TemplateInfo {
  /** 文件夹名，也是导出时用的模板 id */
  id: string;
  dir: string;
  /** 校验通过时的清单；不通过时为 null */
  manifest: TemplateManifest | null;
  /** 人能看懂的问题列表，空数组 = 可用 */
  issues: string[];
  usable: boolean;
}

// ============================================================
// 注释剥离
// ============================================================

/** 这些环境里 `%` 不是注释 —— 别把 verbatim 里的内容删掉 */
const VERBATIM_ENV = /\\begin\{(verbatim\*?|Verbatim|lstlisting|minted|comment)\}/;

/**
 * 去掉 TeX 注释（`%` 到行尾），但保留换行、保留 `\%`、保留 verbatim 类环境。
 *
 * 只用于**占位符替换**，不做别的解析 —— 所以规则宁可保守：
 * 拿不准的时候保留原文，最多留下一行没用的注释，不会把有效代码删掉。
 */
export function stripTexComments(src: string): string {
  const out: string[] = [];
  let verbatim: string | null = null;

  for (const line of src.split(/\r?\n/)) {
    if (verbatim) {
      out.push(line);
      if (line.includes(`\\end{${verbatim}}`)) verbatim = null;
      continue;
    }
    const m = line.match(VERBATIM_ENV);
    if (m) {
      verbatim = m[1];
      out.push(line);
      continue;
    }

    // 找第一个"没被反斜杠转义"的 %：前面连续反斜杠个数是偶数才是真注释
    let cut = -1;
    for (let i = 0; i < line.length; i++) {
      if (line[i] !== '%') continue;
      let bs = 0;
      for (let j = i - 1; j >= 0 && line[j] === '\\'; j--) bs++;
      if (bs % 2 === 0) {
        cut = i;
        break;
      }
    }
    out.push(cut === -1 ? line : line.slice(0, cut));
  }

  return out.join('\n');
}

/** 一个占位符在文本里出现了几次 */
export function countToken(src: string, token: string): number {
  return src.split(`{{${token}}}`).length - 1;
}

/** 文本里出现的全部 `{{XXX}}` 形式的名字（只认大写字母开头的，避免误伤 LaTeX 里的花括号） */
export function findTokenNames(src: string): string[] {
  const names = new Set<string>();
  for (const m of src.matchAll(/\{\{([A-Z][A-Z0-9_]+)\}\}/g)) names.add(m[1]);
  return [...names];
}

// ============================================================
// 套用
// ============================================================

/**
 * 套用模板：把 main.tex 里的 `{{TOKEN}}` 换成实际内容。
 *
 * 先剥注释再替换 —— 于是模板注释里写字面的 `{{BODY}}` 完全无害。
 *
 * `tokens` 不传时，用**模板里实际出现**的占位符（而不是全部已知占位符）——
 * 否则一个只用 TITLE/BODY 的模板会因为"没写 AUTHOR"被判成错误。
 * 导出流程会显式传 meta.json 里声明的 tokens（那时"声明了就必须出现"才有意义）。
 *
 * `BODY` 一定最后替换：正文里万一出现形如 `{{TITLE}}` 的字面文本
 * （比如题目里讲模板用法），先替换别的就会把正文里那串也换掉。
 */
export function applyTemplate(
  template: string,
  subs: Partial<Record<TokenName, string>>,
  tokens?: readonly string[]
): string {
  const stripped = stripTexComments(template);
  const used = tokens ?? findTokenNames(stripped);
  const ordered = [
    ...used.filter((t) => t !== 'BODY'),
    ...used.filter((t) => t === 'BODY'),
  ];

  let out = stripped;
  for (const token of ordered) {
    const marker = `{{${token}}}`;
    const n = out.split(marker).length - 1;
    if (n !== 1) {
      throw new Error(
        `模板有误：占位符 ${marker} 出现了 ${n} 次（必须恰好 1 次）。请检查模板的 main.tex。`
      );
    }
    out = out.split(marker).join(subs[token as TokenName] ?? '');
  }
  return out;
}

// ============================================================
// 读清单 + 校验
// ============================================================

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim());
}

/**
 * 读一个模板的 meta.json。
 * 只负责"读出结构"，不做校验 —— 校验在 validateTemplate 里，
 * 这样即便清单有毛病，界面也能把读到的信息显示出来给你改。
 */
export function readTemplateManifest(dir: string): TemplateManifest | null {
  const file = path.join(dir, 'meta.json');
  if (!fs.existsSync(file)) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>;
  } catch {
    return null;
  }
  const defs = (parsed.defaults ?? {}) as Record<string, unknown>;
  return {
    schema: typeof parsed.schema === 'number' ? parsed.schema : 0,
    name: typeof parsed.name === 'string' ? parsed.name.trim() : '',
    description: typeof parsed.description === 'string' ? parsed.description : '',
    engine: typeof parsed.engine === 'string' && parsed.engine.trim() ? parsed.engine.trim() : 'xelatex',
    styleFiles: asStringArray(parsed.styleFiles),
    tokens: asStringArray(parsed.tokens) as TokenName[],
    defaults: {
      group: typeof defs.group === 'string' ? defs.group : undefined,
    },
  };
}

/** meta.json 不存在 / 读不出来时，给一份可以直接照抄的模板 —— 比只报"缺少 meta.json"有用 */
export function manifestSkeleton(folderName: string): string {
  return (
    JSON.stringify(
      {
        schema: TEMPLATE_SCHEMA,
        name: folderName,
        description: '一句话说明这个模板的用处',
        engine: 'xelatex',
        styleFiles: ['quirex.sty'],
        tokens: [...KNOWN_TOKENS],
        defaults: { group: 'flat' },
      },
      null,
      2
    ) + '\n'
  );
}

/**
 * 校验一个模板目录。返回的问题列表就是给界面看的话术 ——
 * 每条都要能让人知道"去哪、改什么"。
 */
export function validateTemplate(dir: string, id = path.basename(dir)): TemplateInfo {
  const issues: string[] = [];
  const fail = (msg: string): TemplateInfo => {
    issues.push(msg);
    return { id, dir, manifest: null, issues, usable: false };
  };

  const mainPath = path.join(dir, 'main.tex');
  if (!fs.existsSync(mainPath)) return fail('缺少 main.tex —— 模板必须有这个文件');

  const metaPath = path.join(dir, 'meta.json');
  if (!fs.existsSync(metaPath)) {
    return fail(
      `缺少 meta.json —— 模板要靠它说明"复制哪些文件、用哪些占位符"。` +
        `可以在模板目录里放一个内容如下的 meta.json：\n${manifestSkeleton(id)}`
    );
  }

  const manifest = readTemplateManifest(dir);
  if (!manifest) return fail('meta.json 不是合法的 JSON，解析失败');

  if (manifest.schema !== TEMPLATE_SCHEMA) {
    return fail(
      `meta.json 的 schema 是 ${manifest.schema || '(没写)'}，本程序只认 ${TEMPLATE_SCHEMA}。` +
        `请按新格式补上 "schema": ${TEMPLATE_SCHEMA}。`
    );
  }
  if (!manifest.name) return fail('meta.json 里缺少 name（导出时要显示的名字）');
  if (!SUPPORTED_ENGINES.includes(manifest.engine as 'xelatex')) {
    return fail(
      `engine 是「${manifest.engine}」，目前只支持 ${SUPPORTED_ENGINES.join(' / ')}`
    );
  }

  // ---- styleFiles ----
  if (manifest.styleFiles.length === 0) {
    return fail('meta.json 里 styleFiles 是空的 —— 至少要列出要一起复制的 .sty 文件');
  }
  for (const f of manifest.styleFiles) {
    const p = path.join(dir, f);
    if (!fs.existsSync(p) || !fs.statSync(p).isFile()) {
      issues.push(`styleFiles 里写的 ${f} 在模板目录里找不到`);
    }
  }

  // ---- tokens ----
  if (manifest.tokens.length === 0) {
    return fail('meta.json 里 tokens 是空的 —— 至少要声明 PRESET 与 BODY');
  }
  const unknown = manifest.tokens.filter((t) => !(KNOWN_TOKENS as readonly string[]).includes(t));
  if (unknown.length) {
    return fail(
      `tokens 里有本程序不认识的占位符：${unknown.join('、')}。` +
        `认识的只有 ${KNOWN_TOKENS.join('、')}。`
    );
  }
  const missingRequired = REQUIRED_TOKENS.filter((t) => !manifest.tokens.includes(t));
  if (missingRequired.length) {
    return fail(
      `tokens 里缺少必须声明的 ${missingRequired.join('、')}。` +
        `PRESET 少了 →「题目 / 答案」两份会一模一样；BODY 少了 → 没有正文。`
    );
  }

  // ---- 和 main.tex 对照（看剥掉注释之后的文本）----
  const src = stripTexComments(fs.readFileSync(mainPath, 'utf-8'));
  for (const t of manifest.tokens) {
    const n = countToken(src, t);
    if (n === 0) issues.push(`tokens 声明了 ${t}，但 main.tex 里没有 {{${t}}}`);
    else if (n > 1) issues.push(`main.tex 里 {{${t}}} 出现了 ${n} 次，必须恰好 1 次`);
  }

  const found = findTokenNames(src);
  const undeclared = found.filter((t) => !manifest.tokens.includes(t as TokenName));
  if (undeclared.length) {
    issues.push(
      `main.tex 里用了没在 tokens 里声明的占位符：${undeclared.join('、')}` +
        `（用到的都要声明，导出时才知道该替换什么）`
    );
  }

  return { id, dir, manifest, issues, usable: issues.length === 0 };
}

/** 列举模板根目录下的全部模板（含不可用的 —— 界面要能把问题显示出来让人修） */
export function listTemplateInfos(root: string): TemplateInfo[] {
  if (!root || !fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => validateTemplate(path.join(root, e.name), e.name))
    .sort((a, b) => a.id.localeCompare(b.id, 'zh'));
}
