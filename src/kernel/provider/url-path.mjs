/** Remove only trailing ASCII slashes in linear time, without regex backtracking.
 * @param {string} value
 */
export function trimTrailingSlashes(value) {
  let end = value.length
  while (end > 0 && value.charCodeAt(end - 1) === 47) end--
  return end === value.length ? value : value.slice(0, end)
}
