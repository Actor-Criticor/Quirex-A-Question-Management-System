import type { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import {
  CONFIG_KEYS,
  ENV_NAMES,
  configFilePath,
  defaultFor,
  readConfig,
  resolveConfig,
  resolvePathValue,
  writeConfig,
  type AppConfig,
  type ConfigKey,
} from '@/lib/config';
import { bankPath } from '@/lib/paths';
import { RESERVED_DIRS, listSubjects, subjectDirOf } from '@/lib/subjects';
import { fail, ok, readJson } from '@/lib/api';

export const dynamic = 'force-dynamic';

interface EntryView {
  key: ConfigKey;
  /** 当前生效的值（路径类一律给绝对路径，界面上直接可用） */
  value: string;
  /** config.json 里**实际写着的**值（没有则空串）—— 输入框留空=回落默认 */
  stored: string;
  /** 值来自哪里 —— 设置页要显示，免得"我改了怎么没变" */
  source: 'config' | 'env' | 'default';
  envName: string;
  defaultValue: string;
  /** 路径类：存不存在 */
  exists: boolean;
  /** 额外提示（如"这个目录里没有 题库/ 子目录"） */
  note?: string;
}

/**
 * 这个目录像不像一个「题库位置」（所有学科的总位置）。
 *
 * 判据：**空的算**（新建的库就是这样，录第一题时会自动建学科目录），
 * 或者里面已经能看出题库的样子 —— `_subjects.json`、学科目录（`数学`/`化学`）、
 * 老库那层 `题库`、素材目录 `images`。
 *
 * v11 前这里要求"必须有 题库/ 子目录"，于是**指向一个空文件夹会被拒**；
 * 而题库目录现在直接叫学科名，更不该按老名字判。
 */
function vaultLooksOk(abs: string): { ok: boolean; note?: string } {
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
    return { ok: false, note: '这个目录不存在' };
  }
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(abs);
  } catch {
    return { ok: false, note: '这个目录读不了（权限？）' };
  }
  if (entries.length === 0) return { ok: true }; // 空目录 = 新建一个题库，允许

  const known = new Set<string>(['_subjects.json', 'images', ...RESERVED_DIRS]);
  for (const s of listSubjects()) known.add(subjectDirOf(s));
  if (entries.some((e) => known.has(e))) return { ok: true };

  return {
    ok: false,
    note: '这个目录里没有 _subjects.json、也没有「数学」这样的学科目录 —— 确认选的是题库根目录？',
  };
}

function view(): { entries: EntryView[]; file: string; raw: AppConfig } {
  const raw = readConfig();
  const entries: EntryView[] = CONFIG_KEYS.map((key) => {
    const { source } = resolveConfig(key);
    const value = key === 'xelatexPath' ? resolveConfig(key).value : resolvePathValue(key);
    let exists = true;
    let note: string | undefined;

    if (key === 'xelatexPath') {
      // 空串 = 走系统 PATH，能不能找到要靠"检测"按钮
      exists = value === '' ? true : fs.existsSync(value);
      if (value === '') note = '留空 = 用系统 PATH 里的 xelatex';
    } else if (value) {
      exists = fs.existsSync(value) && fs.statSync(value).isDirectory();
      if (!exists) note = '这个目录不存在';
      else if (key === 'vaultPath') {
        const look = vaultLooksOk(value);
        if (!look.ok) note = look.note;
      }
    }

    return {
      key,
      value,
      stored: raw[key] ?? '',
      source,
      envName: ENV_NAMES[key],
      defaultValue: defaultFor(key),
      exists,
      note,
    };
  });
  return { entries, file: configFilePath(), raw };
}

/** GET /api/config — 当前配置 + 每项的来源 */
export async function GET() {
  try {
    return ok(view());
  } catch (e) {
    return fail(e);
  }
}

/**
 * PATCH /api/config — 改配置（部分字段）
 *
 * 校验原则：**宁可直接拒绝，也不要写进一个会让程序坏掉的路径**。
 *   · 路径类：必须存在（`vaultPath` 还要求看起来像 Vault，即里面有 题库/）
 *   · 导出目录：不存在就**帮你建**（这是唯一允许自动创建的，因为它只是输出位置）
 *   · xelatex：给了就要求文件存在
 * 传 `null` 或空串 = 清掉该项 → 回落到环境变量 / 默认值。
 */
export async function PATCH(req: NextRequest) {
  try {
    const body = await readJson(req);
    const patch: Record<string, unknown> = {};
    const problems: string[] = [];

    for (const key of CONFIG_KEYS) {
      if (!(key in body)) continue;
      const rawValue = body[key];

      // 清空
      if (rawValue === null || rawValue === undefined || String(rawValue).trim() === '') {
        patch[key] = null;
        continue;
      }

      const value = String(rawValue).trim();
      const abs = path.isAbsolute(value) ? value : path.resolve(value);

      if (key === 'xelatexPath') {
        if (!fs.existsSync(abs)) {
          problems.push(`xelatex 路径不存在：${abs}`);
          continue;
        }
        patch[key] = abs;
        continue;
      }

      if (key === 'exportDir') {
        // 导出目录不存在就建出来（它只是输出位置，建了无害）
        try {
          if (!fs.existsSync(abs)) fs.mkdirSync(abs, { recursive: true });
        } catch (e) {
          problems.push(`导出目录既不存在也建不出来：${abs}（${(e as Error).message}）`);
          continue;
        }
        patch[key] = abs;
        continue;
      }

      // vaultPath / templatesDir：必须已经存在
      if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
        problems.push(`${key === 'vaultPath' ? '题库' : '模板'}目录不存在：${abs}`);
        continue;
      }
      if (key === 'vaultPath') {
        const look = vaultLooksOk(abs);
        if (!look.ok) {
          problems.push(`${look.note}：${abs}`);
          continue;
        }
      }
      patch[key] = abs;
    }

    if (problems.length) return ok({ error: problems.join('；'), problems }, 400);

    const saved = writeConfig(patch);
    return ok({ config: saved, ...view() });
  } catch (e) {
    return fail(e);
  }
}

/**
 * POST /api/config — 需要"动手"的动作（都带副作用，所以不放 GET）
 *
 *   {action:'testXelatex'}      跑 xelatex --version，把结果贴回来
 *   {action:'reveal', key}      在文件管理器里打开某个目录
 */
export async function POST(req: NextRequest) {
  try {
    const body = await readJson(req);
    const action = String(body.action ?? '');

    if (action === 'testXelatex') {
      const { value } = resolveConfig('xelatexPath');
      const bin = value || 'xelatex';
      return await new Promise<NextResponse>((resolve) => {
        execFile(bin, ['--version'], { timeout: 20000, windowsHide: true }, (err, stdout) => {
          if (err) {
            resolve(
              ok({
                ok: false,
                bin,
                output:
                  (err as NodeJS.ErrnoException).code === 'ENOENT'
                    ? `找不到「${bin}」。装了 TeX Live 就能用；也可以在「路径」里指定 xelatex.exe 的完整路径。`
                    : `调用失败：${err.message}`,
              })
            );
            return;
          }
          const first = (stdout ?? '').split(/\r?\n/).find((l) => l.trim()) ?? '';
          resolve(ok({ ok: true, bin, output: first.trim() }));
        });
      });
    }

    if (action === 'reveal') {
      const key = String(body.key ?? '') as ConfigKey;
      if (!CONFIG_KEYS.includes(key)) return ok({ error: `未知的配置项：${key}` }, 400);
      const { value } = resolveConfig(key);
      let target = value;
      if (key === 'vaultPath') target = bankPath();
      if (key === 'xelatexPath') target = value ? path.dirname(value) : process.cwd();
      if (!target || !fs.existsSync(target)) return ok({ error: `目录不存在：${target}` }, 400);

      if (process.platform === 'win32') {
        // explorer 打开目录：detached 且别等它（explorer 会一直挂着）
        const child = execFile('explorer.exe', [target], { windowsHide: false });
        child.on('error', () => {
          /* 打不开就算了，界面上还有路径可复制 */
        });
        child.unref();
      }
      return ok({ opened: target });
    }

    return ok({ error: `未知操作：${action || '(空)'}` }, 400);
  } catch (e) {
    return fail(e);
  }
}
