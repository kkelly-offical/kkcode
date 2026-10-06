import { useEffect, useLayoutEffect, useRef, useState } from 'react';

/** Follow the actual bottom only while the reader has chosen to stay there. */
export function useTranscriptScroll(identity: string, ready: boolean) {
  const viewport = useRef<HTMLDivElement>(null), content = useRef<HTMLDivElement>(null);
  const following = useRef(true), previousTop = useRef(0);
  const navigationHold = useRef(false);
  const [away, setAway] = useState(false);
  const [canReturn, setCanReturn] = useState(false);
  const bookmark = useRef<{ top: number; following: boolean; node: HTMLElement | null; offset: number } | null>(null);
  const highlight = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const latest = () => {
    navigationHold.current = false;
    following.current = true; setAway(false);
    const element = viewport.current;
    if (element) { element.scrollTo({ top: element.scrollHeight, behavior: 'instant' }); previousTop.current = element.scrollTop; }
  };
  const reveal = (id: string) => {
    const element = viewport.current, body = content.current;
    const target = [...(body?.querySelectorAll<HTMLElement>('[data-row-id]') || [])].find(node => node.dataset.rowId === id);
    if (!element || !target) return false;
    const rect = element.getBoundingClientRect();
    const anchor = [...(body?.querySelectorAll<HTMLElement>('[data-row-id]') || [])].find(node => { const bounds = node.getBoundingClientRect(); return bounds.bottom > rect.top && bounds.top < rect.bottom && bounds.height > 0; }) || null;
    bookmark.current = { top: element.scrollTop, following: following.current, node: anchor, offset: anchor ? anchor.getBoundingClientRect().top - rect.top : 0 };
    following.current = false; navigationHold.current = true;
    for (let parent = target.parentElement; parent && parent !== element; parent = parent.parentElement) if (parent instanceof HTMLDetailsElement) parent.open = true;
    element.scrollTop += target.getBoundingClientRect().top - element.getBoundingClientRect().top - 16;
    previousTop.current = element.scrollTop; setAway(true); setCanReturn(true);
    element.dispatchEvent(new Event('scroll')); element.focus({ preventScroll: true });
    body?.querySelectorAll('.history-highlight').forEach(node => node.classList.remove('history-highlight'));
    target.classList.add('history-highlight'); clearTimeout(highlight.current);
    highlight.current = setTimeout(() => target.classList.remove('history-highlight'), 2400);
    return true;
  };
  const returnToReading = () => {
    const saved = bookmark.current, element = viewport.current;
    if (!saved || !element) return;
    if (saved.following) latest();
    else {
      following.current = false; navigationHold.current = true;
      element.scrollTop = saved.node?.isConnected ? element.scrollTop + saved.node.getBoundingClientRect().top - element.getBoundingClientRect().top - saved.offset : saved.top;
      previousTop.current = element.scrollTop; element.dispatchEvent(new Event('scroll'));
    }
    bookmark.current = null; setCanReturn(false);
  };
  useLayoutEffect(() => { following.current = true; navigationHold.current = false; setAway(false); previousTop.current = 0; bookmark.current = null; setCanReturn(false); clearTimeout(highlight.current); }, [identity]);
  useEffect(() => () => clearTimeout(highlight.current), []);
  useLayoutEffect(() => { if (ready) latest(); }, [identity, ready]);
  useEffect(() => {
    const element = viewport.current, body = content.current;
    if (!element || !body) return;
    let anchor: { node: Element; top: number } | null = null;
    const distance = () => element.scrollHeight - element.clientHeight - element.scrollTop;
    const capture = () => {
      if (following.current) { anchor = null; return; }
      const rect = element.getBoundingClientRect();
      // Hit-test a few visible positions instead of measuring the whole history
      // on every wheel frame. A modal may cover them; retain the last anchor.
      for (const offset of [12, 40, 100]) {
        if (offset >= rect.height) continue;
        const node = document.elementFromPoint(rect.x + rect.width / 2, rect.y + offset)?.closest('p,pre,li,h1,h2,h3,h4,summary,.message,.context-divider');
        if (node && body.contains(node)) { anchor = { node, top: node.getBoundingClientRect().top - rect.top }; return; }
      }
    };
    const pause = () => { following.current = false; capture(); setAway(distance() > 4); };
    const scroll = () => {
      const atBottom = distance() <= 4;
      if (element.scrollTop < previousTop.current - 2) following.current = false;
      if (atBottom && !navigationHold.current) following.current = true;
      previousTop.current = element.scrollTop;
      setAway(!following.current && !atBottom); capture();
    };
    const nestedScroll = (target: EventTarget | null, horizontal = false) => {
      for (let node = target instanceof HTMLElement ? target : null; node && node !== element; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (/(auto|scroll)/.test(horizontal ? style.overflowX : style.overflowY)
          && (horizontal ? node.scrollWidth > node.clientWidth + 1 : node.scrollHeight > node.clientHeight + 1)) return node;
      }
      return null;
    };
    const wheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey) return;
      if (nestedScroll(event.target, event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) && (event.deltaX || event.deltaY)) { pause(); return; }
      if (!event.shiftKey && event.deltaY > 0 && Math.abs(event.deltaY) >= Math.abs(event.deltaX)) { navigationHold.current = false; if (distance() <= 4) latest(); }
      if (!event.shiftKey && event.deltaY < 0 && Math.abs(event.deltaY) >= Math.abs(event.deltaX) && element.scrollHeight > element.clientHeight + 4) pause();
    };
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey
        || (event.target as Element)?.closest('input,textarea,select,button,a,summary,[contenteditable="true"]')) return;
      const horizontal = ['ArrowLeft', 'ArrowRight'].includes(event.key);
      const inner = nestedScroll(event.target, horizontal);
      if (horizontal) {
        if (inner) { pause(); event.preventDefault(); inner.scrollBy({ left: event.key === 'ArrowLeft' ? -40 : 40, behavior: 'instant' }); }
        return;
      }
      const scroller = inner || element, page = scroller.clientHeight * .85;
      const delta = ({ ArrowUp: -40, ArrowDown: 40, PageUp: -page, PageDown: page, ' ': event.shiftKey ? -page : page } as Record<string, number>)[event.key];
      if (delta === undefined && !['Home', 'End'].includes(event.key)) return;
      if (!inner && delta > 0) navigationHold.current = false;
      // Chrome's animated PageUp can outlive a subsequent instant jump. Keep
      // reading-region keyboard commands immediate, without changing wheel,
      // touch, scrollbar, editing, or browser shortcut behavior.
      event.preventDefault();
      if (!inner && event.key === 'End') { latest(); return; }
      if (inner || event.key === 'Home' || delta < 0) pause();
      if (event.key === 'Home') scroller.scrollTo({ top: 0, behavior: 'instant' });
      else if (event.key === 'End') scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'instant' });
      else scroller.scrollBy({ top: delta, behavior: 'instant' });
    };
    let touchY: number | null = null;
    const touchStart = (event: TouchEvent) => { touchY = event.touches.length === 1 ? event.touches[0].clientY : null; };
    const touchMove = (event: TouchEvent) => {
      if (touchY !== null && event.touches.length === 1 && event.touches[0].clientY > touchY + 3) pause();
      if (touchY !== null && event.touches.length === 1 && event.touches[0].clientY < touchY - 3) { navigationHold.current = false; if (distance() <= 4) latest(); }
      touchY = event.touches.length === 1 ? event.touches[0].clientY : null;
    };
    const interact = (event: Event) => { if ((event.target as Element)?.closest('summary,.load-history')) pause(); };
    const scrollbar = (event: PointerEvent) => { if (event.target === element) navigationHold.current = false; };
    const resize = new ResizeObserver(() => {
      if (following.current) latest();
      else {
        if (anchor?.node.isConnected && anchor.node.getClientRects().length) {
          const delta = anchor.node.getBoundingClientRect().top - element.getBoundingClientRect().top - anchor.top;
          if (Math.abs(delta) > 1) element.scrollTop += delta;
        }
        previousTop.current = element.scrollTop;
        setAway(distance() > 4); capture();
      }
    });
    resize.observe(body); resize.observe(element);
    element.addEventListener('scroll', scroll, { passive: true });
    element.addEventListener('wheel', wheel, { passive: true });
    element.addEventListener('touchstart', touchStart, { passive: true });
    element.addEventListener('touchmove', touchMove, { passive: true });
    element.addEventListener('keydown', key);
    element.addEventListener('click', interact, true);
    element.addEventListener('pointerdown', scrollbar);
    return () => {
      resize.disconnect(); element.removeEventListener('scroll', scroll); element.removeEventListener('wheel', wheel);
      element.removeEventListener('touchstart', touchStart); element.removeEventListener('touchmove', touchMove);
      element.removeEventListener('keydown', key); element.removeEventListener('click', interact, true);
      element.removeEventListener('pointerdown', scrollbar);
    };
  }, [identity, ready]);
  return { viewport, content, away, latest, reveal, canReturn, returnToReading };
}
