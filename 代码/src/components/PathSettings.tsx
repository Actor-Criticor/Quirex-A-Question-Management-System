'use client';

/**
 * PathSettings.tsx — 设置页的「路径」区（v6 #3）
 *
 * 四条路径都存在项目根的 `config.json` 里。为什么是这四条：
 *   · 题库（Vault 根目录）—— 换一个题库 = 换一整套数据
 *   · 导出位置           —— 讲义 PDF 想直接落到桌面/网盘目录
 *   · 模板目录           —— 想把自己攒的模板放在别处（比如共享盘）
 *   · xelatex            —— 系统 PATH 里没有时，直接指到 xelatex.exe
 *
 * 两个设计取舍：
 *   1) 输入框里显示的是**生效的绝对路径**，不是 config.json 里存的那串。
 *      这样"现在到底在用哪个目录"一眼可见，复制/打开文件夹都能直接用。
 *   2) 清空输入框 = 删掉这一项，回落到环境变量或默认值 —— 不是写一个空字符串。
 *      所以「恢复默认」就是把框清空，不需要另设一个按钮。
 */

import { useCallback, useEffect, useState } from 'react';
import styles from './PathSettings.module.css';

interface EntryView {
  key: string;
  value: string;
  stored: string;
  source: 'config' | 'env' | 'default';
  envName: string;
  defaultValue: string;
  exists: boolean;
  note?: string;
}

interface ConfigView {
  entries: EntryView[];
  file: string;
}

/**
 * 每行的标题 —— 界面上的中文都集中在这里，改文案不用翻 JSX。
 *
 * v10：行下面那几句说明全删了（你说多余）。占位符与「清空 = 恢复默认」
 * 这类**操作提示**留着 —— 那是"不写就不知道能不能删"的那种，不是说明书。
 */
const LABELS: Record<string, { label: string; placeholder?: string }> = {
  vaultPath: { label: '题库位置' },
  exportDir: { label: '导出位置' },
  templatesDir: { label: '模板目录' },
  xelatexPath: { label: 'xelatex 路径', placeholder: '（留空 = 用系统 PATH）' },
};

const SOURCE_TEXT: Record<string, string> = {
  config: '界面设置',
  env: '.env.local',
  default: '默认值',
};

export function PathSettings() {
  const [view, setView] = useState<ConfigView | null>(null);
  /** 输入框里的草稿值，key → 文本 */
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  const load = useCallback(() => {
    fetch('/api/config', { cache: 'no-store' })
      .then((r) => r.json())
      .then((d: ConfigView) => {
        setView(d);
        setDraft(Object.fromEntries((d.entries ?? []).map((e) => [e.key, e.value])));
      })
      .catch(() => setView(null));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const flash = (t: string) => {
    setMsg(t);
    setTimeout(() => setMsg(''), 5000);
  };

  const entries = view?.entries ?? [];
  const dirty = entries.filter((e) => (draft[e.key] ?? '') !== e.value);

  const save = async () => {
    if (!dirty.length) return;
    setBusy('save');
    setErr('');
    const body: Record<string, string | null> = {};
    for (const e of dirty) {
      const v = (draft[e.key] ?? '').trim();
      // 清空 = 删掉这一项，回落到 env / 默认值
      body[e.key] = v === '' ? null : v;
    }
    try {
      const res = await fetch('/api/config', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const d = await res.json();
      if (d.error) {
        setErr(d.error);
        // 失败的项**保持草稿原样**，让你能就地改，而不是被悄悄弹回去
        load();
      } else {
        flash(`已保存 ${dirty.length} 项，立即生效（不用重启服务）`);
        load();
      }
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy('');
    }
  };

  const reveal = async (key: string) => {
    setErr('');
    const res = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'reveal', key }),
    });
    const d = await res.json();
    if (d.error) setErr(d.error);
  };

  const testXelatex = async () => {
    setBusy('xelatex');
    setErr('');
    try {
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'testXelatex' }),
      });
      const d = await res.json();
      if (d.ok) flash(`xelatex 可用：${d.output}`);
      else setErr(d.output || d.error || '检测失败');
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy('');
    }
  };

  return (
    <section className="ma-card">
      <div className={styles.head}>
        <h2 className={styles.h2}>路径</h2>
        <span className={styles.hint}>
          改完点保存<b>立即生效</b>，不用重启服务
        </span>
      </div>

      {msg && <div className={styles.ok}>{msg}</div>}
      {err && <div className={styles.err}>{err}</div>}

      <div className={styles.list}>
        {!view && <div className={styles.hint}>读取中…</div>}
        {entries.map((e) => {
          const meta = LABELS[e.key] ?? { label: e.key };
          const changed = (draft[e.key] ?? '') !== e.value;
          return (
            <div className={styles.item} key={e.key}>
              <div className={styles.itemHead}>
                <span className={styles.label}>{meta.label}</span>
                <span className={styles.badge}>{SOURCE_TEXT[e.source] ?? e.source}</span>
                {e.source === 'env' && (
                  <span className={styles.hint} title={`环境变量 ${e.envName}`}>
                    （{e.envName}）
                  </span>
                )}
                {changed && <span className={styles.dirty}>未保存</span>}
              </div>

              <div className={styles.inputRow}>
                <input
                  type="text"
                  value={draft[e.key] ?? ''}
                  placeholder={meta.placeholder ?? ''}
                  spellCheck={false}
                  onChange={(ev) => setDraft((p) => ({ ...p, [e.key]: ev.target.value }))}
                />
                {e.key !== 'xelatexPath' && (
                  <button onClick={() => reveal(e.key)} disabled={!!busy} title="在文件管理器里打开">
                    打开
                  </button>
                )}
                {e.key === 'xelatexPath' && (
                  <>
                    <button onClick={() => reveal(e.key)} disabled={!!busy} title="打开所在文件夹">
                      打开
                    </button>
                    <button onClick={testXelatex} disabled={!!busy}>
                      {busy === 'xelatex' ? '检测中…' : '检测'}
                    </button>
                  </>
                )}
              </div>

              {e.note && <div className={styles.note}>⚠ {e.note}</div>}
            </div>
          );
        })}
      </div>

      <div className={styles.foot}>
        <button className="primary" onClick={save} disabled={!!busy || dirty.length === 0}>
          {busy === 'save' ? '保存中…' : dirty.length ? `保存（${dirty.length} 项改动）` : '保存'}
        </button>
        <button
          onClick={() => setDraft(Object.fromEntries(entries.map((e) => [e.key, e.value])))}
          disabled={!!busy || dirty.length === 0}
        >
          放弃改动
        </button>
      </div>
    </section>
  );
}
