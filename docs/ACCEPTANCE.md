# Acceptance

Vireo's milestones are done when every acceptance criterion holds in real use, not only in tests. Acceptance therefore has two parts:

1. **Automated:** `npm run acceptance`. It builds Vireo, runs the unit and end-to-end suites, and writes `acceptance-report.md` with one row per criterion. The suite uses a scripted model and local fixtures, so it is deterministic and needs no credentials. It proves the product behaves as specified when the model makes the expected calls.
2. **Manual, with your real model:** the checklist below. It proves the real model actually makes those calls, and that the integrations work against real services. Run it after changing prompts, agents, tools or models.

## Before you start

- Run `npm run build && npm start`, or use `docker compose up -d`.
- In **Settings → Model**, check that a real model is shown, either pi's default or one you picked.
- For Milestone 3, connect Google in **Settings → Google Calendar & Gmail**. The local calendar is enough for the calendar parts.
- For notifications, open Vireo over HTTPS on your phone, install it to the home screen, and enable **Settings → Notifications**.

## Milestone 1 — Threads that think

- [ ] **M1.1** Install the PWA on iPhone (Safari → Share → Add to Home Screen) and on a Mac. Sign in on both.
- [ ] **M1.2** Tap **New thread** and ask "How do vireos build their nests?". The answer streams in, and the thread gets a short name.
- [ ] **M1.3** Start two threads at once: "My code word is ALPHA, remember it for this thread" and "My code word is BRAVO …". Ask each one "What is my code word?". Each answers with only its own word.
- [ ] **M1.4** Ask "Research the history of the name 'vireo' and cite sources". You get a summary with source links, and the pages appear under **Related** in the side panel.
- [ ] **M1.5** In Settings, switch the main model. The next reply uses it, as shown in **Usage** and in the thread's **Activity**.

## Milestone 2 — Vireo remembers

- [ ] **M2.1** In one thread, say "I prefer aisle seats". The next day, in a new thread, ask Vireo to plan a flight. It mentions the aisle seat without being asked.
- [ ] **M2.2** Say "I live at …", then later "I moved to …". Ask "Where do I live?" in a new thread. Vireo gives only the new address. Under **Memory → Show replaced and expired**, the old one is marked replaced.
- [ ] **M2.3** Ask "What do you remember about <someone>?". You get facts with the thread each one came from. In **Memory**, edit one fact and delete another, then ask again.
- [ ] **M2.4** Start a **temporary** thread and state a preference. Nothing new appears in **Memory**.

## Milestone 3 — Calendar and email

- [ ] **M3.1** Ask "Schedule 30 minutes with <a friend's email> tomorrow afternoon". A card proposes a free slot. Nothing appears in the calendar until you tap **Confirm**, and then the event and invitation exist.
- [ ] **M3.2** Have someone email you a question. Within the inbox check interval (about five minutes), a thread opens with a summary and a draft. Reply "send it". A card appears, and the email is sent only after you confirm. Try **Edit** before confirming.
- [ ] **M3.3** Leave a confirmation pending, lock your laptop, and confirm from the push notification on your phone. Back on the laptop, the thread has continued.
- [ ] **M3.4** In any thread's **Activity**, every send, invite and delete shows "awaiting confirmation" followed by a run by **owner**. Nothing outward-facing ran without one.

## Milestone 4 — Proactive and hands-on

- [ ] **M4.1** The next morning, at the brief time set in Settings, Overview has a brief with today's schedule, emails awaiting a reply, and open threads, and you get a notification. **Brief me** in Overview triggers one on demand.
- [ ] **M4.2** Save a site sign-in under **Settings → Sign-ins for websites**, then ask Vireo to do something on that site that ends in a submit (for example a booking or a form). It signs in, fills the form, and stops at a card before submitting.
- [ ] **M4.3** Search for the saved password in `data/vireo.db`, the server log and the thread's **Activity**, for example with `grep -a`. It appears nowhere. Vireo's own tests also check every prompt sent to the model.
- [ ] **M4.4** Open **Activity** for the M4.2 thread. Every page opened, field typed (shown as `{{password}}`), click, confirmation and model call is listed with its arguments.

## Capabilities spot checks

- [ ] **C1** In Overview, ask "Help me plan a trip to Kyoto". Vireo opens a dedicated thread and links to it.
- [ ] **C7** Create two overlapping events. A thread opens about the conflict, with options.
- [ ] **C8** Say "Remind me to call mom in 2 minutes". The reminder lands in the same thread and you get a notification.
- [ ] **C9** Attach a file to a thread. It appears in the side panel and can be downloaded.
- [ ] **C10** After completing a booking with Vireo, it offers to save the steps as a procedure you can approve.
