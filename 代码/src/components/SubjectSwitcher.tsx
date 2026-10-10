'use client';

/**
 * SubjectSwitcher.tsx — 顶栏右侧的学科切换条（v9）
 *
 * 你的原话：「切换学科放在顶端栏的右侧，放一个加号表示新建，然后新建时只有命名，
 * 命名后名字在加号左侧从右往左排列，名字最长 5 个字，最多 5 个学科。
 * 然后自动切换题库。」
 *
 * 所以这条例子的形状是：
 *
 *     数学  物理  化学  ＋
 *
 * 越新的越靠右（紧挨着加号）。当前学科高亮。
 *
 * ## 切换为什么用整页跳转
 *
 * 切学科换的是**一整套题库**（题目、标签表、试题篮、编号全都换），
 * 不是页面上某一个数字。用 `router.push` 的话，如果当前已经在 `/`
 * 上，App Router 不会重新挂载、各页的 `useEffect` 也就不会重跑 ——
 * 结果就是"切了但界面还是旧的"这种最难查的 bug。
 * 直接整页跳回 `/`：一定重新取数，而且切完学科本来也该从题库第一页看起。
 */

import { useCallback, useEffect, useState } from 'react';
import styles from './SubjectSwitcher.module.css';

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
}

export function SubjectSwitcher() {
  const [data, setData] = useState<SubjectsResponse | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const load = useCallback(() => {
    fetch('/api/subjects', { cache: 'no-store' })
      .then((r) => r.json())
      .then((d: SubjectsResponse) => {
        if ((d as unknown as { error?: string }).error) return;
        setData(d);
      })
      .catch(() => {
        /* 读不到就什么都不显示（不挡着页面） */
      });
  }, []);

  // setState 放在 .then 里 —— effect 体内同步 setState 会触发级联渲染
  useEffect(() => {
    load();
  }, [load]);

  const switchTo = async (id: string) => {
    if (!data || id === data.active) return;
    setBusy(true);
    setErr('');
    try {
      const res = await fetch('/api/subjects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'switch', id }),
      });
      const d = await res.json();
      if (!res.ok || d.error) {
        setErr(d.error || `切换失败（HTTP ${res.status}）`);
        return;
      }
      // 整页回到题库第一页（见文件头的说明）
      window.location.assign('/');
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const create = async () => {
    const clean = name.trim();
    if (!clean) {
      setErr('给它起个名字');
      return;
    }
    setBusy(true);
    setErr('');
    try {
      const res = await fetch('/api/subjects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'create', name: clean }),
      });
      const d = await res.json();
      if (!res.ok || d.error) {
        setErr(d.error || `新建失败（HTTP ${res.status}）`);
        return;
      }
      // 新建后自动切过去 —— 直接回题库页看新学科（空的）
      window.location.assign('/');
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!data || data.subjects.length === 0) return null;

  const full = data.subjects.length >= data.max;

  return (
    <div className={styles.wrap}>
      {data.subjects.map((s) => (
        <button
          key={s.id}
          className={`${styles.chip} ${s.active ? styles.active : ''}`}
          onClick={() => switchTo(s.id)}
          disabled={busy}
          title={`${s.name}（题库：${s.bankPath} · ${s.count} 条记录）`}
        >
          {s.name}
        </button>
      ))}
      <button
        className={styles.plus}
        onClick={() => {
          setName('');
          setErr('');
          setCreating(true);
        }}
        disabled={busy || full}
        title={full ? `最多 ${data.max} 个学科` : '新建学科'}
        aria-label="新建学科"
      >
        ＋
      </button>

      {creating && (
        <div className={styles.mask} onClick={() => setCreating(false)}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <h3 className={styles.modalTitle}>新建学科</h3>
            <div className={styles.modalBody}>
              <input
                type="text"
                autoFocus
                value={name}
                maxLength={data.nameMax}
                placeholder={`最多 ${data.nameMax} 个字，如「化学」`}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    create();
                  }
                  if (e.key === 'Escape') setCreating(false);
                }}
              />
              {err && <div className={styles.err}>{err}</div>}
            </div>
            <div className={styles.modalFoot}>
              <button onClick={() => setCreating(false)} disabled={busy}>
                取消
              </button>
              <button className="primary" onClick={create} disabled={busy || !name.trim()}>
                {busy ? '新建中…' : '新建并切换'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default SubjectSwitcher;
