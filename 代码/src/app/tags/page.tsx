'use client';

import { useCallback, useEffect, useState } from 'react';
import { Pager } from '@/components/Pager';
import { usePager } from '@/components/usePager';
import type { TagItem, TagKind } from '@/lib/types';
import { TAG_KIND_LABEL, TAG_KINDS, CUSTOM_TAG_LEN_MAX, displayQid } from '@/lib/types';
import styles from './page.module.css';

// 与 service.ts 的 RenamePreview 对应（这里只声明形状，不 import 服务端模块）
interface RenamePreview {
  kind: TagKind;
  from: string;
  to: string;
  affected: Array<{ qid: string; before: string | string[] }>;
  merging: boolean;
  targetCount: number;
}

interface PurgePreview {
  kind: TagKind;
  name: string;
  affected: Array<{ qid: string; before: string | string[] }>;
}

const TABS: Array<{ kind: TagKind; label: string }> = TAG_KINDS.map((kind) => ({
  kind,
  label: TAG_KIND_LABEL[kind],
}));

/** v3：标签列表每页最多 20 个 */
const TAG_PAGE_SIZE = 20;

export default function TagsPage() {
  const [kind, setKind] = useState<TagKind>('source');
  const [includeRetired, setIncludeRetired] = useState(false);
  const [vocab, setVocab] = useState<Record<TagKind, TagItem[]> | null>(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const [newName, setNewName] = useState('');

  // 改名
  const [renameFrom, setRenameFrom] = useState<string | null>(null);
  const [renameTo, setRenameTo] = useState('');
  const [renamePreview, setRenamePreview] = useState<RenamePreview | null>(null);

  // 彻底清除
  const [purgeName, setPurgeName] = useState<string | null>(null);
  const [purgePreview, setPurgePreview] = useState<PurgePreview | null>(null);

  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/tags?includeRetired=1', { cache: 'no-store' });
      const data = await res.json();
      if (data.error) setError(data.error);
      else {
        setVocab(data.vocab);
        setError('');
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  // 挂载时加载：setState 放在 .then 回调里（effect 体内同步 setState 会触发级联渲染）
  useEffect(() => {
    fetch('/api/tags?includeRetired=1', { cache: 'no-store' })
      .then((r) => r.json())
      .then((data) => {
        if (data.error) setError(data.error);
        else {
          setVocab(data.vocab);
          setError('');
        }
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  const action = useCallback(
    async (payload: Record<string, unknown>): Promise<Record<string, unknown> | null> => {
      setBusy(true);
      setError('');
      try {
        const res = await fetch('/api/tags/action', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const data = await res.json();
        if (data.error) {
          setError(data.error);
          return null;
        }
        if (data.vocab) setVocab(data.vocab);
        return data;
      } catch (e) {
        setError((e as Error).message);
        return null;
      } finally {
        setBusy(false);
      }
    },
    []
  );

  const flash = (text: string) => {
    setMessage(text);
    setTimeout(() => setMessage(''), 3500);
  };

  // ---- 新增 ----
  const handleAdd = async () => {
    const name = newName.trim();
    if (!name) return;
    const data = await action({ op: 'add', kind, name });
    if (data) {
      setNewName('');
      flash(`已登记「${name}」`);
      await load();
    }
  };

  // ---- 停用 / 恢复 ----
  const handleRetire = async (name: string, count: number) => {
    const extra = count > 0 ? `\n\n（${count} 道题，可随时恢复）` : '';
    if (!confirm(`停用「${name}」？${extra}`)) {
      return;
    }
    const data = await action({ op: 'retire', kind, name });
    if (data) {
      flash(`已停用「${name}」（${count} 道题上仍保留该值）`);
      await load();
    }
  };

  const handleRestore = async (name: string) => {
    const data = await action({ op: 'restore', kind, name });
    if (data) {
      flash(`已恢复「${name}」`);
      await load();
    }
  };

  // ---- 改名 ----
  const openRename = (name: string) => {
    setRenameFrom(name);
    setRenameTo(name);
    setRenamePreview(null);
    setError('');
  };

  const doPreview = async () => {
    if (!renameFrom) return;
    const to = renameTo.trim();
    if (!to) {
      setError('新名字不能为空');
      return;
    }
    if (to === renameFrom) {
      setError('新名字和原名一样');
      return;
    }
    const data = await action({ op: 'renamePreview', kind, name: renameFrom, to });
    if (data) setRenamePreview(data.preview as RenamePreview);
  };

  const doRename = async () => {
    if (!renameFrom || !renamePreview) return;
    const data = await action({ op: 'rename', kind, name: renameFrom, to: renamePreview.to });
    if (data) {
      flash(
        `已把「${renamePreview.from}」改为「${renamePreview.to}」，更新了 ${data.changed} 道题` +
          (renamePreview.merging ? `（与已有的「${renamePreview.to}」合并）` : '')
      );
      setRenameFrom(null);
      setRenamePreview(null);
      await load();
    }
  };

  // ---- 彻底清除 ----
  const openPurge = async (name: string) => {
    setPurgeName(name);
    setPurgePreview(null);
    const data = await action({ op: 'purgePreview', kind, name });
    if (data) setPurgePreview(data.preview as PurgePreview);
  };

  const doPurge = async () => {
    if (!purgeName || !purgePreview) return;
    const data = await action({ op: 'purge', kind, name: purgeName });
    if (data) {
      flash(`已彻底清除「${purgeName}」，从 ${data.changed} 道题上摘除`);
      setPurgeName(null);
      setPurgePreview(null);
      await load();
    }
  };

  // v9：每个分类各配一个搜索框（你说"来源和知识点也分别给搜索，方便寻找"）。
  // 分类本来就只显示一类（页签），所以只放一个框、跟着当前页签走，
  // 但**三类的搜索词各存一份**：切来切去各自的搜索词都留着，不会互相冲掉。
  const [queries, setQueries] = useState<Record<TagKind, string>>({
    source: '',
    knowledge: '',
    custom: '',
  });

  const items = (vocab?.[kind] ?? []).filter(
    (t) => includeRetired || !t.retired
  ).filter((t) => {
    const q = queries[kind].trim().toLowerCase();
    return !q || t.name.toLowerCase().includes(q);
  });
  const retiredCount = (vocab?.[kind] ?? []).filter((t) => t.retired).length;
  const activeTab = TABS.find((t) => t.kind === kind)!;

  // v3：标签列表分页，每页最多 20 个。
  // 换页签 / 切换「显示已停用」/ 改搜索词 都回到第 1 页（都进 key）。
  const pager = usePager(
    items,
    TAG_PAGE_SIZE,
    `${kind}|${includeRetired ? '1' : '0'}|${queries[kind]}`
  );

  return (
    <div className={styles.page}>
      <div className={styles.head}>
        <h1 className={styles.title}>标签管理</h1>
      </div>

      <div className={styles.tabs}>
        {TABS.map((t) => (
          <button
            key={t.kind}
            className={kind === t.kind ? 'active' : ''}
            onClick={() => setKind(t.kind)}
          >
            {t.label}
          </button>
        ))}
        {/* v9：搜索框 —— 只过滤当前这个分类 */}
        <input
          type="search"
          className={styles.search}
          value={queries[kind]}
          onChange={(e) => setQueries((p) => ({ ...p, [kind]: e.target.value }))}
          placeholder={`搜索${activeTab.label}`}
          aria-label={`搜索${activeTab.label}`}
        />
        {queries[kind] && (
          <button onClick={() => setQueries((p) => ({ ...p, [kind]: '' }))}>清空</button>
        )}
        <label className={styles.toggle}>
          <input
            type="checkbox"
            checked={includeRetired}
            onChange={(e) => setIncludeRetired(e.target.checked)}
          />
          显示已停用{retiredCount > 0 ? `（${retiredCount}）` : ''}
        </label>
      </div>

      {message && <div className={styles.ok}>{message}</div>}
      {error && <div className={styles.err}>{error}</div>}

      <section className="ma-card">
        <div className={styles.addRow}>
          <input
            type="text"
            placeholder={`新增${activeTab.label}`}
            value={newName}
            maxLength={kind === 'custom' ? CUSTOM_TAG_LEN_MAX : undefined}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleAdd();
            }}
            className={styles.addInput}
          />
          <button className="primary" onClick={handleAdd} disabled={busy || !newName.trim()}>
            添加
          </button>
          {kind === 'custom' && (
            <span className={styles.hint}>最长 {CUSTOM_TAG_LEN_MAX} 个字</span>
          )}
        </div>
      </section>

      <section className={styles.tableCard}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>{activeTab.label}</th>
              <th className={styles.cCount}>引用</th>
              <th className={styles.cState}>状态</th>
              <th className={`${styles.cOps} ma-ops`}>操作</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={4} className={styles.empty}>
                  载入中…
                </td>
              </tr>
            )}
            {!loading && items.length === 0 && (
              <tr>
                <td colSpan={4} className={styles.empty}>
                  {includeRetired ? '还没有任何标签' : '还没有启用的标签'}
                </td>
              </tr>
            )}
            {pager.pageItems.map((t) => (
              <tr key={t.name} className={t.retired ? styles.retiredRow : ''}>
                <td>
                  <span className={t.retired ? styles.retiredName : ''}>{t.name}</span>
                  {t.manual && t.count === 0 && (
                    <span className="ma-badge" style={{ marginLeft: '.4em' }}>
                      手工登记
                    </span>
                  )}
                </td>
                <td className={styles.cCount}>
                  <span className="ma-mono">{t.count}</span>
                  {t.enabledCount !== t.count && (
                    <span className={styles.hint} title="含已停用的题">
                      （含 {t.count - t.enabledCount} 道停用）
                    </span>
                  )}
                </td>
                <td className={styles.cState}>
                  {t.retired ? (
                    <span className="ma-badge warn">已停用</span>
                  ) : (
                    <span className="ma-badge accent">启用</span>
                  )}
                </td>
                <td className={`${styles.cOps} ma-ops`}>
                  <span className="ma-ops-cell">
                    <button onClick={() => openRename(t.name)} disabled={busy}>
                      改名
                    </button>
                    {t.retired ? (
                      <>
                        <button onClick={() => handleRestore(t.name)} disabled={busy}>
                          恢复
                        </button>
                        <button
                          className={styles.danger}
                          onClick={() => openPurge(t.name)}
                          disabled={busy}
                          title="从所有题目上摘除（不可逆，会先备份）"
                        >
                          彻底清除
                        </button>
                      </>
                    ) : (
                      <button onClick={() => handleRetire(t.name, t.count)} disabled={busy}>
                        停用
                      </button>
                    )}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <Pager
          page={pager.page}
          pageCount={pager.pageCount}
          total={pager.total}
          unit="个标签"
          onChange={pager.setPage}
        />
      </section>

      {/* ---------- 改名弹窗 ---------- */}
      {renameFrom !== null && (
        <div className={styles.overlay} onClick={() => setRenameFrom(null)}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <h3 className={styles.modalTitle}>改名 / 合并</h3>
            <div className={styles.modalBody}>
              <div className={styles.kv}>
                <span className={styles.kvKey}>原名</span>
                <span>{renameFrom}</span>
              </div>
              <div className={styles.kv}>
                <span className={styles.kvKey}>新名</span>
                <input
                  type="text"
                  value={renameTo}
                  maxLength={kind === 'custom' ? CUSTOM_TAG_LEN_MAX : undefined}
                  onChange={(e) => {
                    setRenameTo(e.target.value);
                    setRenamePreview(null);
                  }}
                  className={styles.renameInput}
                  autoFocus
                />
              </div>

              {!renamePreview ? (
                <p className={styles.modalHint}>新名已存在时，两个标签会<b>合并</b>。</p>
              ) : (
                <div className={styles.previewBox}>
                  {renamePreview.merging && (
                    <div className={styles.mergeWarn}>
                      ⚠ 新名「{renamePreview.to}」已被 {renamePreview.targetCount} 道题使用，
                      这次改名会是一次<b>合并</b>。
                    </div>
                  )}
                  <div className={styles.previewTitle}>
                    会影响 <b>{renamePreview.affected.length}</b> 道题：
                  </div>
                  <div className={styles.qidList}>
                    {renamePreview.affected.map((a) => (
                      <span key={a.qid} className="ma-badge ma-mono">
                        {displayQid(a.qid)}
                      </span>
                    ))}
                    {renamePreview.affected.length === 0 && (
                      <span className="ma-muted">（没有题目在用这个名字，只会改标签表）</span>
                    )}
                  </div>
                </div>
              )}
            </div>
            <div className={styles.modalFoot}>
              <button onClick={() => setRenameFrom(null)}>取消</button>
              {!renamePreview ? (
                <button className="primary" onClick={doPreview} disabled={busy}>
                  预览影响
                </button>
              ) : (
                <button className="primary" onClick={doRename} disabled={busy}>
                  确认改名
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ---------- 彻底清除弹窗 ---------- */}
      {purgeName !== null && (
        <div className={styles.overlay} onClick={() => setPurgeName(null)}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <h3 className={styles.modalTitle}>彻底清除「{purgeName}」</h3>
            <div className={styles.modalBody}>
              <div className={styles.previewBox}>
                <div className={styles.mergeWarn}>
                  ⚠ 会把这个值从下列题目上<b>摘掉</b>，不可逆。
                </div>
                <div className={styles.previewTitle}>
                  会从 <b>{purgePreview?.affected.length ?? 0}</b> 道题上摘除：
                </div>
                <div className={styles.qidList}>
                  {(purgePreview?.affected ?? []).map((a) => (
                    <span key={a.qid} className="ma-badge ma-mono">
                      {displayQid(a.qid)}
                    </span>
                  ))}
                  {(purgePreview?.affected.length ?? 0) === 0 && (
                    <span className="ma-muted">（没有题目在用，只会从标签表移除）</span>
                  )}
                </div>
              </div>
            </div>
            <div className={styles.modalFoot}>
              <button onClick={() => setPurgeName(null)}>取消</button>
              <button className={styles.dangerBtn} onClick={doPurge} disabled={busy}>
                确认彻底清除
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
