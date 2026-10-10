/**
 * config.ts — 运行期可改的配置（v6）
 *
 * 为什么要有它：以前路径全靠环境变量（`.env.local`），改一次要重启服务、还得知道去哪改。
 * 现在多了一层 `config.json`（放在「代码」里、package.json 旁边），设置页可以直接改，
 * **改完立即生效** —— 因为路径本来就是"每次调用时读"，不是模块加载时固化。
 *
 * 优先级：**config.json > 环境变量 > 默认值**
 *   这样你现有的 `.env.local` 依然有效，不动任何东西也能照常用；
 *   想临时试个别的位置，用界面写进 config.json 就会盖过环境变量。
 *
 * 为什么跟代码放一起而不是放题库里：题库路径本身要配，而它不能存在题库里（先有鸡还是先有蛋）。
 * 所以配置跟代码放一起，题库里只放题库自己的东西。
 */

import fs from 'fs';
import path from 'path';

export const CONFIG_KEYS = ['vaultPath', 'exportDir', 'templatesDir', 'xelatexPath'] as const;
export type ConfigKey = (typeof CONFIG_KEYS)[number];

export interface AppConfig {
  /** Vault 根目录（题库的父目录），里面应有「题库/」 */
  vaultPath?: string;
  /** 导出根目录 */
  exportDir?: string;
  /** 模板根目录 */
  templatesDir?: string;
  /** xelatex 可执行文件路径；留空 = 走系统 PATH */
  xelatexPath?: string;
}

/** 一个配置项当前的值来自哪里 —— 设置页要显示出来，避免"我改了怎么没变" */
export type ConfigSource = 'config' | 'env' | 'default';

export const ENV_NAMES: Record<ConfigKey, string> = {
  vaultPath: 'VAULT_PATH',
  exportDir: 'EXPORT_DIR',
  templatesDir: 'TEMPLATES_DIR',
  xelatexPath: 'XELATEX_PATH',
};

/**
 * `config.json` 就放在「代码」里（package.json 旁边），所以用 cwd。
 * 它按机器而异，不进版本库（.gitignore 里有 /代码/config.json）。
 */
export function configFilePath(): string {
  return path.join(/* turbopackIgnore: true */ process.cwd(), 'config.json');
}

/**
 * 仓库根目录 —— 「代码」的**上一层**。`题库/`、`模板/`、`导出/` 三个数据文件夹都摆在那儿，
 * 一眼能看出哪个是代码、哪个是数据。
 *
 * 为什么是"上一层"：这个应用的工作目录固定在 `代码/`（package.json 在那儿），
 * 三个 bat 每次都会先 cd 进去，所以在正常用法下 cwd 就是 `代码/`。
 * 万一有人直接在仓库根起服务（cwd 本身就是根，那儿没有 package.json），
 * 那就当根用 —— 用 package.json 做一次判断，免得默认路径跑到 Desktop 上去。
 */
function repoRoot(): string {
  const cwd = process.cwd();
  const looksLikeCodeDir = fs.existsSync(
    path.join(/* turbopackIgnore: true */ cwd, 'package.json'),
  );
  return looksLikeCodeDir ? path.resolve(cwd, '..') : cwd;
}

export function defaultFor(key: ConfigKey): string {
  const root = repoRoot();
  switch (key) {
    case 'vaultPath':
      // 「题库」= 所有学科的总位置（设置页「路径 → 题库位置」），里面每个学科一个子目录
      return path.join(root, '题库');
    case 'exportDir':
      return path.join(root, '导出');
    case 'templatesDir':
      return path.join(root, '模板');
    case 'xelatexPath':
      // 空串 = 不指定，交给系统 PATH 找
      return '';
  }
}

// ============================================================
// 读（带 mtime 缓存：改盘上文件也能被看到，又不至于每次调用都重解析）
// ============================================================

let cache: { mtimeMs: number; size: number; data: AppConfig } | null = null;

function readRaw(): AppConfig {
  const file = configFilePath();
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    cache = null;
    return {};
  }
  if (cache && cache.mtimeMs === stat.mtimeMs && cache.size === stat.size) return cache.data;

  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>;
    const data: AppConfig = {};
    for (const k of CONFIG_KEYS) {
      const v = parsed[k];
      if (typeof v === 'string' && v.trim()) data[k] = v.trim();
    }
    cache = { mtimeMs: stat.mtimeMs, size: stat.size, data };
    return data;
  } catch (e) {
    console.warn(`[config] config.json 解析失败，按空配置处理：${(e as Error).message}`);
    cache = null;
    return {};
  }
}

export function readConfig(): AppConfig {
  return readRaw();
}

/** 某个配置项的**生效值**及来源 */
export function resolveConfig(key: ConfigKey): { value: string; source: ConfigSource } {
  const fromFile = readConfig()[key];
  if (fromFile) return { value: fromFile, source: 'config' };

  const fromEnv = process.env[ENV_NAMES[key]];
  if (fromEnv && fromEnv.trim()) return { value: fromEnv.trim(), source: 'env' };

  return { value: defaultFor(key), source: 'default' };
}

/**
 * 取一个路径类配置的**绝对路径**。
 * 全部解析成绝对路径，免得到处出现"相对谁"的疑问。
 */
export function resolvePathValue(key: ConfigKey): string {
  const { value } = resolveConfig(key);
  if (!value) return '';
  return path.isAbsolute(value) ? value : path.resolve(value);
}

// ============================================================
// 写
// ============================================================

/**
 * 写配置（部分字段）。
 * 传 `null` 显式清掉某一项（清掉后就回落到环境变量 / 默认值）。
 */
export function writeConfig(patch: Record<string, unknown>): AppConfig {
  const current = { ...readConfig() };

  for (const k of CONFIG_KEYS) {
    if (!(k in patch)) continue;
    const v = patch[k];
    if (v === null || v === undefined || String(v).trim() === '') delete current[k];
    else current[k] = String(v).trim();
  }

  cache = null; // 让下一次读走磁盘（也顺便刷新 mtime 缓存）
  const file = configFilePath();
  if (Object.keys(current).length === 0) {
    // 全空就把文件删掉，别留一个 `{}` 让人困惑
    try {
      fs.unlinkSync(file);
    } catch {
      /* 本来就没有就算了 */
    }
    return {};
  }

  fs.writeFileSync(file, JSON.stringify(current, null, 2) + '\n', 'utf-8');
  return current;
}
