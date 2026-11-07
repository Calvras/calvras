import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';

export type McpConnectionConfig = { trusted: true; timeoutMs?: number } & (
  { transport: 'stdio'; command: string; args?: string[]; cwd?: string; env?: Record<string, string> }
  | { transport: 'http'; url: string; headers?: Record<string, string> }
);
type RpcMessage = { jsonrpc: '2.0'; id?: string | number; method?: string; params?: unknown; result?: unknown; error?: { code: number; message: string } };

/** A connection is created only from user-approved configuration, never repository discovery. */
export class McpClient {
  private child: ChildProcessWithoutNullStreams | undefined;
  private pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private sessionId: string | undefined;
  private initialized = false;
  private buffer = '';
  private decoder = new StringDecoder('utf8');
  private stderr = '';
  private closed = false;
  private timeout: number;
  constructor(private config: McpConnectionConfig) {
    if (config.trusted !== true) throw new Error('MCP connections require an explicitly approved configuration.');
    this.timeout = Math.max(100, Math.min(120000, config.timeoutMs ?? 30000));
    if (config.transport === 'http') {
      const url = new URL(config.url);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('MCP HTTP connections require HTTP(S) without embedded credentials.');
    }
  }
  async connect(): Promise<{ tools: any[] }> {
    if (this.closed) throw new Error('MCP connection is closed.');
    if (this.initialized) return this.listTools();
    if (this.config.transport === 'stdio') {
      if (!this.config.command.trim()) throw new Error('MCP server command is required.');
      this.child = spawn(this.config.command, this.config.args ?? [], { cwd: this.config.cwd, env: { PATH: process.env['PATH'], SystemRoot: process.env['SystemRoot'], TEMP: process.env['TEMP'], ...this.config.env }, shell: false, windowsHide: true });
      this.child.stdout.on('data', (chunk: Buffer) => this.receive(this.decoder.write(chunk)));
      this.child.stderr.on('data', (chunk: Buffer) => { this.stderr = (this.stderr + chunk.toString('utf8')).slice(-4000); });
      this.child.on('error', (error) => this.failAll(error));
      this.child.on('exit', (code) => { this.closed = true; this.failAll(new Error(`MCP server exited (${code}). ${this.stderr}`)); });
    }
    try {
      await this.request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'calvras', version: '1.0.0' } });
      await this.notify('notifications/initialized', {});
      this.initialized = true;
      return await this.listTools();
    } catch (error) { await this.close(); throw error; }
  }
  async listTools(): Promise<{ tools: any[] }> {
    const tools: any[] = [];
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      const result = await this.request('tools/list', cursor ? { cursor } : {});
      if (!Array.isArray(result?.tools)) throw new Error('MCP tools/list returned an invalid tool list.');
      tools.push(...result.tools);
      cursor = result.nextCursor;
      if (cursor) {
        if (seen.has(cursor) || seen.size >= 100) throw new Error('MCP tool pagination did not terminate.');
        seen.add(cursor);
      }
    } while (cursor);
    return { tools };
  }
  async callTool(name: string, args: Record<string, unknown> = {}): Promise<any> {
    if (!this.initialized) throw new Error('Connect to the MCP server before calling tools.');
    return this.request('tools/call', { name, arguments: args });
  }
  private receive(chunk: string) {
    this.buffer += chunk;
    if (this.buffer.length > 8 * 1024 * 1024) { this.failAll(new Error('MCP response exceeds 8 MB.')); void this.close(); return; }
    let newline: number;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      try { this.deliver(JSON.parse(line)); } catch { this.failAll(new Error('MCP server emitted invalid JSON.')); }
    }
  }
  private deliver(message: RpcMessage) {
    if (message.method && message.id !== undefined) {
      // No server-initiated filesystem access, sampling or authorization bypass.
      this.child?.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Client requests are not supported.' } }) + '\n');
      return;
    }
    const pending = this.pending.get(String(message.id));
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(String(message.id));
    if (message.error) pending.reject(new Error(`MCP error ${message.error.code}: ${message.error.message}`));
    else pending.resolve(message.result);
  }
  private failAll(error: Error) {
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); }
    this.pending.clear();
  }
  private request(method: string, params: unknown): Promise<any> {
    if (this.closed) return Promise.reject(new Error('MCP connection is closed.'));
    const message: RpcMessage = { jsonrpc: '2.0', id: randomUUID(), method, params };
    if (this.config.transport === 'http') return this.http(message);
    if (!this.child) return Promise.reject(new Error('MCP stdio server is not connected.'));
    return new Promise((resolve, reject) => {
      const id = String(message.id);
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`MCP ${method} timed out after ${this.timeout} ms.`)); }, this.timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.child!.stdin.write(JSON.stringify(message) + '\n', (error) => { if (error) { clearTimeout(timer); this.pending.delete(id); reject(error); } });
    });
  }
  private async notify(method: string, params: unknown) {
    const message: RpcMessage = { jsonrpc: '2.0', method, params };
    if (this.config.transport === 'http') await this.http(message);
    else this.child?.stdin.write(JSON.stringify(message) + '\n');
  }
  private async http(message: RpcMessage): Promise<any> {
    if (this.config.transport !== 'http') throw new Error('Invalid MCP transport.');
    const response = await fetch(this.config.url, { method: 'POST', redirect: 'error', headers: { ...this.config.headers, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-03-26', ...(this.sessionId ? { 'Mcp-Session-Id': this.sessionId } : {}) }, body: JSON.stringify(message), signal: AbortSignal.timeout(this.timeout) });
    if (!response.ok) throw new Error(`MCP HTTP request failed (${response.status}).`);
    this.sessionId = response.headers.get('mcp-session-id') ?? this.sessionId;
    if (message.id === undefined || response.status === 202 || response.status === 204) { await response.body?.cancel(); return; }
    let reply: RpcMessage | undefined;
    if (response.headers.get('content-type')?.includes('text/event-stream')) {
      const reader = response.body?.getReader();
      if (!reader) throw new Error('Empty MCP event stream.');
      const decoder = new TextDecoder();
      let text = '';
      try {
        while (!reply) {
          const result = await reader.read();
          if (result.done) break;
          text += decoder.decode(result.value, { stream: true }).replace(/\r\n/g, '\n');
          if (text.length > 8 * 1024 * 1024) throw new Error('MCP response exceeds 8 MB.');
          let end: number;
          while ((end = text.indexOf('\n\n')) >= 0) {
            const event = text.slice(0, end); text = text.slice(end + 2);
            const data = event.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
            if (data) { const item = JSON.parse(data); if (item.id === message.id) reply = item; }
          }
        }
      } finally { await reader.cancel(); }
    } else {
      const text = await response.text();
      if (text.length > 8 * 1024 * 1024) throw new Error('MCP response exceeds 8 MB.');
      reply = JSON.parse(text);
    }
    if (!reply || reply.id !== message.id) throw new Error('MCP server returned no matching response.');
    if (reply.error) throw new Error(`MCP error ${reply.error.code}: ${reply.error.message}`);
    return reply.result;
  }
  async close(): Promise<void> {
    this.closed = true;
    this.initialized = false;
    this.failAll(new Error('MCP connection closed.'));
    if (this.child) { this.child.stdin.end(); this.child.kill(); this.child = undefined; }
    if (this.config.transport === 'http' && this.sessionId) {
      await fetch(this.config.url, { method: 'DELETE', headers: { ...this.config.headers, 'Mcp-Session-Id': this.sessionId }, signal: AbortSignal.timeout(2000) }).catch(() => {});
    }
  }
}
