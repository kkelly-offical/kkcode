import { createGateway } from '../../src/remote/gateway.mjs'
const app = await createGateway({
  origin: process.env.KKCODE_GATEWAY_ORIGIN,
  issuer: process.env.KKCODE_OIDC_ISSUER,
  clientId: process.env.KKCODE_OIDC_CLIENT_ID,
  clientSecret: process.env.KKCODE_OIDC_CLIENT_SECRET,
  rolesClaim: process.env.KKCODE_OIDC_ROLES_CLAIM,
  adminRole: process.env.KKCODE_OIDC_ADMIN_ROLE,
  scopes: process.env.KKCODE_OIDC_SCOPES,
  auditRetentionDays: Number(process.env.KKCODE_AUDIT_RETENTION_DAYS || 90),
  auditMaxRecords: Number(process.env.KKCODE_AUDIT_MAX_RECORDS || 100000),
  trustProxy: process.env.KKCODE_TRUST_PROXY ? process.env.KKCODE_TRUST_PROXY.split(',').map(value => value.trim()).filter(Boolean) : false,
  organization: process.env.KKCODE_ORGANIZATION || 'Personal',
  databaseUrl: process.env.DATABASE_URL,
  ...(process.env.KKCODE_CLUSTER_ADDRESS ? { cluster: {
    address: process.env.KKCODE_CLUSTER_ADDRESS,
    host: process.env.KKCODE_CLUSTER_HOST || '0.0.0.0',
    port: Number(process.env.KKCODE_CLUSTER_PORT || 18274),
    secret: process.env.KKCODE_CLUSTER_SECRET,
    ...(process.env.KKCODE_CLUSTER_NODE_ID ? { nodeId: process.env.KKCODE_CLUSTER_NODE_ID } : {})
  } } : {}),
  dev: process.env.KKCODE_GATEWAY_DEV === '1'
})
await app.listen({ host: '0.0.0.0', port: Number(process.env.PORT || 18272) })
console.log('KK Code gateway listening')
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void app.close().then(() => process.exit(0)) })
