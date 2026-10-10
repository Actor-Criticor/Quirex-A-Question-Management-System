import type { NextRequest } from 'next/server';
import { readPdf } from '@/lib/store';
import { fail } from '@/lib/api';
import { resolveQid } from '@/lib/paths';

export const dynamic = 'force-dynamic';

/** GET /api/questions/[qid]/pdf/[role] — 取整卷 PDF（详情页内嵌阅读器用） */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ qid: string; role: string }> }
) {
  try {
    const { role } = await params;
    const qid = resolveQid((await params).qid);
    if (role !== 'paper' && role !== 'answer') {
      return new Response('role 只能是 paper 或 answer', { status: 400 });
    }

    const buf = readPdf(qid, role);
    if (!buf) return new Response('PDF 不存在', { status: 404 });

    const label = role === 'paper' ? '题目' : '答案';
    return new Response(new Uint8Array(buf), {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Length': String(buf.length),
        // inline 才能被浏览器内置阅读器内嵌显示
        'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(
          `${qid}-${label}.pdf`
        )}`,
        'Cache-Control': 'private, max-age=60',
      },
    });
  } catch (e) {
    return fail(e);
  }
}
