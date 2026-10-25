import React, { FormEvent, useState } from 'react';
import { supabase } from '../lib/supabase';

type LoginScreenProps = {
  onSignedIn: () => void;
};

export function LoginScreen({ onSignedIn }: LoginScreenProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [showRecovery, setShowRecovery] = useState(false);
  const [recoveryEmail, setRecoveryEmail] = useState('');
  const [recoveryMessage, setRecoveryMessage] = useState('');

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrorMessage('');
    setLoading(true);

    const enteredLogin = email.trim();
    const durantEmail = String(import.meta.env.VITE_DURANT_LOGIN_EMAIL || 'durantmedia@gadgetboysc.com');
    const { error } = await supabase.auth.signInWithPassword({
      email: enteredLogin.toLowerCase() === 'durantmedia' ? durantEmail : enteredLogin,
      password,
    });

    setLoading(false);

    if (error) {
      setErrorMessage(error.message);
      return;
    }

    onSignedIn();
  }

  async function requestRecovery() {
    setRecoveryMessage('');
    setLoading(true);
    const { data, error } = await supabase.functions.invoke('staff-account-admin', {
      body: { action: 'request-recovery', email: recoveryEmail.trim().toLowerCase() },
    });
    setLoading(false);
    // This deliberately stays non-specific so the screen cannot reveal which
    // technician addresses are stored in the POS.
    setRecoveryMessage(error ? 'If that active technician email is on file, a login recovery link has been sent.' : String(data?.message || 'Check your email for a recovery link.'));
  }

  return (
    <main className="min-h-screen bg-slate-950 text-white flex items-center justify-center px-4">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-sm rounded-lg border border-slate-800 bg-slate-900 p-6 shadow-xl"
      >
        <h1 className="text-2xl font-semibold">GadgetBoy POS</h1>
        <p className="mt-2 text-sm text-slate-400">Sign in to access shop data.</p>

        <label className="mt-6 block text-sm font-medium text-slate-200">
          Email
          <input
            type="text"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            autoComplete="username"
            required
            className="mt-2 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-white outline-none focus:border-emerald-400"
          />
        </label>

        <label className="mt-4 block text-sm font-medium text-slate-200">
          Password
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
            required
            className="mt-2 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-white outline-none focus:border-emerald-400"
          />
        </label>

        {errorMessage ? (
          <div className="mt-4 rounded-md border border-red-500/40 bg-red-950/50 px-3 py-2 text-sm text-red-200">
            {errorMessage}
          </div>
        ) : null}

        <button
          type="submit"
          disabled={loading}
          className="mt-6 w-full rounded-md bg-emerald-500 px-4 py-2 font-semibold text-slate-950 hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {loading ? 'Signing in...' : 'Sign in'}
        </button>
        <button type="button" onClick={() => { setShowRecovery(value => !value); setRecoveryMessage(''); }} className="mt-4 w-full text-sm font-medium text-emerald-300 hover:text-emerald-200">
          Forgot ya Login?
        </button>
        {showRecovery ? <div className="mt-4 border-t border-slate-800 pt-4">
          <label className="block text-sm font-medium text-slate-200">Technician email
            <input type="email" value={recoveryEmail} onChange={(event) => setRecoveryEmail(event.target.value)} autoComplete="email" required className="mt-2 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-white outline-none focus:border-emerald-400" />
          </label>
          <button type="button" onClick={() => void requestRecovery()} disabled={loading} className="mt-3 w-full rounded-md border border-emerald-500/60 bg-emerald-500/10 px-4 py-2 text-sm font-semibold text-emerald-200 disabled:opacity-60">Send recovery link</button>
          {recoveryMessage ? <p className="mt-3 text-xs text-slate-300">{recoveryMessage}</p> : null}
          <p className="mt-3 text-xs text-slate-500">Recovery is email-only until the shop configures verified SMS sign-in.</p>
        </div> : null}
      </form>
    </main>
  );
}
