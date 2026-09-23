import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { formatPhone } from '../lib/format';
import { useAutosave } from '@/lib/useAutosave';
import { formatTime12FromHHmm } from '@/lib/datetime';
import { listTechnicians, technicianDisplayName } from '@/lib/admin';
import { consumeWindowPayload } from '@/lib/windowPayload';
import { consultationLocationDisplay } from '@/lib/consultationLocation';
import { ALL_TECHNICIANS, calendarEventAutosaveEnabled, calendarEventGroupKey, isSharedTaskAssignment, taskAssignmentIncludes, taskAssignmentLabel, taskAssignments, taskIsCompleted, tasksForDailyLook, tasksPendingSave, toggleTaskAssignment } from '@/lib/calendarTasks';
import { effectiveTechnicianShiftForDate, isShiftOverrideEvent, SHIFT_OVERRIDE_SOURCE, SHIFT_REQUEST_SOURCE, shiftOverrideLocation } from '@/lib/technicianSchedule';
import ContextMenu, { type ContextMenuItem } from './ContextMenu';
import { useContextMenu } from '@/lib/useContextMenu';
import { expandRecurringEvent, monthlyWeekdayPatternForDate, normalizeRecurrenceRule, type CalendarRecurrenceRule } from '@/lib/calendarRecurrence';
import { replaceRecordById, taskCompletionPatch } from '@/lib/immediatePersistence';
import { publicAsset } from '@/lib/publicAsset';
import { enrichCalendarEventLabels } from '@/lib/calendarRecordLabels';

function openConsultationAddressInMaps(address: string) {
  const destination = String(address || '').trim();
  if (!destination || /^at shop location$/i.test(destination)) return;
  const url = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(destination)}`;
  try {
    const opened = (window as any).api?.openUrl?.(url);
    if (!opened) window.open(url, '_blank', 'noopener,noreferrer');
  } catch {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}

type CalendarEvent = {
  id?: number;
  date: string;       // YYYY-MM-DD
  time?: string;      // HH:mm
  endTime?: string;   // HH:mm (optional)
  title: string;      // Display title
  category?: 'parts' | 'event' | 'consultation' | 'schedule' | 'content' | 'task';
  // For parts category, refine status for display
  partsStatus?: 'ordered' | 'delivery';
  // Identify source to style differently (e.g., sales vs work order)
  source?: 'sale' | 'workorder' | 'consultation' | 'streaming' | 'content' | 'business-calendar' | 'shift-override' | 'shift-request' | 'schedule-request';
  businessKind?: 'federalHoliday' | 'scTaxFreeWeekend' | 'daylightSaving' | 'estimatedTaxDeadline';
  saleId?: number;
  notes?: string;
  // Optional linkage
  workOrderId?: number;
  workOrderLabel?: string;
  saleLabel?: string;
  partName?: string;
  orderUrl?: string;
  trackingUrl?: string;
  // Optional contact/location details
  customerId?: number;
  customerName?: string;
  customerPhone?: string;
  customerEmail?: string;
  consultationAddress?: string;
  consultationType?: string;
  technician?: string;
  location?: string;
  taskCompleted?: boolean;
  taskCompletedAt?: string;
  taskCompletedBy?: string;
  shiftOverridden?: boolean;
  shiftOverrideId?: number;
  requestKind?: 'time-off' | 'shift-change';
  requestStatus?: 'pending' | 'approved' | 'declined';
  shiftRequestOff?: boolean;
  requestedAt?: string;
  reviewedAt?: string;
  recurrenceRule?: CalendarRecurrenceRule | null;
  recurrenceSeriesId?: number | string;
  recurrenceMaster?: CalendarEvent;
  occurrenceDate?: string;
  // Weekly schedule (for category 'schedule')
  schedule?: {
    mon?: { start?: string; end?: string; off?: boolean };
    tue?: { start?: string; end?: string; off?: boolean };
    wed?: { start?: string; end?: string; off?: boolean };
    thu?: { start?: string; end?: string; off?: boolean };
    fri?: { start?: string; end?: string; off?: boolean };
    sat?: { start?: string; end?: string; off?: boolean };
    sun?: { start?: string; end?: string; off?: boolean };
  };
};

type CalendarNote = {
  id?: number | string;
  date: string;
  subject: string;
  body: string;
  createdAt?: string;
  updatedAt?: string;
};

type CalendarColors = {
  schedule: string;
  partsOrdered: string;
  partsDelivery: string;
  event: string;
  consultation: string;
  streaming: string;
  content: string;
  notes: string;
  task: string;
  federalHoliday: string;
  scTaxFreeWeekend: string;
  daylightSaving: string;
  estimatedTaxDeadline: string;
};

type BusinessCalendarSettings = {
  federalHolidays: boolean;
  scTaxFreeWeekend: boolean;
  daylightSaving: boolean;
  estimatedTaxDeadlines: boolean;
};

type CalendarPreferences = {
  colors?: Partial<CalendarColors>;
  technicianColors?: Record<string, string>;
  businessCalendar?: Partial<BusinessCalendarSettings>;
  icons?: Partial<Record<CalendarIconKey, CalendarIconChoice>>;
};

type CalendarIconKey = keyof CalendarColors;
type CalendarIconChoice = { kind: 'text' | 'image'; value: string };

const DEFAULT_CALENDAR_COLORS: CalendarColors = {
  schedule: '#39FF14',
  partsOrdered: '#3B82F6',
  partsDelivery: '#22C55E',
  event: '#EF4444',
  consultation: '#EAB308',
  streaming: '#D946EF',
  content: '#22D3EE',
  notes: '#FBBF24',
  task: '#A78BFA',
  federalHoliday: '#F43F5E',
  scTaxFreeWeekend: '#22C55E',
  daylightSaving: '#38BDF8',
  estimatedTaxDeadline: '#FB923C',
};

const DEFAULT_BUSINESS_CALENDAR_SETTINGS: BusinessCalendarSettings = {
  federalHolidays: true,
  scTaxFreeWeekend: true,
  daylightSaving: true,
  estimatedTaxDeadlines: false,
};

const DEFAULT_CALENDAR_ICONS: Record<CalendarIconKey, CalendarIconChoice> = {
  schedule: { kind: 'text', value: 'S' },
  partsOrdered: { kind: 'text', value: 'O' },
  partsDelivery: { kind: 'text', value: 'D' },
  event: { kind: 'text', value: 'E' },
  consultation: { kind: 'text', value: 'C' },
  streaming: { kind: 'text', value: 'V' },
  content: { kind: 'text', value: 'R' },
  notes: { kind: 'text', value: 'N' },
  task: { kind: 'text', value: 'K' },
  federalHoliday: { kind: 'text', value: 'H' },
  scTaxFreeWeekend: { kind: 'text', value: 'T' },
  daylightSaving: { kind: 'text', value: 'D' },
  estimatedTaxDeadline: { kind: 'text', value: '$' },
};

function calendarIconKey(ev: CalendarEvent): CalendarIconKey {
  if (ev.businessKind) return ev.businessKind;
  if (ev.category === 'parts') return ev.partsStatus === 'delivery' || !ev.partsStatus ? 'partsDelivery' : 'partsOrdered';
  if (ev.category === 'consultation') return 'consultation';
  if (ev.category === 'schedule') return 'schedule';
  if (ev.category === 'task') return 'task';
  if (ev.category === 'content') return ev.source === 'streaming' ? 'streaming' : 'content';
  return 'event';
}

function CalendarIconContent({ event, icons, fallback }: { event: CalendarEvent; icons: Record<CalendarIconKey, CalendarIconChoice>; fallback: string }) {
  const choice = icons[calendarIconKey(event)];
  if (choice?.kind === 'image' && /^data:image\//i.test(choice.value)) {
    return <img src={choice.value} alt="" className="h-[75%] w-[75%] object-contain" />;
  }
  return <>{choice?.value || fallback}</>;
}

function nthWeekdayOfMonth(year: number, month: number, weekday: number, nth: number) {
  const first = new Date(year, month, 1, 12, 0, 0, 0);
  return new Date(year, month, 1 + ((7 + weekday - first.getDay()) % 7) + ((nth - 1) * 7), 12, 0, 0, 0);
}

function lastWeekdayOfMonth(year: number, month: number, weekday: number) {
  const last = new Date(year, month + 1, 0, 12, 0, 0, 0);
  return new Date(year, month, last.getDate() - ((7 + last.getDay() - weekday) % 7), 12, 0, 0, 0);
}

function observedFederalDate(date: Date) {
  if (date.getDay() === 6) return addDays(date, -1);
  if (date.getDay() === 0) return addDays(date, 1);
  return date;
}

function federalHolidayDates(year: number) {
  return [
    { title: "New Year's Day", actual: new Date(year, 0, 1, 12) },
    { title: 'Martin Luther King Jr. Day', actual: nthWeekdayOfMonth(year, 0, 1, 3) },
    { title: "Washington's Birthday", actual: nthWeekdayOfMonth(year, 1, 1, 3) },
    { title: 'Memorial Day', actual: lastWeekdayOfMonth(year, 4, 1) },
    { title: 'Juneteenth National Independence Day', actual: new Date(year, 5, 19, 12) },
    { title: 'Independence Day', actual: new Date(year, 6, 4, 12) },
    { title: 'Labor Day', actual: nthWeekdayOfMonth(year, 8, 1, 1) },
    { title: 'Columbus Day', actual: nthWeekdayOfMonth(year, 9, 1, 2) },
    { title: 'Veterans Day', actual: new Date(year, 10, 11, 12) },
    { title: 'Thanksgiving Day', actual: nthWeekdayOfMonth(year, 10, 4, 4) },
    { title: 'Christmas Day', actual: new Date(year, 11, 25, 12) },
  ].map(item => ({ ...item, observed: observedFederalDate(item.actual) }));
}

function nextBusinessDay(date: Date, federalObserved: Set<string>) {
  let result = new Date(date);
  while (result.getDay() === 0 || result.getDay() === 6 || federalObserved.has(fmtDate(result))) result = addDays(result, 1);
  return result;
}

function buildBusinessCalendarEvents(years: number[], settings: BusinessCalendarSettings): CalendarEvent[] {
  const entries: CalendarEvent[] = [];
  const uniqueYears = Array.from(new Set(years));
  for (const year of uniqueYears) {
    const federal = federalHolidayDates(year);
    if (settings.federalHolidays) {
      federal.forEach(({ title, actual, observed }) => entries.push({
        date: fmtDate(observed),
        title: `${title}${fmtDate(actual) === fmtDate(observed) ? '' : ' (observed)'}`,
        category: 'event', source: 'business-calendar', businessKind: 'federalHoliday',
        notes: 'Federal holiday. Confirm shop hours before publishing a closure.',
      }));
    }
    if (settings.scTaxFreeWeekend) {
      const friday = nthWeekdayOfMonth(year, 7, 5, 1);
      [0, 1, 2].forEach(offset => entries.push({
        date: fmtDate(addDays(friday, offset)),
        title: `SC Tax-Free Weekend${offset === 0 ? ' begins' : offset === 2 ? ' ends' : ''}`,
        category: 'event', source: 'business-calendar', businessKind: 'scTaxFreeWeekend',
        notes: 'South Carolina annual sales tax holiday. Confirm eligible products and reporting guidance with SCDOR.',
      }));
    }
    if (settings.daylightSaving) {
      entries.push({ date: fmtDate(nthWeekdayOfMonth(year, 2, 0, 2)), title: 'Daylight Saving Time begins', time: '02:00', category: 'event', source: 'business-calendar', businessKind: 'daylightSaving', notes: 'Clocks move forward one hour at 2:00 AM local time.' });
      entries.push({ date: fmtDate(nthWeekdayOfMonth(year, 10, 0, 1)), title: 'Daylight Saving Time ends', time: '02:00', category: 'event', source: 'business-calendar', businessKind: 'daylightSaving', notes: 'Clocks move back one hour at 2:00 AM local time.' });
    }
    if (settings.estimatedTaxDeadlines) {
      const observed = new Set(federal.map(item => fmtDate(item.observed)));
      const deadlines = [
        { date: new Date(year, 0, 15, 12), title: 'Estimated tax payment due (Q4 prior year)' },
        { date: new Date(year, 3, 15, 12), title: 'Estimated tax payment due (Q1)' },
        { date: new Date(year, 5, 15, 12), title: 'Estimated tax payment due (Q2)' },
        { date: new Date(year, 8, 15, 12), title: 'Estimated tax payment due (Q3)' },
      ];
      deadlines.forEach(item => entries.push({ date: fmtDate(nextBusinessDay(item.date, observed)), title: item.title, category: 'event', source: 'business-calendar', businessKind: 'estimatedTaxDeadline', notes: 'General calendar-year reminder only. Verify the applicable deadline with your accountant or current IRS guidance.' }));
    }
  }
  return entries;
}

function calendarEventVisual(ev: CalendarEvent, colors: CalendarColors = DEFAULT_CALENDAR_COLORS) {
  if (ev.businessKind) {
    const businessVisuals = {
      federalHoliday: { short: 'HOL', letter: 'H', color: colors.federalHoliday, label: 'Federal holiday' },
      scTaxFreeWeekend: { short: 'SC', letter: 'T', color: colors.scTaxFreeWeekend, label: 'SC tax-free weekend' },
      daylightSaving: { short: 'DST', letter: 'D', color: colors.daylightSaving, label: 'Daylight saving time' },
      estimatedTaxDeadline: { short: 'TAX', letter: '$', color: colors.estimatedTaxDeadline, label: 'Tax reminder' },
    };
    return businessVisuals[ev.businessKind];
  }
  if (ev.category === 'content') {
    const streaming = ev.source === 'streaming';
    return {
      short: streaming ? 'LIVE' : 'REC',
      letter: streaming ? 'V' : 'R',
      color: streaming ? colors.streaming : colors.content,
      label: streaming ? 'Streaming' : 'Content recording',
    };
  }
  if (ev.category === 'consultation') return { short: 'CONS', letter: 'C', color: colors.consultation, label: 'Consultation' };
  if (ev.category === 'task') return { short: 'TASK', letter: 'K', color: colors.task, label: taskIsCompleted(ev) ? 'Completed task' : 'Task' };
  if (ev.category === 'parts') {
    const delivery = ev.partsStatus === 'delivery' || !ev.partsStatus;
    return { short: delivery ? 'DUE' : 'ORD', letter: delivery ? 'D' : 'O', color: delivery ? colors.partsDelivery : colors.partsOrdered, label: delivery ? 'Expected delivery' : 'Part ordered' };
  }
  if (ev.category === 'schedule') return { short: 'SHIFT', letter: 'S', color: colors.schedule, label: 'Technician schedule' };
  return { short: 'EVENT', letter: 'E', color: colors.event, label: 'Event' };
}

function fmtDate(d: Date) {
  // Format YYYY-MM-DD in LOCAL time to avoid UTC shifting around DST/timezones
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function startOfMonth(date: Date) {
  // Local time month start at midnight
  return new Date(date.getFullYear(), date.getMonth(), 1, 0, 0, 0, 0);
}
function endOfMonth(date: Date) {
  // Local time month end (last day of current month)
  return new Date(date.getFullYear(), date.getMonth() + 1, 0, 0, 0, 0, 0);
}
function addDays(d: Date, days: number) {
  // Add days in local time to avoid DST glitches
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + days, d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds());
}

function activeShiftEvents(day: Date, events: CalendarEvent[]) {
  const dayKey = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][day.getDay()] as keyof NonNullable<CalendarEvent['schedule']>;
  return events.filter((event) => {
    const shift = event.category === 'schedule' ? event.schedule?.[dayKey] : null;
    return Boolean(shift && !shift.off && (shift.start || shift.end));
  });
}

const Cell: React.FC<{ day: Date; events: CalendarEvent[]; notes: CalendarNote[]; notesVisible: boolean; tasksVisible: boolean; colors: CalendarColors; icons: Record<CalendarIconKey, CalendarIconChoice>; technicianColors: Record<string, string>; onPick: (day: Date) => void; onOpenBudget: (day: Date) => void; onOpenGroup: (events: CalendarEvent[]) => void; onContextGroup: (event: React.MouseEvent, events: CalendarEvent[]) => void; onOpenNotes: (day: Date) => void; onOpenTasks: (day: Date, tasks: CalendarEvent[]) => void; onOpenShifts: (day: Date) => void; isToday?: boolean }>
  = ({ day, events, notes, notesVisible, tasksVisible, colors, icons, technicianColors, onPick, onOpenBudget, onOpenGroup, onContextGroup, onOpenNotes, onOpenTasks, onOpenShifts, isToday }) => {
  const dayNum = day.getDate();
  function blipFor(ev: CalendarEvent) {
    // Letter & color by type
    if (ev.businessKind) {
      const visual = calendarEventVisual(ev, colors);
      return { letter: visual.letter, color: visual.color, title: visual.label + ': ' + ev.title };
    }
    if (ev.category === 'event') return { letter: 'E', color: colors.event, title: `${formatTime12FromHHmm(ev.time || '')} ${ev.title}`.trim() };
    if (ev.category === 'parts') {
      const status = ev.partsStatus || 'ordered';
      const isSale = ev.source === 'sale';
      const colorDelivery = isSale ? colors.content : colors.partsDelivery;
      const colorOrdered = isSale ? colors.content : colors.partsOrdered;
      if (status === 'delivery') return { letter: 'D', color: colorDelivery, title: `${formatTime12FromHHmm(ev.time || '')} Est. Delivery ${ev.partName || ev.title || ''}`.trim() };
      return { letter: 'O', color: colorOrdered, title: `${formatTime12FromHHmm(ev.time || '')} Ordered ${ev.partName || ev.title || ''}`.trim() };
    }
    if (ev.category === 'consultation') return { letter: 'C', color: colors.consultation, title: `${formatTime12FromHHmm(ev.time || '')} Consult ${ev.customerName || ''} ${ev.title || ''}`.trim() };
    if (ev.category === 'task') return { letter: taskIsCompleted(ev) ? 'X' : 'K', color: colors.task, title: `${taskIsCompleted(ev) ? 'Completed' : 'Task'}: ${ev.title || 'Untitled task'}` };
    if (ev.category === 'content') {
      const visual = calendarEventVisual(ev);
      return { letter: visual.letter, color: visual.color, title: `${formatTime12FromHHmm(ev.time || '')} ${visual.label}: ${ev.title || ''}`.trim() };
    }
    if (ev.category === 'schedule') {
      // Show technician schedule for the current day
      const dayNames = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
      const dayKey = dayNames[day.getDay()] as keyof NonNullable<CalendarEvent['schedule']>;
      const daySchedule = ev.schedule?.[dayKey];
      
      if (daySchedule?.off) {
        return { letter: 'X', color: '#71717A', title: `${ev.technician} - Off` };
      } else if (daySchedule?.start && daySchedule?.end) {
        const startTime = formatTime12FromHHmm(daySchedule.start);
        const endTime = formatTime12FromHHmm(daySchedule.end);
        return { letter: 'T', color: technicianColors[ev.technician || ''] || colors.schedule, title: `${ev.technician}: ${startTime} - ${endTime}` };
      }
      return null; // No schedule for this day
    }
    return { letter: ev.title?.[0]?.toUpperCase?.() || '?', color: '#71717A', title: ev.title || '' };
  }
  // Separate schedule and other events
  const scheduleEvents = events.filter(ev => ev.category === 'schedule');
  const shiftsChanged = scheduleEvents.some(ev => ev.shiftOverridden);
  const tasks = events.filter(ev => ev.category === 'task');
  const openTasks = tasks.filter(task => !taskIsCompleted(task));
  const otherEvents = events.filter(ev => ev.category !== 'schedule' && ev.category !== 'task');
  const activeShifts = activeShiftEvents(day, scheduleEvents);
  const groupedEvents = Array.from(otherEvents.reduce((groups, event) => {
    const key = calendarEventGroupKey(event);
    const existing = groups.get(key) || [];
    existing.push(event);
    groups.set(key, existing);
    return groups;
  }, new Map<string, CalendarEvent[]>()).values());

  return (
    <div className="gb-calendar-cell p-2 h-full min-h-0 flex flex-col overflow-hidden">
      <div className="gb-calendar-cell-toolbar text-sm text-zinc-400 flex items-center justify-between mb-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <div className={isToday ? 'inline-flex items-center justify-center w-7 h-7 rounded-full border-2 border-[#39FF14] text-[#39FF14] font-bold text-sm' : 'font-medium'}>{dayNum}</div>
          {scheduleEvents.length ? <button type="button" className={`shrink-0 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-bold ${shiftsChanged ? 'border border-red-400/80 bg-red-500/15 text-red-100' : 'border border-[#39FF14]/70 bg-[#39FF14]/10 text-[#d9ffd2] hover:bg-[#39FF14]/20'}`} title={shiftsChanged ? 'Shift change saved for this day' : `Show ${activeShifts.length} active shift${activeShifts.length === 1 ? '' : 's'}`} onClick={() => onOpenShifts(day)}><span className={`inline-flex h-3.5 w-3.5 items-center justify-center rounded-sm text-[8px] text-zinc-950 ${shiftsChanged ? 'bg-red-500' : 'bg-[#39FF14]'}`}>S</span>{activeShifts.length}</button> : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button type="button" className="text-xs px-2 py-0.5 bg-violet-700 border border-violet-500 rounded text-white hover:bg-violet-600 transition-colors" onClick={() => onOpenBudget(day)}>Budget</button>
          <button className="text-xs px-2 py-0.5 bg-zinc-800 border border-zinc-700 rounded hover:bg-zinc-700 transition-colors" onClick={() => onPick(day)}>+ Add</button>
        </div>
      </div>
      
      <div className="flex-1 min-h-0" />
      
      {/* Other event icons at bottom */}
      {groupedEvents.length > 0 && (
        <div className="gb-calendar-cell-events flex flex-wrap gap-1 mt-1 pt-1 border-t border-zinc-700">
          {groupedEvents.map((group) => {
            const ev = group[0];
            const b = blipFor(ev);
            if (!b) return null;
            return (
              <button
                type="button"
                key={calendarEventGroupKey(ev)}
                title={group.length > 1 ? `${group.length} ${calendarEventVisual(ev, colors).label} entries` : b.title}
                onClick={() => onOpenGroup(group)}
                onContextMenu={(event) => onContextGroup(event, group)}
                className="relative w-6 h-6 rounded-md text-black font-bold text-[10px] flex items-center justify-center cursor-pointer shadow-md hover:brightness-110 border border-black/10 transition-all hover:scale-105"
                style={{ backgroundColor: b.color }}
              >
                <CalendarIconContent event={ev} icons={icons} fallback={b.letter} />
                {group.length > 1 ? <span className="absolute -right-1.5 -top-1.5 inline-flex min-w-4 h-4 items-center justify-center rounded-full bg-white px-1 text-[9px] font-black text-zinc-950 shadow">{group.length}</span> : null}
              </button>
            );
          })}
        </div>
      )}
      {groupedEvents.length > 0 && <button type="button" className="gb-calendar-cell-events-compact" onClick={() => onOpenGroup(otherEvents)} title="View all entries for this date">{otherEvents.length} entries</button>}
      {(notesVisible || tasksVisible) && <div className={`gb-calendar-day-actions mt-2 grid gap-1 ${notesVisible && tasksVisible ? 'grid-cols-2' : 'grid-cols-1'}`}>
        {notesVisible && <button
            type="button"
            onClick={() => onOpenNotes(day)}
            title={notes.length ? notes.map(note => note.subject).filter(Boolean).join('\n') : 'No notes for this day. Click to add one.'}
            className={`min-h-9 min-w-0 border rounded px-1.5 py-1.5 text-sm font-semibold transition-colors ${notes.length ? 'text-black hover:brightness-110' : 'border-zinc-700 bg-zinc-800 text-zinc-300 hover:bg-zinc-700'}`}
            style={notes.length ? { borderColor: colors.notes, backgroundColor: colors.notes } : undefined}
          >
            Notes{notes.length ? ` (${notes.length})` : ''}
          </button>}
        {tasksVisible && <button
            type="button"
            onClick={() => onOpenTasks(day, tasks)}
            title={tasks.length ? `${openTasks.length} open, ${tasks.length - openTasks.length} completed` : 'No tasks for this day. Click to add one.'}
            className={`min-h-9 min-w-0 border rounded px-1.5 py-1.5 text-sm font-semibold transition-colors ${tasks.length ? 'text-black hover:brightness-110' : 'border-zinc-700 bg-zinc-800 text-zinc-300 hover:bg-zinc-700'}`}
            style={tasks.length ? { borderColor: colors.task, backgroundColor: colors.task } : undefined}
          >
            Tasks{tasks.length ? ` (${openTasks.length}/${tasks.length})` : ''}
          </button>}
      </div>}
    </div>
  );
};

const CalendarWindow: React.FC = () => {
  const calendarPayload = useMemo(() => consumeWindowPayload('calendar'), []);
  const targetEventId = useMemo(() => {
    const queryId = new URLSearchParams(window.location.search).get('calendarEventId');
    return Number(calendarPayload?.calendarEventId || queryId || 0) || 0;
  }, [calendarPayload]);
  const targetNoteId = useMemo(() => String(calendarPayload?.calendarNoteId || ''), [calendarPayload]);
  const targetOpenedRef = useRef(false);
  const [current, setCurrent] = useState<Date>(new Date());
  const [calendarView, setCalendarView] = useState<'day' | 'week' | 'month'>('month');
  const [isMobileCalendar, setIsMobileCalendar] = useState(false);
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [calendarNotes, setCalendarNotes] = useState<CalendarNote[]>([]);
  const [notesDate, setNotesDate] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState({ subject: '', body: '' });
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [noteSaving, setNoteSaving] = useState(false);
  const [noteSaveError, setNoteSaveError] = useState('');
  const [editing, setEditing] = useState<CalendarEvent | null>(null);
  const [taskQueue, setTaskQueue] = useState<CalendarEvent[]>([]);
  const [taskBatchSaving, setTaskBatchSaving] = useState(false);
  const [taskBatchError, setTaskBatchError] = useState('');
  const [notesExpanded, setNotesExpanded] = useState(false);
  const [contentEditorLocked, setContentEditorLocked] = useState(false);
  const [viewing, setViewing] = useState<CalendarEvent | null>(null);
  const [viewingGroup, setViewingGroup] = useState<CalendarEvent[] | null>(null);
  const [shiftDay, setShiftDay] = useState<string | null>(null);
  const [shiftChangeEditing, setShiftChangeEditing] = useState(false);
  const [shiftDrafts, setShiftDrafts] = useState<Record<string, { start: string; end: string; off: boolean }>>({});
  const [shiftSaving, setShiftSaving] = useState(false);
  const [shiftSaveError, setShiftSaveError] = useState('');
  const [requestType, setRequestType] = useState<'time-off' | 'shift-change' | null>(null);
  const [requestDraft, setRequestDraft] = useState({ technician: '', date: fmtDate(new Date()), start: '', end: '' });
  const [requestSaving, setRequestSaving] = useState(false);
  const [requestError, setRequestError] = useState('');
  const [shiftRequestOpen, setShiftRequestOpen] = useState(false);
  const [shiftRequestDraft, setShiftRequestDraft] = useState({ technician: '', date: fmtDate(new Date()), off: true, start: '', end: '', reason: '' });
  const [shiftRequestSaving, setShiftRequestSaving] = useState(false);
  const [shiftRequestError, setShiftRequestError] = useState('');
  const [contentScheduleOpen, setContentScheduleOpen] = useState(false);
  const [dailyLookOpen, setDailyLookOpen] = useState<boolean>(() => Boolean(calendarPayload?.dailyLook));
  const [dailyLookDate, setDailyLookDate] = useState<string>(fmtDate(new Date()));
  const [dailyLookAssignedTo, setDailyLookAssignedTo] = useState<string>('');
  const [calendarColors, setCalendarColors] = useState<CalendarColors>(DEFAULT_CALENDAR_COLORS);
  const [savedCalendarColors, setSavedCalendarColors] = useState<CalendarColors>(DEFAULT_CALENDAR_COLORS);
  const [technicianColors, setTechnicianColors] = useState<Record<string, string>>({});
  const [savedTechnicianColors, setSavedTechnicianColors] = useState<Record<string, string>>({});
  const [businessCalendar, setBusinessCalendar] = useState<BusinessCalendarSettings>(DEFAULT_BUSINESS_CALENDAR_SETTINGS);
  const [savedBusinessCalendar, setSavedBusinessCalendar] = useState<BusinessCalendarSettings>(DEFAULT_BUSINESS_CALENDAR_SETTINGS);
  const [calendarIcons, setCalendarIcons] = useState<Record<CalendarIconKey, CalendarIconChoice>>(DEFAULT_CALENDAR_ICONS);
  const [savedCalendarIcons, setSavedCalendarIcons] = useState<Record<CalendarIconKey, CalendarIconChoice>>(DEFAULT_CALENDAR_ICONS);
  const [calendarSettingsOpen, setCalendarSettingsOpen] = useState(false);
  const [calendarSettingsSaving, setCalendarSettingsSaving] = useState(false);
  const [shopSettingsRecord, setShopSettingsRecord] = useState<any>({});
  const [budgetDate, setBudgetDate] = useState<string | null>(null);
  const [budgetDraft, setBudgetDraft] = useState('');
  const [budgetSaving, setBudgetSaving] = useState(false);
  const [budgetMessage, setBudgetMessage] = useState('');
  // For adding multiple estimated delivery dates in one go (parts only)
  const [deliveryDates, setDeliveryDates] = useState<string[]>([]);
  const [deliveryDateInput, setDeliveryDateInput] = useState<string>('');
  // Live technicians for deriving schedules
  const [techs, setTechs] = useState<any[]>([]);
  const calendarContext = useContextMenu<CalendarEvent[]>();
  
  // Event type filters
  const [filters, setFilters] = useState({
    schedule: true,
    parts: true,
    events: true,
    consultation: true,
    content: true,
    tasks: true,
    notes: true,
  });

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const [settingsRows, legacyRows] = await Promise.all([
          (window as any).api.dbGet('settings').catch(() => []),
          (window as any).api.dbGet('calendarPreferences').catch(() => []),
        ]);
        const shopSettings = Array.isArray(settingsRows) ? settingsRows[0] : null;
        if (active) setShopSettingsRecord(shopSettings || {});
        const legacy = Array.isArray(legacyRows) ? legacyRows[0] : null;
        const stored = (shopSettings?.calendarPreferences || legacy) as CalendarPreferences | null;
        if (!active || !stored) return;
        const colors = { ...DEFAULT_CALENDAR_COLORS, ...(stored.colors && typeof stored.colors === 'object' ? stored.colors : {}) };
        setCalendarColors(colors);
        setSavedCalendarColors(colors);
        const savedTechnicians = stored?.technicianColors && typeof stored.technicianColors === 'object' ? stored.technicianColors : {};
        setTechnicianColors(savedTechnicians);
        setSavedTechnicianColors(savedTechnicians);
        const savedBusiness = { ...DEFAULT_BUSINESS_CALENDAR_SETTINGS, ...(stored?.businessCalendar && typeof stored.businessCalendar === 'object' ? stored.businessCalendar : {}) };
        setBusinessCalendar(savedBusiness);
        setSavedBusinessCalendar(savedBusiness);
        const savedIcons = { ...DEFAULT_CALENDAR_ICONS, ...(stored?.icons && typeof stored.icons === 'object' ? stored.icons : {}) };
        setCalendarIcons(savedIcons);
        setSavedCalendarIcons(savedIcons);
      } catch {
        // Calendar presentation uses defaults until preferences can be read.
      }
    })();
    return () => { active = false; };
  }, []);

  const saveCalendarSettings = async () => {
    setCalendarSettingsSaving(true);
    try {
      const rows = await (window as any).api.dbGet('settings');
      const existing = Array.isArray(rows) ? rows[0] : null;
      const now = new Date().toISOString();
      const calendarPreferences = { colors: calendarColors, technicianColors, businessCalendar, icons: calendarIcons, updatedAt: now };
      const payload = { ...(existing || {}), calendarPreferences, updatedAt: now };
      if (existing?.id != null) await (window as any).api.dbUpdate('settings', existing.id, payload);
      else await (window as any).api.dbAdd('settings', { ...payload, id: 1, createdAt: now });
      setSavedCalendarColors(calendarColors);
      setSavedTechnicianColors(technicianColors);
      setSavedBusinessCalendar(businessCalendar);
      setSavedCalendarIcons(calendarIcons);
      setCalendarSettingsOpen(false);
    } finally {
      setCalendarSettingsSaving(false);
    }
  };

  const openBudgetEditor = (day: Date) => {
    const dayKey = fmtDate(day);
    const budgets = shopSettingsRecord?.dailyPurchaseBudgets;
    const value = budgets && typeof budgets === 'object' && !Array.isArray(budgets) ? budgets[dayKey] : undefined;
    setBudgetDate(dayKey);
    setBudgetDraft(value == null ? '' : Number(value).toFixed(2));
    setBudgetMessage('');
  };

  const saveDailyBudget = async (nextValue?: string) => {
    if (!budgetDate) return;
    const trimmed = (nextValue ?? budgetDraft).trim();
    const parsed = Number(trimmed);
    if (trimmed && (!Number.isFinite(parsed) || parsed < 0)) {
      setBudgetMessage('Enter a valid budget of zero or more.');
      return;
    }
    setBudgetSaving(true);
    setBudgetMessage('');
    try {
      const api = (window as any).api || {};
      const rows = await api.dbGet?.('settings').catch(() => []);
      const current = (Array.isArray(rows) ? rows[0] : rows) || shopSettingsRecord || {};
      const nextBudgets = { ...(current.dailyPurchaseBudgets && typeof current.dailyPurchaseBudgets === 'object' ? current.dailyPurchaseBudgets : {}) };
      if (trimmed) nextBudgets[budgetDate] = Math.round(parsed * 100) / 100;
      else delete nextBudgets[budgetDate];
      const now = new Date().toISOString();
      const payload = { ...current, dailyPurchaseBudgets: nextBudgets, updatedAt: now };
      const saved = current.id != null
        ? await api.dbUpdate?.('settings', current.id, payload)
        : await api.dbAdd?.('settings', { ...payload, id: 1, createdAt: now });
      if (!saved) throw new Error('The budget could not be saved.');
      setShopSettingsRecord(saved);
      setBudgetMessage(trimmed ? 'Daily cart budget saved and synced.' : 'Daily cart budget cleared.');
      window.setTimeout(() => setBudgetDate(null), 450);
    } catch (error: any) {
      setBudgetMessage(error?.message || 'The daily budget could not be saved.');
    } finally {
      setBudgetSaving(false);
    }
  };

  useEffect(() => {
    if (!editing) setNotesExpanded(false);
  }, [editing]);

  useEffect(() => {
    if (!editing || editing.category !== 'task' || editing.id != null) {
      setTaskQueue([]);
      setTaskBatchError('');
    }
  }, [editing?.category, editing?.id]);

  const visibleTaskAssignments = useMemo(() => {
    if (!editing || editing.category !== 'task') return [];
    const date = String(editing.date || '');
    const technician = String(editing.technician || ALL_TECHNICIANS);
    return events.filter((event) => {
      if (event.category !== 'task' || event.date !== date) return false;
      const assigned = String(event.technician || ALL_TECHNICIANS);
      if (isSharedTaskAssignment(technician)) return isSharedTaskAssignment(assigned);
      return taskAssignmentIncludes(assigned, technician);
    });
  }, [editing, events]);

  const taskSaveCount = useMemo(
    () => tasksPendingSave(taskQueue, editing?.category === 'task' ? editing : null).length,
    [editing, taskQueue],
  );

  useEffect(() => {
    if (!targetEventId || targetOpenedRef.current || !events.length) return;
    const target = events.find((event) => Number(event.id) === targetEventId);
    if (!target) return;
    targetOpenedRef.current = true;
    setCurrent(new Date(`${target.date}T12:00:00`));
    setViewing(target);
  }, [events, targetEventId]);

  useEffect(() => {
    if (!targetNoteId || targetOpenedRef.current || !calendarNotes.length) return;
    const target = calendarNotes.find(note => String(note.id) === targetNoteId);
    if (!target) return;
    targetOpenedRef.current = true;
    setCurrent(new Date(`${target.date}T12:00:00`));
    setNotesDate(target.date);
    setEditingNoteId(String(target.id));
    setNoteDraft({ subject: target.subject || '', body: target.body || '' });
  }, [calendarNotes, targetNoteId]);

  useEffect(() => {
    const detect = () => {
      const mobile = /mobile\.html$/i.test(window.location.pathname) || !!document.querySelector('.gbpos-mobile');
      setIsMobileCalendar(mobile);
      if (mobile) setCalendarView((view) => view === 'month' ? 'week' : view);
    };
    detect();
    window.addEventListener('resize', detect);
    return () => window.removeEventListener('resize', detect);
  }, []);

  async function resolveConsultationLinks(ev: CalendarEvent) {
    const api: any = (window as any).api;
    let sale: any = null;
    const eventSaleId = Number((ev as any).saleId || 0) || 0;
    if (eventSaleId > 0 && api?.dbGet) {
      try {
        const sales = await api.dbGet('sales');
        sale = Array.isArray(sales) ? sales.find((s: any) => Number(s?.id || 0) === eventSaleId) || null : null;
      } catch {}
    }

    let customerId = Number((ev as any).customerId || 0) || Number(sale?.customerId || 0) || 0;
    let customerName = String(sale?.customerName || ev.customerName || '').trim();
    let customerPhone = String(sale?.customerPhone || ev.customerPhone || '').trim();

    // Fallback: try to resolve customer by exact phone/name when event has no customerId.
    if (!customerId && api?.dbGet) {
      try {
        const customers = await api.dbGet('customers');
        const needlePhone = String(ev.customerPhone || '').replace(/\D+/g, '').slice(-10);
        const needleName = String(ev.customerName || '').trim().toLowerCase();
        const found = Array.isArray(customers) ? customers.find((c: any) => {
          const cPhone = String(c?.phone || '').replace(/\D+/g, '').slice(-10);
          const cPhoneAlt = String(c?.phoneAlt || '').replace(/\D+/g, '').slice(-10);
          const cName = String(([c?.firstName, c?.lastName].filter(Boolean).join(' ') || c?.name || '')).trim().toLowerCase();
          const phoneMatch = !!needlePhone && (cPhone === needlePhone || cPhoneAlt === needlePhone);
          const nameMatch = !!needleName && !!cName && cName === needleName;
          return phoneMatch || nameMatch;
        }) : null;
        if (found) {
          customerId = Number(found.id || 0) || 0;
          if (!customerName) customerName = String(([found.firstName, found.lastName].filter(Boolean).join(' ') || found.name || '')).trim();
          if (!customerPhone) customerPhone = String(found.phone || '').trim();
        }
      } catch {}
    }

    return {
      sale,
      saleId: Number(sale?.id || eventSaleId || 0) || 0,
      customerId,
      customerName,
      customerPhone,
    };
  }

  async function openConsultationSale(ev: CalendarEvent) {
    const api: any = (window as any).api;
    const links = await resolveConsultationLinks(ev);
    if (!links.saleId) {
      alert('No linked sale found for this consultation event.');
      return;
    }
    if (!api?.openNewSale) return;
    await api.openNewSale({
      id: links.saleId,
      customerId: links.customerId || undefined,
      customerName: links.customerName || undefined,
      customerPhone: links.customerPhone || undefined,
    });
  }

  async function openConsultationCustomer(ev: CalendarEvent) {
    const api: any = (window as any).api;
    const links = await resolveConsultationLinks(ev);
    if (!links.customerId) {
      alert('No linked customer found for this consultation event.');
      return;
    }
    if (!api?.openCustomerOverview) return;
    await api.openCustomerOverview(links.customerId);
  }

  // Load events on open
  useEffect(() => {
    let alive = true;
    const refreshNotes = async () => {
      try {
        const list = await (window as any).api.dbGet('calendarNotes');
        if (alive && Array.isArray(list)) setCalendarNotes(list);
      } catch (error) {
        console.error('load calendar notes failed', error);
      }
    };
    const refreshEvents = async () => {
      try {
        const loadCalendarEvents = async () => {
          let lastError: any = null;
          for (let attempt = 0; attempt < 3; attempt += 1) {
            try { return await (window as any).api.dbGet('calendarEvents'); }
            catch (error) {
              lastError = error;
              if (attempt < 2) await new Promise(resolve => window.setTimeout(resolve, 300 * (attempt + 1)));
            }
          }
          throw lastError || new Error('Calendar events could not be loaded.');
        };
        const [list, customers, technicians, workOrders, sales] = await Promise.all([
          loadCalendarEvents(),
          (window as any).api.dbGet('customers').catch(() => []),
          (window as any).api.dbGet('technicians').catch(() => []),
          (window as any).api.dbGet('workOrders').catch(() => []),
          (window as any).api.dbGet('sales').catch(() => []),
        ]);
        const customerById = new Map((Array.isArray(customers) ? customers : []).map((customer: any) => [Number(customer?.id || 0), customer]));
        const linkedEvents = enrichCalendarEventLabels(list, technicians, workOrders, sales);
        const enriched = linkedEvents.map((event: CalendarEvent) => {
          const normalizedEvent = event.category === 'consultation' ? {
            ...event,
            location: consultationLocationDisplay(event),
            consultationAddress: consultationLocationDisplay(event),
          } : event;
          const customer: any = customerById.get(Number(event.customerId || 0));
          if (!customer) return normalizedEvent;
          return {
            ...normalizedEvent,
            customerEmail: normalizedEvent.customerEmail || customer.email || '',
            customerPhone: normalizedEvent.customerPhone || customer.phone || '',
            customerName: normalizedEvent.customerName || [customer.firstName, customer.lastName].filter(Boolean).join(' ').trim(),
          };
        });
        if (alive) setEvents(enriched);
      } catch (e) { console.error('load calendar events failed', e); }
    };
    void refreshEvents();
    void refreshNotes();
    // Live updates
    const api: any = (window as any).api;
    const off = api?.onCalendarEventsChanged?.(() => { void refreshEvents(); });
    const offNotes = api?.onCalendarNotesChanged?.(() => { void refreshNotes(); });
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        void refreshEvents();
        void refreshNotes();
      }
    }, 30_000);
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        void refreshEvents();
        void refreshNotes();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive = false;
      if (off) off();
      if (offNotes) offNotes();
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  // Load technicians for live schedule derivation
  useEffect(() => {
    let mounted = true;
    (async () => {
      try { const l = await listTechnicians(); if (mounted && Array.isArray(l)) setTechs(l as any); } catch {}
    })();
    const api: any = (window as any).api;
    const unsub = api?.onTechniciansChanged?.(async () => {
      try { const l = await listTechnicians(); setTechs(l as any); } catch {}
    });
    return () => { mounted = false; if (unsub) unsub(); };
  }, []);

  const monthDays = useMemo(() => {
    const start = startOfMonth(current);
    const end = endOfMonth(current);
    const startWeekday = start.getDay(); // 0-6
    const days: Date[] = [];
    // leading blanks (previous month fill) so the first week aligns with weekday
    for (let i = 0; i < startWeekday; i++) {
      days.push(addDays(start, i - startWeekday));
    }
    // current month days
    for (let d = 1; d <= end.getDate(); d++) {
      days.push(new Date(current.getFullYear(), current.getMonth(), d));
    }
    // trailing blanks to complete weeks only (no extra full row)
    const remainder = days.length % 7;
    const missing = remainder === 0 ? 0 : (7 - remainder);
    for (let i = 1; i <= missing; i++) {
      days.push(addDays(end, i));
    }
    return days;
  }, [current]);

  const calendarDays = useMemo(() => {
    if (!isMobileCalendar || calendarView === 'month') return monthDays;
    if (calendarView === 'day') return [new Date(current.getFullYear(), current.getMonth(), current.getDate())];
    const start = addDays(current, -current.getDay());
    return Array.from({ length: 7 }, (_, index) => addDays(start, index));
  }, [calendarView, current, isMobileCalendar, monthDays]);

  const businessCalendarEvents = useMemo(() => buildBusinessCalendarEvents(
    [current.getFullYear() - 1, current.getFullYear(), current.getFullYear() + 1],
    businessCalendar,
  ), [businessCalendar, current]);

  const activeTechnicians = useMemo(
    () => techs.filter((item: any) => item?.active !== false && item?.status !== 'disabled'),
    [techs],
  );
  const pendingShiftRequests = useMemo(
    () => events
      .filter(event => event.source === SHIFT_REQUEST_SOURCE && (event.requestStatus || 'pending') === 'pending')
      .sort((a, b) => `${a.date} ${a.time || ''}`.localeCompare(`${b.date} ${b.time || ''}`)),
    [events],
  );

  function openShiftRequestWindow() {
    setShiftRequestError('');
    setShiftRequestDraft(currentDraft => ({
      ...currentDraft,
      technician: currentDraft.technician || (activeTechnicians[0] ? technicianDisplayName(activeTechnicians[0]) : ''),
      date: currentDraft.date || fmtDate(new Date()),
    }));
    setShiftRequestOpen(true);
  }

  async function submitShiftRequest() {
    const api = (window as any).api;
    const technician = activeTechnicians.find((item: any) => technicianDisplayName(item) === shiftRequestDraft.technician);
    if (!api?.dbAdd) return;
    if (!technician) {
      setShiftRequestError('Select a technician.');
      return;
    }
    if (!shiftRequestDraft.date) {
      setShiftRequestError('Select the requested date.');
      return;
    }
    if (!shiftRequestDraft.off && (!shiftRequestDraft.start || !shiftRequestDraft.end)) {
      setShiftRequestError('Enter both requested start and end times, or select OFF for the full day.');
      return;
    }
    if (!shiftRequestDraft.off && toMinutes(shiftRequestDraft.end) <= toMinutes(shiftRequestDraft.start)) {
      setShiftRequestError('The requested end time must be later than the start time.');
      return;
    }
    setShiftRequestSaving(true);
    setShiftRequestError('');
    try {
      const name = technicianDisplayName(technician);
      const payload: CalendarEvent = {
        date: shiftRequestDraft.date,
        title: `${name} - ${shiftRequestDraft.off ? 'Time Off Request' : 'Shift Change Request'}`,
        category: 'schedule',
        source: SHIFT_REQUEST_SOURCE,
        technician: name,
        location: shiftOverrideLocation(technician),
        time: shiftRequestDraft.off ? '' : shiftRequestDraft.start,
        endTime: shiftRequestDraft.off ? '' : shiftRequestDraft.end,
        notes: shiftRequestDraft.reason.trim(),
        shiftRequestOff: shiftRequestDraft.off,
        requestStatus: 'pending',
        requestedAt: new Date().toISOString(),
      };
      const added = await api.dbAdd('calendarEvents', payload);
      if (!added) throw new Error('The time-off request could not be saved.');
      setEvents(currentEvents => [...currentEvents, added]);
      setShiftRequestDraft({ technician: name, date: shiftRequestDraft.date, off: true, start: '', end: '', reason: '' });
    } catch (error: any) {
      setShiftRequestError(error?.message || 'The time-off request could not be saved.');
    } finally {
      setShiftRequestSaving(false);
    }
  }

  async function reviewShiftRequest(request: CalendarEvent, decision: 'approved' | 'declined') {
    const api = (window as any).api;
    if (!api?.dbUpdate || request.id == null) return;
    setShiftRequestSaving(true);
    setShiftRequestError('');
    try {
      const reviewedAt = new Date().toISOString();
      if (decision === 'declined') {
        const declined = await api.dbUpdate('calendarEvents', request.id, { ...request, requestStatus: 'declined', reviewedAt });
        if (!declined) throw new Error('The request could not be declined.');
        setEvents(currentEvents => currentEvents.map(event => event.id === request.id ? declined : event));
        return;
      }

      const existingOverride = events.find(event => isShiftOverrideEvent(event)
        && event.id !== request.id
        && String(event.date || '').slice(0, 10) === String(request.date || '').slice(0, 10)
        && (event.location === request.location || String(event.technician || '').toLowerCase() === String(request.technician || '').toLowerCase()));
      const overridePayload: CalendarEvent = {
        ...(existingOverride || request),
        date: request.date,
        title: `${request.technician || 'Technician'} - Shift Change`,
        category: 'schedule',
        source: SHIFT_OVERRIDE_SOURCE,
        technician: request.technician,
        location: request.location,
        time: request.shiftRequestOff ? '' : request.time,
        endTime: request.shiftRequestOff ? '' : request.endTime,
        notes: request.shiftRequestOff ? 'OFF' : '',
        requestStatus: undefined,
        shiftRequestOff: undefined,
        reviewedAt,
      };
      if (existingOverride?.id != null) {
        const updatedOverride = await api.dbUpdate('calendarEvents', existingOverride.id, overridePayload);
        const approvedRequest = await api.dbUpdate('calendarEvents', request.id, { ...request, requestStatus: 'approved', reviewedAt });
        if (!updatedOverride || !approvedRequest) throw new Error('The approved shift change could not be saved.');
        setEvents(currentEvents => currentEvents.map(event => event.id === existingOverride.id ? updatedOverride : event.id === request.id ? approvedRequest : event));
      } else {
        const approvedOverride = await api.dbUpdate('calendarEvents', request.id, overridePayload);
        if (!approvedOverride) throw new Error('The approved shift change could not be saved.');
        setEvents(currentEvents => currentEvents.map(event => event.id === request.id ? approvedOverride : event));
      }
    } catch (error: any) {
      setShiftRequestError(error?.message || 'The request could not be reviewed.');
    } finally {
      setShiftRequestSaving(false);
    }
  }

  function openShiftDay(dateKey: string) {
    const drafts: Record<string, { start: string; end: string; off: boolean }> = {};
    for (const technician of techs.filter((item: any) => item?.active !== false && item?.status !== 'disabled')) {
      const key = shiftOverrideLocation(technician);
      const shift = effectiveTechnicianShiftForDate(technician, dateKey, events);
      drafts[key] = { start: shift?.start || '', end: shift?.end || '', off: shift?.off === true };
    }
    setShiftDrafts(drafts);
    setShiftSaveError('');
    setShiftChangeEditing(false);
    setShiftDay(dateKey);
  }

  async function saveShiftChanges(dateKey: string) {
    const api = (window as any).api;
    if (!api) return;
    for (const technician of techs.filter((item: any) => item?.active !== false && item?.status !== 'disabled')) {
      const draft = shiftDrafts[shiftOverrideLocation(technician)] || { start: '', end: '', off: false };
      if (!draft.off && Boolean(draft.start) !== Boolean(draft.end)) {
        setShiftSaveError(`Enter both a start and end time for ${technicianDisplayName(technician)}, or mark the technician OFF.`);
        return;
      }
      if (!draft.off && draft.start && draft.end && toMinutes(draft.end) <= toMinutes(draft.start)) {
        setShiftSaveError(`${technicianDisplayName(technician)}'s end time must be later than the start time.`);
        return;
      }
    }

    setShiftSaving(true);
    setShiftSaveError('');
    try {
      const day = new Date(`${dateKey}T12:00:00`);
      const dayKey = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][day.getDay()];
      let nextEvents = [...events];
      for (const technician of techs.filter((item: any) => item?.active !== false && item?.status !== 'disabled')) {
        const identity = shiftOverrideLocation(technician);
        const name = technicianDisplayName(technician);
        const draft = shiftDrafts[identity] || { start: '', end: '', off: false };
        const regular = technician?.schedule?.[dayKey] || {};
        const matchesRegular = draft.off === (regular?.off === true)
          && (draft.off || (String(draft.start || '') === String(regular?.start || '')
            && String(draft.end || '') === String(regular?.end || '')));
        const existing = nextEvents.find(event => isShiftOverrideEvent(event)
          && String(event.date || '').slice(0, 10) === dateKey
          && (event.location === identity || String(event.technician || '').toLowerCase() === name.toLowerCase()));

        if (matchesRegular) {
          if (existing?.id != null && await api.dbDelete('calendarEvents', existing.id)) {
            nextEvents = nextEvents.filter(event => event.id !== existing.id);
          }
          continue;
        }

        const payload: CalendarEvent = {
          ...(existing || {}),
          date: dateKey,
          title: `${name} - Shift Change`,
          category: 'schedule',
          source: SHIFT_OVERRIDE_SOURCE,
          technician: name,
          location: identity,
          time: draft.off ? '' : draft.start,
          endTime: draft.off ? '' : draft.end,
          notes: draft.off ? 'OFF' : '',
        };
        if (existing?.id != null) {
          const updated = await api.dbUpdate('calendarEvents', existing.id, payload);
          if (!updated) throw new Error(`Could not save ${name}'s shift change.`);
          nextEvents = nextEvents.map(event => event.id === existing.id ? updated : event);
        } else {
          const added = await api.dbAdd('calendarEvents', payload);
          if (!added) throw new Error(`Could not save ${name}'s shift change.`);
          nextEvents.push(added);
        }
      }
      setEvents(nextEvents);
      setShiftChangeEditing(false);
    } catch (error: any) {
      setShiftSaveError(error?.message || 'The shift changes could not be saved.');
    } finally {
      setShiftSaving(false);
    }
  }

  const openScheduleRequest = (kind: 'time-off' | 'shift-change') => {
    setRequestType(kind);
    setRequestDraft({ technician: '', date: fmtDate(current), start: '', end: '' });
    setRequestError('');
  };

  const pendingScheduleRequests = useMemo(() => events.filter(event =>
    event.source === 'schedule-request' && event.requestStatus !== 'approved' && event.requestStatus !== 'declined'
  ), [events]);

  useEffect(() => {
    if (requestType !== 'shift-change' || !requestDraft.technician || !requestDraft.date) return;
    const technician = techs.find((item: any) => technicianDisplayName(item) === requestDraft.technician);
    if (!technician) return;
    const regular = effectiveTechnicianShiftForDate(technician, requestDraft.date, events);
    setRequestDraft(draft => ({
      ...draft,
      start: regular?.off ? '' : regular?.start || '',
      end: regular?.off ? '' : regular?.end || '',
    }));
  }, [events, requestDraft.date, requestDraft.technician, requestType, techs]);

  async function submitScheduleRequest() {
    const technician = requestDraft.technician.trim();
    if (!requestType || !technician) {
      setRequestError('Select the technician making this request.');
      return;
    }
    if (!requestDraft.date) {
      setRequestError('Choose the date for this request.');
      return;
    }
    if (!requestDraft.start || !requestDraft.end) {
      setRequestError('Enter both the start and end time.');
      return;
    }
    if (toMinutes(requestDraft.end) <= toMinutes(requestDraft.start)) {
      setRequestError('End time must be later than start time.');
      return;
    }

    setRequestSaving(true);
    setRequestError('');
    try {
      const api = (window as any).api;
      const label = requestType === 'time-off' ? 'Time Off Request' : 'Shift Change Request';
      const now = new Date().toISOString();
      const payload: CalendarEvent = {
        date: requestDraft.date,
        time: requestDraft.start,
        endTime: requestDraft.end,
        title: `${technician} - ${label}`,
        category: 'schedule',
        source: 'schedule-request',
        technician,
        requestKind: requestType,
        requestStatus: 'pending',
        notes: requestType === 'time-off'
          ? `Requested absence from ${formatTime12FromHHmm(requestDraft.start)} to ${formatTime12FromHHmm(requestDraft.end)}.`
          : `Requested adjusted shift hours: ${formatTime12FromHHmm(requestDraft.start)} to ${formatTime12FromHHmm(requestDraft.end)}.`,
      };
      const added = await api?.dbAdd?.('calendarEvents', payload);
      if (!added) throw new Error('The request could not be saved.');
      await api?.dbAdd?.('notifications', {
        key: `schedule-request:${added.id || `${requestDraft.date}:${technician}:${Date.now()}`}`,
        kind: 'tech_schedule',
        title: label,
        message: `${technician} requested ${formatTime12FromHHmm(requestDraft.start)}–${formatTime12FromHHmm(requestDraft.end)} on ${new Date(`${requestDraft.date}T12:00:00`).toLocaleDateString()}.`,
        createdAt: now,
        eventAt: `${requestDraft.date}T${requestDraft.start}:00`,
        calendarEventId: added.id,
        date: requestDraft.date,
        time: requestDraft.start,
        source: 'calendar',
        readAt: null,
      });
      setEvents(currentEvents => [...currentEvents, added]);
      setRequestType(null);
    } catch (error: any) {
      setRequestError(error?.message || 'The request could not be submitted.');
    } finally {
      setRequestSaving(false);
    }
  }

  const eventsByDay = useMemo(() => {
    const map: Record<string, CalendarEvent[]> = {};
    const firstVisibleDate = calendarDays.length ? fmtDate(calendarDays[0]) : fmtDate(current);
    const lastVisibleDate = calendarDays.length ? fmtDate(calendarDays[calendarDays.length - 1]) : firstVisibleDate;
    const visibleEvents = events.flatMap((event) => event.recurrenceRule
      ? expandRecurringEvent(event, firstVisibleDate, lastVisibleDate) as CalendarEvent[]
      : [event]);
    
    // Process regular events
    for (const ev of visibleEvents) {
      if (ev.category !== 'schedule') {
        // Apply filters
        const shouldShow = 
          (ev.category === 'parts' && filters.parts) ||
          (ev.category === 'event' && filters.events) ||
          (ev.category === 'consultation' && filters.consultation) ||
          (ev.category === 'content' && filters.content) ||
          (ev.category === 'task' && filters.tasks);
          
        if (shouldShow) {
          const k = ev.date;
          if (!map[k]) map[k] = [];
          map[k].push(ev);
        }
      }
    }

    if (filters.events) {
      for (const ev of businessCalendarEvents) {
        const k = ev.date;
        if (!map[k]) map[k] = [];
        map[k].push(ev);
      }
    }
    
    // Resolve date-specific calendar overrides over the master technician schedule.
    if (filters.schedule && Array.isArray(techs) && techs.length) {
      const dayNames = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
      calendarDays.forEach(day => {
        const k = fmtDate(day);
        for (const t of techs) {
          const dayKey = dayNames[day.getDay()] as keyof NonNullable<CalendarEvent['schedule']>;
          const effective = effectiveTechnicianShiftForDate(t, k, events);
          if (!effective) continue;
          const sd = { start: effective.start, end: effective.end, off: effective.off };
          // Show line if off or has start/end
          if (sd.off || (sd.start && sd.end)) {
            if (!map[k]) map[k] = [];
            const techName = technicianDisplayName(t);
            const ev: CalendarEvent = {
              date: k,
              title: `${techName} - Work Schedule`,
              category: 'schedule',
              technician: techName,
              schedule: { [dayKey]: sd },
              shiftOverridden: effective.overridden,
              shiftOverrideId: typeof effective.overrideId === 'number' ? effective.overrideId : undefined,
            };
            map[k].push(ev);
          }
        }
      });
    }
    
    return map;
  }, [businessCalendarEvents, calendarDays, events, filters, techs]);

  const notesByDay = useMemo(() => {
    const map: Record<string, CalendarNote[]> = {};
    for (const note of calendarNotes) {
      const key = String(note?.date || '').slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) continue;
      if (!map[key]) map[key] = [];
      map[key].push(note);
    }
    for (const list of Object.values(map)) {
      list.sort((left, right) => String(left.createdAt || '').localeCompare(String(right.createdAt || '')));
    }
    return map;
  }, [calendarNotes]);

  function openNotes(day: Date) {
    setNotesDate(fmtDate(day));
    setNoteDraft({ subject: '', body: '' });
    setEditingNoteId(null);
  }

  async function saveNote() {
    const date = String(notesDate || '').slice(0, 10);
    const subject = noteDraft.subject.trim();
    const body = noteDraft.body;
    if (!date || !subject || !body.trim() || noteSaving) return;
    const previousNotes = calendarNotes;
    const now = new Date().toISOString();
    const existing = editingNoteId === null ? null : calendarNotes.find(note => String(note.id) === String(editingNoteId));
    const optimisticNote: CalendarNote = existing
      ? { ...existing, subject, body, updatedAt: now }
      : { id: crypto.randomUUID(), date, subject, body, createdAt: now, updatedAt: now };
    setCalendarNotes(list => replaceRecordById(list, optimisticNote));
    setNoteSaving(true);
    setNoteSaveError('');
    try {
      const saved = existing
        ? await (window as any).api.dbUpdate('calendarNotes', existing.id, optimisticNote)
        : await (window as any).api.dbAdd('calendarNotes', optimisticNote);
      if (!saved) throw new Error('The note was not returned after saving.');
      setCalendarNotes(list => replaceRecordById(list, saved));
      setNoteDraft({ subject: '', body: '' });
      setEditingNoteId(null);
    } catch (error: any) {
      console.error('save calendar note failed', error);
      setCalendarNotes(previousNotes);
      setNoteSaveError(error?.message || 'The note could not be saved. Please try again.');
    } finally {
      setNoteSaving(false);
    }
  }

  async function deleteNote(note: CalendarNote) {
    if (!note.id) return;
    try {
      const deleted = await (window as any).api.dbDelete('calendarNotes', note.id);
      if (deleted) setCalendarNotes(list => list.filter(item => item.id !== note.id));
    } catch (error) {
      console.error('delete calendar note failed', error);
    }
  }

  // Build a simple grouping key for parts events to relate deliveries to an order
  function partsGroupKey(ev: CalendarEvent) {
    if (ev.category !== 'parts') return '';
    const wo = ev.workOrderId ? String(ev.workOrderId) : '';
    const id2 = (ev.partName || ev.title || '').toString().trim();
    return `${wo}::${id2}`;
  }

  function movePeriod(direction: -1 | 1) {
    if (!isMobileCalendar || calendarView === 'month') {
      setCurrent(new Date(current.getFullYear(), current.getMonth() + direction, 1, 0, 0, 0, 0));
      return;
    }
    setCurrent(addDays(current, direction * (calendarView === 'week' ? 7 : 1)));
  }

  function onPick(day: Date) {
    setContentEditorLocked(false);
    setTaskQueue([]);
    setTaskBatchError('');
    setEditing({ date: fmtDate(day), title: '', time: '', category: 'event' });
    setDeliveryDates([]);
    setDeliveryDateInput('');
  }

  async function setTaskCompleted(event: CalendarEvent, completed: boolean) {
    if (event.id == null || event.category !== 'task') return;
    const master = event.recurrenceMaster || event;
    const occurrenceDate = event.occurrenceDate || event.date;
    const previous = events.find(item => String(item.id) === String(master.id)) || master;
    const optimistic = taskCompletionPatch(
      { ...master, recurrenceRule: master.recurrenceRule ? normalizeRecurrenceRule(master.recurrenceRule) : null },
      completed,
      occurrenceDate,
      String(event.technician || ''),
    ) as CalendarEvent;
    setEvents(list => replaceRecordById(list, optimistic));
    try {
      const updated = await (window as any).api.dbUpdate('calendarEvents', master.id, optimistic);
      if (!updated) throw new Error('The task update was not saved.');
      setEvents(list => replaceRecordById(list, updated));
      setViewing(currentViewing => currentViewing && String((currentViewing.recurrenceMaster || currentViewing).id) === String(updated.id) ? { ...currentViewing, ...updated } : currentViewing);
      setViewingGroup(group => group ? group.map(item => String((item.recurrenceMaster || item).id) === String(updated.id) ? { ...item, ...updated } : item) : group);
    } catch (error) {
      setEvents(list => replaceRecordById(list, previous));
      console.error('save task completion failed', error);
      alert('The task could not be updated. Check your connection and try again.');
    }
  }
  function onEdit(ev: CalendarEvent) {
    if (ev.source === 'business-calendar') {
      setEditing(null);
      setViewing(ev);
      return;
    }
    setContentEditorLocked(false);
    setViewing(null);
    setEditing(ev.recurrenceMaster || ev);
    setDeliveryDateInput('');
    if (ev.category === 'parts') {
      const key = partsGroupKey(ev);
      const existing = events.filter(e => e.category === 'parts' && e.partsStatus === 'delivery' && partsGroupKey(e) === key).map(e => e.date);
      // unique preserve order
      const uniq = Array.from(new Set(existing));
      setDeliveryDates(uniq);
    } else {
      setDeliveryDates([]);
    }
  }

  async function saveEvent(ev: CalendarEvent) {
    let rollbackEvent: CalendarEvent | null = null;
    if (ev.category === 'task') {
      const hasStart = Boolean(ev.time);
      const hasEnd = Boolean(ev.endTime);
      if (hasStart !== hasEnd) {
        alert('Timed tasks require both a start time and an end time. Select All Day to create an untimed task.');
        return;
      }
      if (hasStart && hasEnd && toMinutes(ev.endTime || '') <= toMinutes(ev.time || '')) {
        alert('Task end time must be later than its start time.');
        return;
      }
    }
    try {
      // Derive title for certain categories if missing
      const payload: CalendarEvent = { ...ev };
      payload.recurrenceRule = normalizeRecurrenceRule(payload.recurrenceRule);
      if (payload.category === 'parts' && !payload.partsStatus) payload.partsStatus = 'ordered';
      if (payload.category === 'parts' && (!payload.title || !payload.title.trim())) {
        payload.title = payload.partName || 'Part/Product';
      }
      if (payload.category === 'content' && !payload.source) payload.source = 'streaming';
      if (payload.category === 'task') {
        payload.title = payload.title.trim() || 'Task';
        payload.taskCompleted = payload.taskCompleted === true;
        if (!payload.taskCompleted) {
          payload.taskCompletedAt = '';
          payload.taskCompletedBy = '';
        }
      }
      // If user typed a date but didn't click Add, include it
      if (payload.category === 'parts' && deliveryDateInput && /^\d{4}-\d{2}-\d{2}$/.test(deliveryDateInput)) {
        if (!deliveryDates.includes(deliveryDateInput)) deliveryDates.push(deliveryDateInput);
      }
      if (ev.id) {
        const previous = events.find(item => String(item.id) === String(ev.id));
        rollbackEvent = previous || null;
        const optimistic = { ...payload, id: ev.id, updatedAt: new Date().toISOString() } as CalendarEvent;
        setEvents(list => replaceRecordById(list, optimistic));
        const updated = await (window as any).api.dbUpdate('calendarEvents', ev.id, payload);
        if (!updated) {
          if (previous) setEvents(list => replaceRecordById(list, previous));
          throw new Error('The calendar entry was not returned after saving.');
        }
        setEvents(list => replaceRecordById(list, updated));
      } else {
        const added = await (window as any).api.dbAdd('calendarEvents', payload);
        if (added) setEvents(list => [...list, added]);
      }
      // If parts and user entered multiple estimated delivery dates, sync calendar entries
      if (payload.category === 'parts') {
        const key = partsGroupKey(payload);
        const existingDeliveries = events.filter(e => e.category === 'parts' && e.partsStatus === 'delivery' && partsGroupKey(e) === key);
        const existingDates = new Set(existingDeliveries.map(e => e.date));
        const desiredDates = new Set(deliveryDates.filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)));

        // Add missing
        for (const iso of desiredDates) {
          if (!existingDates.has(iso)) {
            const deliveryEvent: CalendarEvent = { ...payload, id: undefined, date: iso, partsStatus: 'delivery' };
            try {
              const addedDelivery = await (window as any).api.dbAdd('calendarEvents', deliveryEvent);
              if (addedDelivery) setEvents(list => [...list, addedDelivery]);
            } catch (e) { console.error('add delivery event failed', e); }
          }
        }
        // Remove deleted
        for (const e of existingDeliveries) {
          if (!desiredDates.has(e.date) && e.id != null) {
            try {
              const ok = await (window as any).api.dbDelete('calendarEvents', e.id);
              if (ok) setEvents(list => list.filter(x => x.id !== e.id));
            } catch (e2) { console.error('delete delivery event failed', e2); }
          }
        }
      }
      setEditing(null);
      setContentEditorLocked(false);
      setDeliveryDates([]);
      setDeliveryDateInput('');
    } catch (e) {
      if (rollbackEvent) setEvents(list => replaceRecordById(list, rollbackEvent as CalendarEvent));
      console.error('save event failed', e);
      alert('The calendar entry could not be saved. Check your connection and try again.');
    }
  }

  function addTaskToQueue() {
    if (!editing || editing.category !== 'task' || editing.id != null) return;
    const title = String(editing.title || '').trim();
    if (!title) {
      setTaskBatchError('Enter a subject before adding the task.');
      return;
    }
    const hasStart = Boolean(editing.time);
    const hasEnd = Boolean(editing.endTime);
    if (hasStart !== hasEnd) {
      setTaskBatchError('Timed tasks require both a start and end time.');
      return;
    }
    if (hasStart && hasEnd && toMinutes(editing.endTime || '') <= toMinutes(editing.time || '')) {
      setTaskBatchError('Task end time must be later than its start time.');
      return;
    }
    setTaskQueue((current) => [...current, {
      ...editing,
      id: undefined,
      title,
      notes: String(editing.notes || ''),
      technician: editing.technician || ALL_TECHNICIANS,
      taskCompleted: false,
      taskCompletedAt: '',
      taskCompletedBy: '',
    }]);
    setEditing((current) => current ? { ...current, title: '', notes: '' } : current);
    setTaskBatchError('');
  }

  async function saveTaskBatch() {
    if (!editing || editing.category !== 'task' || editing.id != null || taskBatchSaving) return;
    const pendingTasks = tasksPendingSave(taskQueue, editing);
    if (!pendingTasks.length) {
      setTaskBatchError('Enter a subject or add at least one task to the list before saving.');
      return;
    }
    for (const task of pendingTasks) {
      const hasStart = Boolean(task.time);
      const hasEnd = Boolean(task.endTime);
      if (hasStart !== hasEnd) {
        setTaskBatchError('Timed tasks require both a start and end time.');
        return;
      }
      if (hasStart && hasEnd && toMinutes(task.endTime || '') <= toMinutes(task.time || '')) {
        setTaskBatchError('Task end time must be later than its start time.');
        return;
      }
    }
    setTaskBatchSaving(true);
    setTaskBatchError('');
    const saved: CalendarEvent[] = [];
    try {
      for (const task of pendingTasks) {
        const added = await (window as any).api.dbAdd('calendarEvents', task);
        if (!added) throw new Error('A task was not returned after saving.');
        saved.push(added);
      }
      setEvents((current) => [...current, ...saved]);
      setTaskQueue([]);
      setEditing(null);
      setContentEditorLocked(false);
    } catch (error: any) {
      if (saved.length) {
        setEvents((current) => [...current, ...saved]);
        setTaskQueue((current) => current.slice(saved.length));
      }
      setTaskBatchError(error?.message || 'The task list could not be saved. Unsaved tasks remain in the list.');
    } finally {
      setTaskBatchSaving(false);
    }
  }

  // Silent autosave version (does not close modal or clear arrays)
  async function saveEventSilent(ev: CalendarEvent) {
    try {
      const payload: CalendarEvent = { ...ev };
      if (payload.category === 'parts' && !payload.partsStatus) payload.partsStatus = 'ordered';
      if (payload.category === 'parts' && (!payload.title || !payload.title.trim())) {
        payload.title = payload.partName || 'Part/Product';
      }
      if (payload.category === 'content' && !payload.source) payload.source = 'streaming';
      if (payload.category === 'task') {
        payload.title = payload.title.trim() || 'Task';
        payload.taskCompleted = payload.taskCompleted === true;
      }
      if (ev.id) {
        const updated = await (window as any).api.dbUpdate('calendarEvents', ev.id, payload);
        if (updated) setEvents(list => list.map(x => x.id === updated.id ? updated : x));
      } else {
        const added = await (window as any).api.dbAdd('calendarEvents', payload);
        if (added) {
          setEvents(list => [...list, added]);
          setEditing({ ...payload, id: added.id });
        }
      }
      // Sync delivery dates for parts silently
      if (payload.category === 'parts') {
        const key = partsGroupKey(payload);
        const existingDeliveries = events.filter(e => e.category === 'parts' && e.partsStatus === 'delivery' && partsGroupKey(e) === key);
        const existingDates = new Set(existingDeliveries.map(e => e.date));
        const desiredDates = new Set(deliveryDates.filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)));
        for (const iso of desiredDates) {
          if (!existingDates.has(iso)) {
            const deliveryEvent: CalendarEvent = { ...payload, id: undefined, date: iso, partsStatus: 'delivery' };
            try { const addedDelivery = await (window as any).api.dbAdd('calendarEvents', deliveryEvent); if (addedDelivery) setEvents(list => [...list, addedDelivery]); } catch {}
          }
        }
        for (const e of existingDeliveries) {
          if (!desiredDates.has(e.date) && e.id != null) {
            try { const ok = await (window as any).api.dbDelete('calendarEvents', e.id); if (ok) setEvents(list => list.filter(x => x.id !== e.id)); } catch {}
          }
        }
      }
    } catch (e) { /* silent */ }
  }

  async function deleteEvent(ev: CalendarEvent) {
    console.log('=== DELETE EVENT ATTEMPT ===');
    console.log('Event to delete:', ev);
    console.log('Event ID:', ev.id);
    console.log('Event category:', ev.category);
    
    if (!ev.id) { 
      console.log('No ID found, closing modal');
      setEditing(null); 
      setContentEditorLocked(false);
      return; 
    }
    
    let actualId = ev.id;
    
    // Handle virtual schedule event IDs
    if (ev.category === 'schedule' && ev.id && ev.id > 10) {
      // Virtual schedule events have IDs like: originalId + dayOfWeek
      // Extract original ID by removing the last digit (day of week)
      const idStr = ev.id.toString();
      if (idStr.length > 1) {
        actualId = Number(idStr.slice(0, -1));
        console.log('Schedule event - converted virtual ID', ev.id, 'to actual ID', actualId);
      }
    }
    
    try {
      console.log('Calling dbDelete for calendarEvents with actual ID:', actualId);
      const ok = await (window as any).api.dbDelete('calendarEvents', actualId);
      console.log('Delete result:', ok);
      
      if (ok) {
        console.log('Delete successful, updating local state');
        // Remove all schedule events with the same base ID (all virtual days)
        if (ev.category === 'schedule') {
          setEvents(list => list.filter(x => {
            if (x.category === 'schedule' && x.id && actualId) {
              const xActualId = x.id > 10 ? Number(x.id.toString().slice(0, -1)) : x.id;
              return xActualId !== actualId;
            }
            return x.id !== ev.id;
          }));
        } else {
          setEvents(list => list.filter(x => x.id !== ev.id));
        }
      } else {
        console.log('Delete failed - database returned false');
      }
      setEditing(null);
      setContentEditorLocked(false);
    } catch (e) { 
      console.error('delete event failed', e); 
    } finally {
      // A rejected delete used to leave this full-screen editor mounted, blocking all inputs.
      setEditing(null);
      setContentEditorLocked(false);
    }
    console.log('=== DELETE EVENT END ===');
  }

  function openTasks(day: Date, tasks: CalendarEvent[]) {
    if (tasks.length) {
      setViewingGroup(tasks);
      return;
    }
    setContentEditorLocked(false);
    setTaskQueue([]);
    setTaskBatchError('');
    setEditing({
      date: fmtDate(day),
      title: '',
      time: '',
      endTime: '',
      category: 'task',
      technician: ALL_TECHNICIANS,
    });
    setDeliveryDates([]);
    setDeliveryDateInput('');
  }

  async function openCalendarInvoice(ev: CalendarEvent) {
    const api: any = (window as any).api;
    if (Number(ev.workOrderId || 0) > 0) {
      await api?.openNewWorkOrder?.({ workOrderId: Number(ev.workOrderId) });
      return;
    }
    const saleId = Number(ev.saleId || 0);
    if (saleId > 0) {
      await api?.openNewSale?.({ id: saleId });
      return;
    }
    if (ev.category === 'consultation') await openConsultationSale(ev);
  }

  const calendarContextItems = useMemo<ContextMenuItem[]>(() => {
    const group = calendarContext.state.data || [];
    const event = group[0];
    if (!event) return [];
    const linkedInvoice = Number(event.workOrderId || event.saleId || 0) > 0 || event.category === 'consultation';
    const editable = event.source !== 'business-calendar' && event.category !== 'schedule';
    if (group.length > 1) {
      return [
        { type: 'header', label: `${group.length} ${calendarEventVisual(event, calendarColors).label} entries` },
        { label: 'Open entries', onClick: () => setViewingGroup(group) },
      ];
    }
    return [
      { type: 'header', label: event.title || calendarEventVisual(event, calendarColors).label },
      { label: 'Open details', onClick: () => setViewing(event) },
      { label: 'Edit entry', disabled: !editable, onClick: () => onEdit(event) },
      { type: 'separator' },
      { label: 'Open invoice', disabled: !linkedInvoice, onClick: () => openCalendarInvoice(event) },
      { label: 'Open order URL', disabled: !String(event.orderUrl || '').trim(), onClick: () => (window as any).api?.openUrl?.(String(event.orderUrl)) },
      { label: 'Open tracking URL', disabled: !String(event.trackingUrl || '').trim(), onClick: () => (window as any).api?.openUrl?.(String(event.trackingUrl)) },
      { type: 'separator' },
      { label: 'Delete entry', danger: true, disabled: !editable || event.id == null, onClick: () => deleteEvent(event) },
    ];
  }, [calendarContext.state.data, calendarColors]);

  function updateCalendarIconText(key: CalendarIconKey, value: string) {
    const characters = Array.from(value.trim()).slice(0, 3).join('');
    setCalendarIcons(current => ({ ...current, [key]: { kind: 'text', value: characters || DEFAULT_CALENDAR_ICONS[key].value } }));
  }

  function uploadCalendarIcon(key: CalendarIconKey, file?: File | null) {
    if (!file) return;
    if (!file.type.startsWith('image/')) { alert('Choose an image file.'); return; }
    if (file.size > 96 * 1024) { alert('Calendar icons must be smaller than 96 KB.'); return; }
    const reader = new FileReader();
    reader.onload = () => {
      const value = String(reader.result || '');
      if (value.startsWith('data:image/')) setCalendarIcons(current => ({ ...current, [key]: { kind: 'image', value } }));
    };
    reader.readAsDataURL(file);
  }

  // Minimal validation for autosave
  function canAutosave(ev: CalendarEvent | null) {
    if (!ev) return false;
    if (!ev.date) return false;
    if (ev.category === 'parts') return !!(ev.partName || ev.title);
    if (ev.category === 'event') return !!(ev.title || ev.location || ev.time);
    if (ev.category === 'consultation') return !!(ev.customerName || ev.title);
    if (ev.category === 'content') return !!(ev.title && ev.technician);
    if (ev.category === 'task') {
      const hasStart = Boolean(ev.time);
      const hasEnd = Boolean(ev.endTime);
      const validTiming = (!hasStart && !hasEnd) || (hasStart && hasEnd && toMinutes(ev.endTime || '') > toMinutes(ev.time || ''));
      return !!ev.title.trim() && validTiming;
    }
    return true;
  }

  // Autosave editing after 2s of inactivity; keep modal open
  const autosavePayload = useMemo(() => ({ ev: editing, deliveryDates }), [editing, deliveryDates]);
  useAutosave(autosavePayload, async (val) => {
    if (!val.ev) return;
    await saveEventSilent(val.ev);
  }, {
    debounceMs: 1000,
    enabled: calendarEventAutosaveEnabled(editing),
    skipInitialSave: true,
    shouldSave: (v) => canAutosave(v.ev),
    equals: Object.is,
  });

  const dailyLookData = useMemo(() => {
    const ymd = String(dailyLookDate || '').slice(0, 10);
    const dayDate = /^\d{4}-\d{2}-\d{2}$/.test(ymd) ? new Date(Number(ymd.slice(0, 4)), Number(ymd.slice(5, 7)) - 1, Number(ymd.slice(8, 10)), 0, 0, 0, 0) : new Date();
    const dayNames = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
    const dayKey = dayNames[dayDate.getDay()];
    const assigned = (dailyLookAssignedTo || '').trim();

    const schedules: Array<{ name: string; start?: string; end?: string; off?: boolean }> = [];
    for (const t of Array.isArray(techs) ? techs : []) {
      const schedule = t?.schedule || {};
      const sd = schedule?.[dayKey];
      if (!sd) continue;
      const techName = technicianDisplayName(t);
      if (assigned && techName !== assigned) continue;
      if (sd.off || (sd.start && sd.end)) schedules.push({ name: techName, start: sd.start, end: sd.end, off: !!sd.off });
    }
    schedules.sort((a, b) => (a.name || '').localeCompare(b.name || ''));

    const expandedForDay = (Array.isArray(events) ? events : []).flatMap((event) => event.recurrenceRule
      ? expandRecurringEvent(event, ymd, ymd) as CalendarEvent[]
      : [event]);
    const todays = [...expandedForDay, ...businessCalendarEvents].filter(e => String(e?.date || '').slice(0, 10) === ymd);
    const consultations = todays
      .filter(e => e.category === 'consultation')
      .filter(e => (!assigned ? true : (String(e.technician || '').trim() === assigned)))
      .sort((a, b) => toMinutes(a.time) - toMinutes(b.time));
    const eventItems = todays
      .filter(e => e.category === 'event')
      .sort((a, b) => toMinutes(a.time) - toMinutes(b.time));
    const contentItems = todays
      .filter(e => e.category === 'content')
      .filter(e => (!assigned ? true : String(e.technician || '').trim() === assigned))
      .sort((a, b) => toMinutes(a.time) - toMinutes(b.time));
    const partsAll = todays
      .filter(e => e.category === 'parts')
      .filter(e => (!assigned ? true : (String(e.technician || '').trim() === assigned)))
      .sort((a, b) => toMinutes(a.time) - toMinutes(b.time));
    const partsDelivery = partsAll.filter(e => (e.partsStatus === 'delivery' || !e.partsStatus));
    const partsOrdered = partsAll.filter(e => e.partsStatus === 'ordered');
    const tasks = tasksForDailyLook([
      ...events.filter((event) => !event.recurrenceRule),
      ...expandedForDay.filter((event) => Boolean(event.recurrenceRule)),
    ], ymd, assigned);
    const importantNotes = notesByDay[ymd] || [];

    return { ymd, assigned, schedules, consultations, eventItems, contentItems, partsDelivery, partsOrdered, tasks, importantNotes };
  }, [businessCalendarEvents, dailyLookDate, dailyLookAssignedTo, events, notesByDay, techs]);

  useEffect(() => {
    if (isMobileCalendar && calendarView === 'day') setDailyLookDate(fmtDate(current));
  }, [calendarView, current, isMobileCalendar]);

  const periodLabel = useMemo(() => {
    if (!isMobileCalendar || calendarView === 'month') return current.toLocaleString(undefined, { month: 'long', year: 'numeric' });
    if (calendarView === 'day') return current.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    const start = addDays(current, -current.getDay());
    const end = addDays(start, 6);
    return `${start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} - ${end.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
  }, [calendarView, current, isMobileCalendar]);

  function eventSummary(ev: CalendarEvent): string {
    const time = formatTime12FromHHmm(ev.time || '');
    if (ev.category === 'schedule') {
      const keys = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
      const schedule = ev.schedule?.[keys[new Date(`${ev.date}T12:00:00`).getDay()]];
      return `${ev.technician || 'Technician'}${schedule?.off ? ' - Off' : schedule?.start && schedule?.end ? ` - ${formatTime12FromHHmm(schedule.start)} to ${formatTime12FromHHmm(schedule.end)}` : ''}`;
    }
    if (ev.category === 'parts') {
      const action = ev.partsStatus === 'delivery' || !ev.partsStatus ? 'Expected' : 'Ordered';
      const linkedLabel = ev.workOrderLabel || ev.saleLabel || '';
      return `${time ? `${time} - ` : ''}${action}: ${ev.partName || ev.title || 'Part'}${linkedLabel ? ` (${linkedLabel})` : ''}`;
    }
    if (ev.category === 'consultation') return `${time ? `${time} - ` : ''}${ev.customerName || 'Consultation'}${ev.title ? `: ${ev.title}` : ''}`;
    if (ev.category === 'content') {
      const kind = ev.source === 'streaming' ? 'Stream' : 'Record';
      const end = formatTime12FromHHmm(ev.endTime || '');
      return `${time ? `${time}${end ? ` - ${end}` : ''} - ` : ''}${kind}: ${ev.title || 'Content session'}${ev.technician ? ` with ${ev.technician}` : ''}`;
    }
    if (ev.category === 'task') {
      const end = formatTime12FromHHmm(ev.endTime || '');
      const timing = time ? `${time}${end ? ` - ${end}` : ''}` : 'All Day';
      return `${timing} - ${ev.title || 'Task'}`;
    }
    return `${time ? `${time} - ` : ''}${ev.title || 'Event'}`;
  }

  const contentWeekDays = useMemo(() => {
    const start = addDays(current, -current.getDay());
    return Array.from({ length: 7 }, (_, index) => addDays(start, index));
  }, [current]);

  return (
    <div className="gb-calendar-window box-border p-4 bg-zinc-900 text-gray-100 h-[100dvh] max-h-[100dvh] min-h-0 flex flex-col overflow-hidden">
      <div className="gb-calendar-header flex shrink-0 flex-wrap items-center justify-between gap-3 mb-3">
        <div className="gb-calendar-title-actions flex min-w-0 flex-wrap items-center gap-2">
          <h2 className="min-w-0 text-2xl font-semibold">Calendar - Schedule Management</h2>
          <div className="gb-calendar-timeoff-action relative">
            {pendingShiftRequests.length ? <span className="gb-calendar-timeoff-badge" aria-label={`${pendingShiftRequests.length} pending time-off requests`}>!<strong>{pendingShiftRequests.length}</strong></span> : null}
            <button type="button" className="gb-calendar-timeoff-button" onClick={openShiftRequestWindow}>Request Time Off</button>
          </div>
        </div>
        <div className="gb-calendar-controls flex flex-wrap items-center justify-end gap-2">
          <button
            type="button"
            className="gb-calendar-shift-request"
            onClick={() => openScheduleRequest('shift-change')}
          >
            <span className="gb-calendar-shift-request-icon" aria-hidden="true">⇄</span>
            <span>Request Shift Change</span>
            {pendingScheduleRequests.length ? <strong className="gb-calendar-request-badge" aria-label={`${pendingScheduleRequests.length} pending schedule requests`}>{pendingScheduleRequests.length}</strong> : null}
          </button>
          <button
            className="gb-calendar-content-schedule px-3 py-2 bg-fuchsia-700 border border-fuchsia-500 rounded text-sm font-semibold"
            onClick={() => setContentScheduleOpen(true)}
          >
            Streaming/Content Schedule
          </button>
          <button className="gb-calendar-period-arrow px-2 py-1 bg-zinc-800 border border-zinc-700 rounded" aria-label="Previous calendar period" onClick={() => movePeriod(-1)}>&lt;</button>
          <div className="gb-calendar-period text-sm text-zinc-300 w-36 text-center">
            {periodLabel}
          </div>
          <button className="gb-calendar-period-arrow px-2 py-1 bg-zinc-800 border border-zinc-700 rounded" aria-label="Next calendar period" onClick={() => movePeriod(1)}>&gt;</button>
          <button
            className="gb-calendar-settings px-3 py-1 bg-zinc-800 border border-zinc-700 rounded text-sm"
            onClick={() => { setCalendarColors(savedCalendarColors); setTechnicianColors(savedTechnicianColors); setBusinessCalendar(savedBusinessCalendar); setCalendarSettingsOpen(true); }}
          >
            Settings
          </button>
        </div>
      </div>

      {requestType ? <div className="fixed inset-0 z-[100200] flex items-center justify-center bg-black/75 p-3" onClick={() => setRequestType(null)}>
        <section className="gb-calendar-request-dialog" role="dialog" aria-modal="true" aria-labelledby="calendar-request-title" onClick={event => event.stopPropagation()}>
          <header>
            <div><span className="gb-calendar-request-dialog-icon" aria-hidden="true">{requestType === 'time-off' ? '◷' : '⇄'}</span><div><h3 id="calendar-request-title">{requestType === 'time-off' ? 'Request Time Off' : 'Request Shift Change'}</h3><p>{requestType === 'time-off' ? 'Submit the hours you need away.' : 'Submit your requested hours for this day.'}</p></div></div>
            <button type="button" className="gb-icon-button" aria-label="Close request" onClick={() => setRequestType(null)}>X</button>
          </header>
          <div className="gb-calendar-request-fields">
            <label><span>Technician</span><select value={requestDraft.technician} onChange={event => setRequestDraft(draft => ({ ...draft, technician: event.target.value }))}><option value="">Select your name</option>{techs.filter((tech: any) => tech?.active !== false && tech?.status !== 'disabled').map((tech: any) => { const name = technicianDisplayName(tech); return <option key={tech.id || name} value={name}>{name}</option>; })}</select></label>
            <label><span>Date</span><input type="date" value={requestDraft.date} onChange={event => setRequestDraft(draft => ({ ...draft, date: event.target.value }))} /></label>
            <label><span>{requestType === 'time-off' ? 'Away from' : 'Requested start'}</span><input type="time" value={requestDraft.start} onChange={event => setRequestDraft(draft => ({ ...draft, start: event.target.value }))} /></label>
            <label><span>{requestType === 'time-off' ? 'Until' : 'Requested end'}</span><input type="time" value={requestDraft.end} onChange={event => setRequestDraft(draft => ({ ...draft, end: event.target.value }))} /></label>
          </div>
          {requestError ? <p className="gb-calendar-request-error" role="alert">{requestError}</p> : null}
          <footer><button type="button" onClick={() => setRequestType(null)}>Cancel</button><button type="button" className="submit" disabled={requestSaving} onClick={() => void submitScheduleRequest()}>{requestSaving ? 'Submitting…' : 'Submit Request'}</button></footer>
        </section>
      </div> : null}

      <div className="gb-calendar-view-toggle" role="group" aria-label="Calendar view">
        {(['day', 'week', 'month'] as const).map((view) => (
          <button
            key={view}
            type="button"
            aria-pressed={calendarView === view}
            onClick={() => {
              if (view === 'day') setCurrent(new Date());
              setCalendarView(view);
            }}
          >
            {view === 'day' ? 'Daily' : view === 'week' ? 'Weekly' : 'Monthly'}
          </button>
        ))}
      </div>

      {/* Event Type Filters */}
      <div className="gb-calendar-filters shrink-0 mb-2 p-2 bg-zinc-800 rounded-lg">
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span className="text-zinc-400 font-medium">Show:</span>
          
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              className="w-4 h-4 accent-[#39FF14]"
              checked={filters.schedule}
              onChange={(e) => setFilters(prev => ({ ...prev, schedule: e.target.checked }))}
            />
            <div className="flex items-center gap-1">
              <div className="w-4 h-4 rounded text-black text-xs flex items-center justify-center font-bold" style={{ backgroundColor: calendarColors.schedule }}>S</div>
              <span className="text-sm text-zinc-300">Schedules</span>
            </div>
          </label>

          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              className="w-4 h-4 accent-[#39FF14]"
              checked={filters.parts}
              onChange={(e) => setFilters(prev => ({ ...prev, parts: e.target.checked }))}
            />
            <div className="flex items-center gap-1">
              <div className="w-4 h-4 rounded text-black text-xs flex items-center justify-center font-bold" style={{ backgroundColor: calendarColors.partsOrdered }}>O</div>
              <span className="text-sm text-zinc-300">Orders/Parts</span>
            </div>
          </label>

          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              className="w-4 h-4 accent-[#39FF14]"
              checked={filters.events}
              onChange={(e) => setFilters(prev => ({ ...prev, events: e.target.checked }))}
            />
            <div className="flex items-center gap-1">
              <div className="w-4 h-4 rounded text-black text-xs flex items-center justify-center font-bold" style={{ backgroundColor: calendarColors.event }}>E</div>
              <span className="text-sm text-zinc-300">Events</span>
            </div>
          </label>

          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              className="w-4 h-4 accent-[#39FF14]"
              checked={filters.consultation}
              onChange={(e) => setFilters(prev => ({ ...prev, consultation: e.target.checked }))}
            />
            <div className="flex items-center gap-1">
              <div className="w-4 h-4 rounded text-black text-xs flex items-center justify-center font-bold" style={{ backgroundColor: calendarColors.consultation }}>C</div>
              <span className="text-sm text-zinc-300">Consultations</span>
            </div>
          </label>

          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              className="w-4 h-4 accent-fuchsia-500"
              checked={filters.content}
              onChange={(e) => setFilters(prev => ({ ...prev, content: e.target.checked }))}
            />
            <div className="flex items-center gap-1">
              <div className="w-4 h-4 rounded text-black text-[9px] flex items-center justify-center font-bold" style={{ backgroundColor: calendarColors.streaming }}>V</div>
              <span className="text-sm text-zinc-300">Content</span>
            </div>
          </label>

          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" className="w-4 h-4 accent-violet-400" checked={filters.tasks} onChange={(event) => setFilters(previous => ({ ...previous, tasks: event.target.checked }))} />
            <div className="flex items-center gap-1"><div className="w-4 h-4 rounded text-black text-xs flex items-center justify-center font-bold" style={{ backgroundColor: calendarColors.task }}>K</div><span className="text-sm text-zinc-300">Tasks</span></div>
          </label>

          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              className="w-4 h-4 accent-amber-400"
              checked={filters.notes}
              onChange={(event) => setFilters(previous => ({ ...previous, notes: event.target.checked }))}
            />
            <div className="flex items-center gap-1">
              <div className="w-4 h-4 rounded text-black text-xs flex items-center justify-center font-bold" style={{ backgroundColor: calendarColors.notes }}>N</div>
              <span className="text-sm text-zinc-300">Important Notes</span>
            </div>
          </label>

          <div className="ml-3 flex gap-2">
            <button
              className="px-2.5 py-1 text-xs bg-zinc-700 border border-zinc-600 rounded hover:bg-zinc-600 transition-colors"
              onClick={() => setFilters({ schedule: true, parts: true, events: true, consultation: true, content: true, tasks: true, notes: true })}
            >
              Select All
            </button>
            <button
              className="px-2.5 py-1 text-xs bg-zinc-700 border border-zinc-600 rounded hover:bg-zinc-600 transition-colors"
              onClick={() => setFilters({ schedule: false, parts: false, events: false, consultation: false, content: false, tasks: false, notes: false })}
            >
              Clear All
            </button>
          </div>
        </div>
      </div>

      {!isMobileCalendar || calendarView === 'month' ? <div className="gb-calendar-month flex-1 min-h-0 flex flex-col overflow-hidden">
        <div className="grid grid-cols-7 gap-1.5 bg-zinc-800 rounded-lg overflow-hidden">
          {['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'].map(d => (
            <div key={d} className="text-sm font-medium text-zinc-300 bg-zinc-800 px-2.5 py-2.5 text-center">{d}</div>
          ))}
        </div>
        <div
          className="gb-calendar-month-grid grid grid-cols-7 gap-1.5 mt-1.5 flex-1 min-h-0 overflow-hidden"
          style={{ gridTemplateRows: `repeat(${Math.ceil(monthDays.length / 7)}, minmax(0, 1fr))` }}
        >
          {(() => { const todayStr = fmtDate(new Date()); return monthDays.map((day, idx) => {
            const key = fmtDate(day);
            const isCurrentMonth = day.getMonth() === current.getMonth();
            return (
              <div key={idx} className={`${isCurrentMonth ? 'bg-zinc-900' : 'bg-zinc-900/60'} relative rounded-lg border border-zinc-700 h-full min-h-0 overflow-hidden`}>
                {key.slice(5) === '09-11' ? (
                  <img
                    src={publicAsset('calendar/911-memorial.png')}
                    alt=""
                    aria-hidden="true"
                    className="gb-calendar-september-11-art pointer-events-none absolute inset-0 h-full w-full object-cover opacity-30"
                  />
                ) : null}
                {isCurrentMonth || isMobileCalendar ? (
                  <div className="relative z-10 h-full min-h-0">
                    <Cell
                      day={day}
                      events={eventsByDay[key] || []}
                      notes={notesByDay[key] || []}
                      notesVisible={filters.notes}
                      tasksVisible={filters.tasks}
                      colors={calendarColors}
                      icons={calendarIcons}
                      technicianColors={technicianColors}
                      onPick={onPick}
                      onOpenBudget={openBudgetEditor}
                      onOpenGroup={setViewingGroup}
                      onContextGroup={(event, group) => calendarContext.openFromEvent(event, group)}
                      onOpenNotes={openNotes}
                      onOpenTasks={openTasks}
                      onOpenShifts={(day) => openShiftDay(fmtDate(day))}
                      isToday={key === todayStr}
                    />
                  </div>
                ) : null}
              </div>
            );
          }); })()}
        </div>
      </div> : null}

      {isMobileCalendar && calendarView === 'week' ? (
        <div className="flex-1 min-h-0 flex flex-col">
          <div className="gb-calendar-week-filter">
            <label>
              <span>Week of</span>
              <input
                type="date"
                value={fmtDate(current)}
                aria-label="Choose a date to show its week"
                onChange={(event) => {
                  const selected = new Date(`${event.target.value}T12:00:00`);
                  if (!Number.isNaN(selected.getTime())) setCurrent(selected);
                }}
              />
            </label>
          </div>
          <div className="gb-calendar-week flex-1 min-h-0 overflow-y-auto">
            {calendarDays.map((day) => {
              const key = fmtDate(day);
              const dayEvents = eventsByDay[key] || [];
              const dayNotes = notesByDay[key] || [];
              const activeShifts = activeShiftEvents(day, dayEvents);
              const scheduleEvents = dayEvents.filter((event) => event.category === 'schedule');
              const shiftsChanged = scheduleEvents.some((event) => event.shiftOverridden);
              const nonShiftEvents = dayEvents.filter((event) => event.category !== 'schedule');
              const groupedDayEvents = Array.from(nonShiftEvents.reduce((groups, event) => {
                const groupKey = calendarEventGroupKey(event);
                const group = groups.get(groupKey) || [];
                group.push(event);
                groups.set(groupKey, group);
                return groups;
              }, new Map<string, CalendarEvent[]>()).values());
              const isToday = key === fmtDate(new Date());
              return (
                <section key={key} className={isToday ? 'is-today' : ''}>
                  <header>
                    <button type="button" onClick={() => { setCurrent(day); setCalendarView('day'); }}>
                      <strong>{day.toLocaleDateString(undefined, { weekday: 'short' })}</strong>
                      <span>{day.toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' })}</span>
                      {isToday ? <em>Today</em> : null}
                    </button>
                    <div className="gb-calendar-week-actions">
                      <button type="button" aria-label={`Set purchasing budget for ${key}`} title="Set purchasing budget" onClick={() => openBudgetEditor(day)}>$</button>
                      <button type="button" aria-label={`Add calendar entry for ${key}`} onClick={() => onPick(day)}>+</button>
                    </div>
                  </header>
                  <div className="gb-calendar-agenda-list">
                    {scheduleEvents.length ? <button type="button" className={`gb-calendar-week-shifts ${shiftsChanged ? 'is-overridden' : ''}`} aria-label={`Show shifts for ${key}${shiftsChanged ? '; shift change saved' : ''}`} onClick={() => openShiftDay(key)}><span style={{ backgroundColor: shiftsChanged ? '#ef4444' : calendarColors.schedule }}>S</span><strong>{activeShifts.length}</strong></button> : null}
                    {groupedDayEvents.map((group, index) => {
                      const event = group[0];
                      const visual = calendarEventVisual(event, calendarColors);
                      return (
                        <button
                          key={event.id || `${key}-${index}`}
                          type="button"
                          className={`gb-calendar-week-event type-${event.category || 'event'}`}
                          aria-label={`${visual.label}: ${eventSummary(event)}`}
                          onClick={() => setViewingGroup(group)}
                          onContextMenu={(contextEvent) => calendarContext.openFromEvent(contextEvent, group)}
                        >
                          <span className="gb-calendar-event-icon relative" style={{ backgroundColor: visual.color }}><CalendarIconContent event={event} icons={calendarIcons} fallback={visual.short} />{group.length > 1 ? <b className="absolute -right-2 -top-2 inline-flex min-w-5 h-5 items-center justify-center rounded-full bg-white px-1 text-[10px] text-zinc-950 shadow">{group.length}</b> : null}</span>
                          <span className="gb-calendar-event-copy">
                            <strong>{group.length > 1 ? `${group.length} ${visual.label} entries` : eventSummary(event)}</strong>
                            <small>{visual.label}{group.length > 1 ? ' - tap to view list' : ''}</small>
                          </span>
                        </button>
                      );
                    })}
                    {filters.notes ? (
                      <button
                        type="button"
                        className={`gb-calendar-week-note${dayNotes.length ? ' has-notes' : ''}`}
                        aria-label={dayNotes.length ? `${dayNotes.length} important note${dayNotes.length === 1 ? '' : 's'} for ${key}` : `Add an important note for ${key}`}
                        title={dayNotes.length ? dayNotes.map(note => note.subject).filter(Boolean).join('\n') : 'Add an important note'}
                        onClick={() => openNotes(day)}
                      >
                        <span>N</span>{dayNotes.length ? <strong>{dayNotes.length}</strong> : null}
                      </button>
                    ) : null}
                    {!activeShifts.length && !nonShiftEvents.length && (!filters.notes || !dayNotes.length) ? <span aria-label="No scheduled activity">—</span> : null}
                  </div>
                </section>
              );
            })}
          </div>
        </div>
      ) : null}

      {isMobileCalendar && calendarView === 'day' ? (
        <div className="gb-calendar-day flex-1 overflow-y-auto">
          <div className="gb-calendar-day-actions">
            <input type="date" value={dailyLookData.ymd} onChange={(event) => { setDailyLookDate(event.target.value); const next = new Date(`${event.target.value}T12:00:00`); if (!Number.isNaN(next.getTime())) setCurrent(next); }} />
            <select value={dailyLookAssignedTo} onChange={(event) => setDailyLookAssignedTo(event.target.value)} aria-label="Filter daily calendar by technician">
              <option value="">All technicians</option>
              {techs.map((tech: any) => { const name = technicianDisplayName(tech); return <option key={tech.id || name} value={name}>{name}</option>; })}
            </select>
            <button type="button" className="gb-calendar-budget-button" onClick={() => openBudgetEditor(current)}>Budget</button>
            <button type="button" onClick={() => onPick(current)}>+ Add</button>
          </div>
          <div className="gb-calendar-day-sections">
            {filters.schedule ? <section><h3>Schedules <span>{dailyLookData.schedules.length}</span></h3>{dailyLookData.schedules.map((item) => <div key={item.name}><strong>{item.name}</strong><span>{item.off ? 'Off' : `${formatTime12FromHHmm(item.start || '')} - ${formatTime12FromHHmm(item.end || '')}`}</span></div>)}{!dailyLookData.schedules.length ? <p>No schedules.</p> : null}</section> : null}
            {filters.consultation ? <section><h3>Consultations <span>{dailyLookData.consultations.length}</span></h3>{dailyLookData.consultations.map((item, index) => <button key={item.id || index} type="button" onClick={() => onEdit(item)}>{eventSummary(item)}</button>)}{!dailyLookData.consultations.length ? <p>No consultations.</p> : null}</section> : null}
            {filters.parts ? <section><h3>Expected Deliveries <span>{dailyLookData.partsDelivery.length}</span></h3>{dailyLookData.partsDelivery.map((item, index) => <button key={item.id || index} type="button" onClick={() => onEdit(item)}>{eventSummary(item)}</button>)}{!dailyLookData.partsDelivery.length ? <p>No expected deliveries.</p> : null}</section> : null}
            {filters.parts ? <section><h3>Parts Ordered <span>{dailyLookData.partsOrdered.length}</span></h3>{dailyLookData.partsOrdered.map((item, index) => <button key={item.id || index} type="button" onClick={() => onEdit(item)}>{eventSummary(item)}</button>)}{!dailyLookData.partsOrdered.length ? <p>No parts ordered.</p> : null}</section> : null}
            {filters.events ? <section><h3>Events <span>{dailyLookData.eventItems.length}</span></h3>{dailyLookData.eventItems.map((item, index) => <button key={item.id || index} type="button" onClick={() => onEdit(item)}>{eventSummary(item)}</button>)}{!dailyLookData.eventItems.length ? <p>No events.</p> : null}</section> : null}
            {filters.content ? <section><h3>Streaming/Content <span>{dailyLookData.contentItems.length}</span></h3>{dailyLookData.contentItems.map((item, index) => <button key={item.id || index} type="button" onClick={() => setViewing(item)}>{eventSummary(item)}</button>)}{!dailyLookData.contentItems.length ? <p>No content sessions.</p> : null}</section> : null}
            {filters.tasks ? <section><h3>Tasks <span>{dailyLookData.tasks.length}</span></h3>{dailyLookData.tasks.map((task, index) => <label key={task.id || index} className="flex items-start gap-2"><input type="checkbox" className="mt-0.5 h-5 w-5 shrink-0 accent-violet-400" checked={taskIsCompleted(task)} onChange={event => { void setTaskCompleted(task, event.target.checked); }} /><span className={taskIsCompleted(task) ? 'line-through text-zinc-500' : ''}><strong>{task.title || 'Task'}</strong><small className="block text-zinc-400">{task.date < dailyLookData.ymd ? `Carried from ${task.date}` : taskAssignmentLabel(task.technician)}</small></span></label>)}{!dailyLookData.tasks.length ? <p>No tasks.</p> : null}</section> : null}
            {filters.notes ? <section><h3>Important Notes <span>{dailyLookData.importantNotes.length}</span></h3>{dailyLookData.importantNotes.map((note) => <button key={String(note.id)} type="button" onClick={() => { setNotesDate(dailyLookData.ymd); setEditingNoteId(String(note.id)); setNoteDraft({ subject: note.subject || '', body: note.body || '' }); }}><strong>{note.subject}</strong><span className="block text-xs text-zinc-400">{note.body}</span></button>)}{!dailyLookData.importantNotes.length ? <p>No important notes.</p> : null}</section> : null}
          </div>
        </div>
      ) : null}

      {notesDate && (
        <div className="fixed inset-0 z-40 bg-black/70 flex items-center justify-center p-3" onClick={() => setNotesDate(null)}>
          <div className="calendar-notes-dialog bg-zinc-900 border border-zinc-700 rounded w-full max-w-[1040px] h-[min(82vh,720px)] flex flex-col p-4" onClick={(event) => event.stopPropagation()}>
            <div className="flex items-start justify-between gap-3 mb-4">
              <div>
                <h3 className="text-xl font-semibold">Important Notes</h3>
                <div className="text-sm text-zinc-400">{new Date(`${notesDate}T12:00:00`).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}</div>
              </div>
              <button type="button" className="gb-icon-button" aria-label="Close notes" onClick={() => setNotesDate(null)}>X</button>
            </div>
            <div className="calendar-notes-workspace grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_280px] gap-3">
              <section className="calendar-note-reader min-h-0 flex flex-col rounded border border-zinc-700 bg-zinc-950/50 p-3">
                <div className="font-semibold text-sm mb-2">{editingNoteId === null ? 'Add New Note' : 'Edit Note'}</div>
                <input className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2" placeholder="Subject" value={noteDraft.subject} onChange={event => setNoteDraft(draft => ({ ...draft, subject: event.target.value }))} />
                <textarea className="mt-2 min-h-0 flex-1 w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-3 resize-none leading-relaxed" placeholder="Write the important note..." value={noteDraft.body} onChange={event => setNoteDraft(draft => ({ ...draft, body: event.target.value }))} />
                {noteSaveError ? <div className="mt-2 rounded border border-red-700 bg-red-950/40 px-3 py-2 text-sm text-red-200">{noteSaveError}</div> : null}
                <div className="mt-3 flex justify-end gap-2">
                {editingNoteId !== null ? <button type="button" className="px-3 py-1.5 bg-zinc-800 border border-zinc-700 rounded" onClick={() => { setEditingNoteId(null); setNoteDraft({ subject: '', body: '' }); }}>Cancel edit</button> : null}
                <button type="button" className="px-3 py-1.5 bg-amber-400 text-black font-semibold rounded disabled:opacity-50" disabled={!noteDraft.subject.trim() || !noteDraft.body.trim() || noteSaving} onClick={() => { void saveNote(); }}>
                  {noteSaving ? 'Saving...' : editingNoteId === null ? 'Add New Note' : 'Save Note'}
                </button>
                </div>
              </section>
              <aside className="calendar-note-list min-h-0 overflow-y-auto rounded border border-zinc-700 bg-zinc-950/50 p-2">
                {(notesByDay[notesDate] || []).length === 0 ? <div className="text-sm text-zinc-500 p-2">No notes for this day yet.</div> : (notesByDay[notesDate] || []).map(note => (
                  <div key={String(note.id)} className={`mb-2 rounded border p-2 ${String(note.id) === editingNoteId ? 'border-amber-400 bg-amber-400/15' : 'border-zinc-700 bg-zinc-900'}`}>
                    <button type="button" className="w-full text-left" onClick={() => { setEditingNoteId(String(note.id)); setNoteDraft({ subject: note.subject || '', body: note.body || '' }); }}><strong className="block truncate text-sm text-amber-100">{note.subject}</strong><span className="mt-1 block line-clamp-3 whitespace-pre-wrap text-xs text-zinc-400">{note.body}</span></button>
                    <button type="button" className="mt-2 text-xs text-zinc-500 hover:text-red-300" onClick={() => { void deleteNote(note); }}>Delete</button>
                  </div>
                ))}
              </aside>
            </div>
          </div>
        </div>
      )}

      {shiftRequestOpen && createPortal((
        <div className="gb-calendar-shift-request-layer fixed inset-0 z-[100450] flex items-center justify-center bg-black/75 p-3" onMouseDown={event => { if (event.target === event.currentTarget) setShiftRequestOpen(false); }}>
          <section className="gb-calendar-shift-request-dialog flex max-h-[90dvh] w-full max-w-[780px] flex-col overflow-hidden rounded border border-red-500/70 bg-zinc-900 shadow-[0_0_34px_rgba(239,68,68,0.18)]" role="dialog" aria-modal="true" aria-labelledby="calendar-shift-request-title">
            <header className="flex shrink-0 items-start justify-between gap-3 border-b border-zinc-700 p-4">
              <div><h3 id="calendar-shift-request-title" className="text-xl font-semibold text-white">Request Time Off / Shift Change</h3><p className="mt-1 text-sm text-zinc-400">Submit a full day off or request different hours for one date. Saved Technician schedules are not changed.</p></div>
              <button type="button" className="gb-icon-button" aria-label="Close shift request" onClick={() => setShiftRequestOpen(false)}>X</button>
            </header>
            <div className="gb-calendar-shift-request-body min-h-0 overflow-y-auto p-4">
              <section className="gb-calendar-shift-request-form rounded border border-zinc-700 bg-zinc-950/55 p-3">
                <label><span>Technician</span><select value={shiftRequestDraft.technician} onChange={event => setShiftRequestDraft(draft => ({ ...draft, technician: event.target.value }))}><option value="">Select technician</option>{activeTechnicians.map((technician: any) => { const name = technicianDisplayName(technician); return <option key={shiftOverrideLocation(technician)} value={name}>{name}</option>; })}</select></label>
                <label><span>Date</span><input type="date" value={shiftRequestDraft.date} onChange={event => setShiftRequestDraft(draft => ({ ...draft, date: event.target.value }))} /></label>
                <div className="gb-calendar-shift-request-mode" role="group" aria-label="Request type">
                  <button type="button" className={shiftRequestDraft.off ? 'active' : ''} aria-pressed={shiftRequestDraft.off} onClick={() => setShiftRequestDraft(draft => ({ ...draft, off: true, start: '', end: '' }))}>Full Day OFF</button>
                  <button type="button" className={!shiftRequestDraft.off ? 'active' : ''} aria-pressed={!shiftRequestDraft.off} onClick={() => setShiftRequestDraft(draft => ({ ...draft, off: false }))}>Different Hours</button>
                </div>
                {!shiftRequestDraft.off ? <div className="gb-calendar-shift-request-times"><label><span>Requested Start</span><input type="time" value={shiftRequestDraft.start} onChange={event => setShiftRequestDraft(draft => ({ ...draft, start: event.target.value }))} /></label><label><span>Requested End</span><input type="time" value={shiftRequestDraft.end} onChange={event => setShiftRequestDraft(draft => ({ ...draft, end: event.target.value }))} /></label></div> : <div className="gb-calendar-shift-request-off-summary">OFF for the full selected day</div>}
                <label className="gb-calendar-shift-request-reason"><span>Reason / Notes</span><textarea value={shiftRequestDraft.reason} onChange={event => setShiftRequestDraft(draft => ({ ...draft, reason: event.target.value }))} placeholder="Optional details for the schedule manager" /></label>
                {shiftRequestError ? <p className="gb-calendar-shift-request-error">{shiftRequestError}</p> : null}
                <button type="button" className="gb-calendar-shift-request-submit" disabled={shiftRequestSaving} onClick={() => void submitShiftRequest()}>{shiftRequestSaving ? 'Saving Request...' : 'Submit Shift Request'}</button>
              </section>

              <section className="gb-calendar-pending-shift-requests mt-4">
                <div className="flex items-center justify-between gap-3"><h4 className="font-semibold">Pending Requests</h4><span>{pendingShiftRequests.length}</span></div>
                {!pendingShiftRequests.length ? <p className="mt-2 rounded border border-zinc-800 bg-zinc-950/40 p-3 text-sm text-zinc-500">No pending schedule requests.</p> : pendingShiftRequests.map(request => (
                  <article key={request.id} className="gb-calendar-shift-request-card">
                    <div className="min-w-0"><strong>{request.technician || 'Technician'}</strong><span>{new Date(`${request.date}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}</span><p>{request.shiftRequestOff ? 'Full Day OFF' : `${formatTime12FromHHmm(request.time || '')} - ${formatTime12FromHHmm(request.endTime || '')}`}</p>{request.notes ? <small>{request.notes}</small> : null}</div>
                    <div className="gb-calendar-shift-request-review"><button type="button" disabled={shiftRequestSaving} onClick={() => void reviewShiftRequest(request, 'declined')}>Decline</button><button type="button" disabled={shiftRequestSaving} onClick={() => void reviewShiftRequest(request, 'approved')}>Approve</button></div>
                  </article>
                ))}
              </section>
            </div>
          </section>
        </div>
      ), document.body)}

      {shiftDay && (() => {
        const day = new Date(`${shiftDay}T12:00:00`);
        const shifts = (eventsByDay[shiftDay] || []).filter(event => event.category === 'schedule');
        const dayKey = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][day.getDay()] as keyof NonNullable<CalendarEvent['schedule']>;
        return <div className="fixed inset-0 z-40 bg-black/70 flex items-center justify-center p-3">
          <section className="gb-calendar-shifts-dialog bg-zinc-900 border border-zinc-700 rounded w-full max-w-[620px] max-h-[88vh] flex flex-col p-4" role="dialog" aria-modal="true" aria-labelledby="calendar-shifts-title">
            <div className="flex items-start justify-between gap-3 mb-4"><div><h3 id="calendar-shifts-title" className="text-xl font-semibold">Technician Shifts</h3><div className="text-sm text-zinc-400">{day.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</div></div><button type="button" className="gb-icon-button" aria-label="Close shifts" onClick={() => setShiftDay(null)}>X</button></div>
            <div className="mb-3 flex items-center justify-between gap-2 rounded border border-zinc-700 bg-zinc-950/50 p-2">
              <p className="text-xs text-zinc-400">Changes apply only to this date and do not alter saved Technician schedules.</p>
              <button type="button" className="shrink-0 rounded border border-red-400 bg-red-600 px-3 py-2 text-sm font-semibold text-white hover:bg-red-500" onClick={() => setShiftChangeEditing(value => !value)}>{shiftChangeEditing ? 'Review Shifts' : 'Shift Change'}</button>
            </div>
            <div className="min-h-0 overflow-y-auto space-y-2 pr-1">
              {shiftChangeEditing ? techs.filter((technician: any) => technician?.active !== false && technician?.status !== 'disabled').map((technician: any) => {
                const identity = shiftOverrideLocation(technician);
                const draft = shiftDrafts[identity] || { start: '', end: '', off: false };
                return <div key={identity} className="gb-calendar-shift-edit-row rounded border border-zinc-700 bg-zinc-800 p-3">
                  <strong>{technicianDisplayName(technician)}</strong>
                  <label><span>Start</span><input type="time" disabled={draft.off} value={draft.start} onChange={event => setShiftDrafts(current => ({ ...current, [identity]: { ...draft, start: event.target.value } }))} /></label>
                  <label><span>End</span><input type="time" disabled={draft.off} value={draft.end} onChange={event => setShiftDrafts(current => ({ ...current, [identity]: { ...draft, end: event.target.value } }))} /></label>
                  <label className="gb-calendar-shift-off"><input type="checkbox" checked={draft.off} onChange={event => setShiftDrafts(current => ({ ...current, [identity]: { ...draft, off: event.target.checked } }))} /><span>OFF</span></label>
                </div>;
              }) : shifts.map((event, index) => { const shift = event.schedule?.[dayKey]; return <div key={event.id || `${event.technician}-${index}`} className={`flex items-center justify-between gap-3 rounded border p-3 ${event.shiftOverridden ? 'border-red-500 bg-red-950/30' : 'border-zinc-700 bg-zinc-800'}`}><div><strong>{event.technician || 'Technician'}</strong>{event.shiftOverridden ? <span className="ml-2 rounded bg-red-500/20 px-2 py-0.5 text-[10px] font-bold uppercase text-red-200">Changed</span> : null}</div><span className="text-sm text-zinc-300">{shift?.off ? 'OFF' : `${formatTime12FromHHmm(shift?.start || '')} - ${formatTime12FromHHmm(shift?.end || '')}`}</span></div>; })}
              {!shiftChangeEditing && !shifts.length ? <p className="py-6 text-center text-sm text-zinc-500">No technicians are scheduled for this date.</p> : null}
            </div>
            {shiftSaveError ? <p className="mt-3 rounded border border-red-600 bg-red-950/40 px-3 py-2 text-sm text-red-200">{shiftSaveError}</p> : null}
            {shiftChangeEditing ? <div className="mt-3 flex justify-end gap-2"><button type="button" className="rounded border border-zinc-600 bg-zinc-800 px-3 py-2 text-sm" onClick={() => openShiftDay(shiftDay)}>Cancel</button><button type="button" className="rounded bg-[#39FF14] px-3 py-2 text-sm font-bold text-black disabled:opacity-50" disabled={shiftSaving} onClick={() => void saveShiftChanges(shiftDay)}>{shiftSaving ? 'Saving...' : 'Save Shift Changes'}</button></div> : null}
          </section>
        </div>;
      })()}

      {calendarSettingsOpen && createPortal((
        <div className="gb-calendar-settings-layer fixed inset-0 z-[100500] bg-black/70 flex items-center justify-center p-3" data-modal-shell="1">
          <section className="gb-calendar-settings-dialog bg-zinc-900 border border-zinc-700 rounded w-full max-w-[860px] max-h-[90vh] flex flex-col overflow-hidden" role="dialog" aria-modal="true" aria-labelledby="calendar-settings-title">
            <div className="gb-calendar-settings-header flex items-center justify-between gap-3 border-b border-zinc-700 p-4">
              <div><h3 id="calendar-settings-title" className="text-xl font-semibold">Calendar Settings</h3><p className="text-sm text-zinc-400">Choose business dates, calendar colors, and Technician shift colors.</p></div>
              <button type="button" className="gb-icon-button" aria-label="Close calendar settings" onClick={() => { setCalendarColors(savedCalendarColors); setTechnicianColors(savedTechnicianColors); setBusinessCalendar(savedBusinessCalendar); setCalendarIcons(savedCalendarIcons); setCalendarSettingsOpen(false); }}>X</button>
            </div>
            <div className="gb-calendar-settings-body min-h-0 overflow-y-auto p-4">
              <section className="gb-calendar-settings-section">
                <div className="gb-calendar-settings-section-title"><div><strong>Business Calendar</strong><span>Show useful dates without creating editable calendar records.</span></div></div>
                <div className="gb-business-calendar-options">
                  {([
                    ['federalHolidays', 'U.S. federal holidays', 'Observed federal holiday dates and shop-hours reminders.'],
                    ['scTaxFreeWeekend', 'South Carolina tax-free weekend', 'The annual 72-hour sales tax holiday beginning the first Friday in August.'],
                    ['daylightSaving', 'Daylight saving time changes', 'Spring-forward and fall-back reminders at 2:00 AM local time.'],
                    ['estimatedTaxDeadlines', 'Estimated tax payment reminders', 'General quarterly reminders; verify applicability with your accountant.'],
                  ] as Array<[keyof BusinessCalendarSettings, string, string]>).map(([key, label, detail]) => (
                    <label key={key}><input type="checkbox" checked={businessCalendar[key]} onChange={(event) => setBusinessCalendar(settings => ({ ...settings, [key]: event.target.checked }))} /><span><strong>{label}</strong><small>{detail}</small></span></label>
                  ))}
                </div>
              </section>

              <details className="gb-calendar-settings-section" open>
                <summary>Calendar Color Wheels</summary>
                <div className="gb-calendar-color-grid">{([
                  ['schedule', 'Default technician shifts'], ['partsOrdered', 'Parts ordered'], ['partsDelivery', 'Expected deliveries'], ['event', 'Events'], ['consultation', 'Consultations'], ['streaming', 'Streaming'], ['content', 'Content recording'], ['task', 'Tasks'], ['notes', 'Important notes'], ['federalHoliday', 'Federal holidays'], ['scTaxFreeWeekend', 'SC tax-free weekend'], ['daylightSaving', 'Daylight saving time'], ['estimatedTaxDeadline', 'Tax reminders'],
                ] as Array<[keyof CalendarColors, string]>).map(([key, label]) => <div key={key} className="gb-calendar-color-row"><label className="gb-calendar-color-picker" title={`Choose ${label.toLowerCase()} color`}><input className="gb-calendar-color-wheel" type="color" value={calendarColors[key]} aria-label={`${label} color wheel`} onChange={(event) => setCalendarColors(colors => ({ ...colors, [key]: event.target.value }))} /></label><span className="gb-calendar-color-info"><strong>{label}</strong><small>Current color <code>{calendarColors[key].toUpperCase()}</code></small></span><button type="button" className="gb-calendar-color-reset" onClick={() => setCalendarColors(colors => ({ ...colors, [key]: DEFAULT_CALENDAR_COLORS[key] }))}>Reset</button></div>)}</div>
              </details>

              <details className="gb-calendar-settings-section" open>
                <summary>Calendar Icons</summary>
                <p className="mb-3 text-xs text-zinc-400">Use letters, symbols, emoji, or a small uploaded image. Icon choices synchronize with the shop calendar settings.</p>
                <div className="gb-calendar-icon-grid">{([
                  ['schedule', 'Technician shifts'], ['partsOrdered', 'Parts ordered'], ['partsDelivery', 'Expected deliveries'], ['event', 'Events'], ['consultation', 'Consultations'], ['streaming', 'Streaming'], ['content', 'Content recording'], ['task', 'Tasks'], ['notes', 'Important notes'], ['federalHoliday', 'Federal holidays'], ['scTaxFreeWeekend', 'SC tax-free weekend'], ['daylightSaving', 'Daylight saving'], ['estimatedTaxDeadline', 'Tax reminders'],
                ] as Array<[CalendarIconKey, string]>).map(([key, label]) => {
                  const choice = calendarIcons[key];
                  return <div key={key} className="gb-calendar-icon-row"><span className="gb-calendar-icon-preview" style={{ backgroundColor: calendarColors[key] }}>{choice.kind === 'image' ? <img src={choice.value} alt="" /> : choice.value}</span><label><span>{label}</span><input type="text" value={choice.kind === 'text' ? choice.value : ''} placeholder="Letter or emoji" maxLength={6} onChange={(event) => updateCalendarIconText(key, event.target.value)} /></label><label className="gb-calendar-icon-upload">Upload<input type="file" accept="image/*" onChange={(event) => uploadCalendarIcon(key, event.target.files?.[0])} /></label><button type="button" onClick={() => setCalendarIcons(current => ({ ...current, [key]: DEFAULT_CALENDAR_ICONS[key] }))}>Default</button></div>;
                })}</div>
              </details>

              <details className="gb-calendar-settings-section">
                <summary>Technician Shift Color Wheels</summary>
                <div className="gb-calendar-color-grid technician-colors">
                  {techs.filter((tech: any) => tech?.active !== false).map((tech: any) => { const name = technicianDisplayName(tech); const color = technicianColors[name] || calendarColors.schedule; return <div key={tech.id || name} className="gb-calendar-color-row"><label className="gb-calendar-color-picker" title={`Choose ${name} shift color`}><input className="gb-calendar-color-wheel" type="color" value={color} aria-label={`${name} shift color wheel`} onChange={(event) => setTechnicianColors(colors => ({ ...colors, [name]: event.target.value }))} /></label><span className="gb-calendar-color-info"><strong>{name}</strong><small>{technicianColors[name] ? <>Custom shift color <code>{color.toUpperCase()}</code></> : <>Using default shift color <code>{color.toUpperCase()}</code></>}</small></span><button type="button" className="gb-calendar-color-reset" onClick={() => setTechnicianColors(colors => { const next = { ...colors }; delete next[name]; return next; })}>Reset</button></div>; })}
                  {!techs.length ? <p className="text-sm text-zinc-500">Add technicians in Admin to assign individual shift colors.</p> : null}
                </div>
              </details>
            </div>
            <div className="gb-calendar-settings-footer flex justify-between gap-2 border-t border-zinc-700 p-4">
              <button type="button" className="px-3 py-2 bg-zinc-800 border border-zinc-700 rounded" onClick={() => setCalendarColors(DEFAULT_CALENDAR_COLORS)}>Restore defaults</button>
              <div className="flex gap-2"><button type="button" className="px-3 py-2 bg-zinc-800 border border-zinc-700 rounded" onClick={() => { setCalendarColors(savedCalendarColors); setTechnicianColors(savedTechnicianColors); setBusinessCalendar(savedBusinessCalendar); setCalendarIcons(savedCalendarIcons); setCalendarSettingsOpen(false); }}>Cancel</button><button type="button" className="px-3 py-2 bg-[#39FF14] text-black font-semibold rounded disabled:opacity-50" disabled={calendarSettingsSaving} onClick={() => { void saveCalendarSettings(); }}>{calendarSettingsSaving ? 'Saving...' : 'Save settings'}</button></div>
            </div>
          </section>
        </div>
      ), document.body)}

      {viewingGroup && viewingGroup.length ? (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-3" onClick={() => setViewingGroup(null)}>
          <section className="w-full max-w-[620px] max-h-[86vh] overflow-hidden rounded border border-zinc-700 bg-zinc-900 shadow-2xl flex flex-col" role="dialog" aria-modal="true" aria-labelledby="calendar-group-title" onClick={event => event.stopPropagation()}>
            <header className="flex items-start justify-between gap-3 border-b border-zinc-800 p-4"><div><h3 id="calendar-group-title" className="text-xl font-semibold">{calendarEventVisual(viewingGroup[0], calendarColors).label}</h3><p className="text-sm text-zinc-400">{new Date(`${viewingGroup[0].date}T12:00:00`).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })} - {viewingGroup.length} {viewingGroup.length === 1 ? 'entry' : 'entries'}</p></div><button type="button" className="gb-icon-button" aria-label="Close grouped calendar entries" onClick={() => setViewingGroup(null)}>X</button></header>
            <div className="min-h-0 overflow-y-auto p-3 space-y-2">
              {viewingGroup.slice().sort((left, right) => toMinutes(left.time) - toMinutes(right.time)).map((event, index) => (
                <div key={event.id || index} className="flex items-center gap-3 rounded border border-zinc-700 bg-zinc-800 p-3" onContextMenu={(contextEvent) => calendarContext.openFromEvent(contextEvent, [event])}>
                  {event.category === 'task' ? <input type="checkbox" className="h-5 w-5 shrink-0 accent-violet-400" checked={taskIsCompleted(event)} aria-label={`Mark ${event.title || 'task'} complete`} onChange={change => { void setTaskCompleted(event, change.target.checked); }} /> : <span className="gb-calendar-event-icon shrink-0" style={{ backgroundColor: calendarEventVisual(event, calendarColors).color }}><CalendarIconContent event={event} icons={calendarIcons} fallback={calendarEventVisual(event, calendarColors).short} /></span>}
                  <button type="button" className="min-w-0 flex-1 text-left" onClick={() => { setViewingGroup(null); setViewing(event); }}><strong className={`block break-words ${taskIsCompleted(event) ? 'text-zinc-500 line-through' : ''}`}>{eventSummary(event)}</strong><small className="block text-zinc-400">{event.technician || event.location || (event.id != null ? 'Open details' : '')}</small></button>
                </div>
              ))}
            </div>
          </section>
        </div>
      ) : null}

      {viewing && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-3">
          <div className="gb-calendar-event-detail bg-zinc-900 border border-zinc-700 rounded w-full max-w-[480px] max-h-[88vh] overflow-y-auto">
            <div className="flex items-start justify-between gap-3 p-4 border-b border-zinc-800">
              <div className="flex items-center gap-3 min-w-0">
                <span className="gb-calendar-event-icon" style={{ backgroundColor: calendarEventVisual(viewing, calendarColors).color }}><CalendarIconContent event={viewing} icons={calendarIcons} fallback={calendarEventVisual(viewing, calendarColors).short} /></span>
                <div className="min-w-0">
                  <div className="text-xs uppercase text-zinc-400">{calendarEventVisual(viewing, calendarColors).label}</div>
                  <h3 className="font-semibold text-lg break-words">{viewing.title || calendarEventVisual(viewing, calendarColors).label}</h3>
                </div>
              </div>
              <button type="button" className="gb-icon-button" aria-label="Close event details" onClick={() => setViewing(null)}>X</button>
            </div>
            <div className="gb-calendar-detail-grid p-4">
              <div><span>Date</span><strong>{new Date(`${viewing.date}T12:00:00`).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</strong></div>
              <div><span>Time</span><strong>{viewing.category === 'task' && !viewing.time && !viewing.endTime ? 'All Day' : (formatTime12FromHHmm(viewing.time || '') || 'Not specified')}{viewing.endTime ? ` - ${formatTime12FromHHmm(viewing.endTime)}` : ''}</strong></div>
              {viewing.technician ? <div><span>Assigned</span><strong>{viewing.technician}</strong></div> : null}
              {viewing.customerName ? <div><span>Client</span><strong>{viewing.customerName}</strong></div> : null}
              {viewing.customerPhone ? <div><span>Phone</span><strong>{formatPhone(viewing.customerPhone)}</strong></div> : null}
              {viewing.customerEmail ? <div><span>Email</span><strong>{viewing.customerEmail}</strong></div> : null}
              {viewing.category === 'consultation' && viewing.consultationAddress ? <div className="detail-wide"><span>Address</span><strong>{viewing.consultationAddress}</strong>{!/^at shop location$/i.test(viewing.consultationAddress) ? <button type="button" className="gb-mobile-map-button mt-2 rounded border border-blue-500 bg-blue-600 px-3 py-2 text-xs font-semibold" onClick={() => openConsultationAddressInMaps(viewing.consultationAddress || '')}>Open Maps</button> : null}</div> : null}
              {viewing.location ? <div><span>Platform / location</span><strong>{viewing.location}</strong></div> : null}
              {viewing.partName ? <div><span>Part / product</span><strong>{viewing.partName}</strong></div> : null}
              {viewing.workOrderId ? <div><span>Work order</span><strong>{viewing.workOrderLabel || 'Work order unavailable'}</strong></div> : null}
              {viewing.notes ? <div className="detail-wide"><span>Notes</span><strong>{viewing.notes}</strong></div> : null}
            </div>
            {viewing.category !== 'schedule' ? (
              <div className="flex justify-end gap-2 p-4 border-t border-zinc-800">
                {viewing.category === 'task' ? <button type="button" className={`px-3 py-2 rounded font-semibold ${taskIsCompleted(viewing) ? 'bg-zinc-700 text-zinc-100' : 'bg-violet-500 text-white'}`} onClick={() => { void setTaskCompleted(viewing, !taskIsCompleted(viewing)); }}>{taskIsCompleted(viewing) ? 'Mark Incomplete' : 'Complete Task'}</button> : null}
                <button type="button" className="px-3 py-2 bg-zinc-800 border border-zinc-700 rounded" onClick={() => onEdit(viewing)}>Edit</button>
              </div>
            ) : null}
          </div>
        </div>
      )}

      {contentScheduleOpen && (
        <div className="fixed inset-0 z-40 bg-black/70 flex items-center justify-center p-3">
          <div className="gb-content-schedule bg-zinc-900 border border-zinc-700 rounded w-full max-w-[1180px] max-h-[92vh] overflow-hidden flex flex-col">
            <div className="flex items-center justify-between gap-3 p-4 border-b border-zinc-800">
              <div>
                <h3 className="font-semibold text-xl">Streaming/Content Schedule</h3>
                <p className="text-xs text-zinc-400">Plan streams, filming, and production work for the selected week.</p>
              </div>
              <button type="button" className="gb-icon-button" aria-label="Close streaming and content schedule" onClick={() => setContentScheduleOpen(false)}>X</button>
            </div>
            <div className="gb-content-week-nav">
              <button type="button" aria-label="Previous content week" onClick={() => setCurrent(addDays(current, -7))}>&lt;</button>
              <strong>{contentWeekDays[0].toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} - {contentWeekDays[6].toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</strong>
              <button type="button" aria-label="Next content week" onClick={() => setCurrent(addDays(current, 7))}>&gt;</button>
            </div>
            <div className="gb-content-week-list">
              {contentWeekDays.map((day) => {
                const date = fmtDate(day);
                const isToday = date === fmtDate(new Date());
                const entries = events
                  .filter((event) => event.category === 'content' && event.date === date)
                  .sort((a, b) => toMinutes(a.time) - toMinutes(b.time));
                return (
                  <section key={date} className={isToday ? 'is-today' : ''}>
                    <header>
                      <button
                        type="button"
                        className="gb-content-day-button"
                        onClick={() => {
                          setCurrent(day);
                          setCalendarView('day');
                          setContentScheduleOpen(false);
                        }}
                      >
                        <strong>{day.toLocaleDateString(undefined, { weekday: 'short' })}</strong>
                        <span>{day.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>
                        {isToday ? <em>Today</em> : null}
                      </button>
                      <button
                        type="button"
                        aria-label={`Add streaming or content entry for ${date}`}
                        onClick={() => {
                          setContentEditorLocked(true);
                          setEditing({ date, title: '', time: '', endTime: '', category: 'content', source: 'streaming', technician: '' });
                        }}
                      >
                        +
                      </button>
                    </header>
                    <div className="gb-content-day-events">
                      {entries.map((entry, index) => {
                        const visual = calendarEventVisual(entry);
                        return (
                          <button
                            key={entry.id || `${date}-${index}`}
                            type="button"
                            aria-label={`${visual.label}: ${eventSummary(entry)}`}
                            onClick={() => setViewing(entry)}
                          >
                            <span className={`gb-calendar-event-icon ${visual.color}`}>{visual.short}</span>
                            <span><strong>{eventSummary(entry)}</strong>{entry.location ? <small>{entry.location}</small> : null}</span>
                          </button>
                        );
                      })}
                      {!entries.length ? <p aria-label="No streaming or content scheduled">—</p> : null}
                    </div>
                  </section>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {editing && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center">
          <div className={`gb-calendar-editor bg-zinc-900 border border-zinc-700 rounded p-4 ${editing.category === 'task' && editing.id == null ? 'w-[min(96vw,1080px)]' : 'w-[min(94vw,760px)]'}`}>
            <h3 className="font-semibold mb-2">
              {contentEditorLocked ? 'Add streaming/content entry' : `${editing.id ? 'Edit' : 'Add'} calendar entry`}
            </h3>
            <div className={`gb-calendar-entry-editor-layout ${!contentEditorLocked ? 'has-type-rail' : ''}`}>
            {/* Category selector */}
            {!contentEditorLocked && !editing.id ? <aside className="gb-calendar-entry-type-rail" aria-label="Calendar entry type">
              {([
                { key: 'parts', label: 'Parts/Products' },
                { key: 'event', label: 'Events' },
                { key: 'consultation', label: 'Consultation' },
                { key: 'content', label: 'Streaming/Content' },
                { key: 'task', label: 'Tasks' },
              ] as const).map(opt => (
                <button
                  key={opt.key}
                  className={`rounded border text-left text-xs ${editing.category === opt.key ? 'bg-[#39FF14] text-black border-[#39FF14]' : 'bg-zinc-800 border-zinc-700 text-zinc-200'}`}
                  onClick={() => {
                    setTaskQueue([]);
                    setTaskBatchError('');
                    setEditing({ ...editing, category: opt.key as any, title: '', notes: '' });
                  }}
                >{opt.label}</button>
              ))}
            </aside> : !contentEditorLocked ? <aside className="gb-calendar-entry-type-rail is-readonly"><div className="flex items-center gap-2 rounded border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm"><span className={`gb-calendar-event-icon ${calendarEventVisual(editing).color}`}>{calendarEventVisual(editing).short}</span><strong>{calendarEventVisual(editing).label}</strong></div></aside> : null}
            <div className="gb-calendar-entry-form min-w-0">
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-xs text-zinc-400">Date</label>
                <input type="date" className="w-full mt-1 bg-zinc-800 border border-zinc-700 rounded px-2 py-1" value={editing.date} onChange={e => setEditing({ ...editing, date: e.target.value })} />
              </div>
              {editing.category === 'task' ? (
                <label className="mt-5 flex min-h-9 items-center gap-2 rounded border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm">
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-violet-400"
                    checked={!editing.time && !editing.endTime}
                    onChange={event => setEditing(event.target.checked
                      ? { ...editing, time: '', endTime: '' }
                      : { ...editing, time: editing.time || '09:00', endTime: editing.endTime || '10:00' })}
                  />
                  <span>All Day</span>
                </label>
              ) : <div>
                  <label className="block text-xs text-zinc-400">Time</label>
                  <input type="time" className="w-full mt-1 bg-zinc-800 border border-zinc-700 rounded px-2 py-1" value={editing.time || ''} onChange={e => setEditing({ ...editing, time: e.target.value })} />
                </div>}
              {editing.category === 'task' && (editing.time || editing.endTime) && <>
                <div>
                  <label className="block text-xs text-zinc-400">Start time</label>
                  <input type="time" className="w-full mt-1 bg-zinc-800 border border-zinc-700 rounded px-2 py-1" value={editing.time || ''} onChange={event => setEditing({ ...editing, time: event.target.value })} />
                </div>
                <div>
                  <label className="block text-xs text-zinc-400">End time</label>
                  <input type="time" className="w-full mt-1 bg-zinc-800 border border-zinc-700 rounded px-2 py-1" value={editing.endTime || ''} onChange={event => setEditing({ ...editing, endTime: event.target.value })} />
                </div>
              </>}
              {editing.category === 'content' && (
                <div>
                  <label className="block text-xs text-zinc-400">End time</label>
                  <input type="time" className="w-full mt-1 bg-zinc-800 border border-zinc-700 rounded px-2 py-1" value={editing.endTime || ''} onChange={e => setEditing({ ...editing, endTime: e.target.value })} />
                </div>
              )}
              {!contentEditorLocked && !['business-calendar', 'shift-override', 'shift-request'].includes(String(editing.source || '')) ? (
                <div className="col-span-2 rounded border border-zinc-700 bg-zinc-950/45 p-3">
                  <label className="flex items-center gap-2 text-sm font-semibold">
                    <input type="checkbox" className="h-4 w-4 accent-[#39FF14]" checked={Boolean(editing.recurrenceRule)} onChange={(event) => {
                      if (!event.target.checked) return setEditing({ ...editing, recurrenceRule: null });
                      const start = new Date(`${editing.date}T12:00:00`);
                      setEditing({ ...editing, recurrenceRule: { version: 1, frequency: 'weekly', interval: 1, weekdays: [Number.isNaN(start.getTime()) ? 0 : start.getDay()] } });
                    }} />
                    <span>Recurring entry</span>
                  </label>
                  {editing.recurrenceRule ? (() => {
                    const rule = normalizeRecurrenceRule(editing.recurrenceRule) || { version: 1 as const, frequency: 'weekly' as const, interval: 1, weekdays: [] };
                    const updateRule = (patch: Partial<CalendarRecurrenceRule>) => setEditing({ ...editing, recurrenceRule: { ...rule, ...patch } });
                    const weekdayLabels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
                    return <div className="mt-3 grid gap-3 sm:grid-cols-2">
                      <div><label className="block text-xs text-zinc-400">Repeats</label><select className="mt-1 w-full rounded border border-zinc-700 bg-zinc-800 px-2 py-2" value={rule.frequency} onChange={(event) => {
                        const frequency = event.target.value as CalendarRecurrenceRule['frequency'];
                        const start = new Date(`${editing.date}T12:00:00`);
                        if (frequency === 'daily') updateRule({ frequency, weekdays: undefined, monthlyMode: undefined });
                        else if (frequency === 'weekly') updateRule({ frequency, weekdays: [Number.isNaN(start.getTime()) ? 0 : start.getDay()], monthlyMode: undefined });
                        else updateRule({ frequency, weekdays: undefined, monthlyMode: 'dayOfMonth', monthDay: Number(editing.date.slice(8, 10)) || 1 });
                      }}><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option></select></div>
                      <div><label className="block text-xs text-zinc-400">End date (optional)</label><input type="date" min={editing.date} className="mt-1 w-full rounded border border-zinc-700 bg-zinc-800 px-2 py-2" value={rule.until || ''} onChange={(event) => updateRule({ until: event.target.value || undefined })} /></div>
                      {rule.frequency === 'weekly' ? <div className="sm:col-span-2"><div className="mb-1 text-xs text-zinc-400">Repeat on</div><div className="grid grid-cols-7 gap-1">{weekdayLabels.map((label, weekday) => {
                        const selected = (rule.weekdays || []).includes(weekday);
                        return <button key={label} type="button" aria-pressed={selected} className={`min-h-9 rounded border px-1 text-xs font-semibold ${selected ? 'border-[#39FF14] bg-[#39FF14] text-black' : 'border-zinc-700 bg-zinc-800 text-zinc-300'}`} onClick={() => {
                          const next = selected ? (rule.weekdays || []).filter((value) => value !== weekday) : [...(rule.weekdays || []), weekday].sort();
                          if (next.length) updateRule({ weekdays: next });
                        }}>{label}</button>;
                      })}</div></div> : null}
                      {rule.frequency === 'monthly' ? <div className="sm:col-span-2 space-y-2"><div className="grid grid-cols-2 gap-2">
                        <button type="button" className={`rounded border px-2 py-2 text-sm ${rule.monthlyMode !== 'weekdayPattern' ? 'border-[#39FF14] bg-[#39FF14]/15 text-[#39FF14]' : 'border-zinc-700 bg-zinc-800'}`} onClick={() => updateRule({ monthlyMode: 'dayOfMonth', monthDay: Number(editing.date.slice(8, 10)) || 1 })}>Day of month</button>
                        <button type="button" className={`rounded border px-2 py-2 text-sm ${rule.monthlyMode === 'weekdayPattern' ? 'border-[#39FF14] bg-[#39FF14]/15 text-[#39FF14]' : 'border-zinc-700 bg-zinc-800'}`} onClick={() => { const pattern = monthlyWeekdayPatternForDate(editing.date); updateRule({ monthlyMode: 'weekdayPattern', monthlyOrdinal: pattern.ordinal, monthlyWeekday: pattern.weekday }); }}>Weekday pattern</button>
                      </div>{rule.monthlyMode === 'weekdayPattern' ? <div className="grid grid-cols-2 gap-2">
                        <select className="rounded border border-zinc-700 bg-zinc-800 px-2 py-2" value={rule.monthlyOrdinal || 1} onChange={(event) => updateRule({ monthlyOrdinal: Number(event.target.value) as 1 | 2 | 3 | 4 | -1 })}><option value="1">First</option><option value="2">Second</option><option value="3">Third</option><option value="4">Fourth</option><option value="-1">Last</option></select>
                        <select className="rounded border border-zinc-700 bg-zinc-800 px-2 py-2" value={rule.monthlyWeekday ?? 0} onChange={(event) => updateRule({ monthlyWeekday: Number(event.target.value) })}>{weekdayLabels.map((label, index) => <option key={label} value={index}>{label}</option>)}</select>
                      </div> : <label className="flex items-center gap-2 text-sm"><span>Day</span><input type="number" min="1" max="31" className="w-24 rounded border border-zinc-700 bg-zinc-800 px-2 py-2" value={rule.monthDay || 1} onChange={(event) => updateRule({ monthDay: Math.max(1, Math.min(31, Number(event.target.value) || 1)) })} /><span className="text-zinc-400">of each month</span></label>}</div> : null}
                    </div>;
                  })() : null}
                </div>
              ) : null}
              {/* Dynamic fields per category */}
              {editing.category === 'parts' && (
                <>
                  <div className="col-span-2">
                    <label className="block text-xs text-zinc-400">Part or product name</label>
                    <input className="w-full mt-1 bg-zinc-800 border border-zinc-700 rounded px-2 py-1" value={editing.partName || ''} onChange={e => setEditing({ ...editing, partName: e.target.value })} />
                  </div>
                  <div>
                    <label className="block text-xs text-zinc-400">Work order # (optional)</label>
                    <input type="number" className="w-full mt-1 bg-zinc-800 border border-zinc-700 rounded px-2 py-1" value={editing.workOrderId || ''} onChange={e => setEditing({ ...editing, workOrderId: e.target.value ? Number(e.target.value) : undefined })} />
                  </div>
                  <div>
                    <label className="block text-xs text-zinc-400">Order URL (optional)</label>
                    <input className="w-full mt-1 bg-zinc-800 border border-zinc-700 rounded px-2 py-1" value={editing.orderUrl || ''} onChange={e => setEditing({ ...editing, orderUrl: e.target.value })} />
                  </div>
                  <div>
                    <label className="block text-xs text-zinc-400">Tracking URL (optional)</label>
                    <input className="w-full mt-1 bg-zinc-800 border border-zinc-700 rounded px-2 py-1" value={(editing as any).trackingUrl || ''} onChange={e => setEditing({ ...(editing as any), trackingUrl: e.target.value })} />
                  </div>
                  <div className="col-span-2">
                    <label className="block text-xs text-zinc-400">Estimated delivery date(s)</label>
                    <div className="flex items-end gap-2 mt-1">
                      <div className="flex-1">
                        <input
                          type="date"
                          className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1"
                          value={deliveryDateInput}
                          onChange={e => setDeliveryDateInput(e.target.value)}
                        />
                      </div>
                      <button
                        type="button"
                        className="px-2 py-1 text-xs bg-zinc-800 border border-zinc-700 rounded hover:bg-zinc-700"
                        onClick={() => {
                          const v = (deliveryDateInput || '').trim();
                          if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return;
                          setDeliveryDates(list => (list.includes(v) ? list : [...list, v]));
                          setDeliveryDateInput('');
                        }}
                      >Add</button>
                    </div>
                    {deliveryDates.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-2">
                        {deliveryDates.map(d => (
                          <span key={d} className="inline-flex items-center gap-1 text-xs bg-zinc-800 border border-zinc-700 rounded px-2 py-0.5">
                            {d}
                            <button
                              type="button"
                              className="text-zinc-400 hover:text-zinc-200"
                              onClick={() => setDeliveryDates(list => list.filter(x => x !== d))}
                              aria-label={`Remove ${d}`}
                            >×</button>
                          </span>
                        ))}
                      </div>
                    )}
                    <div className="text-[10px] text-zinc-500 mt-1">Saving will add one calendar entry per date above, marked as delivery (D).</div>
                  </div>
                </>
              )}
              {editing.category === 'event' && (
                <>
                  <div className="col-span-2">
                    <label className="block text-xs text-zinc-400">Title</label>
                    <input className="w-full mt-1 bg-zinc-800 border border-zinc-700 rounded px-2 py-1" value={editing.title} onChange={e => setEditing({ ...editing, title: e.target.value })} />
                  </div>
                  <div className="col-span-2">
                    <label className="block text-xs text-zinc-400">Location (optional)</label>
                    <input className="w-full mt-1 bg-zinc-800 border border-zinc-700 rounded px-2 py-1" value={editing.location || ''} onChange={e => setEditing({ ...editing, location: e.target.value })} />
                  </div>
                </>
              )}
              {editing.category === 'task' && (
                <div className="gb-calendar-task-builder col-span-2 grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(17rem,0.8fr)]">
                  <div className="min-w-0 space-y-3">
                    <div>
                      <label className="block text-xs text-zinc-400">Assigned technicians</label>
                      <details className="relative mt-1">
                        <summary className="flex min-h-10 w-full cursor-pointer list-none items-center justify-between gap-2 rounded border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm marker:content-none">
                          <span className="min-w-0 truncate">{taskAssignmentLabel(editing.technician)}</span>
                          <span className="shrink-0 text-zinc-400">▾</span>
                        </summary>
                        <div className="absolute left-0 right-0 z-30 mt-1 max-h-56 overflow-y-auto rounded border border-zinc-600 bg-zinc-900 p-1 shadow-2xl">
                          <button
                            type="button"
                            aria-pressed={isSharedTaskAssignment(editing.technician)}
                            className={`mb-1 w-full rounded px-3 py-2 text-left text-sm ${isSharedTaskAssignment(editing.technician) ? 'bg-violet-500 font-semibold text-white' : 'text-zinc-200 hover:bg-zinc-800'}`}
                            onClick={() => setEditing({ ...editing, technician: ALL_TECHNICIANS })}
                          >
                            All Technicians
                          </button>
                          {techs.map((tech: any) => {
                            const name = technicianDisplayName(tech);
                            const selected = taskAssignments(editing.technician).some((assigned) => assigned.toLowerCase() === name.toLowerCase());
                            return <button
                              key={tech.id || name}
                              type="button"
                              aria-pressed={selected}
                              className={`mb-1 flex w-full items-center justify-between gap-2 rounded px-3 py-2 text-left text-sm last:mb-0 ${selected ? 'bg-violet-500 font-semibold text-white' : 'text-zinc-200 hover:bg-zinc-800'}`}
                              onClick={() => setEditing({ ...editing, technician: toggleTaskAssignment(editing.technician, name) })}
                            >
                              <span className="truncate">{name}</span>
                              {selected ? <span aria-hidden="true">✓</span> : null}
                            </button>;
                          })}
                        </div>
                      </details>
                      <p className="mt-1 text-[10px] text-zinc-500">Select one or more technicians. Selected names are saved together.</p>
                    </div>
                    <div>
                      <label className="block text-xs text-zinc-400">Subject</label>
                      <input autoFocus className="w-full mt-1 bg-zinc-800 border border-zinc-700 rounded px-2 py-2" value={editing.title || ''} onChange={event => setEditing({ ...editing, title: event.target.value })} placeholder="What needs to be completed?" />
                    </div>
                    <div>
                      <label className="block text-xs text-zinc-400">Task details</label>
                      <textarea className="w-full mt-1 min-h-[7.5rem] resize-y bg-zinc-800 border border-zinc-700 rounded px-2 py-2" value={editing.notes || ''} onChange={event => setEditing({ ...editing, notes: event.target.value })} placeholder="Instructions, checklist details, or context" />
                    </div>
                    {editing.id == null ? <button type="button" className="w-full rounded border border-violet-300 bg-violet-500 px-3 py-2 text-sm font-bold text-white hover:brightness-110" onClick={addTaskToQueue}>Add to Task List</button> : null}
                    {editing.id != null ? <label className="flex items-center gap-2 rounded border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm"><input type="checkbox" className="h-4 w-4 accent-violet-400" checked={taskIsCompleted(editing)} onChange={event => setEditing({ ...editing, taskCompleted: event.target.checked, taskCompletedAt: event.target.checked ? new Date().toISOString() : '', taskCompletedBy: event.target.checked ? String(editing.technician || '') : '' })} /><span>Completed</span></label> : null}
                  </div>
                  {editing.id == null ? <div className="gb-calendar-task-queue min-w-0 rounded border border-zinc-700 bg-zinc-950/60 p-3">
                    <div className="mb-2 flex items-center justify-between gap-2"><strong className="text-sm">Tasks for {editing.date}</strong><span className="rounded bg-violet-500/20 px-2 py-0.5 text-xs text-violet-200">{visibleTaskAssignments.length + taskQueue.length} total</span></div>
                    <div className="max-h-[22rem] space-y-2 overflow-y-auto pr-1">
                      {visibleTaskAssignments.map((task, index) => <div key={task.id ?? `saved-${index}`} className="rounded border border-zinc-800 bg-zinc-900 px-3 py-2"><strong className={`block break-words text-sm ${taskIsCompleted(task) ? 'text-zinc-500 line-through' : ''}`}>{task.title || 'Task'}</strong><small className="mt-1 block text-zinc-400">Saved - {taskAssignmentLabel(task.technician)}</small>{task.notes ? <p className="mt-1 line-clamp-2 whitespace-pre-wrap text-xs text-zinc-400">{task.notes}</p> : null}</div>)}
                      {taskQueue.map((task, index) => <div key={`queued-${index}`} className="rounded border border-violet-400/60 bg-violet-950/30 px-3 py-2"><div className="flex items-start justify-between gap-2"><strong className="min-w-0 break-words text-sm">{task.title}</strong><button type="button" className="shrink-0 text-xs text-red-300 hover:text-red-200" onClick={() => setTaskQueue(current => current.filter((_, itemIndex) => itemIndex !== index))}>Remove</button></div><small className="mt-1 block text-violet-200">Ready to save - {taskAssignmentLabel(task.technician)}</small>{task.notes ? <p className="mt-1 line-clamp-2 whitespace-pre-wrap text-xs text-zinc-300">{task.notes}</p> : null}</div>)}
                      {!visibleTaskAssignments.length && !taskQueue.length ? <p className="py-8 text-center text-sm text-zinc-500">No tasks are assigned here yet.</p> : null}
                    </div>
                  </div> : null}
                  {taskBatchError ? <div className="md:col-span-2 rounded border border-red-600/70 bg-red-950/40 px-3 py-2 text-sm text-red-200">{taskBatchError}</div> : null}
                </div>
              )}
              {editing.category === 'consultation' && (
                <>
                  <div>
                    <label className="block text-xs text-zinc-400">Customer name</label>
                    <input className="w-full mt-1 bg-zinc-800 border border-zinc-700 rounded px-2 py-1" value={editing.customerName || ''} onChange={e => setEditing({ ...editing, customerName: e.target.value })} />
                  </div>
                  <div>
                    <label className="block text-xs text-zinc-400">Phone</label>
                    <input className="w-full mt-1 bg-zinc-800 border border-zinc-700 rounded px-2 py-1" value={editing.customerPhone || ''} onChange={e => setEditing({ ...editing, customerPhone: e.target.value })} />
                  </div>
                  <div>
                    <label className="block text-xs text-zinc-400">Email</label>
                    <input type="email" className="w-full mt-1 bg-zinc-800 border border-zinc-700 rounded px-2 py-1" value={editing.customerEmail || ''} onChange={e => setEditing({ ...editing, customerEmail: e.target.value })} />
                  </div>
                  <div>
                    <label className="block text-xs text-zinc-400">Address</label>
                    <input className="w-full mt-1 bg-zinc-800 border border-zinc-700 rounded px-2 py-1" value={editing.consultationAddress || editing.location || ''} onChange={e => setEditing({ ...editing, consultationAddress: e.target.value, location: e.target.value })} />
                  </div>
                  <div>
                    <label className="block text-xs text-zinc-400">Technician</label>
                    <input className="w-full mt-1 bg-zinc-800 border border-zinc-700 rounded px-2 py-1" value={editing.technician || ''} onChange={e => setEditing({ ...editing, technician: e.target.value })} />
                  </div>
                  <div>
                    <label className="block text-xs text-zinc-400">Title (optional)</label>
                    <input className="w-full mt-1 bg-zinc-800 border border-zinc-700 rounded px-2 py-1" value={editing.title} onChange={e => setEditing({ ...editing, title: e.target.value })} />
                  </div>
                  <div className="col-span-2 flex gap-2 mt-1">
                    <button
                      type="button"
                      className="text-xs px-2 py-1 bg-zinc-800 border border-zinc-700 rounded hover:bg-zinc-700"
                      onClick={() => { void openConsultationSale(editing); }}
                      title="Open linked consultation sale"
                    >
                      View Consultation Sale
                    </button>
                    <button
                      type="button"
                      className="text-xs px-2 py-1 bg-zinc-800 border border-zinc-700 rounded hover:bg-zinc-700"
                      onClick={() => { void openConsultationCustomer(editing); }}
                      title="Open linked customer record"
                    >
                      View Client Info
                    </button>
                  </div>
                </>
              )}
              {editing.category === 'content' && (
                <>
                  <div className="col-span-2">
                    <label className="block text-xs text-zinc-400">Session type</label>
                    <div className="grid grid-cols-2 gap-2 mt-1">
                      <button
                        type="button"
                        className={`px-3 py-2 border rounded text-sm ${editing.source === 'streaming' ? 'bg-fuchsia-600 border-fuchsia-400 text-white' : 'bg-zinc-800 border-zinc-700'}`}
                        onClick={() => setEditing({ ...editing, source: 'streaming' })}
                      >
                        Streaming
                      </button>
                      <button
                        type="button"
                        className={`px-3 py-2 border rounded text-sm ${editing.source === 'content' ? 'bg-cyan-500 border-cyan-300 text-black' : 'bg-zinc-800 border-zinc-700'}`}
                        onClick={() => setEditing({ ...editing, source: 'content' })}
                      >
                        Record Content
                      </button>
                    </div>
                  </div>
                  <div className="col-span-2">
                    <label className="block text-xs text-zinc-400">Who is involved</label>
                    <input
                      list="calendar-content-names"
                      className="w-full mt-1 bg-zinc-800 border border-zinc-700 rounded px-2 py-1"
                      value={editing.technician || ''}
                      onChange={e => setEditing({ ...editing, technician: e.target.value })}
                      placeholder="Name or names"
                    />
                    <datalist id="calendar-content-names">
                      {techs.map((tech: any) => {
                        const name = technicianDisplayName(tech);
                        return <option key={tech.id || name} value={name} />;
                      })}
                    </datalist>
                  </div>
                  <div className="col-span-2">
                    <label className="block text-xs text-zinc-400">What is being streamed or recorded</label>
                    <input
                      className="w-full mt-1 bg-zinc-800 border border-zinc-700 rounded px-2 py-1"
                      value={editing.title || ''}
                      onChange={e => setEditing({ ...editing, title: e.target.value })}
                      placeholder="Game, stream type, video topic, or production task"
                    />
                  </div>
                  <div className="col-span-2">
                    <label className="block text-xs text-zinc-400">Platform or location (optional)</label>
                    <input
                      className="w-full mt-1 bg-zinc-800 border border-zinc-700 rounded px-2 py-1"
                      value={editing.location || ''}
                      onChange={e => setEditing({ ...editing, location: e.target.value })}
                      placeholder="Twitch, YouTube, studio, shop floor..."
                    />
                  </div>
                </>
              )}
              {/* Schedule entries are managed in Admin → Technicians and are not editable here */}
              {editing.category !== 'task' ? <div className="col-span-2">
                <div className="flex items-center justify-between gap-3">
                  <label className="block text-xs text-zinc-400">Notes</label>
                  <button
                    type="button"
                    className="px-2.5 py-1 text-xs bg-zinc-800 border border-zinc-700 rounded hover:bg-zinc-700"
                    onClick={() => setNotesExpanded(true)}
                  >
                    Expand Notes
                  </button>
                </div>
                <textarea
                  className="gb-calendar-notes w-full mt-1 bg-zinc-800 border border-zinc-700 rounded px-2 py-2 min-h-[190px] resize-y"
                  value={editing.notes || ''}
                  onChange={e => setEditing({ ...editing, notes: e.target.value })}
                />
              </div> : null}
            </div>
            <div className="flex justify-end gap-2 mt-3">
              {editing.id && <button className="px-3 py-1 bg-red-700 text-white rounded" onClick={() => deleteEvent(editing)}>Delete</button>}
              <button className="px-3 py-1 bg-zinc-800 border border-zinc-700 rounded" onClick={() => { setEditing(null); setTaskQueue([]); setTaskBatchError(''); setContentEditorLocked(false); }}>Cancel</button>
              <button className="px-3 py-1 bg-[#39FF14] text-black rounded disabled:opacity-50" disabled={taskBatchSaving} onClick={() => editing.category === 'task' && editing.id == null ? void saveTaskBatch() : void saveEvent(editing)}>{editing.category === 'task' && editing.id == null ? (taskBatchSaving ? 'Saving Tasks...' : `Save Tasks (${taskSaveCount})`) : 'Save'}</button>
            </div>
            </div>
            </div>
          </div>
        </div>
      )}

      {editing && notesExpanded && (
        <div
          className="fixed inset-0 z-[70] bg-black/75 flex items-center justify-center p-3 sm:p-6"
          role="presentation"
          onClick={() => setNotesExpanded(false)}
        >
          <div
            className="w-full max-w-[860px] max-h-[88vh] bg-zinc-900 border border-zinc-700 rounded shadow-2xl flex flex-col"
            role="dialog"
            aria-modal="true"
            aria-labelledby="calendar-expanded-notes-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-zinc-800">
              <div className="min-w-0">
                <h3 id="calendar-expanded-notes-title" className="font-semibold text-lg">Calendar Entry Notes</h3>
                <p className="text-xs text-zinc-400 truncate">{editing.title || calendarEventVisual(editing).label}</p>
              </div>
              <button type="button" className="gb-icon-button" aria-label="Close expanded notes" onClick={() => setNotesExpanded(false)}>X</button>
            </div>
            <div className="p-4 flex-1 min-h-0">
              <textarea
                autoFocus
                className="w-full h-[58vh] min-h-[300px] max-h-[68vh] bg-zinc-800 border border-zinc-700 rounded px-3 py-3 resize-none leading-relaxed"
                value={editing.notes || ''}
                onChange={(event) => setEditing({ ...editing, notes: event.target.value })}
                placeholder="Add detailed notes for this calendar entry..."
              />
            </div>
          </div>
        </div>
      )}

      {dailyLookOpen && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center">
          <div className="bg-zinc-900 border border-zinc-700 rounded p-4 w-[780px] max-w-[95vw] max-h-[90vh] overflow-hidden flex flex-col">
            <div className="flex items-start justify-between gap-3 mb-3">
              <div>
                <div className="text-xl font-semibold">Daily Look</div>
                <div className="text-xs text-zinc-400">Schedules, tasks, parts, events, consultations, and important notes for the day.</div>
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="date"
                  className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-sm"
                  value={dailyLookData.ymd}
                  onChange={e => setDailyLookDate(e.target.value)}
                />
                <select
                  className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-sm max-w-[220px]"
                  value={dailyLookAssignedTo}
                  onChange={e => setDailyLookAssignedTo(e.target.value)}
                  title="Assigned to"
                >
                  <option value="">Assigned: All</option>
                  {Array.isArray(techs) && techs.map((t: any) => {
                    const techName = technicianDisplayName(t);
                    return (
                      <option key={t.id || techName} value={techName}>
                        {techName}
                      </option>
                    );
                  })}
                </select>
                <button
                  className="px-3 py-1 bg-zinc-800 border border-zinc-700 rounded text-sm"
                  onClick={() => setDailyLookOpen(false)}
                >
                  Close
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-auto grid grid-cols-2 gap-3">
              <div className="border border-amber-500/40 rounded p-3 col-span-2 bg-amber-500/5">
                <div className="font-semibold mb-2 flex items-center justify-between"><span>Important Notes</span><span className="text-xs text-amber-300">{dailyLookData.importantNotes.length}</span></div>
                {dailyLookData.importantNotes.length === 0 ? <div className="text-sm text-zinc-500">No important notes for this day.</div> : <div className="grid grid-cols-2 gap-2">{dailyLookData.importantNotes.map(note => <button key={String(note.id)} type="button" className="rounded border border-zinc-800 bg-zinc-900/60 p-2 text-left text-sm" onClick={() => { setNotesDate(dailyLookData.ymd); setEditingNoteId(String(note.id)); setNoteDraft({ subject: note.subject || '', body: note.body || '' }); }}><strong className="block break-words text-amber-100">{note.subject || 'Important Note'}</strong><span className="mt-1 block text-xs text-zinc-400 line-clamp-2">{note.body}</span></button>)}</div>}
              </div>
              <div className="border border-violet-500/40 rounded p-3 col-span-2 bg-violet-500/5">
                <div className="font-semibold mb-2 flex items-center justify-between"><span>Tasks</span><span className="text-xs text-violet-300">{dailyLookData.tasks.filter(task => !taskIsCompleted(task)).length} open</span></div>
                {dailyLookData.tasks.length === 0 ? <div className="text-sm text-zinc-500">No tasks for this day.</div> : <div className="grid grid-cols-2 gap-2">{dailyLookData.tasks.map((task, index) => <label key={task.id || index} className="flex items-start gap-2 rounded border border-zinc-800 bg-zinc-900/60 p-2 text-sm"><input type="checkbox" className="mt-0.5 h-4 w-4 shrink-0 accent-violet-400" checked={taskIsCompleted(task)} onChange={event => { void setTaskCompleted(task, event.target.checked); }} /><span className={`min-w-0 ${taskIsCompleted(task) ? 'line-through text-zinc-500' : ''}`}><strong className="block break-words">{task.title || 'Task'}</strong><small className="text-zinc-400">{task.date < dailyLookData.ymd ? `Carried from ${task.date}` : taskAssignmentLabel(task.technician)}</small></span></label>)}</div>}
              </div>
              <div className="border border-zinc-800 rounded p-3">
                <div className="font-semibold mb-2">Schedules</div>
                {dailyLookData.schedules.length === 0 ? (
                  <div className="text-sm text-zinc-500">No schedules found{dailyLookData.assigned ? ` for ${dailyLookData.assigned}.` : '.'}</div>
                ) : (
                  <div className="space-y-1">
                    {dailyLookData.schedules.map(s => (
                      <div key={s.name} className="text-sm text-zinc-200 flex items-center justify-between gap-2">
                        <div className="truncate">{s.name}</div>
                        <div className="text-zinc-400 whitespace-nowrap">
                          {s.off ? 'Off' : `${formatTime12FromHHmm(s.start || '')} - ${formatTime12FromHHmm(s.end || '')}`}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="border border-zinc-800 rounded p-3">
                <div className="font-semibold mb-2">Parts expected (delivery)</div>
                {dailyLookData.partsDelivery.length === 0 ? (
                  <div className="text-sm text-zinc-500">No deliveries{dailyLookData.assigned ? ` for ${dailyLookData.assigned}.` : '.'}</div>
                ) : (
                  <div className="space-y-2">
                    {dailyLookData.partsDelivery.map((p, idx) => (
                      <div key={(p.id ?? idx) as any} className="text-sm">
                        <div className="flex items-center justify-between gap-2">
                          <div className="truncate">
                            <span className="text-zinc-400 mr-2">{formatTime12FromHHmm(p.time || '')}</span>
                            <span className="text-zinc-100">{p.partName || p.title || 'Part'}</span>
                          </div>
                          <div className="text-xs text-zinc-400 whitespace-nowrap">
                            {p.workOrderLabel || p.saleLabel || ''}
                          </div>
                        </div>
                        <div className="mt-1 flex gap-2">
                          {p.orderUrl ? (
                            <button className="text-xs px-2 py-1 bg-zinc-800 border border-zinc-700 rounded hover:bg-zinc-700" onClick={async () => {
                              try { await (window as any).api.openUrl(p.orderUrl); } catch {}
                            }}>Order link</button>
                          ) : null}
                          {(p as any).trackingUrl ? (
                            <button className="text-xs px-2 py-1 bg-zinc-800 border border-zinc-700 rounded hover:bg-zinc-700" onClick={async () => {
                              try { await (window as any).api.openUrl((p as any).trackingUrl); } catch {}
                            }}>Tracking</button>
                          ) : null}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="border border-zinc-800 rounded p-3">
                <div className="font-semibold mb-2">Consultations</div>
                {dailyLookData.consultations.length === 0 ? (
                  <div className="text-sm text-zinc-500">No consultations{dailyLookData.assigned ? ` for ${dailyLookData.assigned}.` : '.'}</div>
                ) : (
                  <div className="space-y-2">
                    {dailyLookData.consultations.map((c, idx) => (
                      <div key={(c.id ?? idx) as any} className="text-sm border border-zinc-800 rounded p-2 bg-zinc-900/50">
                        <div className="flex items-center justify-between gap-2">
                          <div className="truncate">
                            <span className="text-zinc-400 mr-2">{formatTime12FromHHmm(c.time || '')}</span>
                            <span className="text-zinc-100">{c.customerName || 'Customer'}</span>
                            {c.title ? <span className="text-zinc-300"> — {c.title}</span> : null}
                          </div>
                          {c.technician ? <div className="text-xs text-zinc-400 whitespace-nowrap">{c.technician}</div> : null}
                        </div>
                        {c.customerPhone ? <div className="text-xs text-zinc-500">{formatPhone(String(c.customerPhone || '')) || c.customerPhone}</div> : null}
                        <div className="mt-1 flex gap-2">
                          <button
                            className="text-xs px-2 py-1 bg-zinc-800 border border-zinc-700 rounded hover:bg-zinc-700"
                            onClick={() => { void openConsultationSale(c); }}
                            title="Open linked consultation sale"
                          >
                            View Consultation Sale
                          </button>
                          <button
                            className="text-xs px-2 py-1 bg-zinc-800 border border-zinc-700 rounded hover:bg-zinc-700"
                            onClick={() => { void openConsultationCustomer(c); }}
                            title="Open linked customer record"
                          >
                            View Client Info
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="border border-zinc-800 rounded p-3">
                <div className="font-semibold mb-2">Events</div>
                {dailyLookData.eventItems.length === 0 ? (
                  <div className="text-sm text-zinc-500">No events.</div>
                ) : (
                  <div className="space-y-2">
                    {dailyLookData.eventItems.map((e, idx) => (
                      <div key={(e.id ?? idx) as any} className="text-sm">
                        <div className="flex items-center justify-between gap-2">
                          <div className="truncate">
                            <span className="text-zinc-400 mr-2">{formatTime12FromHHmm(e.time || '')}</span>
                            <span className="text-zinc-100">{e.title || 'Event'}</span>
                          </div>
                          {e.location ? <div className="text-xs text-zinc-400 whitespace-nowrap">{e.location}</div> : null}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="border border-zinc-800 rounded p-3 col-span-2">
                <div className="font-semibold mb-2">Streaming/Content</div>
                {dailyLookData.contentItems.length === 0 ? (
                  <div className="text-sm text-zinc-500">No streaming or content sessions.</div>
                ) : (
                  <div className="grid grid-cols-2 gap-2">
                    {dailyLookData.contentItems.map((entry, idx) => {
                      const visual = calendarEventVisual(entry);
                      return (
                        <button key={(entry.id ?? idx) as any} type="button" className="text-left border border-zinc-800 rounded p-2 bg-zinc-900/50" onClick={() => setViewing(entry)}>
                          <div className="flex items-center gap-2">
                            <span className={`gb-calendar-event-icon ${visual.color}`}>{visual.short}</span>
                            <span className="min-w-0">
                              <strong className="block text-sm truncate">{entry.title || visual.label}</strong>
                              <small className="block text-zinc-400">{eventSummary(entry)}</small>
                            </span>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>

              <div className="border border-zinc-800 rounded p-3 col-span-2">
                <div className="font-semibold mb-2">Parts ordered</div>
                {dailyLookData.partsOrdered.length === 0 ? (
                  <div className="text-sm text-zinc-500">No orders{dailyLookData.assigned ? ` for ${dailyLookData.assigned}.` : '.'}</div>
                ) : (
                  <div className="grid grid-cols-2 gap-2">
                    {dailyLookData.partsOrdered.map((p, idx) => (
                      <div key={(p.id ?? idx) as any} className="text-sm border border-zinc-800 rounded p-2 bg-zinc-900/50">
                        <div className="truncate">
                          <span className="text-zinc-400 mr-2">{formatTime12FromHHmm(p.time || '')}</span>
                          <span className="text-zinc-100">{p.partName || p.title || 'Part'}</span>
                        </div>
                        <div className="text-xs text-zinc-400 mt-0.5">
                          {p.workOrderLabel || p.saleLabel || ''}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {budgetDate && createPortal((
        <div className="fixed inset-0 z-[100550] flex items-center justify-center bg-black/80 p-3" onClick={() => setBudgetDate(null)} data-modal-shell="1">
          <section className="w-full max-w-md rounded-lg border border-violet-500/60 bg-zinc-950 p-4 shadow-[0_24px_90px_rgba(0,0,0,0.85)]" onClick={(event) => event.stopPropagation()} role="dialog" aria-modal="true" aria-label="Daily purchasing budget">
            <header><h3 className="text-xl font-semibold text-violet-300">Daily Purchasing Budget</h3><p className="mt-1 text-sm text-zinc-400">Set the Cart spending limit for {new Date(`${budgetDate}T12:00:00`).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}. It does not change reporting.</p></header>
            <label className="mt-4 block text-sm text-zinc-300">Budget
              <div className="mt-1 flex items-center rounded border border-zinc-700 bg-zinc-900 px-3"><span className="text-zinc-500">$</span><input type="number" min="0" step="0.01" inputMode="decimal" className="min-w-0 flex-1 bg-transparent px-2 py-3 text-lg outline-none" value={budgetDraft} onChange={(event) => setBudgetDraft(event.target.value)} placeholder="0.00" autoFocus /></div>
            </label>
            {budgetMessage ? <p className="mt-3 text-sm text-violet-200">{budgetMessage}</p> : null}
            <footer className="mt-4 flex flex-wrap justify-end gap-2"><button type="button" className="rounded border border-zinc-700 px-4 py-2 text-sm" onClick={() => setBudgetDate(null)}>Cancel</button><button type="button" disabled={budgetSaving || !budgetDraft.trim()} className="rounded border border-red-500/60 px-4 py-2 text-sm text-red-200 disabled:opacity-40" onClick={() => { setBudgetDraft(''); void saveDailyBudget(''); }}>Clear</button><button type="button" disabled={budgetSaving} className="rounded bg-violet-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-40" onClick={() => { void saveDailyBudget(); }}>{budgetSaving ? 'Saving...' : 'Save Budget'}</button></footer>
          </section>
        </div>
      ), document.body)}
      <ContextMenu
        id="calendar-entry-context-menu"
        open={calendarContext.state.open}
        x={calendarContext.state.x}
        y={calendarContext.state.y}
        items={calendarContextItems}
        onClose={calendarContext.close}
      />
    </div>
  );
};

export default CalendarWindow;

// Autosave editing modal content after 2s of inactivity (min fields required)
// Placed after default export to avoid rerender churn; hook call occurs conditionally via component scope
(function attachAutosave() {
  // We cannot call hooks outside components; this is a no-op placeholder to document autosave inclusion above.
})();

// --- Helpers and small components ---
function toMinutes(t?: string) { if (!t) return 0; const [h,m] = t.split(':').map(Number); return (h||0)*60 + (m||0); }
function diffMinutes(start?: string, end?: string) { const s = toMinutes(start), e = toMinutes(end); return Math.max(0, e - s); }
function formatScheduleTotal(schedule: CalendarEvent['schedule']) {
  const days: (keyof NonNullable<CalendarEvent['schedule']>)[] = ['mon','tue','wed','thu','fri','sat','sun'];
  const totalMin = days.reduce((sum, d) => sum + diffMinutes(schedule?.[d]?.start, schedule?.[d]?.end), 0);
  const hours = (totalMin / 60).toFixed(2);
  return `${hours} hrs`;
}

const TechnicianSelect: React.FC<{ value: string; onChange: (v: string) => void }> = ({ value, onChange }) => {
  const [techs, setTechs] = useState<{ id: string; firstName?: string; lastName?: string; nickname?: string }[]>([]);
  async function refresh() { try { const l = await listTechnicians(); setTechs(l as any); } catch (e) { console.error('load techs failed', e); } }
  useEffect(() => { refresh(); }, []);
  useEffect(() => {
    const api: any = (window as any).api;
    if (!api?.onTechniciansChanged) return;
    const unsub = api.onTechniciansChanged(() => { refresh(); });
    return unsub;
  }, []);
  return (
    <select className="w-full mt-1 bg-zinc-800 border border-zinc-700 rounded px-2 py-1" value={value} onChange={e => onChange(e.target.value)}>
      <option value="">Select technician</option>
      {techs.map(t => (
        <option key={t.id} value={technicianDisplayName(t)}>
          {technicianDisplayName(t)}
        </option>
      ))}
    </select>
  );
};
