// OS/SQLite messages may contain private paths, SQL, or user-controlled data.
// Only fixed symbolic codes and a bounded SQLite numeric code leave the worker.
const safeCodes = new Set(['EACCES', 'EPERM', 'EBADF', 'EIO', 'ENOSPC', 'EROFS', 'EMFILE', 'ENFILE', 'ENOENT', 'EEXIST', 'EINVAL', 'ENAMETOOLONG', 'ENOTDIR', 'EISDIR', 'EBUSY', 'EXDEV', 'ELOOP', 'ENOTEMPTY', 'ERR_SQLITE_ERROR'])
const safeOperations = new Set(['initialize', 'createBackup', 'listBackups', 'verifyBackup', 'restoreBackup', 'close', 'request'])
const safeSyscalls = new Set(['open', 'close', 'read', 'write', 'fsync', 'fdatasync', 'mkdir', 'rmdir', 'unlink', 'link', 'rename', 'stat', 'lstat', 'fstat', 'realpath', 'chmod', 'readdir'])

/** @param {unknown} error @param {string} [operation] */
export function redactedStorageFailure(error, operation = 'request') {
  const value = error && typeof error === 'object' ? /** @type {Record<string, unknown>} */ (error) : {}
  const causeCode = typeof value.code === 'string' && safeCodes.has(value.code) ? value.code : 'UNCLASSIFIED'
  const phase = safeOperations.has(operation) ? operation : 'request'
  const syscall = typeof value.syscall === 'string' && safeSyscalls.has(value.syscall) ? `, syscall=${value.syscall}` : ''
  const sqlite = causeCode === 'ERR_SQLITE_ERROR' && Number.isSafeInteger(value.errcode) && Number(value.errcode) >= 0 && Number(value.errcode) <= 65535 ? `, sqliteCode=${value.errcode}` : ''
  return { code: 'STORE_UNAVAILABLE', message: `Durable run storage failed (operation=${phase}, causeCode=${causeCode}${syscall}${sqlite}); do not retry effects until persisted state has been inspected` }
}
