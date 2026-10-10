/**
 * qid.ts — id 顺序分配（v2：单题与试卷各自一套号）
 *
 * 规则：
 *   - 单题：4 位零填充字符串 "0001"→"9999"，从 0001 起严格递增
 *   - 试卷：P + 3 位零填充 "P001"→"P999"，从 P001 起严格递增
 *   - 两套号**互不影响**，各自有计数器
 *   - 不提供删除；一旦分配永不变，顺序不断裂
 *   - 不允许手动指定
 *   - 当字符串处理，不把位数焊死（超过 9999 自然变长）
 *
 * 并发安全：单进程内用一条 Promise 链串行化「取号 + 建文件」，
 * 取号成功但建文件失败时不推进计数器，所以不会留下空洞。
 */

import fs from 'fs';
import {
  META_COUNTER,
  ensureDir,
  listQidFolders,
  metaDir,
  metaFile,
  numberToQid,
  qidToNumber,
  questionDir,
  paperNumberToId,
  paperIdToNumber,
  isPaperId,
  isQuestionId,
} from './paths';
import type { QuestionKind } from './types';

interface CounterShape {
  /** 单题下一个号 */
  question: number;
  /** 试卷下一个号 */
  paper: number;
}

function counterPath(): string {
  return metaFile(META_COUNTER);
}

function readCounter(): CounterShape {
  try {
    const f = counterPath();
    if (fs.existsSync(f)) {
      const raw = JSON.parse(fs.readFileSync(f, 'utf-8'));
      // 兼容 v1 的单计数器格式 { next: n }：把它当单题计数器继承过来
      const legacy = Number(raw?.next);
      const q = Number(raw?.question);
      const p = Number(raw?.paper);
      return {
        question: Number.isFinite(q) && q >= 1 ? Math.floor(q) : Number.isFinite(legacy) && legacy >= 1 ? Math.floor(legacy) : 1,
        paper: Number.isFinite(p) && p >= 1 ? Math.floor(p) : 1,
      };
    }
  } catch {
    // 计数器损坏则按目录重建（下面 nextAvailable* 会兜住）
  }
  return { question: 1, paper: 1 };
}

function writeCounter(counter: CounterShape): void {
  ensureDir(metaDir());
  fs.writeFileSync(counterPath(), JSON.stringify(counter, null, 2) + '\n', 'utf-8');
}

/** 库里已有的最大号（按 id 前缀分别统计） */
function maxExisting(kind: QuestionKind): number {
  const ids = listQidFolders().filter((id) =>
    kind === '整卷' ? isPaperId(id) : isQuestionId(id)
  );
  if (!ids.length) return 0;
  const nums = ids.map((id) => (kind === '整卷' ? paperIdToNumber(id) : qidToNumber(id)));
  return Math.max(...nums);
}

/**
 * 下一个可用号 = max(计数器, 库中最大号 + 1)
 * 双保险：即使 counter.json 丢了或被手改小，也不会撞上已有目录。
 */
export function nextAvailableNumber(kind: QuestionKind = '单题'): number {
  const counter = readCounter();
  const fromCounter = kind === '整卷' ? counter.paper : counter.question;
  return Math.max(fromCounter, maxExisting(kind) + 1);
}

/** 预览下一个 id（按类型） */
export function peekNextId(kind: QuestionKind = '单题'): string {
  const n = nextAvailableNumber(kind);
  return kind === '整卷' ? paperNumberToId(n) : numberToQid(n);
}

/** 兼容 v1 的调用名 */
export function peekNextQid(): string {
  return peekNextId('单题');
}

// ============================================================
// 串行化
// ============================================================

let chain: Promise<unknown> = Promise.resolve();

/**
 * 把「取号 → 建文件 → 推进计数器」整段放进临界区。
 * 因为整段串行，任何一步抛错都不会推进计数器，也就不会留下断号。
 */
export function withQidLock<T>(fn: () => T | Promise<T>): Promise<T> {
  const run = async () => fn();
  const p = chain.then(run, run);
  chain = p.then(
    () => undefined,
    () => undefined
  );
  return p as Promise<T>;
}

/**
 * 在临界区内占号：创建空目录作为占位，并推进对应计数器。
 * 调用方负责在此之后写入文件；若写入失败应调用 rollbackQid。
 */
export function reserveId(kind: QuestionKind = '单题'): { id: string; number: number } {
  const number = nextAvailableNumber(kind);
  const id = kind === '整卷' ? paperNumberToId(number) : numberToQid(number);
  ensureDir(questionDir(id));

  const counter = readCounter();
  if (kind === '整卷') counter.paper = number + 1;
  else counter.question = number + 1;
  writeCounter(counter);

  return { id, number };
}

/** 兼容 v1 的调用名 */
export function reserveQid(): { qid: string; number: number } {
  const { id, number } = reserveId('单题');
  return { qid: id, number };
}

/**
 * 回滚一个刚占的号：删掉空目录，并把计数器退回。
 * 只在 withQidLock 临界区内调用才安全。
 */
export function rollbackQid(id: string): void {
  const dir = questionDir(id);
  try {
    if (fs.existsSync(dir)) {
      const rest = fs.readdirSync(dir);
      if (rest.length === 0) fs.rmdirSync(dir);
    }
  } catch {
    // 目录删不掉就留着，不影响正确性（只会多一个空目录）
  }

  const isPaper = isPaperId(id);
  const n = isPaper ? paperIdToNumber(id) : qidToNumber(id);
  const counter = readCounter();
  if (isPaper) {
    if (counter.paper > n) {
      counter.paper = n;
      writeCounter(counter);
    }
  } else if (counter.question > n) {
    counter.question = n;
    writeCounter(counter);
  }
}
