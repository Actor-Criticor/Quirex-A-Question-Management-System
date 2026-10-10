/**
 * validate.ts — 字段校验与输入规范化
 *
 * 方案 §5：
 *   题号：整数 1–30，输入只读数字（T3 → 3、第3题 → 3）
 *   难度：小数 0.01–0.99 或留空，输入只读数字与小数点，2 位小数
 *
 * 两个字段都用「解析 + 校验」两步：ParseResult 同时带回 hint，
 * 让界面能把「94 是不是想填 0.94」这类提示显示出来，而不是替用户猜。
 */

import {
  NUMBER_MIN,
  NUMBER_MAX,
  YEAR_MIN,
  currentYear,
  DIFFICULTY_MIN,
  DIFFICULTY_MAX,
  DIFFICULTY_DECIMALS,
  DIFFICULTY_BANDS,
  BAND_RANGES,
  KNOWLEDGE_MAX,
  CUSTOM_TAG_MAX,
  CUSTOM_TAG_LEN_MAX,
  CHOICE_MIN_OPTIONS,
  type DifficultyBand,
} from './types';

export interface ParseResult<T> {
  /** 规范化后的值；null 表示留空 */
  value: T | null;
  /** 软提示（例如「是否按 0.94 处理」「已四舍五入」），不阻止入库 */
  hint?: string;
  /** 硬错误，必须阻止入库 */
  error?: string;
}

function isEmpty(raw: unknown): boolean {
  return raw === null || raw === undefined || String(raw).trim() === '';
}

// ============================================================
// 题号：整数 1–30，只读数字
// ============================================================

/**
 * 题号解析：从任意文本里提取第一段连续数字。
 *   "T3"    → 3
 *   "第3题"  → 3
 *   "12题"   → 12
 *   "3."    → 3
 *   ""      → null（允许留空）
 *   "abc"   → 错误（没有数字）
 */
export function parseNumberField(raw: unknown): ParseResult<number> {
  if (isEmpty(raw)) return { value: null };

  const text = String(raw).trim();
  const match = text.match(/\d+/);
  if (!match) {
    return { value: null, error: `题号未识别到数字：「${text}」` };
  }

  const n = parseInt(match[0], 10);
  const err = validateNumber(n);
  if (err) return { value: null, error: err };

  return { value: n };
}

/** 校验一个已经解析好的题号数值；合法返回 null，非法返回错误文案 */
export function validateNumber(n: number): string | null {
  if (!Number.isInteger(n)) return `题号必须是整数（当前 ${n}）`;
  if (n < NUMBER_MIN || n > NUMBER_MAX) {
    return `题号须在 ${NUMBER_MIN}–${NUMBER_MAX} 之间（当前 ${n}）`;
  }
  return null;
}

// ============================================================
// v3：年份
// ============================================================

/**
 * 年份解析：提取第一段连续数字。
 *   "2025"   → 2025
 *   "2025年"  → 2025
 *   ""       → null（允许留空）
 *   "25"     → 错误，但 hint 提示「是否按 2025 处理」
 *              （不自动补 —— 来源里普遍写「25全国1」这种两位简写，
 *                但年份有可能是 1998 这种，猜错了很难发现，所以只提示）
 *   "2050"   → 合法（未来年份不拦：可能是预告卷/模拟卷编号）
 *   "12025"  → 错误（超出区间）
 */
export function parseYearField(raw: unknown): ParseResult<number> {
  if (isEmpty(raw)) return { value: null };

  const text = String(raw).trim();
  const match = text.match(/\d+/);
  if (!match) {
    return { value: null, error: `年份未识别到数字：「${text}」` };
  }

  const n = parseInt(match[0], 10);
  const err = validateYear(n);
  if (err) {
    const hint =
      match[0].length === 2 && n >= 0 && n <= 99
        ? `是否按 ${2000 + n} 处理？`
        : undefined;
    return hint ? { value: null, error: err, hint } : { value: null, error: err };
  }

  return { value: n };
}

/** 校验一个已经解析好的年份；合法返回 null，非法返回错误文案 */
export function validateYear(y: number): string | null {
  if (!Number.isInteger(y)) return `年份必须是整数（当前 ${y}）`;
  const max = currentYear();
  if (y < YEAR_MIN || y > max) {
    return `年份须在 ${YEAR_MIN}–${max} 之间（当前 ${y}）`;
  }
  return null;
}

/** 年份显示文案：没有就空串（列表里不占位） */
export function yearText(y?: number | null): string {
  return y === null || y === undefined ? '' : String(y);
}

// ============================================================
// 难度：小数 0.01–0.99 或留空
// ============================================================

/**
 * 难度解析：提取第一段数字（允许带小数点）。
 *   "0.94"  → 0.94
 *   "0.944" → 0.94（四舍五入，带 hint）
 *   ""      → null（未录入，合法）
 *   "94"    → 错误，但 hint 提示「是否按 0.94 处理」
 *   "1"     → 错误（不做 0.01 的猜测，太容易误伤）
 *   "0"     → 错误
 */
export function parseDifficultyField(raw: unknown): ParseResult<number> {
  if (isEmpty(raw)) return { value: null };

  const text = String(raw).trim();
  const match = text.match(/-?\d+(?:\.\d+)?/);
  if (!match) {
    return { value: null, error: `难度未识别到数字：「${text}」` };
  }

  const rawNum = parseFloat(match[0]);
  if (Number.isNaN(rawNum)) {
    return { value: null, error: `难度未能解析：「${text}」` };
  }

  // 百分制误输入：整数且落在 2–99，提示是否除以 100
  // （不自动改，只提示；1 不给提示，因为 1 更可能是想填 1.0）
  if (Number.isInteger(rawNum) && rawNum >= 2 && rawNum <= 99) {
    return {
      value: null,
      error: `难度须在 ${DIFFICULTY_MIN}–${DIFFICULTY_MAX} 之间（当前 ${rawNum}）`,
      hint: `是否按 ${(rawNum / 100).toFixed(DIFFICULTY_DECIMALS)} 处理？`,
    };
  }

  const rounded = roundDifficulty(rawNum);
  const err = validateDifficulty(rounded);
  if (err) return { value: null, error: err };

  const hint =
    Math.abs(rounded - rawNum) > 1e-9
      ? `已四舍五入为 ${rounded}`
      : undefined;

  return hint ? { value: rounded, hint } : { value: rounded };
}

/** 校验一个已经解析好的难度值；合法返回 null，非法返回错误文案 */
export function validateDifficulty(d: number): string | null {
  if (typeof d !== 'number' || Number.isNaN(d)) return '难度不是有效数字';
  if (d < DIFFICULTY_MIN || d > DIFFICULTY_MAX) {
    return `难度须在 ${DIFFICULTY_MIN}–${DIFFICULTY_MAX} 之间（或留空）（当前 ${d}）`;
  }
  return null;
}

/** 按 2 位小数四舍五入，避免浮点尾数（0.1+0.2 类问题） */
export function roundDifficulty(d: number): number {
  const f = Math.pow(10, DIFFICULTY_DECIMALS);
  return Math.round(d * f) / f;
}

// ============================================================
// v8：两道新增的结构性下限
// ============================================================

/**
 * 选择题的选项数下限。
 *
 * 以前"四个全空"也能入库 —— 结果是一道**没有选项的单选题**，
 * 网页和 PDF 里都只有题干加一个空括号，事后很难发现是漏填还是故意。
 * 三个是下限（两个选项在数学题里几乎一定是漏填）。
 *
 * 只在校验**录入**这条路上拦；迁移老数据不走这里（老库里确实可能有残缺题）。
 */
export function validateChoiceOptions(options: Array<string | undefined | null>): string | null {
  const n = options.filter((o) => typeof o === 'string' && o.trim() !== '').length;
  if (n < CHOICE_MIN_OPTIONS) {
    return `选择题至少要有 ${CHOICE_MIN_OPTIONS} 个选项（现在填了 ${n} 个）`;
  }
  return null;
}

/** 知识点数量上限（超过就拦住，不静默截断 —— 让人自己删） */
export function validateKnowledgeCount(list: unknown): string | null {
  const n = Array.isArray(list) ? list.filter((k) => String(k ?? '').trim() !== '').length : 0;
  if (n > KNOWLEDGE_MAX) {
    return `知识点最多 ${KNOWLEDGE_MAX} 个（现在有 ${n} 个）—— 挂太多就分不出层次了`;
  }
  return null;
}

// ============================================================
// 难度 → 固定档位（v2：基础 / 压轴 / 困难）
// ============================================================
//
// 区间左闭右开，避免边界重复命中：
//   0.50 → 基础（不是压轴）     0.25 → 压轴（不是困难）
// 数值仍然照旧填 0.01–0.99，档位是算出来的。

/** 难度数值 → 档位名；未录入或越界返回 null */
export function difficultyToBand(d?: number | null): DifficultyBand | null {
  if (d === null || d === undefined || Number.isNaN(d)) return null;
  for (const band of DIFFICULTY_BANDS) {
    const r = BAND_RANGES[band];
    if (d >= r.min && d < r.max) return band;
    // 最上面一档要包含上界（0.99）
    if (band === '基础' && d === r.max) return band;
  }
  return null;
}

/** 档位 → 数值区间（给检索用）。左闭右开，基础那一档含上界 */
export function bandToRange(band: DifficultyBand): { min: number; max: number; maxInclusive: boolean } {
  const r = BAND_RANGES[band];
  return { min: r.min, max: r.max, maxInclusive: band === '基础' };
}

/** 难度显示文案：有档位就「0.62 压轴」，没录入就「未录入」 */
export function difficultyText(d?: number | null): string {
  if (d === null || d === undefined) return '未录入';
  const band = difficultyToBand(d);
  return band ? `${d.toFixed(2)} ${band}` : d.toFixed(2);
}

// ============================================================
// 其它
// ============================================================

/** 解析范围参数（题号/难度滑块的输入），非法则忽略该边界 */
export function parseOptionalNumber(raw: unknown): number | undefined {
  if (isEmpty(raw)) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/** 创新标记：只认真正的 true / "true" / "1" */
export function normalizeInnovation(raw: unknown): boolean {
  if (raw === true) return true;
  if (typeof raw === 'string') {
    const t = raw.trim().toLowerCase();
    return t === 'true' || t === '1' || t === '是' || t === 'on';
  }
  return raw === 1;
}

/** 描述：不设上限，只做首尾空白裁剪 */
export function normalizeDescription(raw: unknown): string {
  if (isEmpty(raw)) return '';
  return String(raw).trim();
}

/** 来源等标签名：裁剪 + 折叠内部空白 */
export function normalizeTagName(raw: unknown): string {
  if (isEmpty(raw)) return '';
  return String(raw).trim().replace(/\s+/g, ' ');
}

/**
 * 把一个标签值列表收成干净的字符串数组：逐个规范化、去空、去重、保序。
 * （create 与 PATCH 两边都必须走同一个函数 —— 不然会出现"录入拦住了、
 *   改题却能塞进去"这种只在一边生效的规则。）
 */
export function normalizeTagList(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw];
  return Array.from(new Set(list.map((v) => normalizeTagName(v)).filter(Boolean)));
}

/**
 * v9：自定义标签的两条上限。
 *
 * 知识点（8 个）只拦数量；自定义**还拦长度** —— 因为它要跟
 * 「25全国1 第1题 0.94 基础」挤在同一行，太长的名字既排不下也读不出来。
 * 两条都按**规范化之后**的值算（先 trim、先折叠空白），免得靠空格绕过长度上限。
 */
export function validateCustomTags(list: unknown): string | null {
  const clean = normalizeTagList(list);
  if (clean.length > CUSTOM_TAG_MAX) {
    return `自定义标签最多 ${CUSTOM_TAG_MAX} 个（现在有 ${clean.length} 个）`;
  }
  const tooLong = clean.find((t) => t.length > CUSTOM_TAG_LEN_MAX);
  if (tooLong) {
    return `自定义标签最长 ${CUSTOM_TAG_LEN_MAX} 个字（「${tooLong}」有 ${tooLong.length} 个字）`;
  }
  return null;
}
