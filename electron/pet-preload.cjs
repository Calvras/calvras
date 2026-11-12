const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('pet', {
  onState: callback => ipcRenderer.on('pet:state', (_event, state) => callback(state)),
  menu: () => ipcRenderer.send('pet:menu'),
  restore: () => ipcRenderer.send('pet:restore'),
  drag: (dx, dy) => ipcRenderer.send('pet:drag', dx, dy),
  dragEnd: () => ipcRenderer.send('pet:drag-end'),
});
