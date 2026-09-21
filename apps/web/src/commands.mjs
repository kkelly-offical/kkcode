/** Name/alias matches must outrank incidental matches inside descriptions. */
export function commandSuggestions(commands, query = "") {
  const needle = query.toLowerCase();
  const rank = (command) => {
    const name = String(command.name || "").toLowerCase();
    if (name === needle) return 0;
    if (name.startsWith(needle)) return 1;
    if (
      (command.aliases || []).some((alias) =>
        alias.toLowerCase().startsWith(needle),
      )
    )
      return 2;
    if (name.includes(needle)) return 3;
    return String(command.description || "")
      .toLowerCase()
      .includes(needle)
      ? 4
      : 5;
  };
  return commands
    .map((command, index) => ({ command, index, rank: rank(command) }))
    .filter((item) => item.rank < 5)
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .slice(0, 12)
    .map((item) => item.command);
}
