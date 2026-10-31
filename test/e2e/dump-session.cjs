const fs = require('fs')
const zlib = require('zlib')

const file = process.argv[2]
const raw = fs.readFileSync(file)
const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const starts = []
let index = raw.indexOf(magic, 0)
while (index >= 0) {
  starts.push(index)
  index = raw.indexOf(magic, index + 1)
}
const parts = []
for (let i = 0; i < starts.length; i += 1) {
  const end = i + 1 < starts.length ? starts[i + 1] : raw.length
  try {
    parts.push(zlib.zstdDecompressSync(raw.subarray(starts[i], end)))
  } catch (error) {
    console.error('frame', i, 'failed', error.message)
  }
}
const text = Buffer.concat(parts).toString('utf8')
const lines = text.split(/\r?\n/).filter(Boolean)
let events = []
try {
  events = lines.map((line) => JSON.parse(line))
} catch (error) {
  console.error('parse error', error.message)
  process.exit(1)
}
for (const event of events) {
  if (!['turn/start', 'turn/end', 'user/message', 'assistant/message'].includes(event.type)) continue
  const data = event.data ?? {}
  let detail = ''
  if (event.type === 'user/message') {
    const blocks = (data.content ?? []).filter((block) => block.type === 'text').map((block) => block.text)
    detail = `source=${JSON.stringify(data.source)} text=${JSON.stringify(blocks.join(' '))}`
  } else if (event.type === 'turn/end') {
    detail = `reason=${data.reason?.kind} code=${data.reason?.error?.code ?? ''}`
  } else if (event.type === 'turn/start') {
    detail = `turn=${data.turn}`
  }
  console.log(event.type, detail)
}
console.log('events', events.length, 'frames', starts.length)
