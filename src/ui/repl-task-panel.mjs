import { formatPlanProgress } from "./activity-renderer.mjs"

export function renderTaskProgressPanel(taskProgress, formatter = formatPlanProgress) {
  return formatter(taskProgress)
}
