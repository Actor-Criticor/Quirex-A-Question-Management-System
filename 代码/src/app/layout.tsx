import type { Metadata } from "next";
import "katex/dist/katex.min.css";
import "./globals.css";
import "./nav.css";
import Nav from "@/components/Nav";

export const metadata: Metadata = {
  title: "Quirex",
};

/**
 * 在首屏绘制前就把主题写到 <html data-theme>，避免深色用户看到白屏闪一下。
 * 这段脚本必须内联且尽早执行，所以直接放在 body 开头（不能放到 effect 里）。
 */
const THEME_BOOTSTRAP = `try{if(localStorage.getItem('theme')==='dark'){document.documentElement.setAttribute('data-theme','dark')}}catch(e){}`;

/**
 * suppressHydrationWarning 是**必须的**，不是掩盖问题：
 *
 * 上面那段内联脚本会在 HTML 解析阶段（**早于 React hydrate**）就给 `<html>` 加上
 * `data-theme="dark"`。于是 hydrate 时真实 DOM 有这个属性、而服务端发出的 HTML
 * 字符串里没有 —— React 会报
 * "A tree hydrated but some attributes of the server rendered HTML didn't match"
 * （**只有深色模式下才触发**，所以浅色用户看不到、很容易被当成偶发问题）。
 *
 * 这个不匹配**无法靠改代码消除**：
 *   · 要么放弃「首屏绘制前就写好主题」→ 深色用户每次进页面都闪一下白屏；
 *   · 要么让 React 接受这一处差异 —— React 就是为「挂在 <html> 上的主题属性」
 *     这类场景提供了这个开关，而且它**只作用于该元素自身的属性**，
 *     不会掩盖子组件里真正的问题。
 *
 * ⚠️ 别顺手删掉它 —— 删了 Console 会继续报。
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
        <Nav />
        <main className="ma-main">{children}</main>
      </body>
    </html>
  );
}
