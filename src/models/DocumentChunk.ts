import mongoose, { Schema, Document } from 'mongoose';

export interface IDocumentChunk extends Document {
  telegramId: number;
  documentId: string; // groups chunks from the same upload
  fileName: string;
  chunkIndex: number;
  content: string;
  embedding: number[];
  metadata: {
    source?: string;
    pageNumber?: number;
    uploadedAt: Date;
    fileType: string;
    totalChunks: number;
  };
  createdAt: Date;
}

const DocumentChunkSchema = new Schema<IDocumentChunk>(
  {
    telegramId: { type: Number, required: true, index: true },
    documentId: { type: String, required: true, index: true },
    fileName: { type: String, required: true },
    chunkIndex: { type: Number, required: true },
    content: { type: String, required: true },
    embedding: { type: [Number], required: true },
    metadata: {
      source: String,
      pageNumber: Number,
      uploadedAt: { type: Date, default: Date.now },
      fileType: { type: String, required: true },
      totalChunks: { type: Number, required: true },
    },
  },
  {
    timestamps: true,
  }
);

// Index for efficient per-user document retrieval
DocumentChunkSchema.index({ telegramId: 1, documentId: 1 });
DocumentChunkSchema.index({ telegramId: 1, chunkIndex: 1 });

export const DocumentChunk = mongoose.model<IDocumentChunk>('DocumentChunk', DocumentChunkSchema);
