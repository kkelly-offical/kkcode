import { randomBytes, X509Certificate } from 'node:crypto'
import { access, mkdir, writeFile, readFile, chmod, chown } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repository = fileURLToPath(new URL('../', import.meta.url))
const directory = path.resolve(process.env.KKCODE_LAB_STATE || path.join(os.homedir(), '.local/share/kkcode-enterprise-lab'))
const address = process.env.KKCODE_LAB_IP || '10.0.0.2'
const ssoPort = Number(process.env.KKCODE_LAB_SSO_PORT || 18471), gatewayPort = Number(process.env.KKCODE_LAB_GATEWAY_PORT || 18472)
if (!Object.values(os.networkInterfaces()).flat().some(entry => entry?.address === address)) throw new Error('Lab address must belong to this computer')
if (![ssoPort, gatewayPort].every(port => Number.isInteger(port) && port > 1024 && port < 65536) || ssoPort === gatewayPort) throw new Error('Choose two different non-privileged ports')
await mkdir(directory, { recursive: true, mode: 0o700 })
await chmod(directory, 0o700)
const secretsPath = path.join(directory, 'credentials.json')
let credentials
try { credentials = JSON.parse(await readFile(secretsPath, 'utf8')) } catch (error) {
  if (error.code !== 'ENOENT') throw error
  credentials = { address, ssoPort, gatewayPort, gatewayPassword: randomBytes(32).toString('hex'), ssoPassword: randomBytes(32).toString('hex'), adminPassword: randomBytes(32).toString('base64url'), clientSecret: randomBytes(32).toString('base64url'), accounts: Object.fromEntries(['owner', 'viewer', 'administrator'].map(name => [name, { username: `kkcode-${name}`, password: randomBytes(24).toString('base64url') }])) }
  await writeFile(secretsPath, JSON.stringify(credentials, null, 2), { mode: 0o600, flag: 'wx' })
}
if (credentials.address !== address || credentials.ssoPort !== ssoPort || credentials.gatewayPort !== gatewayPort) throw new Error('Existing lab uses different addresses. Use a different KKCODE_LAB_STATE instead of overwriting it.')
const gateway = `https://${address}:${gatewayPort}`, sso = `https://${address}:${ssoPort}`
const generate = args => {
  const result = spawnSync('openssl', args, { cwd: directory, encoding: 'utf8' })
  if (result.status !== 0) throw new Error('Lab certificate generation failed')
}
try { await access(path.join(directory, 'tls.crt')) } catch {
  generate(['req', '-x509', '-newkey', 'rsa:3072', '-nodes', '-keyout', 'ca.key', '-out', 'ca.crt', '-days', '365', '-subj', '/CN=KK Code Enterprise Lab CA', '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign'])
  generate(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'tls.key', '-out', 'tls.csr', '-subj', '/CN=KK Code Enterprise Lab'])
  await writeFile(path.join(directory, 'certificate.ext'), `subjectAltName=IP:${address},IP:127.0.0.1,DNS:localhost\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n`, { mode: 0o600 })
  generate(['x509', '-req', '-in', 'tls.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'tls.crt', '-days', '90', '-extfile', 'certificate.ext'])
  for (const file of ['ca.key', 'tls.key']) await chmod(path.join(directory, file), 0o600)
}
// Public certificates must be readable by the unprivileged gateway container;
// the containing host directory stays 0700 and private keys remain 0600.
for (const file of ['ca.crt', 'tls.crt']) await chmod(path.join(directory, file), 0o644)
const realm = {
  realm: 'kkcode', enabled: true, displayName: 'KK Code Enterprise Lab', sslRequired: 'all', registrationAllowed: false,
  roles: { realm: [{ name: 'kkcode-admin' }] },
  clients: [{ clientId: 'kkcode-gateway', name: 'KK Code Gateway', enabled: true, protocol: 'openid-connect', publicClient: false, secret: credentials.clientSecret, standardFlowEnabled: true, directAccessGrantsEnabled: false, redirectUris: [`${gateway}/auth/callback`], webOrigins: [gateway], attributes: { 'pkce.code.challenge.method': 'S256' }, protocolMappers: [{ name: 'organization-roles', protocol: 'openid-connect', protocolMapper: 'oidc-usermodel-realm-role-mapper', config: { 'claim.name': 'realm_access.roles', 'jsonType.label': 'String', multivalued: 'true', 'id.token.claim': 'true', 'access.token.claim': 'true', 'usermodel.realmRoleMapping.rolePrefix': '' } }] }],
  users: Object.entries(credentials.accounts).map(([name, account]) => ({ username: account.username, enabled: true, email: `${name}@kkcode.test`, emailVerified: true, firstName: 'KK Code', lastName: name, realmRoles: name === 'administrator' ? ['kkcode-admin'] : [], credentials: [{ type: 'password', value: account.password, temporary: false }], requiredActions: [] }))
}
await writeFile(path.join(directory, 'realm.json'), JSON.stringify(realm, null, 2), { mode: 0o600 })
if (process.getuid?.() === 0) await chown(path.join(directory, 'realm.json'), 1000, 1000)
await writeFile(path.join(directory, 'Caddyfile'), `{
  admin off
  auto_https off
}
https://:${ssoPort} {
  tls /tls/cert.pem /tls/key.pem
  @local host localhost 127.0.0.1
  redir @local ${sso}{uri} 307
  reverse_proxy sso:8080
}
https://:${gatewayPort} {
  tls /tls/cert.pem /tls/key.pem
  @local host localhost 127.0.0.1
  redir @local ${gateway}{uri} 307
  reverse_proxy gateway:18272
}
`, { mode: 0o600 })
await writeFile(path.join(directory, 'lab.env'), Object.entries({ KKCODE_LAB_STATE: directory, KKCODE_LAB_IP: address, SSO_PORT: ssoPort, GATEWAY_PORT: gatewayPort, GATEWAY_DB_PASSWORD: credentials.gatewayPassword, SSO_DB_PASSWORD: credentials.ssoPassword, SSO_ADMIN_PASSWORD: credentials.adminPassword, OIDC_CLIENT_SECRET: credentials.clientSecret }).map(([key, value]) => `${key}=${value}`).join('\n') + '\n', { mode: 0o600 })
await writeFile(path.join(directory, 'public.json'), JSON.stringify({ gateway, sso, issuer: `${sso}/realms/kkcode`, ca: path.join(directory, 'ca.crt'), compose: path.join(repository, 'deploy/lab/compose.yaml'), envFile: path.join(directory, 'lab.env') }, null, 2), { mode: 0o600 })
const certificate = new X509Certificate(await readFile(path.join(directory, 'ca.crt')))
console.log(JSON.stringify({ gateway, sso, stateDirectory: directory, caFingerprint: certificate.fingerprint256, message: 'Lab prepared. Credentials are private files, not printed. Databases have no published ports.' }, null, 2))
