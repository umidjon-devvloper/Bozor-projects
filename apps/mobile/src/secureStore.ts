import * as SecureStore from 'expo-secure-store';
import type { RefreshTokenStore } from '@bozorlar/session';

/**
 * The refresh token, in the platform keychain.
 *
 * Not `AsyncStorage`. On both platforms AsyncStorage is an unencrypted file inside the app
 * sandbox, readable by anything with filesystem access on a rooted or jailbroken device — and
 * a refresh token is the one credential worth stealing, because it survives the app being
 * closed and mints access tokens indefinitely until it is used or revoked.
 *
 * SecureStore is the Keychain on iOS and EncryptedSharedPreferences on Android. Both are
 * hardware-backed where the device supports it.
 */
const KEY = 'bozorlar.refresh';

export const secureRefreshStore: RefreshTokenStore = {
  async read() {
    try {
      return await SecureStore.getItemAsync(KEY);
    } catch {
      // A keychain read can fail on a device the user has locked in an unusual state. Treating
      // it as "no session" sends them to sign-in, which is recoverable; throwing here would
      // crash the app on launch.
      return null;
    }
  },

  async write(token: string) {
    await SecureStore.setItemAsync(KEY, token, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
  },

  async clear() {
    try {
      await SecureStore.deleteItemAsync(KEY);
    } catch {
      // Already gone is the outcome we wanted.
    }
  },
};
