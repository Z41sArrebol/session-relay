import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { createZcodeFixture } from '../fixtures/zcode'

const target = process.argv[2]
if (!target) throw new Error('missing output path')
const fixture = createZcodeFixture({ recovery: true })
writeFileSync(
  target,
  JSON.stringify({
    root: fixture.root,
    dbPath: fixture.dbPath,
    projectRoot: fixture.projectRoot,
    userData: path.join(fixture.root, 'userdata'),
    sessionA: fixture.sessionA,
    sessionB: fixture.sessionB
  }),
  'utf8'
)
console.log('fixture ready', fixture.root)
