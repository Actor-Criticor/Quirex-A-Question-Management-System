/**
 * baskets.ts — 试题篮（持久化的一等实体）
 *
 * ============================================================
 * v3 语义（推翻 v1/v2 的「多篮子 + activeId」模型）
 * ============================================================
 * 你原话：「试题篮逻辑明确：只有一个『正在编辑』的试题篮；加入试题篮只有勾选
 * 这一个操作；编辑好后可『保存』，保存的放在左侧显示；点击已保存的 →
 * 『替换为当前编辑』，原来正在编辑的自动保存；保存默认名 = 日期+时间（24 小时制）」
 *
 * 所以数据模型收敛成两块：
 *
 *   draft —— 「正在编辑」。唯一、永远存在、勾选即落盘（关浏览器也不丢）。
 *   saved —— 已保存的快照。按保存时间倒序；左侧列表，每页 15 个。
 *
 * 关键规则：
 *   · 勾选 = 唯一的加入操作；取消勾选 = 移除。没有「先勾再点加入」这一步。
 *   · 「保存」= 给当前内容拍快照。**保存后当前编辑不变**
 *     （否则「自动保存」无从谈起 —— 既然保存即清空，就没有东西需要自动保存了）。
 *   · 点左侧某条快照 = **载入副本**：先把当前编辑自动保存成一条新快照，
 *     再把被点那条的内容拷进 draft。**被点那条原样留在左侧**（你选的语义）。
 *     因为左右可能出现内容相同的两份，所以界面用「当前」标记指出哪条是活的。
 *   · 内容完全相同则不产生无意义的自动保存（否则点一下凭空多一条重复记录）。
 *
 * 篮子只存 qid 引用 —— 题目正文只在详情页编辑，篮内不改正文。
 */

import fs from 'fs';
import crypto from 'crypto';
import { META_BASKETS, ensureDir, metaDir, metaFile } from './paths';
import { questionExists } from './store';
import { loadIndexOrRebuild } from './searchIndex';
import {
  DEFAULT_EXPORT_INFO,
  EXPORT_INFO_KEYS,
  QUESTION_TYPES,
  coerceExportInfo,
  defaultSnapshotName,
  type ExportInfoOptions,
} from './types';

/** 分组方式（导出弹窗里的四选一） */
export const BASKET_GROUPS = ['flat', 'type', 'knowledge', 'source'] as const;
export type BasketGroup = (typeof BASKET_GROUPS)[number];

/**
 * v10：「按题型」分组时的章序。
 *
 * 你说的是「单选、多选、填空、简答」，程序里的题型名叫「解答」——
 * 两者指同一类（解答题/简答题），用程序里的名字，顺便在这里显式写死顺序，
 * 免得依赖 QUESTION_TYPES 的数组顺序（那个顺序是录入页按钮的顺序，两回事）。
 */
export const GROUP_TYPE_ORDER = ['单选', '多选', '填空', '解答'] as const;

/**
 * 导出选项（v2 精简后**只剩分组**）。
 *
 * 删掉的三项及原因：
 *   预设 —— 两个 PDF 天然就是「题目版」和「答案版」，不需要再选
 *   版式 —— 固定用标准留白；想改用模板文件改
 *   顺序 —— 永远是试题篮里的顺序
 */
export interface BasketExportOptions {
  /** 模板名（「模板」文件夹下的子文件夹名；导出弹窗里选） */
  template?: string;
  group?: BasketGroup;
  /**
   * v5：讲义标题。留空则回退到「当前快照名 → 时间戳」。
   * 存进导出选项里而不是每次填一次 —— 这样「保存快照」也会把标题一起记住，
   * 载入历史快照时标题跟着回来。
   */
  title?: string;
  /**
   * v6：题目信息要装哪些（来源/题号/难度/知识点/年份/创新）。
   * 同样存在选项里，所以「保存快照」会把它一起记住。
   */
  info?: ExportInfoOptions;
}

/** 已保存的快照 */
export interface Basket {
  id: string;
  name: string;
  /** 有序的 id 列表 —— 顺序就是讲义里题目的顺序 */
  qids: string[];
  exportOptions: BasketExportOptions;
  createdAt: string;
  updatedAt: string;
}

/** 「正在编辑」的内容 */
export interface BasketDraft {
  qids: string[];
  exportOptions: BasketExportOptions;
}

export interface BasketStoreShape {
  version: number;
  draft: BasketDraft;
  /** 按保存时间倒序（最新在前） */
  saved: Basket[];
}

const STORE_VERSION = 2;

export const DEFAULT_EXPORT_OPTIONS: Required<BasketExportOptions> = {
  template: '默认',
  group: 'flat',
  title: '',
  info: { ...DEFAULT_EXPORT_INFO },
};

export function basketsPath(): string {
  return metaFile(META_BASKETS);
}

function now(): string {
  return new Date().toISOString();
}

function newId(): string {
  return `b${crypto.randomUUID().slice(0, 8)}`;
}

function emptyDraft(): BasketDraft {
  return { qids: [], exportOptions: { ...DEFAULT_EXPORT_OPTIONS } };
}

function emptyStore(): BasketStoreShape {
  return { version: STORE_VERSION, draft: emptyDraft(), saved: [] };
}

/**
 * 默认名（日期 + 时间）的实现搬到了 lib/types.ts —— 那边是纯函数、
 * 客户端能安全引用；本文件 import fs，客户端从这儿引会把 fs 拖进浏览器包。
 * 这里转出去，老调用点（verify-live / final-check 等）不用改。
 */
export { defaultSnapshotName } from './types';

function coerceOptions(raw: unknown): Required<BasketExportOptions> {
  const opts = (raw && typeof raw === 'object' ? raw : {}) as BasketExportOptions;
  return {
    // 只接受合法枚举，防止手改文件塞进奇怪的值。
    // v1 遗留的 preset / layout / order 会被自然丢弃（不再读取）。
    template: typeof opts.template === 'string' && opts.template.trim() ? opts.template : '默认',
    group: (BASKET_GROUPS as readonly string[]).includes(String(opts.group))
      ? (opts.group as BasketGroup)
      : DEFAULT_EXPORT_OPTIONS.group,
    title: typeof opts.title === 'string' ? opts.title.trim() : '',
    // v6：逐项 coerce —— 老快照里没有 info，会自然补上默认值
    info: coerceExportInfo(opts.info),
  };
}

function coerceQids(raw: unknown): string[] {
  return Array.isArray(raw)
    ? Array.from(new Set(raw.filter((q): q is string => typeof q === 'string' && q.trim() !== '')))
    : [];
}

function coerceBasket(raw: unknown): Basket | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  return {
    id: typeof r.id === 'string' && r.id ? r.id : newId(),
    name: typeof r.name === 'string' && r.name.trim() ? r.name.trim() : '未命名',
    qids: coerceQids(r.qids),
    exportOptions: coerceOptions(r.exportOptions),
    createdAt: typeof r.createdAt === 'string' ? r.createdAt : now(),
    updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt : now(),
  };
}

/** 按保存时间倒序（最新在上）；时间相同时用 id 兜底保证顺序稳定 */
function sortSaved(list: Basket[]): Basket[] {
  return list.sort((a, b) =>
    a.createdAt === b.createdAt ? a.id.localeCompare(b.id) : b.createdAt.localeCompare(a.createdAt)
  );
}

/**
 * 读 baskets.json。
 *
 * v1 → v2 一次性迁移：v1 的形状是 `{activeId, baskets[]}`。
 *   · 所有 v1 篮子**原样进 saved**（名字、时间都保住，一条不丢）
 *   · 当时 active 的那个，内容同时拷进 draft（这样打开就是接着在编）
 * 迁移只在读到旧版本时发生，转换完立即回写。
 */
export function readBasketStore(): BasketStoreShape {
  const file = basketsPath();
  if (!fs.existsSync(file)) return emptyStore();
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>;

    // ---- v2 及以上：直接读 ----
    if (raw.version === STORE_VERSION && raw.draft && typeof raw.draft === 'object') {
      const d = raw.draft as Record<string, unknown>;
      const saved = Array.isArray(raw.saved)
        ? raw.saved.map(coerceBasket).filter((b): b is Basket => b !== null)
        : [];
      return {
        version: STORE_VERSION,
        draft: { qids: coerceQids(d.qids), exportOptions: coerceOptions(d.exportOptions) },
        saved: sortSaved(saved),
      };
    }

    // ---- v1 迁移 ----
    const migrated = migrateFromV1(raw);
    writeBasketStore(migrated);
    return migrated;
  } catch (e) {
    console.warn(`[baskets] baskets.json 损坏，按空处理：${(e as Error).message}`);
    return emptyStore();
  }
}

function migrateFromV1(raw: Record<string, unknown>): BasketStoreShape {
  const saved = Array.isArray(raw.baskets)
    ? raw.baskets.map(coerceBasket).filter((b): b is Basket => b !== null)
    : [];
  const activeId = typeof raw.activeId === 'string' ? raw.activeId : null;
  const active = saved.find((b) => b.id === activeId) ?? saved[0] ?? null;
  console.log(
    `[baskets] 检测到 v1 格式，已迁移到 v3 模型：` +
      `${saved.length} 个篮子全部保留为快照，其中「${active?.name ?? '空'}」的内容作为当前编辑`
  );
  return {
    version: STORE_VERSION,
    draft: active
      ? { qids: [...active.qids], exportOptions: { ...coerceOptions(active.exportOptions) } }
      : emptyDraft(),
    saved: sortSaved(saved),
  };
}

export function writeBasketStore(store: BasketStoreShape): void {
  ensureDir(metaDir());
  const out: BasketStoreShape = {
    version: STORE_VERSION,
    draft: {
      qids: coerceQids(store.draft?.qids),
      exportOptions: coerceOptions(store.draft?.exportOptions),
    },
    saved: sortSaved(store.saved ?? []),
  };
  fs.writeFileSync(basketsPath(), JSON.stringify(out, null, 2) + '\n', 'utf-8');
}

// ============================================================
// 读
// ============================================================

/** 当前编辑的内容（永远存在，不会是 null） */
export function getDraft(): BasketDraft {
  return readBasketStore().draft;
}

export function listSaved(): Basket[] {
  return readBasketStore().saved;
}

export function getSaved(id: string): Basket | null {
  return readBasketStore().saved.find((b) => b.id === id) ?? null;
}

/** 浏览页勾选态用的集合 —— **只反映「正在编辑」** */
export function draftQids(): Set<string> {
  return new Set(getDraft().qids);
}

/**
 * 内容是否与 draft 完全相同。
 *
 * v7 起它**只**用来算 `currentSnapshotId()`（导出弹窗里"标题留空时用哪条快照的名字"），
 * 不再参与"要不要自动保存"的判断 —— 你现在允许相同内容配两个名字，
 * 那个判断已经删掉了（见 loadSnapshot）。
 */
export function sameAsDraft(b: Basket, draft: BasketDraft): boolean {
  if (b.qids.length !== draft.qids.length) return false;
  if (b.qids.some((q, i) => q !== draft.qids[i])) return false;
  const a = coerceOptions(b.exportOptions);
  const d = coerceOptions(draft.exportOptions);
  // v5：标题也算内容的一部分 —— 否则只改了标题的两条会被当成重复
  // v6：题目信息开关同理（改了勾选就是另一份讲义）
  return (
    a.template === d.template &&
    a.group === d.group &&
    a.title === d.title &&
    EXPORT_INFO_KEYS.every((k) => a.info[k] === d.info[k])
  );
}

/** 左侧列表里应该打「当前」标记的那条（没有就返回 null） */
export function currentSnapshotId(): string | null {
  const store = readBasketStore();
  return store.saved.find((b) => sameAsDraft(b, store.draft))?.id ?? null;
}

// ============================================================
// 写：draft
// ============================================================

function mutateDraft(fn: (d: BasketDraft) => void): BasketDraft {
  const store = readBasketStore();
  fn(store.draft);
  writeBasketStore(store);
  return store.draft;
}

/**
 * 追加式加入（绝不覆盖）。已存在的跳过，不存在的 qid 拒掉。
 *
 * v7：**整卷直接拒收**（见 pickPapers 的说明）。单独用 papers 报出来，
 * 而不是混进 invalid —— 两者原因完全不同，界面上要分开说。
 */
export function addToDraft(qids: string[]): {
  added: string[];
  skipped: string[];
  invalid: string[];
  papers: string[];
} {
  const invalid: string[] = [];
  const valid: string[] = [];
  for (const q of qids) {
    const clean = String(q).trim();
    if (!clean) continue;
    if (!questionExists(clean)) {
      invalid.push(clean);
      continue;
    }
    valid.push(clean);
  }

  const papers = pickPapers(valid);

  const skipped: string[] = [];
  const added: string[] = [];
  mutateDraft((d) => {
    for (const q of valid) {
      if (papers.includes(q)) continue;
      if (d.qids.includes(q)) skipped.push(q);
      else {
        d.qids.push(q);
        added.push(q);
      }
    }
  });
  return { added, skipped, invalid, papers };
}

/** 取消勾选 = 移除 */
export function removeFromDraft(qid: string): BasketDraft {
  return mutateDraft((d) => {
    d.qids = d.qids.filter((q) => q !== qid);
  });
}

// ============================================================
// v7：整卷不进试题篮
// ============================================================

/**
 * 从一批 qid 里挑出**整卷**。
 *
 * 为什么整卷不能进篮子：整卷在导出那一侧就是一个 PDF 文件（试卷页上是 PDF，
 * 不是能重新排版的 LaTeX），放进篮子再"导"一次没有任何可做的事。
 * 整卷的正确用法是**当来源**：在浏览页看它名下有哪些题，把**那些题**加进篮子。
 */
export function pickPapers(qids: string[]): string[] {
  if (qids.length === 0) return [];
  const kind = new Map(loadIndexOrRebuild().map((e) => [e.qid, e.kind]));
  return qids.filter((q) => kind.get(q) === '整卷');
}

/** 请求里"整卷"的统一话术 —— 界面与接口用同一句，免得两处说法不一样 */
export function papersRejectedMessage(papers: string[]): string {
  return `整卷不进试题篮（它是 PDF，没法重新排版）：${papers.join('、')}。要看它名下的题目，去题目详情页。`;
}

/**
 * 正在编辑的统计（v7：浏览页侧边的试题篮卡片）。
 * 只读索引、**不读正文** —— 浏览页每翻一页都要显示它，不能为它把答案都读出来。
 */
export interface DraftStats {
  total: number;
  /** 题型 → 数量（只有单题；固定包含四个题型，没有的补 0，界面不用再判空） */
  byType: Record<string, number>;
  /** 历史遗留：篮子里混进来的整卷（v7 起不允许，但老数据可能有） */
  papers: string[];
}

export function draftStats(): DraftStats {
  const qids = getDraft().qids;
  const byQid = new Map(loadIndexOrRebuild().map((e) => [e.qid, e]));
  const byType: Record<string, number> = {};
  for (const t of QUESTION_TYPES) byType[t] = 0;

  const papers: string[] = [];
  for (const qid of qids) {
    const e = byQid.get(qid);
    if (e?.kind === '整卷') {
      papers.push(qid);
      continue;
    }
    if (e?.type && byType[e.type] !== undefined) byType[e.type]++;
  }
  return { total: qids.length, byType, papers };
}

/** 整体替换/重排 */
export function setDraftQids(qids: string[]): { invalid: string[]; papers: string[] } {
  const invalid: string[] = [];
  const clean: string[] = [];
  for (const q of qids) {
    const s = String(q).trim();
    if (!s) continue;
    if (!questionExists(s)) {
      invalid.push(s);
      continue;
    }
    if (!clean.includes(s)) clean.push(s);
  }
  const papers = pickPapers(clean);
  const final = clean.filter((q) => !papers.includes(q));

  mutateDraft((d) => {
    d.qids = final;
  });
  return { invalid, papers };
}

export function clearDraft(): BasketDraft {
  return mutateDraft((d) => {
    d.qids = [];
  });
}

export function setDraftExportOptions(options: BasketExportOptions): BasketDraft {
  return mutateDraft((d) => {
    d.exportOptions = { ...coerceOptions(d.exportOptions), ...options };
  });
}

// ============================================================
// 写：saved 快照
// ============================================================

/** 名字重名时追加 ` (2)`、` (3)`… */
function uniqueName(desired: string, saved: Basket[], exceptId?: string): string {
  const taken = new Set(saved.filter((b) => b.id !== exceptId).map((b) => b.name));
  if (!taken.has(desired)) return desired;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${desired} (${i})`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${desired} (${Date.now()})`;
}

/** 给当前编辑内容拍一张快照；**draft 不变** */
export function saveSnapshot(name?: string): Basket {
  const store = readBasketStore();
  const snap: Basket = {
    id: newId(),
    name: uniqueName(name?.trim() || defaultSnapshotName(), store.saved),
    qids: [...store.draft.qids],
    exportOptions: { ...coerceOptions(store.draft.exportOptions) },
    createdAt: now(),
    updatedAt: now(),
  };
  store.saved.push(snap);
  writeBasketStore(store);
  return snap;
}

export interface LoadSnapshotResult {
  /** 载入后的 draft */
  draft: BasketDraft;
  /** 本次为「原来正在编辑的内容」自动存下的快照；没存则为 null */
  autoSaved: Basket | null;
  /** 被载入的那条快照（仍留在列表里） */
  loaded: Basket;
  /** v7：这条存档里被过滤掉的整卷（老存档可能存过） */
  skippedPapers: string[];
}

/**
 * 载入存档（v7 重写）。
 *
 * 规则就是你说的三步，一步都不多：
 *   ① 当前「正在编辑」有题目 → **先保存**成一条新快照
 *   ② 清空当前试题篮
 *   ③ 把这条存档的**全部题目复制**进当前试题篮
 *
 * 被点的那条存档**不动**（可以反复载入）。
 *
 * v7 去掉了 v4 加的「内容已在列表里就不存」判断。理由：
 * 你现在明确要求**允许相同内容配两个不同的名字** —— 那"跟列表里某条一样"
 * 就不再是不保存的理由。连着点同一条存档两次会多出两条内容相同的快照，
 * 这是规则本身的结果，不是 bug；新名字是自动生成的时间戳，随时可以改。
 */
export function loadSnapshot(id: string): LoadSnapshotResult {
  const store = readBasketStore();
  const target = store.saved.find((b) => b.id === id);
  if (!target) throw new Error(`快照不存在：${id}`);

  // ① 先保存当前（只在真有题目时）
  let autoSaved: Basket | null = null;
  if (store.draft.qids.length > 0) {
    autoSaved = {
      id: newId(),
      name: uniqueName(defaultSnapshotName(), store.saved),
      qids: [...store.draft.qids],
      exportOptions: { ...coerceOptions(store.draft.exportOptions) },
      createdAt: now(),
      updatedAt: now(),
    };
    store.saved.push(autoSaved);
  }

  // ②③ 清空 + 复制（一步到位：直接替换就是清空）。老存档里若混了整卷，这里过滤掉。
  const targetQids = [...target.qids];
  const skippedPapers = pickPapers(targetQids);
  store.draft = {
    qids: targetQids.filter((q) => !skippedPapers.includes(q)),
    exportOptions: { ...coerceOptions(target.exportOptions) },
  };
  writeBasketStore(store);
  return { draft: store.draft, autoSaved, loaded: target, skippedPapers };
}

export function renameSnapshot(id: string, name: string): Basket {
  const store = readBasketStore();
  const b = store.saved.find((x) => x.id === id);
  if (!b) throw new Error(`快照不存在：${id}`);
  const clean = name.trim();
  if (!clean) throw new Error('名字不能为空');
  b.name = uniqueName(clean, store.saved, id);
  b.updatedAt = now();
  writeBasketStore(store);
  return b;
}

/**
 * 删除快照。允许删除正被载入的那条 —— 只删左侧这条记录，
 * 右侧「正在编辑」的内容不受影响。
 */
export function deleteSnapshot(id: string): void {
  const store = readBasketStore();
  const before = store.saved.length;
  store.saved = store.saved.filter((b) => b.id !== id);
  if (store.saved.length === before) throw new Error(`快照不存在：${id}`);
  writeBasketStore(store);
}
