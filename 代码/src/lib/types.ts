/**
 * types.ts — Quirex 领域模型
 *
 * 字段三分法：
 *   A 固定枚举：题型（单选/多选/填空/解答），不可增删改，仅单题
 *   B 标签：来源、知识点、自定义 —— 可增删改（删除=停用）
 *   C 普通字段：题号、难度、年份、描述 —— 不是标签
 *
 * 两种录入类型（kind）：单题 / 整卷
 */

// ============================================================
// 录入类型
// ============================================================

export const QUESTION_KINDS = ['单题', '整卷'] as const;
export type QuestionKind = (typeof QUESTION_KINDS)[number];

// ============================================================
// 题型（固定四枚举，不允许增删改）
// ============================================================

export const QUESTION_TYPES = ['单选', '多选', '填空', '解答'] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];

export function isQuestionType(v: unknown): v is QuestionType {
  return typeof v === 'string' && (QUESTION_TYPES as readonly string[]).includes(v);
}

// ============================================================
// 标签维度（来源 / 知识点 / 自定义）
// ============================================================

/**
 * v9：加了第三维「自定义」。
 *
 * 它和知识点**同构**（多值、可联想、进标签表），区别只在用途：
 * 知识点是**学科内部的固定板块**（要长期稳定，所以有 8 个的上限、还进筛选面）；
 * 自定义是**老师自己临时划的道道**（"一模压轴""讲过的""待重做"），
 * 所以上限更紧（5 个）、名字更短（20 字）、**不进浏览页的筛选面**。
 *
 * 顺序即界面上的页签顺序。
 */
export const TAG_KINDS = ['source', 'knowledge', 'custom'] as const;
export type TagKind = (typeof TAG_KINDS)[number];

export const TAG_KIND_LABEL: Record<TagKind, string> = {
  source: '来源',
  knowledge: '知识点',
  custom: '自定义',
};

/** 需要按「一串值」来处理的维度（source 是单个字符串，另外两维是数组） */
export const LIST_TAG_KINDS = ['knowledge', 'custom'] as const;
export type ListTagKind = (typeof LIST_TAG_KINDS)[number];

export function isTagKind(v: unknown): v is TagKind {
  return typeof v === 'string' && (TAG_KINDS as readonly string[]).includes(v);
}

export function isListTagKind(v: unknown): v is ListTagKind {
  return typeof v === 'string' && (LIST_TAG_KINDS as readonly string[]).includes(v);
}

/** 某个记录在某个标签维度上的全部值（source 是单值，包成只含一项的数组） */
export function tagValuesOf(
  rec: { source?: string; knowledge?: string[]; custom?: string[] },
  kind: TagKind
): string[] {
  if (kind === 'source') return rec.source ? [rec.source] : [];
  return (kind === 'knowledge' ? rec.knowledge : rec.custom) ?? [];
}

// ============================================================
// 状态
// ============================================================

/** 题目不可删除，只能停用（停用仍占 qid） */
export type QuestionStatus = '启用' | '停用';

export const QUESTION_STATUSES = ['启用', '停用'] as const;

// ============================================================
// 图片四通道（仅单题）
// 角色由上传时声明，程序不猜
// ============================================================

export const IMAGE_CHANNELS = ['stem', 'fig', 'ans', 'ansfig'] as const;
export type ImageChannel = (typeof IMAGE_CHANNELS)[number];

export const IMAGE_CHANNEL_LABEL: Record<ImageChannel, string> = {
  stem: '题干图',
  fig: '示意图',
  ans: '答案图',
  ansfig: '答案示意图',
};

export function isImageChannel(v: unknown): v is ImageChannel {
  return typeof v === 'string' && (IMAGE_CHANNELS as readonly string[]).includes(v);
}

// ============================================================
// 整卷 PDF
// ============================================================

export const PDF_ROLES = ['paper', 'answer'] as const;
export type PdfRole = (typeof PDF_ROLES)[number];

export const PDF_ROLE_LABEL: Record<PdfRole, string> = {
  paper: '题目 PDF',
  answer: '答案 PDF',
};

export function isPdfRole(v: unknown): v is PdfRole {
  return typeof v === 'string' && (PDF_ROLES as readonly string[]).includes(v);
}

/**
 * v5：配图位置（示意图 `\fig` 放哪儿）。
 *
 * 为什么存在 meta 而不是写进 `.tex` 的 `\fig[...]`：
 *   「图上是什么」属于内容（`.tex`），「图放哪儿」属于排版偏好 ——
 *   和已有的 `figures`（图注）同一类。放 meta 的好处是改位置不用重写内容，
 *   拖一下滑块只动一个字段，`.tex` 一个字不变。
 *
 * 未设时按题型推导（见 `resolveFigAlign`）：解答题靠右，其余居中 —— 这是排版习惯。
 */
export const FIG_ALIGNS = ['左', '中', '右'] as const;
export type FigAlign = (typeof FIG_ALIGNS)[number];

export function isFigAlign(v: unknown): v is FigAlign {
  return typeof v === 'string' && (FIG_ALIGNS as readonly string[]).includes(v);
}

/** 配图位置 → 网页 CSS 类后缀 */
export const FIG_ALIGN_CLASS: Record<FigAlign, string> = {
  左: 'left',
  中: 'center',
  右: 'right',
};

/** 位置 → LaTeX 对齐（模板里 `exercise` 的第二个可选参数） */
export const FIG_ALIGN_TEX: Record<FigAlign, string> = {
  左: 'left',
  中: 'center',
  右: 'right',
};

/**
 * 求出这道题最终生效的配图位置。
 *
 * v8：默认值从"按题型推导（解答靠右、其余居中）"改成**一律靠右**。
 * 原因：这个字段只管 `\fig`（示意图，带「图N」编号的那种），
 * 而你要的是"**加入图片（行内内容图）默认居中，示意图默认靠右**" ——
 * 也就是说默认值应该由**图片类型**决定，而 `figAlign` 管的那一类（示意图）
 * 默认就该靠右，跟题型没关系。行内图的居中由图片宏自己保证（见 buildImageMacro）。
 *
 * `type` 参数保留只是为了不改调用点签名；它已经不参与判断了。
 */
export function resolveFigAlign(_type?: QuestionType, set?: FigAlign): FigAlign {
  if (set) return set;
  return '右';
}

/** v8：示意图的默认位置（网页渲染的兜底值要和这里一致） */
export const DEFAULT_FIG_ALIGN: FigAlign = '右';

/**
 * 快照默认名 = 日期 + 时间（**24 小时制**），形如 `2025-06-01 14:30`。
 * 用本地时间而不是 UTC —— 老师看的是自己的钟。
 *
 * v8 从 lib/baskets.ts 挪到这里：**它是纯函数，而 baskets.ts 要 import fs**。
 * 客户端组件（试题篮页的导出标题默认值）也需要它，从 baskets.ts 引会把
 * `fs` 拖进浏览器包（实测直接 500：Module not found: Can't resolve 'fs'）。
 * baskets.ts 里保留了同名转出，老调用点不用改。
 */
export function defaultSnapshotName(at: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())} ${p(at.getHours())}:${p(at.getMinutes())}`;
}

// ============================================================
// 数值域的硬约束
// ============================================================

/** 题号：整数 1–30（只读数字） */
export const NUMBER_MIN = 1;
export const NUMBER_MAX = 30;

/**
 * v3：年份（单题与整卷都有，录入时手键）。
 * 取值区间：**1900 到今年**。
 *
 * v8 把上限从写死的 2100 改成**当前年份** —— 2100 那个数太随意：
 * 它既不拦手滑打出的未来年份（2130 也过），又给了"这题是 2100 年的"这种荒谬答案空间。
 * 题库里不可能有明年的题，所以上限就是今年。
 * （老库里若有超过今年的年份，读的一侧不拦 —— 只有**写入**校验收紧。）
 */
export const YEAR_MIN = 1900;

/** 今年的年份。用函数而不是常量：进程可能跨年运行（本地工具开着过夜很正常） */
export function currentYear(): number {
  return new Date().getFullYear();
}

/** 难度：0.01–0.99 或留空；2 位小数（单题与整卷同区间） */
export const DIFFICULTY_MIN = 0.01;
export const DIFFICULTY_MAX = 0.99;
export const DIFFICULTY_DECIMALS = 2;

/**
 * v8：每题最多几个知识点。
 *
 * 为什么要有上限：知识点是**给检索用的**，一道题挂十几个标签等于没挂 ——
 * 既分不出层次，也让"按知识点分组"的讲义变得没法看。
 * 8 个足够覆盖"一道综合题跨几个板块"的真实情况。
 */
export const KNOWLEDGE_MAX = 8;

/**
 * v9：自定义标签的两条上限。
 *
 *   每题最多 5 个  —— 它是临时划的道道，挂多了等于没有侧重；
 *   单个最长 20 字 —— 它要跟「25全国1 第1题 0.94 基础」挤在题库列表的同一行，
 *                    而且那一行每个只显示 7 个字，太长的名字本来也读不出来。
 *
 * 两条都在**写入**这一侧拦（create / PATCH 两个入口），读老数据不拦。
 */
export const CUSTOM_TAG_MAX = 5;
export const CUSTOM_TAG_LEN_MAX = 20;

/**
 * v9：题库列表行里，每个自定义标签最多显示几个字（超出用 `…`）。
 * 详情页不受这个限制 —— 那里显示全部。
 */
export const CUSTOM_TAG_ROW_CHARS = 7;

/** 按列表行的宽度截断一个自定义标签；没超长就原样返回 */
export function truncateCustomTag(name: string, max = CUSTOM_TAG_ROW_CHARS): string {
  return name.length > max ? name.slice(0, max) + '…' : name;
}

/**
 * v8：选择题最少几个选项。
 *
 * 以前四个全空也能存（变成"只有题干的单选题"），甚至只填两个也放行。
 * 三个是下限：两个选项在数学里几乎一定是漏填了（对/错、是/否 那种不这么考）。
 */
export const CHOICE_MIN_OPTIONS = 3;

/** 单题 id 零填充位数（不焊死：超过 9999 会自然变长） */
export const QID_PAD = 4;

/** v4：单题 id 前缀。整卷是 P，单题是 T —— 两家都是「一个大写字母 + 数字」 */
export const QUESTION_PREFIX = 'T';

/** 试卷 id 零填充位数（P + 3 位，形如 P001） */
export const PAPER_PAD = 3;

// ============================================================
// v9：qid 的解析与「显示形态」
// ============================================================
//
// 这两个函数放**这里**（纯字符串处理），不放 paths.ts ——
// paths.ts 会 import subjects.ts、进而 import fs 与 node:async_hooks，
// 客户端组件引它就会把 node 内置模块拖进浏览器包（v8 踩过一次同样的坑，
// 那次是 defaultSnapshotName）。
//
// 规则（方案 §0.2）：
//   写：`<学科字母>T####` / `<学科字母>P###`（如 AT0001 / BP001）
//   读：`AT0001`、`T0001`（v4 起）、`0001`（v3 及以前）全认 —— 宽松读、严格写
//   显示：一律去掉学科字母（界面上一律 T0001 / P001）

/**
 * 拆开一个 qid。返回 null 表示它不像 qid。
 *
 *   `AT0001` → { subject:'A', kind:'单题', number:1 }
 *   `T0001`  → { subject:'',  kind:'单题', number:1 }
 *   `0001`   → { subject:'',  kind:'单题', number:1 }
 *   `AP001`  → { subject:'A', kind:'整卷', number:1 }
 */
export function parseQid(
  name: string
): { subject: string; kind: QuestionKind; number: number } | null {
  const m = name.match(/^([A-Z]?)([TP])(\d+)$/);
  if (m) {
    if (m[2] === 'T' && m[3].length >= QID_PAD) {
      return { subject: m[1], kind: '单题', number: parseInt(m[3], 10) };
    }
    if (m[2] === 'P' && m[3].length >= PAPER_PAD) {
      return { subject: m[1], kind: '整卷', number: parseInt(m[3], 10) };
    }
    return null;
  }
  if (new RegExp(`^\\d{${QID_PAD},}$`).test(name)) {
    return { subject: '', kind: '单题', number: parseInt(name, 10) };
  }
  return null;
}

/** v9：qid 里带的学科字母（没有就是空串） */
export function subjectLetterOf(qid: string): string {
  return parseQid(qid)?.subject ?? '';
}

/**
 * v9：**显示用的 qid** —— 一律去掉学科字母。
 *
 * 你说过「在显示上不要显示 AB，AB 的区分只为了让系统区分」。
 * 因为每个学科是独立的题库，去掉字母后在"当前学科"里仍然唯一。
 * 所有往界面上写 qid 的地方都走这个函数，免得有的地方漏改。
 */
export function displayQid(qid: string): string {
  const parsed = parseQid(qid);
  if (!parsed) return qid;
  if (parsed.kind === '整卷') return `P${String(parsed.number).padStart(PAPER_PAD, '0')}`;
  if (parsed.subject) return `${QUESTION_PREFIX}${String(parsed.number).padStart(QID_PAD, '0')}`;
  return qid;
}

/**
 * v4：字段级备份（改名 / 彻底清除前自动生成的那种）在磁盘上的条数上限。
 * 超过就**顶掉最旧的** —— 免得 `_meta/backups/` 无限膨胀。
 */
export const BACKUP_LIMIT = 100;

// ============================================================
// 难度档位（v2）
// ============================================================

/**
 * 难度固定档位（用于筛选与显示）。
 * 数值仍然照旧填 0.01–0.99，档位由数值算出来。
 * 区间**左闭右开**，避免边界重复命中：
 *   0.50 → 基础（不是压轴）    0.25 → 压轴（不是困难）
 */
export const DIFFICULTY_BANDS = ['基础', '压轴', '困难'] as const;
export type DifficultyBand = (typeof DIFFICULTY_BANDS)[number];

// ============================================================
// 导出时"题目信息"要显示哪些（v6 #6）
// ============================================================

/**
 * 每道题上方那行小字（来源、题号、难度……）由哪些信息拼成 —— 导出时可选。
 *
 * 为什么做成"一组开关"而不是几段写死的文本：
 *   同一份题库，给学生的讲义只要来源和难度，给教研组的要带上知识点和年份。
 *   以前这行是写死的「来源 第N题」，改一次就得改代码。
 *
 * 顺序固定（来源+题号 合成一段打头，其余按这个数组的顺序跟），
 * 这样勾不同的组合，出来的样子是可预期的。
 *
 * v10：去掉了 typeMark（题型标记）—— 多选题**一律**带一个「（多选）」，
 *      不需要每次去勾；勾选框从 7 个减到 6 个，一行放得下。
 */
export const EXPORT_INFO_KEYS = [
  'source',
  'number',
  'difficulty',
  'knowledge',
  'year',
  'innovation',
] as const;
export type ExportInfoKey = (typeof EXPORT_INFO_KEYS)[number];

export type ExportInfoOptions = Record<ExportInfoKey, boolean>;

/**
 * 界面上的中文名与说明 —— 后端拼标注、前端画勾选框，都用这一份。
 *
 * v10：勾选框旁边那一长串解释去掉了（你说过是多余的），
 * 所以这里只留 label；hint 只给"确实需要一句话才不至于误会"的那一项留着。
 */
export const EXPORT_INFO_LABEL: Record<ExportInfoKey, { label: string; hint?: string }> = {
  source: { label: '来源' },
  number: { label: '题号' },
  difficulty: { label: '难度等级' },
  knowledge: { label: '知识点' },
  year: { label: '年份' },
  innovation: { label: '创新' },
};

/**
 * 默认勾选：来源 + 题号 + 难度 + 创新。
 * 知识点与年份默认**不勾** —— 它们让标注行变得很长，需要时再开。
 */
export const DEFAULT_EXPORT_INFO: ExportInfoOptions = {
  source: true,
  number: true,
  difficulty: true,
  knowledge: false,
  year: false,
  innovation: true,
};

/** 把任意输入收敛成一组合法开关（手改 baskets.json 也不会读进奇怪的值） */
export function coerceExportInfo(raw: unknown): ExportInfoOptions {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out = {} as ExportInfoOptions;
  for (const k of EXPORT_INFO_KEYS) {
    out[k] = typeof r[k] === 'boolean' ? (r[k] as boolean) : DEFAULT_EXPORT_INFO[k];
  }
  return out;
}

/** 有没有勾选任何一项 */
export function anyExportInfo(info: ExportInfoOptions): boolean {
  return EXPORT_INFO_KEYS.some((k) => info[k]);
}

export const BAND_RANGES: Record<DifficultyBand, { min: number; max: number; note: string }> = {
  基础: { min: 0.5, max: 0.99, note: '得分率高，容易' },
  压轴: { min: 0.25, max: 0.5, note: '中偏难' },
  困难: { min: 0.01, max: 0.25, note: '最难' },
};

export function isDifficultyBand(v: unknown): v is DifficultyBand {
  return typeof v === 'string' && (DIFFICULTY_BANDS as readonly string[]).includes(v);
}

// ============================================================
// 记录
// ============================================================

/** 题目元数据（对应 题库/<id>/<id>.md 的 frontmatter） */
export interface QuestionMeta {
  qid: string;
  kind: QuestionKind;
  /** 仅单题 */
  type?: QuestionType;
  /** 标签（两种 kind 都有） */
  source?: string;
  /** 仅单题，整数 1–30 */
  number?: number;
  /** 0.01–0.99；留空 = 未录入 */
  difficulty?: number;
  /** 标签（仅单题，多值） */
  knowledge?: string[];
  /**
   * v9：自定义标签（**仅单题**，多值，最多 5 个、每个最长 20 字）。
   * 与知识点同构（进标签表、可联想、索引进 searchText），但不进浏览页筛选面，
   * 出现在题库列表行的同一行（每个截到 7 字）与详情页的「题目信息」栏（显示全部）。
   */
  custom?: string[];
  /**
   * v2：创新标记 —— 固定可选字段（不是所有题都有）。
   * 没有这个字段就是不创新；不能改名、不进标签管理页。
   */
  innovation?: boolean;
  /** v3：年份，单题与整卷都有；留空 = 未录入 */
  year?: number;
  /** v5：示意图位置（仅单题）。未设 = 按题型推导 */
  figAlign?: FigAlign;
  /** 不设上限；单题进搜索，整卷不进 */
  description?: string;
  status: QuestionStatus;
  /** 单题可选：示意图图注，键为图片文件名 */
  figures?: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

/** 索引条目（题库/_meta/index.json 的一条） */
export interface IndexEntry {
  qid: string;
  kind: QuestionKind;
  type?: QuestionType;
  source?: string;
  number?: number;
  difficulty?: number;
  knowledge?: string[];
  /** v9：自定义标签（仅单题；进全文检索的"标签路"，不进筛选面） */
  custom?: string[];
  /** v2：创新标记（仅单题；整卷会被服务端丢弃） */
  innovation?: boolean;
  /** v3：年份 */
  year?: number;
  /**
   * v5：配图位置（已按题型解析过的**生效值**）。
   * 索引里存解析后的值，网页就不必再自己推一遍 —— 保证网页和 PDF 一致。
   */
  figAlign?: FigAlign;
  /** 列表页显示用的截断文本（整卷最长描述也不撑大索引） */
  descPreview?: string;
  /** 图片 / PDF 存在性，供列表打标 */
  hasImages: boolean;
  hasPdf: boolean;
  status: QuestionStatus;
  /**
   * 全文检索串。
   * 单题 = 题干去 LaTeX 命令 + 答案 + 描述
   * 整卷 = 恒为空字符串（描述不进搜索）
   */
  searchText: string;
  createdAt: string;
  updatedAt: string;
}

/** 标签表里的一项（有效标签表 = 数据派生 ∪ manual − retired） */
export interface TagItem {
  name: string;
  kind: TagKind;
  /**
   * 引用计数 —— 数的是「有多少道题在用这个标签」，**含已停用的题**。
   * 理由：停用 ≠ 删除，标签值确实还在那些题上；而且改名/彻底清除必须覆盖停用题，
   * 否则停用题上的值就成了漏网之鱼。所以这里的计数与标签操作的影响范围保持一致。
   */
  count: number;
  /** 其中处于「启用」状态的题数（供界面显示「含 N 道停用」） */
  enabledCount: number;
  /** 是否已停用 */
  retired: boolean;
  /** 是否手工登记（暂无题目引用） */
  manual: boolean;
}

/** 标签叠加层文件 tags.json 的形状（v9：三个维度都要有一份 manual / retired） */
export interface TagStoreShape {
  version: number;
  manual: Record<TagKind, string[]>;
  retired: Record<TagKind, string[]>;
}

/** 检索参数 */
export interface SearchParams {
  /** 关键字，空格分词 = AND */
  q?: string;
  kind?: QuestionKind;
  type?: QuestionType;
  source?: string;
  /** 多选：同维度内 OR */
  knowledge?: string[];
  /** v2：难度档位（多选 = OR）。给了它就忽略 diffMin/diffMax */
  bands?: DifficultyBand[];
  /** v2：只看创新题 */
  innovation?: boolean;
  /** v3：年份（多选 = OR）。单题与整卷都适用 */
  years?: number[];
  numMin?: number;
  numMax?: number;
  diffMin?: number;
  diffMax?: number;
  status?: QuestionStatus | '全部';
  page?: number;
  size?: number;
}

export interface SearchResult {
  total: number;
  page: number;
  size: number;
  items: IndexEntry[];
  /** v2：列表要直接渲染题目，所以把这一页的题干/答案一并带回（避免 N 次请求） */
  contents?: Record<string, { stem: string; answer: string; assets: string[] }>;
}
