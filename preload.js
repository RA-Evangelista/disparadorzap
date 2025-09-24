const { contextBridge, ipcRenderer } = require('electron');

// Expondo APIs customizadas
contextBridge.exposeInMainWorld('electronAPI', {
    selectFile: () => ipcRenderer.invoke('dialog:openFile'),
    startWhatsapp: (data) => ipcRenderer.send('start-whatsapp', data),
    pause: () => ipcRenderer.send('pause-whatsapp'),
    resume: () => ipcRenderer.send('resume-whatsapp'),
    stop: () => ipcRenderer.send('stop-whatsapp'),

    onQrCode: (callback) => ipcRenderer.on('qr_code', (event, data) => callback(data)),
    onStatusUpdate: (callback) => ipcRenderer.on('status_update', (event, data) => callback(data)),
    onSessionReady: (callback) => ipcRenderer.on('session_ready', callback),
    onProcessFinished: (callback) => ipcRenderer.on('process_finished', callback)
});