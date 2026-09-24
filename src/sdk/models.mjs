/** Read-only model diagnostics and explicit task-role selection. */
export { resolveProviderProfile, resolveTaskModel, TASK_MODEL_ROLES } from '../kernel/index.mjs'
// Host-side preparation only: no inferred consent, persistence or inference.
export { prepareBudgetProfile, prepareBudgetProfiles } from '../usage/budget-profiles.mjs'
