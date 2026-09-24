// Container-only IPC executable. Never imported into the in-host kernel.
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

const MAX = 2 * 1024 * 1024
const request = JSON.parse(fs.readFileSync(0, 'utf8'))
const root = '/workspace'
const hash = text => createHash('sha256').update(text).digest('hex')
const within = value => value === root || value.startsWith(`${root}/`)
const privateName = name => ['.git', '.kkcode', '.ssh', '.aws', '.azure', '.kube', '.gnupg', '.docker', '.npmrc', '.pypirc', '.netrc', '.envrc', '.mcp.json'].includes(name.toLowerCase()) || /^\.env(?:\.|$)/i.test(name)

function target(raw) {
  if (typeof raw !== 'string') throw new Error('文件路径不能为空')
  const value = path.resolve(root, raw)
  if (!within(value) || path.relative(root, value).split('/').some(privateName)) throw new Error('文件路径超出任务范围或属于私密配置')
  let ancestor = value
  while (!fs.existsSync(ancestor)) {
    try { if (fs.lstatSync(ancestor).isSymbolicLink()) throw new Error('不允许悬空路径别名') } catch (error) { if (error.code !== 'ENOENT') throw error }
    ancestor = path.dirname(ancestor)
  }
  if (!within(fs.realpathSync(ancestor))) throw new Error('文件路径别名超出任务范围')
  if (fs.existsSync(value)) {
    const stat = fs.statSync(value)
    if (!stat.isFile() && !stat.isDirectory()) throw new Error('不支持特殊文件')
    if (stat.isFile() && stat.nlink !== 1) throw new Error('不允许硬链接文件')
  }
  return value
}

function read(file) {
  const stat = fs.statSync(file)
  if (!stat.isFile() || stat.size > MAX) throw new Error('严格文本工具单文件最多 2 MiB，请缩小范围')
  const value = fs.readFileSync(file, 'utf8')
  if (value.includes('\0')) throw new Error('严格 read 只支持源文本；媒体请使用单独授权的产物流程')
  return value
}

function write(file, value) {
  if (typeof value !== 'string' || Buffer.byteLength(value) > MAX) throw new Error('写入内容超过严格文本工具限制')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.kkcode-${process.pid}-${Math.random().toString(36).slice(2)}.tmp`
  const mode = fs.existsSync(file) ? fs.statSync(file).mode & 0o777 : 0o644
  try { fs.writeFileSync(tmp, value, { mode, flag: 'wx' }); fs.renameSync(tmp, file) }
  finally { try { fs.unlinkSync(tmp) } catch {} }
}

try {
  const { tool, args, baseline = {} } = request
  if (tool === 'list') {
    const dir = target(args.path || '.')
    const entries = fs.readdirSync(dir, { withFileTypes: true }).filter(entry => !privateName(entry.name)).slice(0, 500)
    process.stdout.write(JSON.stringify({ output: entries.map(entry => `${entry.name}${entry.isDirectory() ? '/' : ''}`).join('\n') || '(empty directory)' }))
  } else if (tool === 'read') {
    if (args.view === 'image' || args.pages || (args.encoding && args.encoding !== 'utf8')) throw new Error('严格 read 暂只支持 UTF-8 源文本')
    const file = target(args.path), text = read(file), lines = text.split('\n')
    const offset = Math.max(0, Number(args.offset || 1) - 1), limit = Math.max(1, Math.min(2000, Number(args.limit || 2000)))
    const output = lines.slice(offset, offset + limit).map((line, index) => `${offset + index + 1}→${line}`).join('\n')
    process.stdout.write(JSON.stringify({ output, readHashes: { [args.path]: hash(text) } }))
  } else {
    const changes = Array.isArray(args.changes) ? args.changes : [{ ...args, operation: tool }]
    if (!changes.length || changes.length > 32) throw new Error('严格批量编辑应包含 1–32 个文件')
    const planned = [], seen = new Set()
    for (const change of changes) {
      const file = target(change.path)
      if (seen.has(file)) throw new Error('一次事务不能重复编辑相同文件')
      seen.add(file)
      const exists = fs.existsSync(file), previous = exists ? read(file) : null
      if (exists && baseline[change.path] !== hash(previous)) throw new Error('文件尚未读取或已被修改；请重新 read 后编辑')
      let next
      if (change.operation === 'write') next = change.content
      else if (change.operation === 'patch' || change.start_line !== undefined) {
        if (!exists) throw new Error('行号编辑需要现有文件')
        const lines = previous.split('\n'), start = Number(change.start_line), end = Number(change.end_line)
        if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > lines.length) throw new Error('行号范围无效')
        lines.splice(start - 1, end - start + 1, ...String(change.content || '').split('\n')); next = lines.join('\n')
      } else if (!Object.hasOwn(change, 'before')) {
        if (exists) throw new Error('已有文件不能通过省略 before 覆盖')
        next = change.after
      } else {
        if (!exists || typeof change.before !== 'string' || !change.before) throw new Error('文本编辑需要非空 before')
        const pieces = previous.split(change.before)
        if (pieces.length < 2 || (pieces.length > 2 && !change.replace_all)) throw new Error('匹配不存在或不唯一；请提供准确上下文')
        next = pieces.join(String(change.after ?? ''))
      }
      if (typeof next !== 'string' || Buffer.byteLength(next) > MAX) throw new Error('写入内容无效或过大')
      planned.push({ file, path: change.path, previous, next })
    }
    const applied = []
    try { for (const item of planned) { write(item.file, item.next); applied.push(item) } }
    catch (error) {
      let rollbackFailed = false
      for (const item of applied.reverse()) { try { if (item.previous === null) fs.unlinkSync(item.file); else write(item.file, item.previous) } catch { rollbackFailed = true } }
      if (rollbackFailed) throw new Error('编辑失败且部分恢复未完成，请检查候选工作区')
      throw error
    }
    process.stdout.write(JSON.stringify({ output: `已编辑 ${planned.length} 个文件`, readHashes: Object.fromEntries(planned.map(item => [item.path, hash(item.next)])), metadata: { fileChanges: planned.map(item => ({ path: item.path, operation: item.previous === null ? 'create' : 'edit' })) } }))
  }
} catch (error) {
  process.stdout.write(JSON.stringify({ output: `error: ${error.message}`, status: 'error' }))
  process.exitCode = 1
}
