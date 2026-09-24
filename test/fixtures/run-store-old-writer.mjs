import { DatabaseSync } from 'node:sqlite'

const db = new DatabaseSync(process.argv[2])
const update = db.prepare("UPDATE runs SET state='completed',revision=revision+1 WHERE id='legacy'")
process.on('disconnect', () => { db.close(); process.exit(0) })
process.on('message', () => {
  try {
    db.exec('BEGIN IMMEDIATE')
    db.prepare("INSERT INTO events(run_id,revision,type,data_json,created_at) VALUES('legacy',2,'old.writer','{}',2)").run()
    update.run()
    db.exec('COMMIT')
    process.send({ wrote: true })
  } catch (error) {
    try { db.exec('ROLLBACK') } catch {}
    process.send({ wrote: false, message: error.message })
  }
})
process.send({ ready: true })
