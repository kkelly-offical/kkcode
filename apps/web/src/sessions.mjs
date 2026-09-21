const timestamp = (session) => {
  const value = session.updatedAt || session.createdAt;
  if (typeof value === "number") return value;
  return Date.parse(value) || 0;
};
const day = (value) => {
  const date = new Date(value);
  return (
    Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86400000
  );
};
const priority = (session) => /^running(-|$)/.test(session.status || "");

/** Pure home-list projection; never changes stored sessions. */
export function groupSessions(
  sessions,
  { sort = "priority", query = "", archived = false, now = Date.now() } = {},
) {
  const needle = query.trim().toLocaleLowerCase();
  const filtered = sessions.filter(
    (session) =>
      Boolean(session.archived) === archived &&
      `${session.title || ""} ${session.cwd || ""}`
        .toLocaleLowerCase()
        .includes(needle),
  );
  filtered.sort(
    (a, b) =>
      (sort === "priority" ? Number(priority(b)) - Number(priority(a)) : 0) ||
      timestamp(b) - timestamp(a),
  );
  const groups = new Map();
  for (const session of filtered) {
    const age = day(now) - day(timestamp(session));
    const group =
      sort === "project"
        ? String(session.cwd || "")
            .split(/[\\/]/)
            .filter(Boolean)
            .at(-1) || "其他项目"
        : sort === "priority" && priority(session)
          ? "优先级"
          : age <= 0
            ? "今天"
            : age === 1
              ? "昨天"
              : age < 7
                ? "过去 7 天"
                : age < 30
                  ? "过去 30 天"
                  : "更早";
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(session);
  }
  return [...groups];
}
