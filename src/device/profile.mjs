import YAML from 'yaml'
import { defaultProfile, loadProfile } from '../onboarding.mjs'
import { profilePath } from '../storage/paths.mjs'
import { writePrivateFile } from '../storage/private-file.mjs'
import { ProtocolError } from '../protocol/index.mjs'

export async function getDeviceProfile() { return (await loadProfile()) || defaultProfile() }

export async function updateDeviceProfile(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new ProtocolError('invalid_profile', 'Profile must be an object')
  const allowed = new Set(['beginner', 'languages', 'tech_stack', 'design_style', 'extra_notes'])
  for (const [key, value] of Object.entries(patch)) {
    if (!allowed.has(key)) throw new ProtocolError('invalid_profile', `Unknown profile field: ${key}`)
    if (key === 'beginner') {
      if (typeof value !== 'boolean') throw new ProtocolError('invalid_profile', 'beginner must be a boolean')
    } else if (key === 'languages' || key === 'tech_stack') {
      if (!Array.isArray(value) || value.length > 50 || value.some(v => typeof v !== 'string' || !v.trim() || v.length > 100)) throw new ProtocolError('invalid_profile', `${key} must contain up to 50 short text values`)
    } else if (typeof value !== 'string' || value.length > (key === 'extra_notes' ? 10000 : 500)) throw new ProtocolError('invalid_profile', `${key} is too long or is not text`)
  }
  const profile = { ...await getDeviceProfile(), ...patch }
  await writePrivateFile(profilePath(), YAML.stringify(profile))
  return profile
}
