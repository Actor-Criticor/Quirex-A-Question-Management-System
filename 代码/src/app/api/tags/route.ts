import type { NextRequest } from 'next/server';
import { addTag, listTags, listYears, nextQidPreview } from '@/lib/service';
import { fail, ok, readJson } from '@/lib/api';
import { isTagKind } from '@/lib/types';
import { findSubject, withSubject } from '@/lib/subjects';

export const dynamic = 'force-dynamic';

/**
 * v9：`?subject=B` = 读**那个学科**的标签表。
 *
 * 录入页要"先选学科、再选那个学科里有的标签"，而标签表在学科的 `_meta/` 里，
 * 所以必须能指名读哪个学科 —— 默认（不传）就是当前学科。
 */
function subjectParam(req: NextRequest): string | null {
  const s = req.nextUrl.searchParams.get('subject');
  if (!s) return null;
  if (!findSubject(s)) return null; // 不认识的字母就当没传，读当前学科
  return s;
}

/** GET /api/tags?includeRetired=1[&subject=B] — 有效标签表（含引用计数）+ 年份 facet */
export async function GET(req: NextRequest) {
  try {
    const includeRetired = req.nextUrl.searchParams.get('includeRetired') === '1';
    const subject = subjectParam(req);
    const read = () =>
      ok({
        vocab: listTags(includeRetired),
        // v3：年份是检索 facet，跟标签词表一起回（不占独立请求）
        years: listYears(),
        nextQid: nextQidPreview(),
        subject: subject ?? '',
      });
    return subject ? withSubject(subject, read) : read();
  } catch (e) {
    return fail(e);
  }
}

/** POST /api/tags — 手工登记一个暂无题目引用的标签 */
export async function POST(req: NextRequest) {
  try {
    const body = await readJson(req);
    if (!isTagKind(body.kind)) return ok({ error: '标签维度无效' }, 400);
    addTag(body.kind, String(body.name ?? ''));
    return ok({ vocab: listTags(true) });
  } catch (e) {
    return fail(e);
  }
}
