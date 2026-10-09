import { useEffect, useRef, useState, useCallback, useLayoutEffect } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowDown } from 'lucide-react';

/**
 * Virtualized, bottom-anchored message list. Only the visible window of rows is mounted, so
 * 10k-message rooms stay smooth on low-end phones. Auto-sticks to the bottom unless the user scrolled up.
 */
export default function MessageList({ items, renderItem, footer, emptyState, label = 'Messages' }) {
  const parentRef = useRef(null);
  const [atBottom, setAtBottom] = useState(true);
  const [unread, setUnread] = useState(0);
  const prevLen = useRef(0);

  const virt = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 56,
    overscan: 10,
    getItemKey: (i) => items[i].key,
  });

  const scrollToEnd = useCallback(
    (smooth = false) => {
      if (!items.length) return;
      virt.scrollToIndex(items.length - 1, { align: 'end', behavior: smooth ? 'smooth' : 'auto' });
      requestAnimationFrame(() => {
        const el = parentRef.current;
        if (el) el.scrollTop = el.scrollHeight;
      });
    },
    [items.length, virt],
  );

  const onScroll = useCallback(() => {
    const el = parentRef.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    setAtBottom(near);
    if (near) setUnread(0);
  }, []);

  useLayoutEffect(() => {
    const added = items.length - prevLen.current;
    prevLen.current = items.length;
    if (added <= 0) return;
    const lastMine = items[items.length - 1]?.from === 'me' || items[items.length - 1]?.mine;
    if (atBottom || lastMine) scrollToEnd();
    else setUnread((u) => u + added);
  }, [items, atBottom, scrollToEnd]);

  useEffect(() => {
    scrollToEnd();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={parentRef} onScroll={onScroll} role="log" aria-live="polite" aria-label={label} className="scrollbar-thin h-full overflow-y-auto overscroll-contain px-3 py-3">
        {items.length === 0 && emptyState}
        <div style={{ height: virt.getTotalSize(), position: 'relative', width: '100%' }}>
          {virt.getVirtualItems().map((row) => (
            <div key={row.key} data-index={row.index} ref={virt.measureElement} style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${row.start}px)` }}>
              {renderItem(items[row.index], row.index)}
            </div>
          ))}
        </div>
        {footer}
      </div>
      {!atBottom && (
        <button onClick={() => (scrollToEnd(true), setUnread(0))} className="btn-primary btn-sm absolute bottom-3 right-3 shadow-xl" aria-label="Scroll to latest messages">
          <ArrowDown className="h-4 w-4" aria-hidden="true" />
          {unread > 0 ? `${unread} new` : 'Latest'}
        </button>
      )}
    </div>
  );
}
