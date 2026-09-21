import React from "react";

const paths = {
  menu: "M4 7h16M4 17h11",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  close: "m6 6 12 12M6 18 18 6",
  back: "m14 5-7 7 7 7",
  chevron: "m9 5 7 7-7 7",
  down: "m6 9 6 6 6-6",
  search: "M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0",
  chat: "M20 11v7a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3h7M15 3l4 4M10 16l1-5L20 2l3 3-9 10z",
  terminal: "M3 4h18v16H3zM6 8l4 4-4 4M13 16h5",
  folder: "M3 6h6l2 2h10v12H3zM3 6V4h6l2 2h8v2",
  settings: "M4 7h16M4 17h16M9 4v6M16 14v6",
  account:
    "M16 8a4 4 0 1 1-8 0 4 4 0 0 1 8 0M4 21v-2a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v2",
  plus: "M12 5v14M5 12h14",
  check: "m4 12 5 5L20 6",
  clock: "M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0M12 6v6l4 2",
  priority: "M12 3 3 20h18zM12 9v5M12 17h.01",
  archive: "M3 3h18v5H3zM5 8v13h14V8M10 12h4",
  link: "m9 15 6-6M8 16l-1 1a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0M16 8l1-1a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0",
  cloud: "M6 18a5 5 0 0 1-1-10 7 7 0 0 1 13-1 5.5 5.5 0 0 1 0 11z",
  extension:
    "M3 3h6a3 3 0 1 1 6 0h6v6a3 3 0 1 0 0 6v6h-6a3 3 0 1 0-6 0H3v-6a3 3 0 1 0 0-6z",
  shield: "m12 2 9 4v6c0 5-9 10-9 10S3 17 3 12V6zM8 12l3 3 5-6",
  mail: "M3 5h18v14H3zM3 5l9 8 9-8",
  building:
    "M5 22V2h14v20M9 6h.01M15 6h.01M9 10h.01M15 10h.01M9 14h.01M15 14h.01M10 22v-4h4v4",
  logout: "M9 3H3v18h6M10 12h12m-5-5 5 5-5 5",
  send: "M12 20V4m-7 7 7-7 7 7",
  stop: "M6 6h12v12H6z",
  message: "M3 4h18v13H9l-6 4zM7 8h10M7 12h6",
  attachment: "m8 12 7-7a4 4 0 0 1 6 6L10 22a6 6 0 0 1-8-8L13 3M6 16l10-10",
  branch: "M6 7v10M18 7v3a4 4 0 0 1-4 4H6M9 4a3 3 0 1 1-6 0 3 3 0 0 1 6 0M9 20a3 3 0 1 1-6 0 3 3 0 0 1 6 0M21 4a3 3 0 1 1-6 0 3 3 0 0 1 6 0",
} as const;
export type IconName = keyof typeof paths;
export function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={name === "more" ? 3.5 : 1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={paths[name]} />
    </svg>
  );
}
