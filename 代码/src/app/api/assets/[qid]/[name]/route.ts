import type { NextRequest } from 'next/server';
import path from 'path';
import { readAsset } from '@/lib/store';
import { fail } from '@/lib/api';

export const dynamic = 'force-dynamic';

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
};

/** GET /api/assets/[qid]/[name] — 题目图片（四通道共用） */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ qid: string; name: string }> }
) {
  try {
    const { qid, name } = await params;

    // 拒绝路径穿越
    const safeQid = path.basename(qid);
    const safeName = path.basename(name);
    if (safeQid !== qid || safeName !== name) {
      return new Response('非法路径', { status: 400 });
    }

    const buf = readAsset(safeQid, safeName);
    if (!buf) return new Response('图片不存在', { status: 404 });

    const ext = safeName.split('.').pop()?.toLowerCase() ?? '';
    return new Response(new Uint8Array(buf), {
      status: 200,
      headers: {
        'Content-Type': MIME[ext] ?? 'application/octet-stream',
        'Content-Length': String(buf.length),
        'Cache-Control': 'public, max-age=3600',
      },
    });
  } catch (e) {
    return fail(e);
  }
}
