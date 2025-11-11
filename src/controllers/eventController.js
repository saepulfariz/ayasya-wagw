const whatsappService = require('../services/whatsappService');

exports.sendEvent = async (req, res, next) => {
    try {
        const { instanceId } = req.params;
        const { to, name, description, location, startTime, endTime, callLink } = req.body;

        // Validate required fields
        if (!to) {
            return res.status(400).json({
                success: false,
                error: 'Recipient phone number (to) is required',
            });
        }

        if (!name) {
            return res.status(400).json({
                success: false,
                error: 'Event name is required',
            });
        }

        if (!startTime) {
            return res.status(400).json({
                success: false,
                error: 'Event start time is required',
            });
        }

        const instance = whatsappService.getInstance(instanceId);

        if (!instance || !instance.socket) {
            return res.status(404).json({
                success: false,
                error: 'Instance not found or not connected',
            });
        }

        const { socket } = instance;

        // Format recipient
        const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`;

        // Create event message as formatted text
        let messageText = `📅 *${name}*\n\n`;
        if (description) messageText += `📝 Description: ${description}\n\n`;
        if (location) {
            messageText += `📍 Location: ${location.name || ''}\n`;
            if (location.address) messageText += `Address: ${location.address}\n`;
            messageText += '\n';
        }
        messageText += `🕐 Start: ${new Date(startTime).toLocaleString()}\n`;
        if (endTime) messageText += `🕐 End: ${new Date(endTime).toLocaleString()}\n`;
        if (callLink) messageText += `\n🔗 Join Call: ${callLink}`;

        // Send text message
        const result = await socket.sendMessage(jid, { text: messageText });

        res.json({
            success: true,
            message: 'Event message sent successfully',
            data: result,
        });
    } catch (error) {
        console.error('Error sending event message:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to send event message',
            details: error.message,
        });
    }
};
