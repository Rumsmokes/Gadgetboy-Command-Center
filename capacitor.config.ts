import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.gadgetboy.pos',
  appName: 'GadgetBoy POS',
  webDir: 'dist-mobile',
  android: {
    backgroundColor: '#09090b',
  },
  plugins: {
    LocalNotifications: {
      smallIcon: 'gbpos_notification_icon',
      iconColor: '#BC13FE',
    },
    PushNotifications: {
      presentationOptions: ['badge', 'sound', 'alert'],
    },
  },
};

export default config;
