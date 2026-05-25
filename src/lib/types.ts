// Types for ACP UI application

export interface AgentConfig {
  url: string;
}

export interface AgentSession {
  sessionId: string;
  cwd: string;
  title?: string | null;
  updatedAt?: string | null;
  additionalDirectories?: string[];
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  thought?: string;
  timestamp: number;
  toolCalls?: ToolCallInfo[];
}

export interface ToolCallInfo {
  toolCallId: string;
  title: string;
  kind: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  locations?: { path: string }[];
}

export interface PermissionRequest {
  sessionId: string;
  toolCall: ToolCallInfo;
  options: PermissionOption[];
}

export interface PermissionOption {
  kind: string;
  name: string;
  optionId: string;
}

// Session Modes
export interface SessionMode {
  id: string;
  name: string;
  description?: string;
}

export interface SessionModeState {
  currentModeId: string;
  availableModes: SessionMode[];
}

// Slash Commands
export interface SlashCommand {
  name: string;
  description: string;
  hint?: string;
}

// Models
export interface ModelInfo {
  modelId: string;
  name: string;
  description?: string;
}

export type TrafficDirection = 'in' | 'out';
export type TrafficType = 'request' | 'response' | 'notification';
export type TrafficFilter = 'all' | 'requests' | 'responses' | 'notifications';

export interface TrafficEntry {
  id: string;
  timestamp: number;
  direction: TrafficDirection;
  type: TrafficType;
  method: string;
  requestId?: number | string;
  payload: unknown;
  error?: boolean;
}
