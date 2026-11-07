// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { McpClient } from '../lib/runtime/mcp-client';

const fixture = `const readline=require('node:readline');readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;let result=m.method==='initialize'?{protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}:m.method==='tools/list'?{tools:[{name:'echo',inputSchema:{type:'object'}}]}:{content:[{type:'text',text:m.params.arguments.text}]};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');});`;

describe('MCP transport', () => {
  it('handshakes, lists and invokes real stdio tools', async () => {
    const client = new McpClient({ trusted: true, transport: 'stdio', command: process.execPath, args: ['-e', fixture], timeoutMs: 3000 });
    try {
      expect((await client.connect()).tools[0].name).toBe('echo');
      expect(await client.callTool('echo', { text: 'working tool' })).toEqual({ content: [{ type: 'text', text: 'working tool' }] });
    } finally { await client.close(); }
    await expect(client.callTool('echo')).rejects.toThrow('Connect');
  });
  it('times out nonresponsive tools', async () => {
    const client = new McpClient({ trusted: true, transport: 'stdio', command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], timeoutMs: 150 });
    await expect(client.connect()).rejects.toThrow('timed out');
  });
  it('rejects unapproved and filesystem connection configurations', () => {
    expect(() => new McpClient({ trusted: false, transport: 'http', url: 'https://example.com' } as any)).toThrow('explicitly approved');
    expect(() => new McpClient({ trusted: true, transport: 'http', url: 'file:///secret' })).toThrow('HTTP');
  });
  it('uses HTTP session headers and parses streamed tool replies', async () => {
    let sessionSeen = false;
    let closed = false;
    const server = createServer(async (request, response) => {
      if (request.method === 'DELETE') { closed = true; response.writeHead(204).end(); return; }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk);
      const message = JSON.parse(Buffer.concat(chunks).toString());
      sessionSeen ||= request.headers['mcp-session-id'] === 'fixture-session';
      if (!message.id) { response.writeHead(202).end(); return; }
      response.setHeader('mcp-session-id', 'fixture-session');
      const result = message.method === 'initialize' ? { capabilities: {} } : message.method === 'tools/list' ? { tools: [{ name: 'echo' }] } : { content: [{ type: 'text', text: 'http reply' }] };
      response.setHeader('content-type', message.method === 'tools/call' ? 'text/event-stream' : 'application/json');
      const body = JSON.stringify({ jsonrpc: '2.0', id: message.id, result });
      response.end(message.method === 'tools/call' ? `data: ${body}\n\n` : body);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const client = new McpClient({ trusted: true, transport: 'http', url: `http://127.0.0.1:${(server.address() as any).port}`, timeoutMs: 3000 });
    try {
      expect((await client.connect()).tools[0].name).toBe('echo');
      expect((await client.callTool('echo')).content[0].text).toBe('http reply');
      expect(sessionSeen).toBe(true);
      await client.close();
      expect(closed).toBe(true);
    } finally { await client.close(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  });
});
