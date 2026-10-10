/**
 * subjects.ts — 多学科（v9）
 *
 * ## 为什么这么做
 *
 * 你说「我们可能会有多个学科……只在 qid 上区分就可以，相当于读取多个不同的题库」。
 * 落到磁盘上，最省事、也最不容易出错的办法是：**每个学科就是一套独立的题库目录**
 * ——`_meta/`（索引、标签表、试题篮、计数器）本来就在 `题库/` 里面，
 * 所以"切学科自动切标签、切试题篮、切编号"**不需要写任何额外代码**，
 * 它是这个结构自然得到的结果。
 *
 * ## 注册表
 *
 * `<题库位置>/_subjects.json`：
 *
 * ```json
 * {
 *   "version": 1,
 *   "active": "A",
 *   "subjects": [
 *     { "id": "A", "name": "数学", "dir": "" },      // ← 空串 = 用默认目录名「数学」
 *     { "id": "B", "name": "化学", "dir": "化学" }   // ← 新建的学科各占一个子目录
 *   ]
 * }
 * ```
 *
 * **每个学科就是「题库位置」下的一个子目录**，都叫学科名（`题库/数学`、`题库/化学`）。
 *
 * 为什么 A 的 `dir` 是空串：它是"用默认目录名"的意思 —— 这样**改学科名不用搬题库**
 * （名字随便改，目录从建的时候定下来就不动）。新建的学科把名字直接写进 `dir`。
 *
 * - `id`：学科字母 `A`..`E`，**写进 qid，永不改**；最多 5 个
 * - `name`：界面上的名字（≤5 字），可改；**改它不动目录**
 * - `dir`：建的时候定下来就不动了 —— 否则改名要搬整个题库
 * - `active`：当前学科
 *
 * ## 请求内的"当前学科"
 *
 * 绝大部分读写都发生在**当前学科**里，所以 `paths.bankPath()` 默认就用 active。
 * 唯一需要"临时录到别的学科"的是录入页（你可以先选学科再录），
 * 那种情况用 `withSubject(id, fn)` 包一层 —— 用 AsyncLocalStorage 而不是
 * 一个模块级变量：模块级变量在两个并发请求之间会互相踩（A 请求刚设好、
 * B 请求就把它改了），AsyncLocalStorage 天然是"跟着这次调用走"的。
 */

import fs from 'fs';
import path from 'path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { resolvePathValue } from './config';

/** 注册表文件名（放在「题库位置」下，不在任何学科的题库里） */
export const SUBJECTS_FILE = '_subjects.json';

/** 最多几个学科 */
export const MAX_SUBJECTS = 5;

/** 学科名字最长几个字 */
export const SUBJECT_NAME_MAX = 5;

/** 学科字母，按顺序分配 */
export const SUBJECT_IDS = ['A', 'B', 'C', 'D', 'E'] as const;

/**
 * 默认学科（A）的题库目录名。
 *
 * v11：每个学科的题库目录都是「题库位置」下的**一个子目录，直接叫学科名** ——
 *   · 默认学科（A，数学）：`<题库位置>/数学`
 *   · 新建的学科（化学）  ：`<题库位置>/化学`
 * 以前默认学科那一层叫「题库」，于是路径是 `题库/题库/AT0001.md`，看着像白套了一层，
 * 所以改成学科名。两者本来就是同一层（v10 拉平的）。
 *
 * 老库兼容：v10 及以前建的库里那层叫「题库」，磁盘上还在的话照读 ——
 * 见 `subjectDirOf()`，只是**不再往那儿新建**。
 */
export const DEFAULT_SUBJECT_DIR = '数学';

/** 老库里默认学科那一层的名字 —— 只用于"读得到"，不用于新建 */
export const LEGACY_DEFAULT_SUBJECT_DIRS = ['题库'];

/**
 * 这些目录名不能被学科占用（它们就住在「题库位置」下，与各学科的题库同级）：
 *   · `题库`   —— 老库里默认学科那一层；留着免得新学科把它占了（也不是个好名字）
 *   · `images` —— 图片素材目录（老库里就有）
 *   · `_meta` / `_subjects.json` —— 程序自己用的名字
 */
export const RESERVED_DIRS = ['题库', 'images', '_meta', '_subjects.json'];

export interface Subject {
  /** 学科字母，写进 qid，永不改 */
  id: string;
  /** 界面上的名字 */
  name: string;
  /** 相对「题库位置」的目录名；空串 = 用默认名（第一个学科存的就是空串） */
  dir: string;
}

export interface SubjectRegistry {
  version: number;
  active: string;
  subjects: Subject[];
}

// ============================================================
// 路径
// ============================================================

/** 「题库位置」—— 所有学科的**总位置**（设置页「路径」里那个） */
export function subjectsRoot(): string {
  return resolvePathValue('vaultPath');
}

export function subjectsFilePath(): string {
  return path.join(/* turbopackIgnore: true */ subjectsRoot(), SUBJECTS_FILE);
}

/**
 * 默认学科（`dir` 为空串）实际用哪个目录名。
 *
 * 正常是 `DEFAULT_SUBJECT_DIR`（「数学」）；但如果磁盘上已经有一个老库的「题库」目录、
 * 又没有「数学」，那就按老库读 —— v10 及以前建的库直接指过来还能看到题，
 * **不会被误判成空库**（那才是真正吓人的事故：数据明明在，界面却说 0 道题）。
 *
 * ⚠️ 老名字只有在**里面真有东西**时才算数：空目录不算。
 * 否则一个残留的空 `题库/` 会把新库永远拖回旧名字（实测踩过：清库后留下一个空的
 * `题库/题库/`，于是「数学」目录怎么也建不出来，界面上还显示 `题库\题库`）。
 *
 * 结果按「题库位置」缓存一份：这个函数在列表渲染里会被高频调用，
 * 每次都 existsSync 一次没必要。换题库位置（键不同）自然不复用。
 */
const dirCache = new Map<string, string>();

function dirHasContent(dir: string): boolean {
  try {
    return fs.readdirSync(dir).length > 0;
  } catch {
    return false; // 不存在 / 读不了，都当没有
  }
}

function defaultSubjectDir(root: string): string {
  const cached = dirCache.get(root);
  if (cached) return cached;

  let dir = DEFAULT_SUBJECT_DIR;
  const preferred = path.join(/* turbopackIgnore: true */ root, DEFAULT_SUBJECT_DIR);
  if (!dirHasContent(preferred)) {
    for (const legacy of LEGACY_DEFAULT_SUBJECT_DIRS) {
      if (dirHasContent(path.join(root, legacy))) {
        dir = legacy;
        break;
      }
    }
  }
  dirCache.set(root, dir);
  return dir;
}

/**
 * 某个学科的题库目录 —— **直接就是「题库位置」下的一个子目录**。
 *
 *   A（dir 为空串）→ `<总位置>/数学`     ← 老库里这儿叫「题库」，照读
 *   B（dir=化学）  → `<总位置>/化学`
 */
export function bankPathOf(subjectId: string): string {
  const s = findSubject(subjectId);
  return path.join(/* turbopackIgnore: true */ subjectsRoot(), subjectDirOf(s));
}

/** 某个学科实际用的目录名（`dir` 为空串时按「数学」/老库的「题库」解析） */
export function subjectDirOf(s: Subject | undefined): string {
  if (s?.dir) return s.dir;
  return defaultSubjectDir(subjectsRoot());
}

/** 内部用：自己的 ensureDir（不能 import paths.ts —— 那会形成循环依赖） */
function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ============================================================
// 读 / 写注册表
// ============================================================

/**
 * 默认注册表：只有一个 A 学科、`dir` 为空。
 * **注册表文件不存在时就返回它** —— 老库（从没建过学科）因此完全不受影响，
 * 也不需要"升级/迁移"这一步。
 */
export function defaultRegistry(): SubjectRegistry {
  return { version: 1, active: 'A', subjects: [{ id: 'A', name: '数学', dir: '' }] };
}

function sanitizeDir(name: string): string {
  // 目录名不允许出现路径分隔符与 ..（否则就能写到「题库位置」之外）
  return name.replace(/[\\/:*?"<>|]/g, '').replace(/\.+/g, '').trim();
}

export function readSubjects(): SubjectRegistry {
  const file = subjectsFilePath();
  if (!fs.existsSync(file)) return defaultRegistry();
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as Partial<SubjectRegistry>;
    const list: Subject[] = Array.isArray(raw.subjects)
      ? raw.subjects
          .map((s) => ({
            id: String(s?.id ?? '').trim(),
            name: String(s?.name ?? '').trim(),
            dir: String(s?.dir ?? '').trim(),
          }))
          .filter((s) => s.id && s.name)
      : [];
    if (!list.length) return defaultRegistry();
    const active = list.some((s) => s.id === raw.active) ? String(raw.active) : list[0].id;

    // 名字与目录不合法的一律兜住（手改过注册表也不至于让整个程序打不开）
    const seenDir = new Set<string>();
    const clean: Subject[] = [];
    for (const s of list) {
      const dir = s.dir ? sanitizeDir(s.dir) : '';
      // 两个学科指同一个目录 = 数据会互相污染，直接拒绝第二个
      if (dir && seenDir.has(dir)) continue;
      seenDir.add(dir);
      clean.push({ ...s, dir });
    }
    return { version: 1, active, subjects: clean };
  } catch (e) {
    console.warn(`[subjects] _subjects.json 解析失败，按默认（单学科）处理：${(e as Error).message}`);
    return defaultRegistry();
  }
}

export function writeSubjects(reg: SubjectRegistry): SubjectRegistry {
  ensureDir(subjectsRoot());
  fs.writeFileSync(subjectsFilePath(), JSON.stringify(reg, null, 2) + '\n', 'utf-8');
  return reg;
}

// ============================================================
// 查询
// ============================================================

export function listSubjects(): Subject[] {
  return readSubjects().subjects;
}

export function findSubject(id: string): Subject | undefined {
  return readSubjects().subjects.find((s) => s.id === id);
}

/** 当前学科字母（**注册表里的** active，不含请求级覆盖） */
export function activeSubjectId(): string {
  return readSubjects().active;
}

export function activeSubject(): Subject {
  const reg = readSubjects();
  return reg.subjects.find((s) => s.id === reg.active) ?? reg.subjects[0];
}

// ============================================================
// 请求级覆盖（"这次录到哪个学科"）
// ============================================================

const als = new AsyncLocalStorage<string>();

/** 在这段调用里把"当前学科"临时换成 `id`（录入页选学科用） */
export function withSubject<T>(id: string, fn: () => T): T {
  return als.run(id, fn);
}

/** 本次调用真正生效的学科字母：请求级覆盖优先，否则是注册表里的 active */
export function currentSubjectId(): string {
  const override = als.getStore();
  if (override && findSubject(override)) return override;
  return activeSubjectId();
}

export function currentSubject(): Subject {
  return findSubject(currentSubjectId()) ?? activeSubject();
}

/** 当前学科的题库目录（`paths.bankPath()` 就是调它） */
export function currentBankPath(): string {
  return bankPathOf(currentSubjectId());
}

// ============================================================
// 增 / 切换 / 改名
// ============================================================

export interface SubjectView extends Subject {
  /** 该学科的题库目录（绝对路径） */
  bankPath: string;
  /** 题库里已有多少条记录（目录数，不做索引，够界面显示个概览） */
  count: number;
  active: boolean;
}

function countFolders(bank: string): number {
  try {
    return fs
      .readdirSync(bank, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('_')).length;
  } catch {
    return 0;
  }
}

export function listSubjectViews(): SubjectView[] {
  const reg = readSubjects();
  return reg.subjects.map((s) => ({
    ...s,
    bankPath: bankPathOf(s.id),
    count: countFolders(bankPathOf(s.id)),
    active: s.id === reg.active,
  }));
}

export function validateSubjectName(name: unknown): string | null {
  const n = String(name ?? '').trim();
  if (!n) return '学科名字不能为空';
  if (n.length > SUBJECT_NAME_MAX) {
    return `学科名字最长 ${SUBJECT_NAME_MAX} 个字（「${n}」有 ${n.length} 个字）`;
  }
  if (sanitizeDir(n) !== n) {
    return '学科名字里不能有 / \\ : * ? " < > | 这些字符（它要当目录名）';
  }
  // v10：学科目录与默认学科**同级**，所以名字会直接变成「总位置」下的目录名 ——
  // 撞上这几个就把别人的东西盖了，直接拦掉。
  if (RESERVED_DIRS.includes(n)) {
    return `「${n}」这个名字被程序占用了（${RESERVED_DIRS.join('、')}），换一个`;
  }
  return null;
}

/** 新建一个学科并**自动切过去**（你说的"新建后自动切换题库"） */
export function createSubject(name: string): { registry: SubjectRegistry; subject: Subject } {
  const err = validateSubjectName(name);
  if (err) throw new Error(err);

  const reg = readSubjects();
  if (reg.subjects.length >= MAX_SUBJECTS) {
    throw new Error(`最多 ${MAX_SUBJECTS} 个学科（现在有 ${reg.subjects.length} 个）`);
  }
  const clean = String(name).trim();
  if (reg.subjects.some((s) => s.name === clean)) {
    throw new Error(`已经有一个叫「${clean}」的学科了`);
  }

  const usedIds = new Set(reg.subjects.map((s) => s.id));
  const id = SUBJECT_IDS.find((x) => !usedIds.has(x));
  if (!id) throw new Error(`学科字母已经用完了（只有 ${SUBJECT_IDS.join('、')}）`);

  const dir = sanitizeDir(clean);
  // v10：目录与已有的学科同级，所以**目录名也要唯一** ——
  // 两个学科指同一个目录 = 两套数据互相污染（读注册表时已经会挡，这里挡在更早一步）
  // （比较的是**实际目录名**：默认学科存的是空串，但它的目录是「数学」或老库的「题库」）
  if (reg.subjects.some((s) => subjectDirOf(s) === dir)) {
    throw new Error(`已经有一个学科用着「${dir}」这个目录了`);
  }
  /*
   * 目标目录已经存在且有东西 → 那是别人的数据，别往里写。
   *
   * ⚠️ 这里**必须按"候选目录名"拼路径**，不能调 `bankPathOf(id)` ——
   * 新学科还没进注册表，`bankPathOf` 查不到它、会退回默认目录，
   * 于是"题库里有题"被误判成"化学目录已被占用"，任何新建都失败。
   * （实测：默认库里有 2 道题时，新建学科直接报「化学」目录里已经有东西了。）
   */
  const target = path.join(/* turbopackIgnore: true */ subjectsRoot(), dir);
  if (fs.existsSync(target) && fs.readdirSync(target).length > 0) {
    throw new Error(`「${dir}」目录里已经有东西了，换个名字（或者先把它挪走）`);
  }

  const subject: Subject = { id, name: clean, dir };
  reg.subjects.push(subject);
  reg.active = id;
  writeSubjects(reg);

  // 立刻把目录建起来（含 _meta），这样新建完就能直接录题
  ensureDir(path.join(bankPathOf(id), '_meta'));

  return { registry: reg, subject };
}

export function switchSubject(id: string): SubjectRegistry {
  const reg = readSubjects();
  if (!reg.subjects.some((s) => s.id === id)) throw new Error(`没有这个学科：${id}`);
  reg.active = id;
  return writeSubjects(reg);
}

/** 改学科的名字 —— **只改 name，不动目录**（否则要搬整个题库） */
export function renameSubject(id: string, name: string): SubjectRegistry {
  const err = validateSubjectName(name);
  if (err) throw new Error(err);
  const reg = readSubjects();
  const s = reg.subjects.find((x) => x.id === id);
  if (!s) throw new Error(`没有这个学科：${id}`);
  const clean = String(name).trim();
  if (reg.subjects.some((x) => x.id !== id && x.name === clean)) {
    throw new Error(`已经有一个叫「${clean}」的学科了`);
  }
  s.name = clean;
  return writeSubjects(reg);
}
