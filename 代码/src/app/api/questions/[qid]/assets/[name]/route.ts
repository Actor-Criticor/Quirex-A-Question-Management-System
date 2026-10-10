import type { NextRequest } from 'next/server';
import path from 'path';
import { deleteAsset, getQuestion } from '@/lib/service';
import { fail, ok } from '@/lib/api';
import { resolveQid } from '@/lib/paths';

export const dynamic = 'force-dynamic';

/** DELETE /api/questions/[qid]/assets/[name] — 删图片（图片可删，题目不可删） */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ qid: string; name: string }> }
) {
  try {
    const { name } = await params;
    const qid = resolveQid((await params).qid);
    const safe = path.basename(name);
    if (safe !== name) return ok({ error: '非法文件名' }, 400);

    const removed = deleteAsset(qid, safe);
    const full = getQuestion(qid);
    return ok({ removed, assets: full.assets, orphanImages: [] });
  } catch (e) {
    return fail(e);
  }
}
