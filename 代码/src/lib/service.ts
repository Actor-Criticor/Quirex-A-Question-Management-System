/**
 * service.ts — 业务编排层
 *
 * 职责：把 store（文件 IO）、searchIndex（索引）、tags（标签表）串起来，
 * 保证「任何写操作之后索引与标签表都是一致的」。API 路由只调用这一层。
 *
 * 注意：这里**没有**删除题目的函数，而且永远不会加 ——
 * 题目不可删除，只能 status: 停用（方案 §10.6）。图片与 PDF 可以真删。
 */

import fs from 'fs';
import path from 'path';
import {
  type ImageChannel,
  type PdfRole,
  type QuestionKind,
  type QuestionMeta,
  type QuestionStatus,
  type QuestionType,
  type SearchParams,
  type SearchResult,
  type TagItem,
  type TagKind,
  isImageChannel,
  isPdfRole,
  isQuestionType,
  isFigAlign,
  tagValuesOf,
  QUESTION_KINDS,
  BACKUP_LIMIT,
  CUSTOM_TAG_LEN_MAX,
} from './types';
import { META_AUDIT, backupsDir, ensureDir, metaDir, metaFile } from './paths';
import { reserveId, rollbackQid, withQidLock, peekNextId } from './qid';
import * as store from './store';
import {
  listYears as listYearsFromIndex,
  loadIndexOrRebuild,
  rebuildIndex as rebuildIndexFile,
  search as runSearch,
  upsertEntry,
  type YearFacet,
} from './searchIndex';
import * as tags from './tags';
import {
  parseDifficultyField,
  parseNumberField,
  parseYearField,
  normalizeDescription,
  normalizeInnovation,
  normalizeTagList,
  normalizeTagName,
  validateCustomTags,
  validateKnowledgeCount,
} from './validate';
import { buildImageMacro, replaceImageMarkers } from './latexCompose';

// ============================================================
// 错误
// ============================================================

export class ValidationError extends Error {
  field?: string;
  hint?: string;
  constructor(message: string, field?: string, hint?: string) {
    super(message);
    this.name = 'ValidationError';
    this.field = field;
    this.hint = hint;
  }
}

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

// ============================================================
// 审计与备份
// ============================================================

function appendAudit(record: Record<string, unknown>): void {
  try {
    ensureDir(metaDir());
    fs.appendFileSync(
      metaFile(META_AUDIT),
      JSON.stringify({ ts: new Date().toISOString(), ...record }) + '\n',
      'utf-8'
    );
  } catch (e) {
    console.warn(`[audit] 写审计日志失败：${(e as Error).message}`);
  }
}

export interface BackupRecord {
  id: string;
  file: string;
  createdAt: string;
  operation: string;
  affected: Array<{ qid: string; field: string; before: unknown; after?: unknown }>;
}

/**
 * 写一份字段级备份。
 *
 * v4 两处修正：
 *   1. **同秒不再覆盖**：id 以前是 `tags-<秒级时间戳>`，同一秒里做两次操作
 *      （比如连续改名两个标签）会写到同一个文件名上、把前一份覆盖掉。
 *      现在文件已存在就往后加 -2、-3。
 *   2. **写完全立刻裁剪**：只保留最新 BACKUP_LIMIT 条，多余的从磁盘删掉。
 */
function writeBackup(operation: string, affected: BackupRecord['affected']): BackupRecord {
  const now = new Date();
  const stamp = now.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  ensureDir(backupsDir());

  let id = `tags-${stamp}`;
  let file = path.join(backupsDir(), `${id}.json`);
  for (let i = 2; fs.existsSync(file) && i < 1000; i++) {
    id = `tags-${stamp}-${i}`;
    file = path.join(backupsDir(), `${id}.json`);
  }

  const record: BackupRecord = {
    id,
    file,
    createdAt: now.toISOString(),
    operation,
    affected,
  };
  fs.writeFileSync(file, JSON.stringify(record, null, 2) + '\n', 'utf-8');
  pruneBackups();
  return record;
}

/** 只保留最新 BACKUP_LIMIT 条，把更旧的备份文件从磁盘删掉。返回删掉几条。 */
export function pruneBackups(): number {
  const dir = backupsDir();
  if (!fs.existsSync(dir)) return 0;

  const records = listBackups();
  if (records.length <= BACKUP_LIMIT) return 0;

  const doomed = records.slice(BACKUP_LIMIT);
  let removed = 0;
  for (const r of doomed) {
    try {
      fs.unlinkSync(r.file);
      removed++;
    } catch {
      /* 文件已经不在了就算了 */
    }
  }
  return removed;
}

/**
 * 列出字段级备份，最新的在前。
 * v4：读的时候也裁一次 —— 对「历史上已经攒超限」的库生效，
 * 所以老库第一次打开就会自动瘦身到上限。
 */
export function listBackups(): BackupRecord[] {
  const dir = backupsDir();
  if (!fs.existsSync(dir)) return [];
  const records = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')) as BackupRecord;
      } catch {
        return null;
      }
    })
    .filter((b): b is BackupRecord => b !== null)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  if (records.length <= BACKUP_LIMIT) return records;

  // 超限：删掉最旧的，返回剩下的
  for (const r of records.slice(BACKUP_LIMIT)) {
    try {
      fs.unlinkSync(r.file);
    } catch {
      /* 忽略 */
    }
  }
  return records.slice(0, BACKUP_LIMIT);
}

/** 从备份还原：把受影响的题目字段写回 `before` 值 */
export function restoreBackup(id: string): { restored: number } {
  const record = listBackups().find((b) => b.id === id);
  if (!record) throw new NotFoundError(`备份不存在：${id}`);

  let restored = 0;
  for (const item of record.affected) {
    const meta = store.readMeta(item.qid);
    if (!meta) continue;
    // v9：备份里的 `before` 现在**一律是数组**（来源那一维是只含一项的数组）。
    // 这里顺手兼容老备份里的裸字符串，免得以前存下的备份还原不了。
    const list = Array.isArray(item.before)
      ? (item.before as string[]).map((x) => String(x))
      : item.before == null
        ? []
        : [String(item.before)];

    if (item.field === 'source') {
      const one = list.filter(Boolean)[0];
      if (one) meta.source = one;
      else delete meta.source;
    } else if (item.field === 'knowledge') {
      if (list.length) meta.knowledge = list;
      else delete meta.knowledge;
    } else if (item.field === 'custom') {
      // v9：自定义标签也能从备份还原
      if (list.length) meta.custom = list;
      else delete meta.custom;
    } else {
      continue;
    }
    meta.updatedAt = new Date().toISOString();
    store.writeMeta(meta);
    upsertEntry(meta);
    restored++;
  }

  appendAudit({ op: 'restoreBackup', backup: id, restored });
  return { restored };
}

// ============================================================
// 工作区
// ============================================================

export function ensureWorkspace(): void {
  ensureDir(metaDir());
  ensureDir(backupsDir());
}

// ============================================================
// 创建题目（单题 / 整卷 同一入口）
// ============================================================

export interface CreateQuestionInput {
  kind: QuestionKind;
  /** 仅单题 */
  type?: unknown;
  source?: unknown;
  /** 仅单题：只读数字 */
  number?: unknown;
  /** 两种 kind 都有：0.01–0.99 或留空 */
  difficulty?: unknown;
  /** 仅单题 */
  knowledge?: unknown;
  /** v9：仅单题，自定义标签（最多 5 个、每个最长 20 字） */
  custom?: unknown;
  description?: unknown;
  /** v2：创新标记（可选；**仅单题**，整卷会被丢弃） */
  innovation?: unknown;
  /** v3：年份（单题与整卷都有，可留空） */
  year?: unknown;
  /** v5：配图位置（仅单题；不传 = 按题型推导） */
  figAlign?: unknown;
  /** 单题原始 LaTeX（结构化录入的组合在录入页完成；正文里可含 [[img:N]] 占位标记） */
  stem?: string;
  answer?: string;
  figures?: Record<string, string>;
  /** 待入库图片：保存时按 {qid}-{通道}-NN 落盘，并替换正文里的 [[img:N]] */
  pendingImages?: PendingImage[];
  /** 整卷 PDF */
  pdf?: Partial<Record<PdfRole, Buffer>>;
}

export interface PendingImage {
  channel: ImageChannel;
  buf: Buffer;
  ext: string;
  /** true → \fig（示意图，带图号）；false → \includegraphics（内容图） */
  asFigure?: boolean;
  width?: number;
}

export interface CreateQuestionResult {
  qid: string;
  warnings: string[];
}

export function createQuestion(input: CreateQuestionInput): Promise<CreateQuestionResult> {
  const kind: QuestionKind = (QUESTION_KINDS as readonly string[]).includes(String(input.kind))
    ? (input.kind as QuestionKind)
    : '单题';

  const warnings: string[] = [];

  // ---- 校验（在占号之前做完，避免占号后失败）----
  let type: QuestionType | undefined;
  let number: number | undefined;
  let knowledge: string[] = [];
  /** v9：自定义标签（与知识点同构，上限更紧） */
  let custom: string[] = [];

  if (kind === '单题') {
    if (!isQuestionType(input.type)) {
      throw new ValidationError('单题必须选题型（单选/多选/填空/解答）', 'type');
    }
    type = input.type;

    const numParsed = parseNumberField(input.number);
    if (numParsed.error) throw new ValidationError(numParsed.error, 'number', numParsed.hint);
    if (numParsed.value !== null) number = numParsed.value;
    if (numParsed.hint) warnings.push(numParsed.hint);

    if (Array.isArray(input.knowledge)) {
      knowledge = Array.from(
        new Set(input.knowledge.map((k) => normalizeTagName(k)).filter(Boolean))
      );
      // v8：知识点上限 —— 挂太多就分不出层次，也毁掉"按知识点分组"的讲义
      const kErr = validateKnowledgeCount(knowledge);
      if (kErr) throw new ValidationError(kErr, 'knowledge');
    }

    // v9：自定义标签 —— 与知识点同一套写法（可手打、可联想），但两条上限更紧
    custom = normalizeTagList(input.custom);
    const cErr = validateCustomTags(custom);
    if (cErr) throw new ValidationError(cErr, 'custom');
  } else {
    const paper = input.pdf?.paper;
    if (!paper || !store.isPdfBuffer(paper)) {
      throw new ValidationError('整卷必须上传有效的题目 PDF', 'pdf');
    }
  }

  const diffParsed = parseDifficultyField(input.difficulty);
  if (diffParsed.error) throw new ValidationError(diffParsed.error, 'difficulty', diffParsed.hint);
  const difficulty = diffParsed.value ?? undefined;
  if (diffParsed.hint) warnings.push(diffParsed.hint);

  const yearParsed = parseYearField(input.year);
  if (yearParsed.error) throw new ValidationError(yearParsed.error, 'year', yearParsed.hint);
  const year = yearParsed.value ?? undefined;
  if (yearParsed.hint) warnings.push(yearParsed.hint);

  const source = normalizeTagName(input.source) || undefined;
  const description = normalizeDescription(input.description) || undefined;
  // v2：创新标记 —— **只有单题能标**。整卷就算请求里带了也直接丢弃，
  // 防止绕过界面（直接调 API 或手改文件）给整卷打上创新。
  const innovation = kind === '单题' && normalizeInnovation(input.innovation);

  // v5：配图位置 —— 只有单题能设（整卷没有示意图概念）
  const figAlign = kind === '单题' && isFigAlign(input.figAlign) ? input.figAlign : undefined;

  // ---- 占号 → 写文件 → 推进计数器（整段串行）----
  // 单题与试卷各用一套号（0001… / P001…）
  return withQidLock(() => {
    const { id: qid } = reserveId(kind);
    try {
      const now = new Date().toISOString();
      const meta: QuestionMeta = {
        qid,
        kind,
        status: '启用',
        createdAt: now,
        updatedAt: now,
      };
      if (kind === '单题') {
        meta.type = type;
        if (number !== undefined) meta.number = number;
        if (knowledge.length) meta.knowledge = knowledge;
        if (custom.length) meta.custom = custom;
      }
      if (source) meta.source = source;
      if (difficulty !== undefined) meta.difficulty = difficulty;
      if (year !== undefined) meta.year = year;
      if (figAlign) meta.figAlign = figAlign;
      if (innovation) meta.innovation = true;
      if (description) meta.description = description;
      if (input.figures && Object.keys(input.figures).length) meta.figures = input.figures;

      store.writeMeta(meta);

      if (kind === '单题') {
        // 待入库图片：先按 {qid}-{通道}-NN 落盘（名字带 qid → 全库唯一），
        // 再把正文里的 [[img:N]] 占位标记换成真正的 LaTeX 宏。
        let stem = input.stem ?? '';
        let answer = input.answer ?? '';
        const pending = input.pendingImages ?? [];

        if (pending.length) {
          const counters: Record<ImageChannel, number> = { stem: 0, fig: 0, ans: 0, ansfig: 0 };
          const macros: string[] = [];

          for (const img of pending) {
            if (!isImageChannel(img.channel)) {
              throw new ValidationError(`图片通道无效：${String(img.channel)}`, 'channel');
            }
            if (!img.buf || img.buf.length === 0) {
              throw new ValidationError('有一张图片是空的', 'file');
            }
            counters[img.channel] += 1;
            const name = store.buildAssetName(qid, img.channel, counters[img.channel], img.ext);
            store.writeAsset(qid, name, img.buf);
            macros.push(buildImageMacro(name, img.asFigure !== false, img.width ?? 0.4));
          }

          stem = replaceImageMarkers(stem, macros);
          answer = replaceImageMarkers(answer, macros);
        }

        store.writeContent(qid, 'stem', stem);
        store.writeContent(qid, 'answer', answer);
      } else if (input.pdf) {
        for (const role of ['paper', 'answer'] as PdfRole[]) {
          const buf = input.pdf[role];
          if (!buf) continue;
          if (!store.isPdfBuffer(buf)) {
            throw new ValidationError(`${role === 'paper' ? '题目' : '答案'} PDF 不是有效文件`, 'pdf');
          }
          store.writePdf(qid, role, buf);
        }
      }

      upsertEntry(meta);
      appendAudit({ op: 'create', qid, kind, source, number, difficulty });
      return { qid, warnings };
    } catch (e) {
      // 建文件失败 → 回滚占号，保证顺序号不断裂
      rollbackQid(qid);
      throw e;
    }
  });
}

// ============================================================
// 读取
// ============================================================

export interface QuestionFull {
  meta: QuestionMeta;
  stem: string;
  answer: string;
  assets: store.AssetInfo[];
  pdfs: Array<{ role: PdfRole; bytes: number }>;
}

export function getQuestion(qid: string): QuestionFull {
  const meta = store.readMeta(qid);
  if (!meta) throw new NotFoundError(`题目不存在：${qid}`);
  return {
    meta,
    stem: meta.kind === '单题' ? store.readContent(qid, 'stem') : '',
    answer: meta.kind === '单题' ? store.readContent(qid, 'answer') : '',
    assets: store.listAssets(qid),
    pdfs: store.listPdfRoles(qid).map((role) => ({ role, bytes: store.pdfByteSize(qid, role) })),
  };
}

export function getMeta(qid: string): QuestionMeta | null {
  return store.readMeta(qid);
}

export function listAllMetas(): QuestionMeta[] {
  return loadIndexOrRebuild()
    .map((e) => store.readMeta(e.qid))
    .filter((m): m is QuestionMeta => m !== null);
}

// ============================================================
// 修改
// ============================================================

export interface UpdateQuestionPatch {
  type?: unknown;
  source?: unknown;
  number?: unknown;
  difficulty?: unknown;
  knowledge?: unknown;
  /** v9：自定义标签（仅单题） */
  custom?: unknown;
  description?: unknown;
  status?: unknown;
  /** v2：创新标记（仅单题；整卷会被忽略） */
  innovation?: unknown;
  /** v3：年份 */
  year?: unknown;
  /** v5：配图位置（仅单题；传空串 = 回到"按题型推导"） */
  figAlign?: unknown;
  figures?: Record<string, string> | null;
}

export interface UpdateQuestionResult {
  meta: QuestionMeta;
  warnings: string[];
}

export function updateQuestion(qid: string, patch: UpdateQuestionPatch): UpdateQuestionResult {
  const meta = store.readMeta(qid);
  if (!meta) throw new NotFoundError(`题目不存在：${qid}`);

  const warnings: string[] = [];
  // 整卷没有题型/题号/知识点，即便传了也忽略，保持字段矩阵干净
  const isSingle = meta.kind === '单题';

  if (patch.type !== undefined) {
    if (!isSingle) {
      // 忽略
    } else {
      if (!isQuestionType(patch.type)) throw new ValidationError('题型无效', 'type');
      meta.type = patch.type;
    }
  }

  if (patch.source !== undefined) {
    const s = normalizeTagName(patch.source);
    if (s) meta.source = s;
    else delete meta.source;
  }

  if (patch.number !== undefined && isSingle) {
    const parsed = parseNumberField(patch.number);
    if (parsed.error) throw new ValidationError(parsed.error, 'number', parsed.hint);
    if (parsed.hint) warnings.push(parsed.hint);
    if (parsed.value === null) delete meta.number;
    else meta.number = parsed.value;
  }

  if (patch.difficulty !== undefined) {
    const parsed = parseDifficultyField(patch.difficulty);
    if (parsed.error) throw new ValidationError(parsed.error, 'difficulty', parsed.hint);
    if (parsed.hint) warnings.push(parsed.hint);
    if (parsed.value === null) delete meta.difficulty;
    else meta.difficulty = parsed.value;
  }

  if (patch.knowledge !== undefined && isSingle) {
    const list = Array.isArray(patch.knowledge) ? patch.knowledge : [];
    const clean = Array.from(new Set(list.map((k) => normalizeTagName(k)).filter(Boolean)));
    // v8：上限与创建时同一口径（PATCH 也是写入路径，不能只在一边拦）
    const kErr = validateKnowledgeCount(clean);
    if (kErr) throw new ValidationError(kErr, 'knowledge');
    if (clean.length) meta.knowledge = clean;
    else delete meta.knowledge;
  }

  // v9：自定义标签 —— 同样在 PATCH 这一侧拦上限与长度（和 create 一个口径）
  if (patch.custom !== undefined && isSingle) {
    const clean = normalizeTagList(patch.custom);
    const cErr = validateCustomTags(clean);
    if (cErr) throw new ValidationError(cErr, 'custom');
    if (clean.length) meta.custom = clean;
    else delete meta.custom;
  }

  if (patch.description !== undefined) {
    const d = normalizeDescription(patch.description);
    if (d) meta.description = d;
    else delete meta.description;
  }

  // v2：创新标记 —— 只有单题能标；整卷传了也忽略（与 create 的口径一致）
  if (patch.innovation !== undefined && isSingle) {
    if (normalizeInnovation(patch.innovation)) meta.innovation = true;
    else delete meta.innovation;
  }

  // v3：年份（两种 kind 都能改；留空 = 清掉）
  if (patch.year !== undefined) {
    const parsed = parseYearField(patch.year);
    if (parsed.error) throw new ValidationError(parsed.error, 'year', parsed.hint);
    if (parsed.value === null) delete meta.year;
    else meta.year = parsed.value;
    if (parsed.hint) warnings.push(parsed.hint);
  }

  if (patch.status !== undefined) {
    const s = String(patch.status);
    if (s !== '启用' && s !== '停用') throw new ValidationError('状态只能是启用或停用', 'status');
    meta.status = s as QuestionStatus;
  }

  if (patch.figures !== undefined) {
    if (patch.figures === null) delete meta.figures;
    else meta.figures = patch.figures;
  }

  // v5：配图位置（仅单题；空串/非法值 = 清掉，回到"按题型推导"）
  if (patch.figAlign !== undefined && isSingle) {
    if (isFigAlign(patch.figAlign)) meta.figAlign = patch.figAlign;
    else delete meta.figAlign;
  }

  meta.updatedAt = new Date().toISOString();
  store.writeMeta(meta);
  upsertEntry(meta);
  appendAudit({ op: 'update', qid, fields: Object.keys(patch) });

  return { meta, warnings };
}

export function setStatus(qid: string, status: QuestionStatus): QuestionMeta {
  return updateQuestion(qid, { status }).meta;
}

/** 改写题干/答案（仅单题），并刷新索引里的 searchText */
export function writeContent(qid: string, part: 'stem' | 'answer', text: string): QuestionMeta {
  const meta = store.readMeta(qid);
  if (!meta) throw new NotFoundError(`题目不存在：${qid}`);
  if (meta.kind !== '单题') throw new ValidationError('整卷没有题干/答案文本', 'kind');

  store.writeContent(qid, part, text);
  meta.updatedAt = new Date().toISOString();
  store.writeMeta(meta);
  upsertEntry(meta);
  appendAudit({ op: 'writeContent', qid, part, length: text.length });
  return meta;
}

// ============================================================
// 图片资产
// ============================================================

export interface AddImageResult {
  name: string;
  channel: ImageChannel;
}

export function addImage(
  qid: string,
  channel: unknown,
  buf: Buffer,
  ext = 'png'
): AddImageResult {
  const meta = store.readMeta(qid);
  if (!meta) throw new NotFoundError(`题目不存在：${qid}`);
  if (meta.kind !== '单题') throw new ValidationError('整卷不支持图片通道', 'kind');
  if (!isImageChannel(channel)) throw new ValidationError('图片通道无效', 'channel');
  if (!buf || buf.length === 0) throw new ValidationError('图片内容为空', 'file');

  const index = store.nextAssetIndex(qid, channel);
  const name = store.buildAssetName(qid, channel, index, ext);
  store.writeAsset(qid, name, buf);
  upsertEntry(meta);
  appendAudit({ op: 'addImage', qid, channel, name, bytes: buf.length });
  return { name, channel };
}

export function deleteAsset(qid: string, name: string): boolean {
  const meta = store.readMeta(qid);
  if (!meta) throw new NotFoundError(`题目不存在：${qid}`);
  const ok = store.deleteAsset(qid, name);
  if (ok) upsertEntry(meta);
  appendAudit({ op: 'deleteAsset', qid, name, ok });
  return ok;
}

export function savePdf(qid: string, role: unknown, buf: Buffer): PdfRole {
  const meta = store.readMeta(qid);
  if (!meta) throw new NotFoundError(`题目不存在：${qid}`);
  if (meta.kind !== '整卷') throw new ValidationError('只有整卷可以上传 PDF', 'kind');
  if (!isPdfRole(role)) throw new ValidationError('PDF 角色无效', 'role');
  if (!store.isPdfBuffer(buf)) throw new ValidationError('不是有效的 PDF 文件', 'file');

  store.writePdf(qid, role, buf);
  meta.updatedAt = new Date().toISOString();
  store.writeMeta(meta);
  upsertEntry(meta);
  appendAudit({ op: 'savePdf', qid, role, bytes: buf.length });
  return role;
}

// ============================================================
// 检索 / 索引
// ============================================================

/**
 * 检索。
 * withContent=true 时把这一页的题干/答案一并带回 —— 浏览页的卡片要直接渲染题目，
 * 这样只需一次请求，而不是每道题再打一次详情接口。
 */
export function searchQuestions(params: SearchParams, withContent = false): SearchResult {
  return runSearch(params, withContent);
}

export function rebuildIndex() {
  return rebuildIndexFile();
}

/** 下一个 id 预览（按类型：单题给 0001…，试卷给 P001…） */
export function nextIdPreview(kind: QuestionKind = '单题'): string {
  return peekNextId(kind);
}

/** 兼容 v1 的调用名 */
export function nextQidPreview(): string {
  return peekNextId('单题');
}

// ============================================================
// 标签操作
// ============================================================

export function listTags(includeRetired = false): Record<TagKind, TagItem[]> {
  return tags.deriveVocab(loadIndexOrRebuild(), includeRetired);
}

/** v3：年份 facet（浏览页的一排年份 chip；不进标签管理页） */
export function listYears(): YearFacet[] {
  return listYearsFromIndex(loadIndexOrRebuild());
}

export function addTag(kind: TagKind, name: string) {
  // v9：手工登记一个自定义标签也要守长度上限 —— 否则标签管理页就成了绕过录入限制的后门
  if (kind === 'custom') {
    const err = validateCustomTags([name]);
    if (err) throw new ValidationError(err, 'name');
  }
  tags.addManualTag(kind, name);
  appendAudit({ op: 'addTag', kind, name });
}

export function retireTag(kind: TagKind, name: string) {
  const store0 = tags.readTagStore();
  const wasRetired = store0.retired[kind].includes(normalizeTagName(name));
  tags.retireTag(kind, name);
  appendAudit({ op: 'retireTag', kind, name, alreadyRetired: wasRetired });
}

export function restoreTag(kind: TagKind, name: string) {
  tags.restoreTag(kind, name);
  appendAudit({ op: 'restoreTag', kind, name });
}

export interface RenamePreview {
  kind: TagKind;
  from: string;
  to: string;
  /** 会受影响的题目 */
  affected: Array<{ qid: string; before: string | string[] }>;
  /** 目标名当前是否已被使用（撞名 = 合并） */
  merging: boolean;
  targetCount: number;
}

/** 改名/合并前的影响预览（dry-run，不写盘） */
export function previewRename(kind: TagKind, from: string, to: string): RenamePreview {
  const cleanFrom = normalizeTagName(from);
  const cleanTo = normalizeTagName(to);
  if (!cleanTo) throw new ValidationError('新标签名不能为空', 'to');
  if (cleanFrom === cleanTo) throw new ValidationError('新旧标签名相同', 'to');
  // v9：自定义标签有长度上限，改名是**另一个写入入口** —— 不在入口拦的话，
  // 就能靠"改个超长的名"绕过录入时的 20 字限制。
  if (kind === 'custom' && cleanTo.length > CUSTOM_TAG_LEN_MAX) {
    throw new ValidationError(
      `自定义标签最长 ${CUSTOM_TAG_LEN_MAX} 个字（新名有 ${cleanTo.length} 个字）`,
      'to'
    );
  }

  const entries = loadIndexOrRebuild();
  const affected: RenamePreview['affected'] = [];
  let targetCount = 0;

  for (const e of entries) {
    const own = tagValuesOf(e, kind);
    if (own.includes(cleanTo)) targetCount++;
    // ★ 备份里存的就是 `own` 本身（数组）。v9 的第一版写成 `e.source ?? own`，
    //   本意是"来源那一维存单值" —— 结果**知识点/自定义的备份里也塞了来源名**，
    //   等到"从备份还原"时 `Array.isArray('25全国1')` 为假 → 直接 delete 掉知识点，
    //   题目上的知识点就这么没了（selftest 的"还原为原名"当场抓到）。
    //   教训：备份里存什么，必须和 restoreBackup 读什么**完全对齐**。
    if (own.includes(cleanFrom)) affected.push({ qid: e.qid, before: own });
  }

  return {
    kind,
    from: cleanFrom,
    to: cleanTo,
    affected,
    merging: targetCount > 0,
    targetCount,
  };
}

/**
 * 改名（撞名即合并）。这个操作要真的改题目文件，所以带备份 + 审计。
 * 千级规模（≤2000 文件）约 1–3 秒。
 */
export function renameTag(
  kind: TagKind,
  from: string,
  to: string
): { changed: number; backupId: string } {
  const preview = previewRename(kind, from, to);

  const backup = writeBackup(
    `renameTag:${kind}:${preview.from}->${preview.to}`,
    preview.affected.map((a) => ({ qid: a.qid, field: kind, before: a.before }))
  );

  let changed = 0;
  for (const item of preview.affected) {
    const meta = store.readMeta(item.qid);
    if (!meta) continue;

    if (kind === 'source') {
      meta.source = preview.to;
    } else {
      const list = tagValuesOf(meta, kind).map((k) => (k === preview.from ? preview.to : k));
      const clean = Array.from(new Set(list));
      if (kind === 'knowledge') meta.knowledge = clean;
      else meta.custom = clean;
    }
    meta.updatedAt = new Date().toISOString();
    store.writeMeta(meta);
    upsertEntry(meta);
    changed++;
  }

  // 叠加层里的名字也跟着走（manual / retired）
  const ts = tags.readTagStore();
  ts.manual[kind] = ts.manual[kind].map((n) => (n === preview.from ? preview.to : n));
  ts.retired[kind] = ts.retired[kind].map((n) => (n === preview.from ? preview.to : n));
  ts.manual[kind] = Array.from(new Set(ts.manual[kind]));
  ts.retired[kind] = Array.from(new Set(ts.retired[kind]));
  tags.writeTagStore(ts);

  appendAudit({
    op: 'renameTag',
    kind,
    from: preview.from,
    to: preview.to,
    changed,
    merged: preview.merging,
    backup: backup.id,
  });

  return { changed, backupId: backup.id };
}

/** 彻底清除的影响预览 */
export function previewPurge(kind: TagKind, name: string) {
  const clean = normalizeTagName(name);
  const entries = loadIndexOrRebuild();
  const affected: Array<{ qid: string; before: string | string[] }> = [];

  for (const e of entries) {
    const own = tagValuesOf(e, kind);
    if (own.includes(clean)) affected.push({ qid: e.qid, before: own });
  }
  return { kind, name: clean, affected };
}

/**
 * 彻底清除：把标签从所有题目上摘掉（不可逆，带备份 + 审计）。
 * 这是「停用」之外的逃生口，用于标签名打错、留着是噪音的情况。
 */
export function purgeTag(kind: TagKind, name: string): { changed: number; backupId: string } {
  const preview = previewPurge(kind, name);

  const backup = writeBackup(
    `purgeTag:${kind}:${preview.name}`,
    preview.affected.map((a) => ({ qid: a.qid, field: kind, before: a.before }))
  );

  let changed = 0;
  for (const item of preview.affected) {
    const meta = store.readMeta(item.qid);
    if (!meta) continue;

    if (kind === 'source') {
      delete meta.source;
    } else {
      const list = tagValuesOf(meta, kind).filter((k) => k !== preview.name);
      if (list.length) {
        if (kind === 'knowledge') meta.knowledge = list;
        else meta.custom = list;
      } else if (kind === 'knowledge') {
        delete meta.knowledge;
      } else {
        delete meta.custom;
      }
    }
    meta.updatedAt = new Date().toISOString();
    store.writeMeta(meta);
    upsertEntry(meta);
    changed++;
  }

  tags.purgeTagFromStore(kind, preview.name);
  appendAudit({ op: 'purgeTag', kind, name: preview.name, changed, backup: backup.id });

  return { changed, backupId: backup.id };
}
