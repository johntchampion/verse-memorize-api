/** Every request body shape, so routes validate and controllers type-check against one definition. */
import { z } from 'zod'
import { EXERCISE_TYPES } from './db/rows'

export const credentials = z.object({
  email: z.email(),
  password: z.string().min(8),
  timezone: z.string().min(1).optional(),
  translation: z.string().min(1).optional(),
})

export const attemptBody = z.object({
  userVerseId: z.uuid(),
  exerciseType: z.enum(EXERCISE_TYPES),
  correct: z.boolean(),
})

// Every field optional so a client can change one without restating the
// others, but an empty body is a mistake rather than a no-op update.
export const profilePatch = z
  .object({
    timezone: z.string().min(1).optional(),
    translation: z.string().min(1).optional(),
    remindersEnabled: z.boolean().optional(),
  })
  .refine(
    (body) =>
      body.timezone !== undefined ||
      body.translation !== undefined ||
      body.remindersEnabled !== undefined,
    {
      message:
        'expected timezone, translation, remindersEnabled, or a combination',
    },
  )

export const deleteAccountBody = z.object({ password: z.string().min(1) })

export const queueOrderBody = z.object({
  verseIds: z.array(z.string().min(1)).min(1),
})
export const themeBody = z.object({ themeId: z.string().min(1) })
export const nextVerseBody = z.object({ verseId: z.string().min(1) })
export const slotReplaceBody = z.object({
  verseId: z.string().min(1),
  slot: z.number().int().min(1),
})

// The shape of PushSubscription.toJSON(). Its expirationTime is stripped by
// zod, which is right — nothing here reads it.
export const subscribeBody = z.object({
  // Push endpoints run long: FCM's are around 200 characters and other services
  // go further. This bound is a sanity check, not a fit.
  endpoint: z.url().max(2048),
  keys: z.object({
    p256dh: z.string().min(1).max(255),
    auth: z.string().min(1).max(255),
  }),
})
export const unsubscribeBody = z.object({ endpoint: z.url().max(2048) })

export type Credentials = z.infer<typeof credentials>
export type AttemptInput = z.infer<typeof attemptBody>
export type ProfilePatch = z.infer<typeof profilePatch>
export type DeleteAccountInput = z.infer<typeof deleteAccountBody>
export type QueueOrderInput = z.infer<typeof queueOrderBody>
export type ThemeInput = z.infer<typeof themeBody>
export type NextVerseInput = z.infer<typeof nextVerseBody>
export type SlotReplaceInput = z.infer<typeof slotReplaceBody>
export type SubscribeInput = z.infer<typeof subscribeBody>
export type UnsubscribeInput = z.infer<typeof unsubscribeBody>
