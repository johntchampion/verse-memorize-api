import 'dotenv/config'
import { createApp } from './app'
import { migrate } from './db/client'
import { jwtSecret } from './middleware/auth'
import { vapidConfigured, vapidSubject } from './services/pushSender'
import { startReminderScheduler } from './services/reminderScheduler'

const PORT = Number(process.env.PORT ?? 3000)

// Fail at boot rather than on the first signup.
jwtSecret()
migrate()

// Started here and not in createApp(): the app is constructed once per test
// file and again by supertest, and none of those should start a timer.
//
// Unlike JWT_SECRET this is not fatal to miss. Auth is load-bearing; reminders
// are not, so a deployment without VAPID keys boots and simply doesn't remind
// anyone. Note also that the scheduler assumes a single process — two replicas
// over one SQLite file would each claim correctly but write for no benefit.
if (vapidConfigured()) {
  // Checked here rather than on the first send: a bad subject is rejected by
  // Apple alone, so left to surface at runtime it looks like "Safari is
  // broken" rather than "this server is misconfigured".
  vapidSubject()
  startReminderScheduler()
  console.log('daily reminders enabled')
} else {
  console.warn(
    'VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT not all set — daily reminders are off',
  )
}

createApp().listen(PORT, () => {
  console.log(`verse-memorize-api listening on :${PORT}`)
})
