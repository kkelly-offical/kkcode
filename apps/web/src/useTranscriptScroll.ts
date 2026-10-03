import { useEffect, useLayoutEffect, useRef, useState } from 'react';

/** Follow the actual bottom only while the reader has chosen to stay there. */
export function useTranscriptScroll(identity: string, ready: boolean) {
  const viewport = useRef<HTMLDivElement>(null), content = useRef<HTMLDivElement>(null);
  const following = useRef(true), previousTop = useRef(0);
  const [away, setAway] = useState(false);
  const latest = () => {
    following.current = true; setAway(false);
    const element = viewport.current;
    if (element) { element.scrollTop = element.scrollHeight; previousTop.current = element.scrollTop; }
  };
  useLayoutEffect(() => { following.current = true; setAway(false); previousTop.current = 0; }, [identity]);
  useLayoutEffect(() => { if (ready) latest(); }, [identity, ready]);
  useEffect(() => {
    const element = viewport.current, body = content.current;
    if (!element || !body) return;
    const scroll = () => {
      const atBottom = element.scrollHeight - element.clientHeight - element.scrollTop < 36;
      if (element.scrollTop < previousTop.current - 2) following.current = false;
      if (atBottom) following.current = true;
      previousTop.current = element.scrollTop;
      setAway(!following.current && !atBottom);
    };
    const wheel = (event: WheelEvent) => { if (event.deltaY < 0) { following.current = false; setAway(true); } };
    // Expanding an earlier block is a reading action, not a request to jump.
    const interact = (event: Event) => { if ((event.target as Element)?.closest('summary,.load-history')) { following.current = false; setAway(true); } };
    const resize = new ResizeObserver(() => {
      if (following.current) latest();
      else setAway(element.scrollHeight - element.clientHeight - element.scrollTop >= 36);
    });
    resize.observe(body); resize.observe(element);
    element.addEventListener('scroll', scroll, { passive: true });
    element.addEventListener('wheel', wheel, { passive: true });
    element.addEventListener('click', interact, true);
    return () => { resize.disconnect(); element.removeEventListener('scroll', scroll); element.removeEventListener('wheel', wheel); element.removeEventListener('click', interact, true); };
  }, [identity, ready]);
  return { viewport, content, away, latest };
}
