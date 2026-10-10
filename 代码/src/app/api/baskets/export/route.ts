import type { NextRequest } from 'next/server';
import { defaultSnapshotName, getDraft, currentSnapshotId, listSaved } from '@/lib/baskets';
import { exportHandout } from '@/lib/latexExport';
import { fail, ok, readJson } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * POST /api/baskets/export
 *
 * v3：导出的永远是**「正在编辑」**。要导某条历史快照，先在界面上用
 * 「替换为当前编辑」把它载入，再导出 —— 保持「一个正在编辑」这条主线不破。
 *
 * 生成完整的可编译导出文件夹（题目.tex / 答案.tex + 模板声明的样式文件 + images/ +
 * 整卷/ + build.bat），然后自动跑 xelatex，把编译结果回报给界面。
 * 导出不清空任何东西 —— 可以接着调整再导一次。
 */
export async function POST(req: NextRequest) {
  try {
    const body = await readJson(req).catch(() => ({}) as Record<string, unknown>);
    const draft = getDraft();
    if (draft.qids.length === 0) return ok({ error: '试题篮是空的' }, 400);

    // 标题优先级：请求里显式给的 > 「正在编辑」存下的标题 > 当前快照名 > 时间戳
    const currentId = currentSnapshotId();
    const currentName = listSaved().find((b) => b.id === currentId)?.name;
    const title =
      String(body.title ?? '').trim() ||
      String(draft.exportOptions?.title ?? '').trim() ||
      currentName ||
      defaultSnapshotName();

    const result = await exportHandout({
      title,
      qids: draft.qids,
      options: draft.exportOptions,
    });

    const qc = result.compile.questions;
    const ac = result.compile.answers;

    return ok({
      folder: result.folder,
      // 导出文件夹的**绝对路径** —— 界面上「打开文件夹」要用
      outDir: result.outDir,
      title,
      count: result.count,
      imageCount: result.imageCount,
      warnings: result.warnings,
      // v6：分段耗时（读题/写文件/编译），界面上显示"慢在哪"
      timings: result.timings,
      // v2：两个 PDF 分别报告
      compile: {
        ok: result.compile.ok,
        pdfs: result.compile.pdfs,
        questions: {
          ok: qc.ok,
          pdfExists: qc.pdfExists,
          errorCount: qc.errorCount,
          warningCount: qc.warningCount,
          // v6：实际跑了几遍 xelatex（正常 1 遍；日志要求 Rerun 时才 2 遍）
          passes: qc.passes,
          ms: qc.ms,
        },
        answers: {
          ok: ac.ok,
          pdfExists: ac.pdfExists,
          errorCount: ac.errorCount,
          warningCount: ac.warningCount,
          passes: ac.passes,
          ms: ac.ms,
        },
      },
      // 哪个 PDF 出错就把它的日志带回去，界面直接显示
      compileLog: result.compile.ok
        ? ''
        : [qc.ok ? '' : `【题目.pdf】\n${qc.log}`, ac.ok ? '' : `【答案.pdf】\n${ac.log}`]
            .filter(Boolean)
            .join('\n\n'),
    });
  } catch (e) {
    return fail(e);
  }
}
