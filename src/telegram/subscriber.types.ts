export interface TelegramSubscriber {
  chatId: string;
  firstName?: string;
  username?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TelegramUpdateState {
  offset: number;
}
