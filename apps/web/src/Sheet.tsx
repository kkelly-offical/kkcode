import React, { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./Icon";

export function Sheet({
  title,
  onClose,
  onBack,
  children,
}: {
  title: string;
  onClose: () => void;
  onBack?: () => void;
  children: React.ReactNode;
}) {
  const heading = useId(),
    content = useRef<HTMLElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const root = document.getElementById("root")!;
    root.inert = true;
    content.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close.current();
        return;
      }
      if (event.key !== "Tab") return;
      const targets = [
        ...(content.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]',
        ) || []),
      ].filter((node) => node.getClientRects().length);
      const first = targets[0],
        last = targets.at(-1);
      if (!first) {
        event.preventDefault();
        return;
      }
      if (
        event.shiftKey &&
        (document.activeElement === first ||
          document.activeElement === content.current)
      ) {
        event.preventDefault();
        last?.focus();
      } else if (
        !event.shiftKey &&
        (document.activeElement === last ||
          document.activeElement === content.current)
      ) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", keydown);
    return () => {
      root.inert = false;
      document.removeEventListener("keydown", keydown);
      if (previous?.isConnected && previous !== document.body && !previous.matches(':disabled') && previous.getClientRects().length) previous.focus();
      else [...root.querySelectorAll<HTMLElement>('textarea:not(:disabled)'), ...root.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)')].find(node => node.getClientRects().length)?.focus();
    };
  }, []);
  useEffect(() => {
    content.current?.focus();
  }, [title]);
  return createPortal(
    <div
      className="sheet-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={heading}
        tabIndex={-1}
        ref={content}
      >
        <div className="sheet-heading">
          {onBack ? (
            <button
              className="round sheet-back"
              aria-label="返回上一级"
              onClick={onBack}
            >
              <Icon name="back" />
            </button>
          ) : (
            <span className="heading-spacer" />
          )}
          <h2 id={heading}>{title}</h2>
          <button className="round" aria-label="关闭" onClick={onClose}>
            <Icon name="close" />
          </button>
        </div>
        <div className="sheet-body" key={title}>
          {children}
        </div>
      </section>
    </div>,
    document.body,
  );
}
