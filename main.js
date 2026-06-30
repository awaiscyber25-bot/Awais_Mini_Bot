const {
    default: makeWASocket,
    useMultiFileAuthState,
    delay,
    makeCacheableSignalKeyStore,
    jidNormalizedUser,
    Browsers,
    DisconnectReason,
    jidDecode,
    downloadContentFromMessage,
    getContentType,
} = require('@whiskeysockets/baileys');
const { arslanmd } = require('./lib/system');
const config = require('./config');
const events = require('./arslan');
const { sms } = require('./lib/msg');
const {
    connectdb,
    saveSessionToMongoDB,
    getSessionFromMongoDB,
    deleteSessionFromMongoDB,
    getUserConfigFromMongoDB,
    updateUserConfigInMongoDB,
    addNumberToMongoDB,
    removeNumberFromMongoDB,
    getAllNumbersFromMongoDB,
    saveOTPToMongoDB,
    verifyOTPFromMongoDB,
    incrementStats,
    getStatsForNumber
} = require('./lib/database');
const { handleAntidelete } = require('./lib/antidelete');

const express = require('express');
const fs = require('fs-extra');
const path = require('path');
const pino = require('pino');
const crypto = require('crypto');
const FileType = require('file-type');

const prefix = config.PREFIX;
const mode = config.MODE || config.WORK_TYPE;
const router = express.Router();

connectdb();

const activeSockets = new Map();
const socketCreationTime = new Map();

function createarslanStore() {
    const store = {
        messages: {},
        bind(ev) {
            ev.on('messages.upsert', ({ messages }) => {
                for (const msg of messages) {
                    const jid = msg.key && msg.key.remoteJid;
                    if (!jid) continue;
                    if (!store.messages[jid]) store.messages[jid] = [];
                    store.messages[jid].push(msg);
                    if (store.messages[jid].length > 200) store.messages[jid].shift();
                }
            });
        },
        async loadMessage(jid, id) {
            if (!store.messages[jid]) return null;
            return store.messages[jid].find(m => m.key && m.key.id === id) || null;
        }
    };
    return store;
}

const createSerial = (size) => crypto.randomBytes(size).toString('hex').slice(0, size);

function arslanLog(message, type = 'info') {
    const icons = { info: '📝', success: '✅', error: '❌', warning: '⚠️' };
    console.log(`${icons[type] || '📝'} [ARSLAN-MD] ${new Date().toISOString()}: ${message}`);
}

async function arslanPair(number, res = null) {
    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const sessionPath = path.join(__dirname, 'session', `session_${sanitizedNumber}`);
    
    try {
        const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
        
        const conn = makeWASocket({
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" })),
            },
            printQRInTerminal: false,
            logger: pino({ level: "silent" }),
            browser: Browsers.ubuntu('Chrome'), // FIX: Fixed browser compatibility
            syncFullHistory: true,
        });

        conn.ev.on('creds.update', saveCreds);

        if (!conn.authState.creds.registered) {
            arslanLog(`Starting pairing process for ${sanitizedNumber}...`, 'info');
            await delay(2000);
            const code = await conn.requestPairingCode(sanitizedNumber);
            arslanLog(`Pairing Code: ${code}`, 'success');
            if (res && !res.headersSent) res.send({ code: code, status: 'new_pairing' });
        } else {
            arslanLog(`Session exists for ${sanitizedNumber}`, 'success');
            if (res && !res.headersSent) res.json({ status: 'reconnecting' });
        }

        conn.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;
            if (connection === 'open') {
                activeSockets.set(sanitizedNumber, conn);
                arslanLog(`Connected: ${sanitizedNumber}`, 'success');
            }
            if (connection === 'close') {
                activeSockets.delete(sanitizedNumber);
            }
        });

    } catch (err) {
        arslanLog(`Pairing Error: ${err.message}`, 'error');
        if (res && !res.headersSent) res.status(500).send({ error: err.message });
    }
}

router.get('/', (req, res) => res.sendFile(path.join(__dirname, 'pair.html')));
router.get('/code', async (req, res) => { 
    if (!req.query.number) return res.json({ error: 'Number required' }); 
    await arslanPair(req.query.number, res); 
});

module.exports = router;
