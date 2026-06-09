# Firebase Studio

This is a NextJS starter in Firebase Studio.

## Booking frontend

The customer booking landing page is at `/` and submits to `/api/bookings`.

### Environment

1. Copy `.env.example` to `.env.local`.
2. Fill in the remaining Firebase web app values from the `mawio-67c3b` Firebase project settings.
3. Deploy `database.rules.json` to Realtime Database so the app can read/write `mawio/standard` and `mawio/platinum`.
4. Enable Firebase Authentication anonymous sign-in, or keep the Realtime Database rules open for the app storage paths.
5. Set `BOOKING_BACKEND_URL` only if bookings should also be forwarded to an external backend.
6. Set `NGENIUS_PAYMENT_ENABLED=true` plus the N-Genius variables only when live payment checkout is ready.

The API route validates input, enforces basic anti-abuse checks, computes totals server-side, and forwards clean payloads to your backend.
