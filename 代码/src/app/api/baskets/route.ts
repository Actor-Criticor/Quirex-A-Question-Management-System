import type { NextRequest } from 'next/server';
import {
  addToDraft,
  clearDraft,
  currentSnapshotId,
  deleteSnapshot,
  draftQids,
  getDraft,
  listSaved,
  loadSnapshot,
  papersRejectedMessage,
  removeFromDraft,
  renameSnapshot,
  saveSnapshot,
  setDraftExportOptions,
  setDraftQids,
  type BasketExportOptions,
} from '@/lib/baskets';
import { fail, ok, readJson } from '@/lib/api';
import { loadIndexOrRebuild } from '@/lib/searchIndex';
import { listAssets, readContent } from '@/lib/store';

export const dynamic = 'force-dynamic';

/**
 * v3：试题篮只剩两栏 ——「正在编辑」和「已保存的快照」。
 *
 * 给浏览器用的题目视图：篮子要**直接显示题目**，所以连题干/答案/图片清单一起带回
 * （篮子通常只有几十道，一次全带比逐题再查划算）。
 */
function decorate(qids: string[]) {
  const byQid = new Map(loadIndexOrRebuild().map((e) => [e.qid, e]));
  return qids.map((qid) => {
    const entry = byQid.get(qid);
    return {
      qid,
      missing: !entry,
      kind: entry?.kind,
      type: entry?.type,
      source: entry?.source,
      number: entry?.number,
      difficulty: entry?.difficulty,
      year: entry?.year,
      // v5：把已解析的配图位置也带上，网页才能和 PDF 靠同一边
      figAlign: entry?.figAlign,
      knowledge: entry?.knowledge,
      innovation: entry?.innovation,
      descPreview: entry?.descPreview,
      status: entry?.status,
      hasPdf: entry?.hasPdf,
      hasImages: entry?.hasImages,
      // 正文（整卷没有题干，是空串）
      stem: entry ? readContent(qid, 'stem') : '',
      answer: entry ? readContent(qid, 'answer') : '',
      assets: entry ? listAssets(qid).map((a) => a.name) : [],
    };
  });
}

/**
 * GET /api/baskets?page=1&size=15
 *
 * 返回：
 *   draft       —— 正在编辑（含逐题正文）
 *   saved       —— 已保存快照的**当前页**（不含正文，列表只要名字/题数/时间）
 *   savedTotal  —— 快照总数（供分页）
 *   currentId   —— 内容与「正在编辑」完全相同的那条（导出时"标题留空就用它的名字"）
 *   draftQids   —— 浏览页勾选态用的 qid 列表（**只反映正在编辑**）
 *
 * 浏览页**不用**这个接口（它会把整篮的题干答案都读出来）；那边走
 * `/api/baskets/stats`（只读索引）。
 */
export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    const page = Math.max(1, Number(sp.get('page') ?? 1) || 1);
    const size = Math.min(200, Math.max(1, Number(sp.get('size') ?? 15) || 15));

    const draft = getDraft();
    const all = listSaved();
    const start = (page - 1) * size;

    return ok({
      draft: {
        qids: draft.qids,
        exportOptions: draft.exportOptions,
        count: draft.qids.length,
        items: decorate(draft.qids),
      },
      saved: all.slice(start, start + size).map((b) => ({
        id: b.id,
        name: b.name,
        count: b.qids.length,
        createdAt: b.createdAt,
        updatedAt: b.updatedAt,
      })),
      savedTotal: all.length,
      savedPage: page,
      savedSize: size,
      currentId: currentSnapshotId(),
      draftQids: [...draftQids()],
    });
  } catch (e) {
    return fail(e);
  }
}

/**
 * POST /api/baskets — 单一 action 端点。
 *
 *   {action:'add',    qids[]}           加入正在编辑（浏览页勾选）
 *   {action:'remove', qid}              移出正在编辑（取消勾选）
 *   {action:'set',    qids[]}           整体替换/重排
 *   {action:'clear'}                    清空正在编辑
 *   {action:'options', exportOptions}   改正在编辑的导出选项
 *   {action:'save',   name?}            给当前内容拍快照（默认名 = 日期+时间）
 *   {action:'load',   id}               载入副本（自动保存当前 + 载入该条，该条不移除）
 *   {action:'rename', id, name}         重命名快照
 *   {action:'delete', id}               删除快照
 */
export async function POST(req: NextRequest) {
  try {
    const body = await readJson(req);
    const action = String(body.action ?? '');

    switch (action) {
      case 'add': {
        const qids = Array.isArray(body.qids) ? body.qids.map((q) => String(q)) : [];
        const r = addToDraft(qids);
        if (r.invalid.length) {
          return ok({ error: `这些 qid 不存在，已跳过：${r.invalid.join(', ')}` }, 400);
        }
        // v7：整卷单独回一条，原因与"qid 不存在"完全不同
        if (r.papers.length) {
          return ok({ error: papersRejectedMessage(r.papers), papers: r.papers }, 400);
        }
        return ok({ added: r.added, skipped: r.skipped, count: getDraft().qids.length });
      }

      case 'remove':
        removeFromDraft(String(body.qid ?? ''));
        return ok({ count: getDraft().qids.length });

      case 'set': {
        const qids = Array.isArray(body.qids) ? body.qids.map((q) => String(q)) : [];
        const r = setDraftQids(qids);
        if (r.invalid.length) {
          return ok({ error: `这些 qid 不存在，已跳过：${r.invalid.join(', ')}` }, 400);
        }
        // 整卷被静默丢掉的话，界面上的顺序就与请求不符了 —— 要说出来
        if (r.papers.length) {
          return ok({ error: papersRejectedMessage(r.papers), papers: r.papers }, 400);
        }
        return ok({ count: getDraft().qids.length });
      }

      case 'clear':
        clearDraft();
        return ok({ count: 0 });

      case 'options':
        setDraftExportOptions((body.exportOptions ?? {}) as BasketExportOptions);
        return ok({ exportOptions: getDraft().exportOptions });

      case 'save': {
        const snap = saveSnapshot(body.name === undefined ? undefined : String(body.name));
        return ok({ snapshot: snap, currentId: currentSnapshotId() }, 201);
      }

      case 'load': {
        const r = loadSnapshot(String(body.id ?? ''));
        return ok({
          draft: { qids: r.draft.qids, count: r.draft.qids.length },
          autoSaved: r.autoSaved,
          loaded: r.loaded,
          skippedPapers: r.skippedPapers,
          currentId: currentSnapshotId(),
        });
      }

      case 'rename': {
        const b = renameSnapshot(String(body.id ?? ''), String(body.name ?? ''));
        return ok({ snapshot: b, currentId: currentSnapshotId() });
      }

      case 'delete':
        deleteSnapshot(String(body.id ?? ''));
        return ok({ deleted: body.id, currentId: currentSnapshotId() });

      default:
        return ok({ error: `未知操作：${action || '(空)'}` }, 400);
    }
  } catch (e) {
    return fail(e);
  }
}
