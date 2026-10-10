/**
 * paths.ts — 题库路径解析
 *
 * 重要：全部用函数而不是模块级常量。
 * v0 在模块加载时就固化 VAULT_PATH，导致测试无法切换题库；这里改为每次调用时读 env。
 *
 * v9：题库路径变成**跟着学科走**的 —— `bankPath()` 取当前学科的题库目录
 * （见 subjects.ts）：每个学科都是「题库位置」下的一个子目录，叫学科名
 * （`题库/数学`、`题库/化学`）。
 */

import fs from 'fs';
import path from 'path';
import { QID_PAD, PAPER_PAD, QUESTION_PREFIX } from './types';
import { resolvePathValue } from './config';
import { currentBankPath, currentSubjectId } from './subjects';

/**
 * 「题库位置」—— **所有学科的总位置**（v9 起这个说法才准确）。
 * v6：走配置层 —— config.json > 环境变量 VAULT_PATH > 默认 ../题库（仓库根下的「题库」）
 */
export function vaultPath(): string {
  return resolvePathValue('vaultPath');
}

/**
 * 当前学科的题库根目录 = `<题库位置>/<学科目录名>`（`题库/数学`、`题库/化学`）。
 *
 * turbopackIgnore：题库位置由用户的环境变量在运行期决定，
 * 静态文件追踪（NFT）对它没有意义；不加这个标记时打包器会把整个项目
 * 纳入 trace 并给出 "whole project was traced" 警告（本项目是本地工具，无 serverless 需求）。
 */
export function bankPath(): string {
  return currentBankPath();
}

/** 系统数据目录：<题库位置>/<学科目录>/_meta */
export function metaDir(): string {
  return path.join(bankPath(), '_meta');
}

export const META_INDEX = 'index.json';
export const META_TAGS = 'tags.json';
export const META_BASKETS = 'baskets.json';
export const META_COUNTER = 'counter.json';
export const META_AUDIT = 'audit.log';

export function metaFile(name: string): string {
  return path.join(metaDir(), name);
}

export function backupsDir(): string {
  return path.join(metaDir(), 'backups');
}

// ============================================================
// 单题文件夹内的固定文件名
// ============================================================

/** 一题一文件夹，文件夹名 = qid */
export function questionDir(qid: string): string {
  return path.join(bankPath(), qid);
}

/** 元数据：<qid>/<qid>.md */
export function metaMdPath(qid: string): string {
  return path.join(questionDir(qid), `${qid}.md`);
}

/** 题干真源（LaTeX） */
export function stemTexPath(qid: string): string {
  return path.join(questionDir(qid), '题干.tex');
}

/** 答案真源（LaTeX，原「解析」已合并） */
export function answerTexPath(qid: string): string {
  return path.join(questionDir(qid), '答案.tex');
}

/** 整卷 PDF：题目.pdf / 答案.pdf */
export function pdfPath(qid: string, role: 'paper' | 'answer'): string {
  return path.join(questionDir(qid), role === 'paper' ? '题目.pdf' : '答案.pdf');
}

// ============================================================
// 导出目录
// ============================================================

/**
 * 导出根目录。
 * v6：走配置层 —— config.json > 环境变量 EXPORT_DIR > 默认 ../导出（仓库根下的「导出」）
 */
export function exportRootDir(): string {
  return resolvePathValue('exportDir');
}

// ============================================================
// 工具
// ============================================================

export function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/**
 * 判断一个名字是否是合法的单题 id。
 *
 * v4：单题 id 前缀改成 `T`（形如 `T0001`），与整卷的 `P001` 对齐成
 * 「一个大写字母 + 数字」。但**旧的纯数字 id 仍然认** —— 宽松读、严格写：
 * 读的时候两种都接受（老库能照常打开、不会静默丢数据），
 * 写的时候一律 `T####`（见 numberToQid）。
 *
 * v9：前面还可以有一个**学科字母**（`AT0001`）。读取时 A–Z 都认
 * （手改过注册表、字母超范围也不至于读不出来），写入时只用 A–E。
 */
export function isQuestionId(name: string): boolean {
  return (
    new RegExp(`^[A-Z]?${QUESTION_PREFIX}\\d{${QID_PAD},}$`).test(name) ||
    isLegacyQuestionId(name)
  );
}

/** v4：v3 及以前的纯数字单题 id（只读兼容，不再新写） */
export function isLegacyQuestionId(name: string): boolean {
  return new RegExp(`^\\d{${QID_PAD},}$`).test(name);
}

/** 判断一个名字是否是合法的试卷 id（可带学科字母 + P + 至少 PAPER_PAD 位数字） */
export function isPaperId(name: string): boolean {
  return new RegExp(`^[A-Z]?P\\d{${PAPER_PAD},}$`).test(name);
}

/** 单题 id 或试卷 id 都算合法的题目目录 */
export function isQidName(name: string): boolean {
  return isQuestionId(name) || isPaperId(name);
}

/**
 * v9：拆 qid / 显示用的 qid —— 实现放在 types.ts（纯函数，客户端也能引），
 * 这里按服务端的老习惯再转出一次。
 */
export { parseQid, displayQid, subjectLetterOf } from './types';

/** 号 → 单题 id：`T` + 4 位（v4 起）；v9 起前面还可带当前学科的字母 */
export function numberToQid(n: number, subjectId?: string): string {
  const letter = subjectId === undefined ? currentSubjectId() : subjectId;
  return `${letter}${QUESTION_PREFIX}${String(n).padStart(QID_PAD, '0')}`;
}

/** 单题 id → 号：`AT0001`、`T0001` 与更老的 `0001` 都能解析 */
export function qidToNumber(qid: string): number {
  return parseInt(qid.replace(/^[A-Z]?T/i, ''), 10);
}

/** 试卷 id：可带学科字母 + P + PAPER_PAD 位数字 */
export function paperNumberToId(n: number, subjectId?: string): string {
  const letter = subjectId === undefined ? currentSubjectId() : subjectId;
  return `${letter}P${String(n).padStart(PAPER_PAD, '0')}`;
}

export function paperIdToNumber(id: string): number {
  return parseInt(id.replace(/^[A-Z]?P/i, ''), 10);
}

/**
 * 列出题库里所有题目目录（单题 + 试卷）。
 * 排序：单题在前（按号升序），试卷在后（按号升序）。
 * 前端两个页签各自筛选，所以这里的顺序只影响全量遍历（索引重建等）。
 */
export function listQidFolders(): string[] {
  const bank = bankPath();
  if (!fs.existsSync(bank)) return [];
  const names = fs
    .readdirSync(bank, { withFileTypes: true })
    .filter((e) => e.isDirectory() && isQidName(e.name))
    .map((e) => e.name);

  const questions = names.filter(isQuestionId).sort((a, b) => qidToNumber(a) - qidToNumber(b));
  const papers = names.filter(isPaperId).sort((a, b) => paperIdToNumber(a) - paperIdToNumber(b));
  return [...questions, ...papers];
}

/** 只列某一类的目录（按号升序） */
export function listFoldersByKind(kind: '单题' | '整卷'): string[] {
  const ks = listQidFolders();
  return kind === '整卷' ? ks.filter(isPaperId) : ks.filter(isQuestionId);
}

/**
 * v9：把 URL / 界面上的 qid 解析成**当前学科里真实存在的目录名**。
 *
 * 为什么需要它：界面上、地址栏里习惯写的是 `T0001`（不带学科字母），
 * 而磁盘上的目录从 v9 起叫 `AT0001`。如果只认目录名，
 * 那么
 *   · v8 以前的收藏夹 / 历史记录（`/question/T0001`）
 *   · 任何手打的 `/question/T0001`
 * 都会直接 404 —— 而"字母只为了让系统分得清"本来就不该影响用户怎么访问。
 *
 * 规则：**先用原样找**（老库的目录就叫 `T0001`，一步命中），
 * 找不到再按当前学科的字母补一次（`T0001` → `AT0001`）。
 * 带字母的、以及纯数字的老 id 都只在第一步处理 —— 不做多余的猜测。
 */
export function resolveQid(qid: string): string {
  if (!qid) return qid;
  if (fs.existsSync(questionDir(qid))) return qid;
  // 已经带**学科字母**了就直接返回（它就是不存在）。
  // ★ 判据必须是"字母 + T/P + 数字"两段，不能只判 `^[A-Z]` ——
  //   `T0001` 的第一个字符也是大写字母，只判一位的话它会被当成"已带字母"，
  //   兼容就整个失效了（自测里当场抓到）。
  if (/^[A-Z][TP]\d/.test(qid)) return qid;
  const letter = currentSubjectId();
  const alt = `${letter}${qid}`;
  if (fs.existsSync(questionDir(alt))) return alt;
  // 更老的形式：纯数字 0001 → AT0001
  const m = qid.match(/^(\d{3,})$/);
  if (m) {
    const alt2 = `${letter}${QUESTION_PREFIX}${m[1]}`;
    if (fs.existsSync(questionDir(alt2))) return alt2;
  }
  return qid;
}
