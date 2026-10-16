# Jet lag

A small offline web app that shifts your body clock before and after a long flight. Enter your flight, and it tells you when to wake, when to sleep and when to get light each day until you are on local time.

Nothing about any trip is built in. A new visitor starts at a blank setup, and each person's setup is saved only in their own browser.

Two pages:

- **Setup**: your flight (look it up by number, or type the airports and times) and your usual wake and bed times.
- **Plan**: one card per day, starting today. Wake, bed and a light window, in the local time of wherever you are that day, plus an in-flight card.

## Using it on iPhone (Chrome)

1. Open the site once with signal. The app saves its own files for offline use.
2. Optional: Share, then **Add to Home Screen**, so it opens like an app.
3. Do setup, tap **See my plan**. It reopens on the plan from then on.

If offline storage gets cleared by iOS, just open the site again with signal.

## Flight lookup (optional)

Lookup uses [AeroDataBox](https://aerodatabox.com/) through RapidAPI. You need your own key:

1. Make a RapidAPI account and subscribe to AeroDataBox (there is a free plan with a small monthly quota).
2. Copy your `X-RapidAPI-Key`.
3. In the app: Setup, **Flight lookup key**, paste it.

The key is only sent to `aerodatabox.p.rapidapi.com`, and only when you tap **Look up flight**. If lookup fails (no key, no signal, unknown flight, or the service blocks browser calls), type the airports and times instead. Always check looked-up times against your booking.

## Privacy and security

- **Nothing leaves the phone except a lookup.** The Content Security Policy only allows network calls to the AeroDataBox host. Any other connection is blocked by the browser.
- **Saved on this phone only.** Your trip and key live in the browser's local storage on this device. Use **Clear everything on this phone** to remove them.
- **No markup from data.** Pages are built with `textContent`, never `innerHTML`, so text from the API or from inputs cannot run as code.
- **No third-party code.** No CDNs, fonts, analytics or trackers. Requests send no referrer.
- **Offline files only.** The service worker caches the app's own files and never touches requests to other sites.
- Your key is visible to anyone with your unlocked phone. Use a free-tier key and rotate it if needed.

## Plan styles

Pick one on the Setup page. Gradual is the default.

- **Gradual**: shifts up to 4 h before you fly (about 45 min a day), then eases your sleep in after landing at the rate your body clock can follow. More work before the trip, smoother after.
- **Local time on landing** (opt in): a short pre-shift (2 h at 1 h a day), sleep during destination night-time on the plane, then local bed and wake times from landing day. Light windows still follow where your body clock is, so they start later in the day and move earlier as you adapt. Easier to live with; you may feel a bit off for the first day or two.

Switching style fills in its pre-flight settings under Fine tuning. You can still change them.

## How the plan works

- **Your clock's low point.** Your body temperature bottoms out about 3 hours before your usual wake time (CBTmin). Light after this point moves your clock earlier; light before it moves it later.
- **Direction.** Sydney to Los Angeles is 18 hours apart, which your clock can cover as 6 hours earlier or 18 hours later. The app picks earlier when that needs 8 hours or less, because large advances can make the clock drift the wrong way.
- **Before you fly.** It moves wake and bed earlier (or later) each day, finishing on departure day. The amount depends on the plan style and is adjustable under Fine tuning.
- **After landing.** It assumes about 1 hour per day earlier, or 1.5 hours per day later, until you are on local time.
- **On the plane.** Set your watch to destination time as you board. Sleep and shade times are based on where your body clock should be, not on the cabin schedule.

### Light line

- **Light** means outdoors (even overcast) or a light box. Indoor lighting is much weaker.
- **Dim after** means low light and screens down before bed.
- On a delay plan, light is in the evening and mornings stay dim.

## Cautions

- This is general information, not medical advice. If you have a medical condition, take regular medication, are pregnant or work in a safety-critical role, check with your doctor.
- Moving sleep earlier can leave you short on sleep in the week before you fly. Don't drive when sleep deprived.
- Melatonin can help shift the clock, but in Australia it is generally prescription-only. Ask your doctor or pharmacist; the app does not give doses.
- Real body clocks often shift slower than planned. Treat times as targets.

## Sources

- Burgess HJ. *Using bright light and melatonin to reduce jet lag* (patient guide). Rates of shifting and light timing.
- Burgess HJ, Eastman CI. Prevention of jet lag. *Sleep Medicine Clinics*, 2009. Real-world shift rates (about 57 min/day advance, 92 min/day delay).
- Eastman CI, Burgess HJ. How to travel the world without jet lag. *Sleep Medicine Clinics*, 2009. Pre-flight shifting.
- Roach GD, Sargent C. Interventions to minimize jet lag after westward and eastward flight. *Frontiers in Physiology*, 2019, 10:927. Light response curve and pre-flight advance.
- Arendt J. Managing jet lag. *Sleep Medicine Reviews*, 2009.
- Drake C et al. Caffeine effects on sleep taken 0, 3, or 6 hours before going to bed. *J Clin Sleep Med*, 2013, 9(11):1195-1200.
- Airport time zones: [airportsdata](https://github.com/mborsetti/airportsdata) (MIT licence), about 7,900 airports.

## Files

| File | What it does |
| --- | --- |
| `index.html` | Page shell, security policy, both pages |
| `app.js` | Setup, lookup, plan page, saving |
| `logic.js` | Circadian maths, both plan styles (pure functions, no network) |
| `airports.js` | Offline airport code to time zone table |
| `app.css` | Mobile-first styles, light and dark |
| `sw.js` | Offline cache. Bump `VERSION` after any change |
| `manifest.webmanifest`, `icon-*.png` | Home screen app details |

## Saved data

- Stored under `jl.state.v1` (trip and settings) and `jl.apikey.v1` (lookup key) in the browser's local storage.
- On load, saved values are checked: valid ones are kept, missing ones (for example settings added in a newer version) are filled from defaults, and malformed ones are ignored. An update never wipes a saved trip.
