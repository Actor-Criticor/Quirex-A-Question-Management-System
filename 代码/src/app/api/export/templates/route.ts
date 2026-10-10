import type { NextRequest } from 'next/server';
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { fail, ok, readJson } from '@/lib/api';
import { templatesRootDir } from '@/lib/latexExport';
import { KNOWN_TOKENS, listTemplateInfos, TOKEN_DOC, type TemplateInfo } from '@/lib/templates';

export const dynamic = 'force-dynamic';

/**
 * GET /api/export/templates — 列出全部模板及其校验结果
 *
 * 注意"全部"包含**不可用**的模板：界面要能把问题显示出来让人去修，
 * 悄悄藏掉的话你只会看到"模板不见了"，不知道该改什么。
 */
export async function GET() {
  try {
    const root = templatesRootDir();
    const infos = listTemplateInfos(root);
    return ok({
      root,
      templates: infos.map((t: TemplateInfo) => ({
        id: t.id,
        dir: t.dir,
        usable: t.usable,
        issues: t.issues,
        name: t.manifest?.name ?? t.id,
        description: t.manifest?.description ?? '',
        engine: t.manifest?.engine ?? '',
        styleFiles: t.manifest?.styleFiles ?? [],
        tokens: t.manifest?.tokens ?? [],
        defaults: t.manifest?.defaults ?? {},
      })),
      /** 导出弹窗直接用这个列表，免得两边各判一次"哪些能用" */
      usableIds: infos.filter((t) => t.usable).map((t) => t.id),
      /** 占位符字典，界面上的说明文字与后端报错话术同源 */
      tokenDoc: TOKEN_DOC,
      knownTokens: KNOWN_TOKENS,
    });
  } catch (e) {
    return fail(e);
  }
}

/**
 * 只把顶层某个字符串字段的值换掉，**其余一个字符都不动**。
 *
 * 为什么不直接 JSON.parse → 改 → JSON.stringify：那样会把作者手写的排版
 * （数组是否换行、缩进风格）全部规范化，一个"只改了个名字"的操作会在
 * 版本控制里显示成整文件重写。模板是你自己会打开来改的文件，值得尊重。
 *
 * 返回 null 表示"没法安全地就地替换"（比如根本没有这个键），调用方回落到整体重写。
 */
function replaceFieldInPlace(raw: string, key: string, value: string): string | null {
  // 匹配顶层第一个 "key": "..." —— 值里的转义一并吃掉
  const re = new RegExp(`("${key}"\\s*:\\s*)"(?:[^"\\\\]|\\\\.)*"`);
  if (!re.test(raw)) return null;
  // 替换串里的 $ 在 String.replace 里有特殊含义，先转义
  const literal = (JSON.stringify(value) as string).replace(/\$/g, '$$$$');
  return raw.replace(re, `$1${literal}`);
}

/**
 * 检查"就地替换"的结果确实只改了 patch 里那几个字段 —— 其它字段必须与原文完全一致。
 * 不放心的话就不用它（宁可整体重写，也不要把文件改坏）。
 */
function onlyFieldsChanged(
  before: unknown,
  after: unknown,
  patch: Record<string, string>
): boolean {
  if (!after || typeof after !== 'object') return false;
  const a = after as Record<string, unknown>;
  for (const [k, v] of Object.entries(patch)) if (a[k] !== v) return false;

  const strip = (o: unknown): string => {
    const c = { ...(o as Record<string, unknown>) };
    for (const k of Object.keys(patch)) delete c[k];
    return JSON.stringify(c, Object.keys(c).sort());
  };
  return strip(before) === strip(after);
}

/**
 * 把若干字段写进模板的 meta.json，尽量保持原文件的排版。
 *
 * 策略：先逐个尝试"就地替换"；只要有一个字段没法就地替换（比如老模板里
 * 根本没有 description 键），就整体重写 —— 重写也只动这几个字段。
 */
function patchMeta(
  metaPath: string,
  patch: Record<string, string>
): { ok: true } | { ok: false; error: string } {
  const raw = fs.readFileSync(metaPath, 'utf-8');
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch (e) {
    return { ok: false, error: `meta.json 不是合法 JSON，先修好再改：${(e as Error).message}` };
  }

  let next: string | null = raw;
  for (const [k, v] of Object.entries(patch)) {
    next = replaceFieldInPlace(next as string, k, v);
    if (next === null) break;
  }

  let out: string | null = null;
  if (next !== null) {
    try {
      if (onlyFieldsChanged(parsed, JSON.parse(next), patch)) out = next;
    } catch {
      /* 替换结果解析不了 → 走兜底 */
    }
  }
  if (out === null) {
    for (const [k, v] of Object.entries(patch)) parsed[k] = v;
    out = JSON.stringify(parsed, null, 2) + '\n';
  }
  fs.writeFileSync(metaPath, out, 'utf-8');
  return { ok: true };
}

/**
 * POST /api/export/templates — 需要写盘或在文件管理器里打开的动作
 *
 *   {action:'update', id, name, description}  改显示名 + 描述（只写 meta.json，**文件夹名不动**）
 *   {action:'rename', id, name}               只改显示名（v8 的老接口，保留）
 *   {action:'reveal', id}                     在文件管理器里打开模板目录
 */
export async function POST(req: NextRequest) {
  try {
    const body = await readJson(req);
    const action = String(body.action ?? '');

    // v8b：打开**模板根目录**（设置页顶部那个「打开」按钮用）。
    // 它不需要 id，所以放在 id 校验之前。
    if (action === 'revealRoot') {
      const rootDir = templatesRootDir();
      if (!fs.existsSync(rootDir)) return ok({ error: `模板目录不存在：${rootDir}` }, 400);
      if (process.platform === 'win32') {
        const child = execFile('explorer.exe', [path.resolve(rootDir)], { windowsHide: false });
        child.on('error', () => {
          /* 打不开就算了，界面上还显示着完整路径 */
        });
        child.unref();
      }
      return ok({ opened: rootDir });
    }

    const id = String(body.id ?? '').trim();
    if (!id) return ok({ error: '缺少 id' }, 400);

    const root = templatesRootDir();
    const dir = path.join(root, id);

    // 防路径跳转：id 必须是模板根目录下的直接子目录
    if (path.dirname(path.resolve(dir)) !== path.resolve(root) || !fs.existsSync(dir)) {
      return ok({ error: `模板不存在：${id}` }, 404);
    }

    // 名称（显示名）的公共校验，rename 与 update 都用
    if (action === 'rename' || action === 'update') {
      const name = String(body.name ?? '').trim();
      if (!name) return ok({ error: '名称不能为空' }, 400);
      if (name.length > 40) return ok({ error: '名称太长了（最多 40 个字）' }, 400);

      const patch: Record<string, string> = { name };

      if (action === 'update') {
        const description = String(body.description ?? '').trim();
        if (description.length > 200) {
          return ok({ error: '描述太长了（最多 200 个字）' }, 400);
        }
        patch.description = description;
      }

      const metaPath = path.join(dir, 'meta.json');
      if (!fs.existsSync(metaPath)) {
        return ok({ error: `这个模板没有 meta.json，改不了：${dir}` }, 400);
      }
      const w = patchMeta(metaPath, patch);
      if (!w.ok) return ok({ error: w.error }, 400);

      const info = listTemplateInfos(root).find((t) => t.id === id);
      return ok({
        renamed: id,
        updated: id,
        name,
        description: patch.description ?? info?.manifest?.description ?? '',
        usable: info?.usable ?? false,
        issues: info?.issues ?? [],
      });
    }

    if (action === 'reveal') {
      if (process.platform === 'win32') {
        const child = execFile('explorer.exe', [path.resolve(dir)], { windowsHide: false });
        child.on('error', () => {
          /* 打不开就算了，界面上还显示着完整路径 */
        });
        child.unref();
      }
      return ok({ opened: dir });
    }

    return ok({ error: `未知操作：${action || '(空)'}` }, 400);
  } catch (e) {
    return fail(e);
  }
}
