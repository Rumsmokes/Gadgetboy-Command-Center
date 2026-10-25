import React, { useState, useEffect, useMemo } from 'react';
import { useAutosave } from '../lib/useAutosave';
import { listTechnicians, addTechnician, removeTechnician, updateTechnician } from '../lib/admin';
import { formatPhone } from '../lib/format';
import TechnicianAnalyticsWindow from './TechnicianAnalyticsWindow';
import { DEFAULT_TECHNICIAN_ICON_ID, TechnicianAvatar, TechnicianIconPicker } from '../lib/technicianIcons';
import { supabase } from '../lib/supabase';

const TechnicianForm: React.FC<{ onClose: () => void; onSaved: (t: any) => void }> = ({ onClose, onSaved }) => {
  const [local, setLocal] = useState<any>({ firstName: '', lastName: '', nickname: '', phone: '', email: '', passcode: '', profileIcon: DEFAULT_TECHNICIAN_ICON_ID });
  const saving = async () => {
    try {
      const saved = await addTechnician(local);
      try { onSaved && (await onSaved(saved)); } catch (e) { /* ignore */ }
      onClose();
    } catch (err) {
      console.error('Failed to save technician', err);
      alert('Failed to save technician — see console');
    }
  };
  return (
    <div className="fixed inset-0 z-60 flex items-center justify-center bg-black/50">
      <div className="bg-zinc-900 border border-zinc-700 rounded p-4 w-96">
        <h3 className="font-semibold mb-2">New Technician</h3>
        <form onSubmit={e => { e.preventDefault(); saving(); }}>
          <div className="grid grid-cols-2 gap-2">
            <input placeholder="First" value={local.firstName} onChange={e => setLocal({ ...local, firstName: e.target.value })} className="bg-zinc-800 border border-zinc-700 rounded p-2" />
            <input placeholder="Last" value={local.lastName} onChange={e => setLocal({ ...local, lastName: e.target.value })} className="bg-zinc-800 border border-zinc-700 rounded p-2" />
            <input placeholder="Nickname" value={local.nickname} onChange={e => setLocal({ ...local, nickname: e.target.value })} className="bg-zinc-800 border border-zinc-700 rounded p-2" />
            <input placeholder="Phone" value={local.phone} onChange={e => setLocal({ ...local, phone: e.target.value })} className="bg-zinc-800 border border-zinc-700 rounded p-2" />
            <input placeholder="Email" value={local.email} onChange={e => setLocal({ ...local, email: e.target.value })} className="col-span-2 bg-zinc-800 border border-zinc-700 rounded p-2" />
            <input
              type="password"
              inputMode="numeric"
              autoComplete="one-time-code"
              name="new-tech-passcode"
              aria-label="4-digit passcode"
              placeholder="4-digit passcode"
              value={local.passcode}
              maxLength={4}
              onChange={e => {
                const v = e.target.value.replace(/\D/g, '').slice(0,4); setLocal({ ...local, passcode: v });
              }}
              className="col-span-2 bg-zinc-800 border border-zinc-700 rounded p-2"
            />
            <TechnicianIconPicker value={local.profileIcon} onChange={profileIcon => setLocal({ ...local, profileIcon })} />
          </div>
          <div className="flex justify-end gap-2 mt-3">
            <button type="button" className="px-3 py-1 bg-zinc-800 rounded" onClick={onClose}>Cancel</button>
            <button type="submit" className="px-3 py-1 bg-zinc-800 rounded">Save</button>
          </div>
        </form>
      </div>
    </div>
  );
};

const TechniciansWindow: React.FC<{ onClose?: () => void }> = ({ onClose }) => {
  const [list, setList] = useState<any[]>([]);
  const [showNew, setShowNew] = useState(false);
  const [editing, setEditing] = useState<any | null>(null);
  const [saveMessages, setSaveMessages] = useState<Record<number, string>>({});
  const [verifyTech, setVerifyTech] = useState<any | null>(null);
  const [passcodeTech, setPasscodeTech] = useState<any | null>(null);
  const [analyticsTech, setAnalyticsTech] = useState<any | null>(null);
  const [clockAction, setClockAction] = useState<{ mode: 'in' | 'out' } | null>(null);

  async function closeWindow() {
    if (onClose) {
      onClose();
      return;
    }
    try {
      const api: any = (window as any).api;
      if (api?.closeSelfWindow) {
        const res = await api.closeSelfWindow({ focusMain: true });
        if (res?.ok) return;
      }
    } catch {
      // fall back below
    }
    try { window.close(); } catch {}
  }

  // Auto-clear save messages after 3 seconds
  useEffect(() => {
    const timers: NodeJS.Timeout[] = [];
    Object.keys(saveMessages).forEach(techId => {
      if (saveMessages[parseInt(techId)]) {
        const timer = setTimeout(() => {
          setSaveMessages(prev => {
            const updated = { ...prev };
            delete updated[parseInt(techId)];
            return updated;
          });
        }, 3000);
        timers.push(timer);
      }
    });
    return () => timers.forEach(timer => clearTimeout(timer));
  }, [saveMessages]);

  const setTechnicianMessage = (techId: number, message: string) => {
    setSaveMessages(prev => ({ ...prev, [techId]: message }));
  };

  async function refresh() { 
    const l = await listTechnicians(); 
    console.log('Refreshed technician list:', l);
    setList(l); 
  }

  const isMobileLayout = /mobile\.html$/i.test(window.location.pathname)
    || !!document.querySelector('.gbpos-mobile');
  const useCompactCardLayout = true;

  async function saveSchedule(tech: any, schedule: any) {
    await updateTechnician({ ...tech, schedule });
    await refresh();
  }

  async function clearTechnicianTime(tech: any) {
    try {
      const name = tech.nickname || `${tech.firstName || ''} ${tech.lastName || ''}`.trim() || `Tech ${tech.id}`;
      if (!window.confirm(`Clear ALL time entries for ${name}? This cannot be undone.`)) return;
      const api: any = (window as any).api;
      const all = await api.dbGet('timeEntries') || [];
      const mine = all.filter((entry: any) => entry.technicianId === tech.id);
      let count = 0;
      for (const entry of mine) {
        try {
          await api.dbDelete('timeEntries', entry.id);
          count++;
        } catch (error) {
          console.error('delete time entry failed', error);
        }
      }
      await new Promise(resolve => setTimeout(resolve, 150));
      await refresh();
      setTechnicianMessage(tech.id, count ? `Cleared ${count} time entr${count === 1 ? 'y' : 'ies'}` : 'No entries to clear');
    } catch (error) {
      console.error('clear time failed', error);
      alert('Failed to clear time entries');
    }
  }

  async function deleteTechnician(tech: any) {
    try {
      if (!window.confirm(`Delete technician ${tech.firstName || ''} ${tech.lastName || ''}? This cannot be undone.`)) return;
      const ok = await removeTechnician(tech.id);
      if (!ok) {
        alert('Failed to delete technician.');
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 120));
      await refresh();
    } catch (error) {
      console.error('delete tech failed', error);
      alert('Delete failed. See console for details.');
    }
  }

  async function setUpLogin(tech: any) {
    const staffProfileId = String(tech?.cloudId || '').trim();
    if (!staffProfileId) {
      setTechnicianMessage(tech.id, 'Sync this technician first, then try again.');
      return;
    }
    if (!String(tech?.email || '').trim()) {
      setTechnicianMessage(tech.id, 'Add an email address before setting up a login.');
      return;
    }
    const confirmed = window.confirm(`Send ${tech.email} a secure GadgetBoy POS login setup link?`);
    if (!confirmed) return;
    const { data, error } = await supabase.functions.invoke('staff-account-admin', { body: { action: 'setup', staffProfileId } });
    setTechnicianMessage(tech.id, error ? (error.message || 'Login setup could not be sent.') : String(data?.message || 'Login setup link sent.'));
  }

  useEffect(() => { 
    console.log('TechniciansWindow initializing...');
    refresh(); 

    // Listen for technician data changes
    const unsubscribe = (window as any).api.onTechniciansChanged(() => {
      console.log('Technicians data changed, refreshing...');
      refresh();
    });

    return unsubscribe;
  }, []);

  return (
    <div className="gb-technicians-overlay fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="gb-technicians-window bg-zinc-900 border border-zinc-700 rounded w-[1300px] max-w-[95vw] max-h-[90vh] overflow-auto p-4">
        <div className="gb-technicians-header flex items-center justify-between mb-3">
          <h3 className="text-lg font-semibold">Technicians</h3>
          <div className="gb-technicians-toolbar flex gap-2 flex-wrap justify-end">
            <button className="gb-tech-refresh px-3 py-1 bg-zinc-800 rounded" onClick={refresh}>Refresh</button>
            <button className="gb-tech-clock-in px-3 py-1 bg-green-600 border border-green-500 text-white rounded hover:bg-green-700 transition-colors" onClick={() => setClockAction({ mode: 'in' })}>Clock In</button>
            <button className="gb-tech-clock-out px-3 py-1 bg-red-600 border border-red-500 text-white rounded hover:bg-red-700 transition-colors" onClick={() => setClockAction({ mode: 'out' })}>Clock Out</button>
            <button className="gb-tech-add px-3 py-1 bg-zinc-800 rounded" onClick={() => setShowNew(true)}>Add Technician</button>
            {!isMobileLayout ? (
              <button type="button" className="gb-panel-x-button" onClick={() => void closeWindow()} aria-label="Close Technicians" title="Close Technicians">x</button>
            ) : null}
          </div>
        </div>

        {!useCompactCardLayout ? <div className="gb-tech-desktop-table border border-zinc-800 rounded overflow-hidden overflow-x-auto">
          <table className="w-full min-w-[1200px] text-sm">
            <thead className="bg-zinc-800 text-zinc-400">
              <tr>
                <th className="px-3 py-2 text-left">Name</th>
                <th className="px-3 py-2 text-left">Phone</th>
                <th className="px-3 py-2 text-left">Email</th>
                <th className="px-3 py-2 text-left">Schedule & Actions</th>
              </tr>
            </thead>
            <tbody>
                {list.length === 0 && <tr><td colSpan={4} className="p-4 text-center text-zinc-500">No technicians</td></tr>}
                {list.map(t => (
                  <tr key={t.id} className="hover:bg-zinc-800">
                    <td className="px-3 py-2 align-top">
                      <div className="font-medium">{t.firstName} {t.lastName}</div>
                      {t.nickname && <div className="text-xs text-zinc-400">{t.nickname}</div>}
                      <div className="flex flex-wrap gap-2 mt-2">
                        <button 
                          className="px-2 py-1 text-xs bg-zinc-800 border border-zinc-700 rounded hover:bg-zinc-700 transition-colors" 
                          onClick={() => setEditing(t)}
                        >
                          Edit Info
                        </button>
                        <button
                          className="px-2 py-1 text-xs bg-zinc-800 border border-zinc-700 rounded hover:bg-zinc-700 transition-colors"
                          title="Set or change 4-digit passcode"
                          onClick={() => setPasscodeTech(t)}
                        >Passcode</button>
                        <button 
                          className="px-2 py-1 text-xs bg-blue-600 border border-blue-500 text-white rounded hover:bg-blue-700 transition-colors" 
                          onClick={() => setVerifyTech(t)}
                        >
                          Verify Time
                        </button>
                        <button
                          className="px-2 py-1 text-xs bg-purple-700 border border-purple-500 text-white rounded hover:bg-purple-600 transition-colors"
                          onClick={() => setAnalyticsTech(t)}
                        >
                          Analytics
                        </button>
                        <button
                          className="px-2 py-1 text-xs bg-red-800 border border-red-700 text-white rounded hover:bg-red-700 transition-colors"
                          title="Delete all time entries for this technician"
                          onClick={async () => {
                            try {
                              const name = t.nickname || `${t.firstName || ''} ${t.lastName || ''}`.trim() || `Tech ${t.id}`;
                              const ok = window.confirm(`Clear ALL time entries for ${name}? This cannot be undone.`);
                              if (!ok) return;
                              const api: any = (window as any).api;
                              const all = await api.dbGet('timeEntries') || [];
                              const mine = all.filter((e: any) => e.technicianId === t.id);
                              let count = 0;
                              for (const e of mine) {
                                try {
                                  await api.dbDelete('timeEntries', e.id);
                                  count++;
                                } catch (err) {
                                  console.error('delete time entry failed', err);
                                }
                              }
                              // small delay to allow write queue to flush
                              await new Promise(res => setTimeout(res, 150));
                              await refresh();
                              setTechnicianMessage(t.id, count ? `🧹 Cleared ${count} time entr${count === 1 ? 'y' : 'ies'}` : 'No entries to clear');
                            } catch (e) {
                              console.error('clear time failed', e);
                              alert('Failed to clear time entries');
                            }
                          }}
                        >
                          Clear Time
                        </button>
                        <button 
                          className="px-2 py-1 text-xs bg-red-700 text-white rounded hover:bg-red-600 transition-colors" 
                          onClick={async () => { 
                            try {
                              const confirmed = window.confirm(`Delete technician ${t.firstName || ''} ${t.lastName || ''}? This cannot be undone.`);
                              if (!confirmed) return;
                              const ok = await removeTechnician(t.id);
                              if (!ok) {
                                alert('Failed to delete technician.');
                                return;
                              }
                              // Tiny delay to allow main-process write queue to flush before reading
                              await new Promise(res => setTimeout(res, 120));
                              await refresh();
                            } catch (e) {
                              console.error('delete tech failed', e);
                              alert('Delete failed. See console for details.');
                            }
                          }}
                        >
                          Delete
                        </button>
                      </div>
                      {/* Save notification - under buttons */}
                      {saveMessages[t.id] && (
                        <div className="mt-2 p-2 bg-zinc-800 border border-zinc-600 rounded text-xs text-zinc-200 text-center">
                          {saveMessages[t.id]}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2 align-top">
                      <div className="text-sm">{formatPhone(t.phone || '') || t.phone || '-'}</div>
                    </td>
                    <td className="px-3 py-2 align-top">
                      <div className="text-sm">{t.email || '-'}</div>
                    </td>
                    <td className="px-3 py-2 align-top">
                      <ScheduleEditor 
                        tech={t} 
                        showMessage={(message) => setTechnicianMessage(t.id, message)}
                        onSave={(schedule) => saveSchedule(t, schedule)}
                      />
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div> : (
          <div className="gb-tech-mobile-list">
            {list.length === 0 ? <div className="gb-tech-empty">No technicians</div> : null}
            {list.map(tech => {
              const fullName = `${tech.firstName || ''} ${tech.lastName || ''}`.trim() || `Technician ${tech.id}`;
              return (
                <article className="gb-tech-card" key={tech.id}>
                  <div className="gb-tech-card-header">
                    <div className="flex min-w-0 items-center gap-3">
                      <TechnicianAvatar iconId={tech.profileIcon} size={44} ariaLabel={tech.nickname || fullName} />
                      <div className="min-w-0">
                      <h4>{tech.nickname || fullName}</h4>
                      {tech.nickname ? <p>{fullName}</p> : null}
                      </div>
                    </div>
                    <button type="button" className="gb-tech-edit" onClick={() => setEditing(tech)}>Edit</button>
                  </div>

                  <div className="gb-tech-contact">
                    <a href={tech.phone ? `tel:${String(tech.phone).replace(/\D/g, '')}` : undefined}>
                      <span>Phone</span>
                      <strong>{formatPhone(tech.phone || '') || tech.phone || '-'}</strong>
                    </a>
                    <a href={tech.email ? `mailto:${tech.email}` : undefined}>
                      <span>Email</span>
                      <strong>{tech.email || '-'}</strong>
                    </a>
                  </div>

                  <div className="gb-tech-actions">
                    <button type="button" onClick={() => void setUpLogin(tech)}>Set Up Login</button>
                    <button type="button" onClick={() => setPasscodeTech(tech)}>Passcode</button>
                    <button type="button" className="verify" onClick={() => setVerifyTech(tech)}>Verify Time</button>
                    <button type="button" className="analytics" onClick={() => setAnalyticsTech(tech)}>Analytics</button>
                    <button type="button" className="danger" onClick={() => void clearTechnicianTime(tech)}>Clear Time</button>
                  </div>

                  {saveMessages[tech.id] ? <div className="gb-tech-message">{saveMessages[tech.id]}</div> : null}

                  <details className="gb-tech-schedule">
                    <summary>
                      <span>Weekly Schedule</span>
                      <span className="gb-tech-schedule-hint">Tap to edit</span>
                    </summary>
                    <ScheduleEditor
                      tech={tech}
                      showMessage={(message) => setTechnicianMessage(tech.id, message)}
                      onSave={(schedule) => saveSchedule(tech, schedule)}
                    />
                  </details>

                  <button type="button" className="gb-tech-delete" onClick={() => void deleteTechnician(tech)}>
                    Delete Technician
                  </button>
                </article>
              );
            })}
          </div>
        )}
      </div>
      
  {showNew && <TechnicianForm onClose={() => setShowNew(false)} onSaved={async () => { await refresh(); }} />}
  {editing && <EditTechnicianModal tech={editing} onClose={() => setEditing(null)} onAutosave={async (patch) => { await updateTechnician({ id: editing.id, ...patch }); await refresh(); }} onSave={async (patch) => { await updateTechnician({ id: editing.id, ...patch }); setEditing(null); await refresh(); }} />}
  {verifyTech && <TimeVerificationModal tech={verifyTech} onClose={() => setVerifyTech(null)} />}
  {passcodeTech && (
    <PasscodeModal
      tech={passcodeTech}
      onClose={() => setPasscodeTech(null)}
      onSaved={async (msg?: string) => {
        const id = passcodeTech?.id;
        setPasscodeTech(null);
        await refresh();
        if (id && msg) setTechnicianMessage(id, msg);
      }}
    />
  )}
  {analyticsTech && <TechnicianAnalyticsWindow tech={analyticsTech} onClose={() => setAnalyticsTech(null)} />}
  {clockAction && (
    <ClockPasscodeModal
      mode={clockAction.mode}
      onClose={() => setClockAction(null)}
      onCompleted={async (tech: any, msg: string) => {
        setClockAction(null);
        await refresh();
        try { setTechnicianMessage(tech.id as any, msg); } catch {}
      }}
    />
  )}
    </div>
  );
};

export default TechniciansWindow;
const EditTechnicianModal: React.FC<{ tech: any; onClose: () => void; onAutosave: (patch: any) => Promise<void>; onSave: (patch: any) => Promise<void> }> = ({ tech, onClose, onAutosave, onSave }) => {
  const [local, setLocal] = useState<any>({ firstName: tech.firstName || '', lastName: tech.lastName || '', nickname: tech.nickname || '', phone: tech.phone || '', email: tech.email || '', profileIcon: tech.profileIcon || DEFAULT_TECHNICIAN_ICON_ID });
  // Autosave edits after 2s of inactivity
  useAutosave(local, async (val) => {
    try { await onAutosave({ ...val }); } catch (e) { /* swallow */ }
  }, { debounceMs: 2000, enabled: !!tech?.id, equals: Object.is, skipInitialSave: true });
  return (
    <div className="fixed inset-0 z-60 flex items-center justify-center bg-black/50">
      <div className="bg-zinc-900 border border-zinc-700 rounded p-4 w-96">
        <h3 className="font-semibold mb-2">Edit Technician</h3>
        <form onSubmit={async (e) => { e.preventDefault(); await onSave(local); }}>
          <div className="grid grid-cols-2 gap-2">
            <input placeholder="First" value={local.firstName} onChange={e => setLocal({ ...local, firstName: e.target.value })} className="bg-zinc-800 border border-zinc-700 rounded p-2" />
            <input placeholder="Last" value={local.lastName} onChange={e => setLocal({ ...local, lastName: e.target.value })} className="bg-zinc-800 border border-zinc-700 rounded p-2" />
            <input placeholder="Nickname" value={local.nickname} onChange={e => setLocal({ ...local, nickname: e.target.value })} className="bg-zinc-800 border border-zinc-700 rounded p-2" />
            <input placeholder="Phone" value={local.phone} onChange={e => setLocal({ ...local, phone: e.target.value })} className="bg-zinc-800 border border-zinc-700 rounded p-2" />
            <input placeholder="Email" value={local.email} onChange={e => setLocal({ ...local, email: e.target.value })} className="col-span-2 bg-zinc-800 border border-zinc-700 rounded p-2" />
            <TechnicianIconPicker value={local.profileIcon} onChange={profileIcon => setLocal({ ...local, profileIcon })} />
          </div>
          <div className="flex justify-end gap-2 mt-3">
            <button type="button" className="px-3 py-1 bg-zinc-800 rounded" onClick={onClose}>Cancel</button>
            <button type="submit" className="px-3 py-1 bg-zinc-800 rounded">Save</button>
          </div>
        </form>
      </div>
    </div>
  );
};

// Small modal for setting or changing technician passcode
const PasscodeModal: React.FC<{ tech: any; onClose: () => void; onSaved: (msg?: string) => void }> = ({ tech, onClose, onSaved }) => {
  const has = !!String(tech?.passcode || '').slice(0,4);
  const [current, setCurrent] = useState<string>('');
  const [p1, setP1] = useState<string>('');
  const [p2, setP2] = useState<string>('');
  const [saving, setSaving] = useState<boolean>(false);

  async function save() {
    if (saving) return;
    try {
      if (has) {
        if (current.replace(/\D/g,'').slice(0,4) !== String(tech.passcode || '').slice(0,4)) {
          alert('Incorrect current passcode');
          return;
        }
      }
      const np1 = p1.replace(/\D/g,'').slice(0,4);
      const np2 = p2.replace(/\D/g,'').slice(0,4);
      if (!np1 || np1.length !== 4) { alert('Passcode must be 4 digits'); return; }
      if (np1 !== np2) { alert('Passcodes do not match'); return; }
      setSaving(true);
      await updateTechnician({ id: tech.id, passcode: np1 });
      onSaved(has ? 'Passcode updated' : 'Passcode set');
    } catch (e) {
      console.error('passcode save failed', e);
      alert('Failed to save passcode');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-60 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative z-10 w-[360px] max-w-[92vw] bg-zinc-900 border border-zinc-700 rounded-lg shadow-2xl p-4 space-y-3">
        <div className="text-lg font-semibold">{has ? 'Change Passcode' : 'Set Passcode'}</div>
        {has && (
          <div>
            <label className="block text-xs text-zinc-400 mb-1">Current passcode</label>
            <input
              type="password"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={current}
              onChange={e => setCurrent(e.target.value.replace(/\D/g,'').slice(0,4))}
              maxLength={4}
              autoFocus
              className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded outline-none"
              placeholder="••••"
            />
          </div>
        )}
        <div>
          <label className="block text-xs text-zinc-400 mb-1">New passcode</label>
          <input
            type="password"
            inputMode="numeric"
            autoComplete="one-time-code"
            value={p1}
            onChange={e => setP1(e.target.value.replace(/\D/g,'').slice(0,4))}
            maxLength={4}
            autoFocus={!has}
            className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded outline-none"
            placeholder="4 digits"
          />
        </div>
        <div>
          <label className="block text-xs text-zinc-400 mb-1">Re-enter passcode</label>
          <input
            type="password"
            inputMode="numeric"
            autoComplete="one-time-code"
            value={p2}
            onChange={e => setP2(e.target.value.replace(/\D/g,'').slice(0,4))}
            maxLength={4}
            className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded outline-none"
            placeholder="4 digits"
          />
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <button className="px-3 py-2 bg-zinc-800 border border-zinc-700 rounded hover:border-zinc-500" onClick={onClose} disabled={saving}>Cancel</button>
          <button className={`px-3 py-2 border rounded ${saving ? 'opacity-70 cursor-not-allowed' : 'bg-[#39FF14] text-black border-[#39FF14] hover:opacity-90'}`} onClick={save} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
};

// Modal to verify a technician's daily time entries
const TimeVerificationModal: React.FC<{ tech: any; onClose: () => void }> = ({ tech, onClose }) => {
  const [date, setDate] = useState<string>(() => new Date().toISOString().slice(0, 10));
  const [entries, setEntries] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string>('');
  const [editTimes, setEditTimes] = useState<Record<number, { in?: string; out?: string; saving?: boolean; savedAt?: number }>>({});

  function techDisplayName(t: any) { return t?.nickname || `${t?.firstName || ''} ${t?.lastName || ''}`.trim() || `Tech ${t?.id}`; }

  async function load() {
    setLoading(true);
    try {
      const all = await (window as any).api.dbGet('timeEntries') || [];
      const filtered = all.filter((e: any) => e.technicianId === tech.id && e.date === date);
      // Sort by clockIn ascending
      filtered.sort((a: any, b: any) => new Date(a.clockIn).getTime() - new Date(b.clockIn).getTime());
      setEntries(filtered);
    } catch (e) {
      console.error('load time entries failed', e);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, [date, tech?.id]);
  useEffect(() => {
    const api: any = (window as any).api;
    if (!api?.onTimeEntriesChanged) return;
    const unsub = api.onTimeEntriesChanged(() => { load(); });
    return unsub;
  }, []);

  async function setVerified(e: any, verified: boolean) {
    try {
      const patch = { ...e, verifiedAt: verified ? new Date().toISOString() : undefined, verifiedBy: verified ? 'admin' : undefined };
      await (window as any).api.dbUpdate('timeEntries', e.id, patch);
      await load();
      setMessage(verified ? '✅ Entry verified' : '⏹️ Verification removed');
      setTimeout(() => setMessage(''), 2500);
    } catch (err) { console.error('verify failed', err); }
  }

  async function verifyAll() {
    for (const e of entries) {
      if (!e.verifiedAt) {
        try { await (window as any).api.dbUpdate('timeEntries', e.id, { ...e, verifiedAt: new Date().toISOString(), verifiedBy: 'admin' }); } catch {}
      }
    }
    await load();
    setMessage('✅ All entries verified');
    setTimeout(() => setMessage(''), 2500);
  }

  function fmt(t?: string) { return t ? new Date(t).toLocaleTimeString() : '-'; }

  function toDisplay(t?: string) {
    if (!t) return '';
    const d = new Date(t);
    const hh = d.getHours().toString().padStart(2,'0');
    const mm = d.getMinutes().toString().padStart(2,'0');
    return `${hh}:${mm}`; // 24h HH:mm for editing
  }

  function parseTimeText(text: string): { h: number; m: number } | null {
    const raw = (text || '').trim().toLowerCase();
    if (!raw) return null;
    // Accept forms: "1", "13", "130", "1:30", "1p", "1pm", "1:30pm"
    const pm = /pm$/.test(raw) || /p$/.test(raw);
    const clean = raw.replace(/\s/g,'').replace(/am$|pm$|a$|p$/,'');
    let h = 0, m = 0;
    if (/^\d{1,2}:\d{1,2}$/.test(clean)) {
      const [hs, ms] = clean.split(':');
      h = parseInt(hs, 10); m = parseInt(ms, 10) || 0;
    } else if (/^\d{3,4}$/.test(clean)) {
      // e.g., 130 -> 1:30, 0945 -> 9:45
      const s = clean.padStart(4,'0');
      h = parseInt(s.slice(0,2), 10);
      m = parseInt(s.slice(2,4), 10) || 0;
    } else if (/^\d{1,2}$/.test(clean)) {
      h = parseInt(clean, 10); m = 0;
    } else {
      return null;
    }
    if (pm && h < 12) h += 12;
    if (!pm && /am$|a$/.test(raw) && h === 12) h = 0;
    if (h < 0 || h > 23 || m < 0 || m > 59) return null;
    return { h, m };
  }

  async function saveTime(e: any, which: 'in'|'out', text: string) {
    const parsed = parseTimeText(text);
    const id = e.id as number;
    if (!parsed) {
      // If clearing, allow blank to unset
      if (text.trim() === '') {
        const patch = { ...e };
        if (which === 'in') delete (patch as any).clockIn; else delete (patch as any).clockOut;
        await (window as any).api.dbUpdate('timeEntries', id, patch);
        setEditTimes(prev => ({ ...prev, [id]: { ...(prev[id]||{}), [which]: '' } }));
      }
      return;
    }
    const base = new Date(date + 'T00:00:00');
    const when = new Date(base.getFullYear(), base.getMonth(), base.getDate(), parsed.h, parsed.m, 0, 0);
    const iso = when.toISOString();
    const patch = { ...e, [which === 'in' ? 'clockIn' : 'clockOut']: iso };
    setEditTimes(prev => ({ ...prev, [id]: { ...(prev[id]||{}), saving: true } }));
    try {
      await (window as any).api.dbUpdate('timeEntries', id, patch);
      setEditTimes(prev => ({ ...prev, [id]: { ...(prev[id]||{}), [which]: toDisplay(iso), saving: false, savedAt: Date.now() } }));
      await load();
    } catch (err) {
      console.error('saveTime failed', err);
      setEditTimes(prev => ({ ...prev, [id]: { ...(prev[id]||{}), saving: false } }));
      alert('Failed to save time');
    }
  }

  return (
    <div className="fixed inset-0 z-60 flex items-center justify-center bg-black/50">
      <div className="bg-zinc-900 border border-zinc-700 rounded p-4 w-[720px] max-h-[85vh] overflow-auto">
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-semibold">Verify Time — {techDisplayName(tech)}</h3>
          <div className="flex gap-2">
            <button className="px-3 py-1 bg-zinc-800 rounded" onClick={load}>Refresh</button>
            <button className="px-3 py-1 bg-zinc-800 rounded" onClick={onClose}>Close</button>
          </div>
        </div>
        <div className="flex items-end gap-3 mb-3">
          <div>
            <label className="block text-xs text-zinc-400">Date</label>
            <input type="date" className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1" value={date} onChange={e => setDate(e.target.value)} />
          </div>
          <div className="ml-auto flex gap-2">
            <button className="px-3 py-1 bg-blue-600 text-white rounded" onClick={verifyAll} disabled={loading || entries.length === 0}>Verify All</button>
          </div>
        </div>
        {message && <div className="mb-3 p-2 bg-zinc-800 border border-zinc-700 rounded text-sm text-center">{message}</div>}
        <div className="border border-zinc-800 rounded overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-zinc-800 text-zinc-400">
              <tr>
                <th className="px-3 py-2 text-left">Clock In</th>
                <th className="px-3 py-2 text-left">Clock Out</th>
                <th className="px-3 py-2 text-left">Status</th>
                <th className="px-3 py-2 text-left">Hours</th>
                <th className="px-3 py-2 text-left">Notes</th>
                <th className="px-3 py-2 text-left">Verified</th>
                <th className="px-3 py-2 text-left">Actions</th>
              </tr>
            </thead>
            <tbody>
              {entries.length === 0 && (
                <tr><td colSpan={7} className="p-4 text-center text-zinc-500">No time entries for this date</td></tr>
              )}
              {entries.map(e => (
                <tr key={e.id} className="hover:bg-zinc-800">
                  <td className="px-3 py-2">
                    <input
                      className="w-24 bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-sm"
                      list="time-suggestions"
                      placeholder="HH:MM"
                      defaultValue={toDisplay(e.clockIn)}
                      onBlur={async (ev) => { await saveTime(e, 'in', ev.currentTarget.value); }}
                      onKeyDown={async (ev) => { if (ev.key === 'Enter') { ev.currentTarget.blur(); } }}
                    />
                  </td>
                  <td className="px-3 py-2">
                    <input
                      className="w-24 bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-sm"
                      list="time-suggestions"
                      placeholder="HH:MM"
                      defaultValue={toDisplay(e.clockOut)}
                      onBlur={async (ev) => { await saveTime(e, 'out', ev.currentTarget.value); }}
                      onKeyDown={async (ev) => { if (ev.key === 'Enter') { ev.currentTarget.blur(); } }}
                    />
                  </td>
                  <td className="px-3 py-2">{e.status || '-'}</td>
                  <td className="px-3 py-2">{typeof e.totalHours === 'number' ? e.totalHours.toFixed(2) : '-'}</td>
                  <td className="px-3 py-2">{e.notes || '-'}</td>
                  <td className="px-3 py-2">{e.verifiedAt ? `Yes (${new Date(e.verifiedAt).toLocaleDateString()})` : 'No'}</td>
                  <td className="px-3 py-2">
                    {e.verifiedAt ? (
                      <button className="px-2 py-1 text-xs bg-zinc-700 rounded" onClick={() => setVerified(e, false)}>Unverify</button>
                    ) : (
                      <button className="px-2 py-1 text-xs bg-[#39FF14] text-black rounded" onClick={() => setVerified(e, true)}>Verify</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <datalist id="time-suggestions">
          <option value="08:00" />
          <option value="08:30" />
          <option value="09:00" />
          <option value="09:30" />
          <option value="10:00" />
          <option value="12:00" />
          <option value="13:00" />
          <option value="17:00" />
          <option value="5pm" />
          <option value="1:30pm" />
        </datalist>
      </div>
    </div>
  );
};


// Weekly schedule editor embedded per technician
const ScheduleEditor: React.FC<{ tech: any; onSave: (sched: any) => Promise<void>; showMessage: (msg: string) => void }> = ({ tech, onSave, showMessage }) => {
  const mobileSchedule = /mobile\.html$/i.test(window.location.pathname)
    || !!document.querySelector('.gbpos-mobile');
  // Use tech.schedule directly instead of local state, but keep local for editing
  const [local, setLocal] = useState<any>(() => {
    const schedule = tech.schedule || {};
    console.log('ScheduleEditor initial state for', tech.firstName, ':', schedule);
    return schedule;
  });
  
  // Sync local state when tech.schedule changes - use JSON.stringify for deep comparison
  const scheduleStr = JSON.stringify(tech.schedule || {});
  useEffect(() => {
    console.log('=== SCHEDULE SYNC ===');
    console.log('Tech object:', tech);
    console.log('Tech.schedule:', tech.schedule);
    console.log('Setting local to:', tech.schedule || {});
    setLocal(tech.schedule || {});
  }, [scheduleStr, tech.firstName]);
  
  // Debug current local state
  useEffect(() => {
    console.log('ScheduleEditor local state for', tech.firstName, ':', local);
  }, [local, tech.firstName]);
  
  const days: Array<{ key: string; label: string }> = [
    { key: 'mon', label: 'Mon' }, { key: 'tue', label: 'Tue' }, { key: 'wed', label: 'Wed' }, { key: 'thu', label: 'Thu' }, { key: 'fri', label: 'Fri' }, { key: 'sat', label: 'Sat' }, { key: 'sun', label: 'Sun' },
  ];
  function setDay(key: string, field: 'start'|'end'|'off', value: string | boolean) {
    setLocal((prev: any) => ({ ...prev, [key]: { ...(prev?.[key] || {}), [field]: value } }));
  }
  function toMin(t?: string) { if (!t) return 0; const [h,m] = t.split(':').map(Number); return (h||0)*60 + (m||0); }
  function totalHours() {
    const mins = days.reduce((sum, d) => sum + Math.max(0, toMin(local?.[d.key]?.end) - toMin(local?.[d.key]?.start)), 0);
    return (mins/60).toFixed(2);
  }
  // Autosave schedule after 2s of inactivity
  useAutosave(local, async (val) => {
    try {
      await onSave(val);
      showMessage(`✅ Auto-saved ${new Date().toLocaleTimeString()}`);
    } catch {}
  }, { debounceMs: 2000, enabled: !!tech?.id, equals: Object.is });
  return (
    <div className="gb-schedule-editor bg-zinc-900 border border-zinc-800 rounded p-3 max-w-full overflow-auto">
      <div className="text-xs text-zinc-400 mb-2">Weekly Schedule</div>
      <div className="gb-schedule-days space-y-1">
        {days.map(d => {
          const isOff = local?.[d.key]?.off || false;
          return (
            <div key={d.key} className="gb-schedule-day flex items-center gap-2 text-sm">
              <div className="w-10 text-zinc-300">{d.label}</div>
              <label className="flex items-center gap-1 cursor-pointer">
                <input
                  type="checkbox"
                  className="w-3 h-3 accent-[#39FF14]"
                  checked={isOff}
                  onChange={(e) => setDay(d.key, 'off', e.target.checked)}
                />
                <span className="text-xs text-zinc-400">Off</span>
              </label>
              {!isOff && (
                <div className="gb-schedule-times flex items-center gap-2">
                  {mobileSchedule ? (
                    <input
                      type="time"
                      aria-label={`${d.label} start time`}
                      className="gb-mobile-schedule-time bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-sm"
                      value={local?.[d.key]?.start || ''}
                      onChange={event => setDay(d.key, 'start', event.target.value)}
                    />
                  ) : (
                    <TimeSelect value={local?.[d.key]?.start || ''} onChange={val => setDay(d.key,'start', val)} />
                  )}
                  <span className="text-xs text-zinc-500">to</span>
                  {mobileSchedule ? (
                    <input
                      type="time"
                      aria-label={`${d.label} end time`}
                      className="gb-mobile-schedule-time bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-sm"
                      value={local?.[d.key]?.end || ''}
                      onChange={event => setDay(d.key, 'end', event.target.value)}
                    />
                  ) : (
                    <TimeSelect value={local?.[d.key]?.end || ''} onChange={val => setDay(d.key,'end', val)} />
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="gb-schedule-footer flex items-center justify-between mt-3 pt-2 border-t border-zinc-700">
        <div className="text-sm text-zinc-400">Weekly Total: <span className="font-medium text-[#39FF14]">{totalHours()} hours</span></div>
        <button className="px-3 py-1 text-sm bg-[#39FF14] text-black font-medium rounded hover:bg-[#32E610] transition-colors" onClick={async () => {
          console.log('Save schedule for technician to DB only (calendar derives live)');
          try {
            await onSave(local);
            const now = new Date().toLocaleTimeString();
            showMessage(`✅ Saved at ${now}`);
          } catch (error) {
            console.error('Schedule save failed:', error);
            const now = new Date().toLocaleTimeString();
            showMessage(`❌ Save error at ${now}`);
          }
        }}>
          Save Schedule
        </button>
      </div>
      {/* Suggestions for schedule input typing */}
      <datalist id="schedule-time-suggestions">
        <option value="08:00" />
        <option value="08:30" />
        <option value="09:00" />
        <option value="09:30" />
        <option value="10:00" />
        <option value="12:00" />
        <option value="13:00" />
        <option value="17:00" />
        <option value="5pm" />
        <option value="1:30pm" />
      </datalist>
    </div>
  );
};

// Time selector with hour/minute fields that support typing plus AM/PM dropdown
const TimeSelect: React.FC<{ value: string; onChange: (val: string) => void }> = ({ value, onChange }) => {
  const { hour12, minute, period } = useMemo(() => {
    if (!value) return { hour12: '', minute: '', period: 'AM' };
    const [hStr, mStr] = value.split(':');
    let h = Number(hStr);
    const m = (mStr || '00').padStart(2, '0');
    const p = h >= 12 ? 'PM' : 'AM';
    h = h % 12; if (h === 0) h = 12;
    return { hour12: String(h), minute: m, period: p };
  }, [value]);

  const hourListId = useMemo(() => `hours-choices-${Math.random().toString(36).slice(2)}` , []);
  const minuteListId = useMemo(() => `minutes-choices-${Math.random().toString(36).slice(2)}` , []);

  function emit(hh: string, mm: string, p: 'AM' | 'PM') {
    if (!hh) { onChange(''); return; }
    let h = Number(hh);
    if (p === 'AM') { if (h === 12) h = 0; } else { if (h < 12) h += 12; }
    const h24 = String(h).padStart(2, '0');
    const m2 = (mm || '00').padStart(2, '0');
    onChange(`${h24}:${m2}`);
  }

  return (
    <div className="flex items-center gap-1">
      <input
        type="text"
        inputMode="numeric"
        className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-sm w-14 text-center"
        list={hourListId}
        placeholder="hh"
        value={hour12}
        onChange={e => {
          const raw = e.target.value.replace(/\D/g, '').slice(0, 2);
          if (!raw) { emit('', minute, period as any); return; }
          const n = Math.max(1, Math.min(12, parseInt(raw, 10) || 0));
          emit(String(n), minute, period as any);
        }}
      />
      <datalist id={hourListId}>
        {Array.from({ length: 12 }, (_, i) => i + 1).map(h => (
          <option key={h} value={String(h)} />
        ))}
      </datalist>
      <span className="text-xs text-zinc-400">:</span>
      <input
        type="text"
        inputMode="numeric"
        className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-sm w-14 text-center"
        list={minuteListId}
        placeholder="mm"
        value={minute || ''}
        onChange={e => {
          const raw = e.target.value.replace(/\D/g, '').slice(0, 2);
          if (!raw) { emit(hour12, '', period as any); return; }
          const n = Math.max(0, Math.min(59, parseInt(raw, 10) || 0));
          const mm = String(n).padStart(2, '0');
          emit(hour12, mm, period as any);
        }}
      />
      <datalist id={minuteListId}>
        {['00','15','30','45'].map(m => (
          <option key={m} value={m} />
        ))}
      </datalist>
      <select
        className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-sm w-14 appearance-none"
        style={{ backgroundImage: 'none' }}
        value={period}
        onChange={e => emit(hour12, minute, e.target.value as 'AM'|'PM')}
      >
        <option value="AM">AM</option>
        <option value="PM">PM</option>
      </select>
    </div>
  );
};

// Small modal used when clicking Clock In/Clock Out in header — technicians enter 4-digit passcode
const ClockPasscodeModal: React.FC<{
  mode: 'in' | 'out';
  onClose: () => void;
  onCompleted: (tech: any, message: string) => void;
}> = ({ mode, onClose, onCompleted }) => {
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  function nowIso() { return new Date().toISOString(); }
  function todayStr() { return new Date().toISOString().slice(0, 10); }
  function fmtTime(iso: string) { try { return new Date(iso).toLocaleTimeString(); } catch { return 'now'; } }

  async function handleSubmit() {
    const pass = code.replace(/\D/g, '').slice(0,4);
    if (pass.length !== 4) { setError('Enter 4 digits'); return; }
    setError('');
    setLoading(true);
    try {
      // Find technician by passcode
      const techs = await listTechnicians();
      const tech = techs.find((t: any) => String(t.passcode || '').slice(0,4) === pass);
      if (!tech) { setError('Passcode not found'); setLoading(false); return; }

      const api: any = (window as any).api;
      const entries = await api.dbGet('timeEntries') || [];
      const date = todayStr();
      const myToday = entries.filter((e: any) => e.technicianId === tech.id && e.date === date);
      const open = myToday.find((e: any) => !e.clockOut);

      if (mode === 'in') {
        if (open) {
          // Already have an open entry today
          onCompleted(tech, `Already clocked in (since ${fmtTime(open.clockIn)})`);
          return;
        }
        const newEntry = {
          technicianId: tech.id,
          date,
          clockIn: nowIso(),
          status: 'clocked-in',
        };
        const saved = await api.dbAdd('timeEntries', newEntry);
        onCompleted(tech, `Clocked in at ${fmtTime(saved.clockIn)}`);
        return;
      } else {
        // mode === 'out'
        if (!open) {
          // no open entry — try to find the most recent today (even if closed) for feedback
          const latest = myToday.slice().sort((a: any, b: any) => new Date(b.clockIn).getTime() - new Date(a.clockIn).getTime())[0];
          onCompleted(tech, latest ? 'No open entry to clock out' : 'No entry today');
          return;
        }
        const clockOut = nowIso();
        const clockIn = new Date(open.clockIn).getTime();
        const outMs = new Date(clockOut).getTime();
        const hours = Math.max(0, (outMs - clockIn) / 3_600_000);
        const patch = { ...open, clockOut, status: 'clocked-out', totalHours: Math.round(hours * 100) / 100 };
        await api.dbUpdate('timeEntries', open.id, patch);
        onCompleted(tech, `Clocked out at ${fmtTime(clockOut)} (${(patch.totalHours as number).toFixed(2)}h)`);
        return;
      }
    } catch (e) {
      console.error('clock passcode submit failed', e);
      setError('Something went wrong');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-60 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative z-10 w-[360px] max-w-[92vw] bg-zinc-900 border border-zinc-700 rounded-lg shadow-2xl p-4 space-y-3">
        <div className="text-lg font-semibold">{mode === 'in' ? 'Clock In' : 'Clock Out'}</div>
        <div>
          <label className="block text-xs text-zinc-400 mb-1">Enter 4-digit passcode</label>
          <input
            value={code}
            onChange={e => setCode(e.target.value.replace(/\D/g,'').slice(0,4))}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleSubmit(); } }}
            maxLength={4}
            autoFocus
            type="password"
            inputMode="numeric"
            autoComplete="one-time-code"
            className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded outline-none tracking-widest text-center"
            placeholder="••••"
          />
          {error && <div className="mt-2 text-xs text-red-400">{error}</div>}
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <button className="px-3 py-2 bg-zinc-800 border border-zinc-700 rounded hover:border-zinc-500" onClick={onClose} disabled={loading}>Cancel</button>
          <button
            className={`px-3 py-2 border rounded ${loading || code.length !== 4 ? 'opacity-60 cursor-not-allowed bg-zinc-800 border-zinc-700' : 'bg-[#39FF14] text-black border-[#39FF14] hover:opacity-90'}`}
            onClick={handleSubmit}
            disabled={loading || code.length !== 4}
          >
            {loading ? 'Please wait…' : (mode === 'in' ? 'Clock In' : 'Clock Out')}
          </button>
        </div>
      </div>
    </div>
  );
};
