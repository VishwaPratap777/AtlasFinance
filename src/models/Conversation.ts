import mongoose, { Schema, Document } from 'mongoose';

export type MessageRole = 'user' | 'assistant' | 'system';

export interface IMessage {
  role: MessageRole;
  content: string;
  timestamp: Date;
  mediaType?: 'text' | 'voice' | 'image' | 'document';
  toolCalls?: { name: string; args: Record<string, unknown>; result?: string }[];
}

export interface IConversation extends Document {
  telegramId: number;
  messages: IMessage[];
  activeDocumentIds: string[]; // RAG document IDs currently in scope
  lastMessageAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const MessageSchema = new Schema<IMessage>(
  {
    role: { type: String, enum: ['user', 'assistant', 'system'], required: true },
    content: { type: String, required: true },
    timestamp: { type: Date, default: Date.now },
    mediaType: { type: String, enum: ['text', 'voice', 'image', 'document'], default: 'text' },
    toolCalls: [
      {
        name: String,
        args: Schema.Types.Mixed,
        result: String,
      },
    ],
  },
  { _id: false }
);

const ConversationSchema = new Schema<IConversation>(
  {
    telegramId: { type: Number, required: true, unique: true, index: true },
    messages: { type: [MessageSchema], default: [] },
    activeDocumentIds: { type: [String], default: [] },
    lastMessageAt: { type: Date, default: Date.now },
  },
  {
    timestamps: true,
  }
);

// Keep only last 50 messages per user to manage context window
ConversationSchema.methods.trimHistory = function (maxMessages = 50) {
  if (this.messages.length > maxMessages) {
    // Always keep the system message (index 0) + last N messages
    const systemMessages = this.messages.filter((m: IMessage) => m.role === 'system');
    const otherMessages = this.messages.filter((m: IMessage) => m.role !== 'system');
    this.messages = [
      ...systemMessages,
      ...otherMessages.slice(-maxMessages),
    ];
  }
};

export const Conversation = mongoose.model<IConversation>('Conversation', ConversationSchema);
