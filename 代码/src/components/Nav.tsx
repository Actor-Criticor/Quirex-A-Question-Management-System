'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import ThemeToggle from './ThemeToggle';
import { SubjectSwitcher } from './SubjectSwitcher';
import { clientEnv } from '@/lib/env';

const LINKS = [
  { href: '/', label: '题库' },
  { href: '/add', label: '录入' },
  { href: '/tags', label: '标签' },
  { href: '/baskets', label: '试题篮' },
  { href: '/settings', label: '设置' },
];

export default function Nav() {
  const pathname = usePathname();

  return (
    <header className="ma-nav">
      <Link href="/" className="ma-nav-brand">
        {clientEnv.appName}
      </Link>
      <nav className="ma-nav-links">
        {LINKS.map((l) => {
          const active = l.href === '/' ? pathname === '/' : pathname.startsWith(l.href);
          return (
            <Link key={l.href} href={l.href} className={active ? 'ma-nav-link active' : 'ma-nav-link'}>
              {l.label}
            </Link>
          );
        })}
      </nav>
      <div className="ma-nav-right">
        {/* v9：学科切换条（越新的学科越靠右，紧挨着加号） */}
        <SubjectSwitcher />
        <ThemeToggle />
      </div>
    </header>
  );
}
