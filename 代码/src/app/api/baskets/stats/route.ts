import { draftQids, draftStats } from '@/lib/baskets';
import { fail, ok } from '@/lib/api';

export const dynamic = 'force-dynamic';

/**
 * GET /api/baskets/stats — 浏览页侧边那张「试题篮」卡片的数据（v7）
 *
 * 为什么单独开一个接口，而不是给 `/api/baskets` 加字段：
 * 那个接口为了让试题篮**直接显示题目**，会把整篮的题干/答案/图片清单全读出来
 * （`decorate()` 对每道题调 `readContent`）。浏览页只是要显示
 * 「一共多少题、每个题型多少题」，为它付那份代价不值得 ——
 * 这个接口**只读索引，不读正文**。
 *
 * 同时返回 `draftQids`：浏览页要用它画勾选态。一个请求拿两样，省一次往返。
 *
 * `papers` 是把老数据里的整卷报出来（v7 起整卷不允许进篮子）。
 * 界面据此提示你移出，而不是让它悄悄消失。
 */
export async function GET() {
  try {
    const stats = draftStats();
    return ok({
      total: stats.total,
      byType: stats.byType,
      papers: stats.papers,
      draftQids: [...draftQids()],
    });
  } catch (e) {
    return fail(e);
  }
}
