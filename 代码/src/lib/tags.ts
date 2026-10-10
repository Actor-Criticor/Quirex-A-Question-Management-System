/**
 * tags.ts — 标签表（来源 / 知识点 / 自定义）
 *
 * 核心事实（方案 §6.2）：
 *   标签没有独立的预设词表。标签表就是「题目里实际用过的值」。
 *
 *   有效标签表 = （数据派生 ∪ manual）− retired
 *
 * 删除 = 停用（方案 §6.3）：
 *   题目上的值一个字不改 → 只改 tags.json 一处 → O(1)、零风险、可随时恢复。
 *   停用后从「标签表 / 录入联想 / 筛选面板」消失，但手打关键字仍能搜到。
 *
 * 由于「有效表 = 数据派生」，不存在独立词表与数据对不上的漂移，
 * 也就不会出现指向不存在标签的孤儿引用。
 *
 * v9：加了第三维「自定义」。整个文件是**按 TAG_KINDS 泛化**的 ——
 * 只有 collectCounts 需要知道"这个维度的值存在哪个字段"，
 * 于是它改调 tagValuesOf（types.ts），三个维度共用一条路径。
 */

import fs from 'fs';
import {
  TAG_KINDS,
  tagValuesOf,
  type IndexEntry,
  type TagItem,
  type TagKind,
  type TagStoreShape,
} from './types';
import { META_TAGS, ensureDir, metaDir, metaFile } from './paths';
import { normalizeTagName } from './validate';

// ============================================================
// 叠加层文件
// ============================================================

export function tagStorePath(): string {
  return metaFile(META_TAGS);
}

function emptyStore(): TagStoreShape {
  return {
    version: 1,
    manual: { source: [], knowledge: [], custom: [] },
    retired: { source: [], knowledge: [], custom: [] },
  };
}

function normalizeList(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const out = list.map((v) => normalizeTagName(v)).filter(Boolean);
  return Array.from(new Set(out));
}

export function readTagStore(): TagStoreShape {
  const file = tagStorePath();
  if (!fs.existsSync(file)) return emptyStore();
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as Partial<TagStoreShape>;
    // v9：custom 是**新加的键**，老 tags.json 里没有 —— 缺了就按空数组,
    // 所以这里必须逐维显式读，不能直接展开 raw（否则 custom 会是 undefined）
    const pick = (side: 'manual' | 'retired', kind: TagKind): string[] =>
      normalizeList((raw[side] as Record<string, unknown> | undefined)?.[kind]);
    return {
      version: typeof raw.version === 'number' ? raw.version : 1,
      manual: {
        source: pick('manual', 'source'),
        knowledge: pick('manual', 'knowledge'),
        custom: pick('manual', 'custom'),
      },
      retired: {
        source: pick('retired', 'source'),
        knowledge: pick('retired', 'knowledge'),
        custom: pick('retired', 'custom'),
      },
    };
  } catch (e) {
    console.warn(`[tags] tags.json 损坏，按空处理：${(e as Error).message}`);
    return emptyStore();
  }
}

export function writeTagStore(store: TagStoreShape): void {
  ensureDir(metaDir());
  fs.writeFileSync(tagStorePath(), JSON.stringify(store, null, 2) + '\n', 'utf-8');
}

// ============================================================
// 有效标签表
// ============================================================

/**
 * 统计引用数。
 * 返回两份：total 含停用题（用于显示与标签操作的影响范围），enabled 只含启用题。
 *
 * v9：从"知道 source 与 knowledge 两个字段"改成走 tagValuesOf ——
 * 三个维度共用同一条路径，以后再加一维也不用改这里。
 */
function collectCounts(
  entries: IndexEntry[],
  kind: TagKind
): { total: Map<string, number>; enabled: Map<string, number> } {
  const total = new Map<string, number>();
  const enabled = new Map<string, number>();

  const bump = (map: Map<string, number>, name: string) =>
    map.set(name, (map.get(name) ?? 0) + 1);

  for (const entry of entries) {
    const names = tagValuesOf(entry, kind)
      .map((v) => normalizeTagName(v))
      .filter(Boolean);
    for (const n of names) {
      bump(total, n);
      if (entry.status === '启用') bump(enabled, n);
    }
  }

  return { total, enabled };
}

/**
 * 派生标签表。
 * @param includeRetired 是否包含已停用的（标签管理页的「显示已停用」开关）
 */
export function deriveVocab(
  entries: IndexEntry[],
  includeRetired = false
): Record<TagKind, TagItem[]> {
  const store = readTagStore();
  const result = {} as Record<TagKind, TagItem[]>;

  for (const kind of TAG_KINDS) {
    const { total, enabled } = collectCounts(entries, kind);
    const retiredSet = new Set(store.retired[kind]);
    const manualSet = new Set(store.manual[kind]);

    const names = new Set<string>([...total.keys(), ...manualSet, ...retiredSet]);

    const items: TagItem[] = [];
    for (const name of names) {
      const retired = retiredSet.has(name);
      if (retired && !includeRetired) continue;
      items.push({
        name,
        kind,
        count: total.get(name) ?? 0,
        enabledCount: enabled.get(name) ?? 0,
        retired,
        manual: manualSet.has(name),
      });
    }

    // 引用多的排前面，其次按名字
    items.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh'));
    result[kind] = items;
  }

  return result;
}

/** 录入联想用的简单名字数组（不含已停用） */
export function vocabNames(entries: IndexEntry[], kind: TagKind): string[] {
  return deriveVocab(entries, false)[kind].map((t) => t.name);
}

export function isRetired(kind: TagKind, name: string): boolean {
  const store = readTagStore();
  return store.retired[kind].includes(normalizeTagName(name));
}

// ============================================================
// 增 / 停用 / 恢复 / 手工登记
// ============================================================

/** 手工登记一个暂无题目引用的标签 */
export function addManualTag(kind: TagKind, name: string): TagStoreShape {
  const clean = normalizeTagName(name);
  if (!clean) throw new Error('标签名不能为空');
  const store = readTagStore();
  if (!store.manual[kind].includes(clean)) store.manual[kind].push(clean);
  // 登记即视为启用
  store.retired[kind] = store.retired[kind].filter((n) => n !== clean);
  writeTagStore(store);
  return store;
}

export function removeManualTag(kind: TagKind, name: string): TagStoreShape {
  const clean = normalizeTagName(name);
  const store = readTagStore();
  store.manual[kind] = store.manual[kind].filter((n) => n !== clean);
  writeTagStore(store);
  return store;
}

/**
 * 停用 = 删除。
 * 只改 tags.json，题目文件零改动 → O(1)、零风险。
 */
export function retireTag(kind: TagKind, name: string): TagStoreShape {
  const clean = normalizeTagName(name);
  if (!clean) throw new Error('标签名不能为空');
  const store = readTagStore();
  if (!store.retired[kind].includes(clean)) store.retired[kind].push(clean);
  store.manual[kind] = store.manual[kind].filter((n) => n !== clean);
  writeTagStore(store);
  return store;
}

/** 恢复一个已停用的标签 */
export function restoreTag(kind: TagKind, name: string): TagStoreShape {
  const clean = normalizeTagName(name);
  const store = readTagStore();
  store.retired[kind] = store.retired[kind].filter((n) => n !== clean);
  writeTagStore(store);
  return store;
}

// ============================================================
// 彻底清除（高级操作，供 service 在备份后调用）
// ============================================================

/** 把标签从叠加层里彻底抹掉（不去动题目；题目侧的摘除由 service 负责） */
export function purgeTagFromStore(kind: TagKind, name: string): TagStoreShape {
  const clean = normalizeTagName(name);
  const store = readTagStore();
  store.retired[kind] = store.retired[kind].filter((n) => n !== clean);
  store.manual[kind] = store.manual[kind].filter((n) => n !== clean);
  writeTagStore(store);
  return store;
}
