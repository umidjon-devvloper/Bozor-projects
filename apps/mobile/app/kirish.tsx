import { useRouter } from 'expo-router';
import { useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { ApiError } from '@bozorlar/api-client';
import { useSession } from '@bozorlar/session';
import { theme } from '@/theme';

/**
 * Sign in, or register, on one screen.
 *
 * `KeyboardAvoidingView` is not decoration here: on a small Android phone the keyboard covers
 * the password field and the submit button, and a form somebody cannot see the end of is a form
 * they abandon.
 */
export default function SignInScreen() {
  const router = useRouter();
  const { signIn, register } = useSession();
  const [mode, setMode] = useState<'signIn' | 'register'>('signIn');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      if (mode === 'signIn') await signIn(phone, password);
      else await register({ phone, password, name });
      router.replace('/');
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? (caught.detail ?? caught.message)
          : "Ulanmadi. Internetni tekshiring.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={styles.flex}
    >
      <View style={styles.container}>
        <Text style={styles.title}>{mode === 'signIn' ? 'Kirish' : "Ro'yxatdan o'tish"}</Text>

        {mode === 'register' ? (
          <Field label="Ismingiz" value={name} onChange={setName} />
        ) : null}
        <Field label="Telefon" value={phone} onChange={setPhone} keyboardType="phone-pad" />
        <Field label="Parol" value={password} onChange={setPassword} secure />

        {error ? <Text style={styles.error}>{error}</Text> : null}

        <Pressable onPress={() => void submit()} disabled={busy} style={styles.primary}>
          {busy ? (
            <ActivityIndicator color={theme.paper} />
          ) : (
            <Text style={styles.primaryText}>
              {mode === 'signIn' ? 'Kirish' : "Ro'yxatdan o'tish"}
            </Text>
          )}
        </Pressable>

        <Pressable
          onPress={() => {
            setMode(mode === 'signIn' ? 'register' : 'signIn');
            setError(null);
          }}
        >
          <Text style={styles.switch}>
            {mode === 'signIn' ? "Hisobim yo'q" : 'Hisobim bor'}
          </Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

function Field({
  label,
  value,
  onChange,
  secure,
  keyboardType,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  secure?: boolean;
  keyboardType?: 'phone-pad';
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChange}
        secureTextEntry={secure}
        keyboardType={keyboardType}
        autoCapitalize="none"
        style={styles.input}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  container: { flex: 1, justifyContent: 'center', padding: 24, gap: 14 },
  title: { fontSize: 24, fontWeight: '700', color: theme.ink, marginBottom: 6 },
  field: { gap: 5 },
  label: { fontSize: 12, color: theme.muted },
  input: {
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 6,
    backgroundColor: '#FFFFFF',
    paddingHorizontal: 12,
    paddingVertical: 12,
    fontSize: 16,
    color: theme.ink,
  },
  primary: {
    marginTop: 6,
    backgroundColor: theme.tile,
    borderRadius: 6,
    paddingVertical: 14,
    alignItems: 'center',
  },
  primaryText: { color: theme.paper, fontSize: 16, fontWeight: '600' },
  switch: { marginTop: 14, color: theme.tile, textAlign: 'center' },
  error: { color: theme.pomegranate, fontSize: 14 },
});
