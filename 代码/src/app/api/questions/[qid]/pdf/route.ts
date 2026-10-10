import type { NextRequest } from 'next/server';
import { getQuestion, savePdf } from '@/lib/service';
import { fail, ok } from '@/lib/api';
import { resolveQid } from '@/lib/paths';

export const dynamic = 'force-dynamic';

/**
 * POST /api/questions/[qid]/pdf — 上传整卷 PDF
 * multipart/form-data：role = paper | answer，file = PDF
 * 会校验 %PDF- 魔数，不能只看扩展名。
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ qid: string }> }
) {
  try {
    const qid = resolveQid((await params).qid);
    const fd = await req.formData();

    const role = fd.get('role');
    const file = fd.get('file');
    if (!file || typeof file === 'string') {
      return ok({ error: '缺少 file 字段' }, 400);
    }

    const buf = Buffer.from(await file.arrayBuffer());
    savePdf(qid, role, buf);

    return ok({ pdfs: getQuestion(qid).pdfs }, 201);
  } catch (e) {
    return fail(e);
  }
}
