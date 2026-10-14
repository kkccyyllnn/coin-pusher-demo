/** Presentation metadata; the message remains the first argument for existing consumers. */
export type NotificationMeta = {
  event: string;
  priority: 0 | 1 | 2 | 3;
  tone: 'info' | 'reward' | 'danger' | 'jackpot';
  /** Actual account or reward change, never the nominal requested amount. */
  amount?: number;
  minVisibleSeconds?: number;
};

export type Notify = (message: string, meta?: NotificationMeta) => void;
