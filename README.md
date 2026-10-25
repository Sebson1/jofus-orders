# Jofus Ventures – Order Online

A small ordering platform for Jofus Ventures, modelled on the LMJ order app:

- **/** – order page: products grouped by category (consumables, clothing, footwear, kitchen appliances, electronics & accessories), search, quantities, pickup or delivery, Paystack checkout (card / MoMo / bank transfer).
- **/track** – customers look up an order by number + phone, see progress, confirm receipt, message the seller on WhatsApp.
- **/admin** – owner dashboard (password protected): orders with one-tap status changes, mark paid, products with up to 5 photos each, business settings, backup & restore.
- Every order and status change notifies the customer (and the owner) by SMS (mNotify) and WhatsApp (Meta Cloud API) – both optional.

## Run locally
No dependencies to install – plain Node 18+.
```
cp .env.example .env     # set ADMIN_KEY at least
npm start                # http://localhost:3000  –  admin at /admin
```
Without a Paystack key the shop runs in "pay on pickup/delivery" mode.

## Deploy on Render
1. Push this folder to a GitHub repo.
2. Render → New → Web Service → connect the repo (render.yaml is picked up automatically).
3. Set the environment variables (see `.env.example`). `BASE_URL` must be your Render URL, e.g. `https://jofus-orders.onrender.com`.
4. In Paystack → Settings → Webhooks, set the webhook URL to `https://<your-app>/api/paystack/webhook`.

### Storage
By default data lives in `data/db.json`. On Render's free tier the disk is wiped on each deploy, so either add a persistent disk or use Supabase:
Run `supabase-setup.sql` in the Supabase SQL editor, then set `SUPABASE_URL` and `SUPABASE_SERVICE_KEY`. Use **Settings → Download backup** regularly either way.

## Order statuses
pending_payment → placed → accepted → processing → ready → delivered → completed (or cancelled). Customers can close an order themselves from the tracker once it is ready/delivered.
