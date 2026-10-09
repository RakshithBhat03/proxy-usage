import { create } from 'zustand';

export type NotificationType = 'success' | 'error' | 'warning' | 'info';

export interface Notification {
  id: string;
  message: string;
  type: NotificationType;
  duration?: number;
}

export const NOTIFICATION_DURATION_MS = 3000;

interface NotificationState {
  notifications: Notification[];
  showNotification: (message: string, type?: NotificationType, duration?: number) => void;
  removeNotification: (id: string) => void;
}

let counter = 0;

export const useNotificationStore = create<NotificationState>((set) => ({
  notifications: [],
  showNotification: (message, type = 'info', duration = NOTIFICATION_DURATION_MS) => {
    counter += 1;
    const id = `${Date.now()}-${counter}`;
    set((state) => ({ notifications: [...state.notifications, { id, message, type, duration }] }));
  },
  removeNotification: (id) =>
    set((state) => ({ notifications: state.notifications.filter((item) => item.id !== id) })),
}));

/** Convenience for non-React code (query error handlers, etc.). */
export const notify = (message: string, type?: NotificationType) =>
  useNotificationStore.getState().showNotification(message, type);
