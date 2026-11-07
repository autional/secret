import type { ReactNode } from 'react';

/**
 * 页面内的区块容器（**无边框、无背景**）。
 *
 * 为什么不用 SectionCard：AppShell 的内容区已经是一张白色圆角面板，
 * 再套一层带边框/底色的 SectionCard 就是「卡片套卡片」，页面到处都是一层框。
 * 这里只负责标题层级与间距，面由外壳提供（同一块面只能有一个所有者）。
 */
export function PageSection({
  title,
  children,
  className = '',
}: {
  title?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={className}>
      {title ? (
        <h2 className="mb-3 text-base font-semibold text-[var(--color-text-primary)]">{title}</h2>
      ) : null}
      {children}
    </section>
  );
}
