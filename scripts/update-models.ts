// Refresh the vendored AWS model and record its upstream provenance.
import { writeFileSync } from 'node:fs'

const REPO = 'aws/api-models-aws'
const PATH = 'models/socialmessaging/service/2024-01-01/socialmessaging-2024-01-01.json'

const commitsRes = await fetch(`https://api.github.com/repos/${REPO}/commits?path=${encodeURIComponent(PATH)}&per_page=1`, {
  headers: { 'user-agent': 'eum-social-local-emulator' },
})
const commits = await commitsRes.json()
if (!Array.isArray(commits) || !commits[0]) {
  throw new Error(`could not read the latest commit for ${PATH}: ${JSON.stringify(commits).slice(0, 200)}`)
}
const sha: string = commits[0].sha
const res = await fetch(`https://raw.githubusercontent.com/${REPO}/${sha}/${PATH}`)
if (!res.ok) throw new Error(`model download failed: HTTP ${res.status}`)
const text = await res.text()
JSON.parse(text)
writeFileSync(new URL('../models/socialmessaging-2024-01-01.json', import.meta.url), text)
writeFileSync(
  new URL('../models/SOURCE', import.meta.url),
  `repo: https://github.com/${REPO}\npath: ${PATH}\ncommit: ${sha.slice(0, 7)}\ncommitted: ${commits[0].commit.committer.date}\nfetched: ${new Date().toISOString().slice(0, 10)}\n`,
)
console.log(`models updated to ${REPO}@${sha.slice(0, 7)}`)
