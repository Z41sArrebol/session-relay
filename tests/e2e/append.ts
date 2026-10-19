import Database from 'better-sqlite3'

const [dbPath, sessionId, text] = process.argv.slice(2)
if (!dbPath || !sessionId || !text) throw new Error('usage: append <db> <sessionId> <text>')
const db = new Database(dbPath)
const now = Date.now()
const id = `msg_live_${now}`
const seq = (db.prepare('SELECT COALESCE(MAX(sequence), 0) + 1 n FROM message WHERE session_id = ?').get(sessionId) as {
  n: number
}).n
db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data, sequence) VALUES (?, ?, ?, ?, ?, ?)').run(
  id,
  sessionId,
  now,
  now,
  JSON.stringify({
    role: 'user',
    time: { created: now },
    semantics: { origin: 'real_user', kind: 'user_prompt', uiVisibility: 'visible' },
    metadata: { inputIntent: { kind: 'sendText' } }
  }),
  seq
)
db.prepare(
  'INSERT INTO part (id, message_id, session_id, time_created, time_updated, data, sequence) VALUES (?, ?, ?, ?, ?, ?, 0)'
).run(
  `${id}_part`,
  id,
  sessionId,
  now,
  now,
  JSON.stringify({ type: 'text', text, time: { start: now, end: now } })
)
db.close()
console.log(JSON.stringify({ id, text, sequence: seq }))
