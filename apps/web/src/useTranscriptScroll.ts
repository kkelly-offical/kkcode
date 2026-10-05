import { useEffect, useLayoutEffect, useRef, useState } from 'react';

/** Follow the actual bottom only while the reader has chosen to stay there. */
export function useTranscriptScroll(identity: string, ready: boolean) {
  const viewport = useRef<HTMLDivElement>(null), content = useRef<HTMLDivElement>(null);
  const following = useRef(true), previousTop = useRef(0);
  const [away, setAway] = useState(false);
  const latest = () => {
    following.current = true; setAway(false);
    const element = viewport.current;
    if (element) { element.scrollTo({ top: element.scrollHeight, behavior: 'instant' }); previousTop.current = element.scrollTop; }
  };
  useLayoutEffect(() => { following.current = true; setAway(false); previousTop.current = 0; }, [identity]);
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
      if (atBottom) following.current = true;
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
      touchY = event.touches.length === 1 ? event.touches[0].clientY : null;
    };
    const interact = (event: Event) => { if ((event.target as Element)?.closest('summary,.load-history')) pause(); };
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
    return () => {
      resize.disconnect(); element.removeEventListener('scroll', scroll); element.removeEventListener('wheel', wheel);
      element.removeEventListener('touchstart', touchStart); element.removeEventListener('touchmove', touchMove);
      element.removeEventListener('keydown', key); element.removeEventListener('click', interact, true);
    };
  }, [identity, ready]);
  return { viewport, content, away, latest };
}
