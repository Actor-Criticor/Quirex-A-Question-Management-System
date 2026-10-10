'use client';

import { useCallback, useEffect, useState } from 'react';
import { Pager } from '@/components/Pager';
import { usePager } from '@/components/usePager';
import { PathSettings } from '@/components/PathSettings';
import { SubjectSettings } from '@/components/SubjectSettings';
import { TemplateSettings } from '@/components/TemplateSettings';
import { BACKUP_LIMIT } from '@/lib/types';
import styles from './page.module.css';

interface BackupInfo {
  vaultPath: string;
  bankPath: string;
  exists: boolean;
  questionCount: number;
  fileCount: number;
  rawBytes: number;
  metaExists: boolean;
}

/** v3：字段级备份（改名 / 彻底清除前自动生成的那种），从标签页搬到这里 */
interface FieldBackupRecord {
  id: string;
  createdAt: string;
  operation: string;
  affected: Array<{ qid: string; field: string; before: unknown }>;
}

/** v4：每页条数 */
const HISTORY_PAGE_SIZE = 15;
/** v4：备份与还原每页 10 条（你指定的） */
const FIELD_BACKUP_PAGE_SIZE = 10;

interface ExportFolder {
  folder: string;
  createdAt: string;
  hasPdf: boolean;
  /** v6：实际存在的 PDF 文件名（题目.pdf / 答案.pdf） */
  pdfs?: string[];
}

function human(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * v10：设置页整体重排 + 去掉「从 v0 迁移」那一区。
 *
 * 迁移那件事你问「是干啥的、没用就去掉」—— 它原来只做一次 **dry-run**
 * （数一下库里有几个 v0 格式的老文件、抽样列两个），真正的写入从来都得在终端跑
 * `npx tsx scripts/migrate-v0.ts --apply`。既然界面上干不了实事，又占一整块，
 * 就把它撤了；迁移脚本与 README 里那节说明都还在，需要时照样能用。
 * 那个只服务于这块卡片的 `/api/migrate/v0` 接口也一并删了，不留死代码。
 */
export default function SettingsPage() {
  const [backup, setBackup] = useState<BackupInfo | null>(null);
  const [folders, setFolders] = useState<ExportFolder[]>([]);
  const [fieldBackups, setFieldBackups] = useState<FieldBackupRecord[]>([]);
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  // v3：两处长列表都分页
  const historyPager = usePager(folders, HISTORY_PAGE_SIZE, 'history');
  const fieldBackupPager = usePager(fieldBackups, FIELD_BACKUP_PAGE_SIZE, 'fieldBackup');

  const loadAll = useCallback(() => {
    fetch('/api/backup/full', { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => setBackup(d))
      .catch(() => setBackup(null));

    fetch('/api/export/download', { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => setFolders(d.folders ?? []))
      .catch(() => setFolders([]));

    // v3：字段级备份列表（原来在标签页）
    fetch('/api/tags/action', { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => setFieldBackups(d.backups ?? []))
      .catch(() => setFieldBackups([]));
  }, []);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  const flash = (t: string) => {
    setMessage(t);
    setTimeout(() => setMessage(''), 5000);
  };

  /** v3：从字段级备份还原（原来在标签页，现在集中到设置页的备份区） */
  const doRestoreFieldBackup = async (id: string) => {
    if (!confirm('从这份备份还原？受影响的题目字段会被写回备份里的旧值。')) return;
    setBusy('restoreField');
    setError('');
    try {
      const res = await fetch('/api/tags/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ op: 'restoreBackup', id }),
      });
      const d = await res.json();
      if (d.error) setError(d.error);
      else {
        flash(`已还原 ${d.restored} 道题的字段`);
        loadAll();
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  };

  /** 重建索引 */
  const rebuild = async () => {
    setBusy('rebuild');
    setError('');
    try {
      const res = await fetch('/api/index/rebuild', { method: 'POST' });
      const d = await res.json();
      if (d.error) setError(d.error);
      else {
        flash(`索引已重建，共 ${d.count} 条`);
        loadAll();
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  };

  /** 整库备份（下载 zip） */
  const doBackup = async () => {
    setBusy('backup');
    setError('');
    try {
      const res = await fetch('/api/backup/full', { method: 'POST' });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        setError(d.error || `备份失败（HTTP ${res.status}）`);
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const cd = res.headers.get('Content-Disposition') ?? '';
      const m = cd.match(/filename\*=UTF-8''([^;]+)/);
      a.href = url;
      a.download = m ? decodeURIComponent(m[1]) : 'Quirex备份.zip';
      a.click();
      URL.revokeObjectURL(url);
      flash(`已打包整库备份（${human(blob.size)}）`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  };

  /** 下载某个导出文件夹的 zip（用隐藏链接而不是改 window.location，避免破坏当前应用状态） */
  const downloadZip = (folder: string) => {
    const a = document.createElement('a');
    a.href = `/api/export/download?folder=${encodeURIComponent(folder)}`;
    a.download = `${folder}.zip`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  return (
    <div className={styles.page}>
      <h1 className={styles.title}>设置</h1>

      {message && <div className={styles.ok}>{message}</div>}
      {error && <div className={styles.err}>{error}</div>}

      {/*
        v10 区块顺序（你说「路径也放到下面去，当前题库/检索索引/整库备份放最下面」）：
          学科 → 讲义模板 → 导出历史 → 备份与还原 → 路径 → 当前题库 → 检索索引 → 整库备份
        前两块是"日常要动的"，后面几块一年也点不了一次，所以压到最底下。
      */}

      {/* ---------- v9：学科（题库位置是总位置，这里是各学科的分身） ---------- */}
      <SubjectSettings />

      {/* ---------- v6：讲义模板（列出来、能改名、能修） ---------- */}
      <TemplateSettings />


      {/* ---------- 导出历史 ---------- */}
      <section className={styles.tableCard}>
        <div className={styles.head} style={{ padding: '.7rem .8rem', marginBottom: 0 }}>
          <h2 className={styles.h2}>导出历史</h2>
        </div>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>文件夹</th>
              <th className={styles.cTime}>时间</th>
              <th className={styles.cPdf}>编译</th>
              <th className={`${styles.cOps} ma-ops`}>操作</th>
            </tr>
          </thead>
          <tbody>
            {folders.length === 0 && (
              <tr>
                <td colSpan={4} className={styles.empty}>
                  还没有导出过
                </td>
              </tr>
            )}
            {historyPager.pageItems.map((f) => (
              <tr key={f.folder}>
                <td className="ma-mono">{f.folder}</td>
                <td className={`${styles.cTime} ma-mono`}>
                  {f.createdAt.slice(0, 19).replace('T', ' ')}
                </td>
                <td className={styles.cPdf}>
                  {f.hasPdf ? (
                    <span className="ma-badge accent">
                      {f.pdfs?.length ? f.pdfs.map((p) => p.replace('.pdf', '')).join(' / ') : '已生成 PDF'}
                    </span>
                  ) : (
                    <span className="ma-badge warn">无 PDF</span>
                  )}
                </td>
                <td className={`${styles.cOps} ma-ops`}>
                  <span className="ma-ops-cell">
                    <button onClick={() => downloadZip(f.folder)}>下载 zip</button>
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <Pager
          page={historyPager.page}
          pageCount={historyPager.pageCount}
          total={historyPager.total}
          unit="次导出"
          onChange={historyPager.setPage}
        />
      </section>

      {/* ---------- v3：备份与还原（从标签页搬来）----------
          标签页只管标签的浏览与治理；凡是「备份/还原」都集中在设置页这一处。 */}
      <section className={styles.tableCard}>
        <div className={styles.head} style={{ padding: '.7rem .8rem', marginBottom: 0 }}>
          <h2 className={styles.h2}>备份与还原</h2>
          <span className={styles.hint}>
            最多保留 {BACKUP_LIMIT} 条（共 {fieldBackups.length} / {BACKUP_LIMIT}）
          </span>
        </div>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>时间</th>
              <th>操作</th>
              <th className={styles.cPdf}>影响</th>
              <th className={`${styles.cOps} ma-ops`}>操作</th>
            </tr>
          </thead>
          <tbody>
            {fieldBackups.length === 0 && (
              <tr>
                <td colSpan={4} className={styles.empty}>
                  还没有备份
                </td>
              </tr>
            )}
            {fieldBackupPager.pageItems.map((b) => (
              <tr key={b.id}>
                <td className="ma-mono">{b.createdAt.replace('T', ' ').slice(0, 19)}</td>
                <td className="ma-mono">{b.operation}</td>
                <td className={styles.cPdf}>{b.affected.length} 道题</td>
                <td className={`${styles.cOps} ma-ops`}>
                  <span className="ma-ops-cell">
                    <button onClick={() => doRestoreFieldBackup(b.id)} disabled={!!busy}>
                      {busy === 'restoreField' ? '还原中…' : '还原'}
                    </button>
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <Pager
          page={fieldBackupPager.page}
          pageCount={fieldBackupPager.pageCount}
          total={fieldBackupPager.total}
          unit="份备份"
          onChange={fieldBackupPager.setPage}
        />
      </section>

      {/* ---------- v10：路径 + 当前题库 + 索引 + 整库备份（都属于"偶尔才动一次"） ---------- */}

      <PathSettings />

      {/* 当前题库（= 当前学科） */}
      <section className="ma-card">
        <h2 className={styles.h2}>当前题库</h2>
        <div className={styles.kvList}>
          <div className={styles.kv}>
            <span className={styles.kvKey}>题库位置</span>
            <span className="ma-mono">{backup?.vaultPath ?? '…'}</span>
          </div>
          <div className={styles.kv}>
            <span className={styles.kvKey}>当前学科的题库目录</span>
            <span className="ma-mono">{backup?.bankPath ?? '…'}</span>
          </div>
          <div className={styles.kv}>
            <span className={styles.kvKey}>题目数</span>
            <span>
              <b>{backup?.questionCount ?? '…'}</b> 道
            </span>
          </div>
          <div className={styles.kv}>
            <span className={styles.kvKey}>文件占用</span>
            <span>
              {backup ? `${backup.fileCount} 个文件，${human(backup.rawBytes)}` : '…'}
            </span>
          </div>
        </div>
      </section>

      <section className="ma-card">
        <div className={styles.head}>
          <h2 className={styles.h2}>检索索引</h2>
        </div>
        <button className="primary" onClick={rebuild} disabled={!!busy}>
          {busy === 'rebuild' ? '重建中…' : '重建索引'}
        </button>
      </section>

      <section className="ma-card">
        <div className={styles.head}>
          <h2 className={styles.h2}>整库备份</h2>
        </div>
        <div className={styles.row}>
          <button className="primary" onClick={doBackup} disabled={!!busy}>
            {busy === 'backup' ? '打包中…' : '下载整库备份 (.zip)'}
          </button>
          <span className={styles.hint}>
            约 {backup ? human(backup.rawBytes) : '…'}
          </span>
        </div>
      </section>
    </div>
  );
}
