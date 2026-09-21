/** Mode/permission option catalogs for the composer pickers. Pure; no I/O. */

export const MODE_OPTIONS = [
  { id: "agent", label: "agent", desc: "默认智能体模式" },
  { id: "plan", label: "plan", desc: "只读分析与规划" },
  { id: "agent-auto", label: "agent-auto", desc: "自动执行编辑" },
  { id: "ultra", label: "ultra", desc: "长任务编排" },
  { id: "yolo", label: "yolo", desc: "跳过常规确认" },
];

export const PERMISSION_OPTIONS = [
  { id: "readonly", label: "只读", desc: "不修改文件、不执行命令" },
  { id: "manual", label: "每次确认", desc: "敏感操作逐条确认" },
  { id: "accept-edits", label: "允许编辑", desc: "文件编辑免确认" },
  { id: "yolo", label: "跳过确认", desc: "仅在信任的工作区使用" },
];

const find = (options, id) => options.find((option) => option.id === id);

/** Display label for a permission level; sessions default to manual. */
export function permissionLabel(id = "") {
  return find(PERMISSION_OPTIONS, id)?.label || id || "每次确认";
}

/** Display label for an execution mode; falls back to the raw id. */
export function modeLabel(id = "") {
  return find(MODE_OPTIONS, id)?.label || id || "agent";
}
