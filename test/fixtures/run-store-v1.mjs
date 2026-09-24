export const schemaV1 = `
PRAGMA journal_mode=WAL;
PRAGMA application_id=1263227477;
PRAGMA user_version=1;
CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,applied_at INTEGER NOT NULL);
INSERT INTO schema_migrations VALUES(1,1);
CREATE TABLE runs(id TEXT PRIMARY KEY,state TEXT NOT NULL,revision INTEGER NOT NULL,owner_id TEXT NOT NULL,owner_epoch INTEGER NOT NULL,contract_version INTEGER NOT NULL,contract_json TEXT NOT NULL,candidate_hash TEXT,candidate_generation INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
CREATE TABLE contracts(run_id TEXT NOT NULL REFERENCES runs(id),version INTEGER NOT NULL,contract_json TEXT NOT NULL,approval_json TEXT,created_at INTEGER NOT NULL,PRIMARY KEY(run_id,version));
CREATE TABLE actions(run_id TEXT NOT NULL REFERENCES runs(id),id TEXT NOT NULL,spec_json TEXT NOT NULL,state TEXT NOT NULL,owner_epoch INTEGER NOT NULL,receipt_json TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(run_id,id));
CREATE TABLE verifications(sequence INTEGER PRIMARY KEY AUTOINCREMENT,run_id TEXT NOT NULL REFERENCES runs(id),id TEXT NOT NULL,criterion_id TEXT NOT NULL,candidate_hash TEXT NOT NULL,candidate_generation INTEGER NOT NULL,contract_version INTEGER NOT NULL,status TEXT NOT NULL,evidence_json TEXT NOT NULL,created_at INTEGER NOT NULL,UNIQUE(run_id,id));
CREATE TABLE events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,run_id TEXT NOT NULL REFERENCES runs(id),revision INTEGER NOT NULL,type TEXT NOT NULL,data_json TEXT NOT NULL,created_at INTEGER NOT NULL,UNIQUE(run_id,revision));
`
