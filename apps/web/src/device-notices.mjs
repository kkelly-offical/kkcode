export function mcpLoadNotice(event) {
  if (event?.type !== 'mcp.loaded' || !event.configured) return '';
  const failures = (event.failed || []).slice(0, 3).map(item => item.name).join('、');
  return `MCP ${event.connected}/${event.configured} 已连接 · ${event.toolCount} 个工具${event.failedCount ? ` · ${event.failedCount} 项失败${failures ? `（${failures}）` : ''}` : ''}`;
}
