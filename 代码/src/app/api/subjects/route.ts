import type { NextRequest } from 'next/server';
import { fail, ok, readJson } from '@/lib/api';
import {
  createSubject,
  listSubjectViews,
  renameSubject,
  SUBJECT_IDS,
  SUBJECT_NAME_MAX,
  switchSubject,
  MAX_SUBJECTS,
  subjectsFilePath,
} from '@/lib/subjects';

export const dynamic = 'force-dynamic';

/**
 * GET /api/subjects — 学科列表（顶栏的切换条、设置页的「当前题库」都用它）
 *
 * 返回的每个学科都带上它的题库目录 —— 设置页要显示"题库存哪了"，
 * 这句话必须来自**唯一一处**路径解析（subjects.ts），不能在界面上再拼一遍。
 */
export async function GET() {
  try {
    const subs = listSubjectViews();
    return ok({
      active: subs.find((s) => s.active)?.id ?? '',
      subjects: subs,
      /** 上限直接给界面用，免得两边各写一个数 */
      max: MAX_SUBJECTS,
      nameMax: SUBJECT_NAME_MAX,
      letters: SUBJECT_IDS,
      registryFile: subjectsFilePath(),
    });
  } catch (e) {
    return fail(e);
  }
}

/**
 * POST /api/subjects — 新建 / 切换 / 改名
 *
 *   {action:'create', name}   新建（≤5 字；最多 5 个；建成后自动切过去）
 *   {action:'switch', id}     切换当前学科
 *   {action:'rename', id, name}  改名字（**只改 name，不动目录**）
 */
export async function POST(req: NextRequest) {
  try {
    const body = await readJson(req);
    const action = String(body.action ?? '');

    if (action === 'create') {
      const { subject, registry } = createSubject(String(body.name ?? ''));
      return ok({ subject, active: registry.active, subjects: listSubjectViews() }, 201);
    }

    if (action === 'switch') {
      const id = String(body.id ?? '').trim();
      if (!id) return ok({ error: '缺少 id' }, 400);
      switchSubject(id);
      return ok({ active: id });
    }

    if (action === 'rename') {
      const id = String(body.id ?? '').trim();
      if (!id) return ok({ error: '缺少 id' }, 400);
      renameSubject(id, String(body.name ?? ''));
      return ok({ renamed: id });
    }

    return ok({ error: `未知操作：${action || '(空)'}` }, 400);
  } catch (e) {
    // 学科名字/数量的问题都是"人能自己修"的，回 400 并把原话带上
    const msg = (e as Error).message;
    if (/名字|最多|已经有一个|字母/.test(msg)) return ok({ error: msg }, 400);
    return fail(e);
  }
}
