import React, { FormEvent, useState } from 'react';
import { supabase } from '../lib/supabase';

export function AccountPasswordScreen({ onComplete }: { onComplete: () => void }) {
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage('');
    if (password.length < 10) return setMessage('Use a password with at least 10 characters.');
    if (password !== confirmPassword) return setMessage('The passwords do not match.');
    setSaving(true);
    const { error } = await supabase.auth.updateUser({ password });
    setSaving(false);
    if (error) return setMessage(error.message);
    onComplete();
  }

  return <main className="min-h-screen bg-slate-950 text-white flex items-center justify-center px-4">
    <form onSubmit={submit} className="w-full max-w-sm rounded-lg border border-slate-800 bg-slate-900 p-6 shadow-xl">
      <h1 className="text-2xl font-semibold">Set your GadgetBoy POS password</h1>
      <p className="mt-2 text-sm text-slate-400">Choose your own password. Your four-digit shop PIN remains separate and is not a POS login password.</p>
      <label className="mt-6 block text-sm font-medium text-slate-200">New password
        <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" required className="mt-2 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-white outline-none focus:border-emerald-400" />
      </label>
      <label className="mt-4 block text-sm font-medium text-slate-200">Confirm password
        <input type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} autoComplete="new-password" required className="mt-2 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-white outline-none focus:border-emerald-400" />
      </label>
      {message ? <div className="mt-4 rounded-md border border-red-500/40 bg-red-950/50 px-3 py-2 text-sm text-red-200">{message}</div> : null}
      <button type="submit" disabled={saving} className="mt-6 w-full rounded-md bg-emerald-500 px-4 py-2 font-semibold text-slate-950 hover:bg-emerald-400 disabled:opacity-60">{saving ? 'Saving...' : 'Save password'}</button>
    </form>
  </main>;
}
