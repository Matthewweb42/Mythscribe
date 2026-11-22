// A stand-in for the Anthropic Messages API, for the smoke test only: when tools are offered it
// streams one tool_use round, then a short text answer. GET /__log lists the requests it saw.
import http from 'node:http'
const port = Number(process.argv[2] || 8798)
const log = []
http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    if (req.url === '/__log') { res.end(JSON.stringify(log)); return }
    const j = JSON.parse(body || '{}')
    log.push({ url: req.url, headers: { beta: req.headers['anthropic-beta'] || null }, body: j })
    const hasToolResult = j.messages.some((m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result'))
    const wantTool = (j.tools || []).length && !hasToolResult
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const ev = (t, d) => res.write(`event: ${t}\ndata: ${JSON.stringify({ type: t, ...d })}\n\n`)
    ev('message_start', { message: { id: 'msg_1', type: 'message', role: 'assistant', model: j.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1200, output_tokens: 1, cache_read_input_tokens: 800, cache_creation_input_tokens: 400 } } })
    if (wantTool) {
      const t = j.tools[0]
      ev('content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: t.name, input: {} } })
      ev('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: '{"q":"Kael"}' } })
      ev('content_block_stop', { index: 0 })
      ev('message_delta', { delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 20 } })
    } else {
      ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
      for (const piece of ['Kael is ', 'the heir ', 'of Ashkeep.']) ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: piece } })
      ev('content_block_stop', { index: 0 })
      ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 12 } })
    }
    ev('message_stop', {})
    res.end()
  })
}).listen(port, () => console.log('mock on', port))
