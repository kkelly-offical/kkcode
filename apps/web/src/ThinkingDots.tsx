import React from 'react';

/** Decorative only: the adjacent Thinking label is the accessible status. */
export function ThinkingDots() {
  return <span className="thinking-dots" aria-hidden="true" data-testid="thinking-dots">
    {Array.from({ length: 9 }, (_, index) => <span key={index} style={{ animationDelay: `${index * -110}ms` }} />)}
  </span>;
}
