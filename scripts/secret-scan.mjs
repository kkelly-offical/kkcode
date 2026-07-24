import { readFileSync } from "node:fs"
import { execFileSync } from "node:child_process"

const patterns = [
  ["Kimi API key", /sk-kimi-[A-Za-z0-9]{20,}/g],
  ["AWS access key", /AKIA[0-9A-Z]{16}/g],
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g]
]

const files = execFileSync("git", ["ls-files", "-co", "--exclude-standard"], {
  cwd: process.cwd(),
  encoding: "utf8"
}).split(/\r?\n/).filter(Boolean)

const findings = []
for (const file of files) {
  if (file === "package-lock.json") continue
  let source
  try {
    source = readFileSync(file, "utf8")
  } catch {
    continue
  }
  for (const [label, pattern] of patterns) {
    pattern.lastIndex = 0
    for (const match of source.matchAll(pattern)) {
      const line = source.slice(0, match.index).split("\n").length
      findings.push(`${file}:${line}: possible ${label}`)
    }
  }
}

if (findings.length) {
  console.error(findings.join("\n"))
  process.exitCode = 1
} else {
  console.log(`secret scan ok: ${files.length} files`)
}
