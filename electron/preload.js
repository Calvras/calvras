// preload.js — context isolation bridge
// The renderer is a full web app served from localhost — no node APIs needed
window.addEventListener('DOMContentLoaded', () => {
  // Patch title bar if needed
  const titleEl = document.querySelector('title')
  if (titleEl) document.title = titleEl.textContent || 'Calvras'
})
