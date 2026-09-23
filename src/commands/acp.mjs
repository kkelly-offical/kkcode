import { Command } from 'commander'

export function createAcpCommand() {
  return new Command('acp').description('Run the stable Agent Client Protocol adapter over stdio')
    .option('--trust', 'Explicitly trust the editor workspace and its project extensions')
    .action(async options => { const { runAcp } = await import('../acp/server.mjs'); return runAcp({ trust: options.trust === true }) })
}
