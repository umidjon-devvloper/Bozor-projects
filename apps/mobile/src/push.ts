import * as Application from 'expo-application';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import type { ApiClient } from '@bozorlar/api-client';

/**
 * Registering this device for push.
 *
 * Permission is requested when the app first has something worth sending — not at launch. A
 * prompt shown before somebody has followed a product or placed an order is a prompt they
 * decline, and on iOS a declined prompt cannot be shown again: the app must send the user into
 * Settings, which almost nobody does. Asking late costs a few notifications; asking early costs
 * the channel permanently.
 */
export async function registerForPush(api: ApiClient, locale: string): Promise<void> {
  // A simulator has no push token, and asking for one there throws.
  if (!Device.isDevice) return;

  const existing = await Notifications.getPermissionsAsync();
  const granted =
    existing.granted ||
    existing.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL;

  const decision = granted ? existing : await Notifications.requestPermissionsAsync();
  if (!decision.granted && decision.ios?.status !== Notifications.IosAuthorizationStatus.PROVISIONAL) {
    return;
  }

  const token = await Notifications.getExpoPushTokenAsync();

  /**
   * The install identifier, not a per-launch value.
   *
   * The notification engine deactivates a token the provider rejects. If this changed on every
   * launch the platform would accumulate dead device rows, keep sending to them, and count the
   * failures against a user who is in fact reachable.
   */
  const deviceId =
    Platform.OS === 'android'
      ? (Application.getAndroidId() ?? 'android-unknown')
      : ((await Application.getIosIdForVendorAsync()) ?? 'ios-unknown');

  const appVersion = Application.nativeApplicationVersion;
  await api.devices.register({
    deviceId,
    platform: Platform.OS === 'ios' ? 'IOS' : 'ANDROID',
    pushToken: token.data,
    locale,
    ...(appVersion ? { appVersion } : {}),
  });
}

/**
 * Foreground behaviour.
 *
 * A restock alert arriving while somebody is already looking at that product should not cover
 * the screen with a banner telling them what they can see. Sound and badge stay off in the
 * foreground for the same reason.
 */
export function configureNotificationHandler(): void {
  Notifications.setNotificationHandler({
    handleNotification: () =>
      Promise.resolve({
        shouldShowAlert: true,
        shouldPlaySound: false,
        shouldSetBadge: false,
        shouldShowBanner: true,
        shouldShowList: true,
      }),
  });
}
