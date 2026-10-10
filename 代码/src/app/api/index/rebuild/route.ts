import { rebuildIndex } from '@/lib/service';
import { fail, ok } from '@/lib/api';

export const dynamic = 'force-dynamic';

/** POST /api/index/rebuild — 重建检索索引（扫描题库目录） */
export async function POST() {
  try {
    const entries = rebuildIndex();
    return ok({ count: entries.length });
  } catch (e) {
    return fail(e);
  }
}
