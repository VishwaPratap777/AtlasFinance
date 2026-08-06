import mongoose, { Schema, Document } from 'mongoose';

export interface IWatchlistItem {
  ticker: string;
  name?: string;
  alertThreshold?: number; // % move to trigger alert
}

export interface IPortfolioHolding {
  ticker: string;
  shares: number;
  costBasis?: number;
  assetType?: 'stock' | 'etf' | 'crypto' | 'other';
}

export interface IGoogleTokens {
  accessToken: string;
  refreshToken: string;
  expiryDate?: number;
  scope?: string;
}

export interface IUserProfile extends Document {
  telegramId: number;
  username?: string;
  firstName?: string;
  role?: 'investor' | 'analyst' | 'founder' | 'student' | 'finance_professional' | 'other';
  sectors: string[];
  watchlist: IWatchlistItem[];
  portfolio: IPortfolioHolding[];
  insightPreferences: ('market_news' | 'earnings' | 'filings' | 'analyst_ratings' | 'macro')[];
  briefingTime?: string; // HH:MM in user's timezone
  briefingTimezone?: string;
  briefingEnabled: boolean;
  customAlerts: { description: string; condition: string; tickers: string[] }[];
  googleTokens?: IGoogleTokens;
  googleConnected: boolean;
  onboardingComplete: boolean;
  onboardingStep: number;
  lastActiveAt: Date;
  createdAt: Date;
  updatedAt: Date;
  // Extra verticals beyond finance
  extraVerticals: string[];
  // Preferences learned over time
  prefersConcise: boolean;
  lastBriefSentAt?: Date;
}

const WatchlistItemSchema = new Schema<IWatchlistItem>({
  ticker: { type: String, required: true, uppercase: true },
  name: String,
  alertThreshold: { type: Number, default: 5 },
});

const PortfolioHoldingSchema = new Schema<IPortfolioHolding>({
  ticker: { type: String, required: true, uppercase: true },
  shares: { type: Number, required: true },
  costBasis: Number,
  assetType: { type: String, enum: ['stock', 'etf', 'crypto', 'other'], default: 'stock' },
});

const GoogleTokensSchema = new Schema<IGoogleTokens>({
  accessToken: { type: String, required: true },
  refreshToken: { type: String, required: true },
  expiryDate: Number,
  scope: String,
});

const UserProfileSchema = new Schema<IUserProfile>(
  {
    telegramId: { type: Number, required: true, unique: true, index: true },
    username: String,
    firstName: String,
    role: {
      type: String,
      enum: ['investor', 'analyst', 'founder', 'student', 'finance_professional', 'other'],
    },
    sectors: { type: [String], default: [] },
    watchlist: { type: [WatchlistItemSchema], default: [] },
    portfolio: { type: [PortfolioHoldingSchema], default: [] },
    insightPreferences: {
      type: [String],
      enum: ['market_news', 'earnings', 'filings', 'analyst_ratings', 'macro'],
      default: ['market_news', 'earnings'],
    },
    briefingTime: { type: String, default: '08:00' },
    briefingTimezone: { type: String, default: 'America/New_York' },
    briefingEnabled: { type: Boolean, default: false },
    customAlerts: {
      type: [
        {
          description: String,
          condition: String,
          tickers: [String],
        },
      ],
      default: [],
    },
    googleTokens: GoogleTokensSchema,
    googleConnected: { type: Boolean, default: false },
    onboardingComplete: { type: Boolean, default: false },
    onboardingStep: { type: Number, default: 0 },
    lastActiveAt: { type: Date, default: Date.now },
    extraVerticals: { type: [String], default: [] },
    prefersConcise: { type: Boolean, default: true },
    lastBriefSentAt: Date,
  },
  {
    timestamps: true,
  }
);

export const UserProfile = mongoose.model<IUserProfile>('UserProfile', UserProfileSchema);
