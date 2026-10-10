import fs from 'fs';
import path from 'path';
import JSZip from 'jszip';
import { bankPath, ensureDir, metaDir, vaultPath } from '@/lib/paths';
import { rebuildIndex } from '@/lib/service';
import { loadIndex } from '@/lib/searchIndex';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const SKIP_DIRS = new Set(['node_modules', '.next', '.git']);

/** 递归收集题库里的所有文件（相对题库根的路径） */
function collectFiles(root: string, base = ''): Array<{ abs: string; rel: string }> {
  const out: Array<{ abs: string; rel: string }> = [];
  if (!fs.existsSync(root)) return out;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const abs = path.join(root, entry.name);
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...collectFiles(abs, rel));
    else out.push({ abs, rel });
  }
  return out;
}

/**
 * POST /api/backup/full — 整库备份
 *
 * 把整个「题库」目录（含 _meta、每道题的 md/tex/图片/PDF）打成一个 zip 下载。
 * 题库是纯文件、题目不可删除，所以"备份"就是原样打包，不做任何转换。
 */
export async function POST() {
  try {
    // 备份前先重建索引，保证备份里的 index.json 与题目一致
    rebuildIndex();

    const bank = bankPath();
    if (!fs.existsSync(bank)) {
      return Response.json({ error: `找不到题库目录：${bank}` }, { status: 404 });
    }

    const zip = new JSZip();
    const files = collectFiles(bank);
    let bytes = 0;
    for (const f of files) {
      const buf = fs.readFileSync(f.abs);
      bytes += buf.length;
      zip.file(f.rel, buf);
    }

    // 附一份清单，便于日后核对
    const entries = loadIndex();
    const manifest = {
      backedUpAt: new Date().toISOString(),
      vaultPath: vaultPath(),
      bankPath: bank,
      questionCount: entries.length,
      fileCount: files.length,
      rawBytes: bytes,
      questions: entries.map((e) => ({
        qid: e.qid,
        kind: e.kind,
        type: e.type,
        source: e.source,
        number: e.number,
        difficulty: e.difficulty,
        status: e.status,
      })),
    };
    zip.file('备份清单.json', JSON.stringify(manifest, null, 2) + '\n');

    const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);

    return new Response(new Uint8Array(buf), {
      status: 200,
      headers: {
        'Content-Type': 'application/zip',
        'Content-Length': String(buf.length),
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(
          `Quirex备份_${ts}.zip`
        )}`,
      },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error('[backup]', e);
    return Response.json({ error: message }, { status: 500 });
  }
}

/** GET /api/backup/full — 看一眼备份会包含多少东西（不下载） */
export async function GET() {
  try {
    const bank = bankPath();
    const files = fs.existsSync(bank) ? collectFiles(bank) : [];
    const bytes = files.reduce((sum, f) => {
      try {
        return sum + fs.statSync(f.abs).size;
      } catch {
        return sum;
      }
    }, 0);
    const entries = loadIndex();
    return Response.json({
      vaultPath: vaultPath(),
      bankPath: bank,
      exists: fs.existsSync(bank),
      questionCount: entries.length,
      fileCount: files.length,
      rawBytes: bytes,
      metaExists: fs.existsSync(metaDir()),
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return Response.json({ error: message }, { status: 500 });
  }
}

void ensureDir;
