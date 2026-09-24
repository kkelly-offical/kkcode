/** Experimental Node-only persistence primitives. The embedding host owns
 * authentication, actor scopes, consent and verification evidence. Never expose
 * these methods directly as model tools or forward untrusted RPC payloads. */
export {
  openRunStore, RUN_STATES, ACTION_STATES, RUN_STORE_SCHEMA_VERSION,
  createArtifactStore, ArtifactStore, ArtifactStoreError, ARTIFACT_LIMITS
} from '../kernel/index.mjs'
export { inspectLegacySessions, importLegacySessions, resolveMigrationBackupDirectory } from '../storage/run-session-migration.mjs'
