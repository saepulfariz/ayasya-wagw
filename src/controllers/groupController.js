const whatsappService = require('../services/whatsappService');
const database = require('../config/database');

// Get list of groups
exports.getGroups = async (req, res, next) => {
    try {
        const { instanceId } = req.params;
        const instance = whatsappService.getInstance(instanceId);

        if (!instance || !instance.socket) {
            return res.status(404).json({
                success: false,
                error: 'Instance not found or not connected',
            });
        }

        const { socket } = instance;

        const groups = await socket.groupFetchAllParticipating();

        res.json({
            success: true,
            data: groups || [],
            count: groups?.length || 0,
        });
    } catch (error) {
        console.error('Error getting groups:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to get groups',
            details: error.message,
        });
    }
};

// Create new groups
exports.createGroup = async (req, res, next) => {
    try {
        const { instanceId } = req.params;
        const { name, participants } = req.body;

        if (!name) {
            return res.status(400).json({
                success: false,
                error: 'Group name is required',
            });
        }

        if (!Array.isArray(participants) || participants.length === 0) {
            return res.status(400).json({
                success: false,
                error: 'Participants must be a non-empty array of IDs',
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

        // Format nomor WhatsApp
        const formattedParticipants = participants
            .map((p) => {
                if (typeof p !== 'string') return null; // skip invalid
                const to = p.trim();
                if (!to) return null;
                return to.includes('@') ? to : `${to}@s.whatsapp.net`;
            })
            .filter(Boolean); // hapus null / kosong

        if (formattedParticipants.length === 0) {
            return res.status(400).json({
                success: false,
                error: 'All participant IDs are invalid or empty',
            });
        }

        const result = await socket.groupCreate(name, formattedParticipants);

        res.json({
            success: true,
            data: result || [],
        });
    } catch (error) {
        console.error('Error create groups:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to create groups',
            details: error.message,
        });
    }
};

// Group join info
exports.getJoinInfoGroup = async (req, res, next) => {
    try {
        const { instanceId } = req.params;
        let { code } = req.query;

        if (!code) {
            return res.status(400).json({
                success: false,
                error: 'Group code is required',
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

        // Sanitasi: trim & parse jika user mengirim URL penuh
        code = String(code).trim();
        if (/chat\.whatsapp\.com/i.test(code) || code.includes('/')) {
            const parts = code.split('/');
            const last = parts.pop() || parts.pop(); // handle trailing slash
            code = (last || '').trim();
        }

        const result = await socket.groupGetInviteInfo(code);

        res.json({
            success: true,
            data: result || [],
        });
    } catch (error) {
        console.error('Error info groups:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to info groups',
            details: error.message,
        });
    }
};

// Join group via code
exports.joinGroup = async (req, res, next) => {
    try {
        const { instanceId } = req.params;
        let { code } = req.body;

        if (!code) {
            return res.status(400).json({
                success: false,
                error: 'Group code is required',
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

        // Sanitasi: trim & parse jika user mengirim URL penuh
        code = String(code).trim();
        if (/chat\.whatsapp\.com/i.test(code) || code.includes('/')) {
            const parts = code.split('/');
            const last = parts.pop() || parts.pop(); // handle trailing slash
            code = (last || '').trim();
        }

        const result = await socket.groupAcceptInvite(code);

        res.json({
            success: true,
            data: result || [],
        });
    } catch (error) {
        console.error('Error accept code groups:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to accept code groups',
            details: error.message,
        });
    }
};

// Get groups count
exports.getGroupsCount = async (req, res, next) => {
    try {
        const { instanceId } = req.params;
        const instance = whatsappService.getInstance(instanceId);

        if (!instance || !instance.socket) {
            return res.status(404).json({
                success: false,
                error: 'Instance not found or not connected',
            });
        }

        const { socket } = instance;
        const groups = await socket.groupFetchAllParticipating();

        res.json({
            success: true,
            count: Object.keys(groups || {}).length,
        });
    } catch (error) {
        console.error('Error getting groups count:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to get groups count',
            details: error.message,
        });
    }
};

// Get group by ID
exports.getGroupById = async (req, res, next) => {
    try {
        const { instanceId, groupId } = req.params;
        const instance = whatsappService.getInstance(instanceId);

        if (!instance || !instance.socket) {
            return res.status(404).json({
                success: false,
                error: 'Instance not found or not connected',
            });
        }

        const { socket } = instance;

        // Format group ID
        const formattedGroupId = groupId.includes('@') ? groupId : `${groupId}@g.us`;

        // Get group metadata
        const metadata = await socket.groupMetadata(formattedGroupId);

        res.json({
            success: true,
            data: metadata,
        });
    } catch (error) {
        console.error('Error getting group by ID:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to get group',
            details: error.message,
        });
    }
};

// Leave group
exports.leaveGroup = async (req, res, next) => {
    try {
        const { instanceId, groupId } = req.params;
        const instance = whatsappService.getInstance(instanceId);

        if (!instance || !instance.socket) {
            return res.status(404).json({
                success: false,
                error: 'Instance not found or not connected',
            });
        }

        const { socket } = instance;

        // Format group ID
        const formattedGroupId = groupId.includes('@') ? groupId : `${groupId}@g.us`;

        await socket.groupLeave(formattedGroupId);

        res.json({
            success: true,
            message: 'Left group successfully',
        });
    } catch (error) {
        console.error('Error leaving group:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to leave group',
            details: error.message,
        });
    }
};

// Get group picture
exports.getGroupPicture = async (req, res, next) => {
    try {
        const { instanceId, groupId } = req.params;
        const instance = whatsappService.getInstance(instanceId);

        if (!instance || !instance.socket) {
            return res.status(404).json({
                success: false,
                error: 'Instance not found or not connected',
            });
        }

        const { socket } = instance;

        // Format group ID
        const formattedGroupId = groupId.includes('@') ? groupId : `${groupId}@g.us`;

        const pictureUrl = await socket.profilePictureUrl(formattedGroupId, 'image');

        res.json({
            success: true,
            data: {
                pictureUrl: pictureUrl || null,
            },
        });
    } catch (error) {
        console.error('Error getting group picture:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to get group picture',
            details: error.message,
        });
    }
};

// Set group picture
exports.setGroupPicture = async (req, res, next) => {
    try {
        const { instanceId, groupId } = req.params;
        const { imageUrl } = req.body;

        if (!imageUrl) {
            return res.status(400).json({
                success: false,
                error: 'Image URL is required',
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

        // Format group ID
        const formattedGroupId = groupId.includes('@') ? groupId : `${groupId}@g.us`;

        // Download image and set as group picture
        const axios = require('axios');
        const response = await axios.get(imageUrl, {
            responseType: 'arraybuffer',
        });
        const buffer = Buffer.from(response.data);

        await socket.updateProfilePicture(formattedGroupId, buffer);

        res.json({
            success: true,
            message: 'Group picture updated successfully',
        });
    } catch (error) {
        console.error('Error setting group picture:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to set group picture',
            details: error.message,
        });
    }
};

// Delete group picture
exports.deleteGroupPicture = async (req, res, next) => {
    try {
        const { instanceId, groupId } = req.params;
        const instance = whatsappService.getInstance(instanceId);

        if (!instance || !instance.socket) {
            return res.status(404).json({
                success: false,
                error: 'Instance not found or not connected',
            });
        }

        const { socket } = instance;

        // Format group ID
        const formattedGroupId = groupId.includes('@') ? groupId : `${groupId}@g.us`;

        await socket.removeProfilePicture(formattedGroupId);

        res.json({
            success: true,
            message: 'Group picture deleted successfully',
        });
    } catch (error) {
        console.error('Error deleting group picture:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to delete group picture',
            details: error.message,
        });
    }
};

// Update group description
exports.updateGroupDescription = async (req, res, next) => {
    try {
        const { instanceId, groupId } = req.params;
        const { description } = req.body;

        if (description === undefined) {
            return res.status(400).json({
                success: false,
                error: 'Description is required',
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

        // Format group ID
        const formattedGroupId = groupId.includes('@') ? groupId : `${groupId}@g.us`;

        await socket.groupUpdateDescription(formattedGroupId, description);

        res.json({
            success: true,
            message: 'Group description updated successfully',
        });
    } catch (error) {
        console.error('Error updating group description:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to update group description',
            details: error.message,
        });
    }
};

// Update group subject (name)
exports.updateGroupSubject = async (req, res, next) => {
    try {
        const { instanceId, groupId } = req.params;
        const { subject } = req.body;

        if (!subject) {
            return res.status(400).json({
                success: false,
                error: 'Subject is required',
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

        // Format group ID
        const formattedGroupId = groupId.includes('@') ? groupId : `${groupId}@g.us`;

        await socket.groupUpdateSubject(formattedGroupId, subject);

        res.json({
            success: true,
            message: 'Group subject updated successfully',
        });
    } catch (error) {
        console.error('Error updating group subject:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to update group subject',
            details: error.message,
        });
    }
};

// Update group settings - info admin only
exports.updateGroupSettingsInfoAdminOnly = async (req, res, next) => {
    try {
        const { instanceId, groupId } = req.params;
        const { restrict } = req.body;

        if (typeof restrict !== 'boolean') {
            return res.status(400).json({
                success: false,
                error: 'restrict must be a boolean value',
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

        // Format group ID
        const formattedGroupId = groupId.includes('@') ? groupId : `${groupId}@g.us`;

        await socket.groupSettingUpdate(formattedGroupId, restrict ? 'locked' : 'unlocked');

        res.json({
            success: true,
            message: 'Group info settings updated successfully',
            data: {
                restrict: restrict,
            },
        });
    } catch (error) {
        console.error('Error updating group info settings:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to update group info settings',
            details: error.message,
        });
    }
};

// Get group settings - info admin only
exports.getGroupSettingsInfoAdminOnly = async (req, res, next) => {
    try {
        const { instanceId, groupId } = req.params;
        const instance = whatsappService.getInstance(instanceId);

        if (!instance || !instance.socket) {
            return res.status(404).json({
                success: false,
                error: 'Instance not found or not connected',
            });
        }

        const { socket } = instance;

        // Format group ID
        const formattedGroupId = groupId.includes('@') ? groupId : `${groupId}@g.us`;

        const metadata = await socket.groupMetadata(formattedGroupId);

        res.json({
            success: true,
            data: {
                restrict: metadata.restrict || false,
            },
        });
    } catch (error) {
        console.error('Error getting group info settings:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to get group info settings',
            details: error.message,
        });
    }
};

// Update group settings - messages admin only
exports.updateGroupSettingsMessagesAdminOnly = async (req, res, next) => {
    try {
        const { instanceId, groupId } = req.params;
        const { announce } = req.body;

        if (typeof announce !== 'boolean') {
            return res.status(400).json({
                success: false,
                error: 'announce must be a boolean value',
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

        // Format group ID
        const formattedGroupId = groupId.includes('@') ? groupId : `${groupId}@g.us`;

        await socket.groupSettingUpdate(formattedGroupId, announce ? 'announcement' : 'not_announcement');

        res.json({
            success: true,
            message: 'Group message settings updated successfully',
            data: {
                announce: announce,
            },
        });
    } catch (error) {
        console.error('Error updating group message settings:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to update group message settings',
            details: error.message,
        });
    }
};

// Get group settings - messages admin only
exports.getGroupSettingsMessagesAdminOnly = async (req, res, next) => {
    try {
        const { instanceId, groupId } = req.params;
        const instance = whatsappService.getInstance(instanceId);

        if (!instance || !instance.socket) {
            return res.status(404).json({
                success: false,
                error: 'Instance not found or not connected',
            });
        }

        const { socket } = instance;

        // Format group ID
        const formattedGroupId = groupId.includes('@') ? groupId : `${groupId}@g.us`;

        const metadata = await socket.groupMetadata(formattedGroupId);

        res.json({
            success: true,
            data: {
                announce: metadata.announce || false,
            },
        });
    } catch (error) {
        console.error('Error getting group message settings:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to get group message settings',
            details: error.message,
        });
    }
};

// Get group invite code
exports.getGroupInviteCode = async (req, res, next) => {
    try {
        const { instanceId, groupId } = req.params;
        const instance = whatsappService.getInstance(instanceId);

        if (!instance || !instance.socket) {
            return res.status(404).json({
                success: false,
                error: 'Instance not found or not connected',
            });
        }

        const { socket } = instance;

        // Format group ID
        const formattedGroupId = groupId.includes('@') ? groupId : `${groupId}@g.us`;

        const inviteCode = await socket.groupInviteCode(formattedGroupId);

        res.json({
            success: true,
            data: {
                inviteCode: inviteCode,
                inviteUrl: `https://chat.whatsapp.com/${inviteCode}`,
            },
        });
    } catch (error) {
        console.error('Error getting group invite code:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to get group invite code',
            details: error.message,
        });
    }
};

// Revoke group invite code
exports.revokeGroupInviteCode = async (req, res, next) => {
    try {
        const { instanceId, groupId } = req.params;
        const instance = whatsappService.getInstance(instanceId);

        if (!instance || !instance.socket) {
            return res.status(404).json({
                success: false,
                error: 'Instance not found or not connected',
            });
        }

        const { socket } = instance;

        // Format group ID
        const formattedGroupId = groupId.includes('@') ? groupId : `${groupId}@g.us`;

        const newInviteCode = await socket.groupRevokeInvite(formattedGroupId);

        res.json({
            success: true,
            message: 'Group invite code revoked successfully',
            data: {
                inviteCode: newInviteCode,
                inviteUrl: `https://chat.whatsapp.com/${newInviteCode}`,
            },
        });
    } catch (error) {
        console.error('Error revoking group invite code:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to revoke group invite code',
            details: error.message,
        });
    }
};

// Get group participants
exports.getGroupParticipants = async (req, res, next) => {
    try {
        const { instanceId, groupId } = req.params;
        const instance = whatsappService.getInstance(instanceId);

        if (!instance || !instance.socket) {
            return res.status(404).json({
                success: false,
                error: 'Instance not found or not connected',
            });
        }

        const { socket } = instance;

        // Format group ID
        const formattedGroupId = groupId.includes('@') ? groupId : `${groupId}@g.us`;

        const metadata = await socket.groupMetadata(formattedGroupId);

        res.json({
            success: true,
            data: {
                participants: metadata.participants || [],
                count: metadata.participants?.length || 0,
            },
        });
    } catch (error) {
        console.error('Error getting group participants:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to get group participants',
            details: error.message,
        });
    }
};

// Add participants to group
exports.addGroupParticipants = async (req, res, next) => {
    try {
        const { instanceId, groupId } = req.params;
        const { participants } = req.body;

        if (!Array.isArray(participants) || participants.length === 0) {
            return res.status(400).json({
                success: false,
                error: 'Participants must be a non-empty array',
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

        // Format group ID
        const formattedGroupId = groupId.includes('@') ? groupId : `${groupId}@g.us`;

        // Format participants
        const formattedParticipants = participants
            .map((p) => {
                if (typeof p !== 'string') return null;
                const participant = p.trim();
                if (!participant) return null;
                return participant.includes('@') ? participant : `${participant}@s.whatsapp.net`;
            })
            .filter(Boolean);

        if (formattedParticipants.length === 0) {
            return res.status(400).json({
                success: false,
                error: 'All participant IDs are invalid or empty',
            });
        }

        const result = await socket.groupParticipantsUpdate(formattedGroupId, formattedParticipants, 'add');

        res.json({
            success: true,
            message: 'Participants added successfully',
            data: result,
        });
    } catch (error) {
        console.error('Error adding group participants:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to add group participants',
            details: error.message,
        });
    }
};

// Remove participants from group
exports.removeGroupParticipants = async (req, res, next) => {
    try {
        const { instanceId, groupId } = req.params;
        const { participants } = req.body;

        if (!Array.isArray(participants) || participants.length === 0) {
            return res.status(400).json({
                success: false,
                error: 'Participants must be a non-empty array',
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

        // Format group ID
        const formattedGroupId = groupId.includes('@') ? groupId : `${groupId}@g.us`;

        // Format participants
        const formattedParticipants = participants
            .map((p) => {
                if (typeof p !== 'string') return null;
                const participant = p.trim();
                if (!participant) return null;
                return participant.includes('@') ? participant : `${participant}@s.whatsapp.net`;
            })
            .filter(Boolean);

        if (formattedParticipants.length === 0) {
            return res.status(400).json({
                success: false,
                error: 'All participant IDs are invalid or empty',
            });
        }

        const result = await socket.groupParticipantsUpdate(formattedGroupId, formattedParticipants, 'remove');

        res.json({
            success: true,
            message: 'Participants removed successfully',
            data: result,
        });
    } catch (error) {
        console.error('Error removing group participants:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to remove group participants',
            details: error.message,
        });
    }
};

// Promote participants to admin
exports.promoteGroupParticipants = async (req, res, next) => {
    try {
        const { instanceId, groupId } = req.params;
        const { participants } = req.body;

        if (!Array.isArray(participants) || participants.length === 0) {
            return res.status(400).json({
                success: false,
                error: 'Participants must be a non-empty array',
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

        // Format group ID
        const formattedGroupId = groupId.includes('@') ? groupId : `${groupId}@g.us`;

        // Format participants
        const formattedParticipants = participants
            .map((p) => {
                if (typeof p !== 'string') return null;
                const participant = p.trim();
                if (!participant) return null;
                return participant.includes('@') ? participant : `${participant}@s.whatsapp.net`;
            })
            .filter(Boolean);

        if (formattedParticipants.length === 0) {
            return res.status(400).json({
                success: false,
                error: 'All participant IDs are invalid or empty',
            });
        }

        const result = await socket.groupParticipantsUpdate(formattedGroupId, formattedParticipants, 'promote');

        res.json({
            success: true,
            message: 'Participants promoted to admin successfully',
            data: result,
        });
    } catch (error) {
        console.error('Error promoting group participants:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to promote group participants',
            details: error.message,
        });
    }
};

// Demote participants from admin
exports.demoteGroupParticipants = async (req, res, next) => {
    try {
        const { instanceId, groupId } = req.params;
        const { participants } = req.body;

        if (!Array.isArray(participants) || participants.length === 0) {
            return res.status(400).json({
                success: false,
                error: 'Participants must be a non-empty array',
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

        // Format group ID
        const formattedGroupId = groupId.includes('@') ? groupId : `${groupId}@g.us`;

        // Format participants
        const formattedParticipants = participants
            .map((p) => {
                if (typeof p !== 'string') return null;
                const participant = p.trim();
                if (!participant) return null;
                return participant.includes('@') ? participant : `${participant}@s.whatsapp.net`;
            })
            .filter(Boolean);

        if (formattedParticipants.length === 0) {
            return res.status(400).json({
                success: false,
                error: 'All participant IDs are invalid or empty',
            });
        }

        const result = await socket.groupParticipantsUpdate(formattedGroupId, formattedParticipants, 'demote');

        res.json({
            success: true,
            message: 'Participants demoted from admin successfully',
            data: result,
        });
    } catch (error) {
        console.error('Error demoting group participants:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to demote group participants',
            details: error.message,
        });
    }
};
