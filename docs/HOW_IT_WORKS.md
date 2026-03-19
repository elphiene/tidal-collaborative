# How Tidal Collaborative Works

This guide explains how the application works from the ground up — what it does, why it's built the way it is, and how all the pieces fit together.

---

## The Problem It Solves

Tidal doesn't have a built-in way for multiple people to share a single collaborative playlist — one where everyone's additions show up for everyone else automatically. Tidal Collaborative solves this by running a small server (on your home network or a home server device) that acts as the middleman. Each person keeps their own personal Tidal playlist, and the server quietly keeps them all in sync.

---

## The Big Picture

Here's the core idea in plain terms:

1. An admin sets up the server and creates a **shared playlist** (this is an internal record — it doesn't exist on Tidal itself).
2. Each user **links** one of their own personal Tidal playlists to that shared playlist.
3. The server watches everyone's playlists every 60 seconds. If someone adds or removes a track, the server copies that change to every other linked user's playlist.
4. Everyone's browser is also connected to the server via a live connection, so their page updates in real time when a change happens.

No browser extensions, no third-party services, no always-on computers per user — just one server doing the work for everyone.

---

## The Main Components

The application has three main parts:

### 1. The Server
A program written in **Node.js** (a way of running JavaScript outside of a browser) that does all the heavy lifting. It runs permanently in the background and handles:
- Storing data (users, playlists, tracks)
- Talking to the Tidal API on behalf of each user
- Pushing changes to all linked playlists
- Serving the web interface

### 2. The Database
A single file on disk called a **SQLite database**. Think of it as a collection of spreadsheets — one for users, one for playlists, one for tracks, and so on. SQLite is lightweight and needs no separate installation; it's built into the server code.

### 3. The Web Interface
A single webpage served by the server that users and admins interact with. There's no separate app to install — you just open it in a browser.

---

## How Users Sign In (OAuth 2.1 PKCE)

Users sign in with their Tidal account. The server never asks for or stores your Tidal password. Instead, it uses an industry-standard method called **OAuth**, which works roughly like this:

1. You click "Sign in with Tidal" on the web interface.
2. The server generates a one-time secret code (called a **code verifier**) and a scrambled version of it (the **code challenge**). It keeps the original secret to itself.
3. Your browser is redirected to Tidal's own login page, carrying only the scrambled challenge — never the secret.
4. You log in on Tidal's website directly. Tidal then redirects you back to the server with a short-lived **authorisation code**.
5. The server uses the authorisation code *and* the original secret together to prove its identity to Tidal, and receives back two tokens:
   - An **access token** — a key that lets the server act on your behalf for about an hour.
   - A **refresh token** — a longer-lived key that can be used to get a new access token when the current one expires, without making you log in again.

This approach (called **PKCE** — Proof Key for Code Exchange) means that even if someone intercepts the traffic between your browser and the server, they can't get your tokens, because the secret code was never sent over the browser.

### Token Storage
Both tokens are encrypted before being saved to the database using **AES-256-GCM** — a modern encryption standard. This means even if someone obtained a copy of the database file, they couldn't read your tokens without also having the encryption key (which lives separately, in the server's configuration). The server decrypts them on demand, uses them to make API calls, and immediately discards the decrypted versions from memory.

---

## The Polling Loop (How Syncing Works)

The heart of the application is a loop that runs every 60 seconds. Here's what happens on each tick:

1. The server gets a list of all users who have a linked playlist.
2. For each user, it checks whether their access token is about to expire. If it's within 5 minutes of expiry, it uses the refresh token to silently get a new one before continuing.
3. For each of that user's linked playlists, it asks the Tidal API: "what tracks are currently in this playlist?"
4. It compares that list to what it saw last time (stored in memory). This gives it two lists:
   - **Added tracks**: things that weren't there before.
   - **Removed tracks**: things that were there before but aren't now.
5. For each added track, it:
   - Fetches the track's title and artist from Tidal.
   - Records the track in the database.
   - Copies the track into every other linked user's Tidal playlist via the API.
   - Sends a live notification to all open browser tabs.
6. For each removed track, it does the same in reverse — removes it from everyone else's playlists and notifies browsers.

This "compare to last known state" approach is called **polling with diff detection**. It's simple and reliable: the server doesn't need Tidal to push notifications to it; it just checks periodically and figures out what changed.

### Why 60 seconds?
It's a balance. Checking more often means faster sync but more API calls (Tidal could rate-limit the server). Checking less often means slower sync. 60 seconds is a reasonable default for a music playlist.

---

## Real-Time Updates (WebSockets)

The 60-second poll tells the server when something changed. But how does your browser find out without refreshing the page?

When you open the web interface, your browser establishes a **WebSocket** connection to the server. Think of a WebSocket as a phone call that stays open — once connected, either side can send a message at any time, instantly.

When the poller detects a change and propagates it, it also broadcasts a message over WebSocket to all connected browsers. The browser receives it and updates the page immediately — showing a toast notification and refreshing the track list — without you having to do anything.

If the WebSocket disconnects (e.g. due to a network blip), the browser automatically tries to reconnect.

---

## Joining a Shared Playlist (Linking)

When a user links their Tidal playlist to a shared playlist, there's a small initialisation process:

1. The server looks at all tracks already in the shared playlist.
2. It immediately adds all of those tracks to the new user's Tidal playlist, so they're not starting from nothing.
3. It records those tracks as "already known", so the very next poll doesn't mistakenly treat them all as new additions.
4. Then it triggers an immediate poll to check whether the new user's Tidal playlist had any tracks of its own — if so, those get merged into the shared playlist and copied to everyone else.

---

## The Admin PIN

Because the server is intended to sit on a home network, there's a lightweight admin layer protected by a 4-digit PIN (set on first use). The admin can:
- Create and delete shared playlists.
- See which tracks are in each playlist.
- See which users are linked to which playlists.
- See who's currently online.

Regular users only need to sign in with Tidal. They can link or unlink their own playlists, but can't manage the shared playlists themselves.

---

## The Setup Wizard

The first time you open the application, a setup wizard walks through two required steps:

1. **Tidal Client ID** — To use Tidal's API, you need to register as a developer on Tidal's website and get a Client ID (a string that identifies your server to Tidal). The wizard asks for this and saves it.
2. **Admin PIN** — Set the 4-digit PIN that protects the admin controls.

Once both are done, the wizard disappears and the application is fully operational.

---

## Secrets and Security

The server manages a few sensitive pieces of information:

| Secret | What it is | Where it comes from |
|---|---|---|
| `ENCRYPTION_KEY` | 32-byte key used to encrypt Tidal tokens in the database | Auto-generated on first run, stored in the database |
| `SESSION_SECRET` | Key used to sign browser session cookies | Auto-generated on first run, stored in the database |
| `TIDAL_CLIENT_ID` | Identifies your server to Tidal's API | Set manually via the setup wizard |

All three can also be provided as environment variables (useful if you're running multiple instances of the server and want them to share the same secrets). If not provided, the server generates them automatically on first start and saves them in the database so they survive restarts.

Session cookies (the thing that keeps you "logged in" in the browser) are marked **HTTP-only**, meaning JavaScript on the page can't read them — only the browser and server exchange them. They last 30 days.

---

## How It's Deployed

The server is packaged as a **Docker container** — a self-contained box with everything needed to run the application, so you don't need to install Node.js or any dependencies yourself. You just tell Docker to run it.

The only thing that needs to persist between restarts is the database file. This is handled by mounting a folder from your host machine into the container (called a **volume**). As long as that folder exists, all your playlists, users, and settings survive container updates or restarts.

The web interface is served directly by the same server process — there's no separate web server needed.

---

## Summary Flow

```
You add a track to your Tidal playlist
        ↓
60 seconds pass (at most)
        ↓
Server polls your playlist via Tidal API
        ↓
Server detects the new track
        ↓
Track is saved to the database
        ↓
Server adds the track to every other linked user's Tidal playlist
        ↓
Server broadcasts "track added" to all open browser tabs via WebSocket
        ↓
Everyone's page updates instantly
```
