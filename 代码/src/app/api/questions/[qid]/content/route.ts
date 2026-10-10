import type { NextRequest } from 'next/server';
import { writeContent } from '@/lib/service';
import { fail, ok, readJson } from '@/lib/api';
import { resolveQid } from '@/lib/paths';

export const dynamic = 'force-dynamic';

/** PUT /api/questions/[qid]/content — 改写题干/答案（仅单题），并刷新索引 */
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ qid: string }> }
) {
  try {
    const qid = resolveQid((await params).qid);
    const body = await readJson(req);
    const part = body.part === 'answer' ? 'answer' : 'stem';
    const text = typeof body.text === 'string' ? body.text : '';
    const meta = writeContent(qid, part, text);
    return ok({ meta });
  } catch (e) {
    return fail(e);
  }
}
