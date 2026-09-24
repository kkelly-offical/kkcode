import { parse } from 'acorn'

const BANNED_KEYS = new Set(['__proto__', 'prototype', 'constructor', 'then', 'catch', 'finally', 'toJSON', 'toString', 'valueOf'])
const RESERVED = new Set(['tools', 'JSON', 'Object', 'Math', 'emit', 'undefined', 'process', 'globalThis', 'global', 'window', 'self', 'require', 'module', 'exports', 'eval', 'Function', 'Promise', 'Reflect', 'Proxy', 'WebAssembly', 'console', 'import'])
const FORBIDDEN_TOOLS = new Set(['tool_program', 'tool_batch', 'task', 'task_group', 'task_parallel', 'skill', 'enter_plan', 'exit_plan', 'background_cancel', 'task_stop'])
const PURE_METHODS = new Set(['call', 'parse', 'stringify', 'keys', 'values', 'entries', 'slice', 'includes', 'startsWith', 'endsWith', 'split', 'trim', 'toLowerCase', 'toUpperCase', 'join'])
const ALLOWED_NODES = new Set(['Program', 'BlockStatement', 'VariableDeclaration', 'VariableDeclarator', 'ExpressionStatement', 'IfStatement', 'ForOfStatement', 'ReturnStatement', 'BreakStatement', 'ContinueStatement', 'EmptyStatement', 'Identifier', 'Literal', 'ArrayExpression', 'ObjectExpression', 'Property', 'MemberExpression', 'CallExpression', 'AwaitExpression', 'UnaryExpression', 'BinaryExpression', 'LogicalExpression', 'ConditionalExpression', 'AssignmentExpression', 'TemplateLiteral', 'TemplateElement'])
const DEFAULTS = Object.freeze({ max_steps: 2000, max_calls: 8, max_value_bytes: 256 * 1024, max_total_bytes: 1024 * 1024, timeout_ms: 60000 })
const CAPS = Object.freeze({ max_steps: 10000, max_calls: 16, max_value_bytes: 512 * 1024, max_total_bytes: 4 * 1024 * 1024, timeout_ms: 120000 })
const GOVERNED_CALLS = new WeakSet()

/** Host-only bridge brand. Never accepted from model JSON or tool context. */
export function markToolProgramCall(call) {
  if (typeof call !== 'function') fail('program_host_required', '组合程序需要受控叶工具调用接口。')
  GOVERNED_CALLS.add(call)
  return call
}
export function isToolProgramCall(call) { return typeof call === 'function' && GOVERNED_CALLS.has(call) }

export class ToolProgramError extends Error {
  constructor(code, message) { super(message); this.name = 'ToolProgramError'; this.code = code }
}
const fail = (code, message) => { throw new ToolProgramError(code, message) }
function property(value) {
  const key = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value
  if (typeof key !== 'string' || BANNED_KEYS.has(key)) fail('program_property', '组合程序不允许原型、构造器、Promise 或可执行转换属性。')
  return key
}
function limitsFor(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !Object.hasOwn(DEFAULTS, key))) fail('program_limits', '组合执行额度配置无效。')
  const limits = { ...DEFAULTS, ...input }
  for (const [key, value] of Object.entries(limits)) if (!Number.isSafeInteger(value) || value < 1 || value > CAPS[key]) fail('program_limits', `组合执行额度无效：${key}`)
  return limits
}

/** Only JSON data is interpreter-visible. No tool metadata, getters, prototypes or thenables. */
function safeValue(value, maxBytes) {
  let bytes = 0, nodes = 0
  function visit(item, depth = 0) {
    if (++nodes > 10000 || depth > 40) fail('program_value_limit', '组合数据结构过深或过大。')
    if (item === undefined || item === null || typeof item === 'boolean') { bytes += 5; return item }
    if (typeof item === 'number') { if (!Number.isFinite(item)) fail('program_number', '组合程序只支持有限数字。'); bytes += 24; return item }
    if (typeof item === 'string') { bytes += Buffer.byteLength(item); if (bytes > maxBytes) fail('program_value_limit', '组合数据超过字节上限。'); return item }
    if (!item || typeof item !== 'object' || ![Object.prototype, Array.prototype, null].includes(Object.getPrototypeOf(item))) fail('program_value', '组合程序只接受 JSON 纯数据。')
    const out = Array.isArray(item) ? [] : Object.create(null)
    for (const key of Object.keys(item)) {
      property(key)
      const descriptor = Object.getOwnPropertyDescriptor(item, key)
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail('program_value', '组合数据不能包含 getter。')
      bytes += Buffer.byteLength(key) + 4
      if (bytes > maxBytes) fail('program_value_limit', '组合数据超过字节上限。')
      out[key] = visit(descriptor.value, depth + 1)
    }
    return out
  }
  const result = visit(value)
  if (bytes > maxBytes) fail('program_value_limit', '组合数据超过字节上限。')
  return result
}

function parseProgram(code) {
  if (typeof code !== 'string' || !code.trim() || Buffer.byteLength(code) > 16384) fail('program_source', '组合程序必须为不超过 16 KiB 的源码。')
  let ast
  try { ast = parse(code, { ecmaVersion: 2022, sourceType: 'script', allowAwaitOutsideFunction: true, allowReturnOutsideFunction: true }) }
  catch { fail('program_syntax', '组合程序语法无效；没有执行任何叶工具。') }
  let count = 0
  function walk(node, depth = 0) {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) { for (const item of node) walk(item, depth); return }
    if (!node.type) return
    if (++count > 4000 || depth > 64 || !ALLOWED_NODES.has(node.type)) fail('program_syntax', `不支持的组合语法：${node.type || 'depth'}；没有执行任何叶工具。`)
    if (node.type === 'Literal' && (node.regex || node.bigint)) fail('program_syntax', '组合程序不支持正则或 BigInt。')
    if (node.type === 'Identifier' && RESERVED.has(node.name) && !['tools', 'JSON', 'Object', 'emit', 'undefined'].includes(node.name)) fail('program_syntax', '组合程序不能访问宿主全局名称。')
    if (node.type === 'VariableDeclaration' && !['const', 'let'].includes(node.kind)) fail('program_syntax', '仅支持 const／let 变量。')
    if (node.type === 'VariableDeclarator' && (node.id.type !== 'Identifier' || RESERVED.has(node.id.name) || BANNED_KEYS.has(node.id.name))) fail('program_syntax', '变量不能解构或覆盖宿主内建名称。')
    if (node.type === 'Property' && (node.kind !== 'init' || node.method || node.computed)) fail('program_syntax', '对象只支持普通固定键，不支持方法、getter 或计算键。')
    if (node.type === 'Property') property(node.key.name ?? node.key.value)
    if (node.type === 'MemberExpression' && !node.computed) property(node.property.name)
    if (node.type === 'CallExpression') {
      const callee = node.callee
      if (callee.type === 'Identifier' ? callee.name !== 'emit' : callee.type !== 'MemberExpression' || callee.computed || !PURE_METHODS.has(callee.property.name)) fail('program_syntax', '不支持的调用形式；没有执行任何叶工具。')
    }
    if (node.type === 'BinaryExpression' && !['+', '-', '*', '/', '%', '<', '>', '<=', '>=', '===', '!=='].includes(node.operator)) fail('program_syntax', '不支持此二目操作。')
    if (node.type === 'UnaryExpression' && !['!', '-', '+', 'typeof'].includes(node.operator)) fail('program_syntax', '不支持此单目操作。')
    if (node.type === 'ForOfStatement' && (node.await || node.left.type !== 'VariableDeclaration' || node.left.declarations.length !== 1)) fail('program_syntax', '仅支持 for (const/let item of 有限数组)。')
    if (node.type === 'AssignmentExpression' && (node.operator !== '=' || node.left.type !== 'Identifier')) fail('program_syntax', '仅可重新赋值 let 变量，不能修改对象属性。')
    if (['BreakStatement', 'ContinueStatement'].includes(node.type) && node.label) fail('program_syntax', '不支持跳转标签。')
    for (const [key, value] of Object.entries(node)) if (!['start', 'end', 'loc'].includes(key)) walk(value, depth + 1)
  }
  walk(ast)
  return ast
}

class Scope {
  constructor(parent = null) { this.parent = parent; this.values = new Map() }
  define(name, value, mutable) { if (this.values.has(name)) fail('program_binding', '变量重复声明。'); this.values.set(name, { value, mutable }) }
  entry(name) { if (this.values.has(name)) return this.values.get(name); if (this.parent) return this.parent.entry(name); fail('program_identifier', `组合程序中没有可用变量：${name}`) }
  get(name) { return this.entry(name).value }
  set(name, value) { const entry = this.entry(name); if (!entry.mutable) fail('program_binding', '不能修改 const 变量。'); entry.value = value; return value }
}

/** Explicit AST interpreter, not a JS sandbox. Never evals or compiles user code.
 * @param {{code: string, call: Function, signal?: AbortSignal, limits?: Record<string,number>}} options */
export async function runToolProgram({ code, call, signal, limits: supplied = {} }) {
  const limits = limitsFor(supplied), ast = parseProgram(code)
  if (typeof call !== 'function') fail('program_host_required', '组合程序需要受控叶工具调用接口。')
  const timeout = AbortSignal.timeout(limits.timeout_ms)
  const abort = signal ? AbortSignal.any([signal, timeout]) : timeout
  const deadline = Date.now() + limits.timeout_ms
  let steps = 0, calls = 0, totalBytes = 0, uncertain = false
  const executed = [], emitted = []
  function tick() {
    if (abort.aborted || Date.now() > deadline) fail('program_cancelled', '组合程序已取消或超时；之前的副作用不会自动回滚。')
    if (++steps > limits.max_steps) fail('program_steps', '组合程序达到总步数上限。')
  }
  function boundedValue(value) {
    const safe = safeValue(value, limits.max_value_bytes)
    // Include intermediate copies, not just emitted/tool data. Otherwise many
    // separately small values can retain an unbounded aggregate in local scope.
    totalBytes += Buffer.byteLength(JSON.stringify(safe) || 'null')
    if (totalBytes > limits.max_total_bytes) fail('program_bytes', '组合程序达到累计字节上限。')
    return safe
  }
  const charge = boundedValue
  function scalar(value) {
    if (value !== null && typeof value === 'object') fail('program_value', '对象转文本请显式使用 JSON.stringify。')
    return String(value)
  }
  async function toolCall(name, args) {
    if (typeof name !== 'string' || !name || name.length > 128 || FORBIDDEN_TOOLS.has(name) || args?.run_in_background === true) fail('program_tool', '组合程序不允许嵌套组合、委派、模式切换、技能加载或后台启动。')
    if (!args || typeof args !== 'object' || Array.isArray(args)) fail('program_args', '工具参数必须为 JSON 对象。')
    if (calls >= limits.max_calls) fail('program_calls', '组合程序达到叶工具调用上限。')
    const safeArgs = charge(args), index = calls++
    let removeAbort = () => {}
    try {
      const work = Promise.resolve().then(() => call({ name, args: safeArgs, index, signal: abort }))
      const raw = await Promise.race([work, new Promise((_, reject) => {
        const stop = () => reject(new ToolProgramError('program_cancelled', '叶工具已收到取消信号；其结果可能仍需核查，不会重放。'))
        abort.addEventListener('abort', stop, { once: true }); removeAbort = () => abort.removeEventListener('abort', stop)
        if (abort.aborted) stop()
      })])
      // Positive output projection: never expose metadata, credentials, objects,
      // callbacks, media bytes, or arbitrary properties of a host tool result.
      const status = typeof raw?.status === 'string' ? raw.status : 'unknown'
      uncertain ||= status === 'unknown' || raw?.outcomeUnknown === true
      executed.push({ name, index, status })
      const projected = charge({ name, status, output: typeof raw?.output === 'string' ? raw.output : '' })
      if (projected.status !== 'completed' || raw?.outcomeUnknown === true) fail('program_leaf_stopped', '叶工具被拒绝、取消、失败或结果未知；后续组合已停止。')
      return projected
    } finally { removeAbort() }
  }
  async function expression(node, scope) {
    tick()
    switch (node.type) {
      case 'Literal': return boundedValue(node.value)
      case 'Identifier': return node.name === 'undefined' ? undefined : scope.get(node.name)
      case 'ArrayExpression': {
        const out = []
        for (const item of node.elements) out.push(item ? await expression(item, scope) : null)
        return boundedValue(out)
      }
      case 'ObjectExpression': {
        const out = Object.create(null)
        for (const item of node.properties) {
          const key = property(item.key.name ?? item.key.value)
          if (Object.hasOwn(out, key)) fail('program_property', '对象包含重复键。')
          out[key] = await expression(item.value, scope)
        }
        return boundedValue(out)
      }
      case 'MemberExpression': {
        const value = await expression(node.object, scope), key = property(node.computed ? await expression(node.property, scope) : node.property.name)
        if (typeof value === 'string' && key === 'length') return value.length
        if (!value || typeof value !== 'object') fail('program_property', '只能读取纯数据的自有属性。')
        return Object.hasOwn(value, key) ? boundedValue(value[key]) : undefined
      }
      case 'AwaitExpression': return expression(node.argument, scope)
      case 'CallExpression': {
        const callee = node.callee
        const args = []
        for (const arg of node.arguments) args.push(await expression(arg, scope))
        if (callee.type === 'Identifier' && callee.name === 'emit') {
          if (args.length !== 1) fail('program_args', 'emit 仅接受一个纯数据参数。')
          emitted.push(charge(args[0])); return null
        }
        if (callee.type !== 'MemberExpression' || callee.computed) fail('program_call', '只允许显式 tools.call 和有限纯数据操作。')
        const method = property(callee.property.name)
        if (callee.object.type === 'Identifier' && callee.object.name === 'tools' && method === 'call') {
          if (args.length !== 2) fail('program_args', 'tools.call 需要工具名和参数对象。')
          return toolCall(args[0], args[1])
        }
        if (callee.object.type === 'Identifier' && callee.object.name === 'JSON') {
          if (args.length !== 1) fail('program_args', 'JSON 操作只接受一个参数。')
          if (method === 'parse' && typeof args[0] === 'string') { try { return boundedValue(JSON.parse(args[0])) } catch (error) { if (error instanceof ToolProgramError) throw error; fail('program_json', '输入不是完整有效 JSON。') } }
          if (method === 'stringify') return boundedValue(JSON.stringify(boundedValue(args[0])))
        }
        if (callee.object.type === 'Identifier' && callee.object.name === 'Object' && ['keys', 'values', 'entries'].includes(method)) {
          if (args.length !== 1 || !args[0] || typeof args[0] !== 'object') fail('program_args', 'Object 操作需要纯数据对象。')
          return boundedValue(Object[method](args[0]))
        }
        const value = await expression(callee.object, scope)
        if (['string', 'object'].includes(typeof value) && (typeof value === 'string' || Array.isArray(value))) {
          const common = ['slice', 'includes']
          const permitted = typeof value === 'string' ? [...common, 'startsWith', 'endsWith', 'split', 'trim', 'toLowerCase', 'toUpperCase'] : [...common, 'join']
          if (permitted.includes(method) && args.length <= 2 && args.every(arg => arg === undefined || ['string', 'number', 'boolean'].includes(typeof arg))) {
            if (Array.isArray(value) && method === 'join') {
              // Account before native allocation: a short array and a large
              // separator must not allocate gigabytes before boundedValue runs.
              const separator = args[0] === undefined ? ',' : String(args[0])
              let bytes = Buffer.byteLength(separator) * Math.max(0, value.length - 1)
              if (bytes > limits.max_value_bytes) fail('program_value_limit', '组合拼接结果超过字节上限。')
              for (const item of value) {
                if (item !== null && typeof item === 'object') fail('program_value', '数组拼接只支持纯标量；对象请显式 JSON.stringify。')
                bytes += Buffer.byteLength(item == null ? '' : String(item))
                if (bytes > limits.max_value_bytes) fail('program_value_limit', '组合拼接结果超过字节上限。')
              }
            }
            return boundedValue(value[method](...args))
          }
        }
        fail('program_call', '不支持该纯数据操作。')
        break
      }
      case 'UnaryExpression': {
        const value = await expression(node.argument, scope)
        if (node.operator === '!') return !value
        if (node.operator === 'typeof') return typeof value
        if (['+', '-'].includes(node.operator) && typeof value === 'number') return boundedValue(node.operator === '-' ? -value : value)
        fail('program_operator', '不支持此单目操作。'); break
      }
      case 'LogicalExpression': {
        const left = await expression(node.left, scope)
        if ((node.operator === '&&' && !left) || (node.operator === '||' && left) || (node.operator === '??' && left != null)) return left
        return expression(node.right, scope)
      }
      case 'BinaryExpression': {
        const left = await expression(node.left, scope), right = await expression(node.right, scope)
        if (node.operator === '===') return left === right
        if (node.operator === '!==') return left !== right
        if (node.operator === '+' && (typeof left === 'string' || typeof right === 'string')) return boundedValue(scalar(left) + scalar(right))
        if (typeof left !== 'number' || typeof right !== 'number') fail('program_operator', '此操作要求有限数字。')
        const operations = { '+': () => left + right, '-': () => left - right, '*': () => left * right, '/': () => left / right, '%': () => left % right,
          '<': () => left < right, '>': () => left > right, '<=': () => left <= right, '>=': () => left >= right }
        if (!Object.hasOwn(operations, node.operator)) fail('program_operator', '不支持此二目操作。')
        return boundedValue(operations[node.operator]())
      }
      case 'ConditionalExpression': return expression(await expression(node.test, scope) ? node.consequent : node.alternate, scope)
      case 'AssignmentExpression': return scope.set(node.left.name, boundedValue(await expression(node.right, scope)))
      case 'TemplateLiteral': {
        let value = node.quasis[0].value.cooked || ''
        for (let i = 0; i < node.expressions.length; i++) value = boundedValue(value + scalar(await expression(node.expressions[i], scope)) + node.quasis[i + 1].value.cooked)
        return boundedValue(value)
      }
      default: fail('program_syntax', '不支持此表达式。')
    }
  }
  async function statement(node, scope) {
    tick()
    if (node.type === 'Program' || node.type === 'BlockStatement') {
      const block = node.type === 'Program' ? scope : new Scope(scope)
      for (const item of node.body) { const flow = await statement(item, block); if (flow) return flow }
    } else if (node.type === 'VariableDeclaration') {
      for (const item of node.declarations) scope.define(item.id.name, item.init ? await expression(item.init, scope) : undefined, node.kind === 'let')
    } else if (node.type === 'ExpressionStatement') await expression(node.expression, scope)
    else if (node.type === 'IfStatement') {
      const chosen = await expression(node.test, scope) ? node.consequent : node.alternate
      return chosen ? statement(chosen, scope) : null
    } else if (node.type === 'ForOfStatement') {
      const items = await expression(node.right, scope)
      if (!Array.isArray(items) || items.length > 128) fail('program_loop', 'for...of 只接受最多 128 项的有限数组。')
      for (const value of items) {
        const iteration = new Scope(scope)
        iteration.define(node.left.declarations[0].id.name, value, node.left.kind === 'let')
        const flow = await statement(node.body, iteration)
        if (flow?.type === 'break') break
        if (flow && flow.type !== 'continue') return flow
      }
    } else if (node.type === 'ReturnStatement') return { type: 'return', value: node.argument ? await expression(node.argument, scope) : null }
    else if (node.type === 'BreakStatement') return { type: 'break' }
    else if (node.type === 'ContinueStatement') return { type: 'continue' }
    else if (node.type !== 'EmptyStatement') fail('program_syntax', '不支持此语句。')
    return null
  }
  try {
    const result = await statement(ast, new Scope())
    return { status: 'completed', value: charge(result?.type === 'return' ? result.value : emitted), calls: executed, atomic: false, steps, bytes: totalBytes }
  } catch (error) {
    return { status: abort.aborted ? 'cancelled' : 'error', error: error instanceof ToolProgramError ? error.message : '组合执行未完成，后续叶工具已停止。',
      code: error instanceof ToolProgramError ? error.code : 'program_failed', calls: executed, atomic: false, steps, bytes: totalBytes,
      outcomeUnknown: uncertain || calls > executed.length }
  }
}

export function createToolProgram() {
  return {
    name: 'tool_program', description: 'Experimental bounded data/tool composition using a small interpreted syntax. Every tools.call uses normal schemas, permissions, approvals and durable action handling. Stops on denial/failure/unknown/cancellation. Not JavaScript execution, not atomic, no rollback or replay.',
    inputSchema: { type: 'object', properties: { code: { type: 'string', minLength: 1, maxLength: 16384 } }, required: ['code'], additionalProperties: false },
    capabilityFor: () => 'read',
    async execute(args, ctx) {
      if (ctx.config?.tool?.program?.enabled !== true) fail('program_disabled', '受限代码组合仍为实验功能，需由用户显式启用 tool.program.enabled。')
      if (!isToolProgramCall(ctx.runToolProgramCall)) fail('program_host_required', '当前运行时没有受控叶工具桥接。')
      const result = await runToolProgram({ code: args.code, call: ctx.runToolProgramCall, signal: ctx.signal, limits: ctx.config.tool.program.limits || {} })
      return { output: JSON.stringify(result), status: result.status, metadata: { outcomeUnknown: result.outcomeUnknown === true } }
    }
  }
}
