# WhatsApp setup, from scratch

Everything needed to make the app actually send WhatsApp messages on buy-in
approval and session settlement.

Budget **1–2 hours** for steps 1–8 (you can be sending to your own phone by the
end), then a few days of waiting for business verification in step 9 before you
can message the whole club.

Code side is already done — see `src/lib/messaging.ts` and
`src/lib/messageTemplates.ts`. This document is only the Meta-side account work
plus the four values you paste into `.env`.

---

## Before you start

- A personal **Facebook account** (used only to administer the business — it is
  never shown to players).
- A **phone number for the sender**. Critical constraint: it must **not** be
  registered on the regular WhatsApp or WhatsApp Business *app*. If it is, you
  must delete that WhatsApp account first (Settings → Account → Delete my
  account) and wait a few minutes. A cheap second SIM is the usual answer.
- For step 1–8 you don't need this number at all — Meta gives you a free test
  number to develop against.

---

## 1. Create a Meta Business portfolio

1. Go to <https://business.facebook.com>.
2. **Create a business portfolio** — business name, your name, work email.
3. Confirm the email Meta sends.

## 2. Create a Developer app

1. Go to <https://developers.facebook.com/apps>.
2. **Create app**.
3. Use case: **Other** → app type: **Business**.
4. Name it (e.g. `The House Keeps Score`), and link it to the business
   portfolio from step 1.

## 3. Add the WhatsApp product

1. In the app dashboard, find **WhatsApp** in the product list → **Set up**.
2. Meta creates a **WhatsApp Business Account (WABA)** and issues a **free test
   phone number** you can send from immediately.

## 4. Collect your two values

On **WhatsApp → API Setup** you'll see:

| On the page | Goes into `.env` as |
|---|---|
| **Phone number ID** (under the test number) | `WHATSAPP_PHONE_NUMBER_ID` |
| **Temporary access token** | `WHATSAPP_ACCESS_TOKEN` (24h only — replaced in step 7) |

Ignore "WhatsApp Business Account ID" — this app doesn't use it.

## 5. Whitelist your own phone as a test recipient

While on the test number, Meta will **only deliver to numbers you pre-register**
(max 5).

1. Same **API Setup** page → **To** dropdown → **Manage phone number list**.
2. Add your own number in full international format (`+919876543210`).
3. Enter the OTP WhatsApp sends you.

> Sending to any number not on this list fails with error **131030**. That is
> the single most common "why isn't it working" cause during development.

## 6. Register the two message templates

Business-initiated messages **must** use templates approved in advance. Free
text only works within 24 hours of the player messaging you, which never
applies here.

Go to **WhatsApp Manager → Content (or Message templates) → Create template**
and create both. Use category **Utility** — not Marketing. Utility is for
transactional notices, is cheaper, and is approved faster.

### Template 1

- **Name:** `buy_in_approved`
- **Category:** Utility
- **Language:** English (`en`)
- **Body:**

  ```
  Hi {{1}}, your bank request of {{2}} has been approved at {{3}}. Good luck at the table!
  ```

- **Sample values** (Meta requires these to review): `Rahul`, `2,000 Chips`, `No Rake`

### Template 2

- **Name:** `session_settled`
- **Category:** Utility
- **Language:** English (`en`)
- **Body:**

  ```
  Hi {{1}}, {{2}} at {{3}} has been settled. {{4}} Bank in: {{5}}, cashed out: {{6}}. Your overall standing to date: {{7}}.
  ```

- **Sample values:** `Rahul`, `Day 2`, `No Rake`, `You won 2,400 Chips this session.`,
  `5,000 Chips`, `7,400 Chips`, `+7,000 Chips`

**Names and language must match exactly** — the code sends these literal
strings (`TEMPLATE_LANGUAGE = 'en'` in `messageTemplates.ts`). A mismatch fails
with error **132001**.

Utility templates are usually approved in minutes, occasionally up to 24 hours.

> Meta rejects templates that start or end with a variable, or that put two
> variables next to each other. The wording above is already shaped to pass —
> if you reword it, keep literal text at both ends and between every variable.

## 7. Swap in a permanent token

The step-4 token dies after 24 hours. For anything real you need a **System
User** token, which never expires.

1. <https://business.facebook.com/settings> → **Users → System users** → **Add**.
2. Name it (e.g. `whatsapp-sender`), role **Admin**.
3. **Assign assets** → select your **WhatsApp Business Account** → grant **full
   control**. (Miss this and the token authenticates but can't send.)
4. **Generate new token** → select your app → set **Token expiration: Never** →
   tick these permissions:
   - `whatsapp_business_messaging`
   - `whatsapp_business_management`
5. Copy the token immediately — it is shown exactly once.

## 8. Configure and test

In `apps/api/.env`:

```bash
MESSAGING_ENABLED=true
MESSAGING_CHANNEL=whatsapp
MESSAGING_DEFAULT_COUNTRY_CODE=91

WHATSAPP_PHONE_NUMBER_ID=<from step 4>
WHATSAPP_ACCESS_TOKEN=<permanent token from step 7>
WHATSAPP_API_VERSION=v21.0
```

Restart the API, then approve a buy-in for a player whose profile has the phone
number you whitelisted in step 5. Watch the API log:

```
[messaging] sent buy-in approval to <userId> via meta-whatsapp
```

Anything else prints the reason — see troubleshooting below.

To dry-run without sending, set `MESSAGING_ENABLED=false`. The app then logs
what it *would* have sent (`[messaging:noop] -> ...`) and contacts nobody.

## 9. Going live for the whole club

Steps 1–8 only reach the 5 whitelisted test numbers. To message everyone:

1. **Verify the business** — Business Settings → Business info → **Start
   verification**. Needs documents proving the business is real (registration
   certificate, utility bill, bank statement). Takes a few days.
2. **Add your real sender number** — WhatsApp Manager → Phone numbers → **Add
   phone number**, verify by SMS/call. Remember it must not be on the regular
   WhatsApp app (see prerequisites).
3. **Add a payment method** in WhatsApp Manager → Billing.
4. Update `WHATSAPP_PHONE_NUMBER_ID` in `.env` to the **new** number's ID — it
   is different from the test number's.

New accounts start limited to ~250 business-initiated conversations per day and
tier up automatically with good delivery quality. For a private poker club that
ceiling is never a concern.

**Cost:** Utility-category conversations are billed per 24-hour conversation
window, not per message — several notices to the same player in one evening
bill once. Indian utility rates are low; check current pricing in WhatsApp
Manager → Billing, as Meta revises it periodically.

---

## Troubleshooting

The app logs Meta's own error text verbatim, so match on the code:

| Code | Meaning | Fix |
|---|---|---|
| **131030** | Recipient not in the allowed list | Still on the test number — add them in step 5, or finish step 9 |
| **132001** | Template doesn't exist | Name or language mismatch. Must be exactly `buy_in_approved` / `session_settled`, language `en` |
| **132000** | Wrong number of parameters | Template body was edited so `{{n}}` count no longer matches `params` in `messageTemplates.ts` |
| **190** | Token expired/invalid | Still using the 24h token — do step 7 |
| **200 / 10** | Permission denied | System user wasn't granted full control of the WABA, or a permission is missing (step 7.3–7.4) |
| **133010** | Phone number not registered | Complete number registration in WhatsApp Manager |
| **131026** | Message undeliverable | Recipient has no WhatsApp on that number, or it's mistyped |

**Nothing in the log at all?** The player has no phone number saved — the app
skips them by design and logs `skipping ... no usable phone number`. Numbers are
captured at profile setup; anything not parseable to E.164 is treated the same
way.

**Never sends, no errors, provider says `noop`?** Either `MESSAGING_ENABLED` is
not `true`, or a `WHATSAPP_*` variable is blank — the app warns about which one
at startup and falls back to no-op rather than crashing.
