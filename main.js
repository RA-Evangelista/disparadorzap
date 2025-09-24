const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');

let mainWindow;
let client = null;
let isPaused = false;
let isStopped = false;

// Função para criar a janela principal
function createWindow() {
    const indexPath = path.join(__dirname, 'public', 'index.html');
    if (!fs.existsSync(indexPath)) {
        const errorWin = new BrowserWindow({ width: 400, height: 200 });
        errorWin.loadURL('data:text/html,<h1>Erro: index.html não encontrado!</h1>');
        return;
    }
    mainWindow = new BrowserWindow({
        width: 900,
        height: 850,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
        },
        icon: path.join(__dirname, 'public', 'icon.ico'),
        autoHideMenuBar: true,
    });
    mainWindow.setMenu(null);
    mainWindow.loadFile(indexPath);
}

app.whenReady().then(createWindow);
app.on('window-all-closed', function () {
    if (process.platform !== 'darwin') app.quit();
});

function delay(ms) {
    return new Promise(res => setTimeout(res, ms));
}

// PAUSAR envio
ipcMain.on('pause-sending', () => {
    isPaused = true;
    if (mainWindow) mainWindow.webContents.send('status_update', 'Envio pausado pelo usuário.');
});

// RETOMAR envio
ipcMain.on('resume-sending', () => {
    isPaused = false;
    if (mainWindow) mainWindow.webContents.send('status_update', 'Envio retomado!');
});

// PARAR envio (volta ao início SEM fechar app)
ipcMain.on('stop-sending', () => {
    isStopped = true;
    isPaused = false;
    if (mainWindow) {
        mainWindow.webContents.send('status_update', 'Envio parado pelo usuário. Retornando à tela inicial...');
        // Aguarda um pequeno tempo para garantir que a mensagem aparece antes de recarregar
        setTimeout(() => {
            mainWindow.loadFile(path.join(__dirname, 'public', 'index.html'));
        }, 1000);
    }
    // Finaliza client WhatsApp se necessário
    if (client) {
        try { client.destroy(); } catch (e) { }
        client = null;
    }
});

// Diálogo para seleção de arquivo
ipcMain.handle('dialog:openFile', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
        properties: ['openFile'],
        filters: [{ name: 'Arquivos CSV', extensions: ['csv'] }]
    });
    return canceled ? null : filePaths[0];
});

// Handler principal de envio
ipcMain.on('start-whatsapp', async (event, { filePath, messageTemplate }) => {
    // Reset global para evitar múltiplos envios
    isPaused = false;
    isStopped = false;

    client = new Client({
        authStrategy: new LocalAuth(),
        puppeteer: {
            headless: false,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        }
    });

    client.on('qr', async (qr) => {
        const qrDataUrl = await qrcode.toDataURL(qr);
        if (mainWindow) mainWindow.webContents.send('qr_code', qrDataUrl);
    });

    client.on('ready', async () => {
        if (mainWindow) mainWindow.webContents.send('session_ready');

        const contatosComFalha = [];
        let linhas;
        try {
            const data = fs.readFileSync(filePath, 'utf8');
            linhas = data.split(/\r?\n/).filter(linha => linha.trim() !== '');
            if (mainWindow) mainWindow.webContents.send('status_update', `Arquivo lido. ${linhas.length} contatos encontrados. Iniciando envios...`);
        } catch (err) {
            if (mainWindow) mainWindow.webContents.send('status_update', `Erro ao ler o arquivo: ${err.message}`);
            return;
        }

        let contadorSucesso = 0;
        for (let i = 0; i < linhas.length; i++) {
            // Verifica se o usuário pediu para parar
            if (isStopped) {
                if (mainWindow) mainWindow.webContents.send('status_update', 'Envio interrompido pelo usuário.');
                setTimeout(() => {
                    mainWindow.loadFile(path.join(__dirname, 'public', 'index.html'));
                }, 1000);
                if (client) { try { client.destroy(); } catch (e) { } client = null; }
                return; // Sai do loop e da função
            }

            const linha = linhas[i];
            let nome = `Linha ${i + 1}`;
            let telefone = '';

            try {
                if (linha) {
                    const colunas = linha.split(';');
                    if (colunas.length >= 2) {
                        nome = colunas[0].trim();
                        telefone = colunas[1].trim();
                        telefone = colunas[1].trim().replace(/\D/g, ''); // Remove tudo que não for número
                        if (!telefone) throw new Error("Número de telefone vazio.");

                        const numeroFormatado = `55${telefone}@c.us`;
                        const mensagemFinal = messageTemplate.replace(/{nome}/g, nome);

                        const statusMsg = `(${i + 1}/${linhas.length}) Enviando para: ${nome}`;
                        if (mainWindow) mainWindow.webContents.send('status_update', statusMsg);

                        await client.sendMessage(numeroFormatado, mensagemFinal);

                        contadorSucesso++;
                        while (isPaused && !isStopped) {
                            await delay(1000);
                        }
                        if (isStopped) {
                            if (mainWindow) mainWindow.webContents.send('status_update', 'Envio interrompido pelo usuário.');
                            setTimeout(() => {
                                mainWindow.loadFile(path.join(__dirname, 'public', 'index.html'));
                            }, 1000);
                            if (client) { try { client.destroy(); } catch (e) { } client = null; }
                            return;
                        }
                        if (contadorSucesso > 0 && contadorSucesso % 50 === 0 && (i + 1) < linhas.length) {
                            if (mainWindow) mainWindow.webContents.send('status_update', `PAUSA DE 60 SEGUNDOS... (${contadorSucesso} enviados)`);
                            await delay(60000);
                        } else {
                            await delay(15000);
                        }
                    }
                }
            } catch (err) {
                console.error(`ERRO ao enviar para ${nome}: ${err.message}`);
                contatosComFalha.push({ nome, telefone, erro: err.message });
                if (mainWindow) mainWindow.webContents.send('status_update', `Erro ao enviar para ${nome}. Pulando...`);
                await delay(5000);
            }
        }

        let finalReport = `Processo finalizado! ${contadorSucesso} mensagens enviadas com sucesso.`;
        if (contatosComFalha.length > 0) {
            finalReport += `\n\n--- RELATÓRIO DE FALHAS ---\n` + contatosComFalha.map(c => `- ${c.nome} (${c.telefone}): Número inválido ou não encontrado`).join('\n');
        }
        if (mainWindow) mainWindow.webContents.send('status_update', finalReport);

        // Ao finalizar normalmente, volta à tela inicial após alguns segundos
        setTimeout(() => {
            mainWindow.loadFile(path.join(__dirname, 'public', 'index.html'));
        }, 3000);

        if (client) { try { client.destroy(); } catch (e) { } client = null; }
    });

    client.initialize();
});