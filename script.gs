/**
 * Google Calendar -> Habitica To-Dos (today and tomorrow).
 * Based on davicedraz/habitica-google-calendar (MIT).
 *
 * SETUP:
 * 1. Add the Google Calendar API under Apps Script > Services (+).
 * 2. Set Script Properties: CALENDAR_NAME, HABITICA_ID, HABITICA_TOKEN.
 *    Optionally set CALENDAR_ID instead of CALENDAR_NAME.
 * 3. Run syncToHabitica once and authorize it.
 * 4. Remove previous sync triggers, then run installThirtyMinuteTrigger once.
 *
 * No Calendar writes, no task deletions, and no Daily reads or writes.
 * Completion means the scheduled end time has passed, not confirmed attendance.
 * Manually completed tasks stay completed, including after rescheduling.
 * Cancelled/deleted/excluded events leave existing To-Dos unchanged.
 */

const HABITICA_API_BASE = 'https://habitica.com/api/v3/tasks/';
const CALENDAR_TASK_PREFIX = ':calendar: ';
const TASK_PRIORITY = 1; // Easy.

// Case-insensitive substring matches against the event title.
const EXCLUDED_EVENT_TITLE_MATCHES = ['lunch', 'sleep', 'commute'];

// Pace requests below Habitica's usual 30 requests/minute limit.
const API_REQUEST_SPACING_MS = 2100;
let syncDeadline_ = 0;

function syncToHabitica() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) {
    Logger.log('Another sync is running; skipping this run.');
    return;
  }
  try {
    syncDeadline_ = Date.now() + 270000;
    const config = getConfig_();
    const calendar = getCalendar_(config);
    const calendarId = calendar.getId();
    const timezone = calendar.getTimeZone();
    const now = new Date();
    const today = Utilities.formatDate(now, timezone, 'yyyy-MM-dd');
    const tomorrow = addDays_(today, 1);
    const start = Utilities.parseDate(today, timezone, 'yyyy-MM-dd');
    const end = Utilities.parseDate(addDays_(today, 2), timezone, 'yyyy-MM-dd');
    const headers = buildHabiticaHeaders_(config);
    const events = listEvents_(calendarId, start, end, timezone);
    const pending = habiticaRequest_('user?type=todos', 'get', headers);
    if (!Array.isArray(pending)) throw new Error('Unexpected Habitica task list.');

    const byAlias = new Map();
    pending.forEach(task => {
      if (task.type === 'todo' && task.alias) byAlias.set(task.alias, task);
    });
    const processed = new Set();
    let created = 0, updated = 0, completed = 0;

    for (const event of events) {
      checkDeadline_();
      if (!eligibleEvent_(event)) continue;
      processed.add(event.id);
      const alias = eventAlias_(calendarId, event.id);
      // Fetch by alias too: completed To-Dos are absent from the pending list.
      let task = byAlias.get(alias) ||
        habiticaRequest_(encodeURIComponent(alias), 'get', headers, undefined, true);
      const payload = buildTaskPayload_(event, calendarId, timezone, today, tomorrow);
      if (!task) {
        task = habiticaRequest_('user', 'post', headers, payload);
        assertOwnedTodo_(task, alias);
        byAlias.set(alias, task);
        created++;
        // Newly imported past events are completed on the NEXT run.
        continue;
      }
      assertOwnedTodo_(task, alias);
      if (task.completed) continue;
      if (updateTodo_(task, payload, headers)) updated++;
      if (eventEnd_(event, timezone).getTime() <= now.getTime()) {
        completeTodo_(task, headers);
        completed++;
      }
    }

    // Catch imports from earlier days, including events ending near midnight.
    // Re-read the event before scoring: it may have moved or been cancelled.
    for (const task of pending) {
      if (task.type !== 'todo' || task.completed) continue;
      const meta = readMetadata_(task.notes);
      if (!meta || meta.calendarId !== calendarId || processed.has(meta.eventId)) continue;
      if (task.alias !== eventAlias_(calendarId, meta.eventId)) continue;
      checkDeadline_();
      let event;
      try {
        event = Calendar.Events.get(calendarId, meta.eventId);
      } catch (error) {
        // Do not assume an inaccessible or missing event was attended.
        Logger.log('Could not read an earlier imported event; leaving its To-Do unchanged.');
        continue;
      }
      if (!eligibleEvent_(event)) continue;
      const payload = buildTaskPayload_(event, calendarId, timezone);
      if (updateTodo_(task, payload, headers)) updated++;
      if (eventEnd_(event, timezone).getTime() <= now.getTime()) {
        completeTodo_(task, headers);
        completed++;
      }
    }
    Logger.log('Sync finished: created=%s, updated=%s, completed=%s.', created, updated, completed);
  } finally {
    lock.releaseLock();
  }
}

// Retain compatibility with the old misspelled trigger function.
function syncToHabbitica() {
  syncToHabitica();
}

function listEvents_(calendarId, start, end, timezone) {
  const options = {
    timeMin: start.toISOString(), timeMax: end.toISOString(),
    singleEvents: true, showDeleted: false, orderBy: 'startTime',
    timeZone: timezone, maxResults: 250
  };
  let events = [], page;
  do {
    checkDeadline_();
    page = Calendar.Events.list(calendarId, options);
    events = events.concat(page.items || []);
    options.pageToken = page.nextPageToken;
  } while (page.nextPageToken);
  return events;
}

function eligibleEvent_(event) {
  if (!event || !event.id || event.status === 'cancelled' || !event.start || !event.end) return false;
  const title = String(event.summary || '').toLowerCase();
  return !EXCLUDED_EVENT_TITLE_MATCHES.some(value => {
    const needle = String(value).trim().toLowerCase();
    return needle !== '' && title.includes(needle);
  });
}

function eventAlias_(calendarId, eventId) {
  const digest = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256, JSON.stringify([calendarId, eventId])
  );
  return 'gcal_' + digest.map(value => ('0' + ((value + 256) % 256).toString(16)).slice(-2)).join('');
}

function buildTaskPayload_(event, calendarId, timezone, today, tomorrow) {
  const start = eventStart_(event, timezone);
  const end = eventEnd_(event, timezone);
  let due = Utilities.formatDate(start, timezone, 'yyyy-MM-dd');
  // An event overlapping today from yesterday is imported as due today.
  if (today && due < today) due = today;
  if (tomorrow && due > tomorrow) due = tomorrow;
  const minutes = Math.max(0, Math.round((end.getTime() - start.getTime()) / 60000));
  const hours = Math.floor(minutes / 60);
  const duration = hours ? hours + 'h' + (minutes % 60 ? ' ' + minutes % 60 + 'm' : '') : minutes + 'm';
  const notes = [
    '**Start:** ' + Utilities.formatDate(start, timezone, 'yyyy-MM-dd HH:mm'),
    '**End:** ' + Utilities.formatDate(end, timezone, 'yyyy-MM-dd HH:mm') +
      (event.end.date ? ' (exclusive; all-day event)' : ''),
    '**Duration:** ' + duration,
    '**Time zone:** ' + timezone
  ];
  if (event.location) notes.push('**Location:** ' + event.location);
  const description = toMarkdown_(event.description || '');
  if (description) notes.push('', '---', '', description);
  // Keep this marker: it links this To-Do to its Calendar event across runs.
  notes.push('', '<!-- habitica-gcal:' + encodeURIComponent(JSON.stringify({calendarId, eventId:event.id})) + ' -->');
  return {
    text: CALENDAR_TASK_PREFIX + (event.summary || '(Untitled event)'),
    type: 'todo', priority: TASK_PRIORITY, date: due,
    alias: eventAlias_(calendarId, event.id), notes: notes.join('\n')
  };
}

function eventStart_(event, timezone) {
  return event.start.dateTime ? new Date(event.start.dateTime) :
    Utilities.parseDate(event.start.date, timezone, 'yyyy-MM-dd');
}

function eventEnd_(event, timezone) {
  return event.end.dateTime ? new Date(event.end.dateTime) :
    Utilities.parseDate(event.end.date, timezone, 'yyyy-MM-dd');
}

function addDays_(dateString, days) {
  const date = new Date(dateString + 'T12:00:00Z');
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function readMetadata_(notes) {
  const match = String(notes || '').match(/<!-- habitica-gcal:([^\s]+) -->/);
  if (!match) return null;
  try {
    const meta = JSON.parse(decodeURIComponent(match[1]));
    return typeof meta.calendarId === 'string' && typeof meta.eventId === 'string' ? meta : null;
  } catch (error) { return null; }
}

function toMarkdown_(description) {
  // Keep existing Markdown. Convert common Google Calendar rich-text HTML.
  return String(description)
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, url, label) => '[' + label.replace(/<[^>]+>/g, '') + '](' + url + ')')
    .replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, '**$2**')
    .replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, '*$2*')
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ').replace(/<\/li>/gi, '\n')
    .replace(/<\/(p|div|ul|ol|h[1-6])>/gi, '\n\n')
    .replace(/<\/?(?:p|div|span|ul|ol|h[1-6]|font|code|pre|blockquote)\b[^>]*>/gi, '')
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (_, code) => {
      const n = /^x/i.test(code) ? parseInt(code.slice(1), 16) : Number(code);
      return n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
    })
    .replace(/&nbsp;/gi, ' ').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/&amp;/gi, '&')
    .replace(/\n{3,}/g, '\n\n').trim();
}

function assertOwnedTodo_(task, alias) {
  if (!task || task.type !== 'todo' || task.alias !== alias || !(task.id || task._id)) {
    throw new Error('Unexpected task at calendar alias; refusing to modify it.');
  }
}

function updateTodo_(task, payload, headers) {
  if (task.text === payload.text && task.notes === payload.notes &&
      String(task.date || '').slice(0, 10) === payload.date && task.priority === payload.priority) return false;
  habiticaRequest_(encodeURIComponent(task.id || task._id), 'put', headers, {
    text: payload.text, notes: payload.notes, date: payload.date, priority: payload.priority
  });
  Object.assign(task, {text:payload.text, notes:payload.notes, date:payload.date, priority:payload.priority});
  return true;
}

function completeTodo_(task, headers) {
  if (task.type !== 'todo' || task.completed) return;
  habiticaRequest_(encodeURIComponent(task.id || task._id) + '/score/up', 'post', headers);
  task.completed = true;
}

function habiticaRequest_(path, method, headers, payload, allowNotFound) {
  if (!['get', 'post', 'put'].includes(method)) throw new Error('Unsupported request method.');
  checkDeadline_();
  Utilities.sleep(API_REQUEST_SPACING_MS);
  const options = {method, headers, muteHttpExceptions:true};
  if (payload !== undefined) {
    options.contentType = 'application/json';
    options.payload = JSON.stringify(payload);
  }
  // Do not blindly retry mutations: the server may already have applied them.
  const response = UrlFetchApp.fetch(HABITICA_API_BASE + path, options);
  const status = response.getResponseCode();
  if (allowNotFound && status === 404) return null;
  if (status < 200 || status >= 300) throw new Error('Habitica request failed: HTTP ' + status + '. Run again after resolving access/rate-limit errors.');
  const result = JSON.parse(response.getContentText());
  if (result.success === false) throw new Error('Habitica rejected the request.');
  return result.data;
}

function checkDeadline_() {
  if (syncDeadline_ && Date.now() >= syncDeadline_) {
    throw new Error('Sync paused near the execution time limit. The next run will reconcile existing To-Dos and continue.');
  }
}

function buildHabiticaHeaders_(config) {
  return {'x-api-user':config.habiticaId, 'x-api-key':config.habiticaToken,
    'x-client':config.habiticaId + '-GoogleCalendarTodoSync'};
}

function getConfig_() {
  const props = PropertiesService.getScriptProperties();
  const config = {calendarName:props.getProperty('CALENDAR_NAME'), calendarId:props.getProperty('CALENDAR_ID'),
    habiticaId:props.getProperty('HABITICA_ID'), habiticaToken:props.getProperty('HABITICA_TOKEN')};
  if (!(config.calendarId || config.calendarName) || !config.habiticaId || !config.habiticaToken) {
    throw new Error('Set CALENDAR_NAME (or CALENDAR_ID), HABITICA_ID and HABITICA_TOKEN in Script Properties.');
  }
  if (typeof Calendar === 'undefined') throw new Error('Enable Google Calendar API under Apps Script > Services (+).');
  return config;
}

function getCalendar_(config) {
  if (config.calendarId) {
    const calendar = CalendarApp.getCalendarById(config.calendarId);
    if (!calendar) throw new Error('Calendar ID not found or inaccessible.');
    return calendar;
  }
  const calendars = CalendarApp.getCalendarsByName(config.calendarName);
  if (calendars.length !== 1) throw new Error('Calendar name missing or ambiguous; set CALENDAR_ID instead.');
  return calendars[0];
}

function installThirtyMinuteTrigger() {
  const handlers = ['syncToHabitica', 'syncToHabbitica'];
  if (ScriptApp.getProjectTriggers().some(trigger => handlers.includes(trigger.getHandlerFunction()))) {
    throw new Error('A sync trigger already exists. Remove old sync triggers manually under Triggers, then run this installer once.');
  }
  ScriptApp.newTrigger('syncToHabitica').timeBased().everyMinutes(30).create();
  Logger.log('Installed one trigger: syncToHabitica every 30 minutes.');
}
