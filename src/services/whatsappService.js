const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, delay, fetchLatestBaileysVersion } = require('baileys');

const { Boom } = require('@hapi/boom');
const qrcode = require('qrcode');
const path = require('path');
const fs = require('fs').promises;
const database = require('../config/database.js');
const config = require('../config/config.js');
const webhookService = require('./webhookService.js');

class WhatsAppService {
    constructor() {
        this.instances = new Map();
        this.reconnectAttempts = new Map();
        this.appStateReady = new Map(); // Track app state readiness
        this.groupMetadataCache = new Map();
    }

    async init(instanceId) {
        try {
            const sessionPath = path.join(config.whatsapp.sessionPath, instanceId);

            // Ensure session directory exists
            await fs.mkdir(sessionPath, { recursive: true });

            // Use the per-instance session path as the auth directory for Baileys
            const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
            const { version, isLatest } = await fetchLatestBaileysVersion();

            console.info(`📱 Using WA version ${version.join('.')}, isLatest: ${isLatest} for instance ${instanceId}`);

            // Create socket connection
            const socket = makeWASocket({
                version,
                auth: state,
                printQRInTerminal: false,
                browser: ['WhatsApp Gateway', 'Chrome', '1.0.0'],
                defaultQueryTimeoutMs: undefined,
                keepAliveIntervalMs: 30000,
                connectTimeoutMs: 60000,
                emitOwnEvents: true,
                generateHighQualityLinkPreview: true,
                syncFullHistory: true,
                logger: {
                    level: 'error',
                    trace: () => {},
                    debug: () => {},
                    info: () => {},
                    warn: () => {},
                    error: (data, msg) => {
                        // Only log meaningful errors, ignore debug objects
                        if (msg && typeof msg === 'string') {
                            console.error(`[Baileys] ${msg}`);
                        } else if (data && data.err && data.err instanceof Error) {
                            console.error(`[Baileys] ${data.err.message}`);
                        }
                    },
                    fatal: (msg) => console.error(`[Baileys Fatal] ${msg}`),
                    child: () => ({
                        level: 'error',
                        trace: () => {},
                        debug: () => {},
                        info: () => {},
                        warn: () => {},
                        error: (data, msg) => {
                            if (msg && typeof msg === 'string') {
                                console.error(`[Baileys] ${msg}`);
                            } else if (data && data.err && data.err instanceof Error) {
                                console.error(`[Baileys] ${data.err.message}`);
                            }
                        },
                        fatal: (msg) => console.error(`[Baileys Fatal] ${msg}`),
                    }),
                },
                cachedGroupMetadata: async (jid) => {
                    if (this.groupMetadataCache.has(jid)) {
                        return this.groupMetadataCache.get(jid);
                    }

                    // Try to fetch metadata from any available socket instance as a best-effort
                    try {
                        for (const inst of this.instances.values()) {
                            if (inst && inst.socket && typeof inst.socket.groupMetadata === 'function') {
                                try {
                                    const metadata = await inst.socket.groupMetadata(jid);
                                    if (metadata) {
                                        this.groupMetadataCache.set(jid, metadata);
                                        return metadata;
                                    }
                                } catch (err) {
                                    // ignore and try next instance
                                }
                            }
                        }
                    } catch (error) {
                        console.error(`Error fetching group metadata for ${jid}: ${error?.message || error}`);
                    }

                    return null;
                },
            });

            // Handle connection updates
            socket.ev.on('connection.update', async (update) => {
                await this.handleConnectionUpdate(instanceId, update, socket, saveCreds);
            });

            // Handle credentials update
            socket.ev.on('creds.update', saveCreds);

            // Handle messages
            socket.ev.on('messages.upsert', async (messageUpdate) => {
                await this.handleIncomingMessages(instanceId, messageUpdate);
            });

            // Handle message status updates (ACK)
            socket.ev.on('messages.update', async (messages) => {
                await this.handleMessageUpdate(instanceId, messages);
            });

            // Handle message revoke (delete)
            socket.ev.on('message.delete', async (messageDelete) => {
                await this.handleMessageRevoke(instanceId, messageDelete);
            });

            // Handle chats update
            socket.ev.on('chats.set', async ({ chats }) => {
                await this.handleChatsUpdate(instanceId, chats);
            });

            // Handle presence update
            socket.ev.on('presence.update', async (presenceUpdate) => {
                await this.handlePresenceUpdate(instanceId, presenceUpdate);
            });

            // Handle call events
            socket.ev.on('call', async (callEvents) => {
                await this.handleCallEvents(instanceId, callEvents);
            });

            // Handle label events
            socket.ev.on('labels.edit', async (labelUpdate) => {
                await this.handleLabelEvents(instanceId, labelUpdate);
            });

            // Handle label association events
            socket.ev.on('labels.association', async (labelAssociation) => {
                await this.handleLabelAssociation(instanceId, labelAssociation);
            });
            
            socket.ev.on('messaging-history.set', async ({ chats, contacts, messages, isLatest }) => {
                console.log(`📱 History sync for instance ${instanceId}: chats=${chats?.length || 0}, contacts=${contacts?.length || 0}, messages=${messages?.length || 0}, isLatest=${isLatest}`);
                
                const prisma = database.getInstance();
                
                // Store all chats from history sync to database
                if (chats && chats.length > 0) {
                    try {
                        for (const chat of chats) {
                            const chatId = chat.id;
                            const name = chat.name || (chat.id || '').split('@')[0];
                            const isGroup = chatId.endsWith('@g.us');
                            const archived = chat.archived || false;
                            const unreadCount = chat.unreadCount || 0;
                            
                            // Extract last message
                            let lastMessage = '';
                            let lastMessageAt = null;
                            
                            if (chat.lastMessage) {
                                if (chat.lastMessage.message?.conversation) {
                                    lastMessage = chat.lastMessage.message.conversation;
                                } else if (chat.lastMessage.message?.extendedTextMessage?.text) {
                                    lastMessage = chat.lastMessage.message.extendedTextMessage.text;
                                } else if (chat.lastMessage.message?.imageMessage?.caption) {
                                    lastMessage = chat.lastMessage.message.imageMessage.caption;
                                } else if (chat.lastMessage.message?.videoMessage?.caption) {
                                    lastMessage = chat.lastMessage.message.videoMessage.caption;
                                } else if (chat.lastMessage.message?.documentMessage?.fileName) {
                                    lastMessage = chat.lastMessage.message.documentMessage.fileName;
                                }
                                
                                if (chat.lastMessage.messageTimestamp) {
                                    lastMessageAt = new Date(chat.lastMessage.messageTimestamp * 1000);
                                }
                            }
                            
                            // Upsert chat to database
                            try {
                                await prisma.chat.upsert({
                                    where: {
                                        instanceId_chatId: {
                                            instanceId,
                                            chatId,
                                        },
                                    },
                                    update: {
                                        name,
                                        archived,
                                        unreadCount,
                                        lastMessage: lastMessage || null,
                                        lastMessageAt: lastMessageAt || null,
                                    },
                                    create: {
                                        instanceId,
                                        chatId,
                                        name,
                                        isGroup,
                                        archived,
                                        unreadCount,
                                        lastMessage: lastMessage || null,
                                        lastMessageAt: lastMessageAt || null,
                                    },
                                });
                            } catch (err) {
                                console.error(`Error syncing chat ${chatId} from history:`, err);
                            }
                        }
                        console.log(`✅ Synced ${chats.length} chats from history to database for instance ${instanceId}`);
                    } catch (error) {
                        console.error('Error processing chats from history sync:', error);
                    }
                }
                
                // Store messages from history sync (if needed)
                // Note: Messages are already handled by handleIncomingMessages, but we can process them here too
                if (messages && messages.length > 0) {
                    console.log(`📨 Processing ${messages.length} messages from history sync for instance ${instanceId}`);
                    // Messages will be processed by handleIncomingMessages when they come through
                }
                
                if (isLatest) {
                    // Only mark as ready if not already marked by timeout
                    if (!this.appStateReady.get(instanceId)) {
                        this.appStateReady.set(instanceId, true);
                        const instance = this.instances.get(instanceId);
                        if (instance) {
                            instance.appStateReady = true;
                        }
                        console.log(`✅ App state fully synced for instance ${instanceId} - Profile updates now available`);
                    }
                }
            });

            // Handle group updates
            socket.ev.on('groups.update', async (updates) => {
                await this.handleGroupUpdate(instanceId, updates);
            });

            // Handle group participant updates
            socket.ev.on('group-participants.update', async (update) => {
                await this.handleGroupParticipantsUpdate(instanceId, update);
            });

            // Store instance
            this.instances.set(instanceId, {
                socket,
                qr: null,
                info: null,
                appStateReady: false,
                pairingCode: null,
            });

            return { success: true, instanceId };
        } catch (error) {
            console.error('Failed to initialize WhatsApp instance:', error);
            throw error;
        }
    }

    async handleConnectionUpdate(instanceId, update, socket, saveCreds) {
        const { connection, lastDisconnect, qr } = update;
        const prisma = database.getInstance();

        try {
            // Always generate QR code when available, regardless of phone number
            if (qr) {
                const qrCode = await qrcode.toDataURL(qr);

                // Update or create instance in database
                await prisma.instance.upsert({
                    where: { id: instanceId },
                    update: {
                        status: 'qr',
                        qrCode: qrCode,
                    },
                    create: {
                        id: instanceId,
                        name: `Instance ${instanceId}`,
                        status: 'qr',
                        qrCode: qrCode,
                    },
                });

                // Store QR in memory
                if (this.instances.has(instanceId)) {
                    this.instances.get(instanceId).qr = qrCode;
                }

                console.log(`QR Code generated for instance ${instanceId}`);

                // Trigger webhook for session status change using new service
                await webhookService.triggerSessionStatus(instanceId, 'qr', {
                    qrCode: qrCode,
                });
            }

            if (connection === 'close') {
                const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
                const attempts = this.reconnectAttempts.get(instanceId) || 0;
                console.log(`Connection closed for instance ${instanceId}. Should reconnect: ${shouldReconnect}`);

                // Update status in database
                await prisma.instance.upsert({
                    where: { id: instanceId },
                    update: {
                        status: 'disconnected',
                        qrCode: null,
                        pairingCode: null,
                    },
                    create: {
                        id: instanceId,
                        name: `Instance ${instanceId}`,
                        status: 'disconnected',
                        qrCode: null,
                        pairingCode: null,
                    },
                });

                // Clear pairing code from memory
                if (this.instances.has(instanceId)) {
                    this.instances.get(instanceId).pairingCode = null;
                }

                // Trigger webhook for session status change using new service
                await webhookService.triggerSessionStatus(instanceId, 'disconnected', {
                    reason: shouldReconnect ? 'connection_lost' : 'logged_out',
                });

                if (shouldReconnect && attempts < config.whatsapp.maxReconnectAttempts) {
                    // Increment reconnect attempts
                    this.reconnectAttempts.set(instanceId, attempts + 1);

                    // Wait before reconnecting
                    await delay(config.whatsapp.reconnectInterval);

                    console.log(`Reconnecting instance ${instanceId}... Attempt ${attempts + 1}`);
                    await this.init(instanceId);
                } else {
                    // Don't remove instance from memory - keep it for potential QR/pairing code generation
                    // Only clear reconnect attempts
                    this.reconnectAttempts.delete(instanceId);

                    if (!shouldReconnect) {
                        console.log(`Instance ${instanceId} logged out`);

                        // Clear session data
                        const sessionPath = path.join(config.whatsapp.sessionPath, instanceId);
                        try {
                            await fs.rmdir(sessionPath, { recursive: true });
                        } catch (err) {
                            console.error('Failed to delete session:', err);
                        }

                        // Clear socket from memory to allow reinitialize for QR generation
                        if (this.instances.has(instanceId)) {
                            this.instances.get(instanceId).socket = null;
                            this.instances.get(instanceId).qr = null;
                            this.instances.get(instanceId).info = null;
                        }
                    }
                }
            }

            if (connection === 'open') {
                console.log(`WhatsApp connection opened for instance ${instanceId}`);

                // Reset reconnect attempts
                this.reconnectAttempts.set(instanceId, 0);

                // Get user info
                const user = socket.user;

                // Update instance in database
                await prisma.instance.upsert({
                    where: { id: instanceId },
                    update: {
                        status: 'connected',
                        phoneNumber: (user?.id || '').split('@')[0] || null,
                        qrCode: null,
                    },
                    create: {
                        id: instanceId,
                        name: `Instance ${instanceId}`,
                        status: 'connected',
                        phoneNumber: (user?.id || '').split('@')[0] || null,
                        qrCode: null,
                    },
                });

                // Store user info
                if (this.instances.has(instanceId)) {
                    this.instances.get(instanceId).info = user;
                    this.instances.get(instanceId).qr = null;

                    // Wait for app state to sync - increased timeout to 30 seconds
                    // Most accounts sync within 5-15 seconds, but some may take longer
                    setTimeout(() => {
                        const instance = this.instances.get(instanceId);
                        if (instance && !this.appStateReady.get(instanceId)) {
                            // If app state hasn't synced after 30 seconds, mark it as ready anyway
                            // Some accounts might not have messaging history or auto-sync disabled
                            this.appStateReady.set(instanceId, true);
                            instance.appStateReady = true;
                            console.warn(`⚠️  App state marked as ready for instance ${instanceId} (timeout after 30s) - messaging-history.set event not received. Profile updates may be limited.`);
                        }
                    }, 30000);
                }

                // Save session data to database
                await this.saveSessionToDatabase(instanceId);

                // Trigger webhook for session status change using new service
                await webhookService.triggerSessionStatus(instanceId, 'connected', {
                    phoneNumber: (user?.id || '').split('@')[0] || null,
                });
            }

            if (connection === 'connecting') {
                console.log(`Connecting instance ${instanceId}...`);

                await prisma.instance.upsert({
                    where: { id: instanceId },
                    update: {
                        status: 'connecting',
                    },
                    create: {
                        id: instanceId,
                        name: `Instance ${instanceId}`,
                        status: 'connecting',
                    },
                });

                // Trigger webhook for session status change using new service
                await webhookService.triggerSessionStatus(instanceId, 'connecting');

                // Auto-pairing code generation is disabled - use manual endpoints instead
            }
        } catch (error) {
            console.error('Error handling connection update:', error);
        }
    }

    async handleIncomingMessages(instanceId, messageUpdate) {
        const prisma = database.getInstance();

        try {
            const messages = messageUpdate.messages;

            for (const msg of messages) {
                // Skip status messages
                if (msg.key.remoteJid === 'status@broadcast') continue;

                // Extract message details
                const messageId = msg.key.id;
                const fromMe = msg.key.fromMe || false;
                const chatId = msg.key.remoteJid;
                const from = fromMe ? 'me' : msg.key.participant || chatId;
                const pushName = msg.pushName || '';
                const timestamp = new Date(msg.messageTimestamp * 1000);

                // Get message content
                let body = '';
                let type = 'text';
                let mediaUrl = null;

                if (msg.message?.conversation) {
                    body = msg.message.conversation;
                } else if (msg.message?.extendedTextMessage?.text) {
                    body = msg.message.extendedTextMessage.text;
                } else if (msg.message?.imageMessage) {
                    type = 'image';
                    body = msg.message.imageMessage.caption || '';
                } else if (msg.message?.videoMessage) {
                    type = 'video';
                    body = msg.message.videoMessage.caption || '';
                } else if (msg.message?.documentMessage) {
                    type = 'document';
                    body = msg.message.documentMessage.fileName || '';
                } else if (msg.message?.audioMessage) {
                    type = 'audio';
                } else if (msg.message?.stickerMessage) {
                    type = 'sticker';
                }

                // Check if chat exists, create if not
                let chat = await prisma.chat.findUnique({
                    where: {
                        instanceId_chatId: {
                            instanceId,
                            chatId,
                        },
                    },
                });

                if (!chat) {
                    const isGroup = chatId.endsWith('@g.us');
                    chat = await prisma.chat.create({
                        data: {
                            instanceId,
                            chatId,
                            name: pushName || (chatId || '').split('@')[0],
                            isGroup,
                            lastMessage: body,
                            lastMessageAt: timestamp,
                        },
                    });
                } else {
                    // Update last message
                    await prisma.chat.update({
                        where: { id: chat.id },
                        data: {
                            lastMessage: body,
                            lastMessageAt: timestamp,
                            unreadCount: fromMe ? 0 : { increment: 1 },
                        },
                    });
                }

                // Save message to database
                await prisma.message.upsert({
                    where: { messageId },
                    update: {
                        fromMe,
                        from,
                        to: chatId,
                        body,
                        type,
                        mediaUrl,
                        timestamp,
                        status: fromMe ? 'sent' : 'received',
                    },
                    create: {
                        instanceId,
                        chatId: chat.id,
                        messageId,
                        fromMe,
                        from,
                        to: chatId,
                        body,
                        type,
                        mediaUrl,
                        timestamp,
                        status: fromMe ? 'sent' : 'received',
                    },
                });

                // Trigger webhook for incoming messages (not from me)
                if (!fromMe) {
                    await webhookService.triggerMessageReceived(instanceId, {
                        messageId,
                        from,
                        chatId,
                        pushName,
                        body,
                        type,
                        mediaUrl,
                        timestamp,
                    });
                }

                console.log(`New message received in instance ${instanceId}: ${body.substring(0, 50)}...`);
            }
        } catch (error) {
            console.error('Error handling incoming messages:', error);
        }
    }

    async handleMessageUpdate(instanceId, messages) {
        const prisma = database.getInstance();

        try {
            for (const update of messages) {
                const messageId = update.key.id;
                const chatId = update.key.remoteJid;
                const from = update.key.fromMe ? 'me' : update.key.participant || chatId;

                // Handle message status updates (ACK)
                if (update.update?.status !== undefined) {
                    const ack = update.update.status;
                    let status = 'sent';

                    switch (ack) {
                        case 0:
                            status = 'pending';
                            break;
                        case 1:
                            status = 'sent';
                            break;
                        case 2:
                            status = 'delivered';
                            break;
                        case 3:
                            status = 'read';
                            break;
                        case 4:
                            status = 'played';
                            break;
                    }

                    // Update in database
                    await prisma.message.updateMany({
                        where: { messageId },
                        data: { status },
                    });

                    // Trigger message.ack webhook
                    await webhookService.triggerMessageAck(instanceId, {
                        messageId,
                        chatId,
                        from,
                        ack,
                        timestamp: new Date().toISOString(),
                    });

                    // Also trigger message.any webhook
                    await webhookService.triggerMessageAny(
                        instanceId,
                        {
                            messageId,
                            chatId,
                            from,
                            ack,
                            status,
                            timestamp: new Date().toISOString(),
                        },
                        'ack',
                    );

                    console.log(`Message ${messageId} status updated to ${status} (ack: ${ack})`);
                }

                // Handle message edit
                if (update.update?.message) {
                    const message = await prisma.message.findFirst({
                        where: { messageId },
                    });

                    if (message) {
                        const oldBody = message.body;
                        let newBody = '';

                        // Extract new message content
                        if (update.update.message.conversation) {
                            newBody = update.update.message.conversation;
                        } else if (update.update.message.extendedTextMessage?.text) {
                            newBody = update.update.message.extendedTextMessage.text;
                        }

                        if (newBody && newBody !== oldBody) {
                            // Update in database
                            await prisma.message.updateMany({
                                where: { messageId },
                                data: { body: newBody },
                            });

                            // Trigger message.edited webhook
                            await webhookService.triggerMessageEdited(instanceId, {
                                messageId,
                                chatId,
                                from,
                                pushName: message.from,
                                oldBody,
                                newBody,
                                editedTimestamp: new Date().toISOString(),
                                originalTimestamp: message.timestamp,
                            });

                            // Also trigger message.any webhook
                            await webhookService.triggerMessageAny(
                                instanceId,
                                {
                                    messageId,
                                    chatId,
                                    from,
                                    oldBody,
                                    newBody,
                                    timestamp: new Date().toISOString(),
                                },
                                'edited',
                            );

                            console.log(`Message ${messageId} edited from "${oldBody}" to "${newBody}"`);
                        }
                    }
                }
            }
        } catch (error) {
            console.error('Error handling message update:', error);
        }
    }

    async handleMessageRevoke(instanceId, messageDelete) {
        const prisma = database.getInstance();

        try {
            const messageId = messageDelete.key.id;
            const chatId = messageDelete.key.remoteJid;
            const fromMe = messageDelete.key.fromMe;
            const from = fromMe ? 'me' : messageDelete.key.participant || chatId;

            // Get original message before deleting
            const message = await prisma.message.findFirst({
                where: { messageId },
            });

            if (message) {
                // Delete from database
                await prisma.message.deleteMany({
                    where: { messageId },
                });

                // Trigger message.revoked webhook
                await webhookService.triggerMessageRevoked(instanceId, {
                    messageId,
                    chatId,
                    from,
                    revokedBy: fromMe ? 'me' : 'them',
                    originalMessage: {
                        body: message.body,
                        type: message.type,
                        timestamp: message.timestamp,
                    },
                    timestamp: new Date().toISOString(),
                });

                // Also trigger message.any webhook
                await webhookService.triggerMessageAny(
                    instanceId,
                    {
                        messageId,
                        chatId,
                        from,
                        revokedBy: fromMe ? 'me' : 'them',
                        originalMessage: message.body,
                        timestamp: new Date().toISOString(),
                    },
                    'revoked',
                );

                console.log(`Message ${messageId} revoked by ${fromMe ? 'me' : 'them'}`);
            }
        } catch (error) {
            console.error('Error handling message revoke:', error);
        }
    }

    async handleChatsUpdate(instanceId, chats) {
        const prisma = database.getInstance();

        try {
            for (const chat of chats) {
                const chatId = chat.id;
                const name = chat.name || (chat.id || '').split('@')[0];
                const isGroup = chatId.endsWith('@g.us');
                const archived = chat.archived || false;
                const unreadCount = chat.unreadCount || 0;

                // Upsert chat
                await prisma.chat.upsert({
                    where: {
                        instanceId_chatId: {
                            instanceId,
                            chatId,
                        },
                    },
                    update: {
                        name,
                        archived,
                        unreadCount,
                    },
                    create: {
                        instanceId,
                        chatId,
                        name,
                        isGroup,
                        archived,
                        unreadCount,
                    },
                });
            }
        } catch (error) {
            console.error('Error handling chats update:', error);
        }
    }

    async handlePresenceUpdate(instanceId, presenceUpdate) {
        // Handle presence updates if needed
        console.log(`Presence update for instance ${instanceId}:`, presenceUpdate);
    }

    async saveSessionToDatabase(instanceId) {
        const prisma = database.getInstance();

        try {
            const sessionPath = path.join(config.whatsapp.sessionPath, instanceId);
            const sessionFiles = await fs.readdir(sessionPath);
            const sessionData = {};

            for (const file of sessionFiles) {
                if (file.endsWith('.json')) {
                    const filePath = path.join(sessionPath, file);
                    const content = await fs.readFile(filePath, 'utf-8');
                    sessionData[file] = JSON.parse(content);
                }
            }

            await prisma.session.upsert({
                where: { instanceId },
                update: {
                    sessionData: JSON.stringify(sessionData),
                },
                create: {
                    instanceId,
                    sessionData: JSON.stringify(sessionData),
                },
            });
        } catch (error) {
            console.error('Error saving session to database:', error);
        }
    }

    async triggerWebhook(url, data) {
        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(data),
            });

            if (!response.ok) {
                throw new Error(`Webhook failed: ${response.statusText}`);
            }
        } catch (error) {
            console.error('Error triggering webhook:', error);
        }
    }

    async sendMessage(instanceId, to, message, options = {}) {
        const instance = this.instances.get(instanceId);

        if (!instance || !instance.socket) {
            throw new Error('Instance not found or not connected');
        }

        const { socket } = instance;
        const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`;

        try {
            let sentMessage;

            if (options.type === 'image' && options.media) {
                sentMessage = await socket.sendMessage(jid, {
                    image: { url: options.media },
                    caption: message,
                });
            } else if (options.type === 'document' && options.media) {
                sentMessage = await socket.sendMessage(jid, {
                    document: { url: options.media },
                    fileName: options.fileName || 'document',
                    mimetype: options.mimetype || 'application/octet-stream',
                });
            } else if (options.type === 'video' && options.media) {
                sentMessage = await socket.sendMessage(jid, {
                    video: { url: options.media },
                    caption: message,
                });
            } else if (options.type === 'audio' && options.media) {
                sentMessage = await socket.sendMessage(jid, {
                    audio: { url: options.media },
                    ptt: options.ptt || false,
                });
            } else {
                sentMessage = await socket.sendMessage(jid, {
                    text: message,
                });
            }

            return sentMessage;
        } catch (error) {
            console.error('Error sending message:', error);
            throw error;
        }
    }

    async requestPairingCode(instanceId, phoneNumber) {
        let instance = this.instances.get(instanceId);

        // If instance doesn't exist or socket is not available, reinitialize with forceFresh
        if (!instance || !instance.socket) {
            console.log(`Reinitializing instance ${instanceId} for pairing code request`);
            await this.init(instanceId, true); // Force fresh connection
            instance = this.instances.get(instanceId);

            if (!instance || !instance.socket) {
                throw new Error('Failed to initialize instance for pairing code request');
            }
        }

        const { socket } = instance;

        try {
            // Ensure phone number is in E.164 format without plus sign
            const cleanPhoneNumber = phoneNumber.replace(/^\+/, '');

            // Wait a bit for socket to be ready
            let attempts = 0;
            while (!socket.user && attempts < 10) {
                await new Promise((resolve) => setTimeout(resolve, 1000));
                attempts++;
            }

            const pairingCode = await socket.requestPairingCode(cleanPhoneNumber);
            console.log(`Pairing code requested for ${cleanPhoneNumber}: ${pairingCode}`);

            // Store pairing code in memory
            instance.pairingCode = pairingCode;

            // Update instance in database
            const prisma = database.getInstance();
            await prisma.instance.upsert({
                where: { id: instanceId },
                update: {
                    pairingCode: pairingCode,
                },
                create: {
                    id: instanceId,
                    name: `Instance ${instanceId}`,
                    pairingCode: pairingCode,
                },
            });

            return pairingCode;
        } catch (error) {
            console.error('Error requesting pairing code:', error);
            throw error;
        }
    }

    getPairingCode(instanceId) {
        const instance = this.instances.get(instanceId);
        return instance?.pairingCode || null;
    }

    async deleteInstance(instanceId) {
        const instance = this.instances.get(instanceId);

        if (instance && instance.socket) {
            await instance.socket.logout();
        }

        // Remove from memory
        this.instances.delete(instanceId);
        this.reconnectAttempts.delete(instanceId);
        this.appStateReady.delete(instanceId);

        // Delete session files
        const sessionPath = path.join(config.whatsapp.sessionPath, instanceId);
        try {
            await fs.rmdir(sessionPath, { recursive: true });
        } catch (err) {
            console.error('Failed to delete session files:', err);
        }
    }

    removeInstanceFromMemory(instanceId) {
        // Remove from memory without logging out (for reinitialize purposes)
        this.instances.delete(instanceId);
        this.reconnectAttempts.delete(instanceId);
        this.appStateReady.delete(instanceId);
    }

    getInstance(instanceId) {
        const instance = this.instances.get(instanceId);
        if (instance) {
            instance.appStateReady = this.appStateReady.get(instanceId) || false;
        }
        return instance;
    }

    isAppStateReady(instanceId) {
        return this.appStateReady.get(instanceId) || false;
    }

    getAllInstances() {
        return Array.from(this.instances.keys());
    }

    getInstanceStatus(instanceId) {
        const instance = this.instances.get(instanceId);

        if (!instance) {
            return 'not_found';
        }

        if (instance.socket?.user) {
            return 'connected';
        } else if (instance.qr) {
            return 'qr';
        } else {
            return 'disconnected';
        }
    }

    getMessageType(message) {
        if (message?.conversation || message?.extendedTextMessage) return 'text';
        if (message?.imageMessage) return 'image';
        if (message?.videoMessage) return 'video';
        if (message?.documentMessage) return 'document';
        if (message?.audioMessage) return 'audio';
        if (message?.stickerMessage) return 'sticker';
        if (message?.contactMessage) return 'contact';
        if (message?.locationMessage) return 'location';
        return 'unknown';
    }

    // Chat Methods
    async getChats(instanceId) {
        const instance = this.instances.get(instanceId);

        if (!instance || !instance.socket) {
            throw new Error('Instance not found or not connected');
        }

        const { socket } = instance;
        const prisma = database.getInstance();

        try {
            // First, try to fetch all chats from WhatsApp server if store is empty or incomplete
            let storeChats = [];
            
            // Get chats from store first
            if (socket.store && socket.store.chats) {
                try {
                    // Try different methods to get chats from store
                    if (typeof socket.store.chats.all === 'function') {
                        storeChats = socket.store.chats.all();
                    } else if (socket.store.chats instanceof Map) {
                        storeChats = Array.from(socket.store.chats.values());
                    } else if (typeof socket.store.chats === 'object') {
                        storeChats = Object.values(socket.store.chats);
                    } else if (Array.isArray(socket.store.chats)) {
                        storeChats = socket.store.chats;
                    }
                    
                    // Filter out invalid chats
                    storeChats = storeChats.filter(chat => chat && chat.id);
                    
                    console.log(`Found ${storeChats.length} chats in WhatsApp store for instance ${instanceId}`);
                } catch (err) {
                    console.error('Error getting chats from store:', err);
                }
            }

            // According to Baileys docs: https://baileys.wiki/docs/socket/history-sync/
            // We can use fetchMessageHistory for on-demand history sync
            // But first, let's check if we have all chats in database
            const dbChatCount = await prisma.chat.count({ where: { instanceId } });
            
            // If database has few chats and store also has few, try to trigger history sync
            // Note: History sync happens automatically on connection, but we can check if it's complete
            if ((storeChats.length < 50 || dbChatCount < 50) && socket.fetchMessageHistory) {
                try {
                    console.log(`Store has ${storeChats.length} chats, database has ${dbChatCount} chats. History sync should have populated these.`);
                    console.log(`If chats are missing, they will be synced via messaging-history.set event when available.`);
                } catch (err) {
                    console.error('Error checking history sync status:', err);
                }
            }
            
            // Log store status
            if (storeChats.length === 0) {
                console.log(`No chats found in WhatsApp store for instance ${instanceId}. Will use database as fallback.`);
            }

            // Sync all chats from store to database
            const chatMap = new Map();
            
            for (const chat of storeChats) {
                const chatId = chat.id;
                const name = chat.name || (chat.id || '').split('@')[0];
                const isGroup = chatId.endsWith('@g.us');
                const archived = chat.archived || false;
                const unreadCount = chat.unreadCount || 0;
                
                // Extract last message
                let lastMessage = '';
                let lastMessageAt = null;
                
                if (chat.lastMessage) {
                    if (chat.lastMessage.message?.conversation) {
                        lastMessage = chat.lastMessage.message.conversation;
                    } else if (chat.lastMessage.message?.extendedTextMessage?.text) {
                        lastMessage = chat.lastMessage.message.extendedTextMessage.text;
                    } else if (chat.lastMessage.message?.imageMessage?.caption) {
                        lastMessage = chat.lastMessage.message.imageMessage.caption;
                    } else if (chat.lastMessage.message?.videoMessage?.caption) {
                        lastMessage = chat.lastMessage.message.videoMessage.caption;
                    } else if (chat.lastMessage.message?.documentMessage?.fileName) {
                        lastMessage = chat.lastMessage.message.documentMessage.fileName;
                    }
                    
                    if (chat.lastMessage.messageTimestamp) {
                        lastMessageAt = new Date(chat.lastMessage.messageTimestamp * 1000);
                    }
                }

                // Upsert to database
                try {
                    await prisma.chat.upsert({
                        where: {
                            instanceId_chatId: {
                                instanceId,
                                chatId,
                            },
                        },
                        update: {
                            name,
                            archived,
                            unreadCount,
                            lastMessage: lastMessage || null,
                            lastMessageAt: lastMessageAt || null,
                        },
                        create: {
                            instanceId,
                            chatId,
                            name,
                            isGroup,
                            archived,
                            unreadCount,
                            lastMessage: lastMessage || null,
                            lastMessageAt: lastMessageAt || null,
                        },
                    });
                } catch (err) {
                    console.error(`Error syncing chat ${chatId} to database:`, err);
                }

                // Store in map for response
                chatMap.set(chatId, {
                    id: chatId,
                    name,
                    isGroup,
                    archived,
                    unreadCount,
                    lastMessage: lastMessage || null,
                    lastMessageAt,
                });
            }

            // Note: We'll get all chats from database below, so we don't need to filter here

            // Get ALL chats from database (this is the complete list)
            const allDbChats = await prisma.chat.findMany({
                where: { instanceId },
                orderBy: { lastMessageAt: 'desc' },
                include: {
                    _count: {
                        select: { messages: true },
                    },
                },
            });

            // Create a map of all database chats
            const dbChatMap = new Map();
            allDbChats.forEach(chat => {
                dbChatMap.set(chat.chatId, {
                    id: chat.chatId,
                    name: chat.name,
                    isGroup: chat.isGroup,
                    archived: chat.archived,
                    unreadCount: chat.unreadCount,
                    lastMessage: chat.lastMessage,
                    lastMessageAt: chat.lastMessageAt,
                    messageCount: chat._count.messages,
                });
            });

            // Merge store data with database data
            // Store data (real-time) takes priority for fields like name, archived, unreadCount
            // But we include ALL chats from database, not just from store
            const allChats = Array.from(dbChatMap.values()).map((dbChat) => {
                const storeChat = chatMap.get(dbChat.id);
                
                // If chat exists in store, use store data (more up-to-date)
                if (storeChat) {
                    return {
                        id: dbChat.id,
                        name: storeChat.name || dbChat.name,
                        isGroup: dbChat.isGroup,
                        archived: storeChat.archived !== undefined ? storeChat.archived : dbChat.archived,
                        unreadCount: storeChat.unreadCount !== undefined ? storeChat.unreadCount : dbChat.unreadCount,
                        lastMessage: storeChat.lastMessage || dbChat.lastMessage,
                        lastMessageAt: storeChat.lastMessageAt || dbChat.lastMessageAt,
                        messageCount: dbChat.messageCount,
                    };
                }
                
                // Otherwise use database data
                return dbChat;
            });

            // Also add any chats from store that are not in database yet
            chatMap.forEach((storeChat, chatId) => {
                if (!dbChatMap.has(chatId)) {
                    // Find message count from database for this chat
                    const dbChat = allDbChats.find(c => c.chatId === chatId);
                    allChats.push({
                        id: storeChat.id,
                        name: storeChat.name,
                        isGroup: storeChat.isGroup,
                        archived: storeChat.archived,
                        unreadCount: storeChat.unreadCount,
                        lastMessage: storeChat.lastMessage,
                        lastMessageAt: storeChat.lastMessageAt,
                        messageCount: dbChat?._count?.messages || 0,
                    });
                }
            });

            console.log(`Total chats: ${allChats.length} (from store: ${chatMap.size}, from database: ${allDbChats.length})`);

            // If no chats found at all, return empty array
            if (allChats.length === 0) {
                const dbChatCount = await prisma.chat.count({ where: { instanceId } });
                console.log(`No chats found for instance ${instanceId}`, {
                    storeChats: storeChats.length,
                    chatMapSize: chatMap.size,
                    databaseCount: dbChatCount,
                    hasStore: !!socket.store,
                    hasChats: !!socket.store?.chats,
                });
                return [];
            }

            // Sort by lastMessageAt descending
            allChats.sort((a, b) => {
                const dateA = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : 0;
                const dateB = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : 0;
                return dateB - dateA;
            });

            console.log(`Returning ${allChats.length} chats for instance ${instanceId}`);
            return allChats;
        } catch (error) {
            console.error('Error getting chats:', error);
            throw error;
        }
    }

    async getChatsOverview(instanceId) {
        const chats = await this.getChats(instanceId);

        return chats.map((chat) => ({
            id: chat.id,
            name: chat.name,
            isGroup: chat.isGroup,
            unreadCount: chat.unreadCount,
            lastMessage: chat.lastMessage,
            lastMessageAt: chat.lastMessageAt,
        }));
    }

    async deleteChat(instanceId, chatId) {
        const instance = this.instances.get(instanceId);

        if (!instance || !instance.socket) {
            throw new Error('Instance not found or not connected');
        }

        const { socket } = instance;
        const prisma = database.getInstance();

        try {
            // Normalize chatId to ensure proper JID format
            let normalizedChatId = chatId;
            if (!chatId.includes('@')) {
                // If no @, assume it's a phone number, add @s.whatsapp.net
                normalizedChatId = `${chatId}@s.whatsapp.net`;
            }

            // Verify chat exists in database first
            const existingChat = await prisma.chat.findUnique({
                where: {
                    instanceId_chatId: {
                        instanceId,
                        chatId: normalizedChatId,
                    },
                },
            });

            if (!existingChat) {
                // Try with original chatId format
                const existingChatAlt = await prisma.chat.findUnique({
                    where: {
                        instanceId_chatId: {
                            instanceId,
                            chatId: chatId,
                        },
                    },
                });

                if (!existingChatAlt) {
                    console.warn(`Chat ${chatId} not found in database, but will still try to delete from WhatsApp`);
                }
            }

            // Delete from WhatsApp
            try {
                await socket.chatModify({
                    chatId: normalizedChatId,
                    delete: true,
                });
                console.log(`Chat ${normalizedChatId} deleted from WhatsApp`);
            } catch (whatsappError) {
                // If WhatsApp deletion fails, try with original chatId
                if (normalizedChatId !== chatId) {
                    try {
                        await socket.chatModify({
                            chatId: chatId,
                            delete: true,
                        });
                        console.log(`Chat ${chatId} deleted from WhatsApp (using original format)`);
                        normalizedChatId = chatId; // Use original for database deletion
                    } catch (err) {
                        console.error('Error deleting chat from WhatsApp:', err);
                        throw new Error(`Failed to delete chat from WhatsApp: ${err.message}`);
                    }
                } else {
                    throw whatsappError;
                }
            }

            // Find chat in database to get the chat.id for message deletion
            const chatToDelete = await prisma.chat.findFirst({
                where: {
                    instanceId,
                    OR: [
                        { chatId: normalizedChatId },
                        { chatId: chatId }, // Also try original format
                    ],
                },
            });

            let deletedMessages = { count: 0 };
            if (chatToDelete) {
                // Delete messages using chat.id (foreign key)
                deletedMessages = await prisma.message.deleteMany({
                    where: {
                        chatId: chatToDelete.id,
                    },
                });
                console.log(`Deleted ${deletedMessages.count} messages for chat ${chatToDelete.id}`);
            } else {
                // If chat not found, messages will be deleted by cascade when chat is deleted
                // But we can try to find and delete by matching 'to' field
                console.log(`Chat not found in database, messages may be orphaned`);
            }

            // Delete chat from database
            const deletedChats = await prisma.chat.deleteMany({
                where: {
                    instanceId,
                    OR: [
                        { chatId: normalizedChatId },
                        { chatId: chatId }, // Also try original format
                    ],
                },
            });

            console.log(`Deleted chat ${normalizedChatId} from database (${deletedChats.count} chat(s), ${deletedMessages.count} message(s))`);

            return { 
                success: true, 
                message: 'Chat deleted successfully',
                deleted: {
                    chat: deletedChats.count,
                    messages: deletedMessages.count,
                },
            };
        } catch (error) {
            console.error('Error deleting chat:', error);
            throw error;
        }
    }

    async getChatPicture(instanceId, chatId) {
        const instance = this.instances.get(instanceId);

        if (!instance || !instance.socket) {
            throw new Error('Instance not found or not connected');
        }

        const { socket } = instance;

        try {
            const picture = await socket.profilePictureUrl(chatId, 'image');
            return { pictureUrl: picture };
        } catch (error) {
            console.error('Error getting chat picture:', error);
            throw error;
        }
    }

    async getMessagesInChat(instanceId, chatId, limit = 50) {
        const prisma = database.getInstance();

        try {
            const messages = await prisma.message.findMany({
                where: {
                    instanceId,
                    chatId: {
                        contains: chatId,
                    },
                },
                orderBy: { timestamp: 'desc' },
                take: limit,
                include: {
                    chat: true,
                },
            });

            return messages.reverse(); // Return in chronological order
        } catch (error) {
            console.error('Error getting messages in chat:', error);
            throw error;
        }
    }

    async clearAllMessages(instanceId, chatId) {
        const instance = this.instances.get(instanceId);

        if (!instance || !instance.socket) {
            throw new Error('Instance not found or not connected');
        }

        const { socket } = instance;
        const prisma = database.getInstance();

        try {
            // Clear messages from WhatsApp
            await socket.chatModify({
                chatId,
                clear: true,
            });

            // Delete messages from database
            await prisma.message.deleteMany({
                where: {
                    instanceId,
                    chatId: {
                        contains: chatId,
                    },
                },
            });

            return { success: true, message: 'All messages cleared successfully' };
        } catch (error) {
            console.error('Error clearing all messages:', error);
            throw error;
        }
    }

    async readUnreadMessages(instanceId, chatId) {
        const instance = this.instances.get(instanceId);

        if (!instance || !instance.socket) {
            throw new Error('Instance not found or not connected');
        }

        const { socket } = instance;
        const prisma = database.getInstance();

        try {
            // Mark as read in WhatsApp
            await socket.chatModify({
                chatId,
                markRead: true,
            });

            // Update unread count in database
            await prisma.chat.updateMany({
                where: {
                    instanceId,
                    chatId,
                },
                data: {
                    unreadCount: 0,
                },
            });

            return { success: true, message: 'Messages marked as read' };
        } catch (error) {
            console.error('Error reading unread messages:', error);
            throw error;
        }
    }

    async getMessageById(instanceId, chatId, messageId) {
        const prisma = database.getInstance();

        try {
            const message = await prisma.message.findUnique({
                where: { messageId },
                include: {
                    chat: true,
                },
            });

            if (!message) {
                throw new Error('Message not found');
            }

            return message;
        } catch (error) {
            console.error('Error getting message by ID:', error);
            throw error;
        }
    }

    async deleteMessage(instanceId, chatId, messageId) {
        const instance = this.instances.get(instanceId);

        if (!instance || !instance.socket) {
            throw new Error('Instance not found or not connected');
        }

        const { socket } = instance;
        const prisma = database.getInstance();

        try {
            // Delete from WhatsApp
            await socket.sendMessage(chatId, {
                delete: {
                    remoteJid: chatId,
                    fromMe: true,
                    id: messageId,
                },
            });

            // Delete from database
            await prisma.message.deleteMany({
                where: { messageId },
            });

            return { success: true, message: 'Message deleted successfully' };
        } catch (error) {
            console.error('Error deleting message:', error);
            throw error;
        }
    }

    async editMessage(instanceId, chatId, messageId, newText) {
        const instance = this.instances.get(instanceId);

        if (!instance || !instance.socket) {
            throw new Error('Instance not found or not connected');
        }

        const { socket } = instance;

        try {
            await socket.sendMessage(chatId, {
                text: newText,
                edit: { id: messageId },
            });

            return { success: true, message: 'Message edited successfully' };
        } catch (error) {
            console.error('Error editing message:', error);
            throw error;
        }
    }

    async pinMessage(instanceId, chatId, messageId) {
        // This method is not available in Baileys
        throw new Error('Pin message method is not available');
    }

    async unpinMessage(instanceId, chatId, messageId) {
        // This method is not available in Baileys
        throw new Error('Unpin message method is not available');
    }

    async archiveChat(instanceId, chatId) {
        const instance = this.instances.get(instanceId);

        if (!instance || !instance.socket) {
            throw new Error('Instance not found or not connected');
        }

        const { socket } = instance;

        try {
            await socket.chatModify({
                chatId,
                archive: true,
            });

            return { success: true, message: 'Chat archived successfully' };
        } catch (error) {
            console.error('Error archiving chat:', error);
            throw error;
        }
    }

    async unarchiveChat(instanceId, chatId) {
        const instance = this.instances.get(instanceId);

        if (!instance || !instance.socket) {
            throw new Error('Instance not found or not connected');
        }

        const { socket } = instance;

        try {
            await socket.chatModify({
                chatId,
                archive: false,
            });

            return { success: true, message: 'Chat unarchived successfully' };
        } catch (error) {
            console.error('Error unarchiving chat:', error);
            throw error;
        }
    }

    async unreadChat(instanceId, chatId) {
        // This method is not available in Baileys
        throw new Error('Unread chat method is not available');
    }

    // Additional Webhook Handlers
    async handleCallEvents(instanceId, callEvents) {
        try {
            for (const call of callEvents) {
                const callData = {
                    callId: call.id,
                    from: call.from,
                    fromName: call.pushName || (call.from || '').split('@')[0],
                    isVideo: call.isVideo || false,
                    isGroup: call.isGroup || false,
                    timestamp: new Date().toISOString(),
                };

                if (call.status === 'offer') {
                    // Incoming call
                    await webhookService.triggerCallReceived(instanceId, callData);
                    console.log(`Call received from ${call.from}`);
                } else if (call.status === 'accept') {
                    // Call accepted
                    await webhookService.triggerCallAccepted(instanceId, callData);
                    console.log(`Call accepted from ${call.from}`);
                } else if (call.status === 'reject' || call.status === 'timeout') {
                    // Call rejected or timeout
                    callData.reason = call.status;
                    await webhookService.triggerCallRejected(instanceId, callData);
                    console.log(`Call ${call.status} from ${call.from}`);
                }
            }
        } catch (error) {
            console.error('Error handling call events:', error);
        }
    }

    async handleLabelEvents(instanceId, labelUpdate) {
        try {
            const { id, name, color, deleted } = labelUpdate;

            if (deleted) {
                // Label deleted
                await webhookService.triggerLabelDeleted(instanceId, {
                    labelId: id,
                    labelName: name,
                    timestamp: new Date().toISOString(),
                });
                console.log(`Label deleted: ${name}`);
            } else {
                // Label created or updated
                const action = labelUpdate.new ? 'created' : 'updated';
                await webhookService.triggerLabelUpsert(instanceId, {
                    labelId: id,
                    labelName: name,
                    labelColor: color || '#000000',
                    action,
                    timestamp: new Date().toISOString(),
                });
                console.log(`Label ${action}: ${name}`);
            }
        } catch (error) {
            console.error('Error handling label events:', error);
        }
    }

    async handleLabelAssociation(instanceId, labelAssociation) {
        try {
            const { chatId, labelId, type } = labelAssociation;
            const prisma = database.getInstance();

            // Get chat name
            const chat = await prisma.chat.findUnique({
                where: {
                    instanceId_chatId: {
                        instanceId,
                        chatId,
                    },
                },
            });

            const chatName = chat?.name || (chatId || '').split('@')[0];

            if (type === 'add') {
                // Label added to chat
                await webhookService.triggerLabelChatAdded(instanceId, {
                    labelId,
                    labelName: labelId, // In real scenario, fetch label name
                    chatId,
                    chatName,
                    timestamp: new Date().toISOString(),
                });
                console.log(`Label ${labelId} added to chat ${chatId}`);
            } else if (type === 'remove') {
                // Label removed from chat
                await webhookService.triggerLabelChatDeleted(instanceId, {
                    labelId,
                    labelName: labelId,
                    chatId,
                    chatName,
                    timestamp: new Date().toISOString(),
                });
                console.log(`Label ${labelId} removed from chat ${chatId}`);
            }
        } catch (error) {
            console.error('Error handling label association:', error);
        }
    }

    // Group Webhook Handlers
    async handleGroupUpdate(instanceId, updates) {
        try {
            for (const update of updates) {
                const groupId = update.id;
                const instance = this.instances.get(instanceId);

                if (!instance || !instance.socket) continue;

                // Get group metadata
                try {
                    const groupMetadata = await instance.socket.groupMetadata(groupId);

                    // Trigger group.v2.update webhook
                    await webhookService.triggerGroupUpdate(instanceId, {
                        groupId,
                        groupName: groupMetadata.subject,
                        updates: {
                            subject: update.subject,
                            desc: update.desc,
                            announce: update.announce,
                            restrict: update.restrict,
                        },
                        updatedBy: update.author || 'unknown',
                        timestamp: new Date().toISOString(),
                    });

                    console.log(`Group ${groupId} updated`);
                } catch (error) {
                    console.error(`Error getting group metadata for ${groupId}:`, error);
                }
            }
        } catch (error) {
            console.error('Error handling group update:', error);
        }
    }

    async handleGroupParticipantsUpdate(instanceId, update) {
        try {
            const { id: groupId, participants, action, author } = update;
            const instance = this.instances.get(instanceId);

            if (!instance || !instance.socket) return;

            // Get group metadata
            try {
                const groupMetadata = await instance.socket.groupMetadata(groupId);

                // Determine which webhook to trigger based on action
                switch (action) {
                    case 'add':
                        // Trigger group.v2.join webhook
                        await webhookService.triggerGroupJoin(instanceId, {
                            groupId,
                            groupName: groupMetadata.subject,
                            participants: participants,
                            addedBy: author || 'unknown',
                            timestamp: new Date().toISOString(),
                        });
                        console.log(`Participants added to group ${groupId}:`, participants);
                        break;

                    case 'remove':
                        // Trigger group.v2.leave webhook
                        await webhookService.triggerGroupLeave(instanceId, {
                            groupId,
                            groupName: groupMetadata.subject,
                            participants: participants,
                            removedBy: author || 'unknown',
                            reason: 'removed',
                            timestamp: new Date().toISOString(),
                        });
                        console.log(`Participants removed from group ${groupId}:`, participants);
                        break;

                    case 'promote':
                    case 'demote':
                        // Trigger group.v2.participants webhook
                        await webhookService.triggerGroupParticipants(instanceId, {
                            groupId,
                            groupName: groupMetadata.subject,
                            action: action,
                            participants: participants,
                            actor: author || 'unknown',
                            timestamp: new Date().toISOString(),
                        });
                        console.log(`Participants ${action}d in group ${groupId}:`, participants);
                        break;

                    default:
                        // For any other action, trigger generic participants webhook
                        await webhookService.triggerGroupParticipants(instanceId, {
                            groupId,
                            groupName: groupMetadata.subject,
                            action: action,
                            participants: participants,
                            actor: author || 'unknown',
                            timestamp: new Date().toISOString(),
                        });
                        console.log(`Group ${groupId} participants action ${action}:`, participants);
                }
            } catch (error) {
                console.error(`Error getting group metadata for ${groupId}:`, error);
            }
        } catch (error) {
            console.error('Error handling group participants update:', error);
        }
    }
}

module.exports = new WhatsAppService();
