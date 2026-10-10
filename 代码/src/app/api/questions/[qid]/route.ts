import type { NextRequest } from 'next/server';
import { getQuestion, updateQuestion, type UpdateQuestionPatch } from '@/lib/service';
import { fail, ok, readJson } from '@/lib/api';
import {
  checkImageRefs,
  findOrphanImages,
  imageBasename,
  lintLatex,
  splitSegments,
} from '@/lib/latexSubset';
import { resolveQid } from '@/lib/paths';

export const dynamic = 'force-dynamic';

/** GET /api/questions/[qid] — 详情（元数据 + 题干/答案 + 图片 + PDF） */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ qid: string }> }
) {
  try {
    const qid = resolveQid((await params).qid);
    const full = getQuestion(qid);

    const files = new Set(full.assets.map((a) => a.name));
    const problems = [
      ...lintLatex(full.stem, '题干'),
      ...lintLatex(full.answer, '答案'),
      ...checkImageRefs(full.stem, files),
      ...checkImageRefs(full.answer, files),
    ];

    const referenced = [...splitSegments(full.stem), ...splitSegments(full.answer)]
      .filter((s) => s.type === 'image')
      .map((s) => imageBasename(s.value));
    const orphans = findOrphanImages([...files], referenced);

    return ok({ ...full, problems, orphanImages: orphans });
  } catch (e) {
    return fail(e);
  }
}

/** PATCH /api/questions/[qid] — 改元数据（不含正文；正文走 /content） */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ qid: string }> }
) {
  try {
    const qid = resolveQid((await params).qid);
    const body = await readJson(req);
    const patch: UpdateQuestionPatch = {
      type: body.type,
      source: body.source,
      number: body.number,
      difficulty: body.difficulty,
      knowledge: body.knowledge,
      // v9：自定义标签（又是这个白名单 —— 新增可改字段必须同步这里）
      custom: body.custom,
      description: body.description,
      status: body.status,
      // v2 的 innovation 以前漏在这个白名单外 —— 结果录入之后再也没法改创新标记。
      // v3 一并补上（服务端仍会按 kind 兜底：整卷的会被丢弃）。
      innovation: body.innovation,
      // v3：年份
      year: body.year,
      // v5：配图位置（仅单题；空串 = 回到"按题型推导"）
      // 注意：这个白名单漏过一次（v3 的 innovation）、又漏过一次（v5 的 figAlign）——
      // 新增可改字段时**必须同步这里**，否则 PATCH 静默无效。
      figAlign: body.figAlign,
      figures: body.figures as UpdateQuestionPatch['figures'],
    };
    // 过滤掉未提供的字段，避免把 undefined 当成"清空"
    for (const key of Object.keys(patch) as Array<keyof UpdateQuestionPatch>) {
      if (!(key in body)) delete patch[key];
    }

    const result = updateQuestion(qid, patch);
    return ok(result);
  } catch (e) {
    return fail(e);
  }
}

/** DELETE /api/questions/[qid] — 题目永远不可删除，只有停用 */
export async function DELETE() {
  return ok(
    {
      error: '题目不可删除，只能停用。',
    },
    405
  );
}
