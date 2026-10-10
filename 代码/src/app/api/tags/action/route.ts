import type { NextRequest } from 'next/server';
import {
  addTag,
  listBackups,
  listTags,
  previewPurge,
  previewRename,
  purgeTag,
  renameTag,
  restoreBackup,
  restoreTag,
  retireTag,
} from '@/lib/service';
import { fail, ok, readJson } from '@/lib/api';
import { isTagKind } from '@/lib/types';

export const dynamic = 'force-dynamic';

/**
 * POST /api/tags/action — 标签操作统一入口
 *
 * op:
 *   add            手工登记
 *   retire         停用（= 删除；题上值不动，O(1) 零风险）
 *   restore        恢复
 *   renamePreview  改名/合并前的影响预览（dry-run）
 *   rename         改名（撞名即合并；带备份 + 审计）
 *   purgePreview   彻底清除前的影响预览
 *   purge          彻底清除（带备份 + 审计）
 *   restoreBackup  从备份还原
 */
export async function POST(req: NextRequest) {
  try {
    const body = await readJson(req);
    const op = String(body.op ?? '');
    const kind = body.kind;
    const name = String(body.name ?? '');
    const to = String(body.to ?? '');

    const needKind = op !== 'restoreBackup';
    if (needKind && !isTagKind(kind)) return ok({ error: '标签维度无效' }, 400);

    switch (op) {
      case 'add': {
        addTag(kind as never, name);
        break;
      }
      case 'retire': {
        retireTag(kind as never, name);
        break;
      }
      case 'restore': {
        restoreTag(kind as never, name);
        break;
      }
      case 'renamePreview': {
        return ok({ preview: previewRename(kind as never, name, to) });
      }
      case 'rename': {
        const result = renameTag(kind as never, name, to);
        return ok({ ...result, vocab: listTags(true) });
      }
      case 'purgePreview': {
        return ok({ preview: previewPurge(kind as never, name) });
      }
      case 'purge': {
        const result = purgeTag(kind as never, name);
        return ok({ ...result, vocab: listTags(true) });
      }
      case 'restoreBackup': {
        const result = restoreBackup(String(body.id ?? ''));
        return ok({ ...result, vocab: listTags(true) });
      }
      default:
        return ok({ error: `未知操作：${op}` }, 400);
    }

    return ok({ vocab: listTags(true) });
  } catch (e) {
    return fail(e);
  }
}

/** GET /api/tags/action — 备份列表 */
export async function GET() {
  try {
    return ok({ backups: listBackups() });
  } catch (e) {
    return fail(e);
  }
}
