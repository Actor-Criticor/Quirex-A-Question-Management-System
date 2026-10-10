/**
 * searchIndex.ts — 检索索引
 *
 * 题库/_meta/index.json 一题一条。作用（方案 §11）：
 *   1) 搜索不必每次读全部 md
 *   2) 预计算 searchText（题干去 LaTeX 命令的纯文本）
 *
 * 关键设计：整卷的 searchText 恒为空 —— 描述不进搜索索引（方案 §8.1）。
 * 否则搜任何一个知识点都会把一堆整卷淹进结果，干扰找单题。
 */

import fs from 'fs';
import {
  BAND_RANGES,
  resolveFigAlign,
  type IndexEntry,
  type QuestionMeta,
  type SearchParams,
  type SearchResult,
} from './types';
import { META_INDEX, ensureDir, metaDir, metaFile, paperIdToNumber, qidToNumber } from './paths';
import { listAssets, listPdfRoles, readContent, readMeta } from './store';
import { listQidFolders } from './paths';
import { stripLatex } from './latexSubset';

export { stripLatex };

interface IndexFileShape {
  version: number;
  generatedAt: string;
  entries: IndexEntry[];
}

const INDEX_VERSION = 1;
const DESC_PREVIEW_LIMIT = 200;

// ============================================================
// 文本处理
// ============================================================
// stripLatex 已移到 latexSubset.ts（与可移植子集定义放在一起），此处按需再导出。

export function makeDescPreview(description?: string): string | undefined {
  if (!description) return undefined;
  const t = description.replace(/\s+/g, ' ').trim();
  if (!t) return undefined;
  return t.length > DESC_PREVIEW_LIMIT ? t.slice(0, DESC_PREVIEW_LIMIT) + '…' : t;
}

/**
 * 计算全文检索串。
 *   单题 = 题干去命令 + 答案去命令 + 描述
 *   整卷 = ''（描述不进搜索）
 */
export function buildSearchText(meta: QuestionMeta): string {
  if (meta.kind === '整卷') return '';
  const stem = stripLatex(readContent(meta.qid, 'stem'));
  const answer = stripLatex(readContent(meta.qid, 'answer'));
  const desc = (meta.description ?? '').toLowerCase();
  return [stem, answer, desc].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

// ============================================================
// 构造条目
// ============================================================

export function buildEntry(meta: QuestionMeta): IndexEntry {
  const entry: IndexEntry = {
    qid: meta.qid,
    kind: meta.kind,
    hasImages: listAssets(meta.qid).length > 0,
    hasPdf: listPdfRoles(meta.qid).length > 0,
    status: meta.status,
    searchText: buildSearchText(meta),
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
  };
  if (meta.kind === '单题') {
    if (meta.type) entry.type = meta.type;
    if (meta.number !== undefined) entry.number = meta.number;
    if (meta.knowledge?.length) entry.knowledge = meta.knowledge;
    // v9：自定义标签（仅单题）
    if (meta.custom?.length) entry.custom = meta.custom;
  }
  if (meta.source) entry.source = meta.source;
  if (meta.difficulty !== undefined) entry.difficulty = meta.difficulty;
  // v2：创新只属于单题 —— 整卷即使文件里残留了 innovation 也不进索引
  if (meta.kind === '单题' && meta.innovation) entry.innovation = true;
  // v3：年份两种 kind 都记
  if (meta.year !== undefined) entry.year = meta.year;
  // v5：配图位置 —— 存**解析后的生效值**（手动设过就用设的，没设过按题型推导），
  // 这样网页直接读索引就能和 PDF 保持一致，不用各自推一遍。
  if (meta.kind === '单题') entry.figAlign = resolveFigAlign(meta.type, meta.figAlign);
  const preview = makeDescPreview(meta.description);
  if (preview) entry.descPreview = preview;
  return entry;
}

// ============================================================
// 读写索引文件
// ============================================================

export function indexFilePath(): string {
  return metaFile(META_INDEX);
}

export function loadIndex(): IndexEntry[] {
  const file = indexFilePath();
  if (!fs.existsSync(file)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as IndexFileShape;
    if (!raw || !Array.isArray(raw.entries)) return [];
    return raw.entries;
  } catch (e) {
    console.warn(`[index] 索引损坏，将重建：${(e as Error).message}`);
    return [];
  }
}

/** 索引里的排序键：单题按数字号，试卷按 P 后面的数字号（两类不混排） */
function sortKey(entry: IndexEntry): number {
  return entry.kind === '整卷' ? paperIdToNumber(entry.qid) : qidToNumber(entry.qid);
}

export function saveIndex(entries: IndexEntry[]): void {
  ensureDir(metaDir());
  const payload: IndexFileShape = {
    version: INDEX_VERSION,
    generatedAt: new Date().toISOString(),
    entries: entries
      .slice()
      .sort((a, b) => {
        // 单题在前、试卷在后，各自按号升序
        if (a.kind !== b.kind) return a.kind === '整卷' ? 1 : -1;
        return sortKey(a) - sortKey(b);
      }),
  };
  fs.writeFileSync(indexFilePath(), JSON.stringify(payload, null, 2) + '\n', 'utf-8');
}

/** 全量重建：扫描题库目录，逐个读元数据 */
export function rebuildIndex(): IndexEntry[] {
  const entries: IndexEntry[] = [];
  for (const qid of listQidFolders()) {
    const meta = readMeta(qid);
    if (!meta) continue;
    entries.push(buildEntry(meta));
  }
  saveIndex(entries);
  return entries;
}

/** 索引不可用（缺文件）时自动重建 */
export function loadIndexOrRebuild(): IndexEntry[] {
  const file = indexFilePath();
  if (!fs.existsSync(file)) return rebuildIndex();
  return loadIndex();
}

// ============================================================
// 增量更新（改题只更新这一条）
// ============================================================

export function upsertEntry(meta: QuestionMeta): IndexEntry {
  const entries = loadIndex();
  const entry = buildEntry(meta);
  const i = entries.findIndex((e) => e.qid === meta.qid);
  if (i >= 0) entries[i] = entry;
  else entries.push(entry);
  saveIndex(entries);
  return entry;
}

export function removeEntry(qid: string): void {
  const entries = loadIndex().filter((e) => e.qid !== qid);
  saveIndex(entries);
}

// ============================================================
// 检索
// ============================================================

function splitTokens(q?: string): string[] {
  if (!q) return [];
  return q
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

/** 一条记录的所有标签名（用于「标签路」匹配） */
export function entryTagNames(entry: IndexEntry): string[] {
  const names: string[] = [];
  if (entry.source) names.push(entry.source);
  if (entry.knowledge?.length) names.push(...entry.knowledge);
  // v9：自定义标签也走「标签路」—— 关键字框里打「一模压轴」就能找到那批题。
  // （你说过它不进浏览页的筛选面，但**关键字能搜到**是另一件事，这个要。）
  if (entry.custom?.length) names.push(...entry.custom);
  // v3：年份也算一个「标签名」—— 这样关键字框里直接打 2025 就能命中，
  // 而且对整卷同样有效（整卷的 searchText 恒为空，只有标签路能用）。
  if (entry.year !== undefined) names.push(String(entry.year));
  return names.map((n) => n.toLowerCase());
}

/** v3：年份 facet 的一项 */
export interface YearFacet {
  year: number;
  /** 引用计数（含停用题）—— 与标签计数口径一致 */
  count: number;
  /** 其中启用的题数 */
  enabledCount: number;
}

/**
 * 从索引聚合出年份 facet（只返回真实存在的年份，不铺 1900–2100）。
 * 降序排列 —— 新课标/新题在前，符合老师找题的习惯。
 */
export function listYears(entries?: IndexEntry[]): YearFacet[] {
  const src = entries ?? loadIndex();
  const map = new Map<number, YearFacet>();
  for (const e of src) {
    if (e.year === undefined) continue;
    let item = map.get(e.year);
    if (!item) {
      item = { year: e.year, count: 0, enabledCount: 0 };
      map.set(e.year, item);
    }
    item.count += 1;
    if (e.status === '启用') item.enabledCount += 1;
  }
  return Array.from(map.values()).sort((a, b) => b.year - a.year);
}

/**
 * 纯函数检索（便于测试注入）。
 *
 * 语义：
 *   - 关键字：空格分词 = AND；每个词命中「标签名」或「searchText」即可（两路求并集）
 *   - 同一维度多选 = OR（知识点、难度档位选中多个时是"或"）
 *   - 跨维度 = AND
 *   - 范围参数给了才过滤；没给就不过滤（所以未录入难度的题不会被默认排除）
 *   - v2：bands 给的是档位（按左闭右开换算成数值区间）；innovation 只看创新题
 *   - 默认只看「启用」
 */
export function searchEntries(entries: IndexEntry[], params: SearchParams = {}): SearchResult {
  const tokens = splitTokens(params.q);
  const page = Math.max(1, Math.floor(params.page ?? 1));
  const size = Math.max(1, Math.floor(params.size ?? 25));
  const status = params.status ?? '启用';

  const filtered = entries.filter((entry) => {
    if (status !== '全部' && entry.status !== status) return false;
    if (params.kind && entry.kind !== params.kind) return false;
    if (params.type && entry.type !== params.type) return false;
    if (params.source && entry.source !== params.source) return false;

    if (params.knowledge?.length) {
      const own = entry.knowledge ?? [];
      if (!params.knowledge.some((k) => own.includes(k))) return false;
    }

    // v2：创新标记筛选（整卷永远不创新，所以整卷在这个条件下会被全部排除）
    if (params.innovation === true && entry.innovation !== true) return false;

    // v3：年份（多选 = OR）
    if (params.years?.length) {
      if (entry.year === undefined || !params.years.includes(entry.year)) return false;
    }

    // v2：难度档位（多选 = OR）；左闭右开，基础那一档含上界
    if (params.bands?.length) {
      const d = entry.difficulty;
      if (d === undefined) return false;
      const hit = params.bands.some((band) => {
        const r = BAND_RANGES[band];
        return d >= r.min && (band === '基础' ? d <= r.max : d < r.max);
      });
      if (!hit) return false;
    }

    if (params.numMin !== undefined) {
      if (entry.number === undefined || entry.number < params.numMin) return false;
    }
    if (params.numMax !== undefined) {
      if (entry.number === undefined || entry.number > params.numMax) return false;
    }
    if (params.diffMin !== undefined) {
      if (entry.difficulty === undefined || entry.difficulty < params.diffMin) return false;
    }
    if (params.diffMax !== undefined) {
      if (entry.difficulty === undefined || entry.difficulty > params.diffMax) return false;
    }

    if (tokens.length) {
      const tagNames = entryTagNames(entry);
      const text = entry.searchText;
      const allHit = tokens.every(
        (t) => tagNames.some((name) => name.includes(t)) || text.includes(t)
      );
      if (!allHit) return false;
    }

    return true;
  });

  const sorted = filtered.slice().sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === '整卷' ? 1 : -1;
    return sortKey(a) - sortKey(b);
  });

  const start = (page - 1) * size;
  return {
    total: sorted.length,
    page,
    size,
    items: sorted.slice(start, start + size),
  };
}

/**
 * 便捷封装：读索引 + 检索。
 * withContent=true 时把这一页的题干/答案一并带上（列表要直接渲染题目，
 * 这样只需一次请求，而不是每道题再打一次详情接口）。
 */
export function search(params: SearchParams = {}, withContent = false): SearchResult {
  const result = searchEntries(loadIndexOrRebuild(), params);
  if (!withContent) return result;

  const contents: NonNullable<SearchResult['contents']> = {};
  for (const item of result.items) {
    contents[item.qid] = {
      stem: readContent(item.qid, 'stem'),
      answer: readContent(item.qid, 'answer'),
      assets: listAssets(item.qid).map((a) => a.name),
    };
  }
  return { ...result, contents };
}
