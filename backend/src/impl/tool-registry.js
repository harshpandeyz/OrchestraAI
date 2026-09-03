'use strict';

const { ToolRegistry } = require('../interfaces');
const { EventType } = require('../core/types');
const { generateId, now } = require('../state/runtime-state');

class InMemoryToolRegistry extends ToolRegistry {
  constructor(eventBus = null, options = {}) {
    super();
    this.eventBus = eventBus;
    this.tools = new Map();
    this.config = {
      ...options
    };
  }

  async getTools() {
    return Array.from(this.tools.values());
  }

  async getTool(name) {
    return this.tools.get(name) || null;
  }

  async registerTool(tool) {
    const newTool = {
      id: tool.id || generateId('tool'),
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters || { type: 'object', properties: {}, required: [] },
      status: tool.status || 'enabled',
      capabilities: tool.capabilities || [],
      permissions: tool.permissions || [],
      timeoutMs: tool.timeoutMs || 30000,
      costPerCall: tool.costPerCall || 0.001,
      avgLatencyMs: tool.avgLatencyMs || 100,
      successRate: tool.successRate || 1.0,
      registeredAt: now(),
      metadata: tool.metadata || {}
    };
    
    this.tools.set(newTool.name, newTool);
    
    if (this.eventBus) {
      this.eventBus.emit('system', EventType.TOOL_SELECTED, { tool: newTool.name, action: 'registered' });
    }
    
    return newTool;
  }

  async unregisterTool(name) {
    const tool = this.tools.get(name);
    if (!tool) return false;
    
    this.tools.delete(name);
    
    if (this.eventBus) {
      this.eventBus.emit('system', EventType.TOOL_SELECTED, { tool: name, action: 'unregistered' });
    }
    
    return true;
  }

  async updateTool(name, updates) {
    const tool = this.tools.get(name);
    if (!tool) return null;
    
    const updated = { ...tool, ...updates, updatedAt: now() };
    this.tools.set(name, updated);
    
    if (this.eventBus) {
      this.eventBus.emit('system', EventType.TOOL_SELECTED, { tool: name, action: 'updated', updates });
    }
    
    return updated;
  }

  async getToolsByCapability(capability) {
    return Array.from(this.tools.values()).filter(t => t.capabilities.includes(capability));
  }

  async healthCheck(name) {
    const tool = this.tools.get(name);
    if (!tool) return { name, status: 'unknown', healthy: false };
    
    return {
      name,
      status: tool.status,
      healthy: tool.status === 'enabled' && tool.successRate > 0.5,
      successRate: tool.successRate,
      avgLatencyMs: tool.avgLatencyMs
    };
  }

  on(event, handler) {}

  seedTools(tools) {
    for (const tool of tools) {
      this.tools.set(tool.name, {
        ...tool,
        id: tool.id || generateId('tool'),
        registeredAt: tool.registeredAt || now(),
        status: tool.status || 'enabled'
      });
    }
  }
}

module.exports = {
  InMemoryToolRegistry
};