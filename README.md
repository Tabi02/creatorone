# CreatorOne (real product, v1)

Free all-in-one creator pages. Live landing: https://tabi02.github.io/creatorone/
Real app (after backend deploy): https://creatorone-api.onrender.com/app.html
— and the GitHub Pages app calls that same API, so a public page link is
https://tabi02.github.io/creatorone/app.html?u=YOURHANDLE

## What is real in v1
- Signup / login (email + password, salted scrypt hash, token sessions)
- Your own public page at `?u=handle`: profile, links, products, courses, community
- Visitor bookings and newsletter subscriptions, stored in the database
- Real analytics: page views, link clicks, subscribers, bookings (start at 0, no demo numbers)

## Creator dashboard for selling to followers
Every creator gets their own dashboard: add products/courses, share their public
page link (`app.html?u=handle`) with followers, and followers can place test
orders from that page. The creator sees orders, subscribers, bookings and real
analytics in their dashboard, and marks test orders verified/rejected only
after checking their own bank records. Creating a page is always free.

## What is NOT live yet (labelled honestly on the site)
- Real payments: Buy / Enroll create TEST orders only, no money moves.
  YouPI-PG is under test review only — it is an experimental, non-certified
  gateway, so no real UPI, bank SMS observer, Gmail observer, or Android
  observer is connected, and no merchant VPA is configured yet.
- Instagram auto-DMs: placeholder only (needs Meta official API approval)
- Email sending: subscribing stores the email; no welcome email is sent yet

## Hosting caveat
Free-tier Render uses an ephemeral SQLite file: a redeploy / restart can reset
data. A managed Postgres move is the next step once the product has real users.

## Run locally
```
npm install
npm start   # http://localhost:3000, serves the site + /api/*
```
