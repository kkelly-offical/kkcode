import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createInterface } from 'node:readline/promises'

const execute = promisify(execFile)
export function parseWindowsFolderRoots(value) {
  const data = JSON.parse(value), drives = Array.isArray(data) ? data : [data]
  if (!drives.length || drives.some(drive => typeof drive !== 'string' || !/^[A-Za-z]:$/.test(drive))) throw new Error('无法确认本机磁盘列表，请使用 --root 明确授权目录。')
  return [...new Set(drives.map(drive => `${drive.toUpperCase()}\\`))]
}
export async function allDeviceFolderRoots({ platform = process.platform, home = os.homedir(), executeImpl = execute } = {}) {
  if (platform !== 'win32') return [...new Set([home, '/'])]
  // Do not probe arbitrary UNC/network shares while discovering local drives.
  const { stdout } = await executeImpl('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_LogicalDisk | Where-Object { $_.DriveType -ne 4 } | Select-Object -ExpandProperty DeviceID | ConvertTo-Json -Compress'], { timeout: 10000, windowsHide: true, maxBuffer: 32768 })
  return [...new Set([home, ...parseWindowsFolderRoots(stdout)])]
}
export async function chooseRemoteFolderAccess(options, {
  home = os.homedir(), cwd = process.cwd(), interactive = Boolean(process.stdin.isTTY && process.stderr.isTTY),
  ask, print = message => console.error(message), rootsForAll = () => allDeviceFolderRoots({ home })
} = {}) {
  const modes = [Boolean(options.root), Boolean(options.allFolders), Boolean(options.homeOnly)].filter(Boolean).length
  if (modes > 1) throw new Error('--root、--all-folders 和 --home-only 不能同时使用。')
  if (options.root) return { mode: 'custom', roots: [path.resolve(cwd, options.root)] }
  if (options.allFolders) return { mode: 'all', roots: await rootsForAll() }
  if (options.homeOnly) return { mode: 'home', roots: [home] }
  if (!interactive) throw new Error('远程访问范围尚未授权。请在交互终端启动并确认，或明确使用 --home-only、--root <目录>、--all-folders。--trust 只代表工作区执行信任。')
  print('远程文件夹授权：登录账号及获准的远端 Agent 可以访问哪些目录？')
  print('选择“是”允许当前系统用户可访问的所有普通目录；SSH 密钥、模型凭据和 KK Code 私密状态仍受保护。')
  print(`选择“否”仅开放用户主目录：${home}。操作系统权限不会被提升；工具执行仍遵循审批规则。`)
  const readline = ask ? null : createInterface({ input: process.stdin, output: process.stderr })
  try {
    const answer = (await (ask || (question => readline.question(question)))('是否信任远端 Agent 访问所有普通目录？[y/N] ')).trim().toLowerCase()
    if (['y', 'yes', '是', '允许'].includes(answer)) return { mode: 'all', roots: await rootsForAll() }
    if (['', 'n', 'no', '否', '不允许'].includes(answer)) return { mode: 'home', roots: [home] }
    throw new Error('没有得到明确授权，远程服务未启动。请重新选择 y 或 n。')
  } finally { readline?.close() }
}
