# Habitica Google Calendar Sync

Turn today's and tomorrow's Google Calendar events into Habitica To-Dos, with meeting details and automatic completion after events end.

Runs every 30 minutes in Google Apps Script. No separate server, Android background service, or local installation is needed.

**Automatic completion means the scheduled end time has passed. It does not verify attendance or whether you completed the activity.**

## Contents

- [Quick start](#quick-start)
- [Features and behaviour](#features-and-behaviour)
- [Configuration](#configuration)
- [Troubleshooting](#troubleshooting)
- [FAQ](#faq)
- [Verification and credits](#verification-and-credits)

## Quick start

Allow about 5–10 minutes for setup. You need a Google account with access to the calendar and a Habitica account.

### 1. Copy the script

Open [Google Apps Script](https://script.google.com/) and create a project, or use your existing sync project.

Copy the complete contents of [script.gs](script.gs) into the editor, replacing the old code. The editor's file can remain named `Code.gs`.

### 2. Enable the Calendar service

In the left sidebar, select **Services → + → Google Calendar API → Add**. Keep its identifier as `Calendar`.

If the Apps Script project uses a manually linked, standard Google Cloud project, also enable the Google Calendar API in that Cloud project. With Apps Script's default Cloud project, adding the service enables the API automatically. See [Google's advanced services instructions](https://developers.google.com/apps-script/guides/services/advanced).

### 3. Configure the calendar and credentials

Open **Project Settings → Script Properties** and add:

| Property | Value |
| --- | --- |
| `CALENDAR_NAME` | The exact calendar name, such as `Personal` or `Work` |
| `HABITICA_ID` | Your Habitica User ID |
| `HABITICA_TOKEN` | Your Habitica API token |

Find your Habitica credentials under [Settings → API](https://habitica.com/user/settings/api).

Alternatively, set `CALENDAR_ID` instead of `CALENDAR_NAME`. Find it in Google Calendar under **Settings → your calendar → Integrate calendar → Calendar ID**. If both properties are present, the ID takes precedence. An ID is useful when multiple calendars share a name.

Store credentials in Script Properties, not in the source file or GitHub repository. Anyone with editor access to the Apps Script project can access those properties, so keep the project private.

### 4. Run once

Save the project. Select **`syncToHabitica`** from the function dropdown and click **Run**. Authorise access when prompted.

Check Habitica's To-Dos and the Apps Script execution log. A successful run reports:

```text
Sync finished: created=2, updated=0, completed=0.
```

The numbers depend on your calendar. Review the imported due dates and notes before enabling automatic runs.

### 5. Schedule runs every 30 minutes

If you used an older version, first remove its sync triggers under **Triggers**. Replace or disable old sync code in other Apps Script projects too; this script cannot stop those projects from changing tasks.

Select **`installThirtyMinuteTrigger`** and run it once. It creates a time-driven trigger for `syncToHabitica` every 30 minutes. If a trigger for either `syncToHabitica` or the legacy `syncToHabbitica` already exists in this project, the installer stops instead of adding another.

You can also configure it manually: **Triggers → Add Trigger → `syncToHabitica` → Time-driven → Minutes timer → Every 30 minutes**. Use either method, not both.

## Features and behaviour

### Import

- Reads events overlapping today or tomorrow in the **selected calendar's time zone**.
- Creates **To-Dos**, with difficulty **Easy** (`priority: 1`).
- Sets the due date to the event's local start date. An event continuing into today from an earlier day is initially due today.
- Handles individual occurrences of recurring meetings separately, including meetings with identical titles.
- Excludes titles containing configured words, such as `lunch`, `sleep`, or `commute`.

### Update and complete

- Uses the calendar ID and Google's event ID to recognise imports across runs.
- Updates the title, due date, notes, and difficulty of an unfinished imported To-Do when the event changes.
- Completes an existing imported To-Do when the event's scheduled end time has passed, using Habitica's normal completion action and rewards.
- Rechecks earlier pending imports, so completion can still happen after midnight or after a missed run.
- Leaves manually completed tasks completed, even if their events are later rescheduled.

An event first imported **after** its end time is created unfinished, then completed on the next successful run.

### What remains unchanged

The script does not modify Google Calendar, read or modify Dailies, delete Habitica tasks, or manage unrelated manually created tasks.

If an event is cancelled, deleted, becomes excluded, or cannot be retrieved, its existing To-Do remains unchanged. Review those tasks manually. Changing the exclusion list does not remove earlier imports.

## Configuration

### Script Properties

| Property | Required | Purpose |
| --- | --- | --- |
| `CALENDAR_NAME` | Unless an ID is provided | Select one calendar by its exact name; duplicate names are rejected |
| `CALENDAR_ID` | Optional | Select one calendar by ID; overrides the name |
| `HABITICA_ID` | Yes | Authenticate with Habitica |
| `HABITICA_TOKEN` | Yes | Authenticate with Habitica; keep private |

### Exclude events by title

Edit this array near the top of the script:

```javascript
const EXCLUDED_EVENT_TITLE_MATCHES = [
  'lunch',
  'sleep',
  'commute'
];
```

Matching is case-insensitive and uses substrings. For example, `lunch` matches `Lunch with team` and `Working lunch`. Blank entries are ignored. Set the array to `[]` to disable title exclusions.

### Meeting notes

A typical To-Do looks like this:

**Title:** `📅 Backend interview`

```markdown
**Start:** 2026-10-03 14:00
**End:** 2026-10-03 15:30
**Duration:** 1h 30m
**Time zone:** Asia/Kolkata
**Location:** Video call

---

Discuss **Go**, system design, and previous projects.
```

The description is appended after the meeting details. Existing Markdown is preserved; common rich-text HTML, including links, bold, italic, paragraphs, and lists, is converted to Markdown. This is a basic converter, not a complete HTML renderer.

The stored notes also contain a `habitica-gcal` metadata comment. Keep it intact: it helps the script locate earlier imports for completion. Keep the task's generated alias intact too. Calendar synchronisation can overwrite manual edits to the imported title, notes, due date, or difficulty; use the event description for notes you want retained.

### Timing and limits

The script requests a run every 30 minutes; Google controls the actual trigger timing. Completion happens on the next successful run after the event ends.

Requests to Habitica are spaced 2.1 seconds apart. A script lock prevents simultaneous runs in the same project. If a run approaches 4.5 minutes, it stops with an error so a later run can reconcile existing tasks and continue. Large calendars and Google/Habitica service quotas can still limit a run.

## Troubleshooting

| Problem | What to check |
| --- | --- |
| `Enable Google Calendar API...` or `Calendar is not defined` | Add the Calendar service and keep the identifier `Calendar` |
| Calendar name missing or ambiguous | Check the exact name and access permissions, or use `CALENDAR_ID` |
| Calendar ID not found or inaccessible | Check the ID and whether the Google account running the script can read it |
| Habitica HTTP `401` | Check `HABITICA_ID` and `HABITICA_TOKEN` in Script Properties |
| Habitica HTTP `429` | Allow the rate limit to reset; check for other scripts making requests to Habitica |
| No imported tasks | Check the selected calendar, local today/tomorrow window, title exclusions, and execution errors |
| A sync trigger already exists | Remove old sync triggers before running the installer; do not repeatedly install triggers |
| Old Dailies remain | Expected: this version intentionally leaves all Dailies alone |
| A cancelled event's To-Do remains | Expected: there are no task deletions or cancellation-based completions |
| To-Do has not completed | Check the event end time, trigger status, and metadata; newly imported past events complete on the next run |
| Run stopped near the time limit | Check the next execution; existing imports should be reconciled rather than recreated |

Use **Executions** in Apps Script to inspect failures. Mutating requests are not blindly retried: a timeout may occur after Habitica has already applied a change. The next run looks for the existing task before creating another.

## FAQ

### Does this synchronise in both directions?

No. Google Calendar is the source. Editing a Habitica task does not update Google Calendar.

### Does it confirm that I attended a meeting?

No. It marks a To-Do complete based only on the scheduled end time. This includes missed meetings or declined invitations that remain on the calendar. Use automatic completion only if that behaviour fits your tracking system.

### Does it import my entire calendar history?

No. New imports are limited to events overlapping today and tomorrow. Older tasks already imported by this version may be checked for updates and completion.

### Does it support all-day events?

Yes. Their start and end dates are interpreted as midnight in the selected calendar's time zone. Google Calendar's all-day end date is exclusive: a one-day event ends at midnight at the beginning of the following day. The notes label this explicitly. Duration is elapsed time, which can differ from 24 hours per day around daylight-saving changes.

### Does it support multiple calendars?

This version selects one calendar per Apps Script project. The generated task identity includes the calendar ID, so separate calendars do not share an identity just because event titles match. Multiple projects still share your Habitica account's request limits.

### What happens if I delete an imported To-Do myself?

If the event is still eligible and within the import window, a subsequent run may recreate the To-Do. To prevent a new import, add a matching title exclusion or remove the event from the source calendar.

### How do I stop automatic runs?

Open **Triggers** and remove the sync trigger. Imported tasks remain in Habitica.

## Verification and credits

JavaScript syntax validation and 10 simulated checks passed during development. Checks covered due dates, exclusions, duplicate prevention, rescheduling, midnight completion, calendar time zones, all-day events, basic HTML conversion, trigger interval, and recovery after an interrupted creation. These checks did not connect to live Google Calendar or Habitica accounts; live execution remains unverified.

The script is adapted from [Davi Cedraz's Habitica Google Calendar project](https://github.com/davicedraz/habitica-google-calendar). This version creates To-Dos for today and tomorrow, includes meeting details and exclusions, and completes imported tasks after their events end without deleting tasks or modifying Dailies.

Useful references:

- [Habitica API documentation](https://apidoc.habitica.com/)
- [Google Apps Script Calendar service](https://developers.google.com/apps-script/advanced/calendar)
- [Google Calendar event queries](https://developers.google.com/calendar/api/v3/reference/events/list)
- [Time-driven trigger intervals](https://developers.google.com/apps-script/reference/script/clock-trigger-builder#everyMinutes(Integer))
