const database = require('../config/database');
const whatsappService = require('./whatsappService');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs').promises;
const config = require('../config/config');

class SessionManager {
  constructor() {
    this.sessions = new Map();
  }

  async createInstance(data) {
    const prisma = database.getInstance();

    try {
      // Create instance in database
      const instance = await prisma.instance.create({
        data: {
          id: data.id || uuidv4(),
          name: data.name,
          phoneNumber: data.phoneNumber,
          webhookUrl: data.webhookUrl || null,
          status: 'disconnected'
        }
      });

      // Initialize WhatsApp connection
      await whatsappService.init(instance.id);

      // Store in memory
      this.sessions.set(instance.id, {
        id: instance.id,
        name: instance.name,
        phoneNumber: instance.phoneNumber,
        createdAt: instance.createdAt
      });

      return instance;
    } catch (error) {
      console.error('Error creating instance:', error);
      throw error;
    }
  }

  async deleteInstance(instanceId) {
    const prisma = database.getInstance();
    
    try {
      // Delete from WhatsApp service
      await whatsappService.deleteInstance(instanceId);
      
      // Delete from database
      await prisma.instance.delete({
        where: { id: instanceId }
      });
      
      // Remove from memory
      this.sessions.delete(instanceId);
      
      return { success: true, message: 'Instance deleted successfully' };
    } catch (error) {
      console.error('Error deleting instance:', error);
      throw error;
    }
  }

  async getInstance(instanceId) {
    const prisma = database.getInstance();
    
    try {
      const instance = await prisma.instance.findUnique({
        where: { id: instanceId },
        include: {
          _count: {
            select: {
              messages: true,
              chats: true
            }
          }
        }
      });
      
      if (!instance) {
        throw new Error('Instance not found');
      }
      
      // Get real-time status from WhatsApp service
      const status = whatsappService.getInstanceStatus(instanceId);
      const whatsappInstance = whatsappService.getInstance(instanceId);
      
      return {
        ...instance,
        status,
        qrCode: whatsappInstance?.qr || instance.qrCode,
        info: whatsappInstance?.info || null
      };
    } catch (error) {
      console.error('Error getting instance:', error);
      throw error;
    }
  }

  async getAllInstances() {
    const prisma = database.getInstance();
    
    try {
      const instances = await prisma.instance.findMany({
        where: { isActive: true },
        include: {
          _count: {
            select: {
              messages: true,
              chats: true
            }
          }
        }
      });
      
      // Add real-time status
      return instances.map(instance => {
        const status = whatsappService.getInstanceStatus(instance.id);
        const whatsappInstance = whatsappService.getInstance(instance.id);
        
        return {
          ...instance,
          status,
          qrCode: status === 'qr' ? (whatsappInstance?.qr || instance.qrCode) : null,
          info: whatsappInstance?.info || null
        };
      });
    } catch (error) {
      console.error('Error getting all instances:', error);
      throw error;
    }
  }

  async updateInstance(instanceId, data) {
    const prisma = database.getInstance();
    
    try {
      const instance = await prisma.instance.update({
        where: { id: instanceId },
        data: {
          name: data.name,
          webhookUrl: data.webhookUrl
        }
      });
      
      return instance;
    } catch (error) {
      console.error('Error updating instance:', error);
      throw error;
    }
  }

  async restoreSession(instanceId) {
    const prisma = database.getInstance();
    
    try {
      // Get session from database
      const session = await prisma.session.findUnique({
        where: { instanceId }
      });
      
      if (!session) {
        throw new Error('No saved session found');
      }
      
      // Restore session files
      const path = require('path');
      const fs = require('fs').promises;
      const config = require('../config/config');
      
      const sessionPath = path.join(config.whatsapp.sessionPath, instanceId);
      await fs.mkdir(sessionPath, { recursive: true });
      
      const sessionData = JSON.parse(session.sessionData);
      
      for (const [filename, content] of Object.entries(sessionData)) {
        const filePath = path.join(sessionPath, filename);
        await fs.writeFile(filePath, JSON.stringify(content));
      }
      
      // Initialize WhatsApp connection
      await whatsappService.init(instanceId);
      
      return { success: true, message: 'Session restored successfully' };
    } catch (error) {
      console.error('Error restoring session:', error);
      throw error;
    }
  }

  async initializeAllSessions() {
    const prisma = database.getInstance();
    
    try {
      // Get all active instances
      const instances = await prisma.instance.findMany({
        where: { isActive: true }
      });
      
      console.log(`Initializing ${instances.length} sessions...`);
      
      // Initialize each instance
      for (const instance of instances) {
        try {
          // Check if session exists
          const session = await prisma.session.findUnique({
            where: { instanceId: instance.id }
          });
          
          if (session) {
            await this.restoreSession(instance.id);
          } else {
            await whatsappService.init(instance.id);
          }
          
          this.sessions.set(instance.id, {
            id: instance.id,
            name: instance.name,
            createdAt: instance.createdAt
          });
        } catch (error) {
          console.error(`Failed to initialize instance ${instance.id}:`, error);
        }
      }
      
      console.log('All sessions initialized');
    } catch (error) {
      console.error('Error initializing sessions:', error);
    }
  }

  async getInstanceQR(instanceId) {
    let whatsappInstance = whatsappService.getInstance(instanceId);

    // If instance doesn't exist, doesn't have a socket, or socket is not connected, reinitialize
    const needsReinit = !whatsappInstance || 
                        !whatsappInstance.socket || 
                        (whatsappInstance.socket && !whatsappInstance.socket.user);

    if (needsReinit) {
      console.log(`Reinitializing instance ${instanceId} for QR code request`);
      
      // Remove existing instance from memory to ensure clean reinitialize
      // Don't use deleteInstance as it will logout, just remove from memory
      whatsappService.removeInstanceFromMemory(instanceId);
      
      // Delete session files to force QR code generation
      const sessionPath = path.join(config.whatsapp.sessionPath, instanceId);
      try {
        await fs.rmdir(sessionPath, { recursive: true });
        console.log(`Session files deleted for instance ${instanceId}`);
      } catch (err) {
        // Ignore error if directory doesn't exist
        if (err.code !== 'ENOENT') {
          console.error(`Failed to delete session files for ${instanceId}:`, err);
        }
      }
      
      // Wait a moment for cleanup
      await new Promise(resolve => setTimeout(resolve, 500));
      
      // Reinitialize
      await whatsappService.init(instanceId);
      
      // Wait a moment for socket to initialize and connection.update event to fire
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      whatsappInstance = whatsappService.getInstance(instanceId);

      if (!whatsappInstance) {
        throw new Error('Failed to initialize instance');
      }
    }

    // Wait for QR code to be generated
    // QR code comes from connection.update event which may take a moment
    let attempts = 0;
    const maxAttempts = 60; // Wait up to 60 seconds for QR code
    
    console.log(`Waiting for QR code generation for instance ${instanceId}...`);
    
    while (!whatsappInstance.qr && attempts < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      whatsappInstance = whatsappService.getInstance(instanceId);
      attempts++;
      
      // Log progress every 10 seconds
      if (attempts % 10 === 0) {
        console.log(`Still waiting for QR code... (${attempts}/${maxAttempts} seconds)`);
      }
      
      // Check if socket is still valid
      if (whatsappInstance && whatsappInstance.socket && whatsappInstance.socket.user) {
        throw new Error('Instance is already connected. Cannot generate QR code for connected instance.');
      }
    }

    if (!whatsappInstance.qr) {
      throw new Error('QR code not available. Instance may already be connected or failed to generate QR. Please try restarting the instance.');
    }

    console.log(`QR code generated successfully for instance ${instanceId}`);
    return whatsappInstance.qr;
  }

  async getInstanceInfo(instanceId) {
    const whatsappInstance = whatsappService.getInstance(instanceId);
    
    if (!whatsappInstance) {
      throw new Error('Instance not found');
    }
    
    if (!whatsappInstance.info) {
      throw new Error('Instance not connected');
    }
    
    return whatsappInstance.info;
  }
}

module.exports = new SessionManager();
