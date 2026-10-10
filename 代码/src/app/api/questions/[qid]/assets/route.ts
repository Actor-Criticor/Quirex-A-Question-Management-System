import type { NextRequest } from 'next/server';
import { addImage, getQuestion } from '@/lib/service';
import { toPortableImage } from '@/lib/imageConvert';
import { fail, ok } from '@/lib/api';
import { resolveQid } from '@/lib/paths';

export const dynamic = 'force-dynamic';

/**
 * POST /api/questions/[qid]/assets — 上传图片（四通道）
 *
 * multipart/form-data：
 *   channel = stem | fig | ans | ansfig   （角色由用户声明，程序不猜）
 *   file    = 图片文件
 *
 * 文件名一律 {qid}-{channel}-NN.ext → 全库唯一 → 导出时只复制文件、不改 .tex。
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ qid: string }> }
) {
  try {
    const qid = resolveQid((await params).qid);
    const fd = await req.formData();

    const channel = fd.get('channel');
    const file = fd.get('file');
    if (!file || typeof file === 'string') {
      return ok({ error: '缺少 file 字段' }, 400);
    }

    const raw = Buffer.from(await file.arrayBuffer());
    const originalName = (file as File).name || 'upload.png';
    const converted = await toPortableImage(raw, originalName);

    const result = addImage(qid, channel, converted.buf, converted.ext);
    const full = getQuestion(qid);

    return ok(
      {
        ...result,
        note: converted.note,
        assets: full.assets,
      },
      201
    );
  } catch (e) {
    return fail(e);
  }
}
