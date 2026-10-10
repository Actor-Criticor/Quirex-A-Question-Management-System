'use client';

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { QuestionBody } from '@/components/LatexContent';
import { Pager } from '@/components/Pager';
import { SearchSuggest, type SuggestItem } from '@/components/SearchSuggest';
import { usePager } from '@/components/usePager';
import { useScrollRestore } from '@/components/useScrollRestore';
import { difficultyText } from '@/lib/validate';
import {
  DIFFICULTY_BANDS,
  QUESTION_TYPES,
  displayQid,
  truncateCustomTag,
  type DifficultyBand,
  type IndexEntry,
  type SearchResult,
  type TagItem,
} from '@/lib/types';
import styles from './page.module.css';

const PAGE_SIZE = 10;
/** v3：筛选面板里每个分组每页最多 20 个（年份 / 知识点各自分页） */
const FACET_PAGE_SIZE = 20;

interface YearFacet {
  year: number;
  count: number;
  enabledCount: number;
}

/** v7：浏览页只关心"篮子里有什么"（勾选态 + 计数），不再拉整篮正文 */
interface BasketStats {
  error?: string;
  total?: number;
  byType?: Record<string, number>;
  /** 历史遗留的整卷（v7 起不允许进篮子） */
  papers?: string[];
  draftQids?: string[];
}

type KindTab = '单题' | '整卷';
type FacetGroup = '年份' | '知识点';

// ============================================================
// v8：把「筛选条件 + 页码」放进 URL —— 返回上一页才回得来
// ============================================================
//
// 上一轮我把「返回上一页」只做成了 router.back()，那是错的：
// back() 确实回到了 `/` 这个路由，但这个页面的页签/筛选/页码**全是组件内部 state**，
// 一挂载就用默认值 —— 于是"从整卷第 2 页点进详情，返回后变成单题第 1 页"。
//
// 做法：把 URL 的查询串当成一个**外部 store**，用 useSyncExternalStore 订阅。
// 为什么不是普通 useState：
//   · 首次渲染读 window.location 会让 SSR 与客户端首帧不一致 → hydration 报错
//     （实测踩到：服务端给「单题」高亮、客户端给「整卷」）。
//     useSyncExternalStore 有"服务端快照"这个概念，正是为这种场景准备的：
//     服务端用 getServerSnapshot()，hydrate 完再切到真实值。
//   · 监听 popstate → 浏览器前进/后退时状态自动跟着变，不用手写同步。
//
// 写回用 **history.replaceState** 而不是 pushState：
// 每点一下筛选项都往历史里堆一条的话，back() 会变成"撤销上一次点击"。
// 也没走 next 的 router.replace —— 那会触发软导航（可能重挂组件，搜索框打字会丢焦点）。
const URL_CHANGE_EVENT = 'quirex:urlchange';

function subscribeUrl(cb: () => void): () => void {
  window.addEventListener('popstate', cb);
  window.addEventListener(URL_CHANGE_EVENT, cb);
  return () => {
    window.removeEventListener('popstate', cb);
    window.removeEventListener(URL_CHANGE_EVENT, cb);
  };
}

/** 客户端快照：当前查询串（字符串是原始值，React 不会因为它"每次都是新对象"而循环） */
function clientSearch(): string {
  return window.location.search;
}

/** 服务端快照：一律空 —— 服务端渲染的就是"没有任何筛选"的默认视图 */
function serverSearch(): string {
  return '';
}

function writeUrl(next: URLSearchParams): void {
  const qs = next.toString();
  const want = qs ? `?${qs}` : '';
  if (window.location.search === want) return;
  window.history.replaceState(null, '', `${window.location.pathname}${want}`);
  window.dispatchEvent(new Event(URL_CHANGE_EVENT));
}

// ============================================================
// v8b：滚动位置也按 URL 记住
// ============================================================
//
// 光把"页签 + 页码"写进 URL 还不够：你在第 2 页滑到底、点开一道题、再点返回，
// 会回到第 2 页的**最上面**，长列表里等于又丢了一次位置。
//
// 所以另存一份 `URL → 滚动距离`，回同一个视图时滚回原处 ——
// v10 起这件事交给公共 hook `useScrollRestore`（试题篮页用同一套），
// 三个坑与对策都写在那里面。

export default function BrowsePage() {
  // ---- 筛选条件：全部从 URL 派生（URL 是唯一真源）----
  const search = useSyncExternalStore(subscribeUrl, clientSearch, serverSearch);
  const sp = useMemo(() => new URLSearchParams(search), [search]);

  const tab: KindTab = sp.get('kind') === '整卷' ? '整卷' : '单题';
  const q = sp.get('q') ?? '';
  const bands = useMemo(
    () => sp.getAll('bands').filter((b): b is DifficultyBand => (DIFFICULTY_BANDS as readonly string[]).includes(b)),
    [sp]
  );
  const innovation = sp.get('innovation') === '1';
  const type = sp.get('type') ?? '';
  const knowledge = useMemo(() => sp.getAll('knowledge'), [sp]);
  const years = useMemo(
    () => sp.getAll('year').map((y) => Number(y)).filter((y) => Number.isInteger(y)),
    [sp]
  );
  const status = sp.get('status') ?? '启用';
  const page = Math.max(1, Number(sp.get('page') ?? 1) || 1);

  /**
   * 改筛选条件：从当前 URL 出发改，并**顺手删掉 page**（条件一变就回第 1 页）。
   * 所有 setter 都走这里，就不会出现"改了筛选却停在第 3 页"这种状态。
   */
  const patch = useCallback(
    (fn: (p: URLSearchParams) => void) => {
      const next = new URLSearchParams(sp.toString());
      next.delete('page');
      fn(next);
      writeUrl(next);
    },
    [sp]
  );

  const setTab = (t: KindTab) => patch((p) => (t === '整卷' ? p.set('kind', t) : p.delete('kind')));
  const setQ = (v: string) => patch((p) => (v.trim() ? p.set('q', v) : p.delete('q')));
  const setType = (v: string) => patch((p) => (v ? p.set('type', v) : p.delete('type')));
  const setStatus = (v: string) => patch((p) => (v === '启用' ? p.delete('status') : p.set('status', v)));
  const setInnovation = (v: boolean) => patch((p) => (v ? p.set('innovation', '1') : p.delete('innovation')));

  /** 多值参数（bands / knowledge / year）统一按"有就删、没有就加"改 */
  const toggleMulti = (key: string, value: string) =>
    patch((p) => {
      const cur = p.getAll(key);
      p.delete(key);
      const nextVal = cur.includes(value) ? cur.filter((x) => x !== value) : [...cur, value];
      nextVal.forEach((x) => p.append(key, x));
    });

  const toggleBand = (b: DifficultyBand) => toggleMulti('bands', b);
  const toggleKnowledge = (name: string) => toggleMulti('knowledge', name);
  const toggleYear = (y: number) => toggleMulti('year', String(y));

  const setPage = useCallback(
    (n: number) => {
      const next = new URLSearchParams(sp.toString());
      if (n > 1) next.set('page', String(n));
      else next.delete('page');
      writeUrl(next);
    },
    [sp]
  );

  // ---- 筛选面板（v3：常驻一行 + 展开面板，面板内分组分页）----
  const [panelOpen, setPanelOpen] = useState(false);
  const [facetGroup, setFacetGroup] = useState<FacetGroup>('知识点');
  const [facetQuery, setFacetQuery] = useState('');

  // ---- 数据 ----
  const [result, setResult] = useState<SearchResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [vocab, setVocab] = useState<{
    source: TagItem[];
    knowledge: TagItem[];
    custom: TagItem[];
  } | null>(null);
  const [yearsFacet, setYearsFacet] = useState<YearFacet[]>([]);
  const [error, setError] = useState('');

  // ---- 试题篮（v7：只拿"有多少 / 勾了哪些"，不拿正文） ----
  const [basket, setBasket] = useState<BasketStats>({});
  const [inBasket, setInBasket] = useState<Set<string>>(new Set());
  const [basketError, setBasketError] = useState('');

  /** v7：翻页后滚到列表最上方（结果条那一行） */
  const listTopRef = useRef<HTMLDivElement>(null);

  const knowledgeKey = knowledge.join('\u0001');
  const yearsKey = years.join(',');

  /** v7：刷新篮子状态（只打轻量接口 —— 不读正文） */
  const refreshBasket = useCallback((d: BasketStats) => {
    if (!d || d.error) return;
    setBasket(d);
    setInBasket(new Set<string>(d.draftQids ?? []));
  }, []);

  // 挂载时加载：setState 放在 .then 回调里
  useEffect(() => {
    fetch('/api/baskets/stats', { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => refreshBasket(d as BasketStats))
      .catch(() => {
        /* 篮子不可用不影响浏览 */
      });

    fetch('/api/tags', { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => {
        setVocab(d.vocab);
        setYearsFacet(Array.isArray(d.years) ? (d.years as YearFacet[]) : []);
      })
      .catch(() => {
        setVocab(null);
        setYearsFacet([]);
      });
  }, [refreshBasket]);

  const queryString = useMemo(() => {
    const qs = new URLSearchParams();
    if (q.trim()) qs.set('q', q.trim());
    qs.set('kind', tab);
    if (tab === '单题' && type) qs.set('type', type);
    bands.forEach((b) => qs.append('bands', b));
    // v2：创新只属于单题
    if (innovation && tab === '单题') qs.set('innovation', '1');
    knowledge.forEach((k) => qs.append('knowledge', k));
    // v3：年份
    years.forEach((y) => qs.append('year', String(y)));
    qs.set('status', status);
    qs.set('page', String(page));
    qs.set('size', String(PAGE_SIZE));
    // 列表要直接渲染题目，一次把这 10 道的正文带回来
    qs.set('withContent', '1');
    return qs.toString();
  }, [tab, q, type, bands, innovation, knowledge, years, status, page]);

  useEffect(() => {
    let alive = true;
    const timer = setTimeout(async () => {
      if (alive) setLoading(true);
      try {
        const res = await fetch(`/api/questions/search?${queryString}`, { cache: 'no-store' });
        const data = await res.json();
        if (!alive) return;
        if (data.error) {
          setError(data.error);
          setResult(null);
        } else {
          setError('');
          setResult(data as SearchResult);
        }
      } catch (e) {
        if (alive) setError((e as Error).message);
      } finally {
        if (alive) setLoading(false);
      }
    }, 150);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [queryString]);

  // ---- v8b：滚动位置的保存与恢复 ----
  // v10 抽成公共 hook（试题篮页也要同一套行为），三个坑的说明都在那个文件里
  useScrollRestore('/', !loading && !!result);

  /** 清除筛选 = 把 URL 里的参数全清掉（回默认视图 + 第 1 页） */
  const clearFilters = () => writeUrl(new URLSearchParams());

  /**
   * v3：勾选 = 加入「正在编辑」；取消勾选 = 移出。
   * 这是**唯一**的加入操作（不再有「先勾选再点加入试题篮」两步）。
   * 先乐观更新界面（点下去就有反应），失败再回滚。
   *
   * v7：整卷的勾选框根本不渲染（整卷进不了篮子），所以这里不必再判 kind。
   */
  const toggleBasket = async (qid: string) => {
    const was = inBasket.has(qid);
    setBasketError('');

    setInBasket((prev) => {
      const next = new Set(prev);
      if (was) next.delete(qid);
      else next.add(qid);
      return next;
    });

    try {
      const res = await fetch('/api/baskets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(was ? { action: 'remove', qid } : { action: 'add', qids: [qid] }),
      });
      const d = await res.json();
      if (d.error) throw new Error(d.error);
      // 计数与分题型统计交给服务端算（它读的是索引，比前端自己数可靠）
      await fetch('/api/baskets/stats', { cache: 'no-store' })
        .then((r) => r.json())
        .then((s) => refreshBasket(s as BasketStats));
    } catch (e) {
      // 回滚
      setInBasket((prev) => {
        const next = new Set(prev);
        if (was) next.add(qid);
        else next.delete(qid);
        return next;
      });
      setBasketError((e as Error).message);
      setTimeout(() => setBasketError(''), 4000);
    }
  };

  const totalPages = result ? Math.max(1, Math.ceil(result.total / result.size)) : 1;
  const chips = vocab?.knowledge ?? [];
  const items = result?.items ?? [];
  const basketTotal = basket.total ?? 0;
  const basketByType = basket.byType ?? {};

  // ---- 筛选面板：当前分组的候选（先按输入框即时过滤，再交给分页）----
  const facetItems = useMemo(() => {
    const kw = facetQuery.trim().toLowerCase();
    if (facetGroup === '年份') {
      return yearsFacet
        .filter((y) => !kw || String(y.year).includes(kw))
        .map((y) => ({ key: `y:${y.year}`, label: String(y.year), count: y.count, on: years.includes(y.year), toggle: () => toggleYear(y.year) }));
    }
    return chips
      .filter((k) => !kw || k.name.toLowerCase().includes(kw))
      .map((k) => ({ key: `k:${k.name}`, label: k.name, count: k.count, on: knowledge.includes(k.name), toggle: () => toggleKnowledge(k.name) }));
    // toggleYear / toggleKnowledge 是纯 setState，无需进依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [facetGroup, facetQuery, yearsFacet, chips, yearsKey, knowledgeKey]);

  const facetPager = usePager(facetItems, FACET_PAGE_SIZE, `${facetGroup}|${facetQuery}`);

  const selectedCount = years.length + knowledge.length;

  /**
   * v4：搜索框的建议候选池 = 来源 + 知识点 + 年份。
   * v9：加上自定义标签 —— 它虽然**没有筛选面**，但"打全了能搜到"，
   *     所以要出现在建议里，否则等于没人知道库里有这些标签可选。
   * 数据全都来自已经在拉的 /api/tags，组件本身不发请求。
   */
  const suggestItems = useMemo<SuggestItem[]>(() => {
    const out: SuggestItem[] = [];
    for (const t of vocab?.source ?? []) {
      out.push({ key: `s:${t.name}`, label: t.name, kind: '来源', count: t.count });
    }
    for (const t of vocab?.knowledge ?? []) {
      out.push({ key: `k:${t.name}`, label: t.name, kind: '知识点', count: t.count });
    }
    for (const t of vocab?.custom ?? []) {
      out.push({ key: `c:${t.name}`, label: t.name, kind: '自定义', count: t.count });
    }
    for (const y of yearsFacet) {
      out.push({ key: `y:${y.year}`, label: String(y.year), kind: '年份', count: y.count });
    }
    return out;
  }, [vocab, yearsFacet]);

  return (
    <div className={styles.page}>
      {/* ---------- 页签 ---------- */}
      <div className={styles.tabs}>
        {(['单题', '整卷'] as const).map((t) => (
          <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </div>

      {/* ---------- v7：试题篮统计 ----------
          v8：顶部那一行紧凑统计**删掉了**（你说没用、还挡视线）。
          侧栏固定贴着右边 —— 它 `position: fixed`，**不参与主列排版**，
          所以题目那一列仍然严格居中（有像素级断言守着）。 */}
      <aside className={styles.basketRail}>
        <div className={styles.basketRailTitle}>
          试题篮
          <span className={styles.basketRailTotal}>{basketTotal}</span>
        </div>
        {basketTotal === 0 ? (
          <div className={styles.basketRailEmpty}>还没选题</div>
        ) : (
          <ul className={styles.basketRailList}>
            {QUESTION_TYPES.map((t) => (
              <li key={t}>
                <span>{t}</span>
                <b>{basketByType[t] ?? 0}</b>
              </li>
            ))}
          </ul>
        )}
        <Link href="/baskets" className={styles.basketRailGo}>
          去试题篮 →
        </Link>
      </aside>

      {/* ---------- 筛选 ---------- */}
      <section className={`ma-card ${styles.filters}`}>
        <div className={styles.row}>
          <SearchSuggest
            value={q}
            onChange={setQ}
            placeholder={tab === '整卷' ? '搜来源，如 25海淀一模' : '搜题干 / 答案 / 描述 / 标签'}
            items={suggestItems}
          />
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="启用">启用</option>
            <option value="停用">停用</option>
            <option value="全部">全部</option>
          </select>
          <button onClick={clearFilters}>清除筛选</button>
        </div>

        <div className={styles.row}>
          <span className={styles.label}>难度</span>
          {DIFFICULTY_BANDS.map((b) => (
            <button key={b} className={bands.includes(b) ? 'active' : ''} onClick={() => toggleBand(b)}>
              {b}
            </button>
          ))}
          {/* v2/v3：创新只属于单题 —— 整卷页签不显示这个筛选 */}
          {tab === '单题' && (
            <button className={innovation ? 'active' : ''} onClick={() => setInnovation(!innovation)}>
              创新
            </button>
          )}

          {tab === '单题' && (
            <>
              <span className={styles.label}>题型</span>
              <button className={type === '' ? 'active' : ''} onClick={() => setType('')}>
                全部
              </button>
              {QUESTION_TYPES.map((t) => (
                <button key={t} className={type === t ? 'active' : ''} onClick={() => setType(t)}>
                  {t}
                </button>
              ))}
            </>
          )}
        </div>

        {/* ---------- v3：标签筛选（年份 / 知识点）----------
            以前知识点直接平铺 20 个 chip，占三行还跟一个「还有 N 个…」。
            现在常驻只有一行「已选」，点「筛选」才展开面板；
            面板内按分组分页，每页最多 20 个，并带即时过滤框。 */}
        <div className={styles.row}>
          <span className={styles.label}>标签</span>
          <div className={styles.selectedChips}>
            {selectedCount === 0 && <span className={styles.hint}>未选</span>}
            {years.map((y) => (
              <button key={`y${y}`} className={`${styles.chip} active`} onClick={() => toggleYear(y)}>
                {y}
                <span className={styles.chipX}>×</span>
              </button>
            ))}
            {knowledge.map((k) => (
              <button
                key={`k${k}`}
                className={`${styles.chip} active`}
                onClick={() => toggleKnowledge(k)}
              >
                {k}
                <span className={styles.chipX}>×</span>
              </button>
            ))}
          </div>
          <button
            className={panelOpen ? 'active' : ''}
            onClick={() => setPanelOpen((v) => !v)}
            aria-expanded={panelOpen}
          >
            筛选 {panelOpen ? '▴' : '▾'}
          </button>
        </div>

        {panelOpen && (
          <div className={styles.facetPanel}>
            <div className={styles.facetHead}>
              {(['年份', '知识点'] as const).map((g) => (
                <button
                  key={g}
                  className={facetGroup === g ? 'active' : ''}
                  onClick={() => setFacetGroup(g)}
                >
                  {g}
                  <span className={styles.facetGroupCount}>
                    {g === '年份' ? yearsFacet.length : chips.length}
                  </span>
                </button>
              ))}
              <input
                type="search"
                className={styles.facetSearch}
                value={facetQuery}
                onChange={(e) => setFacetQuery(e.target.value)}
                placeholder="输入即过滤"
              />
            </div>

            <div className={styles.chips}>
              {facetPager.total === 0 && <span className={styles.hint}>没有匹配项</span>}
              {facetPager.pageItems.map((it) => (
                <button
                  key={it.key}
                  className={`${styles.chip} ${it.on ? 'active' : ''}`}
                  onClick={it.toggle}
                >
                  {it.label}
                  <span className={styles.chipCount}>{it.count}</span>
                </button>
              ))}
            </div>

            <Pager
              page={facetPager.page}
              pageCount={facetPager.pageCount}
              total={facetPager.total}
              unit="个"
              onChange={facetPager.setPage}
            />
          </div>
        )}
      </section>

      {/* ---------- 结果 ---------- */}
      <div className={styles.bar} ref={listTopRef}>
        <span>{loading ? '检索中…' : `共 ${result?.total ?? 0} 道`}</span>
      </div>

      {error && <div className={styles.err}>检索失败：{error}</div>}
      {basketError && <div className={styles.err}>试题篮操作失败：{basketError}</div>}

      <div className={styles.cards}>
        {items.map((entry) => (
          <QuestionCard
            key={entry.qid}
            entry={entry}
            content={result?.contents?.[entry.qid]}
            checked={inBasket.has(entry.qid)}
            onToggle={() => toggleBasket(entry.qid)}
          />
        ))}
        {!loading && items.length === 0 && <div className={styles.empty}>没有符合条件的题目</div>}
      </div>

      {/* v7：翻页后滚到结果条那一行（列表最上方），而不是停在翻页按钮处 */}
      <Pager
        page={page}
        pageCount={totalPages}
        total={result?.total ?? 0}
        unit="道"
        scrollTo={listTopRef}
        onChange={setPage}
      />
    </div>
  );
}

// ============================================================
// 单张题卡
// ============================================================

function QuestionCard({
  entry,
  content,
  checked,
  onToggle,
}: {
  entry: IndexEntry;
  content?: { stem: string; answer: string; assets: string[] };
  checked: boolean;
  onToggle: () => void;
}) {
  const isPaper = entry.kind === '整卷';

  return (
    <article className={`${styles.card} ${checked ? styles.cardChecked : ''}`}>
      <div className={styles.cardHead}>
        {/* v8：整卷连占位符都不留 —— 上一轮那个 ▤ 你说难看。
            整卷是 PDF，进不了试题篮，所以这里本来就不该有"勾选"这一列的痕迹。 */}
        {!isPaper && (
          <input
            type="checkbox"
            checked={checked}
            onChange={onToggle}
            className={styles.check}
            title={checked ? '取消勾选即移出试题篮' : '勾选即加入试题篮'}
          />
        )}
        {/* v9：显示时去掉学科字母（AT0001 → T0001） */}
        <span className={`ma-mono ${styles.qid}`}>{displayQid(entry.qid)}</span>
        {entry.year !== undefined && <span className="ma-badge">{entry.year}</span>}
        <span>{entry.source ?? '未指定'}</span>
        {entry.number !== undefined && <span>第{entry.number}题</span>}
        <span className={styles.diff}>{difficultyText(entry.difficulty)}</span>
        {/*
          v9：自定义标签就放在这一行 —— 和「25全国1 第1题 0.94 基础」并排。
          每个最多显示 7 个字（超了用 …），因为这一行本来就挤；
          完整的名字放在 title 里，鼠标停上去能看到。
          没设过就什么都不显示（不是"未设定"）。
          整卷不显示（自定义标签本来就只属于单题）。
        */}
        {!isPaper &&
          (entry.custom ?? []).map((c) => (
            <span key={c} className={styles.customTag} title={c}>
              {truncateCustomTag(c)}
            </span>
          ))}
        {/* v2：创新只属于单题 */}
        {!isPaper && entry.innovation && <span className="ma-badge accent">创新</span>}
        {entry.status === '停用' && <span className="ma-badge warn">停用</span>}
        <Link href={`/question/${entry.qid}`} className={styles.detailLink}>
          {/* v10：整卷不再标「（含它名下的题目）」—— 详情页里本来就有，标题上多这一句是噪音 */}
          详情
        </Link>
      </div>

      {isPaper ? (
        <>
          <p className={styles.descClamp}>{entry.descPreview ?? '（无描述）'}</p>
          <div className={styles.paperLinks}>
            {entry.hasPdf && (
              <>
                <a href={`/api/questions/${entry.qid}/pdf/paper`} target="_blank" rel="noreferrer">
                  题目 PDF
                </a>
                <a href={`/api/questions/${entry.qid}/pdf/answer`} target="_blank" rel="noreferrer">
                  答案 PDF
                </a>
              </>
            )}
          </div>
        </>
      ) : (
        <div className={styles.body}>
          {content ? (
            <QuestionBody
              qid={entry.qid}
              stem={content.stem}
              showAnswer={false}
              existingFiles={content.assets}
              figAlign={entry.figAlign}
            />
          ) : (
            <span className="ma-muted">载入中…</span>
          )}
        </div>
      )}

      {!isPaper && (entry.knowledge?.length ?? 0) > 0 && (
        <div className={styles.cardTags}>
          {(entry.knowledge ?? []).map((k) => (
            <span key={k} className="ma-badge">
              {k}
            </span>
          ))}
        </div>
      )}
    </article>
  );
}
