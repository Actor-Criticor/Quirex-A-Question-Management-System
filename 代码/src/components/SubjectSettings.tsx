'use client';

/**
 * SubjectSettings.tsx — 设置页的「学科」区（v9）
 *
 * 你说：「设置里的题库位置是所有学科的总位置，当前题库信息是当前学科」。
 * 所以这一区只回答两件事：
 *   · 一共有哪几个学科、各自题库存哪、各有多少条记录
 *   · 当前是哪一个
 *
 * **切换**不放在这里 —— 它在顶栏右侧（你指定的位置），这里只显示状态。
 * 这里多给了一个「改名」：学科名字是新建时定的，写错了总得有个地方改；
 * 改名字**只改 name、不动目录**（否则要搬整个题库）。
 */

import { useCallback, useEffect, useState } from 'react';
import styles from './SubjectSettings.module.css';

interface SubjectView {
  id: string;
  name: string;
  dir: string;
  bankPath: string;
  count: number;
  active: boolean;
}

interface SubjectsResponse {
  active: string;
  subjects: SubjectView[];
  max: number;
  nameMax: number;
  registryFile: string;
}

export function SubjectSettings() {
  const [view, setView] = useState<SubjectsResponse | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');

  const load = useCallback(() => {
    fetch('/api/subjects', { cache: 'no-store' })
      .then((r) => r.json())
      .then((d: SubjectsResponse) => setView(d))
      .catch(() => setView(null));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const startRename = (s: SubjectView) => {
    setEditing(s.id);
    setDraft(s.name);
    setErr('');
  };

  const doRename = async (id: string) => {
    setBusy(true);
    setErr('');
    try {
      const res = await fetch('/api/subjects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'rename', id, name: draft.trim() }),
      });
      const d = await res.json();
      if (!res.ok || d.error) {
        setErr(d.error || `改名失败（HTTP ${res.status}）`);
        return;
      }
      setMsg('已改学科名字（目录没动，题库还在原处）');
      setTimeout(() => setMsg(''), 5000);
      setEditing(null);
      load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!view) return null;

  return (
    <section className="ma-card">
      <div className={styles.head}>
        <h2 className={styles.h2}>学科</h2>
        <span className={styles.hint}>
          共 {view.subjects.length} / {view.max} 个 · 切换在<b>顶栏右侧</b>
        </span>
      </div>

      {msg && <div className={styles.ok}>{msg}</div>}
      {err && <div className={styles.err}>{err}</div>}

      <table className={styles.table}>
        <thead>
          <tr>
            <th>学科</th>
            <th className={styles.cCount}>记录</th>
            <th>题库目录</th>
            <th className={styles.cOps}>操作</th>
          </tr>
        </thead>
        <tbody>
          {view.subjects.map((s) => (
            <tr key={s.id} className={s.active ? styles.activeRow : ''}>
              <td>
                {editing === s.id ? (
                  <input
                    type="text"
                    autoFocus
                    value={draft}
                    maxLength={view.nameMax}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') doRename(s.id);
                      if (e.key === 'Escape') setEditing(null);
                    }}
                    className={styles.renameInput}
                  />
                ) : (
                  <span className={styles.name}>{s.name}</span>
                )}
                {s.active && <span className={styles.currentBadge}>当前</span>}
              </td>
              <td className={styles.cCount}>
                <span className="ma-mono">{s.count}</span>
              </td>
              <td className={`${styles.path} ma-mono`}>{s.bankPath}</td>
              <td className={styles.cOps}>
                {editing === s.id ? (
                  <span className="ma-ops-cell">
                    <button className="primary" onClick={() => doRename(s.id)} disabled={busy || !draft.trim()}>
                      保存
                    </button>
                    <button onClick={() => setEditing(null)} disabled={busy}>
                      取消
                    </button>
                  </span>
                ) : (
                  <span className="ma-ops-cell">
                    <button onClick={() => startRename(s)} disabled={busy}>
                      改名
                    </button>
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

export default SubjectSettings;
