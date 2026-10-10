/**
 * cdp.ts — 一个极小的 Chrome DevTools Protocol 客户端（只够"点一下、读 DOM"用）
 *
 * 为什么要它：导出弹窗是**只有点开才存在**的界面，`--dump-dom` 那种一锤子渲染
 * 看不到它。要真正验证"点一下弹出窗口、勾选实时预览、确认后导出"，
 * 就必须能驱动浏览器。
 *
 * 用 Node 自带的 WebSocket（Node 22+），不装任何依赖。
 */

import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const CHROME_CANDIDATES = [
  path.join(process.env.LOCALAPPDATA ?? '', 'Google/Chrome/Application/chrome.exe'),
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
];

export function findChrome(): string | null {
  for (const p of CHROME_CANDIDATES) {
    if (p && fs.existsSync(p)) return p;
  }
  return null;
}

interface CdpMessage {
  id?: number;
  result?: unknown;
  error?: { message: string };
  method?: string;
  params?: unknown;
}

export class Chrome {
  private proc: ChildProcess | null = null;
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, (m: CdpMessage) => void>();
  private profile = '';
  /** 页面里抛出的异常与 console.error —— 界面"看起来没反应"时，答案常在这里 */
  readonly errors: string[] = [];

  /** 起一个无头 Chrome 并连上第一个页面 */
  async start(port: number): Promise<void> {
    const bin = findChrome();
    if (!bin) throw new Error('找不到 Chrome/Edge，无法做真实浏览器校验');
    this.profile = fs.mkdtempSync(path.join(os.tmpdir(), 'quirex-cdp-'));

    this.proc = spawn(
      bin,
      [
        '--headless=new',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${this.profile}`,
        'about:blank',
      ],
      { stdio: 'ignore', windowsHide: true }
    );

    const base = `http://127.0.0.1:${port}`;
    let target: { webSocketDebuggerUrl?: string } | null = null;
    for (let i = 0; i < 60 && !target; i++) {
      await new Promise((r) => setTimeout(r, 250));
      try {
        const list = (await (await fetch(`${base}/json/list`)).json()) as Array<{
          type: string;
          webSocketDebuggerUrl?: string;
        }>;
        target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl) ?? null;
      } catch {
        /* 还没起来 */
      }
    }
    if (!target?.webSocketDebuggerUrl) throw new Error('连不上 Chrome 调试端口');

    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise<void>((res, rej) => {
      ws.onopen = () => res();
      ws.onerror = () => rej(new Error('WebSocket 连接失败'));
    });
    ws.onmessage = (ev) => {
      let msg: CdpMessage;
      try {
        msg = JSON.parse(String(ev.data)) as CdpMessage;
      } catch {
        return;
      }
      // 事件（没有 id）：只收异常与 console 错误
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params as { exceptionDetails?: { text?: string; exception?: { description?: string } } };
        this.errors.push(`[异常] ${d?.exceptionDetails?.exception?.description ?? d?.exceptionDetails?.text ?? ''}`);
        return;
      }
      if (msg.method === 'Runtime.consoleAPICalled') {
        const d = msg.params as { type?: string; args?: Array<{ value?: unknown; description?: string }> };
        if (d?.type === 'error') {
          this.errors.push(
            `[console.error] ${(d.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ')}`
          );
        }
        return;
      }
      if (msg.id && this.pending.has(msg.id)) {
        const done = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        done(msg);
      }
    };
    this.ws = ws as unknown as WebSocket;

    await this.send('Runtime.enable');
    await this.send('Page.enable');
  }

  /** 直接发一条 CDP 命令（用于脚本设置视口大小等） */
  send(method: string, params: Record<string, unknown> = {}): Promise<CdpMessage> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, resolve);
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} 超时`));
      }, 30000);
      this.pending.set(id, (m) => {
        clearTimeout(timer);
        resolve(m);
      });
      (this.ws as unknown as { send(s: string): void }).send(JSON.stringify({ id, method, params }));
    });
  }

  /** 在页面里跑一段表达式，返回它的值 */
  async eval<T = unknown>(expr: string): Promise<T> {
    const m = await this.send('Runtime.evaluate', {
      expression: expr,
      awaitPromise: true,
      returnByValue: true,
    });
    const r = m.result as {
      result?: { value?: T };
      exceptionDetails?: {
        text: string;
        exception?: { description?: string; value?: unknown };
        lineNumber?: number;
        columnNumber?: number;
      };
    } | undefined;
    if (r?.exceptionDetails) {
      // v9：以前只报 exceptionDetails.text，那常常就是干巴巴一个 "Uncaught" ——
      // 真正有用的堆栈在 exception.description 里。把它带上，
      // 免得每次都要另写脚本去猜"页面脚本到底哪一行炸了"。
      const d = r.exceptionDetails;
      const desc = d.exception?.description ?? String(d.exception?.value ?? '');
      throw new Error(
        `页面脚本抛错：${d.text}${desc ? ` — ${desc}` : ''}` +
          (d.lineNumber !== undefined ? `（第 ${d.lineNumber} 行）` : '')
      );
    }
    return r?.result?.value as T;
  }

  async goto(url: string): Promise<void> {
    await this.send('Page.enable');
    await this.send('Page.navigate', { url });
  }
  /** 反复求值直到条件成立（或超时）。返回最后一次的值 */
  async waitFor<T>(expr: string, timeoutMs = 20000, label = ''): Promise<T> {
    const until = Date.now() + timeoutMs;
    let last: T = undefined as T;
    while (Date.now() < until) {
      last = await this.eval<T>(expr);
      if (last) return last;
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`等待超时${label ? `（${label}）` : ''}：${expr}`);
  }

  async close(): Promise<void> {
    try {
      (this.ws as unknown as { close(): void } | null)?.close();
    } catch {
      /* 已经关了 */
    }
    this.proc?.kill();
    try {
      fs.rmSync(this.profile, { recursive: true, force: true });
    } catch {
      /* 删不掉就算了 */
    }
  }
}
