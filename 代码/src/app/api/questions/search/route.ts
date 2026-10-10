import type { NextRequest } from 'next/server';
import { searchQuestions } from '@/lib/service';
import { fail, ok, queryList, queryNumber } from '@/lib/api';
import { findSubject, withSubject } from '@/lib/subjects';
import {
  QUESTION_KINDS,
  QUESTION_TYPES,
  DIFFICULTY_BANDS,
  isDifficultyBand,
  type SearchParams,
} from '@/lib/types';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;

    const kindRaw = sp.get('kind');
    const kind = (QUESTION_KINDS as readonly string[]).includes(kindRaw ?? '')
      ? (kindRaw as SearchParams['kind'])
      : undefined;

    const typeRaw = sp.get('type');
    const type = (QUESTION_TYPES as readonly string[]).includes(typeRaw ?? '')
      ? (typeRaw as SearchParams['type'])
      : undefined;

    const statusRaw = sp.get('status');
    const status =
      statusRaw === '停用' || statusRaw === '全部'
        ? statusRaw
        : statusRaw === '启用'
          ? '启用'
          : undefined;

    // v2：难度档位（可重复或逗号分隔）
    const bands = queryList(sp, 'bands').filter(isDifficultyBand);
    // v2：只看创新题
    const innovation = sp.get('innovation') === '1';
    // v3：年份（可重复或逗号分隔）—— 单题与整卷都适用
    const years = queryList(sp, 'year')
      .concat(queryList(sp, 'years'))
      .map((v) => Number(v))
      .filter((n) => Number.isInteger(n));
    // v2：列表要直接渲染题目 → 把这一页的题干/答案一并带回
    const withContent = sp.get('withContent') === '1';

    const params: SearchParams = {
      q: sp.get('q') ?? undefined,
      kind,
      type,
      source: sp.get('source') ?? undefined,
      knowledge: queryList(sp, 'knowledge'),
      status: status ?? '启用',
      page: queryNumber(sp, 'page') ?? 1,
      size: queryNumber(sp, 'size') ?? 10,
    };
    if (bands.length) params.bands = bands;
    if (innovation) params.innovation = true;
    if (years.length) params.years = Array.from(new Set(years));
    if (!params.knowledge?.length) delete params.knowledge;

    /*
     * 数值范围参数 —— 这四个以前**漏读了**，是个真 bug：
     *   SearchParams 里有 numMin/numMax/diffMin/diffMax，searchEntries 也认真按它们过滤，
     *   但 HTTP 层从来没把它们从 query string 里读出来 → 条件被静默丢弃。
     *
     * 症状：录入页的「同来源 + 同题号」查重发的是 numMin=N&numMax=N，
     *       被丢掉后只剩来源条件，于是返回该来源的**全部**题目，
     *       再取 items[0]（同源里 qid 最小的那道）——
     *       **题号填几都报重复，且报的永远是同一道题**。
     * 之所以一直没被发现：浏览页的筛选界面没用到这几个参数，只有录入页查重在用。
     */
    const numMin = queryNumber(sp, 'numMin');
    const numMax = queryNumber(sp, 'numMax');
    const diffMin = queryNumber(sp, 'diffMin');
    const diffMax = queryNumber(sp, 'diffMax');
    if (numMin !== undefined) params.numMin = numMin;
    if (numMax !== undefined) params.numMax = numMax;
    if (diffMin !== undefined) params.diffMin = diffMin;
    if (diffMax !== undefined) params.diffMax = diffMax;

    // v9：`?subject=B` = 在**那个学科**里检索（录入页的查重需要它：
    // 选了别的学科再录入时，查重也得查那个学科，否则会误报/漏报重复）
    const subjectRaw = sp.get('subject');
    const subject = subjectRaw && findSubject(subjectRaw) ? subjectRaw : null;

    if (subject) return withSubject(subject, () => ok(searchQuestions(params, withContent)));
    return ok(searchQuestions(params, withContent));
  } catch (e) {
    return fail(e);
  }
}

/** 让前端能拿到可选档位清单（免得硬编码） */
export async function OPTIONS() {
  return ok({ bands: DIFFICULTY_BANDS });
}
