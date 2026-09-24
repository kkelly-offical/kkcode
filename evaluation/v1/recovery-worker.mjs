import { runRecoveryCrashWorker } from './recovery-drivers.mjs'
process.on('disconnect', () => process.exit(0))
process.once('message', input => runRecoveryCrashWorker(input).then(() => process.disconnect()).catch(error => { process.stderr.write(String(error.code || error.message)); process.exitCode = 1; process.disconnect() }))
