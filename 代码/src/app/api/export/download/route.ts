import type { NextRequest } from 'next/server';
import fs from 'fs';
import path from 'path';
import JSZip from 'jszip';
import { exportRootDir } from '@/lib/paths';
import { fail, ok } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/** 列出已有导出（历史记录） */
export async function GET(req: NextRequest) {
  try {
    const folder = req.nextUrl.searchParams.get('folder');
    const root = exportRootDir();
    if (!fs.existsSync(root)) return ok({ folders: [] });

    // 不带 folder 参数 → 返回导出历史
    if (!folder) {
      const folders = fs
        .readdirSync(root, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => {
          const full = path.join(root, e.name);
          const stat = fs.statSync(full);
          // v6 修：这里原来找的是 `main.pdf`（v0 的文件名），而 v1 之后导出的是
          // 题目.pdf / 答案.pdf —— 于是导出历史里**每一条都显示「无 PDF」**。
          //
          // 注意这两行要**写成字面路径**：如果改成 `['题目.pdf','答案.pdf'].filter(f => fs.existsSync(path.join(full, f)))`，
          // 打包器的静态分析会把 `path.join(full, 变量)` 当成通配
          // （实测告警：matches 17258 files）—— 那是构建性能与误打包的隐患。
          const pdfs: string[] = [];
          if (fs.existsSync(path.join(full, '题目.pdf'))) pdfs.push('题目.pdf');
          if (fs.existsSync(path.join(full, '答案.pdf'))) pdfs.push('答案.pdf');
          return {
            folder: e.name,
            createdAt: stat.mtime.toISOString(),
            hasPdf: pdfs.length > 0,
            pdfs,
          };
        })
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return ok({ folders });
    }

    // 带 folder → 打包下载
    const safe = path.basename(folder);
    if (safe !== folder) return ok({ error: '非法文件夹名' }, 400);
    const dir = path.join(root, safe);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      return ok({ error: `导出文件夹不存在：${safe}` }, 404);
    }

    const zip = new JSZip();
    const addDir = (current: string, prefix: string) => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name);
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) addDir(full, rel);
        else zip.file(rel, fs.readFileSync(full));
      }
    };
    addDir(dir, '');

    const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    return new Response(new Uint8Array(buf), {
      status: 200,
      headers: {
        'Content-Type': 'application/zip',
        'Content-Length': String(buf.length),
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(safe + '.zip')}`,
      },
    });
  } catch (e) {
    return fail(e);
  }
}
