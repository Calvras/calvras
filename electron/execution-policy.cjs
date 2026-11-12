'use strict';

const { randomUUID } = require('node:crypto');
const MODES = new Set(['Request Review', 'Default', 'Turbo']);

function classifyCommand(command) {
  if (typeof command !== 'string' || !command.trim() || command.length > 32768) throw new Error('Provide a nonempty command up to 32 KB.');
  const text = command.trim();
  const destructive = /\b(rm|rmdir|del|erase|remove-item|format|clear-disk|drop\s+(?:table|database)|git\s+(?:reset|clean))\b/i.test(text);
  const external = /\b(push|publish|deploy|send-mailmessage|invoke-restmethod|curl|wget|ssh|scp)\b/i.test(text);
  const safe = /^(?:pwd|Get-Location|ls|dir|Get-ChildItem|git (?:status(?: --short)?|log -[1-9]\d?)|node --version|npm --version|python --version)$/i.test(text);
  return { destructive, external, safe };
}

function createExecutionPolicy({ onRequest, onSettled = () => {} }) {
  let mode = 'Request Review';
  const pending = new Map();
  function setMode(value) {
    if (!MODES.has(value)) throw new Error('Unknown approval mode.');
    mode = value;
    return mode;
  }
  function settle(id, allowed) {
    const request = pending.get(id);
    if (!request) return false;
    pending.delete(id);
    clearTimeout(request.timer);
    onSettled({ id, allowed });
    request.resolve(allowed);
    return true;
  }
  async function authorize(command, { force = false, title = 'Run a command', reason = '' } = {}) {
    const classification = classifyCommand(command);
    // Full access (Turbo) is unrestricted: run every command without asking.
    // Other modes still gate destructive/external commands, and Default only auto-runs known-safe reads.
    if (!force && (mode === 'Turbo' || (!classification.destructive && !classification.external && mode === 'Default' && classification.safe))) return;
    const allowed = await new Promise((resolve) => {
      const id = randomUUID();
      const timer = setTimeout(() => settle(id, false), 10 * 60 * 1000);
      pending.set(id, { resolve, timer });
      try { onRequest({ id, command, title, reason, destructive: classification.destructive }); }
      catch { settle(id, false); }
    });
    if (!allowed) throw new Error('Action was denied or cancelled. Do not retry it unless the user asks.');
  }
  function respond({ id, approved } = {}) {
    if (typeof id !== 'string' || typeof approved !== 'boolean') throw new Error('Invalid approval response.');
    if (!settle(id, approved)) throw new Error('This approval is no longer pending.');
    return { accepted: true };
  }
  function cancel() {
    for (const id of pending.keys()) settle(id, false);
  }
  return { setMode, getMode: () => mode, authorize, respond, cancel };
}

module.exports = { createExecutionPolicy, classifyCommand };
