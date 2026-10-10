/**
 * store.ts — 题目文件读写（纯文件 IO 层，不碰索引）
 *
 * 结构（方案 §10.1）：
 *   题库/<qid>/<qid>.md       元数据
 *   题库/<qid>/题干.tex       单题题干（LaTeX 真源）
 *   题库/<qid>/答案.tex       单题答案（原「解析」已合并）
 *   题库/<qid>/<qid>-stem-01.png  图片（四通道，角色写在文件名里）
 *   题库/<qid>/题目.pdf       整卷题目
 *   题库/<qid>/答案.pdf       整卷答案
 *
 * 只做文件 IO；索引维护与业务编排在 service.ts。
 */

import fs from 'fs';
import path from 'path';
import matter from 'gray-matter';
import {
  IMAGE_CHANNELS,
  type ImageChannel,
  type PdfRole,
  type QuestionKind,
  type QuestionMeta,
  type QuestionStatus,
  isQuestionType,
  isFigAlign,
} from './types';
import {
  answerTexPath,
  ensureDir,
  metaMdPath,
  pdfPath,
  questionDir,
  stemTexPath,
} from './paths';
import { normalizeDescription, normalizeInnovation, normalizeTagName } from './validate';

// ============================================================
// 路径
// ============================================================

export type ContentPart = 'stem' | 'answer';

export function contentPath(qid: string, part: ContentPart): string {
  return part === 'stem' ? stemTexPath(qid) : answerTexPath(qid);
}

// ============================================================
// 存在性
// ============================================================

export function questionDirExists(qid: string): boolean {
  return fs.existsSync(questionDir(qid));
}

export function questionExists(qid: string): boolean {
  return fs.existsSync(metaMdPath(qid));
}

// ============================================================
// 元数据读写
// ============================================================

function toIsoString(v: unknown, fallback: string): string {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'string' && v.trim()) return v.trim();
  return fallback;
}

function toNumberOrUndefined(v: unknown): number | undefined {
  if (v === null || v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** 宽松地把 frontmatter 收成 QuestionMeta（外部手改过的文件也不至于读崩） */
export function coerceMeta(qid: string, data: Record<string, unknown>): QuestionMeta {
  const now = new Date().toISOString();

  const kind: QuestionKind = data.kind === '整卷' ? '整卷' : '单题';

  const rawKnowledge = data.knowledge;
  const knowledgeList = (Array.isArray(rawKnowledge) ? rawKnowledge : rawKnowledge ? [rawKnowledge] : [])
    .map((k) => normalizeTagName(k))
    .filter(Boolean);
  const knowledge = Array.from(new Set(knowledgeList));

  // v9：自定义标签 —— 与知识点同一套宽松读法（手改过的文件也不至于读崩）。
  // 读的一侧**不查上限**：老数据里可能已经超过 5 个，不能一读就丢字段。
  const rawCustom = data.custom;
  const customList = (Array.isArray(rawCustom) ? rawCustom : rawCustom ? [rawCustom] : [])
    .map((k) => normalizeTagName(k))
    .filter(Boolean);
  const custom = Array.from(new Set(customList));

  const source = normalizeTagName(data.source) || undefined;

  const status: QuestionStatus = data.status === '停用' ? '停用' : '启用';

  let figures: Record<string, string> | undefined;
  if (data.figures && typeof data.figures === 'object' && !Array.isArray(data.figures)) {
    figures = {};
    for (const [k, v] of Object.entries(data.figures as Record<string, unknown>)) {
      if (typeof v === 'string' && v.trim()) figures[k] = v.trim();
    }
    if (Object.keys(figures).length === 0) figures = undefined;
  }

  const meta: QuestionMeta = {
    qid,
    kind,
    status,
    createdAt: toIsoString(data.createdAt, now),
    updatedAt: toIsoString(data.updatedAt, now),
  };

  // 只有单题才有题型/题号/知识点/自定义标签
  if (kind === '单题') {
    if (isQuestionType(data.type)) meta.type = data.type;
    const num = toNumberOrUndefined(data.number);
    if (num !== undefined) meta.number = num;
    if (knowledge.length) meta.knowledge = knowledge;
    if (custom.length) meta.custom = custom;
  } else {
    // 整卷即便历史文件里带了这些字段也一律忽略，保持字段矩阵干净
  }

  if (source) meta.source = source;
  const diff = toNumberOrUndefined(data.difficulty);
  if (diff !== undefined) meta.difficulty = diff;
  // v2：创新标记（只认真值）—— **仅单题**。整卷即便历史文件里带了也一律忽略，
  // 与 service.create / service.update / searchIndex.buildEntry 四处的口径保持一致。
  if (kind === '单题' && normalizeInnovation(data.innovation)) meta.innovation = true;
  // v3：年份（两种 kind 都有）。**这一步漏了的话，年份写进文件后一读就丢，
  // 而索引走的是内存对象 —— 会造成「索引里有、文件里没有」的不一致。**
  const year = toNumberOrUndefined(data.year);
  if (year !== undefined) meta.year = year;
  // v5：配图位置（仅单题）。**同样必须读写两侧都搬**，否则算出来的位置会丢。
  if (kind === '单题' && isFigAlign(data.figAlign)) meta.figAlign = data.figAlign;
  const desc = normalizeDescription(data.description);
  if (desc) meta.description = desc;
  if (figures) meta.figures = figures;

  return meta;
}

/** 读元数据；文件不存在返回 null。qid 以文件夹名为准，不信 md 里的值 */
export function readMeta(qid: string): QuestionMeta | null {
  const file = metaMdPath(qid);
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = matter(fs.readFileSync(file, 'utf-8'));
    return coerceMeta(qid, parsed.data as Record<string, unknown>);
  } catch (e) {
    console.warn(`[store] 元数据解析失败 ${file}: ${(e as Error).message}`);
    return null;
  }
}

/** 写元数据（固定字段顺序，便于 git diff 与人工查看） */
export function writeMeta(meta: QuestionMeta): void {
  ensureDir(questionDir(meta.qid));

  const data: Record<string, unknown> = {
    qid: meta.qid,
    kind: meta.kind,
  };

  if (meta.kind === '单题') {
    if (meta.type) data.type = meta.type;
  }
  if (meta.source) data.source = meta.source;
  if (meta.kind === '单题' && meta.number !== undefined) data.number = meta.number;
  if (meta.difficulty !== undefined) data.difficulty = meta.difficulty;
  if (meta.kind === '单题' && meta.knowledge?.length) data.knowledge = meta.knowledge;
  // v9：自定义标签（仅单题；空数组就不写这个字段）
  if (meta.kind === '单题' && meta.custom?.length) data.custom = meta.custom;
  // v2：创新标记；false/undefined 就不写这个字段（保持 md 干净）。
  // 只有单题写 —— 整卷不该出现这个字段。
  if (meta.kind === '单题' && meta.innovation) data.innovation = true;
  // v3：年份（两种 kind 都写；没录就不写这个字段）
  if (meta.year !== undefined) data.year = meta.year;
  // v5：配图位置（仅单题；没设就不写，让"按题型推导"保持生效）
  if (meta.kind === '单题' && meta.figAlign) data.figAlign = meta.figAlign;
  if (meta.description) data.description = meta.description;
  data.status = meta.status;
  if (meta.figures && Object.keys(meta.figures).length) data.figures = meta.figures;
  data.createdAt = meta.createdAt;
  data.updatedAt = meta.updatedAt;

  // 正文留空：题干/答案在各自的 .tex 里（方案 §10.2）
  const out = matter.stringify('', data as Record<string, unknown>);
  fs.writeFileSync(metaMdPath(meta.qid), out, 'utf-8');
}

// ============================================================
// 正文读写（LaTeX 真源）
// ============================================================

export function readContent(qid: string, part: ContentPart): string {
  const file = contentPath(qid, part);
  if (!fs.existsSync(file)) return '';
  return fs.readFileSync(file, 'utf-8');
}

export function writeContent(qid: string, part: ContentPart, text: string): void {
  ensureDir(questionDir(qid));
  fs.writeFileSync(contentPath(qid, part), text ?? '', 'utf-8');
}

// ============================================================
// 图片资产（四通道）
// ============================================================

export interface AssetInfo {
  name: string;
  channel: ImageChannel;
  index: number;
  ext: string;
}

/**
 * 资源文件名：`{qid}-{通道}-NN.ext`
 *
 * v4：qid 可能是新的 `T0001` 也可能是旧的 `0001`，两种都认（宽松读）。
 * 新写入的一律是 `T####-...`（见 buildAssetName）。
 * v9：qid 前面还可能带**学科字母**（`AT0001`）—— 所以前缀是
 * "最多两个字母 + 至少 3 位数字"。这条正则漏改的话，带字母的 qid
 * 的图片会**静默识别不出来**（列表里显示"没有图片"、导出也复制不到）。
 */
const ASSET_RE = /^([A-Za-z]{0,2}\d{3,})-(stem|fig|ans|ansfig)-(\d{2,})\.([A-Za-z0-9]+)$/;

export function parseAssetName(name: string): AssetInfo | null {
  const m = name.match(ASSET_RE);
  if (!m) return null;
  return {
    name,
    channel: m[2] as ImageChannel,
    index: parseInt(m[3], 10),
    ext: m[4].toLowerCase(),
  };
}
/** 列出该题的图片（只认符合命名规范、且 qid 前缀匹配的文件） */
export function listAssets(qid: string): AssetInfo[] {
  const dir = questionDir(qid);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .map(parseAssetName)
    .filter((a): a is AssetInfo => a !== null && a.name.startsWith(`${qid}-`))
    .sort((a, b) =>
      a.channel === b.channel ? a.index - b.index : a.channel.localeCompare(b.channel)
    );
}

export function listAssetsByChannel(qid: string, channel: ImageChannel): AssetInfo[] {
  return listAssets(qid).filter((a) => a.channel === channel);
}

export function nextAssetIndex(qid: string, channel: ImageChannel): number {
  const list = listAssetsByChannel(qid, channel);
  return list.length ? Math.max(...list.map((a) => a.index)) + 1 : 1;
}

/** 图片文件名一律带 qid 前缀 → 全库唯一 → 导出时只复制文件、不改 .tex */
export function buildAssetName(
  qid: string,
  channel: ImageChannel,
  index: number,
  ext = 'png'
): string {
  return `${qid}-${channel}-${String(index).padStart(2, '0')}.${ext.toLowerCase()}`;
}

export function assetPath(qid: string, name: string): string {
  return path.join(questionDir(qid), name);
}

export function writeAsset(qid: string, name: string, buf: Buffer): void {
  ensureDir(questionDir(qid));
  fs.writeFileSync(assetPath(qid, name), buf);
}

export function readAsset(qid: string, name: string): Buffer | null {
  const p = assetPath(qid, name);
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p);
}

/** 图片/PDF 可以真删（题目记录本身不可删） */
export function deleteAsset(qid: string, name: string): boolean {
  const safe = path.basename(name);
  if (safe !== name) return false; // 拒绝路径穿越
  const p = assetPath(qid, safe);
  if (!fs.existsSync(p)) return false;
  fs.unlinkSync(p);
  return true;
}

export const ALL_IMAGE_CHANNELS = IMAGE_CHANNELS;

// ============================================================
// 整卷 PDF
// ============================================================

/** PDF 魔数校验：不能只看扩展名 */
export function isPdfBuffer(buf: Buffer): boolean {
  if (!buf || buf.length < 5) return false;
  return buf.subarray(0, 5).toString('latin1') === '%PDF-';
}

export function hasPdf(qid: string, role: PdfRole): boolean {
  return fs.existsSync(pdfPath(qid, role));
}

export function listPdfRoles(qid: string): PdfRole[] {
  const roles: PdfRole[] = [];
  if (hasPdf(qid, 'paper')) roles.push('paper');
  if (hasPdf(qid, 'answer')) roles.push('answer');
  return roles;
}

export function writePdf(qid: string, role: PdfRole, buf: Buffer): void {
  ensureDir(questionDir(qid));
  fs.writeFileSync(pdfPath(qid, role), buf);
}

export function readPdf(qid: string, role: PdfRole): Buffer | null {
  const p = pdfPath(qid, role);
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p);
}

export function pdfByteSize(qid: string, role: PdfRole): number {
  const p = pdfPath(qid, role);
  if (!fs.existsSync(p)) return 0;
  return fs.statSync(p).size;
}
